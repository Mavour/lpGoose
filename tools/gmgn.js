import crypto from "crypto";

const DEFAULT_GMGN_BASE = "https://openapi.gmgn.ai";

function gmgnHeaders() {
  const key = process.env.GMGN_API_KEY || process.env.GMGN_API_TOKEN || "";
  return { "X-APIKEY": key };
}

async function fetchJson(path) {
  const base = (process.env.GMGN_API_BASE || DEFAULT_GMGN_BASE).replace(/\/$/, "");
  const separator = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${separator}timestamp=${Date.now()}&client_id=${crypto.randomUUID()}`;
  const res = await fetch(url, { headers: gmgnHeaders() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GMGN API error ${res.status}: ${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GMGN API returned non-JSON: ${text.slice(0, 120)}`);
  }
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function poolAddressOf(obj) {
  return obj?.pool_address
    || obj?.poolAddress
    || obj?.pair_address
    || obj?.pairAddress
    || obj?.address
    || obj?.pool
    || obj?.id
    || null;
}

function feeValueOf(obj) {
  if (!obj || typeof obj !== "object") return null;
  const directKeys = [
    "pool_fees_sol",
    "poolFeesSol",
    "pool_fee_sol",
    "poolFeeSol",
    "total_fees_sol",
    "totalFeesSol",
    "total_fee_sol",
    "totalFeeSol",
    "fees_sol",
    "feesSol",
    "fee_sol",
    "feeSol",
    "fees",
    "fee",
    "total_fee",
    "totalFee",
  ];
  for (const key of directKeys) {
    const n = toNumber(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function findMatchingPool(root, poolAddress) {
  const target = poolAddress?.toLowerCase();
  if (!target || !root || typeof root !== "object") return null;

  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);

    const addr = poolAddressOf(cur);
    if (addr && String(addr).toLowerCase() === target) {
      return cur;
    }

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
    } else {
      for (const value of Object.values(cur)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
  }
  return null;
}

export async function getGmgnPoolFees({ mint, pool_address }) {
  if (!mint) return { pool_fees_sol: null, source: null };

  try {
    const data = await fetchJson(`/v1/token/info?chain=sol&address=${mint}`);
    const info = data?.data?.data || data?.data || data;
    const value = feeValueOf(info);
    if (value != null) {
      return { pool_fees_sol: Number(value.toFixed(2)), source: "gmgn" };
    }
    return { pool_fees_sol: null, source: null, error: "total_fee not found in GMGN response" };
  } catch (e) {
    return { pool_fees_sol: null, source: null, error: e.message };
  }
}
