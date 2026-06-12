import assert from "node:assert/strict";
import {
  deployPosition,
  evaluatePositionCostQuote,
} from "../tools/dlmm.js";
import { runRankedCandidateAttempts } from "../confidence.js";

const refundableOnly = evaluatePositionCostQuote({
  positionCost: 0.06,
  positionReallocCost: 0.06,
  binArraysCount: 0,
  binArrayCost: 0,
  bitmapExtensionCost: 0,
  transactionCount: 3,
});
assert.equal(refundableOnly.blocked, false);
assert.equal(refundableOnly.position_rent_sol, 0.06);
assert.equal(refundableOnly.position_extension_rent_sol, 0.06);

const newBinArray = evaluatePositionCostQuote({
  binArraysCount: 1,
  binArrayCost: 0.07143744,
  bitmapExtensionCost: 0,
});
assert.equal(newBinArray.blocked, true);
assert.equal(newBinArray.avoided_cost_sol, 0.07143744);

const bitmapExtension = evaluatePositionCostQuote({
  binArraysCount: 0,
  binArrayCost: 0,
  bitmapExtensionCost: 0.01150224,
});
assert.equal(bitmapExtension.blocked, true);

const attemptOrder = [];
const rankedAttempts = await runRankedCandidateAttempts([
  { pool: { name: "FIRST", pool: "FirstPool" } },
  { pool: { name: "SECOND", pool: "SecondPool" } },
], async (candidate) => {
  attemptOrder.push(candidate.pool.name);
  if (candidate.pool.name === "FIRST") {
    return {
      status: "non_refundable_bin_cost",
      deployResult: { avoided_cost_sol: 0.07143744 },
    };
  }
  return { status: "success", candidate };
});
assert.deepEqual(attemptOrder, ["FIRST", "SECOND"]);
assert.equal(rankedAttempts.selectedAttempt.candidate.pool.name, "SECOND");
assert.equal(rankedAttempts.infrastructureSkips.length, 1);
assert.equal(rankedAttempts.infrastructureSkips[0].avoided_cost_sol, 0.07143744);

const originalDryRun = process.env.DRY_RUN;
process.env.DRY_RUN = "false";

let walletLoads = 0;
let generatedPositions = 0;
let sentTransactions = 0;
let createCalls = 0;

const result = await deployPosition({
  pool_address: "11111111111111111111111111111111",
  pool_name: "TEST-SOL",
  amount_sol: 0.5,
  strategy: "spot",
  bins_below: 150,
  bins_above: 0,
}, {
  manualRange: true,
  dependencies: {
    getDLMM: async () => ({
      StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
    }),
    getPool: async () => ({
      getActiveBin: async () => ({ binId: 1000, price: "1" }),
      quoteCreatePosition: async () => ({
        positionCount: 1,
        positionCost: 0.06,
        positionReallocCost: 0.06,
        bitmapExtensionCost: 0,
        binArraysCount: 1,
        binArrayCost: 0.07143744,
        transactionCount: 3,
      }),
      createExtendedEmptyPosition: async () => {
        createCalls += 1;
        throw new Error("must not create a position after cost block");
      },
    }),
    getWallet: () => {
      walletLoads += 1;
      throw new Error("must not load wallet after cost block");
    },
    generatePosition: () => {
      generatedPositions += 1;
      throw new Error("must not generate position after cost block");
    },
    sendAndConfirmTransaction: async () => {
      sentTransactions += 1;
      throw new Error("must not send transaction after cost block");
    },
  },
});

assert.equal(result.success, false);
assert.equal(result.blocked, true);
assert.equal(result.code, "non_refundable_bin_cost");
assert.equal(result.avoided_cost_sol, 0.07143744);
assert.equal(walletLoads, 0);
assert.equal(generatedPositions, 0);
assert.equal(sentTransactions, 0);
assert.equal(createCalls, 0);

process.env.DRY_RUN = originalDryRun;

console.log("Bin cost guard tests passed");
process.exit(0);
