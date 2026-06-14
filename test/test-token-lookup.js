import assert from "node:assert/strict";
import { selectTokenSearchResults } from "../tools/token.js";

const islandsMint = "yoA2CoHk6HRNtFuTP1kVt5xkcvG7mr5raQ5zuNxpump";
const turtleMint = "2dJniDEAGCG7zWKseCkyrML3W23WLjDf1CGxpNv3pump";
const fuzzyResults = [
  { id: turtleMint, symbol: "TURTLE" },
  { id: islandsMint, symbol: "ISLANDS" },
];

assert.deepEqual(
  selectTokenSearchResults(fuzzyResults, islandsMint),
  [{ id: islandsMint, symbol: "ISLANDS" }],
  "mint lookup must select the exact token even when a fuzzy result appears first",
);

assert.deepEqual(
  selectTokenSearchResults([{ id: turtleMint, symbol: "TURTLE" }], islandsMint),
  [],
  "mint lookup must not substitute a different token",
);

assert.deepEqual(
  selectTokenSearchResults(fuzzyResults, "TURTLE", 1),
  [{ id: turtleMint, symbol: "TURTLE" }],
  "symbol lookup should preserve ranked fuzzy search behavior",
);

console.log("Token lookup tests passed");
