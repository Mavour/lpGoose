/**
 * Lifecycle engine unit tests (no network).
 */
import assert from "assert";
import { decide, PositionStatus } from "../engine/decide.js";
import { evaluateRisk, riskSuppressed } from "../engine/risk.js";
import { classify, strategyForRegime } from "../engine/trend.js";
import {
  totalBinsForVolatility,
  curveHalfWidthForVolatility,
  isOutOfRangeDirectional,
  bidRange,
  centeredRange,
} from "../engine/binMath.js";

const cfg = {
  risk: {
    takeProfitPct: 30,
    stopLossPct: -15,
    maxLossPct: -25,
    suppressMsAfterEntry: 12_000,
    suppressMsAfterLiquidityOp: 12_000,
  },
  flip: { ratioLow: 0.4, ratioHigh: 0.6 },
  reshape: { binTrigger: 3, minReshapeIntervalMs: 10_000 },
  rebalance: { oorBufferBins: 0, cooldownMs: 15_000, trigger: "both" },
};

// ── risk ──
assert.strictEqual(evaluateRisk(5, 5, cfg.risk), "ok");
assert.strictEqual(evaluateRisk(31, 31, cfg.risk), "tp");
assert.strictEqual(evaluateRisk(-16, -16, cfg.risk), "sl");
assert.strictEqual(evaluateRisk(-26, -26, cfg.risk), "maxloss");
assert.ok(
  riskSuppressed({
    status: PositionStatus.CURVE_ACTIVE,
    entryTs: Date.now() - 1000,
    nowMs: Date.now(),
    suppressMsAfterEntry: 12_000,
  }),
);

// ── trend ──
const pumpCandles = Array.from({ length: 20 }, (_, i) => ({
  c: 1 + i * 0.1,
  h: 1.1 + i * 0.1,
  l: 0.9 + i * 0.1,
  o: 1 + i * 0.1,
}));
assert.strictEqual(classify(pumpCandles, { lookbackCandles: 20, pumpPctThreshold: 50 }), "pump");
assert.strictEqual(strategyForRegime("pump"), "bid_ask");
assert.strictEqual(strategyForRegime("sideways"), "curve");
assert.strictEqual(strategyForRegime("bottom"), "curve");

// ── bin math ──
const total = totalBinsForVolatility(4, 35, 60, 8);
assert.ok(total >= 35 && total <= 60);
assert.ok(curveHalfWidthForVolatility(4, 35, 60, 8) >= 1);
assert.deepStrictEqual(bidRange(100, 20), { minBinId: 80, maxBinId: 99 });
assert.deepStrictEqual(centeredRange(100, 10), { minBinId: 90, maxBinId: 110 });
assert.ok(isOutOfRangeDirectional(120, 90, 110, 0, "upper"));
assert.ok(!isOutOfRangeDirectional(100, 90, 110, 0, "both"));

// ── decide: risk exit ──
{
  const d = decide(
    {
      status: PositionStatus.CURVE_ACTIVE,
      nowMs: Date.now(),
      entryTs: Date.now() - 60_000,
      lastLiquidityOpTs: Date.now() - 60_000,
      pnlPct: -16,
      pnlPctLoss: -16,
      activeBinId: 100,
      lowerBin: 90,
      upperBin: 110,
    },
    cfg,
  );
  assert.strictEqual(d.action, "exit");
  assert.ok(d.reason.startsWith("risk:"));
}

// ── decide: OOR rebalance for curve ──
{
  const d = decide(
    {
      status: PositionStatus.CURVE_ACTIVE,
      nowMs: Date.now(),
      entryTs: Date.now() - 60_000,
      lastLiquidityOpTs: Date.now() - 60_000,
      lastRebalanceTs: Date.now() - 60_000,
      pnlPct: 1,
      activeBinId: 130,
      lowerBin: 90,
      upperBin: 110,
    },
    cfg,
  );
  assert.strictEqual(d.action, "rebalance");
}

// ── decide: bid-ask upper OOR is NOT rebalance (by design) ──
{
  const d = decide(
    {
      status: PositionStatus.BIDASK_OPEN,
      nowMs: Date.now(),
      entryTs: Date.now() - 60_000,
      lastLiquidityOpTs: Date.now() - 60_000,
      lastRebalanceTs: Date.now() - 60_000,
      lastReshapeTs: Date.now() - 60_000,
      lastReshapeBin: 100,
      pnlPct: 1,
      activeBinId: 100, // still above bid range which ends at 99
      lowerBin: 80,
      upperBin: 99,
      tokenShare: 0.2,
    },
    cfg,
  );
  // active=100 is above upper=99 but side is "lower" only for bidask OOR
  assert.notStrictEqual(d.action, "exit");
}

// ── decide: flip ──
{
  const d = decide(
    {
      status: PositionStatus.BIDASK_OPEN,
      nowMs: Date.now(),
      entryTs: Date.now() - 60_000,
      lastLiquidityOpTs: Date.now() - 60_000,
      lastRebalanceTs: Date.now(),
      pnlPct: 2,
      activeBinId: 100,
      lowerBin: 80,
      upperBin: 99,
      tokenShare: 0.5,
    },
    cfg,
  );
  assert.strictEqual(d.action, "flip");
}

// ── decide: reshape ──
{
  const d = decide(
    {
      status: PositionStatus.CURVE_ACTIVE,
      nowMs: Date.now(),
      entryTs: Date.now() - 60_000,
      lastLiquidityOpTs: Date.now() - 60_000,
      lastReshapeTs: Date.now() - 60_000,
      lastReshapeBin: 95,
      pnlPct: 1,
      activeBinId: 100,
      lowerBin: 90,
      upperBin: 110,
    },
    cfg,
  );
  assert.strictEqual(d.action, "reshape");
}

// ── decide: idle entry ──
{
  const d = decide({ status: PositionStatus.IDLE, regime: "pump" }, cfg);
  assert.strictEqual(d.action, "openBidask");
  const d2 = decide({ status: PositionStatus.IDLE, regime: "sideways" }, cfg);
  assert.strictEqual(d2.action, "openCurve");
}

console.log("test-lifecycle: all passed");
