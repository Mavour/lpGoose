import assert from "node:assert/strict";
import {
  applyRuntimeConfig,
  config,
  formatRuntimeConfigSnapshot,
} from "../config.js";
import {
  calculateMomentum,
  calculateWeakMomentumFallback,
  fetchMomentumCandles,
  formatMomentumLog,
  validateMomentumCandles,
} from "../tools/momentum.js";
import { confirmSupertrendFromCandles } from "../tools/chart-indicators.js";
import { deployPosition } from "../tools/dlmm.js";
import { getGmgnPoolFees } from "../tools/gmgn.js";
import { dedupePoolsByAddress, evaluateScreeningGate, verifyLiveEntryGuards } from "../tools/screening.js";

const FIVE_MINUTES = 5 * 60_000;
const now = Date.UTC(2026, 5, 11, 6, 0, 0);
const originalRuntimeConfig = {
  minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
  momentumStrongThreshold: config.momentum.strongThreshold,
  momentumStrongMinBins: config.momentum.strongMinBins,
  momentumStrongMaxBins: config.momentum.strongMaxBins,
  momentumWeakMinBins: config.momentum.weakMinBins,
  momentumWeakMaxBins: config.momentum.weakMaxBins,
  momentumMaxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
  momentumMaxRetries: config.momentum.maxRetries,
  momentumRetryDelayMs: config.momentum.retryDelayMs,
  chartIndicators: { ...config.chartIndicators },
};

function candles({
  baselineVolume = 100,
  latestVolume = 200,
  previousClose = 100,
  latestClose = 110,
} = {}) {
  return Array.from({ length: 12 }, (_, index) => {
    const isLatest = index === 11;
    const close = isLatest ? latestClose : previousClose - (10 - index) * 0.1;
    return {
      time: Math.floor((now - (13 - index) * FIVE_MINUTES) / 1000),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: isLatest ? latestVolume : baselineVolume,
    };
  });
}

const strong = calculateMomentum({
  candles: candles(),
  feeActiveTvlRatio: 0.8,
  minFeeActiveTvlRatio: 0.2,
  volatility: 2.5,
  now,
});
assert.equal(strong.valid, true);
assert.equal(strong.classification, "strong");
assert.equal(strong.score, 80);
assert.equal(strong.binsBelow, 55);
assert.ok(strong.binsBelow >= 40 && strong.binsBelow <= 70);

const boundaryStrong = calculateMomentum({
  candles: candles({ latestVolume: 166.6666667, latestClose: 110 }),
  feeActiveTvlRatio: 0.8,
  minFeeActiveTvlRatio: 0.2,
  volatility: 5,
  now,
});
assert.equal(boundaryStrong.score, 70);
assert.equal(boundaryStrong.classification, "strong");
assert.equal(boundaryStrong.binsBelow, 70);

const weak = calculateMomentum({
  candles: candles({ latestVolume: 100, latestClose: 100 }),
  feeActiveTvlRatio: 0.2,
  minFeeActiveTvlRatio: 0.2,
  volatility: 5,
  now,
});
assert.equal(weak.score, 0);
assert.equal(weak.classification, "weak");
assert.equal(weak.binsBelow, 150);

const ageBands = {
  newMaxHours: 24,
  youngMaxHours: 48,
  matureMaxHours: 120,
  newMinBins: 90,
  newMaxBins: 150,
  youngMinBins: 70,
  youngMaxBins: 110,
  matureMinBins: 55,
  matureMaxBins: 85,
  oldMinBins: 45,
  oldMaxBins: 70,
};
const newToken = calculateMomentum({
  candles: candles({ latestVolume: 100, latestClose: 100 }),
  feeActiveTvlRatio: 0.2,
  minFeeActiveTvlRatio: 0.2,
  volatility: 5,
  tokenAgeHours: 6,
  ageBands,
  now,
});
assert.equal(newToken.ageBand, "new");
assert.deepEqual(newToken.selectedBand, [90, 150]);
assert.equal(newToken.binsBelow, 150);

