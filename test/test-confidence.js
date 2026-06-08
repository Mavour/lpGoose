import assert from "node:assert/strict";
import {
  calculateConfidence,
  getConfidenceSizing,
  getMinimumConfidenceDeployAmount,
  selectBestConfidenceCandidate,
  scoreFeeActiveTvl,
  scoreSmartWallets,
  scoreVolatility,
} from "../confidence.js";

assert.equal(scoreVolatility(2.4), 40);
assert.equal(scoreVolatility(4.5), 36);
assert.equal(scoreVolatility(3.5), 28);
assert.equal(scoreVolatility(5.5), 15);
assert.equal(scoreVolatility(7), 5);
assert.equal(scoreVolatility(9), 10);

assert.equal(scoreFeeActiveTvl(0.19), 0);
assert.equal(scoreFeeActiveTvl(0.2), 15);
assert.equal(scoreFeeActiveTvl(0.3), 24);
assert.equal(scoreFeeActiveTvl(0.5), 32);
assert.equal(scoreFeeActiveTvl(0.8), 36);
assert.equal(scoreFeeActiveTvl(1), 40);

const wallets = {
  in_pool: [
    { address: "recent", age_minutes: 30 },
    { address: "boundary", age_minutes: 60 },
    { address: "stale", age_minutes: 61 },
  ],
};
assert.equal(scoreSmartWallets(wallets, 60).score, 20);
assert.equal(scoreSmartWallets({ in_pool: [wallets.in_pool[2]] }, 60).score, 0);

const confidence = calculateConfidence(
  { volatility: 2.4, fee_active_tvl_ratio: 0.5 },
  { in_pool: [{ address: "recent", age_minutes: 20 }] },
  { smartWalletMaxAgeMinutes: 60 }
);
assert.deepEqual(
  {
    total: confidence.total,
    volatility: confidence.volatility_score,
    fee: confidence.fee_active_tvl_score,
    smart: confidence.smart_wallet_score,
  },
  { total: 87, volatility: 40, fee: 32, smart: 15 }
);

assert.deepEqual(
  getConfidenceSizing(70, 0.1, { fullThreshold: 70, skipThreshold: 40, halfMultiplier: 0.5 }),
  { action: "full", multiplier: 1, amount: 0.1 }
);
assert.deepEqual(
  getConfidenceSizing(69, 0.1, { fullThreshold: 70, skipThreshold: 40, halfMultiplier: 0.5 }),
  { action: "half", multiplier: 0.5, amount: 0.05 }
);
assert.deepEqual(
  getConfidenceSizing(39, 0.1, { fullThreshold: 70, skipThreshold: 40, halfMultiplier: 0.5 }),
  { action: "skip", multiplier: 0, amount: 0 }
);
assert.equal(
  getMinimumConfidenceDeployAmount(0.1, { enabled: true, halfMultiplier: 0.5 }),
  0.05
);

const selected = selectBestConfidenceCandidate([
  {
    pool: { name: "HIGH-FEE", volatility: 7, fee_active_tvl_ratio: 1.2 },
    sw: { in_pool: [] },
  },
  {
    pool: { name: "BALANCED", volatility: 2.4, fee_active_tvl_ratio: 0.5 },
    sw: { in_pool: [{ age_minutes: 30 }] },
  },
], { enabled: true, smartWalletMaxAgeMinutes: 60 });
assert.equal(selected.pool.name, "BALANCED");
assert.equal(selected.confidence.total, 87);

const selectedWithoutConfidence = selectBestConfidenceCandidate([
  { pool: { name: "LOW-FEE", volatility: 2.4, fee_active_tvl_ratio: 0.5 }, sw: null },
  { pool: { name: "HIGH-FEE", volatility: 7, fee_active_tvl_ratio: 1.2 }, sw: null },
], { enabled: false });
assert.equal(selectedWithoutConfidence.pool.name, "HIGH-FEE");

console.log("Confidence scoring tests passed");
