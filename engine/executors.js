/**
 * Lifecycle executors using existing Bravonoid dlmm / wallet tools.
 * Reshape/flip/rebalance = close + reopen (SDK-safe, no position keypair secret).
 */
import { log } from "../logger.js";
import { config, computeDeployAmount } from "../config.js";
import {
  closePosition,
  deployPosition,
  getActiveBin,
  claimFees,
  getMyPositions,
} from "../tools/dlmm.js";
import { getWalletBalances, swapToken } from "../tools/wallet.js";
import {
  getTrackedPosition,
  recordRebalance,
} from "../state.js";
import {
  curveHalfWidthForVolatility,
  totalBinsForVolatility,
} from "./binMath.js";
import { PositionStatus } from "./decide.js";
import {
  initLifecycleOnDeploy,
  markLifecycleAction,
  patchLifecyclePosition,
  statusFromStrategy,
} from "./lifecycleState.js";

const WSOL = "So11111111111111111111111111111111111111112";

function lc() {
  return config.lifecycle || {};
}

function entryCfg() {
  return lc().entry || {};
}

function capitalCfg() {
  return lc().capital || {};
}

export function binsForPool(volatility) {
  const e = entryCfg();
  const minB = e.curveBinsMin ?? 35;
  const maxB = e.curveBinsMax ?? 60;
  const full = e.volatilityFullRangePct ?? 8;
  const total = totalBinsForVolatility(volatility, minB, maxB, full);
  const half = curveHalfWidthForVolatility(volatility, minB, maxB, full);
  return { total, half, bidDepth: e.bidAskRangeBins ?? total };
}

/**
 * Deploy a lifecycle position (bid_ask or curve) with explicit range.
 */
export async function executeLifecycleDeploy({
  pool,
  regime,
  strategy,
  amountSol,
  signal_snapshot = null,
  momentum = null,
}) {
  const vol = Number(pool.volatility ?? 0);
  const { total, half, bidDepth } = binsForPool(vol);
  const isBidAsk = strategy === "bid_ask";
  const bins_below = isBidAsk ? bidDepth : half;
  const bins_above = isBidAsk ? 0 : half;

  const deployParams = {
    pool_address: pool.pool || pool.pool_address,
    amount_sol: amountSol,
    amount_y: amountSol,
    strategy: isBidAsk ? "bid_ask" : "curve",
    strategy_label: "lifecycle",
    bins_below,
    bins_above,
    pool_name: pool.name || pool.pool_name,
    bin_step: pool.bin_step,
    base_fee: pool.fee_pct ?? pool.base_fee,
    volatility: pool.volatility,
    fee_tvl_ratio: pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio,
    volume: pool.volume_window ?? pool.volume,
    organic_score: pool.organic_score ?? pool.base?.organic,
    base_mint: pool.base?.mint || pool.base_mint,
    signal_snapshot,
    momentum: momentum || {
      valid: true,
      binsBelow: bins_below,
      score: 0,
      classification: regime || "lifecycle",
      latestCandleTime: new Date().toISOString(),
      priceChange5m: 0,
      volumeRatio: 1,
      selectedBand: [bins_below, bins_below],
    },
  };

  log(
    "lifecycle",
    `Deploy ${deployParams.strategy} ${pool.name || pool.pool} regime=${regime} bins=${bins_below}/${bins_above} amount=${amountSol}`,
  );

  const result = await deployPosition(deployParams, { manualRange: true });

  if (result?.success || result?.dry_run) {
    const posAddr = result.position || result.position_address || result.would_deploy?.position;
    // trackPosition is called inside deployPosition; patch lifecycle after
    if (posAddr && !result.dry_run) {
      const active = await getActiveBin({ pool_address: deployParams.pool_address }).catch(() => null);
      const activeId = active?.binId;
      initLifecycleOnDeploy(posAddr, {
        regime,
        fsmStatus: statusFromStrategy(deployParams.strategy),
        lowerBin: activeId != null ? activeId - bins_below : null,
        upperBin: activeId != null ? activeId + bins_above : (isBidAsk ? activeId - 1 : null),
        entryValueSol: amountSol,
        curveHalfWidth: half,
        lastAction: isBidAsk ? "open_bidask" : "open_curve",
      });
      // Fix bin range on tracked position if deploy stored it
      patchLifecyclePosition(posAddr, {
        bin_range: {
          min: activeId != null ? activeId - bins_below : undefined,
          max: activeId != null ? (isBidAsk ? activeId - 1 : activeId + bins_above) : undefined,
          bins_below,
          bins_above,
        },
      });
    }
  }

  return result;
}

