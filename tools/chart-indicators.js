import crypto from "crypto";
import { log } from "../logger.js";

function getGMGNKey() {
  return process.env.GMGN_API_KEY || "";
}

function toGMGNResolution(interval) {
  const map = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "4h": "4h", "1d": "1d",
    "1_MINUTE": "1m", "5_MINUTE": "5m", "15_MINUTE": "15m",
    "30_MINUTE": "30m", "1_HOUR": "1h", "4_HOUR": "4h", "1_DAY": "1d",
  };
  return map[String(interval || "5m").toUpperCase().replace(/^"|"$/g, "")] || "5m";
}

function toGMGNInterval(interval) {
  const raw = String(interval || "5m").trim().toUpperCase();
  if (raw === "1M" || raw === "1_MINUTE") return "1m";
  if (raw === "5M" || raw === "5_MINUTE") return "5m";
  if (raw === "15M" || raw === "15_MINUTE") return "15m";
  if (raw === "30M" || raw === "30_MINUTE") return "30m";
  if (raw === "1H" || raw === "1_HOUR") return "1h";
  if (raw === "4H" || raw === "4_HOUR") return "4h";
  if (raw === "1D" || raw === "1_DAY") return "1d";
  return "5m";
}

async function fetchKlineGMGN(mint, interval = "5m", limit = 298) {
  const apiKey = getGMGNKey();
  if (!apiKey) throw new Error("GMGN_API_KEY not set");

  const resolution = toGMGNInterval(interval);
  const fetchLimit = Math.max(limit + 5, 105);
  const ts = Math.floor(Date.now() / 1000);
  const cid = crypto.randomUUID();
  const url = `https://openapi.gmgn.ai/v1/market/token_kline?chain=sol&address=${mint}&resolution=${resolution}&limit=${fetchLimit}&timestamp=${ts}&client_id=${cid}`;

  const res = await fetch(url, {
    headers: { "X-APIKEY": apiKey },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GMGN ${res.status}: ${text.slice(0, 80)}`);
  }

  const json = await res.json();
  if (!json?.data?.list?.length || json.data.list.length < 10) {
    throw new Error(`GMGN insufficient data: ${json?.data?.list?.length ?? 0} candles`);
  }

  return json.data.list.map((c) => ({
    time: c.time,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }))
    .filter((c) => c.close != null && !isNaN(c.close))
    .sort((a, b) => Number(a.time) - Number(b.time));
}

export function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (!candles || candles.length < period + 1) {
    return {
      value: null,
      direction: "neutral",
      previousDirection: "neutral",
      supertrendBreakUp: false,
      supertrendBreakDown: false,
      upperBand: [],
      lowerBand: [],
      directions: [],
      values: [],
    };
  }

  const tr = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }

  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  const upperBand = new Array(candles.length).fill(null);
  const lowerBand = new Array(candles.length).fill(null);
  const directions = new Array(candles.length).fill("neutral");
  const values = new Array(candles.length).fill(null);

  for (let i = period; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    if (i === period) {
      upperBand[i] = basicUpper;
      lowerBand[i] = basicLower;
      directions[i] = candles[i].close <= basicLower ? "bearish" : "bullish";
      values[i] = directions[i] === "bullish" ? lowerBand[i] : upperBand[i];
      continue;
    }

    const prevClose = candles[i - 1].close;
    if (basicUpper < upperBand[i - 1] || prevClose > upperBand[i - 1]) {
      upperBand[i] = basicUpper;
    } else {
      upperBand[i] = upperBand[i - 1];
    }

    if (basicLower > lowerBand[i - 1] || prevClose < lowerBand[i - 1]) {
      lowerBand[i] = basicLower;
    } else {
      lowerBand[i] = lowerBand[i - 1];
    }

    const previousDirection = directions[i - 1];
    const close = candles[i].close;
    if (previousDirection === "bearish" && close >= upperBand[i - 1]) {
      directions[i] = "bullish";
    } else if (previousDirection === "bullish" && close <= lowerBand[i - 1]) {
      directions[i] = "bearish";
    } else {
      directions[i] = previousDirection;
    }
    values[i] = directions[i] === "bullish" ? lowerBand[i] : upperBand[i];
  }

  const latestIndex = candles.length - 1;
  const previousIndex = latestIndex - 1;
  const direction = directions[latestIndex];
  const prevDir = directions[previousIndex] || "neutral";
  const supertrendBreakDown = prevDir === "bullish" && direction === "bearish";
  const supertrendBreakUp = prevDir === "bearish" && direction === "bullish";

  return {
    value: values[latestIndex],
    direction,
    previousDirection: prevDir,
    supertrendBreakUp,
    supertrendBreakDown,
    upperBand,
    lowerBand,
    directions,
    values,
  };
}

export async function confirmSupertrendBreak({ mint, interval = "5m", limit = 298, period = 10, multiplier = 3 }) {
  try {
    const candles = await fetchKlineGMGN(mint, interval, limit);

    if (candles.length < period + 1) {
      return { confirmed: false, direction: "neutral", reason: `Not enough candles: ${candles.length} < ${period + 1}` };
    }

    const st = calcSupertrend(candles, period, multiplier);

    if (st.direction === "neutral") {
      return { confirmed: false, direction: "neutral", reason: "Insufficient data for supertrend" };
    }

    const latest = candles[candles.length - 1];
    const previous = candles[candles.length - 2];
    const latestClose = latest.close;
    const previousClose = previous?.close ?? null;
    const signal = {
      interval,
      candleTime: latest.time,
      supertrend: st.value,
      close: latestClose,
      previousClose,
      previousDirection: st.previousDirection,
      direction: st.direction,
      supertrendBreakUp: st.supertrendBreakUp,
      supertrendBreakDown: st.supertrendBreakDown,
    };

    if (st.supertrendBreakUp) {
      return {
        confirmed: true,
        direction: st.direction,
        reason: `Bullish break ${interval} (ST=${formatPrice(st.value)}, prevClose=${formatPrice(previousClose)}, close=${formatPrice(latestClose)}, prevDir=${st.previousDirection}, dir=${st.direction})`,
        signal,
      };
    }

    if (st.direction === "bullish" && latestClose >= st.value) {
      return {
        confirmed: true,
        direction: st.direction,
        reason: `Bullish trend ${interval} (ST=${formatPrice(st.value)}, prevClose=${formatPrice(previousClose)}, close=${formatPrice(latestClose)}, prevDir=${st.previousDirection}, dir=${st.direction})`,
        signal,
      };
    }

    return {
      confirmed: false,
      direction: st.direction,
      reason: `Bearish trend ${interval} (ST=${formatPrice(st.value)}, prevClose=${formatPrice(previousClose)}, close=${formatPrice(latestClose)}, prevDir=${st.previousDirection}, dir=${st.direction}) - wait for bullish close`,
      signal,
    };
  } catch (e) {
    log("screening_warn", `GMGN supertrend error for ${mint?.slice(0, 8)}: ${e.message}`);
    return { confirmed: false, error: e.message };
  }
}

export async function confirmEntrySupertrendBreak({
  mint,
  ...options
} = {}) {
  const result = await confirmSupertrendBreak({ mint, ...options });
  return requireFreshBullishBreak(result);
}

export async function confirmExitSupertrendFlip({ mint, ...options } = {}) {
  const result = await confirmSupertrendBreak({ mint, ...options });
  return requireFreshBearishFlip(result);
}

export function requireFreshBullishBreak(result) {
  if (!result?.confirmed || result.error) return result;
  if (result.signal?.supertrendBreakUp) return result;

  return {
    ...result,
    confirmed: false,
    reason: `Bullish continuation ${result.signal?.interval || "5m"} - wait for a fresh Supertrend break`,
  };
}

export function requireFreshBearishFlip(result) {
  if (result?.error) return { triggered: false, error: result.error, reason: result.reason };
  if (result?.signal?.supertrendBreakDown) {
    return {
      triggered: true,
      direction: "bearish",
      reason: `Fresh bearish Supertrend flip ${result.signal.interval}`,
      signal: result.signal,
    };
  }

  return {
    triggered: false,
    direction: result?.direction || "neutral",
    reason: result?.signal
      ? `No fresh bearish Supertrend flip ${result.signal.interval}`
      : result?.reason || "Supertrend data unavailable",
    signal: result?.signal,
  };
}

function formatPrice(value) {
  return value == null || !Number.isFinite(Number(value)) ? "n/a" : Number(value).toFixed(8);
}
