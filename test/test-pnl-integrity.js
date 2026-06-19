import assert from "node:assert/strict";
import fs from "node:fs";
import {
  calculateMeteoraPositionPnl,
  calculatePnl,
} from "../pnl-fetcher.js";
import {
  calculateMixedAllocation,
  evaluatePnlDepositTrust,
} from "../tools/dlmm.js";
import { updatePnlAndCheckExits } from "../state.js";

const statePath = "./state.json";
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;

try {
  const dlmmSource = fs.readFileSync("./tools/dlmm.js", "utf8");
  const closeSource = dlmmSource.slice(
    dlmmSource.indexOf("export async function closePosition"),
    dlmmSource.indexOf("export async function withdrawLiquidity"),
  );
  assert.doesNotMatch(
    closeSource,
    /getMyPositions\(\{\s*force:\s*true,\s*silent:\s*true,\s*liveOnly:\s*true/,
    "close must not fetch a fresh RPC PnL snapshot before sending transactions",
  );
  assert.match(
    dlmmSource,
    /pnlSignatureCheckIntervalMs \?\? 60_000/,
    "position signature RPC checks must be throttled",
  );
  assert.match(
    dlmmSource,
    /function calculatePnlWithDepositFallback/,
    "PnL display must fall back to tracked deposit when Meteora has not indexed deposits",
  );
  assert.match(dlmmSource, /tracked\?\.expected_deposit_sol/);
  assert.match(dlmmSource, /fallbackDeposits: expectedSol/);

  const indexSource = fs.readFileSync("./index.js", "utf8");
  const pollerSource = indexSource.slice(
    indexSource.indexOf("const pnlPollInterval"),
    indexSource.indexOf("const pnlSlowCheckInterval"),
  );
  assert.match(pollerSource, /liveOnly:\s*true/);
  assert.doesNotMatch(pollerSource, /apiOnly:\s*true/);
  assert.match(pollerSource, /pnlPollIntervalMs/);

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

  for (const ratio of [
    { bidask: 90, spot: 10 },
    { bidask: 80, spot: 20 },
    { bidask: 70, spot: 30 },
  ]) {
    const allocation = calculateMixedAllocation(0.2, ratio);
    assert.ok(Math.abs(allocation.bidask - 0.2 * ratio.bidask / 100) < 1e-12);
    assert.ok(Math.abs(allocation.spot - 0.2 * ratio.spot / 100) < 1e-12);
    assert.ok(Math.abs(allocation.bidask + allocation.spot - 0.2) < 1e-12);
  }

  assert.equal(evaluatePnlDepositTrust({
    actualDepositSol: 0.16,
    expectedDepositSol: 0.2,
  }).trusted, false);
  assert.equal(evaluatePnlDepositTrust({
    actualDepositSol: 0.198,
    expectedDepositSol: 0.2,
  }).trusted, true);
  assert.equal(evaluatePnlDepositTrust({
    actualDepositSol: 0.18,
    expectedDepositSol: 0.18,
  }).trusted, true);
  assert.equal(evaluatePnlDepositTrust({
    actualDepositSol: 0.2,
    expectedDepositSol: 0.2,
    deploying: true,
  }).trusted, false);

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

  fs.writeFileSync(statePath, JSON.stringify({
    positions: {
      partial_mixed: {
        position: "partial_mixed",
        peak_pnl_pct: 0,
        trailing_active: false,
        closed: false,
        amount_sol: 0.2,
      },
    },
    recentEvents: [],
  }));
  const pendingExit = updatePnlAndCheckExits(
    "partial_mixed",
    {
      pnl_pct: 25,
      pnl_trusted: false,
      pnl_pending_reason: "indexed deposit 0.16 SOL below expected 0.2 SOL",
      in_range: true,
      fee_per_tvl_24h: 0,
    },
    {
      trailingTakeProfit: true,
      trailingTriggerPct: 2,
      trailingDropPct: 0.15,
      stopLossPct: -5,
      takeProfitFeePct: 15,
    }
  );
  assert.equal(pendingExit, null);
  const pendingState = JSON.parse(fs.readFileSync(statePath, "utf8")).positions.partial_mixed;
  assert.equal(pendingState.peak_pnl_pct, 0);
  assert.equal(pendingState.trailing_active, false);

  console.log("PnL integrity tests passed");
} finally {
  if (originalState == null) {
    fs.rmSync(statePath, { force: true });
  } else {
    fs.writeFileSync(statePath, originalState);
  }
}

process.exit(0);