async function closeAndWait(positionAddress, reason) {
  const result = await closePosition({ position_address: positionAddress, reason });
  // brief settle for balances
  await new Promise((r) => setTimeout(r, lc().reshape?.walletSettleMs ?? 800));
  return result;
}

/**
 * Exit: full close + optional swap base token to SOL.
 */
export async function executeExit(tracked, reason) {
  if (!tracked?.position) throw new Error("exit: no position");
  markLifecycleAction(tracked.position, "exit", reason, {
    fsm_status: PositionStatus.IDLE,
  });
  const result = await closeAndWait(tracked.position, reason);

  // Swap leftover base token → SOL
  try {
    const mint = tracked.base_mint;
    if (mint && mint !== WSOL) {
      const bal = await getWalletBalances();
      const token = (bal.tokens || []).find(
        (t) => t.mint === mint && Number(t.balance || t.ui_amount || 0) > 0,
      );
      if (token) {
        const amt = Number(token.balance ?? token.ui_amount ?? 0);
        const usd = Number(token.usd || 0);
        if (amt > 0 && usd >= 0.1) {
          await swapToken({
            input_mint: mint,
            output_mint: WSOL,
            amount: amt,
          }).catch((e) => log("lifecycle_warn", `post-exit swap: ${e.message}`));
        }
      }
    }
  } catch (e) {
    log("lifecycle_warn", `post-exit cleanup: ${e.message}`);
  }

  return result;
}

/**
 * Flip bid-ask → curve: close, redeploy curve with same capital on same pool.
 */
export async function executeFlip(tracked, livePosition) {
  const reason = "lifecycle:flip_to_curve";
  markLifecycleAction(tracked.position, "flip", reason, {
    fsm_status: PositionStatus.REOPENING,
    reopen_target: "curve",
  });

  const amountSol =
    Number(tracked.amount_sol) ||
    Number(tracked.entry_value_sol) ||
    capitalCfg().perPositionSol ||
    config.management.deployAmountSol;

  const oldPos = tracked.position;
  await closeAndWait(oldPos, reason);

  // Prefer token bag + SOL for curve; amount_sol drives SOL side
  const bal = await getWalletBalances();
  const solBal = Number(bal.sol || 0);
  const gas = config.management.gasReserve ?? 0.05;
  const deploySol = Math.min(amountSol, Math.max(0, solBal - gas));

  const pool = {
    pool: tracked.pool,
    name: tracked.pool_name,
    pool_name: tracked.pool_name,
    bin_step: tracked.bin_step,
    volatility: tracked.volatility,
    fee_active_tvl_ratio: tracked.fee_tvl_ratio,
    organic_score: tracked.organic_score,
    base: { mint: tracked.base_mint },
    base_mint: tracked.base_mint,
  };

  const result = await executeLifecycleDeploy({
    pool,
    regime: tracked.entry_regime || "flip",
    strategy: "curve",
    amountSol: deploySol > 0.01 ? deploySol : amountSol,
    signal_snapshot: tracked.signal_snapshot,
  });

  if (result?.position || result?.position_address) {
    const newPos = result.position || result.position_address;
    recordRebalance(oldPos, newPos);
    patchLifecyclePosition(newPos, {
      fsm_status: PositionStatus.CURVE_ACTIVE,
      last_lifecycle_action: "flip",
      last_lifecycle_reason: reason,
      cumulative_entry_sol: tracked.cumulative_entry_sol ?? tracked.entry_value_sol ?? amountSol,
      entry_value_sol: tracked.entry_value_sol ?? amountSol,
      entry_ts_ms: tracked.entry_ts_ms || Date.now(),
      last_rebalance_ts: Date.now(),
    });
  }

  return result;
}

/**
 * Reshape: claim + close + reopen curve centered (approx fee-maxi reshape).
 */
