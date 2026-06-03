import assert from "assert";
import { calcSupertrend } from "../tools/chart-indicators.js";

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

console.log("Supertrend tests passed");
