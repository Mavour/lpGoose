import assert from "node:assert/strict";
import fs from "node:fs";
import {
  calculateMeteoraPositionPnl,
  calculatePnl,
} from "../pnl-fetcher.js";
import { updatePnlAndCheckExits } from "../state.js";

const statePath = "./state.json";
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;

try {
  assert.deepEqual(calculatePnl({
    balance: 110,
    withdrawals: 5,
    claimableFees: 6,
    claimedFees: 4,
    deposits: 100,
  }), {
    balance: 110,
    withdrawals: 5,
    claimableFees: 6,
    claimedFees: 4,
    deposits: 100,
    pnl: 25,
    pnlPct: 25,
  });

  const apiPosition = {
    unrealizedPnl: {
      balances: "110",
      balancesSol: "1.1",
      unclaimedFeeTokenX: { usd: "2", amountSol: "0.02" },
      unclaimedFeeTokenY: { usd: "3", amountSol: "0.03" },
      unclaimedRewardTokenX: { usd: "1", amountSol: "0.01" },
    },
    allTimeWithdrawals: { total: { usd: "5", sol: "0.05" } },
    allTimeFees: { total: { usd: "4", sol: "0.04" } },
    allTimeDeposits: { total: { usd: "100", sol: "1" } },
  };
  assert.equal(calculateMeteoraPositionPnl(apiPosition, "usd").pnl, 25);
  assert.ok(Math.abs(calculateMeteoraPositionPnl(apiPosition, "sol").pnl - 0.25) < 1e-12);

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
