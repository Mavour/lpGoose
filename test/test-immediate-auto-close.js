import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PositionCloseCoordinator } from "../position-close-coordinator.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-auto-exit-"));
const originalCwd = process.cwd();

const config = {
  stopLossPct: -5,
  takeProfitFeePct: 10,
  trailingTakeProfit: true,
  trailingTriggerPct: 2,
  trailingDropPct: 0.15,
  outOfRangeBinsToClose: 5,
  outOfRangeWaitMinutes: 8,
  downsideOutOfRangeWaitMinutes: 3,
  downsideOutOfRangeLossPct: -5,
  minFeePerTvl24h: 1,
  minAgeBeforeYieldCheck: 60,
};

const position = (id, overrides = {}) => ({
  position: id,
  pool: `pool-${id}`,
  pair: `${id}-SOL`,
  pnl_pct: 0,
  in_range: true,
  active_bin: 100,
  lower_bin: 90,
  upper_bin: 110,
  fee_per_tvl_24h: 2,
  age_minutes: 30,
  total_value_usd: 10,
  ...overrides,
});

try {
  process.chdir(tempDir);
  const stateModuleUrl = pathToFileURL(path.join(repoRoot, "state.js")).href;
  const { updatePnlAndCheckExits } = await import(stateModuleUrl);

  assert.equal(
    updatePnlAndCheckExits("stop", position("stop", { pnl_pct: -6 }), config)?.action,
    "STOP_LOSS",
  );
  assert.equal(
    updatePnlAndCheckExits("take", position("take", { pnl_pct: 11 }), config)?.action,
    "TAKE_PROFIT",
  );

  assert.equal(updatePnlAndCheckExits("trail", position("trail", { pnl_pct: 3 }), config), null);
  assert.equal(
    updatePnlAndCheckExits("trail", position("trail", { pnl_pct: 2.8 }), config)?.action,
    "TRAILING_TP",
  );

  assert.equal(
    updatePnlAndCheckExits("pumped", position("pumped", {
      active_bin: 116,
      upper_bin: 110,
    }), config)?.action,
    "PUMPED_ABOVE_RANGE",
  );
  assert.equal(
    updatePnlAndCheckExits("yield", position("yield", {
      fee_per_tvl_24h: 0.5,
      age_minutes: 60,
    }), config)?.action,
    "LOW_YIELD",
  );
  assert.equal(updatePnlAndCheckExits("stay", position("stay"), config), null);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const coordinator = new PositionCloseCoordinator();
let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
let samePositionCalls = 0;
const first = coordinator.run("same", async () => {
  samePositionCalls++;
  await firstGate;
  return "closed";
});
const duplicate = await coordinator.run("same", async () => {
  samePositionCalls++;
  return "duplicate";
});
assert.equal(duplicate.acquired, false);
releaseFirst();
assert.equal((await first).result, "closed");
assert.equal(samePositionCalls, 1);

let concurrent = 0;
let maxConcurrent = 0;
await Promise.all([
  coordinator.run("one", async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent--;
  }),
  coordinator.run("two", async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent--;
  }),
]);
assert.equal(maxConcurrent, 2);

const indexSource = fs.readFileSync(path.join(repoRoot, "index.js"), "utf8");
assert.match(indexSource, /closeTasks\.push\(executeAutoClose\(p, exit, "poller"\)\)/);
assert.doesNotMatch(indexSource, /Poll-triggered management/);
assert.doesNotMatch(indexSource, /_pollTriggeredAt/);

console.log("Immediate auto-close tests passed");
