import assert from "node:assert/strict";
import fs from "node:fs";
import { selectAdaptivePnlPollIntervalMs } from "../tools/polling.js";
import {
  instrumentConnection,
  snapshotRpcTelemetry,
} from "../tools/rpc-telemetry.js";

const schedule = {
  pnlPollIntervalMs: 3_000,
  pnlNormalPollIntervalMs: 15_000,
  pnlNoPositionPollIntervalMs: 60_000,
};
const management = {
  trailingTakeProfit: true,
  trailingTriggerPct: 2,
  trailingDropPct: 0.15,
  stopLossPct: -10,
  dangerDrawdownPct: -5,
};

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [],
  result: { positions: [] },
  schedule,
  management,
}), 60_000);

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [{ position: "p1" }],
  result: { positions: [{ position: "p1", pnl_pct: 0.1, in_range: true }] },
  schedule,
  management,
}), 15_000);

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [{ position: "p1" }],
  result: { positions: [{ position: "p1", pnl_pct: 2.1, in_range: true }] },
  schedule,
  management,
}), 3_000);

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [{ position: "p1" }],
  result: { positions: [{ position: "p1", pnl_pct: -4.2, in_range: true }] },
  schedule,
  management,
}), 3_000);

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [{ position: "p1" }],
  result: { positions: [{ position: "p1", pnl_pct: 0.1, in_range: false }] },
  schedule,
  management,
}), 3_000);

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [{ position: "p1" }],
  result: null,
  schedule,
  management,
}), 3_000);

assert.equal(selectAdaptivePnlPollIntervalMs({
  trackedPositions: [{ position: "p1" }],
  result: { stale: true, positions: [{ position: "p1" }] },
  schedule,
  management,
}), 3_000);

const dashboardSource = fs.readFileSync("./dashboard/server.js", "utf8");
assert.match(dashboardSource, /BALANCE_CACHE_TTL_MS/);
assert.match(dashboardSource, /case '\/api\/logs\/stream':\s+return apiLogStream/);

const fakeConnection = {
  getBalance: async () => 1,
};
instrumentConnection(fakeConnection, "test");
await fakeConnection.getBalance("wallet");
const rpcCounts = snapshotRpcTelemetry({ reset: true });
assert.equal(rpcCounts.getBalance, 1);

console.log("RPC optimization tests passed");