const oldToken = calculateMomentum({
  candles: candles({ latestVolume: 100, latestClose: 100 }),
  feeActiveTvlRatio: 0.2,
  minFeeActiveTvlRatio: 0.2,
  volatility: 2.5,
  tokenAgeHours: 240,
  ageBands,
  now,
});
assert.equal(oldToken.ageBand, "old");
assert.deepEqual(oldToken.selectedBand, [45, 70]);
assert.equal(oldToken.binsBelow, 58);

applyRuntimeConfig({
  minFeeActiveTvlRatio: 0.1,
  momentumWeakMaxBins: 125,
  momentumOldMaxBins: 72,
  chartIndicators: {
    ...config.chartIndicators,
    stPeriod: 7,
  },
});
assert.equal(config.screening.minFeeActiveTvlRatio, 0.1);
assert.equal(config.momentum.weakMaxBins, 125);
assert.equal(config.momentum.oldMaxBins, 72);
assert.equal(config.chartIndicators.stPeriod, 7);

const runtimeChanges = applyRuntimeConfig({
  minFeeActiveTvlRatio: 0.2,
  momentumStrongThreshold: 70,
  momentumStrongMinBins: 40,
  momentumStrongMaxBins: 70,
  momentumWeakMinBins: 70,
  momentumWeakMaxBins: 150,
  momentumOldMaxBins: 70,
  chartIndicators: {
    ...config.chartIndicators,
    entryPreset: "supertrend_break",
    stPeriod: 10,
    stMultiplier: 3,
    entryInterval: "5m",
  },
});
assert.ok(runtimeChanges.some((change) => change.key === "momentum.weakMaxBins"));
assert.ok(runtimeChanges.some((change) => change.key === "momentum.oldMaxBins"));
assert.equal(config.screening.minFeeActiveTvlRatio, 0.2);
assert.equal(config.momentum.weakMaxBins, 150);
assert.equal(config.chartIndicators.stPeriod, 10);
assert.match(formatRuntimeConfigSnapshot(), /min_fee_active_tvl=0.2%/);
assert.match(formatRuntimeConfigSnapshot(), /weak_band=70-150/);
assert.match(formatRuntimeConfigSnapshot(), /age_bands=<24h:90-150,<48h:70-110,<120h:55-85,old:45-70/);
assert.match(formatRuntimeConfigSnapshot(), /supertrend=5m\/10\/3/);

const magpieCandles = Array.from({ length: 12 }, (_, index) => ({
  time: Math.floor((now - (13 - index) * FIVE_MINUTES) / 1000),
  open: 0.0009296073,
  high: 0.00094,
  low: 0.00091,
  close: index === 11 ? 0.0009269445 : 0.0009296073,
  volume: index === 11 ? 4036.89 : 5661.11,
}));
const magpie = calculateMomentum({
  candles: magpieCandles,
  feeActiveTvlRatio: 0.5406,
  minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
  volatility: 8.21,
  strongThreshold: config.momentum.strongThreshold,
  strongMinBins: config.momentum.strongMinBins,
  strongMaxBins: config.momentum.strongMaxBins,
  weakMinBins: config.momentum.weakMinBins,
  weakMaxBins: config.momentum.weakMaxBins,
  now,
});
assert.equal(magpie.valid, true);
assert.ok(Math.abs(magpie.feeScore - 17.03) < 0.001);
assert.equal(magpie.score, 17);
assert.equal(magpie.classification, "weak");
assert.deepEqual(magpie.selectedBand, [70, 150]);
assert.equal(magpie.binsBelow, 150);

const outlierBaseline = candles({ baselineVolume: 100, latestVolume: 200 });
outlierBaseline[0].volume = 10_000;
const robust = calculateMomentum({
  candles: outlierBaseline,
  feeActiveTvlRatio: 0.2,
  minFeeActiveTvlRatio: 0.2,
  volatility: 0,
  now,
});
assert.equal(robust.baselineMedianVolume, 100);
assert.equal(robust.volumeRatio, 2);
assert.equal(robust.volumeScore, 30);

const negativePrice = calculateMomentum({
  candles: candles({ previousClose: 100, latestClose: 90 }),
  feeActiveTvlRatio: 0.2,
  minFeeActiveTvlRatio: 0.2,
  volatility: 0,
  now,
});
assert.equal(negativePrice.priceScore, 0);

