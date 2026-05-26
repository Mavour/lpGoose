const DEFAULT_GMGN_BASE = "https://gmgn.ai";

function gmgnHeaders() {
  const key = process.env.GMGN_API_KEY || process.env.GMGN_API_TOKEN || "";
  const headers = {
    accept: "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0",
  };
  if (key) {
    headers.authorization = key.startsWith("Bearer ") ? key : `Bearer ${key}`;
    headers["x-api-key"] = key;
    headers["api-key"] = key;
  }
  return headers;
}

async function fetchJson(path) {
  const base = (process.env.GMGN_API_BASE || DEFAULT_GMGN_BASE).replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, { headers: gmgnHeaders() });
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
  if (!mint && !pool_address) return { pool_fees_sol: null, source: null };

  const attempts = [];
  if (pool_address) {
    attempts.push(`/defi/quotation/v1/pools/sol/${pool_address}`);
    attempts.push(`/defi/quotation/v1/pool/sol/${pool_address}`);
  }
  if (mint) {
    attempts.push(`/defi/quotation/v1/tokens/sol/${mint}`);
    attempts.push(`/defi/quotation/v1/token/sol/${mint}`);
  }

  const errors = [];
  for (const path of attempts) {
    try {
      const data = await fetchJson(path);
      const poolObj = pool_address ? findMatchingPool(data, pool_address) : data?.data || data;
      const value = feeValueOf(poolObj);
      if (value != null) {
        return { pool_fees_sol: Number(value.toFixed(2)), source: "gmgn" };
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  return {
    pool_fees_sol: null,
    source: null,
    error: errors[0] || "GMGN pool fee not found",
  };
}
