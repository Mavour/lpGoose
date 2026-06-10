export function buildManualClosePerformance(tracked, closedPnl = null, now = Date.now()) {
  if (!tracked?.position || !tracked?.pool) return null;

  const snapshot = tracked.last_snapshot || {};
  const deployedAt = Date.parse(tracked.deployed_at);
  const minutesHeld = Number.isFinite(deployedAt)
    ? Math.max(0, Math.floor((now - deployedAt) / 60000))
    : Math.max(0, Number(snapshot.age_minutes || 0));

  let minutesOor = 0;
  if (tracked.out_of_range_since) {
    const oorAt = Date.parse(tracked.out_of_range_since);
    if (Number.isFinite(oorAt)) {
      minutesOor = Math.max(0, Math.floor((now - oorAt) / 60000));
    }
  } else if (snapshot.in_range === false) {
    minutesOor = minutesHeld;
  }

  const amountSol = Number(tracked.amount_sol || 0);
  const pnlPct = finiteOrNull(closedPnl?.pnl_pct) ?? finiteOrNull(snapshot.pnl_pct);
  const pnlSol = finiteOrNull(closedPnl?.pnl_sol)
    ?? finiteOrNull(snapshot.pnl_sol)
    ?? (amountSol > 0 && pnlPct != null ? amountSol * (pnlPct / 100) : null);

  if (pnlSol == null && pnlPct == null) return null;

  const initialUsd = finiteOrNull(closedPnl?.initial_value_usd)
    ?? finiteOrNull(tracked.initial_value_usd)
    ?? 0;
  const pnlUsd = finiteOrNull(closedPnl?.pnl_usd)
    ?? finiteOrNull(snapshot.pnl_usd)
    ?? 0;
  const feesUsd = finiteOrNull(closedPnl?.fees_earned_usd)
    ?? finiteOrNull(snapshot.fees_earned_usd)
    ?? Number(tracked.total_fees_claimed_usd || 0);
  const finalValueUsd = finiteOrNull(closedPnl?.final_value_usd)
    ?? finiteOrNull(snapshot.final_value_usd)
    ?? (initialUsd > 0 ? Math.max(0, initialUsd + pnlUsd - feesUsd) : 0);

  return {
    position: tracked.position,
    pool: tracked.pool,
    pool_name: tracked.pool_name || tracked.pool.slice(0, 8),
    base_mint: tracked.base_mint || null,
    strategy: tracked.strategy,
    bin_range: tracked.bin_range,
    bin_step: tracked.bin_step ?? null,
    volatility: tracked.volatility ?? null,
    fee_tvl_ratio: tracked.fee_tvl_ratio ?? null,
    organic_score: tracked.organic_score ?? null,
    amount_sol: amountSol,
    pnl_sol: pnlSol,
    pnl_usd: pnlUsd,
    fees_earned_sol: finiteOrNull(closedPnl?.fees_earned_sol)
      ?? finiteOrNull(snapshot.fees_earned_sol)
      ?? 0,
    fees_earned_usd: feesUsd,
    final_value_usd: finalValueUsd,
    initial_value_usd: initialUsd,
    minutes_in_range: Math.max(0, minutesHeld - Math.min(minutesHeld, minutesOor)),
    minutes_held: minutesHeld,
    close_reason: "External/manual close detected",
    close_source: "external",
    pnl_source: closedPnl ? "meteora_closed_api" : "last_open_snapshot",
  };
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
