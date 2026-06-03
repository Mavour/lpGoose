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
  })).filter((c) => c.close != null && !isNaN(c.close));
}

export function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (!candles || candles.length < period + 1) {
    return { value: null, direction: "neutral", supertrendBreakUp: false, supertrendBreakDown: false };
  }

  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const atr = [];
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  atr.push(sum / period);
  for (let i = period; i < tr.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
  }

  const hl2 = candles.slice(1).map(c => (c.high + c.low) / 2);
  const basicUpper = [];
  const basicLower = [];
  for (let i = 0; i < atr.length; i++) {
    basicUpper.push(hl2[i] + multiplier * atr[i]);
    basicLower.push(hl2[i] - multiplier * atr[i]);
  }

  const upperBand = [basicUpper[0]];
  const lowerBand = [basicLower[0]];
  let direction = candles[1].close <= basicLower[0] ? "bearish" : "bullish";

  for (let i = 1; i < basicUpper.length; i++) {
    const prevClose = candles[i].close;

    if (basicUpper[i] < upperBand[i - 1] || prevClose > upperBand[i - 1]) {
      upperBand.push(basicUpper[i]);
    } else {
      upperBand.push(upperBand[i - 1]);
    }

    if (basicLower[i] > lowerBand[i - 1] || prevClose < lowerBand[i - 1]) {
      lowerBand.push(basicLower[i]);
    } else {
      lowerBand.push(lowerBand[i - 1]);
    }

    if (prevClose <= lowerBand[i - 1]) {
      direction = "bearish";
    } else if (prevClose >= upperBand[i - 1]) {
      direction = "bullish";
    }
  }

  const prevDir = candles[candles.length - 2].close <= lowerBand[lowerBand.length - 2] ? "bearish" : "bullish";
  const supertrendBreakDown = prevDir === "bullish" && direction === "bearish";
  const supertrendBreakUp = prevDir === "bearish" && direction === "bullish";

  return {
    value: direction === "bullish" ? lowerBand[lowerBand.length - 1] : upperBand[upperBand.length - 1],
    direction,
    supertrendBreakUp,
    supertrendBreakDown,
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

    if (st.supertrendBreakUp) {
      return { confirmed: true, direction: st.direction, reason: `Bullish break at ${latest.close.toFixed(8)}` };
    }

    if (st.direction === "bullish") {
      return { confirmed: true, direction: st.direction, reason: `Bullish trend (ST=${st.value.toFixed(8)}, price=${latest.close.toFixed(8)})` };
    }

    return {
      confirmed: false,
      direction: st.direction,
      reason: `Bearish trend (ST=${st.value.toFixed(8)}, price=${latest.close.toFixed(8)}) - wait for bullish`,
    };
  } catch (e) {
    log("screening_warn", `GMGN supertrend error for ${mint?.slice(0, 8)}: ${e.message}`);
    return { confirmed: false, error: e.message };
  }
}
