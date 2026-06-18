function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function scoreVolatility(volatility) {
  const value = Number(volatility);
  if (!Number.isFinite(value)) return 0;
  if (value >= 1.5 && value < 3) return 40;
  if (value >= 4 && value < 5) return 36;
  if (value >= 3 && value < 4) return 28;
  if (value < 1.5) return 25;
  if (value >= 5 && value < 6) return 15;
  if (value >= 6 && value < 8) return 5;
  return 10;
}

export function scoreFeeActiveTvl(feeActiveTvlRatio) {
  const value = numberOrZero(feeActiveTvlRatio);
  return Math.max(0, Math.min(40, Math.round(value * 100)));
}

export function scoreSmartWallets(smartWalletResult, maxAgeMinutes = 60) {
  const recent = (smartWalletResult?.in_pool || []).filter((wallet) => {
    const age = Number(wallet.age_minutes);
    return Number.isFinite(age) && age >= 0 && age <= maxAgeMinutes;
  });

  return {
    score: recent.length >= 2 ? 20 : recent.length === 1 ? 15 : 0,
    recent,
  };
}

export function calculateConfidence(pool, smartWalletResult, options = {}) {
  const maxAgeMinutes = options.smartWalletMaxAgeMinutes ?? 60;
  const volatilityScore = scoreVolatility(pool?.volatility);
  const feeScore = scoreFeeActiveTvl(pool?.fee_active_tvl_ratio);
  const smartWallets = scoreSmartWallets(smartWalletResult, maxAgeMinutes);

  return {
    total: volatilityScore + feeScore + smartWallets.score,
    volatility_score: volatilityScore,
    fee_active_tvl_score: feeScore,
    smart_wallet_score: smartWallets.score,
    recent_smart_wallets: smartWallets.recent,
  };
}

export function getConfidenceSizing(confidence, baseAmount, options = {}) {
  const enabled = options.enabled ?? true;
  const fullThreshold = options.fullThreshold ?? 70;
  const skipThreshold = options.skipThreshold ?? 40;
  const halfMultiplier = options.halfMultiplier ?? 0.5;
  const amount = numberOrZero(baseAmount);

  if (!enabled) {
    return { action: "full", multiplier: 1, amount: Number(amount.toFixed(4)) };
  }
  if (confidence < skipThreshold) {
    return { action: "skip", multiplier: 0, amount: 0 };
  }

  const multiplier = confidence >= fullThreshold ? 1 : halfMultiplier;
  return {
    action: multiplier === 1 ? "full" : "half",
    multiplier,
    amount: Number((amount * multiplier).toFixed(4)),
  };
}

export function rankConfidenceCandidates(candidates, options = {}) {
  const scored = candidates.map((candidate) => ({
    ...candidate,
    confidence: calculateConfidence(candidate.pool, candidate.sw, options),
  }));

  return scored.sort((a, b) => {
    if (options.enabled === false) {
      return (b.pool?.fee_active_tvl_ratio ?? 0) - (a.pool?.fee_active_tvl_ratio ?? 0);
    }
    return b.confidence.total - a.confidence.total ||
      (b.pool?.fee_active_tvl_ratio ?? 0) - (a.pool?.fee_active_tvl_ratio ?? 0);
  });
}

export function selectBestConfidenceCandidate(candidates, options = {}) {
  return rankConfidenceCandidates(candidates, options)[0] || null;
}

export async function runRankedCandidateAttempts(candidates, attemptCandidate) {
  const infrastructureSkips = [];

  for (const candidate of candidates) {
    const attempt = await attemptCandidate(candidate);
    if (attempt.status === "non_refundable_bin_cost") {
      infrastructureSkips.push({
        pool: candidate.pool?.name,
        address: candidate.pool?.pool,
        avoided_cost_sol: attempt.deployResult?.avoided_cost_sol ?? 0,
      });
      continue;
    }
    if (attempt.status === "failed") {
      return { selectedAttempt: null, failedAttempt: attempt, infrastructureSkips };
    }
    return { selectedAttempt: attempt, failedAttempt: null, infrastructureSkips };
  }

  return { selectedAttempt: null, failedAttempt: null, infrastructureSkips };
}

export function getMinimumConfidenceDeployAmount(baseAmount, options = {}) {
  const multiplier = options.enabled === false ? 1 : (options.halfMultiplier ?? 0.5);
  return Math.max(0.01, Number((numberOrZero(baseAmount) * multiplier).toFixed(4)));
}
