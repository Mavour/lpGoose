import assert from "assert";
import {
  calcSupertrend,
  closedCandlesOnly,
  confirmEntrySupertrendBreak,
  confirmSupertrendFromCandles,
  evaluateBullishEntry,
  evaluateEntrySupertrend,
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

const lateBullishContinuation = [
  ...bullishContinuation,
  candle(104),
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

const freshEntry = evaluateBullishEntry(confirmSupertrendFromCandles(bullishBreak, {
  interval: "5m",
  period: 3,
  multiplier: 1,
}), { ath: 126.25, athFilterPct: -20 });
assert.equal(freshEntry.confirmed, true, "fresh bullish break is accepted");
assert.equal(freshEntry.barsSinceBullishBreak, 0);
assert.equal(freshEntry.priceVsAthPct, 80);

const secondCandleEntry = evaluateBullishEntry(confirmSupertrendFromCandles(bullishContinuation, {
  interval: "5m",
  period: 3,
  multiplier: 1,
}), { ath: 128.75, athFilterPct: -20 });
assert.equal(secondCandleEntry.confirmed, true, "second bullish candle is accepted");
assert.equal(secondCandleEntry.barsSinceBullishBreak, 1);
assert.equal(secondCandleEntry.priceVsAthPct, 80);

assert.equal(
  evaluateBullishEntry(confirmSupertrendFromCandles(lateBullishContinuation, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  }), { ath: 200, athFilterPct: -20 }).confirmed,
  true,
  "established bullish trend is accepted",
);

assert.equal(
  evaluateEntrySupertrend(confirmSupertrendFromCandles(bullishBreak, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  }), { entryPreset: "supertrend_break", ath: 200, athFilterPct: -20 }).confirmed,
  true,
  "supertrend_break preset accepts a fresh bullish flip",
);

assert.equal(
  evaluateEntrySupertrend(confirmSupertrendFromCandles(bullishContinuation, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  }), { entryPreset: "supertrend_break", ath: 200, athFilterPct: -20 }).confirmed,
  false,
  "supertrend_break preset rejects bullish continuation",
);

assert.equal(
  evaluateEntrySupertrend(confirmSupertrendFromCandles(bullishContinuation, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  }), { entryPreset: "supertrend_trend", ath: 200, athFilterPct: -20 }).confirmed,
  true,
  "supertrend_trend preset permits bullish continuation",
);

assert.equal(
  evaluateEntrySupertrend({
    direction: "bullish",
    signal: {
      interval: "5m",
      direction: "bullish",
      close: 99,
      previousClose: 100,
      supertrend: 95,
      barsSinceBullishBreak: 2,
    },
  }, {
    entryPreset: "supertrend_trend",
    minPriceChangePct: -1,
  }).confirmed,
  true,
  "bullish trend accepts an exact -1% closed-candle move",
);

const fallingBullishEntry = evaluateEntrySupertrend({
  direction: "bullish",
  signal: {
    interval: "5m",
    direction: "bullish",
    close: 98.9,
    previousClose: 100,
    supertrend: 95,
    barsSinceBullishBreak: 2,
  },
}, {
  entryPreset: "supertrend_trend",
  minPriceChangePct: -1,
});
assert.equal(
  fallingBullishEntry.confirmed,
  false,
  "bullish trend rejects a closed-candle move below -1%",
);
assert.match(fallingBullishEntry.reason, /-1\.10% < minimum -1%/);

assert.equal(
  evaluateBullishEntry(confirmSupertrendFromCandles(bullishContinuation, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  }), { ath: 128, athFilterPct: -20 }).confirmed,
  false,
  "second candle above 80% ATH is rejected",
);

assert.equal(
  evaluateBullishEntry({
    direction: "bearish",
    signal: {
      interval: "5m",
      direction: "bearish",
      close: 90,
      supertrend: 95,
      barsSinceBullishBreak: null,
    },
  }, { ath: 200, athFilterPct: -20 }).confirmed,
  false,
  "bearish candle after a break is rejected",
);

assert.equal(
  evaluateBullishEntry({
    direction: "bullish",
    signal: {
      interval: "5m",
      direction: "bullish",
      close: 90,
      supertrend: 95,
      barsSinceBullishBreak: 1,
    },
  }, { ath: 200, athFilterPct: -20 }).confirmed,
  false,
  "second candle below Supertrend is rejected",
);

assert.match(
  evaluateBullishEntry(confirmSupertrendFromCandles(bullishContinuation, {
    interval: "5m",
    period: 3,
    multiplier: 1,
  }), { ath: null, athFilterPct: -20 }).reason,
  /ATH data unavailable/,
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

const originalFetch = globalThis.fetch;
process.env.GMGN_API_KEY = "test-key";
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    data: {
      list: [
        ...Array.from({ length: 97 }, (_, index) => ({
          time: 1_700_000_000 + index * 300,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1,
        })),
        ...bullishBreak.map((item, index) => ({
          ...item,
          time: 1_700_000_000 + (97 + index) * 300,
        })),
        {
          time: Math.floor(Date.now() / 1000),
          open: 101,
          high: 102,
          low: 79,
          close: 80,
          volume: 10,
        },
      ],
    },
  }),
});
const activeBearishEntry = await confirmEntrySupertrendBreak({
  mint: "test-mint",
  interval: "5m",
  period: 3,
  multiplier: 1,
});
globalThis.fetch = originalFetch;
assert.equal(
  activeBearishEntry.confirmed,
  true,
  "active bearish candle is ignored until it closes",
);

console.log("Supertrend tests passed");
