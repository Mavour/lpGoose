import assert from "node:assert/strict";
import { getToolsForRole } from "../agent.js";

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

console.log("Agent routing tests passed");
process.exit(0);
