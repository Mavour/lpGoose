import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log, logAction } from "../logger.js";
import { getGmgnPoolFees } from "./gmgn.js";
import {
  calculateMomentum,
  calculateWeakMomentumFallback,
  fetchMomentumCandles,
  formatMomentumLog,
  validateMomentumCandles,
} from "./momentum.js";
import { getPoolMemory, getTokenCloseCooldown, isPoolOnCooldown } from "../pool-memory.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

export async function verifyLiveEntryGuards({ poolAddress, mint }, {
  getPoolFees = getGmgnPoolFees,
  deferAthThreshold = false,
  feesSnapshot = null,
} = {}) {
  if (!poolAddress || !mint) {
    return { pass: false, reason: "live entry verification requires pool address and base mint" };
  }

  let fees;
  try {
    fees = feesSnapshot || await getPoolFees({ mint, pool_address: poolAddress });
  } catch (error) {
    return { pass: false, reason: `verified GMGN pool fees unavailable: ${error.message}` };
  }
  if (fees?.pool_fees_sol == null || !["gmgn_pool", "gmgn_token_total"].includes(fees.source)) {
    return {
      pass: false,
      reason: `verified GMGN pool fees unavailable: ${fees?.error || "unknown error"}`,
    };
  }
  if (fees.pool_fees_sol < config.screening.minTokenFeesSol) {
    return {
      pass: false,
      reason: `pool_fees ${fees.pool_fees_sol} SOL < min ${config.screening.minTokenFeesSol} SOL`,
    };
  }

  let price = null;
  if (config.screening.athFilterPct != null) {
    if (fees.price_vs_ath_pct != null) {
      price = {
        price: fees.price,
        ath: fees.ath,
        price_vs_ath_pct: fees.price_vs_ath_pct,
        source: "gmgn_token_info",
      };
    }
    if (price?.price_vs_ath_pct == null) {
      return { pass: false, reason: "ATH data unavailable while ATH filter is active" };
    }
    const threshold = 100 + config.screening.athFilterPct;
    if (!deferAthThreshold && price.price_vs_ath_pct > threshold) {
      return {
        pass: false,
        reason: `price_vs_ath ${price.price_vs_ath_pct}% > limit ${threshold}%`,
      };
    }
  }

  return { pass: true, fees, price };
}

// ─── PvP (same-symbol rival) detection constants ───
const PVP_COPYCAT_AGE_GAP_MS = 24 * 60 * 60 * 1000;

