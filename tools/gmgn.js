import crypto from "crypto";
import { fetchGmgn } from "./gmgn-request.js";

const DEFAULT_GMGN_BASE = "https://openapi.gmgn.ai";

function gmgnHeaders() {
  const key = process.env.GMGN_API_KEY || process.env.GMGN_API_TOKEN || "";
  return { "X-APIKEY": key };
}

async function fetchJson(path) {
  const base = (process.env.GMGN_API_BASE || DEFAULT_GMGN_BASE).replace(/\/$/, "");
  const separator = path.includes("?") ? "&" : "?";
  const timestamp = Math.floor(Date.now() / 1000);
  const url = `${base}${path}${separator}timestamp=${timestamp}&client_id=${crypto.randomUUID()}`;
  const res = await fetchGmgn(url, { headers: gmgnHeaders() });
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
  ];
  for (const key of directKeys) {
    const n = toNumber(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function tokenTotalFeeOf(obj) {
  return toNumber(
    obj?.total_fee
    ?? obj?.totalFee
    ?? obj?.total_fees_sol
    ?? obj?.totalFeesSol
  );
}

function withPriceContext(result, info) {
  const price = toNumber(info?.price?.price ?? info?.price);
  const ath = toNumber(info?.ath_price ?? info?.athPrice);
  if (price == null || ath == null || ath <= 0) return result;
  return {
    ...result,
    price,
    ath,
    price_vs_ath_pct: Number(((price / ath) * 100).toFixed(1)),
  };
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

export async function getGmgnPoolFees({ mint, pool_address }, { fetchData = fetchJson } = {}) {
  if (!mint || !pool_address) {
    return { pool_fees_sol: null, source: null, error: "mint and pool_address are required" };
  }

  try {
    const data = await fetchData(`/v1/token/info?chain=sol&address=${mint}`);
    const info = data?.data?.data || data?.data || data;
    const matchedPool = findMatchingPool(info, pool_address);
    if (!matchedPool) {
      const tokenTotal = tokenTotalFeeOf(info);
      if (tokenTotal != null) {
        return withPriceContext({
          pool_fees_sol: Number(tokenTotal.toFixed(2)),
          source: "gmgn_token_total",
          timeframe: "all_time",
          scope: "token",
        }, info);
      }
      return {
        pool_fees_sol: null,
        source: null,
        error: `requested pool ${pool_address} not found in GMGN response`,
      };
    }
    const value = feeValueOf(matchedPool);
    if (value != null) {
      return withPriceContext({
        pool_fees_sol: Number(value.toFixed(2)),
        source: "gmgn_pool",
        timeframe: matchedPool.timeframe || matchedPool.interval || null,
        scope: "pool",
      }, info);
    }
    const tokenTotal = tokenTotalFeeOf(info);
    if (tokenTotal != null) {
      return withPriceContext({
        pool_fees_sol: Number(tokenTotal.toFixed(2)),
        source: "gmgn_token_total",
        timeframe: "all_time",
        scope: "token",
      }, info);
    }
    return { pool_fees_sol: null, source: null, error: "pool fee not found in matching GMGN pool response" };
  } catch (e) {
    return { pool_fees_sol: null, source: null, error: e.message };
  }
}
