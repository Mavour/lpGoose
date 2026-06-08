import { log } from "../logger.js";

const DEFAULT_ATH_LOOKBACK = 48;
const MIN_CANDLES = 10;
const DEFAULT_MIN_DUMP_PCT = 45;
const DEFAULT_MIN_RETRACE_PCT = 5;
const DEFAULT_MIN_BASE_FEE = 2.0;
const DEFAULT_MIN_TVL = 10_000;
const DEFAULT_MAX_TVL = 150_000;
const DEFAULT_MIN_ORGANIC = 65;
const DEFAULT_RANGE_PCT = -45;
const MIN_RANGE_PCT = -55;
const MAX_RANGE_PCT = -30;
const MAX_GAS_HEAVY_BINS = 200;
const MIN_USEFUL_BINS = 20;
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const BB_PERIOD = 20;
const BB_STD_DEV = 2;

const DEFAULTS = {
  enabled: false,
  deployAmountSol: 0.3,
  minBaseFee: DEFAULT_MIN_BASE_FEE,
  minTvl: DEFAULT_MIN_TVL,
  maxTvl: DEFAULT_MAX_TVL,
  minOrganic: DEFAULT_MIN_ORGANIC,
  rangePct: DEFAULT_RANGE_PCT,
  minDumpPct: DEFAULT_MIN_DUMP_PCT,
  minRetracePct: DEFAULT_MIN_RETRACE_PCT,
  athLookbackCandles: DEFAULT_ATH_LOOKBACK,
  rsiExitThreshold: 90,
  takeProfitFeePct: 5,
  maxILPct: 25,
  minFeesToOverrideStopLoss: 8,
  outOfRangeWaitMinutes: 60,
  outOfRangeTolerance: 15,
  feesForReposition: 3,
  enableTAExit: true,
  logLevel: "verbose",
};

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function closeOf(candle) {
  return safeNumber(candle?.close ?? candle?.c ?? candle?.price);
}

function highOf(candle) {
  return safeNumber(candle?.high ?? candle?.h ?? closeOf(candle));
}

function lowOf(candle) {
  return safeNumber(candle?.low ?? candle?.l ?? closeOf(candle));
}

function feeOf(pool) {
  return safeNumber(pool?.base_fee ?? pool?.baseFee ?? pool?.fee_pct ?? pool?.feePct);
}

function tvlOf(pool) {
  return safeNumber(pool?.active_tvl ?? pool?.tvl ?? pool?.liquidity);
}

function organicOf(pool) {
  return safeNumber(pool?.organic_score ?? pool?.organicScore ?? pool?.base?.organic);
}

function poolAddressOf(pool) {
  return pool?.pool ?? pool?.pool_address ?? pool?.address ?? null;
}

function logBottom(level, message) {
  const category = level === "error" ? "bottom_spot_error"
    : level === "warn" ? "bottom_spot_warn"
    : "bottom_spot";
  log(category, message);
}

function normalizeConfig(config = {}) {
  return { ...DEFAULTS, ...(config || {}) };
}

function validCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((c) => ({
      ...c,
      close: closeOf(c),
      high: highOf(c),
      low: lowOf(c),
    }))
    .filter((c) => c.close != null && c.high != null && c.low != null);
}

export function detectDumpAndRetrace(priceHistory, config = {}) {
  try {
    const cfg = normalizeConfig(config);
    const candles = validCandles(priceHistory);
    if (candles.length < MIN_CANDLES) {
      return { triggered: false, reason: "insufficient_data" };
    }

    const lookback = Math.max(MIN_CANDLES, cfg.athLookbackCandles || DEFAULT_ATH_LOOKBACK);
    const window = candles.slice(-lookback);
    let athPrice = 0;
    let athIndex = -1;
    for (let i = 0; i < window.length; i++) {
      if (window[i].high > athPrice) {
        athPrice = window[i].high;
        athIndex = i;
      }
    }
    if (athPrice <= 0 || athIndex < 0) return { triggered: false, reason: "invalid_ath" };

    const postAth = window.slice(athIndex);
    const dumpLow = Math.min(...postAth.map((c) => c.low).filter((n) => n > 0));
    const currentPrice = window[window.length - 1].close;
    if (!Number.isFinite(dumpLow) || dumpLow <= 0 || currentPrice <= 0) {
      return { triggered: false, reason: "invalid_prices" };
    }

    const dumpPct = ((athPrice - currentPrice) / athPrice) * 100;
    const retracePct = ((currentPrice - dumpLow) / dumpLow) * 100;
    const triggered = dumpPct >= cfg.minDumpPct && retracePct >= cfg.minRetracePct;

    if (!triggered) {
      return {
        triggered: false,
        reason: dumpPct < cfg.minDumpPct ? "dump_too_small" : "retrace_too_small",
        athPrice,
        dumpLow,
        currentPrice,
        dumpPct,
        retracePct,
      };
    }

    return { triggered: true, athPrice, dumpLow, currentPrice, dumpPct, retracePct };
  } catch (err) {
    logBottom("error", `[BottomSpotLP] detectDumpAndRetrace: ${err.message}`);
    return { triggered: false, reason: "error", error: err.message };
  }
}

