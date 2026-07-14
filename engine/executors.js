/**
 * Lifecycle executors — fee-maxi style:
 * - reshape: remove liquidity, re-add Curve to SAME position + range
 * - flip: remove+close bid-ask, open new centered curve from wallet delta
 * - rebalance: remove+close, reopen bid-ask or curve recentered
 */
import { log } from "../logger.js";
import { config, computeDeployAmount } from "../config.js";
import {
  closePosition,
  deployPosition,
  getActiveBin,
  getMyPositions,
} from "../tools/dlmm.js";
import { getWalletBalances, swapToken } from "../tools/wallet.js";
import {
  getTrackedPosition,
  recordRebalance,
  trackPosition,
} from "../state.js";
import {
  bidRange,
  centeredRange,
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
import * as ops from "./dlmmOps.js";

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
function reshapeCfg() {
  return lc().reshape || {};
}
function safetyBps() {
  return reshapeCfg().depositSafetyBps ?? 9950;
}
function slipPct() {
  return entryCfg().lpSlippagePct ?? 1;
}
function settleMs() {
  return reshapeCfg().walletSettleMs ?? 800;
}
function minReserve() {
  return capitalCfg().minSolReserve ?? config.management.gasReserve ?? 0.05;
}
function feeBuf() {
  return capitalCfg().txFeeBufferSol ?? 0.005;
}
function newPosOverhead() {
  return capitalCfg().newPositionOverheadSol ?? 0.012;
}

export function binsForPool(volatility) {
  const e = entryCfg();
  const minB = e.curveBinsMin ?? 35;
  const maxB = e.curveBinsMax ?? 60;
  const full = e.volatilityFullRangePct ?? 8;
  const total = totalBinsForVolatility(volatility, minB, maxB, full);
  const half = curveHalfWidthForVolatility(volatility, minB, maxB, full);
  return { total, half, bidDepth: e.bidAskRangeBins ?? Math.min(total, 25) };
}

function lowerUpper(tracked, live) {
  const lower =
    live?.lower_bin ??
    tracked?.bin_range?.min ??
    null;
  const upper =
    live?.upper_bin ??
    tracked?.bin_range?.max ??
    null;
  return { lower, upper };
}

/**
 * Register a newly opened position from dlmmOps into state.json.
 */
function trackOpened({
  opened,
  tracked,
  strategy,
  fsmStatus,
  amountSol,
  extra = {},
}) {
  const pos = opened.position;
  trackPosition({
    position: pos,
    pool: tracked.pool,
    pool_name: tracked.pool_name,
    strategy,
    bin_range: {
      min: opened.lowerBin,
      max: opened.upperBin,
      bins_below:
        strategy === "bid_ask"
          ? opened.upperBin - opened.lowerBin + 1
          : Math.round((opened.upperBin - opened.lowerBin) / 2),
      bins_above: strategy === "bid_ask" ? 0 : Math.round((opened.upperBin - opened.lowerBin) / 2),
    },
    amount_sol: amountSol,
    amount_x: 0,
    active_bin: extra.activeBin ?? null,
    bin_step: tracked.bin_step,
    volatility: tracked.volatility,
    fee_tvl_ratio: tracked.fee_tvl_ratio,
    organic_score: tracked.organic_score,
    base_mint: tracked.base_mint,
    expected_deposit_sol: amountSol,
    requested_deposit_sol: amountSol,
    position_secret: opened.secret || null,
    signal_snapshot: tracked.signal_snapshot || null,
  });
  // mark old closed if different
  if (tracked.position && tracked.position !== pos) {
    recordRebalance(tracked.position, pos);
  }
  patchLifecyclePosition(pos, {
    lifecycle_enabled: true,
    fsm_status: fsmStatus,
    position_secret: opened.secret || null,
    entry_regime: tracked.entry_regime || null,
    entry_value_sol: tracked.entry_value_sol ?? amountSol,
    cumulative_entry_sol: tracked.cumulative_entry_sol ?? tracked.entry_value_sol ?? amountSol,
    entry_ts_ms: tracked.entry_ts_ms || Date.now(),
    curve_half_width: tracked.curve_half_width ?? null,
    last_liquidity_op_ts: Date.now(),
    reopen_target: null,
    pending_reshape_x: null,
    pending_reshape_y: null,
    ...extra,
  });
  return pos;
}

// ─── Deploy (screening entry) ─────────────────────────────────

export async function executeLifecycleDeploy({
  pool,
  regime,
  strategy,
  amountSol,
  signal_snapshot = null,
  momentum = null,
}) {
  const vol = Number(pool.volatility ?? 0);
  const { half, bidDepth } = binsForPool(vol);
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

  if (result?.success && !result.dry_run) {
    const posAddr = result.position;
    const active = await getActiveBin({ pool_address: deployParams.pool_address }).catch(() => null);
    const activeId = active?.binId;
    const lower = activeId != null ? activeId - bins_below : result.bin_range?.min;
    const upper = activeId != null
      ? (isBidAsk ? activeId - 1 : activeId + bins_above)
      : result.bin_range?.max;

    initLifecycleOnDeploy(posAddr, {
      regime,
      fsmStatus: statusFromStrategy(deployParams.strategy),
      lowerBin: lower,
      upperBin: upper,
      entryValueSol: amountSol,
      curveHalfWidth: half,
      lastAction: isBidAsk ? "open_bidask" : "open_curve",
    });
    patchLifecyclePosition(posAddr, {
      bin_range: {
        min: lower,
        max: upper,
        bins_below,
        bins_above,
      },
      // secret saved by deployPosition when present
      last_reshape_bin: activeId,
      last_reshape_ts: Date.now(),
    });
  }

  return result;
}

// ─── Exit ─────────────────────────────────────────────────────

export async function executeExit(tracked, reason) {
  if (!tracked?.position) throw new Error("exit: no position");
  markLifecycleAction(tracked.position, "exit", reason, {
    fsm_status: PositionStatus.IDLE,
  });

  let result;
  try {
    // Prefer removeAll+close via ops when we have bin range
    const { lower, upper } = lowerUpper(tracked, null);
    if (lower != null && upper != null && tracked.pool) {
      await ops.removeAll(tracked.pool, tracked.position, lower, upper, true);
      // still run closePosition path for state/perf recording
      result = await closePosition({
        position_address: tracked.position,
        reason,
      }).catch(() => ({ success: true, position: tracked.position, close_reason: reason }));
    } else {
      result = await closePosition({ position_address: tracked.position, reason });
    }
  } catch (e) {
    log("lifecycle_warn", `exit removeAll fallback to closePosition: ${e.message}`);
    result = await closePosition({ position_address: tracked.position, reason });
  }

  await ops.sleep(settleMs());

  try {
    const mint = tracked.base_mint;
    if (mint && mint !== WSOL) {
      const bal = await getWalletBalances();
      const token = (bal.tokens || []).find((t) => t.mint === mint);
      const amt = Number(token?.balance ?? token?.ui_amount ?? 0);
      const usd = Number(token?.usd || 0);
      if (amt > 0 && usd >= 0.1) {
        await swapToken({ input_mint: mint, output_mint: WSOL, amount: amt }).catch((err) =>
          log("lifecycle_warn", `post-exit swap: ${err.message}`),
        );
      }
    }
  } catch (e) {
    log("lifecycle_warn", `post-exit cleanup: ${e.message}`);
  }

  return result;
}

// ─── Reshape (SAME position) ──────────────────────────────────

/**
 * fee-maxi reshape: withdraw all, re-add Curve into the SAME position + range.
 * Recovery path if crash left RESHAPE_PENDING_READD + pending amounts.
 */
export async function executeReshape(tracked, livePosition) {
  if (!tracked?.position || !tracked.pool) throw new Error("reshape: missing position/pool");
  const { lower, upper } = lowerUpper(tracked, livePosition);
  if (lower == null || upper == null) throw new Error("reshape: missing bin range");

  const bps = safetyBps();
  const recovering =
    tracked.fsm_status === PositionStatus.RESHAPE_PENDING_READD &&
    tracked.pending_reshape_x != null &&
    tracked.pending_reshape_y != null;

  markLifecycleAction(tracked.position, "reshape", recovering ? "pending_readd" : "bin_drift", {
    fsm_status: PositionStatus.RESHAPE_PENDING_READD,
    last_liquidity_op_ts: Date.now(),
  });

  let xAdd;
  let yAdd;

  if (recovering) {
    const wantX = new ops.BN(tracked.pending_reshape_x);
    const wantY = new ops.BN(tracked.pending_reshape_y);
    const tokenBal = await ops.getTokenBalanceRaw(tracked.base_mint);
    const maxY = ops.maxDeployableSolLamports(
      minReserve(),
      feeBuf(),
      await ops.getSolBalanceLamports(),
    );
    xAdd = ops.bnMin(wantX.isZero() ? tokenBal : wantX, tokenBal);
    yAdd = ops.bnMin(wantY.isZero() ? maxY : wantY, maxY);
    log("lifecycle", `reshape recovery re-add x=${xAdd.toString()} y=${yAdd.toString()}`);
  } else {
    const tokenBefore = await ops.getTokenBalanceRaw(tracked.base_mint);
    const solBefore = await ops.getSolBalanceLamports();

    // remove all, keep position account open
    const onChain = await ops.findOnChainPosition(tracked.pool, tracked.position);
    if (onChain) {
      const from = onChain.positionData?.lowerBinId ?? lower;
      const to = onChain.positionData?.upperBinId ?? upper;
      const totalLiq =
        BigInt(onChain.positionData?.totalXAmount || 0) +
        BigInt(onChain.positionData?.totalYAmount || 0);
      if (totalLiq > 0n) {
        await ops.removeAll(tracked.pool, tracked.position, from, to, false);
        await ops.sleep(settleMs());
      }
    } else {
      throw new Error("reshape: position not found on-chain");
    }

    const tokenAfter = await ops.getTokenBalanceRaw(tracked.base_mint);
    const solAfter = await ops.getSolBalanceLamports();
    const withdrawnToken = ops.clampPos(tokenAfter.sub(tokenBefore));
    const withdrawnSol = ops.clampPos(solAfter.sub(solBefore));
    const maxY = ops.maxDeployableSolLamports(minReserve(), feeBuf(), solAfter);

    xAdd = ops.applySafetyBps(ops.bnMin(withdrawnToken, tokenAfter), bps);
    yAdd = ops.applySafetyBps(ops.bnMin(withdrawnSol, maxY), bps);

    patchLifecyclePosition(tracked.position, {
      pending_reshape_x: xAdd.toString(),
      pending_reshape_y: yAdd.toString(),
      last_liquidity_op_ts: Date.now(),
    });

    log(
      "lifecycle",
      `reshape withdraw delta x=${withdrawnToken.toString()} y=${withdrawnSol.toString()} → readd x=${xAdd.toString()} y=${yAdd.toString()}`,
    );
  }

  if (xAdd.isZero() && yAdd.isZero()) {
    throw new Error(recovering ? "reshape: pending re-add zero" : "reshape: nothing withdrawn");
  }

  await ops.addCurveSameRange(
    tracked.pool,
    tracked.position,
    lower,
    upper,
    xAdd,
    yAdd,
    slipPct(),
  );

  const active = await ops.getActiveBinInfo(tracked.pool).catch(() => null);
  patchLifecyclePosition(tracked.position, {
    fsm_status: PositionStatus.CURVE_ACTIVE,
    strategy: "curve",
    last_reshape_bin: active?.binId ?? null,
    last_reshape_ts: Date.now(),
    last_liquidity_op_ts: Date.now(),
    last_lifecycle_action: "reshape",
    last_lifecycle_reason: recovering ? "pending_readd" : "bin_drift",
    pending_reshape_x: null,
    pending_reshape_y: null,
  });

  log("lifecycle", `reshape OK same position ${tracked.position.slice(0, 8)} active=${active?.binId}`);
  return { success: true, position: tracked.position, action: "reshape" };
}

// ─── Flip bid-ask → curve ─────────────────────────────────────

export async function executeFlip(tracked, livePosition) {
  if (!tracked?.position || !tracked.pool || !tracked.base_mint) {
    throw new Error("flip: missing state");
  }

  const reason = "lifecycle:flip_to_curve";
  markLifecycleAction(tracked.position, "flip", reason, {
    fsm_status: PositionStatus.REOPENING,
    reopen_target: "curve",
    last_liquidity_op_ts: Date.now(),
  });

  const { lower, upper } = lowerUpper(tracked, livePosition);
  const onChain = await ops.findOnChainPosition(tracked.pool, tracked.position);
  const from = onChain?.positionData?.lowerBinId ?? lower;
  const to = onChain?.positionData?.upperBinId ?? upper;
  if (from == null || to == null) throw new Error("flip: missing bins");

  const tokenBefore = await ops.getTokenBalanceRaw(tracked.base_mint);
  const solBefore = await ops.getSolBalanceLamports();

  // remove + claim + close old bid-ask
  await ops.removeAll(tracked.pool, tracked.position, from, to, true);
  await ops.sleep(settleMs());

  // record close for lessons/state
  await closePosition({
    position_address: tracked.position,
    reason,
  }).catch(() => null);

  const active = await ops.getActiveBinInfo(tracked.pool);
  const half =
    tracked.curve_half_width ??
    binsForPool(tracked.volatility).half;
  const range = centeredRange(active.binId, half);

  const bps = safetyBps();
  const tokenAfter = await ops.getTokenBalanceRaw(tracked.base_mint);
  const solAfter = await ops.getSolBalanceLamports();
  const withdrawnToken = ops.clampPos(tokenAfter.sub(tokenBefore));
  const withdrawnSol = ops.clampPos(solAfter.sub(solBefore));
  const maxY = ops.maxDeployableSolLamports(
    minReserve(),
    feeBuf(),
    solAfter,
    newPosOverhead(),
  );
  const xAdd = ops.applySafetyBps(ops.bnMin(withdrawnToken, tokenAfter), bps);
  const yAdd = ops.applySafetyBps(ops.bnMin(withdrawnSol, maxY), bps);

  log(
    "lifecycle",
    `flip redeploy curve x=${xAdd.toString()} y=${yAdd.toString()} bins=${range.minBinId}..${range.maxBinId}`,
  );

  if (xAdd.isZero() && yAdd.isZero()) {
    throw new Error("flip: nothing to redeploy after withdraw");
  }

  const opened = await ops.openCurveDouble(
    tracked.pool,
    range.minBinId,
    range.maxBinId,
    xAdd,
    yAdd,
    slipPct(),
  );

  const entrySol =
    Number(tracked.entry_value_sol) ||
    Number(tracked.amount_sol) ||
    Number(yAdd.toString()) / 1e9;

  trackOpened({
    opened,
    tracked,
    strategy: "curve",
    fsmStatus: PositionStatus.CURVE_ACTIVE,
    amountSol: entrySol,
    extra: {
      last_lifecycle_action: "flip",
      last_lifecycle_reason: reason,
      last_reshape_bin: active.binId,
      last_reshape_ts: Date.now(),
      curve_half_width: half,
      activeBin: active.binId,
    },
  });

  return { success: true, position: opened.position, action: "flip" };
}

// ─── Rebalance ────────────────────────────────────────────────

async function swapAllTokenToSol(baseMint) {
  if (!baseMint || baseMint === WSOL) return;
  if (process.env.DRY_RUN === "true") return;
  const bal = await getWalletBalances();
  const token = (bal.tokens || []).find((t) => t.mint === baseMint);
  const amt = Number(token?.balance ?? token?.ui_amount ?? 0);
  if (amt > 0) {
    await swapToken({ input_mint: baseMint, output_mint: WSOL, amount: amt });
    await ops.sleep(settleMs());
  }
}

export async function executeRebalance(tracked, livePosition, reason = "lifecycle:rebalance") {
  if (!tracked?.pool || !tracked.base_mint) throw new Error("rebalance: missing state");

  const status = tracked.fsm_status || tracked.strategy;
  let reopenAs =
    tracked.reopen_target ||
    (status === PositionStatus.BIDASK_OPEN || status === "bid_ask" ? "bidask" : "curve");

  // Curve pumped above upper → reopen as bid-ask (fee-maxi)
  if (
    reopenAs === "curve" &&
    livePosition?.active_bin != null &&
    (livePosition?.upper_bin ?? tracked.bin_range?.max) != null &&
    livePosition.active_bin > (livePosition.upper_bin ?? tracked.bin_range.max)
  ) {
    reopenAs = "bidask";
  }

  markLifecycleAction(tracked.position, "rebalance", reason, {
    fsm_status: PositionStatus.REOPENING,
    reopen_target: reopenAs,
    last_liquidity_op_ts: Date.now(),
  });

  const resume = status === PositionStatus.REOPENING;
  const { lower, upper } = lowerUpper(tracked, livePosition);

  // Close existing position if still open
  if (tracked.position && !tracked.closed) {
    try {
      const onChain = await ops.findOnChainPosition(tracked.pool, tracked.position);
      if (onChain) {
        const from = onChain.positionData?.lowerBinId ?? lower;
        const to = onChain.positionData?.upperBinId ?? upper;
        const totalLiq =
          BigInt(onChain.positionData?.totalXAmount || 0) +
          BigInt(onChain.positionData?.totalYAmount || 0);
        if (from != null && to != null && totalLiq > 0n) {
          await ops.removeAll(tracked.pool, tracked.position, from, to, true);
        }
      }
      await closePosition({
        position_address: tracked.position,
        reason,
      }).catch(() => null);
    } catch (e) {
      log("lifecycle_warn", `rebalance close: ${e.message}`);
      await closePosition({ position_address: tracked.position, reason }).catch(() => null);
    }
    await ops.sleep(settleMs());
  }

  const entryCap =
    Number(tracked.entry_value_sol) ||
    Number(tracked.amount_sol) ||
    capitalCfg().perPositionSol ||
    config.management.deployAmountSol;

  const active = await ops.getActiveBinInfo(tracked.pool);
  const half =
    tracked.curve_half_width ??
    binsForPool(tracked.volatility).half;
  const bidDepth =
    lower != null && upper != null
      ? upper - lower + 1
      : binsForPool(tracked.volatility).bidDepth;

  if (reopenAs === "bidask") {
    await swapAllTokenToSol(tracked.base_mint);
    const solBal = await ops.getSolBalanceLamports();
    const maxSol = ops.maxDeployableSolLamports(
      minReserve(),
      feeBuf(),
      solBal,
      newPosOverhead(),
    );
    const want = ops.solToLamports(entryCap);
    const sol = ops.bnMin(want, maxSol);
    if (sol.isZero()) throw new Error("rebalance bidask: no SOL to deploy");

    const range = bidRange(active.binId, bidDepth);
    const opened = await ops.openSingleSideSol(
      tracked.pool,
      range.minBinId,
      range.maxBinId,
      sol,
      slipPct(),
    );
    const amountSol = Number(sol.toString()) / 1e9;
    trackOpened({
      opened,
      tracked,
      strategy: "bid_ask",
      fsmStatus: PositionStatus.BIDASK_OPEN,
      amountSol,
      extra: {
        last_lifecycle_action: "rebalance",
        last_lifecycle_reason: reason,
        last_rebalance_ts: Date.now(),
        last_reshape_bin: active.binId,
        last_reshape_ts: Date.now(),
        activeBin: active.binId,
        resume: !!resume,
      },
    });
    return { success: true, position: opened.position, action: "rebalance_bidask" };
  }

  // curve reopen — use wallet token+SOL after withdraw (no forced swap)
  const tokenBal = await ops.getTokenBalanceRaw(tracked.base_mint);
  const solBal = await ops.getSolBalanceLamports();
  const maxY = ops.maxDeployableSolLamports(
    minReserve(),
    feeBuf(),
    solBal,
    newPosOverhead(),
  );
  const bps = safetyBps();
  const yAdd = ops.applySafetyBps(ops.bnMin(ops.solToLamports(entryCap), maxY), bps);
  // Prefer deploying available token bag; if zero token, SOL-only curve is still valid
  const xAdd = ops.applySafetyBps(tokenBal, bps);

  const range = centeredRange(active.binId, half);
  log(
    "lifecycle",
    `rebalance curve x=${xAdd.toString()} y=${yAdd.toString()} bins=${range.minBinId}..${range.maxBinId}`,
  );

  if (xAdd.isZero() && yAdd.isZero()) {
    throw new Error("rebalance curve: nothing to deploy");
  }

  const opened = await ops.openCurveDouble(
    tracked.pool,
    range.minBinId,
    range.maxBinId,
    xAdd,
    yAdd,
    slipPct(),
  );

  trackOpened({
    opened,
    tracked,
    strategy: "curve",
    fsmStatus: PositionStatus.CURVE_ACTIVE,
    amountSol: entryCap,
    extra: {
      last_lifecycle_action: "rebalance",
      last_lifecycle_reason: reason,
      last_rebalance_ts: Date.now(),
      last_reshape_bin: active.binId,
      last_reshape_ts: Date.now(),
      curve_half_width: half,
      activeBin: active.binId,
    },
  });

  return { success: true, position: opened.position, action: "rebalance_curve" };
}

// ─── Helpers used by tick ─────────────────────────────────────

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
  const tokenSol = Number(livePosition.token_x_sol ?? livePosition.base_amount_sol ?? NaN);
  const totalSol = Number(livePosition.total_value_sol ?? livePosition.position_value_sol ?? NaN);
  if (Number.isFinite(tokenSol) && Number.isFinite(totalSol) && totalSol > 0) {
    return tokenSol / totalSol;
  }
  return null;
}

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
  let currentSol = null;
  if (livePosition?.total_value_sol != null) {
    currentSol =
      Number(livePosition.total_value_sol) + Number(livePosition.unclaimed_fees_sol || 0);
  } else if (livePosition?.pnl_sol != null && Number.isFinite(Number(livePosition.pnl_sol))) {
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
