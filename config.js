import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minVolumeToActiveTvlRatio: u.minVolumeToActiveTvlRatio ?? null,
    minMomentumScore:  u.minMomentumScore  ?? null,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // [30] Hard min - skip pools with pool fees < 30 SOL. Rug/scam filter.
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    allowedLaunchpads:  u.allowedLaunchpads  ?? [],  // empty = allow any launchpad not blocked
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    avoidPvpSymbols:    u.avoidPvpSymbols    ?? true,  // detect PvP rivals with same symbol
    blockPvpSymbols:    u.blockPvpSymbols    ?? false, // hard-filter PvP pools before LLM sees them
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    downsideOutOfRangeWaitMinutes: u.downsideOutOfRangeWaitMinutes ?? u.outOfRangeWaitMinutes ?? 30,
    downsideOutOfRangeLossPct: u.downsideOutOfRangeLossPct ?? null,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -10,
    dangerDrawdownPct:     u.dangerDrawdownPct     ?? -5,
    dangerHardClosePct:    u.dangerHardClosePct    ?? -8,
    dangerGraceMinutes:    u.dangerGraceMinutes    ?? 10,
    dangerCloseMomentumBelow: u.dangerCloseMomentumBelow ?? 40,
    dangerClosePriceChange5mPct: u.dangerClosePriceChange5mPct ?? -1,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    tokenCloseCooldownMinutes: u.tokenCloseCooldownMinutes ?? null,
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // Disabled by default when lifecycle FSM is on (fee-maxi uses fixed perPositionSol).
  confidence: {
    enabled: u.confidenceEnabled ?? !(u.lifecycle?.enabled ?? true),
    fullThreshold: u.confidenceFullThreshold ?? 70,
    skipThreshold: u.confidenceSkipThreshold ?? 40,
    halfMultiplier: u.confidenceHalfMultiplier ?? 0.5,
    smartWalletMaxAgeMinutes: u.smartWalletMaxAgeMinutes ?? 60,
  },

  momentum: {
    strongThreshold: u.momentumStrongThreshold ?? u.momentum?.strongThreshold ?? 70,
    strongMinBins: u.momentumStrongMinBins ?? u.momentum?.strongMinBins ?? 40,
    strongMaxBins: u.momentumStrongMaxBins ?? u.momentum?.strongMaxBins ?? 70,
    weakMinBins: u.momentumWeakMinBins ?? u.momentum?.weakMinBins ?? 70,
    weakMaxBins: u.momentumWeakMaxBins ?? u.momentum?.weakMaxBins ?? 150,
    ageNewMaxHours: u.momentumAgeNewMaxHours ?? u.momentum?.ageNewMaxHours ?? 24,
    ageYoungMaxHours: u.momentumAgeYoungMaxHours ?? u.momentum?.ageYoungMaxHours ?? 48,
    ageMatureMaxHours: u.momentumAgeMatureMaxHours ?? u.momentum?.ageMatureMaxHours ?? 120,
    newMinBins: u.momentumNewMinBins ?? u.momentum?.newMinBins ?? 90,
    newMaxBins: u.momentumNewMaxBins ?? u.momentum?.newMaxBins ?? 150,
    youngMinBins: u.momentumYoungMinBins ?? u.momentum?.youngMinBins ?? 70,
    youngMaxBins: u.momentumYoungMaxBins ?? u.momentum?.youngMaxBins ?? 110,
    matureMinBins: u.momentumMatureMinBins ?? u.momentum?.matureMinBins ?? 55,
    matureMaxBins: u.momentumMatureMaxBins ?? u.momentum?.matureMaxBins ?? 85,
    oldMinBins: u.momentumOldMinBins ?? u.momentum?.oldMinBins ?? 45,
    oldMaxBins: u.momentumOldMaxBins ?? u.momentum?.oldMaxBins ?? 70,
    maxCandleAgeMinutes: u.momentumMaxCandleAgeMinutes ?? u.momentum?.maxCandleAgeMinutes ?? 10,
    maxRetries: u.momentumMaxRetries ?? u.momentum?.maxRetries ?? 2,
    retryDelayMs: u.momentumRetryDelayMs ?? u.momentum?.retryDelayMs ?? 500,
  },

  // ─── Chart Indicators (Supertrend) ───
  // Off by default with lifecycle: fee-maxi uses candle regime only, not Supertrend.
  chartIndicators: {
    enabled:       u.chartIndicators?.enabled       ?? !(u.lifecycle?.enabled ?? true),
    entryPreset:   u.chartIndicators?.entryPreset   ?? "supertrend_trend",
    entryMinPriceChangePct: u.chartIndicators?.entryMinPriceChangePct ?? -1,
    stPeriod:      u.chartIndicators?.stPeriod      ?? 10,
    stMultiplier:  u.chartIndicators?.stMultiplier  ?? 3,
    interval:      u.chartIndicators?.interval      ?? "5m",
    entryInterval: u.chartIndicators?.entryInterval ?? u.chartIndicators?.interval ?? "5m",
    exitInterval:  u.chartIndicators?.exitInterval  ?? "15m",
    failOpen:      u.chartIndicators?.failOpen      ?? false,
    exitOnBearishFlip: u.chartIndicators?.exitOnBearishFlip ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    minBinsBelow: u.minBinsBelow ?? 30,
    maxBinsBelow: u.maxBinsBelow ?? 55,
    mixedRatio: u.mixedRatio ?? { bidask: 70, spot: 30 },
  },

  // Removed from active product (fee-maxi / lifecycle only). Kept stub for old state files.
  bottomSpotLP: {
    enabled: false,
  },

  // ─── Lifecycle FSM (fee-maxi style) ─────
  // When enabled: single-position flip/reshape/rebalance + risk exit;
  // auto screening still deploys; legacy multi-exit poller is bypassed.
  lifecycle: {
    enabled: u.lifecycle?.enabled ?? true,
    capital: {
      perPositionSol: u.lifecycle?.capital?.perPositionSol ?? u.deployAmountSol ?? 0.2,
      minSolReserve: u.lifecycle?.capital?.minSolReserve ?? u.gasReserve ?? 0.05,
      txFeeBufferSol: u.lifecycle?.capital?.txFeeBufferSol ?? 0.005,
      newPositionOverheadSol: u.lifecycle?.capital?.newPositionOverheadSol ?? 0.012,
    },
    entry: {
      bidAskRangeBins: u.lifecycle?.entry?.bidAskRangeBins ?? 20,
      curveBinsMin: u.lifecycle?.entry?.curveBinsMin ?? 35,
      curveBinsMax: u.lifecycle?.entry?.curveBinsMax ?? 60,
      volatilityFullRangePct: u.lifecycle?.entry?.volatilityFullRangePct ?? 8,
      lpSlippagePct: u.lifecycle?.entry?.lpSlippagePct ?? 1,
      lookbackCandles: u.lifecycle?.entry?.lookbackCandles ?? 48,
      pumpPctThreshold: u.lifecycle?.entry?.pumpPctThreshold ?? 50,
      downtrendPctThreshold: u.lifecycle?.entry?.downtrendPctThreshold ?? -25,
      bottomDrawdownPct: u.lifecycle?.entry?.bottomDrawdownPct ?? -40,
      bottomFlatSlopePct: u.lifecycle?.entry?.bottomFlatSlopePct ?? 2,
      bottomSlopeCandles: u.lifecycle?.entry?.bottomSlopeCandles ?? 6,
    },
    flip: {
      ratioLow: u.lifecycle?.flip?.ratioLow ?? 0.4,
      ratioHigh: u.lifecycle?.flip?.ratioHigh ?? 0.6,
    },
    reshape: {
      binTrigger: u.lifecycle?.reshape?.binTrigger ?? 3,
      claimEach: u.lifecycle?.reshape?.claimEach ?? true,
      minReshapeIntervalMs: u.lifecycle?.reshape?.minReshapeIntervalMs ?? 10_000,
      walletSettleMs: u.lifecycle?.reshape?.walletSettleMs ?? 800,
      depositSafetyBps: u.lifecycle?.reshape?.depositSafetyBps ?? 9950,
    },
    rebalance: {
      oorBufferBins: u.lifecycle?.rebalance?.oorBufferBins ?? 0,
      cooldownMs: u.lifecycle?.rebalance?.cooldownMs ?? 15_000,
      trigger: u.lifecycle?.rebalance?.trigger ?? "both",
    },
    risk: {
      takeProfitPct: u.lifecycle?.risk?.takeProfitPct ?? 30,
      stopLossPct: u.lifecycle?.risk?.stopLossPct ?? -15,
      maxLossPct: u.lifecycle?.risk?.maxLossPct ?? -25,
      confirmMs: u.lifecycle?.risk?.confirmMs ?? 3000,
      suppressMsAfterEntry: u.lifecycle?.risk?.suppressMsAfterEntry ?? 12_000,
      suppressMsAfterLiquidityOp: u.lifecycle?.risk?.suppressMsAfterLiquidityOp ?? 12_000,
    },
    pollIntervalMs: u.lifecycle?.pollIntervalMs ?? 5000,
    // Cap fee_tvl at entry (history: extreme fee_tvl → fat-tail losses)
    maxFeeActiveTvlRatio: u.lifecycle?.maxFeeActiveTvlRatio ?? 1.2,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
    pnlPollIntervalMs:      u.pnlPollIntervalMs      ?? 3_000,
    pnlNormalPollIntervalMs: u.pnlNormalPollIntervalMs ?? 15_000,
    pnlNoPositionPollIntervalMs: u.pnlNoPositionPollIntervalMs ?? 60_000,
    pnlSlowCheckIntervalMs: u.pnlSlowCheckIntervalMs ?? 30_000,
    pnlSignatureCheckIntervalMs: u.pnlSignatureCheckIntervalMs ?? 60_000,
    pnlDiscoveryTtlMs:      u.pnlDiscoveryTtlMs      ?? 120_000,
    lpAgentPnlNormalTtlMs:  u.lpAgentPnlNormalTtlMs  ?? 30_000,
    lpAgentPnlUrgentTtlMs:  u.lpAgentPnlUrgentTtlMs  ?? 15_000,
    lpAgentPnlRateLimitBackoffMs: u.lpAgentPnlRateLimitBackoffMs ?? 60_000,
    emptyPositionsCacheTtlMs: u.emptyPositionsCacheTtlMs ?? 120_000,
    screeningWatchdogMs:    u.screeningWatchdogMs    ?? 10 * 60_000,
    urgentPositionsTimeoutMs: u.urgentPositionsTimeoutMs ?? 4_000,
    shutdownTimeoutMs:      u.shutdownTimeoutMs      ?? 8_000,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  learning: {
    enabled: u.learning?.enabled ?? u.learningEnabled ?? true,
    minClosedPositions: u.learning?.minClosedPositions ?? u.learningMinClosedPositions ?? 5,
    proposalCooldownHours: u.learning?.proposalCooldownHours ?? u.learningProposalCooldownHours ?? 24,
    maxChangesPerProposal: u.learning?.maxChangesPerProposal ?? u.learningMaxChangesPerProposal ?? 3,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

const RUNTIME_CONFIG_FIELDS = {
  screening: {
    minFeeActiveTvlRatio: ["minFeeActiveTvlRatio"],
    minTvl: ["minTvl"],
    maxTvl: ["maxTvl"],
    minVolume: ["minVolume"],
    minVolumeToActiveTvlRatio: ["minVolumeToActiveTvlRatio"],
    minMomentumScore: ["minMomentumScore"],
    minOrganic: ["minOrganic"],
    minHolders: ["minHolders"],
    minMcap: ["minMcap"],
    maxMcap: ["maxMcap"],
    minBinStep: ["minBinStep"],
    maxBinStep: ["maxBinStep"],
    timeframe: ["timeframe"],
    category: ["category"],
    minTokenFeesSol: ["minTokenFeesSol"],
    maxBotHoldersPct: ["maxBotHoldersPct"],
    maxTop10Pct: ["maxTop10Pct"],
    blockedLaunchpads: ["blockedLaunchpads"],
    allowedLaunchpads: ["allowedLaunchpads"],
    minTokenAgeHours: ["minTokenAgeHours"],
    maxTokenAgeHours: ["maxTokenAgeHours"],
    athFilterPct: ["athFilterPct"],
    avoidPvpSymbols: ["avoidPvpSymbols"],
    blockPvpSymbols: ["blockPvpSymbols"],
  },
  momentum: {
    strongThreshold: ["momentumStrongThreshold", "momentum", "strongThreshold"],
    strongMinBins: ["momentumStrongMinBins", "momentum", "strongMinBins"],
    strongMaxBins: ["momentumStrongMaxBins", "momentum", "strongMaxBins"],
    weakMinBins: ["momentumWeakMinBins", "momentum", "weakMinBins"],
    weakMaxBins: ["momentumWeakMaxBins", "momentum", "weakMaxBins"],
    ageNewMaxHours: ["momentumAgeNewMaxHours", "momentum", "ageNewMaxHours"],
    ageYoungMaxHours: ["momentumAgeYoungMaxHours", "momentum", "ageYoungMaxHours"],
    ageMatureMaxHours: ["momentumAgeMatureMaxHours", "momentum", "ageMatureMaxHours"],
    newMinBins: ["momentumNewMinBins", "momentum", "newMinBins"],
    newMaxBins: ["momentumNewMaxBins", "momentum", "newMaxBins"],
    youngMinBins: ["momentumYoungMinBins", "momentum", "youngMinBins"],
    youngMaxBins: ["momentumYoungMaxBins", "momentum", "youngMaxBins"],
    matureMinBins: ["momentumMatureMinBins", "momentum", "matureMinBins"],
    matureMaxBins: ["momentumMatureMaxBins", "momentum", "matureMaxBins"],
    oldMinBins: ["momentumOldMinBins", "momentum", "oldMinBins"],
    oldMaxBins: ["momentumOldMaxBins", "momentum", "oldMaxBins"],
    maxCandleAgeMinutes: ["momentumMaxCandleAgeMinutes", "momentum", "maxCandleAgeMinutes"],
    maxRetries: ["momentumMaxRetries", "momentum", "maxRetries"],
    retryDelayMs: ["momentumRetryDelayMs", "momentum", "retryDelayMs"],
  },
  chartIndicators: {
    enabled: ["chartIndicators", "enabled"],
    entryPreset: ["chartIndicators", "entryPreset"],
    entryMinPriceChangePct: ["chartIndicators", "entryMinPriceChangePct"],
    stPeriod: ["chartIndicators", "stPeriod"],
    stMultiplier: ["chartIndicators", "stMultiplier"],
    interval: ["chartIndicators", "interval"],
    entryInterval: ["chartIndicators", "entryInterval"],
    exitInterval: ["chartIndicators", "exitInterval"],
    failOpen: ["chartIndicators", "failOpen"],
    exitOnBearishFlip: ["chartIndicators", "exitOnBearishFlip"],
  },
  management: {
    stopLossPct: ["stopLossPct", "management", "stopLossPct"],
    dangerDrawdownPct: ["dangerDrawdownPct", "management", "dangerDrawdownPct"],
    dangerHardClosePct: ["dangerHardClosePct", "management", "dangerHardClosePct"],
    dangerGraceMinutes: ["dangerGraceMinutes", "management", "dangerGraceMinutes"],
    dangerCloseMomentumBelow: ["dangerCloseMomentumBelow", "management", "dangerCloseMomentumBelow"],
    dangerClosePriceChange5mPct: ["dangerClosePriceChange5mPct", "management", "dangerClosePriceChange5mPct"],
    tokenCloseCooldownMinutes: ["tokenCloseCooldownMinutes", "management", "tokenCloseCooldownMinutes"],
  },
};

function getConfigValue(source, pathParts) {
  let current = source;
  for (const part of pathParts) {
    if (current == null || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function getFirstConfigValue(source, pathParts) {
  if (pathParts.length <= 2) return getConfigValue(source, pathParts);
  const flat = getConfigValue(source, [pathParts[0]]);
  return flat.found ? flat : getConfigValue(source, pathParts.slice(1));
}

export function applyRuntimeConfig(fresh) {
  const changes = [];
  for (const [section, fields] of Object.entries(RUNTIME_CONFIG_FIELDS)) {
    for (const [field, sourcePath] of Object.entries(fields)) {
      const next = getFirstConfigValue(fresh, sourcePath);
      if (!next.found) continue;
      const previous = config[section][field];
      if (JSON.stringify(previous) === JSON.stringify(next.value)) continue;
      config[section][field] = next.value;
      changes.push({
        key: `${section}.${field}`,
        previous,
        value: next.value,
      });
    }
  }
  return changes;
}

export function formatRuntimeConfigSnapshot() {
  const s = config.screening;
  const m = config.momentum;
  const c = config.chartIndicators;
  const minVolumeTvl = normalizeVolumeTvlThreshold(s.minVolumeToActiveTvlRatio);
  return [
    `min_fee_active_tvl=${s.minFeeActiveTvlRatio}%`,
    `min_volume=${s.minVolume}`,
    `min_volume_tvl=${minVolumeTvl == null ? "off" : `${Number((minVolumeTvl * 100).toFixed(4))}%`}`,
    `min_momentum=${s.minMomentumScore ?? "off"}`,
    `momentum_threshold=${m.strongThreshold}`,
    `strong_band=${m.strongMinBins}-${m.strongMaxBins}`,
    `weak_band=${m.weakMinBins}-${m.weakMaxBins}`,
    `age_bands=<${m.ageNewMaxHours}h:${m.newMinBins}-${m.newMaxBins},<${m.ageYoungMaxHours}h:${m.youngMinBins}-${m.youngMaxBins},<${m.ageMatureMaxHours}h:${m.matureMinBins}-${m.matureMaxBins},old:${m.oldMinBins}-${m.oldMaxBins}`,
    `supertrend=${c.entryInterval || c.interval}/${c.stPeriod}/${c.stMultiplier}`,
    `entry_preset=${c.entryPreset}`,
    `entry_min_change=${c.entryMinPriceChangePct}%`,
    `ath_filter=${s.athFilterPct ?? "off"}`,
  ].join(" | ");
}

function normalizeVolumeTvlThreshold(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * Reload only entry-screening configuration that is safe to change while the
 * process is running. Wallet, RPC, and process-level settings still require a
 * restart.
 */
export function reloadRuntimeConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return { changes: [], error: null };
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    return { changes: applyRuntimeConfig(fresh), error: null };
  } catch (error) {
    return { changes: [], error: error.message };
  }
}

// Backward-compatible alias for callers outside this repository.
export const reloadScreeningThresholds = reloadRuntimeConfig;
