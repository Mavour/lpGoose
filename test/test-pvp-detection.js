import assert from "node:assert/strict";
import {
  checkPoolPvpRisk,
  enrichPvpRisk,
  evaluatePvpAssets,
  evaluateScreeningGate,
  getPvpBlockReason,
} from "../tools/screening.js";
import { config } from "../config.js";

const REAL_PNUT = "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump";
const COPYCAT_PNUT = "6p3Y3WBXcVwMbYNoVsU4EuVb3gdMmzSKhkEfo8Vcpump";
const assets = [
  {
    id: REAL_PNUT,
    name: "Peanut the Squirrel",
    symbol: "Pnut",
    createdAt: "2024-10-31T14:21:40Z",
  },
  {
    id: COPYCAT_PNUT,
    name: "Peanut the Squirrel",
    symbol: "PNUT",
    createdAt: "2026-06-09T19:12:47Z",
  },
  {
    id: "FuzzyResult",
    name: "Not PNUT",
    symbol: "PNUT2",
    createdAt: "2020-01-01T00:00:00Z",
  },
];

function pool(mint, symbol = "Pnut") {
  return {
    pool: `pool-${mint}`,
    name: `${symbol}/SOL`,
    base: { mint, symbol },
    quote: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  };
}

const real = evaluatePvpAssets(pool(REAL_PNUT), assets);
assert.equal(real.pvp_check_status, "verified");
assert.equal(real.is_pvp, false);

const copycat = evaluatePvpAssets(pool(COPYCAT_PNUT), assets);
assert.equal(copycat.pvp_check_status, "copycat");
assert.equal(copycat.is_pvp, true);
assert.equal(copycat.pvp_rival_mint, REAL_PNUT);
assert.equal(copycat.pvp_rival_created_at, "2024-10-31T14:21:40.000Z");

const unique = evaluatePvpAssets(pool("UniqueMint", "UNIQUE"), [
  { id: "UniqueMint", symbol: "UNIQUE", createdAt: "2026-01-01T00:00:00Z" },
]);
assert.equal(unique.pvp_check_status, "verified");
assert.equal(unique.is_pvp, false);

const boundaryOwn = "2026-01-02T00:00:00Z";
for (const [rivalCreatedAt, expected] of [
  ["2026-01-01T00:00:00Z", "verified"],
  ["2025-12-31T23:59:59Z", "copycat"],
]) {
  const result = evaluatePvpAssets(pool("BoundaryMint", "BOUND"), [
    { id: "BoundaryMint", symbol: "BOUND", createdAt: boundaryOwn },
    { id: "OlderMint", symbol: "BOUND", createdAt: rivalCreatedAt },
  ]);
  assert.equal(result.pvp_check_status, expected);
}

const missingMint = evaluatePvpAssets(pool("MissingMint"), assets);
assert.equal(missingMint.pvp_check_status, "unverified");

const invalidTimestamp = evaluatePvpAssets(pool("InvalidMint", "INVALID"), [
  { id: "InvalidMint", symbol: "INVALID", createdAt: "not-a-date" },
]);
assert.equal(invalidTimestamp.pvp_check_status, "unverified");

const failedSearch = await checkPoolPvpRisk(pool("ApiFailure", "FAIL"), {
  searchAssets: async () => { throw new Error("timeout"); },
});
assert.equal(failedSearch.pvp_check_status, "unverified");
assert.match(failedSearch.pvp_check_reason, /timeout/);
assert.match(getPvpBlockReason(copycat), /copycat/);
assert.match(getPvpBlockReason(failedSearch), /unverified/);

let searchCount = 0;
const allPools = [
  pool(REAL_PNUT),
  pool(COPYCAT_PNUT),
  pool("UniqueMint", "UNIQUE"),
];
await enrichPvpRisk(allPools, {
  searchAssets: async (symbol) => {
    searchCount += 1;
    return symbol === "PNUT"
      ? assets
      : [{ id: "UniqueMint", symbol: "UNIQUE", createdAt: "2026-01-01T00:00:00Z" }];
  },
});
assert.equal(searchCount, 2, "each normalized symbol should be fetched once");
assert.deepEqual(allPools.map((item) => item.pvp_check_status), ["verified", "copycat", "verified"]);

const previousBlockPvp = config.screening.blockPvpSymbols;
config.screening.blockPvpSymbols = true;
try {
  assert.equal(evaluateScreeningGate(copycat).pass, false);
  assert.match(evaluateScreeningGate(copycat).reason, /pvp copycat/);
  assert.equal(evaluateScreeningGate(failedSearch).pass, false);
  assert.match(evaluateScreeningGate(failedSearch).reason, /pvp unverified/);
} finally {
  config.screening.blockPvpSymbols = previousBlockPvp;
}

console.log("PvP detection tests passed");
