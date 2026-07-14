/**
 * Price regime classifier for lifecycle entry.
 * @typedef {"pump"|"downtrend"|"bottom"|"sideways"} TrendRegime
 */

function pctChange(first, last) {
  if (!first) return 0;
  return ((last - first) / first) * 100;
}

function recentSlopePct(candles, k) {
  if (!candles?.length || candles.length < 2) return 0;
  const slice = candles.slice(-Math.min(k, candles.length));
  return pctChange(slice[0].c, slice[slice.length - 1].c);
}

function sliceLookback(candles, lookback) {
  if (!candles?.length) return [];
  return candles.slice(-lookback);
}

/**
 * @param {Array<{t?:number,o:number,h:number,l:number,c:number,v?:number}>} candles
 * @param {object} cfg entry regime thresholds
 * @returns {TrendRegime}
 */
export function classify(candles, cfg) {
  const lookback = cfg.lookbackCandles ?? 48;
  const window = sliceLookback(candles, lookback);
  if (window.length < 2) return "sideways";

  const first = window[0].c;
  const last = window[window.length - 1].c;
  const pct = pctChange(first, last);

  if (pct >= (cfg.pumpPctThreshold ?? 50)) return "pump";

  const minLow = Math.min(...window.map((c) => c.l));
  const drawdown = pctChange(first, minLow);
  const slope = recentSlopePct(window, cfg.bottomSlopeCandles ?? 6);

  if (
    drawdown <= (cfg.bottomDrawdownPct ?? -40) &&
    Math.abs(slope) <= (cfg.bottomFlatSlopePct ?? 2)
  ) {
    return "bottom";
  }

  if (pct <= (cfg.downtrendPctThreshold ?? -25)) return "downtrend";

  return "sideways";
}

/** bid-ask for directional regimes; curve for mean-reversion / range. */
export function strategyForRegime(regime) {
  if (regime === "pump" || regime === "downtrend") return "bid_ask";
  return "curve";
}
