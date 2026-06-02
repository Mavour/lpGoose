import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { getGmgnPoolFees } from "./gmgn.js";
import { getPoolMemory, getTokenCloseCooldown, isPoolOnCooldown } from "../pool-memory.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

// ─── PvP (same-symbol rival) detection constants ───
const PVP_SHORTLIST_LIMIT = 2;     // Only score-check top 2 pools
const PVP_RIVAL_LIMIT = 2;         // Max 2 rival tokens to check per pool
const PVP_MIN_ACTIVE_TVL = 5_000;  // Rival's Meteora pool must have >= $5k TVL
const PVP_MIN_HOLDERS = 500;       // Rival token must have >= 500 holders
const PVP_MIN_GLOBAL_FEES_SOL = 30; // Rival must have generated >= 30 SOL in fees

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + volume / 100 + holders / 100;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return;

  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);

      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = Math.round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));

      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)}) — tvl=$${pool.pvp_rival_tvl} holders=${pool.pvp_rival_holders} fees=${pool.pvp_rival_fees} SOL`);
      break;
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

  const condensed = (data.data || []).map(condensePool);

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
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { getTokenInfo } = await import("./token.js");
  const { pools } = await discoverPools({ page_size: 50 });

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions({ force: true });
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools.filter((p) => {
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

  // Pool fee gate/reporting must use pool-specific fees, not Jupiter token/global fees.
  if (eligible.length > 0) {
    const feeResults = await Promise.allSettled(
      eligible.map((p) => getGmgnPoolFees({ mint: p.base?.mint, pool_address: p.pool }))
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = feeResults[i];
      if (r.status === "fulfilled" && r.value?.pool_fees_sol != null) {
        eligible[i].pool_fees_sol = r.value.pool_fees_sol;
        eligible[i].pool_fees_source = "gmgn";
      } else if (eligible[i].fee_window != null) {
        eligible[i].pool_fees_sol = eligible[i].fee_window;
        eligible[i].pool_fees_source = "meteora_fallback";
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

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map((p) => p.base?.mint
        ? Promise.all([getAdvancedInfo(p.base.mint), getPriceInfo(p.base.mint), getClusterList(p.base.mint), getRiskFlags(p.base.mint)])
        : Promise.resolve([null, null, [], null])
      )
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const [adv, price, clusters, risk] = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) { log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`); return false; }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  // ─── PvP (same-symbol rival) detection ───
  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);

    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => log("screening", `PVP hard filter: dropped ${p.name} — rival ${p.pvp_rival_name}`));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
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

  const memoryRisk = getMemoryRisk(pool.pool);
  if (pool.active_tvl != null && pool.active_tvl < s.minTvl) return fail(`tvl ${pool.active_tvl} < min ${s.minTvl}`);
  if (pool.active_tvl != null && pool.active_tvl > s.maxTvl) return fail(`tvl ${pool.active_tvl} > max ${s.maxTvl}`);
  if (pool.volume_window != null && pool.volume_window < s.minVolume) return fail(`volume ${pool.volume_window} < min ${s.minVolume}`);
  if (pool.organic_score != null && pool.organic_score < s.minOrganic) return fail(`organic ${pool.organic_score} < min ${s.minOrganic}`);
  if (pool.mcap != null && pool.mcap < s.minMcap) return fail(`mcap ${pool.mcap} < min ${s.minMcap}`);
  if (pool.mcap != null && pool.mcap > s.maxMcap) return fail(`mcap ${pool.mcap} > max ${s.maxMcap}`);
  if (pool.bin_step != null && pool.bin_step < s.minBinStep) return fail(`bin_step ${pool.bin_step} < min ${s.minBinStep}`);
  if (pool.bin_step != null && pool.bin_step > s.maxBinStep) return fail(`bin_step ${pool.bin_step} > max ${s.maxBinStep}`);
  if (pool.fee_active_tvl_ratio != null && pool.fee_active_tvl_ratio < s.minFeeActiveTvlRatio) return fail(`fee_tvl ${pool.fee_active_tvl_ratio}% < min ${s.minFeeActiveTvlRatio}%`);
  if (pool.token_age_hours != null && s.minTokenAgeHours != null && pool.token_age_hours < s.minTokenAgeHours) return fail(`token age ${pool.token_age_hours}h < min ${s.minTokenAgeHours}h`);
  if (pool.token_age_hours != null && s.maxTokenAgeHours != null && pool.token_age_hours > s.maxTokenAgeHours) return fail(`token age ${pool.token_age_hours}h > max ${s.maxTokenAgeHours}h`);
  if (pool.pool_fees_sol == null) return fail("pool_fees unavailable");
  if (pool.pool_fees_sol < s.minTokenFeesSol) return fail(`pool_fees ${pool.pool_fees_sol} SOL < min ${s.minTokenFeesSol} SOL`);

  const launchpad = tokenInfo?.launchpad ?? null;
  if (launchpad && s.blockedLaunchpads.includes(launchpad)) return fail(`blocked launchpad ${launchpad}`);

  const botPct = numberOrNull(tokenInfo?.audit?.bot_holders_pct);
  if (botPct != null && s.maxBotHoldersPct != null && botPct > s.maxBotHoldersPct) return fail(`bots ${botPct}% > max ${s.maxBotHoldersPct}%`);

  const top10Pct = numberOrNull(tokenInfo?.audit?.top_holders_pct);
  if (top10Pct != null && s.maxTop10Pct != null && top10Pct > s.maxTop10Pct) return fail(`top10 ${top10Pct}% > max ${s.maxTop10Pct}%`);

  if (pool.bundle_pct != null && s.maxBundlePct != null && pool.bundle_pct > s.maxBundlePct) return fail(`bundle ${pool.bundle_pct}% > max ${s.maxBundlePct}%`);

  if (pool.is_wash) return fail("wash trading flagged");
  if (pool.is_rugpull) return fail("rugpull flagged");

  if (s.athFilterPct != null && pool.price_vs_ath_pct != null) {
    const threshold = 100 + s.athFilterPct;
    if (pool.price_vs_ath_pct > threshold) return fail(`price_vs_ath ${pool.price_vs_ath_pct}% > limit ${threshold}%`);
  }

  if (s.blockPvpSymbols && pool.is_pvp) {
    return fail(`pvp rival: ${pool.pvp_rival_name} (tvl=$${pool.pvp_rival_tvl})`);
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
    fee_window: round(p.fee),
    pool_fees_sol: null,
    pool_fees_source: null,
    volume_window: round(p.volume),
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
