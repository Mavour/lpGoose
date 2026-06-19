import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchLPAgentWalletPnl } from "../pnl-fetcher.js";
import { parseFastCloseCommand, resolveCloseMatches } from "../tools/telegram-close.js";

assert.deepEqual(parseFastCloseCommand("close all"), {
  target: null,
  singleOpenPosition: false,
  closeAll: true,
});
assert.deepEqual(parseFastCloseCommand("/close all"), {
  target: null,
  singleOpenPosition: false,
  closeAll: true,
});
assert.deepEqual(parseFastCloseCommand("exit all"), {
  target: null,
  singleOpenPosition: false,
  closeAll: true,
});
assert.equal(parseFastCloseCommand("/close 1"), null);
assert.deepEqual(parseFastCloseCommand("/close"), {
  target: null,
  singleOpenPosition: true,
  closeAll: false,
});
assert.equal(resolveCloseMatches([
  { pair: "GTAVI-SOL", position: "PositionOne", pool: "PoolOne" },
  { pair: "ZERO-SOL", position: "PositionTwo", pool: "PoolTwo" },
], "GTAVI").length, 1);

const originalFetch = globalThis.fetch;
const originalKey = process.env.LPAGENT_API_KEY;
try {
  process.env.LPAGENT_API_KEY = "test-key";
  let requestedUrl = "";
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    assert.equal(options.headers["x-api-key"], "test-key");
    return {
      ok: true,
      text: async () => JSON.stringify({
        positions: [{
          positionAddress: "PositionOne",
          pnlPct: 12.5,
          pnlUsd: 3.2,
          pnlSol: 0.01,
          currentValue: 28,
          feesCollected: 0.4,
        }],
      }),
    };
  };
  const pnl = await fetchLPAgentWalletPnl("WalletOne");
  assert.match(requestedUrl, /\/wallets\/WalletOne\/pnl$/);
  assert.equal(pnl.source, "lpagent");
  assert.equal(pnl.positions[0].positionAddress, "PositionOne");
  assert.equal(pnl.positions[0].pnlPct, 12.5);
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey == null) delete process.env.LPAGENT_API_KEY;
  else process.env.LPAGENT_API_KEY = originalKey;
}

const configSource = fs.readFileSync("./config.js", "utf8");
assert.match(configSource, /lpAgentPnlNormalTtlMs:\s+u\.lpAgentPnlNormalTtlMs\s+\?\?\s+30_000/);
assert.match(configSource, /lpAgentPnlUrgentTtlMs:\s+u\.lpAgentPnlUrgentTtlMs\s+\?\?\s+15_000/);

const dlmmSource = fs.readFileSync("./tools/dlmm.js", "utf8");
assert.match(dlmmSource, /pnl_source:\s+"unknown"/);
assert.match(dlmmSource, /pnl_source = "lpagent_fallback"/);
assert.match(dlmmSource, /fetchLPAgentPnlMap\(walletAddress, \{ urgent \}\)/);
assert.match(dlmmSource, /function needsLpAgentFallback\(position\)/);
assert.match(dlmmSource, /if \(!meteoraPositions\.some\(needsLpAgentFallback\)\)/);
assert.match(dlmmSource, /needsLpAgentFallback\(position\)\s*\?\s*applyLpAgentPnl\(position, lpAgentMap\.get\(position\.position\)\)/);
assert.doesNotMatch(dlmmSource, /pnlPct \?\? 0/);

console.log("PnL chain and close-all tests passed");
