import assert from "node:assert/strict";
import {
  getToolsForRole,
  shouldIsolateLookupHistory,
  shouldRequireRealToolUse,
} from "../agent.js";

assert.deepEqual(
  getToolsForRole("GENERAL", "halo"),
  [],
  "casual chat must not send the full tool schema",
);

assert.ok(
  getToolsForRole("GENERAL", "cek balance wallet").some((tool) => tool.function.name === "get_wallet_balance"),
  "wallet intent should expose wallet tools",
);

assert.ok(
  getToolsForRole("GENERAL", "close position saya").some((tool) => tool.function.name === "close_position"),
  "close intent should expose close tools",
);

const mintLookupTools = getToolsForRole(
  "GENERAL",
  "cek 2dJniDEAGCG7zWKseCkyrML3W23WLjDf1CGxpNv3pump",
);
assert.ok(
  mintLookupTools.some((tool) => tool.function.name === "get_token_info"),
  "a raw Solana mint lookup should expose token research tools",
);
assert.ok(
  mintLookupTools.some((tool) => tool.function.name === "search_pools"),
  "a raw Solana mint lookup should expose pool search",
);
assert.equal(
  shouldRequireRealToolUse(
    "cek 2dJniDEAGCG7zWKseCkyrML3W23WLjDf1CGxpNv3pump",
    "GENERAL",
    false,
  ),
  true,
  "a raw Solana mint lookup must not accept a no-tool final answer",
);
assert.equal(
  shouldIsolateLookupHistory(
    "cek yoA2CoHk6HRNtFuTP1kVt5xkcvG7mr5raQ5zuNxpump",
    "GENERAL",
  ),
  true,
  "a standalone mint lookup should not inherit an earlier token analysis",
);
assert.equal(
  shouldIsolateLookupHistory(
    "deploy 0.2 SOL ke yoA2CoHk6HRNtFuTP1kVt5xkcvG7mr5raQ5zuNxpump",
    "GENERAL",
  ),
  false,
  "an action request may retain conversation context",
);

console.log("Agent routing tests passed");
process.exit(0);
