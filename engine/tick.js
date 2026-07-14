/**
 * Lifecycle tick — single action per call.
 */
import { log } from "../logger.js";
import { config } from "../config.js";
import { getTrackedPosition } from "../state.js";
import { getActiveBin } from "../tools/dlmm.js";
import { decide, PositionStatus } from "./decide.js";
import {
  computeCumulativePnlPct,
  computeTokenShare,
  executeExit,
  executeFlip,
  executeRebalance,
  executeReshape,
  refreshLivePosition,
} from "./executors.js";
import {
  getOpenLifecyclePosition,
  inferFsmStatus,
  patchLifecyclePosition,
} from "./lifecycleState.js";

let _tickBusy = false;
let _lastTickTs = 0;
let _lastTickAction = "none";
let _lastTickReason = "";

export function getLifecycleTickStatus() {
  return {
    busy: _tickBusy,
    lastTickTs: _lastTickTs,
    lastAction: _lastTickAction,
    lastReason: _lastTickReason,
  };
}

function lowerUpperFromTracked(tracked, live) {
  let lower =
    live?.lower_bin ??
    tracked?.bin_range?.min ??
    (tracked?.bin_range?.bins_below != null && live?.active_bin != null
      ? live.active_bin - tracked.bin_range.bins_below
      : null);
  let upper =
    live?.upper_bin ??
    tracked?.bin_range?.max ??
    null;

  if (lower == null && tracked?.active_bin_at_deploy != null && tracked?.bin_range?.bins_below != null) {
    lower = tracked.active_bin_at_deploy - tracked.bin_range.bins_below;
    upper =
      tracked.bin_range.bins_above != null
        ? tracked.active_bin_at_deploy + tracked.bin_range.bins_above
        : tracked.active_bin_at_deploy - 1;
  }
  return { lowerBin: lower, upperBin: upper };
}

/**
 * Run one lifecycle management tick for the open position.
 * Entry is handled by screening cycle (auto-deploy).
 * @returns {{ action: string, reason: string }|null}
 */
export async function runLifecycleTick() {
  if (!config.lifecycle?.enabled) return null;
  if (_tickBusy) return { action: "none", reason: "tick_busy" };
  _tickBusy = true;
  _lastTickTs = Date.now();

  try {
    const tracked = getOpenLifecyclePosition();
    if (!tracked) {
      _lastTickAction = "none";
      _lastTickReason = "idle_no_position";
      return { action: "none", reason: "idle_no_position" };
    }

    // Ensure lifecycle fields exist for pre-migration positions
    if (!tracked.fsm_status) {
      patchLifecyclePosition(tracked.position, {
        lifecycle_enabled: true,
        fsm_status: inferFsmStatus(tracked),
        entry_value_sol: tracked.entry_value_sol ?? tracked.amount_sol,
        entry_ts_ms: tracked.entry_ts_ms || (tracked.deployed_at ? Date.parse(tracked.deployed_at) : Date.now()),
        cumulative_entry_sol: tracked.cumulative_entry_sol ?? tracked.amount_sol,
      });
    }

    const fresh = getTrackedPosition(tracked.position) || tracked;
    const { live } = await refreshLivePosition(fresh.position);

    if (!live) {
      // Position vanished on-chain — mark idle path via none (close recording is elsewhere)
      log("lifecycle", `No live position for ${fresh.position.slice(0, 8)} — skip`);
      _lastTickAction = "none";
      _lastTickReason = "no_live_position";
      return { action: "none", reason: "no_live_position" };
    }

    let activeBinId = live.active_bin ?? null;
    if (activeBinId == null && fresh.pool) {
      const ab = await getActiveBin({ pool_address: fresh.pool }).catch(() => null);
      activeBinId = ab?.binId ?? null;
    }

    const { lowerBin, upperBin } = lowerUpperFromTracked(fresh, live);
    const { pnlPct, pnlPctLoss } = computeCumulativePnlPct(fresh, live);
    const tokenShare = computeTokenShare(live);
    const status = inferFsmStatus(fresh);
    const nowMs = Date.now();

    // Persist live snapshot fields for dashboard
    patchLifecyclePosition(fresh.position, {
      last_snapshot_pnl_pct: pnlPct,
      last_token_share: tokenShare,
      last_active_bin: activeBinId,
      bin_range: {
        ...(fresh.bin_range || {}),
        min: lowerBin ?? fresh.bin_range?.min,
        max: upperBin ?? fresh.bin_range?.max,
      },
    });

    const decision = decide(
      {
        status,
        nowMs,
        activeBinId,
        pnlPct,
        pnlPctLoss,
        tokenShare,
        lowerBin,
        upperBin,
        lastReshapeBin: fresh.last_reshape_bin ?? null,
        lastReshapeTs: fresh.last_reshape_ts || 0,
        lastRebalanceTs: fresh.last_rebalance_ts || 0,
        lastLiquidityOpTs: fresh.last_liquidity_op_ts || 0,
        entryTs: fresh.entry_ts_ms || (fresh.deployed_at ? Date.parse(fresh.deployed_at) : 0),
        regime: null, // entry is screening's job
      },
      config.lifecycle,
    );

    _lastTickAction = decision.action;
    _lastTickReason = decision.reason;

    log(
      "lifecycle",
      `${fresh.pool_name || fresh.pool?.slice?.(0, 8)} | status=${status} | pnl=${pnlPct != null ? pnlPct.toFixed(2) + "%" : "?"} | share=${tokenShare != null ? (tokenShare * 100).toFixed(1) + "%" : "?"} | → ${decision.action} (${decision.reason})`,
    );

    if (decision.action === "none") return decision;

    // Optional risk confirm delay
    if (decision.action === "exit" && (config.lifecycle.risk?.confirmMs || 0) > 0) {
      const wait = config.lifecycle.risk.confirmMs;
      await new Promise((r) => setTimeout(r, wait));
      const { live: live2 } = await refreshLivePosition(fresh.position);
      if (!live2) return { action: "none", reason: "gone_during_confirm" };
      const again = computeCumulativePnlPct(getTrackedPosition(fresh.position) || fresh, live2);
      const { evaluateRisk } = await import("./risk.js");
      const signal = decision.reason.replace("risk:", "");
      const re = evaluateRisk(again.pnlPct, again.pnlPctLoss, config.lifecycle.risk);
      if (re === "ok" || (signal !== re && !(signal === "sl" && re === "maxloss"))) {
        log("lifecycle", `Risk confirm cancelled: was ${signal}, now ${re}`);
        return { action: "none", reason: "risk_unconfirmed" };
      }
    }

    const t = getTrackedPosition(fresh.position) || fresh;

    if (decision.action === "exit") {
      await executeExit(t, decision.reason);
    } else if (decision.action === "flip") {
      await executeFlip(t, live);
    } else if (decision.action === "reshape") {
      await executeReshape(t, live);
    } else if (decision.action === "rebalance") {
      await executeRebalance(t, live, decision.reason);
    } else if (decision.action === "openBidask" || decision.action === "openCurve") {
      // Handled by screening auto-deploy
      return { action: "none", reason: "entry_via_screening" };
    }

    return decision;
  } catch (err) {
    log("lifecycle_error", err.message || String(err));
    _lastTickAction = "error";
    _lastTickReason = err.message || "error";
    return { action: "error", reason: err.message };
  } finally {
    _tickBusy = false;
  }
}

export { PositionStatus };
