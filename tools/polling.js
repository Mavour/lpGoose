export function isRiskSensitivePosition(position = {}, tracked = {}, management = {}) {
  const pnl = Number(position.pnl_pct);
  const peak = Number(tracked?.peak_pnl_pct ?? position.peak_pnl_pct ?? 0);
  const trailingActive = tracked?.trailing_active === true || position.trailing_active === true;
  const trailingTrigger = Number(management.trailingTriggerPct);
  const trailingDrop = Number(management.trailingDropPct);
  const stopLoss = Number(management.stopLossPct);
  const danger = Number(management.dangerDrawdownPct);

  if (position.stale || position.error || position.pnl_trusted === false) return true;
  if (position.in_range === false || Number(position.minutes_out_of_range ?? 0) > 0) return true;
  if (tracked?.danger_drawdown_since) return true;
  if (trailingActive) return true;

  if (Number.isFinite(pnl)) {
    if (Number.isFinite(trailingTrigger) && pnl >= trailingTrigger - 0.5) return true;
    if (Number.isFinite(stopLoss) && pnl <= stopLoss + 1) return true;
    if (Number.isFinite(danger) && pnl <= danger + 1) return true;
    if (trailingActive && Number.isFinite(trailingDrop) && Number.isFinite(peak)) {
      const dropFromPeak = peak - pnl;
      if (dropFromPeak >= trailingDrop - 0.25) return true;
    }
  }

  return false;
}

export function selectAdaptivePnlPollIntervalMs({
  trackedPositions = [],
  result = null,
  schedule = {},
  management = {},
  getTracked = () => null,
} = {}) {
  const fastMs = Math.max(1_000, Number(schedule.pnlPollIntervalMs ?? 3_000));
  const normalMs = Math.max(fastMs, Number(schedule.pnlNormalPollIntervalMs ?? 15_000));
  const noPositionMs = Math.max(normalMs, Number(schedule.pnlNoPositionPollIntervalMs ?? 60_000));

  if (!trackedPositions.length && !result?.positions?.length) return noPositionMs;
  if (!result || result.stale || result.error) return fastMs;

  const positions = Array.isArray(result.positions) ? result.positions : [];
  if (!positions.length) return trackedPositions.length ? fastMs : noPositionMs;

  for (const position of positions) {
    const tracked = getTracked(position.position) || {};
    if (isRiskSensitivePosition(position, tracked, management)) return fastMs;
  }

  return normalMs;
}
