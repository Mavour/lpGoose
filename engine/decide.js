/**
 * Lifecycle strategy FSM decide() — pure, no I/O.
 */
import {
  activeBinInRange,
  drift,
  isOutOfRangeDirectional,
} from "./binMath.js";
import { evaluateRisk, riskSuppressed } from "./risk.js";

export const PositionStatus = {
  IDLE: "IDLE",
  BIDASK_OPEN: "BIDASK_OPEN",
  CURVE_ACTIVE: "CURVE_ACTIVE",
  RESHAPE_PENDING_READD: "RESHAPE_PENDING_READD",
  REOPENING: "REOPENING",
};

/**
 * @param {object} input
 * @param {object} cfg lifecycle config (risk, flip, reshape, rebalance)
 * @returns {{ action: string, reason: string }}
 */
export function decide(input, cfg) {
  const {
    status,
    nowMs = Date.now(),
    activeBinId = null,
    pnlPct = null,
    pnlPctLoss = null,
    tokenShare = null,
    lowerBin = null,
    upperBin = null,
    lastReshapeBin = null,
    lastReshapeTs = 0,
    lastRebalanceTs = 0,
    lastLiquidityOpTs = 0,
    entryTs = 0,
    regime = null,
  } = input;

  // 1. Risk first
  if (status !== PositionStatus.IDLE) {
    const suppressed = riskSuppressed({
      status,
      entryTs,
      lastLiquidityOpTs,
      nowMs,
      suppressMsAfterEntry: cfg.risk?.suppressMsAfterEntry ?? 12_000,
      suppressMsAfterLiquidityOp: cfg.risk?.suppressMsAfterLiquidityOp ?? 12_000,
    });
    if (!suppressed) {
      const risk = evaluateRisk(pnlPct, pnlPctLoss ?? pnlPct, cfg.risk || {});
      if (risk !== "ok") {
        return { action: "exit", reason: `risk:${risk}` };
      }
    }
  }

  // 2. Out-of-range → rebalance (not hard-close)
  if (
    status === PositionStatus.CURVE_ACTIVE ||
    status === PositionStatus.BIDASK_OPEN ||
    status === PositionStatus.RESHAPE_PENDING_READD
  ) {
    // Bid-ask sits entirely below active by design — only lower-side OOR rebalances.
    const side =
      status === PositionStatus.BIDASK_OPEN
        ? "lower"
        : (cfg.rebalance?.trigger || "both");
    const buf = cfg.rebalance?.oorBufferBins ?? 0;
    const oor =
      activeBinId != null &&
      lowerBin != null &&
      upperBin != null &&
      isOutOfRangeDirectional(activeBinId, lowerBin, upperBin, buf, side);
    const cooledDown =
      nowMs - (lastRebalanceTs || 0) >= (cfg.rebalance?.cooldownMs ?? 15_000);
    if (oor && cooledDown) {
      return { action: "rebalance", reason: `out_of_range:${side}` };
    }
  }

  // 2b. Bid-ask pump follow — active moved up, reopen below
  if (status === PositionStatus.BIDASK_OPEN && activeBinId != null) {
    const triggerSide = cfg.rebalance?.trigger || "both";
    if (triggerSide === "upper" || triggerSide === "both") {
      const refBin = lastReshapeBin ?? activeBinId;
      const upwardDrift = activeBinId - refBin;
      const cooledDown =
        nowMs - (lastRebalanceTs || 0) >= (cfg.rebalance?.cooldownMs ?? 15_000);
      const intervalOk =
        nowMs - (lastReshapeTs || 0) >= (cfg.reshape?.minReshapeIntervalMs ?? 10_000);
      if (
        upwardDrift >= (cfg.reshape?.binTrigger ?? 3) &&
        cooledDown &&
        intervalOk
      ) {
        return { action: "rebalance", reason: `bidask_pump_drift:${upwardDrift}` };
      }
    }
  }

  // 3. Flip bid-ask → curve when roughly balanced
  if (status === PositionStatus.BIDASK_OPEN) {
    const ratio = tokenShare;
    const low = cfg.flip?.ratioLow ?? 0.4;
    const high = cfg.flip?.ratioHigh ?? 0.6;
    if (ratio != null && ratio >= low && ratio <= high) {
      return { action: "flip", reason: `flip_ratio:${Number(ratio).toFixed(3)}` };
    }
  }

  // 4. Reshape curve when active bin drifts inside range
  if (status === PositionStatus.CURVE_ACTIVE && activeBinId != null) {
    const inRange =
      lowerBin != null &&
      upperBin != null &&
      activeBinInRange(activeBinId, lowerBin, upperBin);
    const lastBin = lastReshapeBin ?? activeBinId;
    const binDrift = drift(activeBinId, lastBin);
    if (
      inRange &&
      binDrift >= (cfg.reshape?.binTrigger ?? 3) &&
      nowMs - (lastReshapeTs || 0) >= (cfg.reshape?.minReshapeIntervalMs ?? 10_000)
    ) {
      return { action: "reshape", reason: `bin_drift:${binDrift}` };
    }
  }

  if (status === PositionStatus.RESHAPE_PENDING_READD) {
    const inRange =
      activeBinId != null &&
      lowerBin != null &&
      upperBin != null &&
      activeBinInRange(activeBinId, lowerBin, upperBin);
    if (inRange) {
      return { action: "reshape", reason: "pending_readd" };
    }
  }

  if (status === PositionStatus.REOPENING) {
    return { action: "rebalance", reason: "resume_reopen" };
  }

  if (status === PositionStatus.IDLE) {
    if (!regime) return { action: "none", reason: "awaiting_regime" };
    if (regime === "pump" || regime === "downtrend") {
      return { action: "openBidask", reason: `entry:${regime}` };
    }
    return { action: "openCurve", reason: `entry:${regime}` };
  }

  return { action: "none", reason: "steady" };
}
