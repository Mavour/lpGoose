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
  const dangerExitModuleUrl = pathToFileURL(path.join(repoRoot, "danger-exit.js")).href;
  const { buildDangerDrawdownDecision } = await import(dangerExitModuleUrl);

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
  assert.equal(updatePnlAndCheckExits("danger", position("danger", { pnl_pct: -5.2 }), {
    ...config,
    stopLossPct: -10,
    dangerDrawdownPct: -5,
  }), null);
  const state = JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
  assert.ok(state.positions.danger.danger_drawdown_since);
  assert.equal(state.positions.danger.min_pnl_pct, -5.2);
  assert.equal(updatePnlAndCheckExits("danger", position("danger", { pnl_pct: -4.5 }), {
    ...config,
    stopLossPct: -10,
    dangerDrawdownPct: -5,
  }), null);
  const recoveredState = JSON.parse(fs.readFileSync(path.join(tempDir, "state.json"), "utf8"));
  assert.equal(recoveredState.positions.danger.danger_drawdown_since, null);
  assert.equal(recoveredState.positions.danger.min_pnl_pct, -5.2);

  assert.equal(buildDangerDrawdownDecision({
    currentPnlPct: -5.3,
    dangerPct: -5,
    hardClosePct: -8,
    graceExpired: false,
    elapsed: 0,
    badReasons: ["Supertrend bearish", "momentum 0 < 40"],
  })?.action, "DANGER_HOLD");
  assert.equal(buildDangerDrawdownDecision({
    currentPnlPct: -8.1,
    dangerPct: -5,
    hardClosePct: -8,
    graceExpired: false,
    badReasons: ["Supertrend bearish"],
  })?.action, "DANGER_DRAWDOWN");
  assert.equal(buildDangerDrawdownDecision({
    currentPnlPct: -5.3,
    dangerPct: -5,
    hardClosePct: -8,
    graceExpired: true,
    elapsed: 10,
    badReasons: ["Supertrend bearish", "momentum 0 < 40"],
  })?.action, "DANGER_DRAWDOWN");
  assert.equal(buildDangerDrawdownDecision({
    currentPnlPct: -5.3,
    dangerPct: -5,
    hardClosePct: -8,
    graceExpired: true,
    elapsed: 10,
    badReasons: [],
  })?.action, "DANGER_HOLD");
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
const configSource = fs.readFileSync(path.join(repoRoot, "config.js"), "utf8");
const dlmmSource = fs.readFileSync(path.join(repoRoot, "tools", "dlmm.js"), "utf8");
const dangerExitSource = fs.readFileSync(path.join(repoRoot, "danger-exit.js"), "utf8");
assert.match(indexSource, /closeTasks\.push\(executeAutoClose\(p, exit, "poller"\)\)/);
assert.match(indexSource, /liveOnly:\s*true/);
assert.match(indexSource, /pnlPollIntervalMs/);
assert.match(indexSource, /pnlSlowCheckIntervalMs/);
assert.match(indexSource, /updatePnlAndCheckExits\(p\.position, p, config\.management\)/);
assert.match(indexSource, /if \(!result\?\.positions\?\.length \|\| result\.stale\) return/);
assert.match(configSource, /pnlPollIntervalMs:\s+u\.pnlPollIntervalMs\s+\?\?\s+3_000/);
assert.match(dlmmSource, /pnl_source:\s*"rpc"/);
assert.match(dlmmSource, /pnl_source:\s*"meteora_fallback"/);
assert.doesNotMatch(dlmmSource.split("async function getMyPositionsLegacy")[0], /getWalletPnl/);
assert.doesNotMatch(indexSource, /Poll-triggered management/);
assert.doesNotMatch(indexSource, /_pollTriggeredAt/);
assert.doesNotMatch(indexSource, /action:\s*"SUPERTREND_EXIT"/);
assert.match(indexSource, /notifySupertrendWarning\(/);
assert.match(indexSource, /evaluateDangerDrawdownExit\(position\)/);
assert.match(indexSource, /DANGER_HOLD/);
assert.match(indexSource, /config\.chartIndicators\.exitInterval/);
assert.match(indexSource, /fetchKlineGMGN\(position\.base_mint, interval, 80\)/);
assert.doesNotMatch(indexSource, /Number\(momentum\.score\)/);
assert.match(dangerExitSource, /Danger hard close/);
assert.match(dangerExitSource, /grace active/);
assert.match(configSource, /dangerDrawdownPct:\s+u\.dangerDrawdownPct\s+\?\?\s+-5/);
assert.match(configSource, /dangerHardClosePct:\s+u\.dangerHardClosePct\s+\?\?\s+-8/);
assert.match(configSource, /dangerGraceMinutes:\s+u\.dangerGraceMinutes\s+\?\?\s+10/);

console.log("Immediate auto-close tests passed");
