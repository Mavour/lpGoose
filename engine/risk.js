/**
 * Cumulative PnL risk evaluation (fee-maxi style).
 */

export function riskSuppressed({
  status,
  entryTs = 0,
  lastLiquidityOpTs = 0,
  nowMs = Date.now(),
  suppressMsAfterEntry = 12_000,
  suppressMsAfterLiquidityOp = 12_000,
}) {
  if (status === "RESHAPE_PENDING_READD" || status === "REOPENING") return true;
  if (entryTs > 0 && nowMs - entryTs < suppressMsAfterEntry) return true;
  if (lastLiquidityOpTs > 0 && nowMs - lastLiquidityOpTs < suppressMsAfterLiquidityOp) return true;
  return false;
}

/**
 * @returns {"tp"|"sl"|"maxloss"|"ok"}
 */
export function evaluateRisk(pnlPctTp, pnlPctLoss, cfg) {
  const maxLoss = Number(cfg.maxLossPct);
  const stopLoss = Number(cfg.stopLossPct);
  const takeProfit = Number(cfg.takeProfitPct);

  if (pnlPctLoss != null && Number.isFinite(maxLoss) && pnlPctLoss <= maxLoss) return "maxloss";
  if (pnlPctTp != null && Number.isFinite(takeProfit) && pnlPctTp >= takeProfit) return "tp";
  if (pnlPctLoss != null && Number.isFinite(stopLoss) && pnlPctLoss <= stopLoss) return "sl";
  return "ok";
}

export function evaluate(pnlPct, cfg) {
  return evaluateRisk(pnlPct, pnlPct, cfg);
}
