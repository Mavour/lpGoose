import assert from "node:assert/strict";
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
import { evaluateScreeningGate } from "../tools/screening.js";

const FIVE_MINUTES = 5 * 60_000;
const now = Date.UTC(2026, 5, 11, 6, 0, 0);

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
  poolFeesSource: "meteora_fallback",
  feeTimeframe: "30m",
  decision: "deploy",
  reason: "test",
});
assert.match(logLine, /pool_fees_source=meteora_fallback/);
assert.match(logLine, /final_bins_below=55/);

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
});

const tokenOnlyFee = await getGmgnPoolFees(
  { mint: "mint", pool_address: "TargetPool" },
  { fetchData: async () => ({ data: { total_fees_sol: 999 } }) },
);
assert.equal(tokenOnlyFee.pool_fees_sol, null);
assert.match(tokenOnlyFee.error, /requested pool/);

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
  bundle_pct: 0,
  is_wash: false,
  is_rugpull: false,
  price_vs_ath_pct: 10,
  pvp_check_status: "verified",
  is_pvp: false,
};
assert.match(
  evaluateScreeningGate(gatePool, { tokenInfo: { launchpad: "pump.fun", audit: {} } }).reason,
  /source unverified/,
);
gatePool.pool_fees_source = "meteora_fallback";
assert.equal(
  evaluateScreeningGate(gatePool, { tokenInfo: { launchpad: "pump.fun", audit: {} } }).pass,
  true,
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

console.log("Momentum tests passed");
process.exit(0);
