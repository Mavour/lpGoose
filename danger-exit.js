export function buildDangerDrawdownDecision({
  currentPnlPct,
  dangerPct,
  hardClosePct,
  graceExpired,
  elapsed = 0,
  badReasons = [],
  signalNotes = [],
}) {
  if (!Number.isFinite(currentPnlPct) || !Number.isFinite(dangerPct) || currentPnlPct > dangerPct) {
    return null;
  }

  if (Number.isFinite(hardClosePct) && currentPnlPct <= hardClosePct) {
    return {
      action: "DANGER_DRAWDOWN",
      reason: `Danger hard close: PnL ${currentPnlPct.toFixed(2)}% <= ${hardClosePct}%`,
    };
  }

  const noteText = signalNotes.length > 0 ? `; note: ${signalNotes.join("; ")}` : "";
  if (badReasons.length > 0) {
    if (graceExpired) {
      return {
        action: "DANGER_DRAWDOWN",
        reason: `Danger drawdown: PnL ${currentPnlPct.toFixed(2)}% still <= ${dangerPct}% after ${elapsed}m; ${badReasons.join("; ")}${noteText}`,
      };
    }

    return {
      action: "DANGER_HOLD",
      reason: `Danger hold: PnL ${currentPnlPct.toFixed(2)}% <= ${dangerPct}%, grace active ${elapsed}m; ${badReasons.join("; ")}${noteText}`,
    };
  }

  return {
    action: "DANGER_HOLD",
    reason: `Danger hold: PnL ${currentPnlPct.toFixed(2)}% <= ${dangerPct}%, live signal not bad enough to close`,
  };
}
