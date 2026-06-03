import { log } from "../logger.js";

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

export async function confirmSupertrendBreak({ pool_address, interval = "5m", limit = 30, period = 10, multiplier = 3 }) {
  try {
    const url = `https://dlmm.datapi.meteora.ag/pools/${pool_address}/ohlcv?timeframe=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OHLCV API ${res.status}`);

    const data = await res.json();
    const candles = Array.isArray(data) ? data : (data?.data || []);

    if (candles.length < period + 1) {
      return { confirmed: false, direction: "neutral", reason: `Not enough candles: ${candles.length} < ${period + 1}` };
    }

    const st = calcSupertrend(candles, period, multiplier);

    if (st.direction === "neutral") {
      return { confirmed: false, direction: "neutral", reason: "Insufficient data for supertrend" };
    }

    const latest = candles[candles.length - 1];

    if (st.supertrendBreakDown) {
      return { confirmed: true, direction: st.direction, reason: `Bearish break at ${latest.close.toFixed(8)}` };
    }

    if (st.direction === "bearish") {
      return { confirmed: true, direction: st.direction, reason: `Bearish trend (ST=${st.value.toFixed(8)}, price=${latest.close.toFixed(8)})` };
    }

    return {
      confirmed: false,
      direction: st.direction,
      reason: `Bullish trend (ST=${st.value.toFixed(8)}, price=${latest.close.toFixed(8)}) - wait for bearish`,
    };
  } catch (e) {
    log("screening_warn", `Supertrend API error: ${e.message}`);
    return { confirmed: false, error: e.message };
  }
}