export async function executeReshape(tracked, livePosition) {
  const reason = "lifecycle:reshape";
  if (lc().reshape?.claimEach !== false) {
    try {
      await claimFees({ position_address: tracked.position });
    } catch (e) {
      log("lifecycle_warn", `reshape claim: ${e.message}`);
    }
  }

  markLifecycleAction(tracked.position, "reshape", reason, {
    fsm_status: PositionStatus.RESHAPE_PENDING_READD,
  });

  const amountSol =
    Number(tracked.amount_sol) ||
    Number(tracked.entry_value_sol) ||
    config.management.deployAmountSol;
  const oldPos = tracked.position;
  const activeId = livePosition?.active_bin ?? null;

  await closeAndWait(oldPos, reason);

  const bal = await getWalletBalances();
  const solBal = Number(bal.sol || 0);
  const gas = config.management.gasReserve ?? 0.05;
  const deploySol = Math.min(amountSol, Math.max(0, solBal - gas));

  const pool = {
    pool: tracked.pool,
    name: tracked.pool_name,
    bin_step: tracked.bin_step,
    volatility: tracked.volatility,
    fee_active_tvl_ratio: tracked.fee_tvl_ratio,
    organic_score: tracked.organic_score,
    base: { mint: tracked.base_mint },
    base_mint: tracked.base_mint,
  };

  const result = await executeLifecycleDeploy({
    pool,
    regime: tracked.entry_regime || "reshape",
    strategy: "curve",
    amountSol: deploySol > 0.01 ? deploySol : amountSol,
  });

  if (result?.position || result?.position_address) {
    const newPos = result.position || result.position_address;
    recordRebalance(oldPos, newPos);
    patchLifecyclePosition(newPos, {
      fsm_status: PositionStatus.CURVE_ACTIVE,
      last_reshape_bin: activeId,
      last_reshape_ts: Date.now(),
      last_lifecycle_action: "reshape",
      cumulative_entry_sol: tracked.cumulative_entry_sol ?? amountSol,
      entry_value_sol: tracked.entry_value_sol ?? amountSol,
      entry_ts_ms: tracked.entry_ts_ms || Date.now(),
    });
  }

  return result;
}

/**
 * Rebalance OOR or bid-ask pump: close, optionally swap to SOL, reopen same shape.
 */
export async function executeRebalance(tracked, livePosition, reason = "lifecycle:rebalance") {
  const isBidAsk =
    (tracked.fsm_status || tracked.strategy) === "bid_ask" ||
    tracked.fsm_status === PositionStatus.BIDASK_OPEN ||
    tracked.reopen_target === "bidask";

  markLifecycleAction(tracked.position, "rebalance", reason, {
    fsm_status: PositionStatus.REOPENING,
    reopen_target: isBidAsk ? "bidask" : "curve",
  });

  const amountSol =
    Number(tracked.amount_sol) ||
    Number(tracked.entry_value_sol) ||
    config.management.deployAmountSol;
  const oldPos = tracked.position;

  await closeAndWait(oldPos, reason);

  // Pump follow / bid-ask rebalance: dump token → SOL first
  if (isBidAsk && tracked.base_mint) {
    try {
      const bal0 = await getWalletBalances();
      const token = (bal0.tokens || []).find((t) => t.mint === tracked.base_mint);
      const amt = Number(token?.balance ?? token?.ui_amount ?? 0);
      if (amt > 0) {
        await swapToken({
          input_mint: tracked.base_mint,
          output_mint: WSOL,
          amount: amt,
        });
      }
    } catch (e) {
      log("lifecycle_warn", `rebalance swap: ${e.message}`);
    }
  }

  const bal = await getWalletBalances();
  const solBal = Number(bal.sol || 0);
  const gas = config.management.gasReserve ?? 0.05;
  const deploySol = Math.min(amountSol, Math.max(0, solBal - gas));

  const pool = {
    pool: tracked.pool,
    name: tracked.pool_name,
    bin_step: tracked.bin_step,
    volatility: tracked.volatility,
    fee_active_tvl_ratio: tracked.fee_tvl_ratio,
    organic_score: tracked.organic_score,
    base: { mint: tracked.base_mint },
    base_mint: tracked.base_mint,
  };

  const strategy = isBidAsk ? "bid_ask" : "curve";
  const result = await executeLifecycleDeploy({
    pool,
    regime: tracked.entry_regime || "rebalance",
    strategy,
    amountSol: deploySol > 0.01 ? deploySol : amountSol,
  });

  if (result?.position || result?.position_address) {
    const newPos = result.position || result.position_address;
    recordRebalance(oldPos, newPos);
    const active = await getActiveBin({ pool_address: tracked.pool }).catch(() => null);
    patchLifecyclePosition(newPos, {
      fsm_status: statusFromStrategy(strategy),
      last_rebalance_ts: Date.now(),
      last_reshape_bin: active?.binId ?? null,
      last_reshape_ts: Date.now(),
      last_lifecycle_action: "rebalance",
      last_lifecycle_reason: reason,
      cumulative_entry_sol: tracked.cumulative_entry_sol ?? amountSol,
      entry_value_sol: tracked.entry_value_sol ?? amountSol,
      entry_ts_ms: tracked.entry_ts_ms || Date.now(),
      reopen_target: null,
    });
  }

  return result;
}

