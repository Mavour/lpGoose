import "dotenv/config";
import { log } from "./logger.js";

const LPAGENT_BASE_URL = "https://api.lpagent.io/open-api/v1";
const METEORA_DATA_URL = "https://dlmm.datapi.meteora.ag";
const JUPITER_DATA_URL = "https://datapi.jup.ag/v1";
const REQUEST_TIMEOUT_MS = 8000;

function getLpAgentKey() {
  return (process.env.LPAGENT_API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)[0] || null;
}

function getLpAgentWalletPnlUrls(walletAddress) {
  const wallet = encodeURIComponent(walletAddress);
  const templates = (process.env.LPAGENT_WALLET_PNL_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  const defaults = [
    `${LPAGENT_BASE_URL}/wallets/${wallet}/pnl`,
    `${LPAGENT_BASE_URL}/wallets/${wallet}/positions`,
    `${LPAGENT_BASE_URL}/wallets/${wallet}/positions/pnl`,
    `${LPAGENT_BASE_URL}/wallet/${wallet}/pnl`,
    `${LPAGENT_BASE_URL}/wallet/${wallet}/positions`,
    `${LPAGENT_BASE_URL}/pnl/wallets/${wallet}`,
    `${LPAGENT_BASE_URL}/pnl?wallet=${wallet}`,
    `${LPAGENT_BASE_URL}/positions?wallet=${wallet}`,
    `${LPAGENT_BASE_URL}/positions/pnl?wallet=${wallet}`,
  ];

  return [...templates, ...defaults].map((url) =>
    url
      .replaceAll("{wallet}", wallet)
      .replaceAll("{walletAddress}", wallet)
  );
}

function logError(context, error) {
  log("pnl_fetcher_warn", `${context}: ${error?.message || error}`);
}

function isRetryableStatus(status) {
  return status >= 500;
}

export function pnlNumber(value, fallback = 0) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

export function calculatePnl({ balance, withdrawals, claimableFees, claimedFees, deposits }) {
  const normalized = {
    balance: pnlNumber(balance),
    withdrawals: pnlNumber(withdrawals),
    claimableFees: pnlNumber(claimableFees),
    claimedFees: pnlNumber(claimedFees),
    deposits: pnlNumber(deposits),
  };
  const pnl =
    normalized.balance +
    normalized.withdrawals +
    normalized.claimableFees +
    normalized.claimedFees -
    normalized.deposits;

  return {
    ...normalized,
    pnl,
    pnlPct: normalized.deposits > 0 ? (pnl / normalized.deposits) * 100 : null,
  };
}

export function calculateMeteoraPositionPnl(position, denomination = "usd") {
  const isSol = denomination === "sol";
  const unrealized = position?.unrealizedPnl || {};
  const valueField = isSol ? "amountSol" : "usd";
  const claimableFees = [
    unrealized.unclaimedFeeTokenX?.[valueField],
    unrealized.unclaimedFeeTokenY?.[valueField],
    unrealized.unclaimedRewardTokenX?.[valueField],
    unrealized.unclaimedRewardTokenY?.[valueField],
  ].reduce((sum, value) => sum + pnlNumber(value), 0);

  return calculatePnl({
    balance: isSol ? unrealized.balancesSol : unrealized.balances,
    withdrawals: isSol
      ? position?.allTimeWithdrawals?.total?.sol
      : position?.allTimeWithdrawals?.total?.usd,
    claimableFees,
    claimedFees: isSol
      ? position?.allTimeFees?.total?.sol
      : position?.allTimeFees?.total?.usd,
    deposits: isSol
      ? position?.allTimeDeposits?.total?.sol
      : position?.allTimeDeposits?.total?.usd,
  });
}

async function fetchJson(url, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
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
    return fetchJson(url, options);
  }
}

export async function fetchMeteoraPortfolio(walletAddress) {
  return fetchJsonWithOneRetry(
    `${METEORA_DATA_URL}/portfolio/open?user=${encodeURIComponent(walletAddress)}`,
    {},
    `Meteora portfolio ${walletAddress}`
  );
}

