import "dotenv/config";
import { log } from "./logger.js";

const LPAGENT_BASE_URL = "https://api.lpagent.io/open-api/v1";
const METEORA_BASE_URL = "https://dlmm-api.meteora.ag";
const REQUEST_TIMEOUT_MS = 8000;

function getLpAgentKey() {
  return (process.env.LPAGENT_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)[0] || null;
}

function logSource(source, detail) {
  log("pnl_fetcher", `source=${source}${detail ? ` ${detail}` : ""}`);
}

function logError(context, error) {
  log("pnl_fetcher_warn", `${context}: ${error?.message || error}`);
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function toNumber(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchJson(url, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`);
      error.status = res.status;
      error.body = body;
      throw error;
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithOneRetry(url, options, context) {
  try {
    return await fetchJson(url, options);
  } catch (firstError) {
    const retryable =
      firstError.name === "AbortError" ||
      firstError.status == null ||
      isRetryableStatus(firstError.status);

    if (!retryable) throw firstError;

    logError(`${context} first attempt failed, retrying once`, firstError);

    try {
      return await fetchJson(url, options);
    } catch (secondError) {
      logError(`${context} retry failed`, secondError);
      throw secondError;
    }
  }
}

function firstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.positions)) return payload.positions;
  if (Array.isArray(payload?.result)) return payload.result;
  return [];
}

function normalizePosition(raw, fallbackAddress, source) {
  const positionAddress =
    raw?.position ||
    raw?.positionAddress ||
    raw?.tokenId ||
    raw?.address ||
    fallbackAddress;

  const pnlUsd =
    raw?.pnl?.valueNative ??
    raw?.pnl?.value ??
    raw?.pnlUsd ??
    raw?.pnl_usd ??
    raw?.totalPnl ??
    raw?.profit ??
    0;

  const feesCollected =
    raw?.collectedFee ??
    raw?.collectedFeeNative ??
    raw?.feesCollected ??
    raw?.allTimeFees?.total?.usd ??
    raw?.allTimeFees?.total?.sol ??
    raw?.feeUsd ??
    0;

  const currentValue =
    raw?.currentValue ??
    raw?.valueNative ??
    raw?.value ??
    raw?.unrealizedPnl?.balances ??
    raw?.balances ??
    0;

  const inRange =
    raw?.inRange ??
    (typeof raw?.isOutOfRange === "boolean" ? !raw.isOutOfRange : null);

  const pnlPct =
    raw?.pnl?.percentNative ??
    raw?.pnl?.percent ??
    raw?.pnlPctChange ??
    raw?.pnl_pct ??
    raw?.pnlPercent ??
    null;

  return {
    positionAddress,
    pnlUsd: toNumber(pnlUsd),
    feesCollected: toNumber(feesCollected),
    currentValue: toNumber(currentValue),
    inRange,
    pnlPct: pnlPct != null ? toNumber(pnlPct) : null,
    source,
  };
}

let _lastLpAgentCall = 0;
const LPAGENT_MIN_INTERVAL_MS = 2000;

async function fetchLpAgent(path, context) {
  const apiKey = getLpAgentKey();
  if (!apiKey) return null;

  const now = Date.now();
  const elapsed = now - _lastLpAgentCall;
  if (_lastLpAgentCall > 0 && elapsed < LPAGENT_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, LPAGENT_MIN_INTERVAL_MS - elapsed));
  }
  _lastLpAgentCall = Date.now();

  return fetchJsonWithOneRetry(
    `${LPAGENT_BASE_URL}${path}`,
    { headers: { "x-api-key": apiKey } },
    context
  );
}

async function fetchMeteora(path, context) {
  return fetchJsonWithOneRetry(`${METEORA_BASE_URL}${path}`, {}, context);
}

async function fetchMeteoraPoolPnl(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  const data = await fetchJsonWithOneRetry(url, {}, `Meteora pool PnL ${poolAddress.slice(0, 8)}`);
  const positions = data?.positions || data?.data || [];
  const byAddress = {};
  for (const p of positions) {
    const addr = p.positionAddress || p.address || p.position;
    if (addr) byAddress[addr] = p;
  }
  return byAddress;
}

/**
 * Fetch PnL for a single DLMM position.
 *
 * Primary source is LPAgent. If LPAGENT_API_KEY is missing, LPAgent fails,
 * times out, rate-limits, or returns unusable data, this falls back to Meteora.
 *
 * @param {string} positionAddress - DLMM position address.
 * @returns {Promise<{positionAddress: string, pnlUsd: number, feesCollected: number, currentValue: number, inRange: boolean|null, source: "lpagent"|"meteora_fallback"}>}
 */
export async function getPositionPnl(positionAddress) {
  try {
    const lpPayload = await fetchLpAgent(
      `/lp-positions/logs?owner=${encodeURIComponent(positionAddress)}`,
      `LPAgent position ${positionAddress}`
    );

    if (lpPayload) {
      const rows = firstArray(lpPayload);
      const row = rows.find((p) =>
        [p.position, p.positionAddress, p.tokenId, p.address].includes(positionAddress)
      ) || rows[0] || lpPayload?.data || lpPayload;

      logSource("lpagent", `position=${positionAddress}`);
      return normalizePosition(row, positionAddress, "lpagent");
    }
  } catch (error) {
    logError(`LPAgent position PnL failed for ${positionAddress}`, error);
  }

  try {
    const meteoraPayload = await fetchMeteora(
      `/position/${encodeURIComponent(positionAddress)}`,
      `Meteora position ${positionAddress}`
    );

    logSource("meteora_fallback", `position=${positionAddress}`);
    return normalizePosition(meteoraPayload?.data || meteoraPayload, positionAddress, "meteora_fallback");
  } catch (error) {
    logError(`Meteora fallback position PnL failed for ${positionAddress}`, error);
    logSource("meteora_fallback", `position=${positionAddress} error=true`);
    return {
      positionAddress,
      pnlUsd: 0,
      feesCollected: 0,
      currentValue: 0,
      inRange: null,
      source: "meteora_fallback",
      error: error?.message || String(error),
    };
  }
}

/**
 * Fetch PnL for all currently open DLMM positions owned by a wallet.
 *
 * Primary source is LPAgent. If LPAGENT_API_KEY is missing, LPAgent fails,
 * times out, rate-limits, or returns unusable data, this falls back to Meteora.
 *
 * @param {string} walletAddress - Solana wallet address.
 * @returns {Promise<{walletAddress: string, positions: Array<object>, totalPnlUsd: number, totalFeesCollected: number, source: "lpagent"|"meteora_fallback"}>}
 */
export async function getWalletPnl(walletAddress) {
  try {
    const lpPayload = await fetchLpAgent(
      `/lp-positions/opening?owner=${encodeURIComponent(walletAddress)}`,
      `LPAgent wallet ${walletAddress}`
    );

    if (lpPayload) {
      const positions = firstArray(lpPayload).map((p) =>
        normalizePosition(p, p.position || p.tokenId || p.positionAddress, "lpagent")
      );

      logSource("lpagent", `wallet=${walletAddress}`);
      return {
        walletAddress,
        positions,
        totalPnlUsd: positions.reduce((sum, p) => sum + p.pnlUsd, 0),
        totalFeesCollected: positions.reduce((sum, p) => sum + p.feesCollected, 0),
        source: "lpagent",
      };
    }
  } catch (error) {
    logError(`LPAgent wallet PnL failed for ${walletAddress}`, error);
  }

  try {
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${encodeURIComponent(walletAddress)}`;
    const portfolio = await fetchJsonWithOneRetry(portfolioUrl, {}, `Meteora portfolio ${walletAddress}`);
    const pools = portfolio?.pools || [];
    const allPositions = [];

    for (const pool of pools) {
      const pnlByPos = await fetchMeteoraPoolPnl(pool.poolAddress, walletAddress);
      for (const posAddr of (pool.listPositions || [])) {
        const raw = pnlByPos[posAddr] || {};
        allPositions.push(normalizePosition({ ...raw, positionAddress: posAddr, position: posAddr }, posAddr, "meteora_fallback"));
      }
    }

    logSource("meteora_fallback", `wallet=${walletAddress}`);
    return {
      walletAddress,
      positions: allPositions,
      totalPnlUsd: allPositions.reduce((sum, p) => sum + p.pnlUsd, 0),
      totalFeesCollected: allPositions.reduce((sum, p) => sum + p.feesCollected, 0),
      source: "meteora_fallback",
    };
  } catch (error) {
    logError(`Meteora fallback wallet PnL failed for ${walletAddress}`, error);
    logSource("meteora_fallback", `wallet=${walletAddress} error=true`);
    return {
      walletAddress,
      positions: [],
      totalPnlUsd: 0,
      totalFeesCollected: 0,
      source: "meteora_fallback",
      error: error?.message || String(error),
    };
  }
}

/**
 * Fetch top LPers for a Meteora pool from LPAgent.
 *
 * This is an LPAgent Premium endpoint and intentionally has no Meteora
 * fallback. Missing LPAGENT_API_KEY throws the required explicit error.
 *
 * @param {string} poolAddress - Meteora pool address.
 * @param {number} [limit=10] - Maximum number of LPers to request.
 * @returns {Promise<object>} Raw LPAgent response.
 */
export async function getPoolTopLpers(poolAddress, limit = 10) {
  const apiKey = getLpAgentKey();
  if (!apiKey) {
    throw new Error("top-lpers requires LPAgent Premium key");
  }

  try {
    const payload = await fetchJsonWithOneRetry(
      `${LPAGENT_BASE_URL}/pools/${encodeURIComponent(poolAddress)}/top-lpers?limit=${encodeURIComponent(limit)}`,
      { headers: { "x-api-key": apiKey } },
      `LPAgent top-lpers ${poolAddress}`
    );

    logSource("lpagent", `top_lpers_pool=${poolAddress}`);
    return payload;
  } catch (error) {
    logError(`LPAgent top-lpers failed for ${poolAddress}`, error);
    return {
      status: "error",
      error: error?.message || String(error),
      source: "lpagent",
    };
  }
}

if (process.argv[2] === "--test") {
  const dummyPosition = "DummyPosition111111111111111111111111111111111";
  const dummyWallet = "DummyWallet111111111111111111111111111111111111";
  const dummyPool = "DummyPool11111111111111111111111111111111111111";

  console.log("Testing getPositionPnl...");
  console.log(await getPositionPnl(dummyPosition));

  console.log("Testing getWalletPnl...");
  console.log(await getWalletPnl(dummyWallet));

  console.log("Testing getPoolTopLpers...");
  try {
    console.log(await getPoolTopLpers(dummyPool, 3));
  } catch (error) {
    console.error(error.message);
  }
}