/**
 * Compute token value share from live position (token / total).
 */
export function computeTokenShare(livePosition) {
  if (!livePosition) return null;
  const tokenUsd = Number(
    livePosition.token_x_usd ??
    livePosition.base_value_usd ??
    livePosition.amount_x_usd ??
    NaN,
  );
  const totalUsd = Number(
    livePosition.total_value_true_usd ??
    livePosition.total_value_usd ??
    NaN,
  );
  if (Number.isFinite(tokenUsd) && Number.isFinite(totalUsd) && totalUsd > 0) {
    return tokenUsd / totalUsd;
  }
  // SOL-mode: use sol amounts if present
  const tokenSol = Number(livePosition.token_x_sol ?? livePosition.base_amount_sol ?? NaN);
  const totalSol = Number(livePosition.total_value_sol ?? livePosition.position_value_sol ?? NaN);
  if (Number.isFinite(tokenSol) && Number.isFinite(totalSol) && totalSol > 0) {
    return tokenSol / totalSol;
  }
  return null;
}

/**
 * Cumulative PnL % vs entry_value_sol (or amount_sol).
 */
export function computeCumulativePnlPct(tracked, livePosition) {
  const entry =
    Number(tracked?.cumulative_entry_sol) ||
    Number(tracked?.entry_value_sol) ||
    Number(tracked?.amount_sol) ||
    0;
  if (!(entry > 0)) {
    return {
      pnlPct: livePosition?.pnl_pct ?? null,
      pnlPctLoss: livePosition?.pnl_pct ?? null,
    };
  }

  // Prefer position PnL in SOL if available
  let currentSol = null;
  if (livePosition?.total_value_sol != null) {
    currentSol = Number(livePosition.total_value_sol) + Number(livePosition.unclaimed_fees_sol || 0);
  } else if (livePosition?.pnl_sol != null && Number.isFinite(Number(livePosition.pnl_sol))) {
    // pnl_sol is already net of entry in many paths — reconstruct value
    currentSol = entry + Number(livePosition.pnl_sol);
  } else if (livePosition?.pnl_pct != null) {
    return {
      pnlPct: Number(livePosition.pnl_pct),
      pnlPctLoss: Number(livePosition.pnl_pct),
    };
  }

  if (currentSol == null || !Number.isFinite(currentSol)) {
    return {
      pnlPct: livePosition?.pnl_pct ?? null,
      pnlPctLoss: livePosition?.pnl_pct ?? null,
    };
  }

  const pct = ((currentSol - entry) / entry) * 100;
  return { pnlPct: pct, pnlPctLoss: pct };
}

export function resolveDeployAmount() {
  const fixed = capitalCfg().perPositionSol;
  if (fixed != null && fixed > 0) return fixed;
  return config.management.deployAmountSol;
}

export async function resolveDeployAmountFromWallet() {
  const bal = await getWalletBalances();
  const fixed = capitalCfg().perPositionSol;
  if (fixed != null && fixed > 0) {
    return Math.min(fixed, computeDeployAmount(bal.sol));
  }
  return computeDeployAmount(bal.sol);
}

export async function refreshLivePosition(positionAddress) {
  const result = await getMyPositions({ force: true, silent: true, liveOnly: true });
  const live = (result?.positions || []).find((p) => p.position === positionAddress);
  return { live, all: result };
}

export function getTrackedOrThrow(positionAddress) {
  const t = getTrackedPosition(positionAddress);
  if (!t || t.closed) throw new Error(`position gone: ${positionAddress}`);
  return t;
}