export function selectBestPool(pools, config = {}) {
  try {
    const cfg = normalizeConfig(config);
    if (!Array.isArray(pools) || pools.length === 0) return null;

    const accepted = [];
    for (const pool of pools) {
      const fee = feeOf(pool);
      const tvl = tvlOf(pool);
      const organic = organicOf(pool);
      const name = pool?.name || poolAddressOf(pool) || "unknown";

      if (fee == null || fee < cfg.minBaseFee) {
        logBottom("debug", `[BottomSpotLP] Reject ${name}: fee ${fee} < ${cfg.minBaseFee}`);
        continue;
      }
      if (tvl == null || tvl < cfg.minTvl) {
        logBottom("debug", `[BottomSpotLP] Reject ${name}: tvl ${tvl} < ${cfg.minTvl}`);
        continue;
      }
      if (tvl > cfg.maxTvl) {
        logBottom("debug", `[BottomSpotLP] Reject ${name}: tvl ${tvl} > ${cfg.maxTvl}`);
        continue;
      }
      if (organic == null || organic < cfg.minOrganic) {
        logBottom("debug", `[BottomSpotLP] Reject ${name}: organic ${organic} < ${cfg.minOrganic}`);
        continue;
      }
      accepted.push(pool);
    }

    return accepted.sort((a, b) => tvlOf(b) - tvlOf(a))[0] || null;
  } catch (err) {
    logBottom("error", `[BottomSpotLP] selectBestPool: ${err.message}`);
    return null;
  }
}

export function calculateBinRange(currentPrice, binStep, config = {}) {
  try {
    const cfg = normalizeConfig(config);
    const price = safeNumber(currentPrice);
    const step = safeNumber(binStep);
    if (price == null || price <= 0) return { valid: false, reason: "invalid_current_price" };
    if (step == null || step <= 0) return { valid: false, reason: "invalid_bin_step" };

    const rangePct = Math.min(MAX_RANGE_PCT, Math.max(MIN_RANGE_PCT, cfg.rangePct));
    const lowerPrice = price * (1 - Math.abs(rangePct) / 100);
    const upperPrice = price;
    if (lowerPrice <= 0 || upperPrice <= lowerPrice) {
      return { valid: false, reason: "invalid_range" };
    }

    const stepRatio = 1 + step / 10_000;
    const totalBins = Math.ceil(Math.abs(Math.log(lowerPrice / upperPrice) / Math.log(stepRatio)));
    if (totalBins > MAX_GAS_HEAVY_BINS) {
      logBottom("warn", `[BottomSpotLP] Bin range gas heavy: ${totalBins} bins`);
    } else if (totalBins < MIN_USEFUL_BINS) {
      logBottom("warn", `[BottomSpotLP] Bin range narrow: ${totalBins} bins`);
    }

    return {
      valid: true,
      lowerBinId: -totalBins,
      upperBinId: 0,
      lowerPrice,
      upperPrice,
      totalBins,
      expectedILAtLower: Math.abs(rangePct),
      shape: "spot",
      singleSidedAsset: "SOL",
    };
  } catch (err) {
    logBottom("error", `[BottomSpotLP] calculateBinRange: ${err.message}`);
    return { valid: false, reason: "error", error: err.message };
  }
}

