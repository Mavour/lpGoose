import assert from "node:assert/strict";
import {
  assessEstablishedPvpRival,
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
    liquidity: 2_300_000,
    holderCount: 110_700,
    organicScore: 90,
    stats24h: { buyVolume: 40_000, sellVolume: 47_800 },
  },
  {
    id: COPYCAT_PNUT,
    name: "Peanut the Squirrel",
    symbol: "PNUT",
    createdAt: "2026-06-09T19:12:47Z",
    liquidity: 42_600,
    holderCount: 1_080,
    organicScore: 75,
    stats24h: { buyVolume: 600_000, sellVolume: 700_000 },
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

const establishedPnut = {
  established: true,
  liquidity: 2_300_000,
  volume24h: 87_800,
  holders: 110_700,
  pool: "PnutEstablishedPool",
  tvl: 2_300_000,
  feeTvl: 0.5,
  poolFeesSol: 146.44,
};
const copycat = evaluatePvpAssets(
  pool(COPYCAT_PNUT),
  assets,
  new Map([[REAL_PNUT, establishedPnut]]),
);
assert.equal(copycat.pvp_check_status, "copycat");
assert.equal(copycat.is_pvp, true);
assert.equal(copycat.pvp_rival_mint, REAL_PNUT);
assert.equal(copycat.pvp_rival_created_at, "2024-10-31T14:21:40.000Z");
assert.equal(copycat.pvp_rival_liquidity, 2_300_000);
assert.equal(copycat.pvp_rival_volume_24h, 87_800);
assert.equal(copycat.pvp_rival_holders, 110_700);
assert.equal(copycat.pvp_rival_pool, "PnutEstablishedPool");
assert.equal(copycat.pvp_rival_tvl, 2_300_000);
assert.equal(copycat.pvp_rival_fee_tvl, 0.5);

const unique = evaluatePvpAssets(pool("UniqueMint", "UNIQUE"), [
  { id: "UniqueMint", symbol: "UNIQUE", createdAt: "2026-01-01T00:00:00Z" },
]);
assert.equal(unique.pvp_check_status, "verified");
assert.equal(unique.is_pvp, false);

const boundaryOwn = "2026-01-02T00:00:00Z";
for (const [rivalCreatedAt, expected] of [
  ["2026-01-01T00:00:00Z", "verified"],
  ["2025-12-31T23:59:59Z", "symbol_collision"],
]) {
  const result = evaluatePvpAssets(pool("BoundaryMint", "BOUND"), [
    { id: "BoundaryMint", symbol: "BOUND", createdAt: boundaryOwn },
    { id: "OlderMint", symbol: "BOUND", createdAt: rivalCreatedAt },
  ], new Map([["OlderMint", { established: true }]]));
  assert.equal(result.pvp_check_status, expected);
}

const DEAD_CHANCE = "4rBey6kLcpWZP2csF5jugkFJXH6kqaoMJJVtjUJipump";
const LIVE_CHANCE = "JCKwsT8UAbygnFkZ7u3amDUM7BXRtwUhCsHQv2khpump";
const chanceAssets = [
  {
    id: DEAD_CHANCE,
    name: "a chance to be kind",
    symbol: "chance",
    createdAt: "2026-06-09T00:48:01Z",
    liquidity: 1_967,
    holderCount: 1,
    organicScore: 0,
    stats24h: { buyVolume: 265, sellVolume: 265 },
  },
  {
    id: LIVE_CHANCE,
    name: "CHANCE",
    symbol: "CHANCE",
    createdAt: "2026-06-10T12:00:00Z",
  },
];
const chance = await checkPoolPvpRisk(pool(LIVE_CHANCE, "CHANCE"), {
  searchAssets: async () => chanceAssets,
  assessRival: async () => ({
    established: false,
    reason: "liquidity 1967 < min 5000; holders 1 < min 1000; organic 0 < min 70",
  }),
});
assert.equal(chance.pvp_check_status, "verified");
assert.equal(chance.is_pvp, false);
assert.match(chance.pvp_check_reason, /none qualify as an established OG/);

const assessedPnut = await assessEstablishedPvpRival(assets[0], {
  searchPools: async () => [
    { address: "WeakPool", mint_x: REAL_PNUT },
    { address: "StrongPool", mint_x: REAL_PNUT },
  ],
  getPoolQuality: async (address) => address === "StrongPool"
    ? { pool: address, active_tvl: 2_300_000, volume_window: 87_800, fee_active_tvl_ratio: 0.5 }
    : { pool: address, active_tvl: 1_000, volume_window: 100, fee_active_tvl_ratio: 0.01 },
  getPoolFees: async ({ pool_address }) => ({
    pool_fees_sol: pool_address === "StrongPool" ? 146.44 : 1,
  }),
});
assert.equal(assessedPnut.established, true);
assert.equal(assessedPnut.pool, "StrongPool");

const highVolumeButWeak = await assessEstablishedPvpRival({
  id: "WeakMint",
  liquidity: 1_000,
  holderCount: 2,
  organicScore: 0,
  stats24h: { buyVolume: 1_000_000, sellVolume: 1_000_000 },
}, {
  searchPools: async () => [{ address: "WeakPool", mint_x: "WeakMint" }],
  getPoolQuality: async () => ({
    pool: "WeakPool",
    active_tvl: 1_000,
    volume_window: 2_000_000,
    fee_active_tvl_ratio: 1,
  }),
  getPoolFees: async () => ({ pool_fees_sol: 100 }),
});
assert.equal(highVolumeButWeak.established, false);
assert.match(highVolumeButWeak.reason, /liquidity|holders|organic/);

const noPoolRival = await assessEstablishedPvpRival({
  id: "NoPoolMint",
  liquidity: 100_000,
  holderCount: 10_000,
  organicScore: 90,
  stats24h: { buyVolume: 50_000, sellVolume: 50_000 },
}, {
  searchPools: async () => [],
});
assert.equal(noPoolRival.established, false);
assert.match(noPoolRival.reason, /no active market pool/);

const failedRivalVerification = await checkPoolPvpRisk(pool(COPYCAT_PNUT), {
  searchAssets: async () => assets,
  assessRival: async () => { throw new Error("Meteora unavailable"); },
});
assert.equal(failedRivalVerification.pvp_check_status, "unverified");
assert.match(failedRivalVerification.pvp_check_reason, /Meteora unavailable/);

const missingMint = evaluatePvpAssets(pool("MissingMint"), assets);
assert.equal(missingMint.pvp_check_status, "unverified");

const invalidTimestamp = evaluatePvpAssets(pool("InvalidMint", "INVALID"), [
  { id: "InvalidMint", symbol: "INVALID", createdAt: "not-a-date" },
]);
assert.equal(invalidTimestamp.pvp_check_status, "unverified");

const JOTCHOA = "BcHEaaTCvycPwwsJ9yQTXdHP9X2gCLkznDbZ8VySpump";
const UNDATED_JOTCHOA_RIVAL = "3aBcYMDudtgJoMoJBECnVLo6zKKfzHKpnEjMzx4wRi97";
const jotchoaAssets = [
  {
    id: JOTCHOA,
    name: "Jotchoa",
    symbol: "Jotchoa",
    createdAt: "2026-06-07T00:00:00Z",
  },
  {
    id: UNDATED_JOTCHOA_RIVAL,
    name: "Jotchoa copy",
    symbol: "Jotchoa",
    createdAt: null,
  },
];
const jotchoaWithWeakUndatedRival = await checkPoolPvpRisk(pool(JOTCHOA, "Jotchoa"), {
  searchAssets: async () => jotchoaAssets,
  assessRival: async () => ({
    established: false,
    reason: "liquidity 500 < min 5000; holders 2 < min 1000",
  }),
});
assert.equal(jotchoaWithWeakUndatedRival.pvp_check_status, "verified");
assert.equal(jotchoaWithWeakUndatedRival.is_pvp, false);
assert.match(jotchoaWithWeakUndatedRival.pvp_check_reason, /without createdAt/);

const jotchoaWithStrongUndatedRival = await checkPoolPvpRisk(pool(JOTCHOA, "Jotchoa"), {
  searchAssets: async () => jotchoaAssets,
  assessRival: async () => ({
    established: true,
    liquidity: 500_000,
    volume24h: 100_000,
    holders: 20_000,
    pool: "StrongUndatedPool",
    tvl: 400_000,
    feeTvl: 0.5,
    poolFeesSol: 200,
  }),
});
assert.equal(jotchoaWithStrongUndatedRival.pvp_check_status, "unverified");
assert.equal(jotchoaWithStrongUndatedRival.is_pvp, false);
assert.match(jotchoaWithStrongUndatedRival.pvp_check_reason, /established same-symbol rival/);
assert.match(getPvpBlockReason(jotchoaWithStrongUndatedRival), /unverified/);

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
  assessRival: async (asset) => asset.id === REAL_PNUT
    ? establishedPnut
    : { established: false, reason: "not established" },
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
