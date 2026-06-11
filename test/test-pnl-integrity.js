import assert from "node:assert/strict";
import fs from "node:fs";
import { selectTrustedPnlPct } from "../pnl-fetcher.js";
import { updatePnlAndCheckExits } from "../state.js";

const statePath = "./state.json";
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;

try {
  assert.deepEqual(
    selectTrustedPnlPct(11.1111, 0.15),
    { value: 0.15, source: "meteora", rejected: true, differencePct: 10.9611 }
  );
  assert.deepEqual(
    selectTrustedPnlPct(1.2, 0.9),
    { value: 1.2, source: "lpagent", rejected: false, differencePct: 0.29999999999999993 }
  );
  assert.deepEqual(
    selectTrustedPnlPct(null, -0.4),
    { value: -0.4, source: "meteora", rejected: false }
  );

  fs.writeFileSync(statePath, JSON.stringify({
    positions: {
      test_position: {
        position: "test_position",
        peak_pnl_pct: 11.19,
        trailing_active: true,
        closed: false,
        amount_sol: 0.15,
      },
    },
    recentEvents: [],
  }));

  const exit = updatePnlAndCheckExits(
    "test_position",
    {
      pnl_pct: 0.2,
      pnl_integrity_reset: true,
      in_range: true,
      fee_per_tvl_24h: 10,
      total_value_usd: 0.15,
    },
    {
      trailingTakeProfit: true,
      trailingTriggerPct: 3,
      trailingDropPct: 1,
      stopLossPct: -5,
      takeProfitFeePct: null,
      outOfRangeBinsToClose: null,
      maxOutOfRangeMinutes: null,
      minFeeAprToKeep: null,
    }
  );

  assert.equal(exit, null);
  const repaired = JSON.parse(fs.readFileSync(statePath, "utf8")).positions.test_position;
  assert.equal(repaired.peak_pnl_pct, 0.2);
  assert.equal(repaired.trailing_active, false);

  console.log("PnL integrity tests passed");
} finally {
  if (originalState == null) {
    fs.rmSync(statePath, { force: true });
  } else {
    fs.writeFileSync(statePath, originalState);
  }
}
