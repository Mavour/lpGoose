import assert from "assert";
import {
  calcSupertrend,
  closedCandlesOnly,
  confirmSupertrendFromCandles,
  requireFreshBullishBreak,
  requireFreshBearishFlip,
} from "../tools/chart-indicators.js";

function candle(close, spread = 1) {
  return {
    open: close,
    high: close + spread,
    low: close - spread,
    close,
    volume: 1,
  };
}

function assertLatest(candles, expected, label) {
  const result = calcSupertrend(candles, 3, 1);
  assert.equal(result.direction, expected.direction, `${label}: direction`);
  assert.equal(result.previousDirection, expected.previousDirection, `${label}: previousDirection`);
  assert.equal(result.supertrendBreakUp, !!expected.supertrendBreakUp, `${label}: supertrendBreakUp`);
  assert.equal(result.supertrendBreakDown, !!expected.supertrendBreakDown, `${label}: supertrendBreakDown`);
  return result;
}

const bearishBase = [
  candle(100),
  candle(98),
  candle(96),
  candle(94),
  candle(92),
  candle(90),
  candle(91),
];

assertLatest(
  [...bearishBase],
  { direction: "bearish", previousDirection: "bearish" },
  "bearish continuation",
);

const wickOnly = [
  ...bearishBase,
  { open: 90, high: 100, low: 88, close: 91, volume: 1 },
];

assertLatest(
  wickOnly,
  { direction: "bearish", previousDirection: "bearish" },
  "wick above band without close confirmation",
);

const bullishBreak = [
  ...bearishBase,
  candle(101),
];

assertLatest(
  bullishBreak,
  { direction: "bullish", previousDirection: "bearish", supertrendBreakUp: true },
  "bullish close-confirmed break",
);

const bullishContinuation = [
  ...bullishBreak,
  candle(103),
];

assertLatest(
  bullishContinuation,
  { direction: "bullish", previousDirection: "bullish" },
  "bullish continuation after break",
);

assert.equal(
  requireFreshBullishBreak(confirmSupertrendFromCandles(bullishBreak, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  })).confirmed,
  true,
  "fresh bullish break confirms entry",
);

assert.equal(
  requireFreshBullishBreak(confirmSupertrendFromCandles(bullishContinuation, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  })).confirmed,
  false,
  "bullish continuation without a fresh break does not confirm entry",
);

assert.equal(
  requireFreshBullishBreak(confirmSupertrendFromCandles(bearishBase, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  })).confirmed,
  false,
  "bearish trend does not confirm entry",
);

assert.equal(
  requireFreshBearishFlip({
    direction: "bearish",
    signal: { interval: "5m", supertrendBreakDown: true },
  }).triggered,
  true,
  "fresh bearish flip triggers exit",
);

assert.equal(
  requireFreshBearishFlip({
    direction: "bearish",
    signal: { interval: "5m", supertrendBreakDown: false },
  }).triggered,
  false,
  "bearish continuation does not repeatedly trigger exit",
);

const now = Date.UTC(2026, 5, 11, 5, 30, 0);
const candleStarts = [
  { time: Math.floor(Date.UTC(2026, 5, 11, 5, 0, 0) / 1000) },
  { time: Math.floor(Date.UTC(2026, 5, 11, 5, 15, 0) / 1000) },
  { time: Math.floor(Date.UTC(2026, 5, 11, 5, 30, 0) / 1000) },
];
assert.deepEqual(
  closedCandlesOnly(candleStarts, "15m", now).map((item) => item.time),
  candleStarts.slice(0, 2).map((item) => item.time),
  "active 15m candle is excluded",
);

console.log("Supertrend tests passed");