const zeroBaseline = candles();
zeroBaseline.slice(0, 11).forEach((candle) => { candle.volume = 0; });
const zeroBaselineResult = calculateMomentum({
  candles: zeroBaseline,
  feeActiveTvlRatio: 0.5,
  minFeeActiveTvlRatio: 0.2,
  volatility: 2,
  now,
});
assert.equal(zeroBaselineResult.reason, "zero_volume_baseline");
const validatedZeroBaseline = validateMomentumCandles(zeroBaseline, { now });
const fallbackWeak = calculateWeakMomentumFallback({
  validatedCandles: validatedZeroBaseline,
  volatility: 2,
  weakMinBins: 70,
  weakMaxBins: 150,
  reason: `supertrend_confirmed_momentum_fallback: ${zeroBaselineResult.reason}`,
});
assert.equal(fallbackWeak.valid, true);
assert.equal(fallbackWeak.classification, "fallback_weak");
assert.equal(fallbackWeak.binsBelow, 102);
assert.equal(fallbackWeak.score, null);
assert.match(fallbackWeak.reason, /zero_volume_baseline/);

const stale = candles();
stale.forEach((candle) => { candle.time -= 20 * 60; });
assert.equal(validateMomentumCandles(stale, { now }).reason, "stale_candle");

const gap = candles();
gap[6].time += 5 * 60;
assert.match(validateMomentumCandles(gap, { now }).reason, /duplicate|gap/);

assert.equal(validateMomentumCandles(candles().slice(1), { now }).reason, "insufficient_closed_candles");
const malformed = candles();
malformed[4].close = Number.NaN;
assert.equal(validateMomentumCandles(malformed, { now }).reason, "malformed_candle");

let attempts = 0;
const retrySuccess = await fetchMomentumCandles({
  mint: "test",
  maxRetries: 2,
  retryDelayMs: 0,
  sleep: async () => {},
  fetchCandles: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("GMGN 429: rate limited");
    return candles();
  },
});
assert.equal(retrySuccess.success, true);
assert.equal(retrySuccess.attempt, 2);

const authFailure = await fetchMomentumCandles({
  mint: "test",
  maxRetries: 1,
  retryDelayMs: 0,
  sleep: async () => {},
  fetchCandles: async () => { throw new Error("GMGN 401: unauthorized"); },
});
assert.equal(authFailure.success, false);
assert.equal(authFailure.errorType, "auth_error");
assert.equal(authFailure.attempt, 1);

for (const [message, expectedType] of [
  ["The operation was aborted due to timeout", "timeout"],
  ["GMGN API returned non-JSON", "malformed_json"],
  ["GMGN insufficient data: 4 candles", "insufficient_candles"],
]) {
  const failure = await fetchMomentumCandles({
    mint: "test",
    maxRetries: 0,
    retryDelayMs: 0,
    sleep: async () => {},
    fetchCandles: async () => { throw new Error(message); },
  });
  assert.equal(failure.errorType, expectedType);
}

const sharedCandles = strong.candles;
const supertrend = confirmSupertrendFromCandles(sharedCandles, { period: 3, multiplier: 1 });
assert.equal(supertrend.signal.candleTime, sharedCandles.at(-1).time);

const logLine = formatMomentumLog({
  pool: "pool",
  mint: "mint",
  result: strong,
  gmgnAttempt: 1,
  poolFeesSol: 42,
  poolFeesSource: "gmgn_pool",
  feeTimeframe: "30m",
  decision: "deploy",
  reason: "test",
});
assert.match(logLine, /pool_fees_source=gmgn_pool/);
assert.match(logLine, /final_bins_below=55/);
assert.match(logLine, /min_fee_active_tvl_ratio=0.2000%/);
assert.match(logLine, /strong_threshold=70/);
assert.match(logLine, /strong_band=40-70/);
assert.match(logLine, /weak_band=70-150/);

const poolFee = await getGmgnPoolFees(
  { mint: "mint", pool_address: "TargetPool" },
  {
    fetchData: async () => ({
      data: {
        pools: [
          { pool_address: "OtherPool", pool_fees_sol: 999 },
          { pool_address: "TargetPool", pool_fees_sol: 42, timeframe: "24h" },
        ],
      },
    }),
  },
);
assert.deepEqual(poolFee, {
  pool_fees_sol: 42,
  source: "gmgn_pool",
  timeframe: "24h",
  scope: "pool",
});