export async function fetchMeteoraPoolPnl(poolAddress, walletAddress) {
  const payload = await fetchJsonWithOneRetry(
    `${METEORA_DATA_URL}/positions/${poolAddress}/pnl?user=${encodeURIComponent(walletAddress)}&status=open&pageSize=100&page=1`,
    {},
    `Meteora PnL ${poolAddress.slice(0, 8)}`
  );
  const rows = payload?.positions || payload?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`Invalid Meteora PnL response for ${poolAddress}`);
  }

  const positions = new Map();
  for (const row of rows) {
    const address = row.positionAddress || row.address || row.position;
    if (address) positions.set(address, row);
  }
  return positions;
}

export async function fetchJupiterPrices(mints) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  if (uniqueMints.length === 0) return new Map();
  const payload = await fetchJsonWithOneRetry(
    `${JUPITER_DATA_URL}/assets/search?query=${encodeURIComponent(uniqueMints.join(","))}`,
    {},
    "Jupiter PnL prices"
  );
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) throw new Error("Invalid Jupiter price response");
  return new Map(rows.map((row) => [row.id, pnlNumber(row.usdPrice, null)]));
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number.parseFloat(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function unwrapLpAgentRows(payload) {
  const candidates = [
    payload?.positions,
    payload?.data?.positions,
    payload?.data?.tokenPositions,
    payload?.data,
    payload?.wallet?.positions,
    payload,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeLpAgentPnlRow(row) {
  const positionAddress =
    row?.positionAddress ||
    row?.position_address ||
    row?.address ||
    row?.position ||
    row?.pubkey;
  if (!positionAddress) return null;

  return {
    positionAddress,
    pnlPct: firstFinite(
      row?.pnlPct,
      row?.pnl_pct,
      row?.pnlPercentage,
      row?.pnl_percentage,
      row?.pnlSolPctChange,
      row?.pnlPctChange,
      row?.pnl?.percent,
      row?.pnl?.percentage
    ),
    pnlUsd: firstFinite(
      row?.pnlUsd,
      row?.pnl_usd,
      row?.totalPnl,
      row?.total_pnl,
      row?.pnl?.usd,
      row?.pnl?.value
    ),
    pnlSol: firstFinite(row?.pnlSol, row?.pnl_sol),
    currentValue: firstFinite(
      row?.currentValue,
      row?.current_value,
      row?.currentValueUsd,
      row?.current_value_usd,
      row?.valueUsd,
      row?.value_usd
    ),
    feesCollected: firstFinite(
      row?.feesCollected,
      row?.fees_collected,
      row?.allTimeFeesUsd,
      row?.all_time_fees_usd,
      row?.allTimeFees?.total?.usd
    ),
    raw: row,
  };
}

export async function fetchLPAgentWalletPnl(walletAddress) {
  const apiKey = getLpAgentKey();
  if (!apiKey) throw new Error("LPAgent API key missing");

  const urls = getLpAgentWalletPnlUrls(walletAddress);
  let lastError = null;
  let lastPayload = null;
  let lastSourceUrl = null;
  for (const url of urls) {
    try {
      const payload = await fetchJsonWithOneRetry(
        url,
        { headers: { "x-api-key": apiKey } },
        `LPAgent wallet PnL ${walletAddress}`
      );
      const positions = unwrapLpAgentRows(payload)
        .map(normalizeLpAgentPnlRow)
        .filter(Boolean);
      if (positions.length > 0) {
        return { source: "lpagent", positions, url, raw: payload };
      }
      lastPayload = payload;
      lastSourceUrl = url;
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 404) throw error;
    }
  }
  if (!lastPayload) {
    throw new Error(`LPAgent wallet PnL unavailable: ${lastError?.message || "no endpoint returned data"}`);
  }

  return { source: "lpagent", positions: [], url: lastSourceUrl, raw: lastPayload };
}

/**
 * LPAgent top-LPers uses the same premium API key as the PnL fallback.
 */
export async function getPoolTopLpers(poolAddress, limit = 10) {
  const apiKey = getLpAgentKey();
  if (!apiKey) throw new Error("top-lpers requires LPAgent Premium key");

  try {
    return await fetchJsonWithOneRetry(
      `${LPAGENT_BASE_URL}/pools/${encodeURIComponent(poolAddress)}/top-lpers?limit=${encodeURIComponent(limit)}`,
      { headers: { "x-api-key": apiKey } },
      `LPAgent top-lpers ${poolAddress}`
    );
  } catch (error) {
    logError(`LPAgent top-lpers failed for ${poolAddress}`, error);
    return { status: "error", error: error?.message || String(error), source: "lpagent" };
  }
}
