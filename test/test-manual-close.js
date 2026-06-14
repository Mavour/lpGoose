import assert from "node:assert/strict";
import fs from "fs";
import { buildManualClosePerformance } from "../manual-close.js";
import {
  getTrackedPosition,
  syncOpenPositions,
  trackPosition,
  updatePositionSnapshots,
} from "../state.js";

const stateFile = "./state.json";
const backup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
const position = "ManualCloseTestPosition";

try {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

  trackPosition({
    position,
    pool: "ManualCloseTestPool",
    pool_name: "TEST-SOL",
    strategy: "mixed",
    bin_range: { min: 1, max: 10 },
    amount_sol: 1,
    bin_step: 100,
    volatility: 3,
    fee_tvl_ratio: 0.5,
    organic_score: 75,
    initial_value_usd: 100,
  });

  updatePositionSnapshots([{
    position,
    base_mint: "ManualCloseMint",
    pnl_pct: -4,
    pnl_sol: -0.04,
    pnl_true_usd: -4,
    collected_fees_true_usd: 1,
    unclaimed_fees_true_usd: 0.5,
    fees_earned_sol: 0.015,
    total_value_true_usd: 94.5,
    pnl_source: "rpc",
    in_range: true,
    age_minutes: 60,
  }]);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.positions[position].deployed_at = new Date(Date.now() - 60 * 60_000).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const ignored = syncOpenPositions([], { ignore_addresses: [position] });
  assert.equal(ignored.length, 0);
  assert.equal(getTrackedPosition(position).closed, false);

  const detected = syncOpenPositions([]);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].close_source, "external");
  assert.equal(getTrackedPosition(position).closed, true);

  const performance = buildManualClosePerformance(detected[0], null);
  assert.equal(performance.position, position);
  assert.equal(performance.close_reason, "External/manual close detected");
  assert.equal(performance.pnl_source, "rpc");
  assert.equal(performance.pnl_sol, -0.04);
  assert.equal(performance.fees_earned_usd, 1.5);
  assert.equal(performance.final_value_usd, 94.5);

  const authoritative = buildManualClosePerformance(detected[0], {
    pnl_sol: 0.1,
    pnl_pct: 10,
    pnl_usd: 10,
    fees_earned_sol: 0.02,
    fees_earned_usd: 2,
    final_value_usd: 108,
    initial_value_usd: 100,
    pnl_source: "meteora_closed_api",
  });
  assert.equal(authoritative.pnl_source, "meteora_closed_api");
  assert.equal(authoritative.pnl_sol, 0.1);
  assert.equal(authoritative.final_value_usd, 108);

  assert.equal(buildManualClosePerformance({
    position: "NoPnlPosition",
    pool: "NoPnlPool",
    amount_sol: 1,
    deployed_at: new Date(Date.now() - 60_000).toISOString(),
  }), null);

  console.log("Manual close reconciliation tests passed");
} finally {
  if (backup == null) {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  } else {
    fs.writeFileSync(stateFile, backup);
  }
}