const tokenOnlyFee = await getGmgnPoolFees(
  { mint: "mint", pool_address: "TargetPool" },
  { fetchData: async () => ({ data: { total_fee: 57.64 } }) },
);
assert.deepEqual(tokenOnlyFee, {
  pool_fees_sol: 57.64,
  source: "gmgn_token_total",
  timeframe: "all_time",
  scope: "token",
});

const gatePool = {
  pool: "FeeSourceTestPool",
  base: { mint: "FeeSourceTestMint", symbol: "TEST" },
  quote: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  active_tvl: 10_000,
  volume_window: 10_000,
  organic_score: 100,
  mcap: 500_000,
  bin_step: 100,
  fee_active_tvl_ratio: 0.5,
  token_age_hours: 24,
  pool_fees_sol: 100,
  pool_fees_source: "token_total",
  pool_fees_unit: "SOL",
  price_vs_ath_pct: 10,
  ath: 1,
  pvp_check_status: "verified",
  is_pvp: false,
};
assert.match(
  evaluateScreeningGate(gatePool, { tokenInfo: { launchpad: "pump.fun", audit: {} } }).reason,
  /source unverified/,
);
gatePool.pool_fees_source = "gmgn_pool";
assert.equal(
  evaluateScreeningGate(gatePool, { tokenInfo: { launchpad: "pump.fun", audit: {} } }).pass,
  true,
);
gatePool.pool_fees_source = "gmgn_token_total";
assert.equal(
  evaluateScreeningGate(gatePool, { tokenInfo: { launchpad: "pump.fun", audit: {} } }).pass,
  true,
);
gatePool.price_vs_ath_pct = null;
gatePool.ath = null;
assert.match(
  evaluateScreeningGate(gatePool, { tokenInfo: { launchpad: "pump.fun", audit: {} } }).reason,
  /ATH data unavailable/,
);

const liveGuard = await verifyLiveEntryGuards(
  { poolAddress: "TargetPool", mint: "mint" },
  {
    getPoolFees: async () => ({
      pool_fees_sol: 57.64,
      source: "gmgn_token_total",
      timeframe: "all_time",
      price: 0.95,
      ath: 1,
      price_vs_ath_pct: 95,
    }),
  },
);
assert.equal(liveGuard.pass, false);
assert.match(liveGuard.reason, /price_vs_ath 95%/);

const missingAthGuard = await verifyLiveEntryGuards(
  { poolAddress: "TargetPool", mint: "mint" },
  {
    getPoolFees: async () => ({ pool_fees_sol: 57.64, source: "gmgn_pool" }),
  },
);
assert.equal(missingAthGuard.pass, false);
assert.match(missingAthGuard.reason, /ATH data unavailable/);

assert.deepEqual(
  dedupePoolsByAddress([
    { pool: "PoolA", name: "A" },
    { pool: "PoolA", name: "A duplicate" },
    { pool: "PoolB", name: "B" },
  ]).map((pool) => pool.pool),
  ["PoolA", "PoolB"],
);

const originalDryRun = process.env.DRY_RUN;
process.env.DRY_RUN = "true";
await assert.rejects(
  deployPosition({
    pool_address: "11111111111111111111111111111111",
    amount_sol: 0.1,
    bins_below: strong.binsBelow + 1,
    bins_above: 0,
    momentum: { ...strong, candles: undefined, latestCandleTime: new Date(Date.now() - 10 * 60_000).toISOString() },
  }),
  /Momentum range enforcement failed/,
);
const manual = await deployPosition({
  pool_address: "11111111111111111111111111111111",
  amount_sol: 0.1,
  bins_below: 90,
  bins_above: 0,
}, { manualRange: true });
assert.equal(manual.dry_run, true);
assert.equal(manual.would_deploy.bins_below, 90);
process.env.DRY_RUN = originalDryRun;
applyRuntimeConfig(originalRuntimeConfig);

console.log("Momentum tests passed");
process.exit(0);