export function calculateRSI(candles, period = RSI_PERIOD) {
  const valid = validCandles(candles);
  if (valid.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = valid[i].close - valid[i - 1].close;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < valid.length; i++) {
    const change = valid[i].close - valid[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function calculateMACD(candles) {
  const closes = validCandles(candles).map((c) => c.close);
  if (closes.length < MACD_SLOW + MACD_SIGNAL) return null;
  const fast = ema(closes, MACD_FAST);
  const slow = ema(closes, MACD_SLOW);
  const macdSeries = closes.map((_, i) =>
    fast[i] == null || slow[i] == null ? null : fast[i] - slow[i]
  );
  const compactMacd = macdSeries.filter((n) => n != null);
  const signalCompact = ema(compactMacd, MACD_SIGNAL);
  const latestSignal = signalCompact[signalCompact.length - 1];
  const prevSignal = signalCompact[signalCompact.length - 2];
  const latestMacd = compactMacd[compactMacd.length - 1];
  const prevMacd = compactMacd[compactMacd.length - 2];
  if ([latestSignal, prevSignal, latestMacd, prevMacd].some((n) => n == null)) return null;
  return {
    macd: latestMacd,
    signal: latestSignal,
    histogram: latestMacd - latestSignal,
    bullishCross: prevMacd <= prevSignal && latestMacd > latestSignal,
    bearishCross: prevMacd >= prevSignal && latestMacd < latestSignal,
  };
}

export function calculateBollingerBands(candles, period = BB_PERIOD, stdDev = BB_STD_DEV) {
  const closes = validCandles(candles).map((c) => c.close);
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((sum, n) => sum + n, 0) / period;
  const variance = slice.reduce((sum, n) => sum + Math.pow(n - mid, 2), 0) / period;
  const deviation = Math.sqrt(variance);
  const latest = closes[closes.length - 1];
  const upper = mid + stdDev * deviation;
  const lower = mid - stdDev * deviation;
  return {
    upper,
    mid,
    lower,
    breakingUpper: latest > upper,
    breakingLower: latest < lower,
  };
}

export function evaluateExitSignal(candles, position = {}, config = {}) {
  try {
    const cfg = normalizeConfig(config);
    const valid = validCandles(candles);
    if (valid.length < BB_PERIOD) {
      return { shouldExit: false, reason: null, urgency: "low", details: { insufficientData: true } };
    }

    const currentPrice = valid[valid.length - 1].close;
    const feesPct = safeNumber(position.accumulatedFeesPct ?? position.feesPct) || 0;
    const ilPct = safeNumber(position.ilPct ?? position.pnl_pct) || 0;
    const rsi = cfg.enableTAExit ? calculateRSI(valid) : null;
    const macd = cfg.enableTAExit ? calculateMACD(valid) : null;
    const bb = cfg.enableTAExit ? calculateBollingerBands(valid) : null;
    const details = { currentPrice, feesPct, ilPct, rsi, macd, bb };

    let reason = null;
    if (rsi != null && rsi > cfg.rsiExitThreshold) reason = "rsi_overbought";
    else if (macd?.bearishCross) reason = "macd_bearish_cross";
    else if (bb?.breakingUpper) reason = "bb_upper_break";
    else if (feesPct >= cfg.takeProfitFeePct) reason = "fees_target_hit";
    else if (position.upperPrice != null && currentPrice > position.upperPrice) {
      reason = "price_above_range";
    } else if (Math.abs(ilPct) > cfg.maxILPct && feesPct < cfg.minFeesToOverrideStopLoss) {
      reason = "il_stop_loss";
    }

    const high = new Set(["rsi_overbought", "price_above_range", "il_stop_loss"]);
    const medium = new Set(["macd_bearish_cross", "bb_upper_break"]);
    const urgency = high.has(reason) ? "high" : medium.has(reason) ? "medium" : "low";

    logBottom("debug", `[BottomSpotLP] TA ${JSON.stringify({ rsi, macd, bb })}`);
    return { shouldExit: !!reason, reason, urgency, details };
  } catch (err) {
    logBottom("error", `[BottomSpotLP] evaluateExitSignal: ${err.message}`);
    return { shouldExit: false, reason: "error", urgency: "low", details: { error: err.message } };
  }
}

export function handleOutOfRangeLower(position = {}, accumulatedFees = {}, config = {}) {
  try {
    const cfg = normalizeConfig(config);
    const feesPct = safeNumber(accumulatedFees.pct ?? accumulatedFees.accumulatedFeesPct) || 0;
    const minutes = safeNumber(position.minutesOutOfRange ?? position.minutes_out_of_range) || 0;
    const active = safeNumber(position.active_bin);
    const lower = safeNumber(position.lower_bin);
    const isLower = position.outOfRangeLower === true || (
      active != null && lower != null && active < lower
    );

    if (!isLower || minutes <= cfg.outOfRangeTolerance) {
      return { action: "hold", reason: "in_range" };
    }
    if (feesPct >= cfg.feesForReposition) {
      return { action: "reposition", useAccumulatedFees: true };
    }
    if (minutes < cfg.outOfRangeWaitMinutes) {
      return { action: "hold", reason: "waiting_for_rebound" };
    }
    return { action: "close", reason: "oor_timeout_exceeded" };
  } catch (err) {
    logBottom("error", `[BottomSpotLP] handleOutOfRangeLower: ${err.message}`);
    return { action: "hold", reason: "error", error: err.message };
  }
}

export class BottomSpotLPStrategy {
  constructor(config = {}) {
    this.config = normalizeConfig(config);
  }

  /**
   * Check whether dump-retrace conditions and pool filters allow deployment.
   */
  async shouldDeploy(priceHistory, pools) {
    try {
      const signal = detectDumpAndRetrace(priceHistory, this.config);
      if (!signal.triggered) return { deploy: false, reason: signal.reason, signal };

      const pool = selectBestPool(pools, this.config);
      if (!pool) return { deploy: false, reason: "no_pool_passed_filters", signal };

      const price = signal.currentPrice ?? safeNumber(pool.price);
      const binRange = calculateBinRange(price, pool.bin_step, this.config);
      if (!binRange.valid) return { deploy: false, reason: binRange.reason, signal, pool };

      logBottom("info", `[BottomSpotLP] Deploy signal ${pool.name || poolAddressOf(pool)}`);
      return { deploy: true, pool, binRange, signal, reason: "dump_retrace_confirmed" };
    } catch (err) {
      logBottom("error", `[BottomSpotLP] shouldDeploy: ${err.message}`);
      return { deploy: false, reason: "error", error: err.message };
    }
  }

  /**
   * Build deploy params for the existing DLMM wrapper.
   */
  buildDeployParams(pool, binRange, amountSol) {
    try {
      const poolAddress = poolAddressOf(pool);
      const amount = safeNumber(amountSol);
      if (!poolAddress || !binRange?.valid || amount == null || amount <= 0) {
        return { valid: false, reason: "invalid_deploy_params" };
      }
      return {
        valid: true,
        pool_address: poolAddress,
        amount_sol: amount,
        amount_y: amount,
        amount_x: 0,
        strategy: "spot",
        strategy_label: "bottom_spot_lp",
        bins_below: binRange.totalBins,
        bins_above: 0,
        pool_name: pool.name,
        bin_step: pool.bin_step,
        base_fee: feeOf(pool),
        fee_tvl_ratio: pool.fee_active_tvl_ratio,
        volatility: pool.volatility,
        organic_score: organicOf(pool),
        base_mint: pool.base?.mint,
        signal_snapshot: {
          strategy: "bottom_spot_lp",
          lowerPrice: binRange.lowerPrice,
          upperPrice: binRange.upperPrice,
          totalBins: binRange.totalBins,
        },
      };
    } catch (err) {
      logBottom("error", `[BottomSpotLP] buildDeployParams: ${err.message}`);
      return { valid: false, reason: "error", error: err.message };
    }
  }

  /**
   * Evaluate whether a Bottom Spot position should stay, close, or reposition.
   */
  async evaluatePosition(position, candles, accumulatedFees = {}) {
    try {
      const feesPct = safeNumber(accumulatedFees.pct ?? accumulatedFees.accumulatedFeesPct) || 0;
      const enriched = { ...position, accumulatedFeesPct: feesPct };
      const exit = evaluateExitSignal(candles, enriched, this.config);
      if (exit.shouldExit) {
        logBottom("info", `[BottomSpotLP] Exit decision: ${exit.reason}`);
        return { action: "close", reason: exit.reason, urgency: exit.urgency, details: exit.details };
      }
      const oor = handleOutOfRangeLower(position, accumulatedFees, this.config);
      if (oor.action !== "hold") return { ...oor, urgency: "medium" };
      return { action: "stay", reason: oor.reason, urgency: "low" };
    } catch (err) {
      logBottom("error", `[BottomSpotLP] evaluatePosition: ${err.message}`);
      return { action: "stay", reason: "error", urgency: "low", error: err.message };
    }
  }

  /**
   * Generate a compact status report for logs or Telegram.
   */
  formatStatusReport(position, candles, fees = {}) {
    try {
      const valid = validCandles(candles);
      const latest = valid[valid.length - 1]?.close;
      const rsi = calculateRSI(valid);
      return [
        `Bottom Spot LP: ${position?.pair || position?.pool_name || position?.pool || "unknown"}`,
        `Price: ${latest ?? "?"}`,
        `Range: ${position?.lowerPrice ?? position?.lower_bin ?? "?"} -> ${
          position?.upperPrice ?? position?.upper_bin ?? "?"
        }`,
        `Fees: ${fees?.pct ?? fees?.accumulatedFeesPct ?? 0}%`,
        `RSI: ${rsi == null ? "?" : rsi.toFixed(2)}`,
      ].join("\n");
    } catch (err) {
      logBottom("error", `[BottomSpotLP] formatStatusReport: ${err.message}`);
      return "Bottom Spot LP: status unavailable";
    }
  }
}
