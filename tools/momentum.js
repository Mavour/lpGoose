import { log } from "../logger.js";
import { closedCandlesOnly, fetchKlineGMGN } from "./chart-indicators.js";

const FIVE_MINUTES_MS = 5 * 60_000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function candleTimeMs(time) {
  const value = Number(time);
  if (!Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function invalid(reason, details = {}) {
  return { ...details, valid: false, reason };
}

export function validateMomentumCandles(candles, {
  now = Date.now(),
  maxCandleAgeMinutes = 10,
} = {}) {
  if (!Array.isArray(candles)) return invalid("candles_not_array");

  const closed = closedCandlesOnly(candles, "5m", now);
  if (closed.length < 12) {
    return invalid("insufficient_closed_candles", {
      candleCount: candles.length,
      closedCount: closed.length,
    });
  }

  const window = closed.slice(-12);
  const normalized = [];
  for (const candle of window) {
    const timeMs = candleTimeMs(candle?.time);
    const open = Number(candle?.open);
    const high = Number(candle?.high);
    const low = Number(candle?.low);
    const close = Number(candle?.close);
    const volume = Number(candle?.volume);
    if (
      timeMs == null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0
    ) {
      return invalid("malformed_candle", {
        candleCount: candles.length,
        closedCount: closed.length,
      });
    }
    normalized.push({ time: candle.time, timeMs, open, high, low, close, volume });
  }

  for (let i = 1; i < normalized.length; i++) {
    const delta = normalized[i].timeMs - normalized[i - 1].timeMs;
    if (delta === 0) {
      return invalid("duplicate_candle_timestamp", {
        candleCount: candles.length,
        closedCount: closed.length,
      });
    }
    if (delta !== FIVE_MINUTES_MS) {
      return invalid("candle_gap", {
        candleCount: candles.length,
        closedCount: closed.length,
        gapMinutes: delta / 60_000,
      });
    }
  }

  const latest = normalized.at(-1);
  const latestCloseTimeMs = latest.timeMs + FIVE_MINUTES_MS;
  const candleAgeMinutes = (now - latestCloseTimeMs) / 60_000;
  if (candleAgeMinutes < 0 || candleAgeMinutes > maxCandleAgeMinutes) {
    return invalid("stale_candle", {
      candleCount: candles.length,
      closedCount: closed.length,
      latestCandleTime: new Date(latest.timeMs).toISOString(),
      candleAgeMinutes,
    });
  }

  return {
    valid: true,
    candles: normalized,
    candleCount: candles.length,
    closedCount: closed.length,
    latestCandleTime: new Date(latest.timeMs).toISOString(),
    candleAgeMinutes,
  };
}

export function calculateMomentum({
  candles,
  feeActiveTvlRatio,
  minFeeActiveTvlRatio,
  volatility,
  volumeChangePct = null,
  strongThreshold = 70,
  strongMinBins = 40,
  strongMaxBins = 70,
  weakMinBins = 70,
  weakMaxBins = 150,
  tokenAgeHours = null,
  ageBands = null,
  maxCandleAgeMinutes = 10,
  now = Date.now(),
} = {}) {
  const validated = validateMomentumCandles(candles, { now, maxCandleAgeMinutes });
  if (!validated.valid) return validated;

  const feeTvl = Number(feeActiveTvlRatio);
  const feeMinimum = Number(minFeeActiveTvlRatio);
  const volatilityValue = Number(volatility);
  if (!Number.isFinite(feeTvl) || !Number.isFinite(feeMinimum)) {
    return invalid("invalid_fee_active_tvl_ratio", validated);
  }
  if (!Number.isFinite(volatilityValue) || volatilityValue < 0) {
    return invalid("invalid_volatility", validated);
  }

  const latest = validated.candles.at(-1);
  const previous = validated.candles.at(-2);
  const baselineVolumes = validated.candles.slice(0, -1).map((candle) => candle.volume);
  const baselineMedianVolume = median(baselineVolumes);
  if (!Number.isFinite(baselineMedianVolume) || baselineMedianVolume <= 0) {
    return invalid("zero_volume_baseline", {
      ...validated,
      latestVolume: latest.volume,
      baselineMedianVolume,
    });
  }

  const priceChange5m = ((latest.close / previous.close) - 1) * 100;
  const priceScore = clamp(priceChange5m, 0, 40);
  const priceVelocityScore = clamp(priceChange5m * 2, 0, 30);
  const volumeRatio = latest.volume / baselineMedianVolume;
  const volumeTrendPct = volumeChangePct == null ? null : Number(volumeChangePct);
  const volumeAccelerating = Number.isFinite(volumeTrendPct)
    ? volumeTrendPct > 10
    : volumeRatio >= 1.5;
  const volumeScore = volumeAccelerating ? 30 : 0;
  const feeScore = clamp(feeTvl * 100, 0, 30);
  const scoreFactors = [priceScore, volumeScore, feeScore, priceVelocityScore];
  const score = Math.round(
    scoreFactors.reduce((sum, value) => sum + value, 0) * (3 / scoreFactors.length),
  );
  const classification = score >= strongThreshold ? "strong" : "weak";
  const volatilityFactor = clamp(volatilityValue / 5, 0, 1);
  const ageBand = selectAgeBand(tokenAgeHours, ageBands);
  const selectedBand = ageBand?.band || (classification === "strong"
    ? [strongMinBins, strongMaxBins]
    : [weakMinBins, weakMaxBins]);
  const binsBelow = Math.round(
    selectedBand[0] + volatilityFactor * (selectedBand[1] - selectedBand[0]),
  );

  return {
    valid: true,
    score,
    classification,
    binsBelow: clamp(binsBelow, selectedBand[0], selectedBand[1]),
    selectedBand,
    ageBand: ageBand?.name || null,
    tokenAgeHours: Number.isFinite(Number(tokenAgeHours)) ? Number(tokenAgeHours) : null,
    priceChange5m,
    volumeChangePct: Number.isFinite(volumeTrendPct) ? volumeTrendPct : null,
    volumeAccelerating,
    volumeRatio,
    priceScore,
    priceVelocityScore,
    volumeScore,
    feeScore,
    feeActiveTvlRatio: feeTvl,
    minFeeActiveTvlRatio: feeMinimum,
    strongThreshold,
    strongBand: [strongMinBins, strongMaxBins],
    weakBand: [weakMinBins, weakMaxBins],
    volatility: volatilityValue,
    volatilityFactor,
    latestClose: latest.close,
    previousClose: previous.close,
    latestVolume: latest.volume,
    baselineMedianVolume,
    candleCount: validated.candleCount,
    closedCount: validated.closedCount,
    latestCandleTime: validated.latestCandleTime,
    candleAgeMinutes: validated.candleAgeMinutes,
    candles: validated.candles,
    reason: "momentum_calculated",
  };
}

export function calculateWeakMomentumFallback({
  validatedCandles,
  volatility,
  weakMinBins = 70,
  weakMaxBins = 150,
  tokenAgeHours = null,
  ageBands = null,
  reason = "momentum_scoring_unavailable",
} = {}) {
  if (!validatedCandles?.valid || !Array.isArray(validatedCandles.candles)) {
    return invalid("fallback_requires_valid_candles");
  }
  const volatilityValue = Number(volatility);
  const volatilityFactor = Number.isFinite(volatilityValue) && volatilityValue >= 0
    ? clamp(volatilityValue / 5, 0, 1)
    : 1;
  const ageBand = selectAgeBand(tokenAgeHours, ageBands);
  const selectedBand = ageBand?.band || [weakMinBins, weakMaxBins];
  const binsBelow = Math.round(
    selectedBand[0] + volatilityFactor * (selectedBand[1] - selectedBand[0]),
  );
  const latest = validatedCandles.candles.at(-1);
  const previous = validatedCandles.candles.at(-2);

  return {
    valid: true,
    score: null,
    classification: "fallback_weak",
    binsBelow: clamp(binsBelow, selectedBand[0], selectedBand[1]),
    selectedBand,
    ageBand: ageBand?.name || null,
    tokenAgeHours: Number.isFinite(Number(tokenAgeHours)) ? Number(tokenAgeHours) : null,
    priceChange5m: previous?.close > 0
      ? ((latest.close / previous.close) - 1) * 100
      : null,
    volumeRatio: null,
    priceScore: null,
    volumeScore: null,
    feeScore: null,
    feeActiveTvlRatio: null,
    minFeeActiveTvlRatio: null,
    strongThreshold: null,
    strongBand: null,
    weakBand: [weakMinBins, weakMaxBins],
    volatility: Number.isFinite(volatilityValue) ? volatilityValue : null,
    volatilityFactor,
    latestClose: latest?.close ?? null,
    previousClose: previous?.close ?? null,
    latestVolume: latest?.volume ?? null,
    baselineMedianVolume: null,
    candleCount: validatedCandles.candleCount,
    closedCount: validatedCandles.closedCount,
    latestCandleTime: validatedCandles.latestCandleTime,
    candleAgeMinutes: validatedCandles.candleAgeMinutes,
    candles: validatedCandles.candles,
    fallback: true,
    reason,
  };
}

export function selectAgeBand(tokenAgeHours, ageBands) {
  const age = Number(tokenAgeHours);
  if (!Number.isFinite(age) || age < 0 || !ageBands) return null;

  const bands = [
    ["new", ageBands.newMaxHours, ageBands.newMinBins, ageBands.newMaxBins],
    ["young", ageBands.youngMaxHours, ageBands.youngMinBins, ageBands.youngMaxBins],
    ["mature", ageBands.matureMaxHours, ageBands.matureMinBins, ageBands.matureMaxBins],
    ["old", Infinity, ageBands.oldMinBins, ageBands.oldMaxBins],
  ];
  const match = bands.find(([, maxHours]) => age < Number(maxHours));
  const minBins = Number(match?.[2]);
  const maxBins = Number(match?.[3]);
  if (!match || !Number.isFinite(minBins) || !Number.isFinite(maxBins) || minBins > maxBins) {
    return null;
  }
  return { name: match[0], band: [minBins, maxBins] };
}

function classifyFetchError(error) {
  const message = error?.message || String(error);
  if (/\b401\b|\b403\b|api_key not set|api token not set/i.test(message)) return "auth_error";
  if (/\b429\b/.test(message)) return "rate_limited";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/json/i.test(message)) return "malformed_json";
  if (/insufficient/i.test(message)) return "insufficient_candles";
  return "fetch_error";
}

export async function fetchMomentumCandles({
  mint,
  maxRetries = 2,
  retryDelayMs = 500,
  fetchCandles = fetchKlineGMGN,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const totalAttempts = maxRetries + 1;
  let lastError = null;
  let finalAttempt = 0;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    finalAttempt = attempt;
    try {
      const candles = await fetchCandles(mint, "5m", 20);
      return { success: true, candles, attempt, totalAttempts };
    } catch (error) {
      lastError = error;
      const errorType = classifyFetchError(error);
      log(
        "momentum_warn",
        `mint=${mint || "?"} gmgn_attempt=${attempt}/${totalAttempts} error_type=${errorType} error=${error.message}`,
      );
      if (["auth_error", "malformed_json"].includes(errorType)) break;
      if (attempt < totalAttempts) await sleep(retryDelayMs * attempt);
    }
  }
  return {
    success: false,
    attempt: finalAttempt,
    totalAttempts,
    errorType: classifyFetchError(lastError),
    error: lastError?.message || "unknown GMGN error",
  };
}

export function formatMomentumLog({
  pool,
  mint,
  result,
  gmgnAttempt,
  poolFeesSol,
  poolFeesSource,
  feeTimeframe,
  decision,
  reason,
}) {
  const value = (input, digits = 4) => Number.isFinite(Number(input))
    ? Number(input).toFixed(digits)
    : "?";
  return [
    `pool=${pool || "?"}`,
    `mint=${mint || "?"}`,
    `gmgn_attempt=${gmgnAttempt ?? "?"}`,
    `candle_count=${result?.candleCount ?? "?"}`,
    `closed_count=${result?.closedCount ?? "?"}`,
    `latest_candle_time=${result?.latestCandleTime ?? "?"}`,
    `candle_age_minutes=${value(result?.candleAgeMinutes, 2)}`,
    `latest_close=${value(result?.latestClose, 10)}`,
    `previous_close=${value(result?.previousClose, 10)}`,
    `price_change_5m=${value(result?.priceChange5m, 2)}%`,
    `latest_volume=${value(result?.latestVolume, 2)}`,
    `baseline_median_volume=${value(result?.baselineMedianVolume, 2)}`,
    `volume_ratio=${value(result?.volumeRatio, 2)}x`,
    `volume_change_pct=${value(result?.volumeChangePct, 2)}%`,
    `volume_accelerating=${result?.volumeAccelerating ?? "?"}`,
    `fee_active_tvl_ratio=${value(result?.feeActiveTvlRatio, 4)}%`,
    `min_fee_active_tvl_ratio=${value(result?.minFeeActiveTvlRatio, 4)}%`,
    `fee_score=${value(result?.feeScore, 2)}`,
    `pool_fees_sol=${value(poolFeesSol, 2)}`,
    `pool_fees_source=${poolFeesSource || "?"}`,
    `fee_timeframe=${feeTimeframe || "?"}`,
    `price_score=${value(result?.priceScore, 2)}`,
    `price_velocity_score=${value(result?.priceVelocityScore, 2)}`,
    `volume_score=${value(result?.volumeScore, 2)}`,
    `total_score=${result?.score ?? "?"}`,
    `strong_threshold=${result?.strongThreshold ?? "?"}`,
    `classification=${result?.classification ?? "?"}`,
    `token_age_hours=${value(result?.tokenAgeHours, 1)}`,
    `age_band=${result?.ageBand ?? "?"}`,
    `volatility=${value(result?.volatility, 2)}`,
    `volatility_factor=${value(result?.volatilityFactor, 2)}`,
    `strong_band=${result?.strongBand?.join("-") ?? "?"}`,
    `weak_band=${result?.weakBand?.join("-") ?? "?"}`,
    `selected_band=${result?.selectedBand?.join("-") ?? "?"}`,
    `final_bins_below=${result?.binsBelow ?? "?"}`,
    `decision=${decision}`,
    `reason=${reason || result?.reason || "?"}`,
  ].join(" | ");
}
