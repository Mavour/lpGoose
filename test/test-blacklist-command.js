import assert from "node:assert/strict";
import { parseBlacklistCommand } from "../token-blacklist.js";

const mint = "2Mcwccy7Ckf6C2BUfwG9Z6kcYp8Mj5tKFBHEEoYCpump";

assert.deepEqual(
  parseBlacklistCommand(`blacklist 1B ${mint}`),
  {
    action: "add",
    symbol: "1B",
    mint,
    reason: "Manually blacklisted from Telegram",
  },
);

assert.deepEqual(
  parseBlacklistCommand(`/blacklist 1B ${mint} repeated stop-loss`),
  {
    action: "add",
    symbol: "1B",
    mint,
    reason: "repeated stop-loss",
  },
);

assert.deepEqual(
  parseBlacklistCommand("remove blacklist 1B"),
  { action: "remove", target: "1B" },
);

assert.deepEqual(
  parseBlacklistCommand(`unblacklist ${mint}`),
  { action: "remove", target: mint },
);

assert.deepEqual(parseBlacklistCommand("list blacklist"), { action: "list" });
assert.equal(parseBlacklistCommand("blacklist 1B invalid-mint"), null);

console.log("Blacklist command tests passed");
