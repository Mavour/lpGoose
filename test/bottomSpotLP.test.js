import assert from "assert";
import {
  calculateBinRange,
  detectDumpAndRetrace,
  evaluateExitSignal,
} from "../strategies/bottomSpotLP.js";

function candle(close, spread = 0.01) {
  return {
    open: close,
    high: close * (1 + spread),
    low: close * (1 - spread),
    close,
    volume: 1_000,
  };
}

function buildCandles(values) {
  return values.map((value) => candle(value));
}

function sineCandles(length = 60, base = 100, amplitude = 5) {
  const candles = [];
  for (let i = 0; i < length; i++) {
    const close = base + Math.sin(i / 4) * amplitude;
    candles.push(candle(close, 0.005));
  }
  return candles;
}

const validDump = buildCandles([
  70, 76, 82, 90, 100, 96, 88, 74, 55, 46, 48, 52, 54,
]);
const dumpSignal = detectDumpAndRetrace(validDump, {
  minDumpPct: 45,
  minRetracePct: 5,
  athLookbackCandles: 48,
});
assert.equal(dumpSignal.triggered, true, "valid 45% dump and retrace should trigger");
assert.ok(dumpSignal.dumpPct >= 45, "dump pct should meet configured threshold");
assert.ok(dumpSignal.retracePct >= 5, "retrace pct should meet configured threshold");

const noDump = buildCandles([80, 90, 100, 96, 94, 92, 91, 90, 89, 88, 87]);
assert.equal(
  detectDumpAndRetrace(noDump, { minDumpPct: 45, minRetracePct: 5 }).triggered,
  false,
  "shallow pullback should not trigger",
);

const noRetrace = buildCandles([70, 80, 100, 90, 70, 55, 48, 47, 46, 45, 44]);
assert.equal(
  detectDumpAndRetrace(noRetrace, { minDumpPct: 45, minRetracePct: 5 }).triggered,
  false,
  "dump without retrace should not trigger",
);

assert.equal(
  detectDumpAndRetrace([candle(1), null, candle(2)], {}).reason,
  "insufficient_data",
  "insufficient data should be safe",
);

const range = calculateBinRange(100, 100, { rangePct: -45 });
assert.equal(range.valid, true, "valid bin range should pass");
assert.ok(range.lowerPrice > 0, "lower price must be positive");
assert.ok(range.upperPrice > range.lowerPrice, "upper must be above lower");
assert.ok(range.totalBins >= 20, "45% at 100 bps should be a useful range");

const wideRange = calculateBinRange(100, 25, { rangePct: -45 });
assert.equal(wideRange.valid, true, "wide valid range should still pass");
assert.ok(wideRange.totalBins > 200, "25 bps should warn via totalBins > 200");

const upOnly = Array.from({ length: 35 }, (_, i) => candle(100 + i * 3, 0.001));
const rsiExit = evaluateExitSignal(upOnly, {}, { rsiExitThreshold: 80 });
assert.equal(rsiExit.shouldExit, true, "strong uptrend should trigger RSI exit");
assert.equal(rsiExit.reason, "rsi_overbought", "RSI trigger reason");

const feesExit = evaluateExitSignal(sineCandles(), { accumulatedFeesPct: 6 }, {
  enableTAExit: false,
  takeProfitFeePct: 5,
});
assert.equal(feesExit.shouldExit, true, "fee target should trigger exit");
assert.equal(feesExit.reason, "fees_target_hit", "fee target reason");

const aboveRangeExit = evaluateExitSignal(sineCandles(), { upperPrice: 90 }, {
  enableTAExit: false,
});
assert.equal(aboveRangeExit.reason, "price_above_range", "above range reason");

const ilExit = evaluateExitSignal(sineCandles(), { ilPct: 30, accumulatedFeesPct: 2 }, {
  enableTAExit: false,
  maxILPct: 25,
  minFeesToOverrideStopLoss: 8,
});
assert.equal(ilExit.reason, "il_stop_loss", "IL stop reason");

console.log("Bottom Spot LP tests passed");