export function dedupePoolsByAddress(pools) {
  const seen = new Set();
  return pools.filter((pool) => {
    const address = pool?.pool;
    if (!address || seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function clearPvpRival(pool) {
  delete pool.pvp_rival_name;
  delete pool.pvp_rival_mint;
  delete pool.pvp_rival_created_at;
  delete pool.pvp_rival_liquidity;
  delete pool.pvp_rival_volume_24h;
  delete pool.pvp_rival_holders;
  delete pool.pvp_rival_pool;
  delete pool.pvp_rival_tvl;
  delete pool.pvp_rival_fee_tvl;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

function setPvpUnverified(pool, reason) {
  clearPvpRival(pool);
  pool.is_pvp = false;
  pool.pvp_risk = "unknown";
  pool.pvp_symbol = pool.base?.symbol || null;
  pool.pvp_check_status = "unverified";
  pool.pvp_check_reason = reason;
  return pool;
}

export async function searchPoolsByMint(mint) {
  const res = await fetch(`https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}`);
  if (!res.ok) throw new Error(`Meteora pool search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data || []);
}

async function fetchPoolQuality(poolAddress) {
  const detail = await getPoolDetail({ pool_address: poolAddress, timeframe: config.screening.timeframe });
  return {
    pool: detail.pool_address,
    active_tvl: numberOrNull(detail.active_tvl ?? detail.tvl),
    volume_window: numberOrNull(detail.volume),
    fee_active_tvl_ratio: numberOrNull(
      detail.fee_active_tvl_ratio
      ?? (Number(detail.active_tvl) > 0 ? (Number(detail.fee || 0) / Number(detail.active_tvl)) * 100 : null)
    ),
  };
}

function assetVolume24h(asset) {
  const direct = numberOrNull(asset?.volume24h ?? asset?.volume_24h);
  if (direct != null) return direct;
  const buy = numberOrNull(asset?.stats24h?.buyVolume) ?? 0;
  const sell = numberOrNull(asset?.stats24h?.sellVolume) ?? 0;
  return buy + sell;
}

function poolAddressOf(rawPool) {
  return rawPool?.address || rawPool?.pool_address || null;
}

function poolContainsMint(rawPool, mint) {
  const mints = [
    rawPool?.mint_x,
    rawPool?.mint_y,
    rawPool?.token_x?.address,
    rawPool?.token_y?.address,
  ].filter(Boolean);
  return mints.includes(mint);
}

export async function assessEstablishedPvpRival(asset, {
  searchPools = searchPoolsByMint,
  getPoolQuality = fetchPoolQuality,
  getPoolFees = getGmgnPoolFees,
} = {}) {
  const s = config.screening;
  const liquidity = numberOrNull(asset?.liquidity);
  const volume24h = assetVolume24h(asset);
  const holders = numberOrNull(asset?.holderCount ?? asset?.holders);
  const organic = numberOrNull(asset?.organicScore ?? asset?.organic_score);
  const verified = asset?.isVerified === true || asset?.tags?.includes("verified");
  const assetFeesSol = numberOrNull(asset?.fees);
  const tokenFailures = [];

  if (liquidity == null || liquidity < s.minTvl) tokenFailures.push(`liquidity ${liquidity ?? "unavailable"} < min ${s.minTvl}`);
  if (volume24h < s.minVolume) tokenFailures.push(`volume24h ${volume24h} < min ${s.minVolume}`);
  if (holders == null || holders < s.minHolders) tokenFailures.push(`holders ${holders ?? "unavailable"} < min ${s.minHolders}`);
  if (!verified && (organic == null || organic < s.minOrganic)) {
    tokenFailures.push(`organic ${organic ?? "unavailable"} < min ${s.minOrganic} and token is not verified`);
  }

  const rawPools = (await searchPools(asset.id)).filter((rawPool) => poolContainsMint(rawPool, asset.id));
  const marketPool = asset?.graduatedPool || asset?.firstPool?.id || poolAddressOf(rawPools[0]);
  if (!marketPool) {
    return {
      established: false,
      reason: [...tokenFailures, "no active market pool found"].join("; "),
      liquidity,
      volume24h,
      holders,
    };
  }

  const poolsToCheck = rawPools
    .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
    .slice(0, 3);
  const poolChecks = await Promise.all(poolsToCheck.map(async (rawPool) => {
    const poolAddress = poolAddressOf(rawPool);
    if (!poolAddress) return { pass: false, reason: "pool address unavailable" };
    const [quality, fees] = await Promise.all([
      getPoolQuality(poolAddress),
      assetFeesSol != null
        ? Promise.resolve({ pool_fees_sol: assetFeesSol })
        : getPoolFees({ mint: asset.id, pool_address: poolAddress }),
    ]);
    const failures = [];
    if (quality.active_tvl == null || quality.active_tvl < s.minTvl) failures.push(`tvl ${quality.active_tvl ?? "unavailable"} < min ${s.minTvl}`);
    if (quality.volume_window == null || quality.volume_window < s.minVolume) failures.push(`volume ${quality.volume_window ?? "unavailable"} < min ${s.minVolume}`);
    if (quality.fee_active_tvl_ratio == null || quality.fee_active_tvl_ratio < s.minFeeActiveTvlRatio) {
      failures.push(`fee_tvl ${quality.fee_active_tvl_ratio ?? "unavailable"} < min ${s.minFeeActiveTvlRatio}`);
    }
    const poolFeesSol = numberOrNull(fees?.pool_fees_sol);
    if (poolFeesSol == null || poolFeesSol < s.minTokenFeesSol) failures.push(`pool_fees ${poolFeesSol ?? "unavailable"} < min ${s.minTokenFeesSol}`);
    return { ...quality, pool_fees_sol: poolFeesSol, pass: failures.length === 0, reason: failures.join("; ") };
  }));

  const validPool = poolChecks
    .filter((check) => check.pass)
    .sort((a, b) => (b.active_tvl || 0) - (a.active_tvl || 0))[0];
  const bestReportedFees = validPool?.pool_fees_sol ?? assetFeesSol;
  if (bestReportedFees == null || bestReportedFees < s.minTokenFeesSol) {
    tokenFailures.push(`fees ${bestReportedFees ?? "unavailable"} SOL < min ${s.minTokenFeesSol} SOL`);
  }
  const established = tokenFailures.length === 0;
  const aggregateFeeTvl = liquidity > 0 && bestReportedFees != null
    ? (bestReportedFees / liquidity) * 100
    : null;
  return {
    established,
    reason: established
      ? `market metrics meet established OG thresholds${validPool ? " with a qualifying Meteora pool" : ""}`
      : tokenFailures.join("; "),
    liquidity,
    volume24h,
    holders,
    pool: validPool?.pool || marketPool,
    tvl: validPool?.active_tvl ?? liquidity,
    feeTvl: validPool?.fee_active_tvl_ratio ?? aggregateFeeTvl,
    poolFeesSol: bestReportedFees,
  };
}

export function evaluatePvpAssets(pool, assets, rivalAssessments = new Map()) {
  const symbol = normalizeSymbol(pool.base?.symbol);
  const ownMint = pool.base?.mint;
  pool.pvp_symbol = pool.base?.symbol || symbol || null;

  if (!symbol) return setPvpUnverified(pool, "token symbol unavailable");
  if (!ownMint) return setPvpUnverified(pool, "token mint unavailable");
  if (!Array.isArray(assets)) return setPvpUnverified(pool, "Jupiter asset response invalid");

  const matching = assets.filter((asset) =>
    asset?.id && normalizeSymbol(asset?.symbol) === symbol
  );
  const ownAsset = matching.find((asset) => asset.id === ownMint);
  if (!ownAsset) return setPvpUnverified(pool, `mint ${ownMint} not found in Jupiter symbol search`);

  const ownCreatedAt = Date.parse(ownAsset.createdAt);
  if (!Number.isFinite(ownCreatedAt)) {
    return setPvpUnverified(pool, `createdAt unavailable for mint ${ownMint}`);
  }

  const rivals = matching.filter((asset) => asset.id !== ownMint);
  const undatedRivals = rivals.filter((asset) => !Number.isFinite(Date.parse(asset.createdAt)));
  const establishedUndatedRivals = undatedRivals.filter(
    (asset) => rivalAssessments.get(asset.id)?.established,
  );
  if (establishedUndatedRivals.length > 0) {
    const rival = establishedUndatedRivals[0];
    return setPvpUnverified(
      pool,
      `established same-symbol rival ${rival.id} has no createdAt; cannot determine original mint`,
    );
  }

  const olderRivals = rivals
    .map((asset) => ({ asset, createdAt: Date.parse(asset.createdAt) }))
    .filter(({ createdAt }) => Number.isFinite(createdAt))
    .filter(({ createdAt }) => createdAt < ownCreatedAt - PVP_COPYCAT_AGE_GAP_MS)
    .sort((a, b) => a.createdAt - b.createdAt);

  const establishedRivals = olderRivals.filter(({ asset }) => rivalAssessments.get(asset.id)?.established);
  if (establishedRivals.length > 0) {
    const { asset: rival, createdAt } = establishedRivals[0];
    const assessment = rivalAssessments.get(rival.id);
    pool.is_pvp = true;
    pool.pvp_risk = "high";
    pool.pvp_rival_name = rival.name || pool.pvp_symbol;
    pool.pvp_rival_mint = rival.id;
    pool.pvp_rival_created_at = new Date(createdAt).toISOString();
    pool.pvp_rival_liquidity = assessment.liquidity;
    pool.pvp_rival_volume_24h = assessment.volume24h;
    pool.pvp_rival_holders = assessment.holders;
    pool.pvp_rival_pool = assessment.pool;
    pool.pvp_rival_tvl = assessment.tvl;
    pool.pvp_rival_fee_tvl = assessment.feeTvl;
    pool.pvp_check_status = "copycat";
    pool.pvp_check_reason = `established older same-symbol mint created ${pool.pvp_rival_created_at}`;
    return pool;
  }

  pool.is_pvp = false;
  pool.pvp_risk = "low";
  clearPvpRival(pool);
  pool.pvp_check_status = "verified";
  if (olderRivals.length > 0) {
    pool.pvp_check_reason = "older same-symbol mints exist but none qualify as an established OG";
  } else if (undatedRivals.length > 0) {
    pool.pvp_check_reason = "same-symbol rivals without createdAt exist but none qualify as established";
  } else {
    pool.pvp_check_reason = "no same-symbol mint is more than 24 hours older";
  }
  return pool;
}

async function evaluatePvpWithEstablishedRivals(pool, assets, {
  assessRival = assessEstablishedPvpRival,
  assessmentCache = new Map(),
} = {}) {
  const preliminary = evaluatePvpAssets(pool, assets);
  if (preliminary.pvp_check_status === "unverified") return preliminary;

  const symbol = normalizeSymbol(pool.base?.symbol);
  const ownAsset = assets.find((asset) => asset?.id === pool.base?.mint && normalizeSymbol(asset?.symbol) === symbol);
  const ownCreatedAt = Date.parse(ownAsset.createdAt);
  const relevantRivals = assets
    .filter((asset) =>
      asset?.id
      && asset.id !== ownAsset.id
      && normalizeSymbol(asset.symbol) === symbol
      && (
        !Number.isFinite(Date.parse(asset.createdAt))
        || Date.parse(asset.createdAt) < ownCreatedAt - PVP_COPYCAT_AGE_GAP_MS
      )
    )
    .sort((a, b) => {
      const aCreatedAt = Date.parse(a.createdAt);
      const bCreatedAt = Date.parse(b.createdAt);
      if (!Number.isFinite(aCreatedAt)) return 1;
      if (!Number.isFinite(bCreatedAt)) return -1;
      return aCreatedAt - bCreatedAt;
    });

  const assessments = new Map();
  await Promise.all(relevantRivals.map(async (rival) => {
    if (!assessmentCache.has(rival.id)) {
      assessmentCache.set(rival.id, Promise.resolve().then(() => assessRival(rival)));
    }
    assessments.set(rival.id, await assessmentCache.get(rival.id));
  }));
  return evaluatePvpAssets(pool, assets, assessments);
}

export async function checkPoolPvpRisk(pool, {
  searchAssets = searchAssetsBySymbol,
  assessRival = assessEstablishedPvpRival,
} = {}) {
  const symbol = normalizeSymbol(pool?.base?.symbol);
  if (!pool || !symbol || !pool.base?.mint) {
    return setPvpUnverified(pool || {}, !symbol ? "token symbol unavailable" : "token mint unavailable");
  }

  try {
    return await evaluatePvpWithEstablishedRivals(pool, await searchAssets(symbol), { assessRival });
  } catch (error) {
    return setPvpUnverified(pool, `PvP verification failed: ${error.message}`);
  }
}

export function getPvpBlockReason(pool) {
  if (pool?.pvp_check_status === "unverified") {
    return `unverified: ${pool.pvp_check_reason || "unknown reason"}`;
  }
  if (pool?.is_pvp) {
    return `copycat of ${pool.pvp_rival_name || pool.pvp_rival_mint}, older mint created ${pool.pvp_rival_created_at}`;
  }
  return null;
}

export async function enrichPvpRisk(pools, {
  searchAssets = searchAssetsBySymbol,
  assessRival = assessEstablishedPvpRival,
} = {}) {
  if (!Array.isArray(pools) || pools.length === 0) return;

  const symbolCache = new Map();
  const assessmentCache = new Map();
  await Promise.all(pools.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    if (!symbol || !pool.base?.mint) {
      setPvpUnverified(pool, !symbol ? "token symbol unavailable" : "token mint unavailable");
      return;
    }

    if (!symbolCache.has(symbol)) {
      symbolCache.set(symbol, searchAssets(symbol));
    }

    try {
      const assets = await symbolCache.get(symbol);
      await evaluatePvpWithEstablishedRivals(pool, assets, { assessRival, assessmentCache });

      const ownAsset = assets.find((asset) => asset?.id === pool.base.mint);
      const ownCreatedAt = Date.parse(ownAsset?.createdAt);
      const relevantRivals = assets.filter((asset) => {
        const rivalCreatedAt = Date.parse(asset?.createdAt);
        return asset?.id
          && asset.id !== pool.base.mint
          && normalizeSymbol(asset.symbol) === symbol
          && (
            !Number.isFinite(rivalCreatedAt)
            || rivalCreatedAt < ownCreatedAt - PVP_COPYCAT_AGE_GAP_MS
          );
      });
      for (const rival of relevantRivals) {
        const assessment = await assessmentCache.get(rival.id);
        const rivalCreatedAt = Date.parse(rival.createdAt);
        if (!Number.isFinite(rivalCreatedAt) && assessment?.established) {
          log("screening", `PVP established undated rival blocks verification: ${rival.name || symbol} (${rival.id.slice(0, 8)}) liquidity=$${assessment.liquidity ?? "?"} volume24h=$${assessment.volume24h ?? "?"} holders=${assessment.holders ?? "?"} pool=${assessment.pool || "?"} tvl=$${assessment.tvl ?? "?"} fee_tvl=${assessment.feeTvl ?? "?"}% fees=${assessment.poolFeesSol ?? "?"} SOL`);
        } else if (!Number.isFinite(rivalCreatedAt)) {
          log("screening", `PVP weak undated rival ignored: ${rival.name || symbol} (${rival.id.slice(0, 8)}) - ${assessment?.reason || "not established"}`);
        } else if (assessment?.established) {
          log("screening", `PVP rival accepted: ${rival.name || symbol} (${rival.id.slice(0, 8)}) liquidity=$${assessment.liquidity ?? "?"} volume24h=$${assessment.volume24h ?? "?"} holders=${assessment.holders ?? "?"} pool=${assessment.pool || "?"} tvl=$${assessment.tvl ?? "?"} fee_tvl=${assessment.feeTvl ?? "?"}% fees=${assessment.poolFeesSol ?? "?"} SOL`);
        } else {
          log("screening", `PVP rival ignored: ${rival.name || symbol} (${rival.id.slice(0, 8)}) - ${assessment?.reason || "not established"}`);
        }
      }
    } catch (error) {
      setPvpUnverified(pool, `PvP verification failed: ${error.message}`);
    }

    if (pool.pvp_check_status === "copycat") {
      log("screening", `PVP guard: ${pool.name} (${pool.base.mint.slice(0, 8)}) is a copycat of ${pool.pvp_rival_name} (${pool.pvp_rival_mint.slice(0, 8)}), created ${pool.pvp_rival_created_at}`);
    } else if (pool.pvp_check_status === "unverified") {
      log("screening", `PVP guard: symbol=${pool.base.symbol} mint=${pool.base.mint} unverified - ${pool.pvp_check_reason}`);
    }
  }));
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=${s.category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = dedupePoolsByAddress((data.data || []).map(condensePool));

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({
  limit = 10,
  evaluationLimit = null,
  evaluationOffset = 0,
  signalGate = true,
} = {}) {
  const { config } = await import("../config.js");
  const { getTokenInfo } = await import("./token.js");
  const { pools } = await discoverPools({ page_size: 50 });

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions({ force: true });
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligiblePools = pools.filter((p) => {
    if (occupiedPools.has(p.pool)) {
      log("screening", `Fresh gate: dropped ${p.name} - already have open position in pool`);
      return false;
    }
    if (occupiedMints.has(p.base?.mint)) {
      log("screening", `Fresh gate: dropped ${p.name} - already holding base token ${p.base?.mint}`);
      return false;
    }
    return true;
  });
  const requestedEvaluationLimit = Number(evaluationLimit);
  const requestedEvaluationOffset = Math.max(0, Number(evaluationOffset) || 0);
  const eligible = Number.isInteger(requestedEvaluationLimit) && requestedEvaluationLimit > 0
    ? eligiblePools.slice(
      requestedEvaluationOffset,
      requestedEvaluationOffset + requestedEvaluationLimit,
    )
    : eligiblePools;
  if (eligible.length < eligiblePools.length) {
    log(
      "screening",
      `Limited expensive candidate checks to rank ${requestedEvaluationOffset + 1}-${requestedEvaluationOffset + eligible.length} of ${eligiblePools.length} pool(s)`,
    );
  }

  // Pool fee gate/reporting must use pool-specific fees, not Jupiter token/global fees.
  if (eligible.length > 0) {
    const feeResults = await Promise.allSettled(
      eligible.map((p) => getGmgnPoolFees({ mint: p.base?.mint, pool_address: p.pool }))
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = feeResults[i];
      if (r.status === "fulfilled" && r.value?.pool_fees_sol != null) {
        eligible[i].pool_fees_sol = r.value.pool_fees_sol;
        eligible[i].pool_fees_source = r.value.source;
        eligible[i].pool_fees_timeframe = r.value.timeframe || null;
        eligible[i].pool_fees_unit = "SOL";
        eligible[i].gmgn_price = r.value.price ?? null;
        eligible[i].price_vs_ath_pct = r.value.price_vs_ath_pct ?? null;
        eligible[i].ath = r.value.ath ?? null;
      } else {
        const error = r.status === "fulfilled" ? r.value?.error : r.reason?.message;
        log("screening_warn", `GMGN fee unavailable: ${eligible[i].name} gmgn_error=${error || "fee unavailable"}; Meteora window fee is USD and cannot satisfy minTokenFeesSol`);
      }
    }
  }

  // Enrich token audit before final hard gates so JS, not the LLM, enforces config.
  if (eligible.length > 0) {
    const tokenResults = await Promise.allSettled(
      eligible.map((p) => p.base?.mint ? getTokenInfo({ query: p.base.mint }) : Promise.resolve(null))
    );
    for (let i = 0; i < eligible.length; i++) {
      const ti = tokenResults[i].status === "fulfilled" ? tokenResults[i].value?.results?.[0] : null;
      eligible[i].token_info = ti || null;
    }
  }

  // Apply ATH data returned by the GMGN fee/token-info request.
  if (eligible.length > 0) {
    // Require ATH data here; the entry-candle threshold is checked after
    // Supertrend is calculated from closed candles.
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.ath == null || !Number.isFinite(Number(p.ath)) || Number(p.ath) <= 0) {
          log("screening", `ATH filter: dropped ${p.name} - ATH data unavailable`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH availability filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator was supplied by Pool Discovery or Jupiter.
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via creator check`);
  }

  const gated = [];
  for (const pool of eligible) {
    const gate = evaluateScreeningGate(pool, { tokenInfo: pool.token_info });
    pool.memory_risk = gate.memoryRisk || null;
    pool.hard_gate_pass = gate.pass;
    pool.hard_gate_reason = gate.reason || null;
    if (!gate.pass) {
      log("screening", `Hard gate: dropped ${pool.name} - ${gate.reason}`);
      continue;
    }
    gated.push(pool);
  }

  // ─── Supertrend entry gate (hard filter) ───
  if (signalGate && gated.length > 0) {
    const cc = config.chartIndicators;
    const momentumConfig = config.momentum;
    const {
      closedCandlesOnly,
      confirmSupertrendFromCandles,
      evaluateEntrySupertrend,
    } = await import("./chart-indicators.js");
    const signalResults = await Promise.all(
      gated.map(async (pool) => {
        const mint = pool.base?.mint;
        if (!mint) return { valid: false, reason: "missing_mint" };

        const fetched = await fetchMomentumCandles({
          mint,
          maxRetries: momentumConfig.maxRetries,
          retryDelayMs: momentumConfig.retryDelayMs,
        });
        if (!fetched.success) {
          return {
            valid: false,
            reason: `${fetched.errorType}: ${fetched.error}`,
            gmgnAttempt: fetched.attempt,
          };
        }

        const validated = validateMomentumCandles(fetched.candles, {
          maxCandleAgeMinutes: momentumConfig.maxCandleAgeMinutes,
        });
        if (!validated.valid) {
          return {
            valid: false,
            reason: validated.reason,
            momentum: validated,
            gmgnAttempt: fetched.attempt,
          };
        }

        const entryInterval = cc.entryInterval || cc.interval || "5m";
        const closedCandles = closedCandlesOnly(fetched.candles, entryInterval);
        const supertrend = evaluateEntrySupertrend(confirmSupertrendFromCandles(closedCandles, {
          interval: entryInterval,
          period: cc.stPeriod || 10,
          multiplier: cc.stMultiplier || 3,
        }), {
          entryPreset: cc.entryPreset,
          ath: pool.ath,
          athFilterPct: config.screening.athFilterPct,
          minPriceChangePct: cc.entryMinPriceChangePct,
        });
        if (!supertrend.confirmed) {
          return {
            valid: true,
            momentum: validated,
            supertrend,
            gmgnAttempt: fetched.attempt,
          };
        }

        let momentum = calculateMomentum({
          candles: fetched.candles,
          feeActiveTvlRatio: pool.fee_active_tvl_ratio,
          minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
          volatility: pool.volatility,
          strongThreshold: momentumConfig.strongThreshold,
          strongMinBins: momentumConfig.strongMinBins,
          strongMaxBins: momentumConfig.strongMaxBins,
          weakMinBins: momentumConfig.weakMinBins,
          weakMaxBins: momentumConfig.weakMaxBins,
          tokenAgeHours: pool.token_age_hours,
          ageBands: {
            newMaxHours: momentumConfig.ageNewMaxHours,
            youngMaxHours: momentumConfig.ageYoungMaxHours,
            matureMaxHours: momentumConfig.ageMatureMaxHours,
            newMinBins: momentumConfig.newMinBins,
            newMaxBins: momentumConfig.newMaxBins,
            youngMinBins: momentumConfig.youngMinBins,
            youngMaxBins: momentumConfig.youngMaxBins,
            matureMinBins: momentumConfig.matureMinBins,
            matureMaxBins: momentumConfig.matureMaxBins,
            oldMinBins: momentumConfig.oldMinBins,
            oldMaxBins: momentumConfig.oldMaxBins,
          },
          maxCandleAgeMinutes: momentumConfig.maxCandleAgeMinutes,
        });
        if (!momentum.valid) {
          momentum = calculateWeakMomentumFallback({
            validatedCandles: validated,
            volatility: pool.volatility,
            weakMinBins: momentumConfig.weakMinBins,
            weakMaxBins: momentumConfig.weakMaxBins,
            tokenAgeHours: pool.token_age_hours,
            ageBands: {
              newMaxHours: momentumConfig.ageNewMaxHours,
              youngMaxHours: momentumConfig.ageYoungMaxHours,
              matureMaxHours: momentumConfig.ageMatureMaxHours,
              newMinBins: momentumConfig.newMinBins,
              newMaxBins: momentumConfig.newMaxBins,
              youngMinBins: momentumConfig.youngMinBins,
              youngMaxBins: momentumConfig.youngMaxBins,
              matureMinBins: momentumConfig.matureMinBins,
              matureMaxBins: momentumConfig.matureMaxBins,
              oldMinBins: momentumConfig.oldMinBins,
              oldMaxBins: momentumConfig.oldMaxBins,
            },
            reason: `supertrend_confirmed_momentum_fallback: ${momentum.reason}`,
          });
        }

        return {
          valid: true,
          momentum,
          supertrend,
          gmgnAttempt: fetched.attempt,
        };
      }),
    );

    const before = gated.length;
    const signalPassed = [];
    for (let i = 0; i < gated.length; i++) {
      const pool = gated[i];
      const result = signalResults[i];
      if (!result.valid || !result.supertrend.confirmed) {
        const reason = result.valid ? result.supertrend.reason : result.reason;
        const momentumSnapshot = result.momentum
          ? { ...result.momentum, candles: undefined }
          : null;
        log("momentum", formatMomentumLog({
          pool: pool.pool,
          mint: pool.base?.mint,
          result: result.momentum,
          gmgnAttempt: result.gmgnAttempt,
          poolFeesSol: pool.pool_fees_sol,
          poolFeesSource: pool.pool_fees_source,
          feeTimeframe: pool.pool_fees_timeframe,
          decision: "skip",
          reason,
        }));
        logAction({
          tool: "momentum_gate",
          args: { pool: pool.pool, mint: pool.base?.mint },
          result: {
            decision: "skip",
            reason,
            momentum: momentumSnapshot,
            gmgn_attempt: result.gmgnAttempt,
            pool_fees_sol: pool.pool_fees_sol,
            pool_fees_source: pool.pool_fees_source,
            pool_fees_timeframe: pool.pool_fees_timeframe,
          },
          success: false,
        });
        log("screening", `${result.valid ? "Supertrend" : "Momentum"} gate: dropped ${pool.name} - ${reason}`);
        continue;
      }

      pool.supertrend_direction = result.supertrend.direction;
      pool.supertrend_reason = result.supertrend.reason;
      pool.momentum = { ...result.momentum, candles: undefined };
      Object.defineProperty(pool, "momentum_candles", {
        value: result.momentum.candles,
        enumerable: false,
      });
      pool.momentum_gmgn_attempt = result.gmgnAttempt;
      signalPassed.push(pool);
    }
    gated.splice(0, gated.length, ...signalPassed);
    if (gated.length < before) {
      log("screening", `Momentum/Supertrend gate removed ${before - gated.length} pool(s)`);
    }
  }

  // ─── PvP (same-symbol rival) detection — run after hard gates so all final candidates are checked ───
  if ((config.screening.avoidPvpSymbols || config.screening.blockPvpSymbols) && gated.length > 0) {
    await enrichPvpRisk(gated);

    if (config.screening.blockPvpSymbols) {
      const before = gated.length;
      const pvpRemoved = gated.filter((p) => p.is_pvp || p.pvp_check_status === "unverified");
      pvpRemoved.forEach((p) => log("screening", `PVP hard filter: dropped symbol=${p.base?.symbol || "unknown"} mint=${p.base?.mint || "unknown"} - ${getPvpBlockReason(p)}`));
      gated.splice(0, gated.length, ...gated.filter((p) => !p.is_pvp && p.pvp_check_status !== "unverified"));
      if (gated.length < before) {
        log("screening", `PVP hard filter removed ${before - gated.length} pool(s)`);
      }
    }
  }

  return {
    candidates: gated.slice(0, limit),
    total_screened: pools.length,
    total_eligible: gated.length,
  };
}

export function evaluateScreeningGate(pool, { tokenInfo = null } = {}) {
  const s = config.screening;
  const fail = (reason, memoryRisk = null) => ({ pass: false, reason, memoryRisk });
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (pool.quote?.mint && pool.quote.mint !== SOL_MINT) return fail(`quote ${pool.quote.symbol} is not SOL`);
  const closeCooldown = getTokenCloseCooldown(pool.base?.mint);
  if (closeCooldown) {
    return fail(
      `close_cooldown: token ${pool.base.mint.slice(0, 8)} blocked until ${closeCooldown.cooldown_until}`,
      `close_cooldown: ${closeCooldown.pool_name || pool.base.mint.slice(0, 8)} until ${closeCooldown.cooldown_until}`
    );
  }

  if (s.blockPvpSymbols) {
    const pvpBlockReason = getPvpBlockReason(pool);
    if (pvpBlockReason) return fail(`pvp ${pvpBlockReason}`);
  }

  const memoryRisk = getMemoryRisk(pool.pool);
  if (pool.active_tvl != null && pool.active_tvl < s.minTvl) return fail(`tvl ${pool.active_tvl} < min ${s.minTvl}`);
  if (pool.active_tvl != null && pool.active_tvl > s.maxTvl) return fail(`tvl ${pool.active_tvl} > max ${s.maxTvl}`);
  if (pool.volume_window != null && pool.volume_window < s.minVolume) return fail(`volume ${pool.volume_window} < min ${s.minVolume}`);
  if (
    s.minVolumeToActiveTvlRatio != null &&
    pool.volume_window != null &&
    pool.active_tvl != null &&
    Number(pool.active_tvl) > 0
  ) {
    const volumeTvlRatio = Number(pool.volume_window) / Number(pool.active_tvl);
    if (Number.isFinite(volumeTvlRatio) && volumeTvlRatio < s.minVolumeToActiveTvlRatio) {
      return fail(`volume/tvl ${volumeTvlRatio.toFixed(4)} < min ${s.minVolumeToActiveTvlRatio}`);
    }
  }
  if (pool.organic_score != null && pool.organic_score < s.minOrganic) return fail(`organic ${pool.organic_score} < min ${s.minOrganic}`);
  if (pool.mcap != null && pool.mcap < s.minMcap) return fail(`mcap ${pool.mcap} < min ${s.minMcap}`);
  if (pool.mcap != null && pool.mcap > s.maxMcap) return fail(`mcap ${pool.mcap} > max ${s.maxMcap}`);
  if (pool.bin_step != null && pool.bin_step < s.minBinStep) return fail(`bin_step ${pool.bin_step} < min ${s.minBinStep}`);
  if (pool.bin_step != null && pool.bin_step > s.maxBinStep) return fail(`bin_step ${pool.bin_step} > max ${s.maxBinStep}`);
  if (pool.fee_active_tvl_ratio != null && pool.fee_active_tvl_ratio < s.minFeeActiveTvlRatio) return fail(`fee_tvl ${pool.fee_active_tvl_ratio}% < min ${s.minFeeActiveTvlRatio}%`);
  if (pool.token_age_hours != null && s.minTokenAgeHours != null && pool.token_age_hours < s.minTokenAgeHours) return fail(`token age ${pool.token_age_hours}h < min ${s.minTokenAgeHours}h`);
  if (pool.token_age_hours != null && s.maxTokenAgeHours != null && pool.token_age_hours > s.maxTokenAgeHours) return fail(`token age ${pool.token_age_hours}h > max ${s.maxTokenAgeHours}h`);
  if (pool.pool_fees_sol == null) return fail("pool_fees unavailable");
  if (!["gmgn_pool", "gmgn_token_total"].includes(pool.pool_fees_source)) {
    return fail(`pool_fees source unverified: ${pool.pool_fees_source || "missing"}`);
  }
  if (pool.pool_fees_unit !== "SOL") {
    return fail(`pool_fees unit unverified: ${pool.pool_fees_unit || "missing"}`);
  }
  if (pool.pool_fees_sol < s.minTokenFeesSol) return fail(`pool_fees ${pool.pool_fees_sol} SOL < min ${s.minTokenFeesSol} SOL`);

  const launchpad = tokenInfo?.launchpad ?? null;
  if (launchpad && s.blockedLaunchpads.includes(launchpad)) return fail(`blocked launchpad ${launchpad}`);
  if (Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0) {
    if (!launchpad) return fail("launchpad unavailable but allowlist is active");
    if (!s.allowedLaunchpads.includes(launchpad)) return fail(`launchpad ${launchpad} not in allowlist`);
  }

  const botPct = numberOrNull(tokenInfo?.audit?.bot_holders_pct);
  if (botPct != null && s.maxBotHoldersPct != null && botPct > s.maxBotHoldersPct) return fail(`bots ${botPct}% > max ${s.maxBotHoldersPct}%`);

  const top10Pct = numberOrNull(tokenInfo?.audit?.top_holders_pct);
  if (top10Pct != null && s.maxTop10Pct != null && top10Pct > s.maxTop10Pct) return fail(`top10 ${top10Pct}% > max ${s.maxTop10Pct}%`);

  if (s.athFilterPct != null) {
    if (pool.ath == null || !Number.isFinite(Number(pool.ath)) || Number(pool.ath) <= 0) {
      return fail("ATH data unavailable while ATH filter is active");
    }
  }

  return { pass: true, memoryRisk: memoryRisk?.reason || null };
}

function getMemoryRisk(poolAddress) {
  if (!poolAddress) return null;
  if (isPoolOnCooldown(poolAddress)) return { reject: true, reason: "pool on cooldown (whale exit)" };
  return null;
}

function numberOrNull(value) {
  if (value == null || value === "?") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window_usd: round(p.fee),
    pool_fees_sol: null,
    pool_fees_source: null,
    pool_fees_timeframe: null,
    pool_fees_unit: null,
    volume_window: round(p.volume),
    // fee_active_tvl_ratio: display only — NOT sent to LLM for decision. Hard gate only.
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}
