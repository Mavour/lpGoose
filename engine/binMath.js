/**
 * DLMM bin range helpers (ported from fee-maxi).
 */

export function drift(a, b) {
  return Math.abs(a - b);
}

export function centeredRange(activeId, halfWidth) {
  return {
    minBinId: activeId - halfWidth,
    maxBinId: activeId + halfWidth,
  };
}

export function bidRange(activeId, width) {
  return {
    minBinId: activeId - width,
    maxBinId: activeId - 1,
  };
}

export function activeBinInRange(activeId, lower, upper) {
  return activeId >= lower && activeId <= upper;
}

/**
 * @param {"both"|"upper"|"lower"} side
 */
export function isOutOfRangeDirectional(activeId, lower, upper, buffer = 0, side = "both") {
  const belowLower = activeId < lower - buffer;
  const aboveUpper = activeId > upper + buffer;
  if (side === "upper") return aboveUpper;
  if (side === "lower") return belowLower;
  return belowLower || aboveUpper;
}

export function totalBinsForVolatility(volatility, minBins, maxBins, fullRangeVol) {
  const frac =
    fullRangeVol > 0
      ? Math.min(1, Math.max(0, Number(volatility || 0) / fullRangeVol))
      : 0;
  return Math.round(minBins + frac * (maxBins - minBins));
}

export function curveHalfWidthForVolatility(volatility, minBins, maxBins, fullRangeVol) {
  return Math.max(1, Math.round(totalBinsForVolatility(volatility, minBins, maxBins, fullRangeVol) / 2));
}
