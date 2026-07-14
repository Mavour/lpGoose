/**
 * Lifecycle fields on tracked positions in state.json.
 */
import fs from "fs";
import { log } from "../logger.js";
import { PositionStatus } from "./decide.js";

const STATE_FILE = "./state.json";

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null, lifecycle: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: {}, recentEvents: [], lastUpdated: null, lifecycle: {} };
  }
}

function save(state) {
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getLifecycleMeta() {
  const state = load();
  return state.lifecycle || {};
}

export function setLifecycleMeta(patch) {
  const state = load();
  state.lifecycle = { ...(state.lifecycle || {}), ...patch };
  save(state);
  return state.lifecycle;
}

/**
 * Patch lifecycle fields on an open tracked position.
 */
export function patchLifecyclePosition(positionAddress, patch) {
  const state = load();
  const pos = state.positions[positionAddress];
  if (!pos || pos.closed) return null;
  Object.assign(pos, patch);
  save(state);
  return pos;
}

/**
 * Initialize lifecycle fields after deploy.
 */
export function initLifecycleOnDeploy(positionAddress, {
  regime = null,
  fsmStatus = PositionStatus.BIDASK_OPEN,
  lowerBin = null,
  upperBin = null,
  entryValueSol = null,
  curveHalfWidth = null,
  lastAction = "open",
} = {}) {
  const now = Date.now();
  return patchLifecyclePosition(positionAddress, {
    lifecycle_enabled: true,
    fsm_status: fsmStatus,
    entry_regime: regime,
    entry_value_sol: entryValueSol,
    entry_ts_ms: now,
    last_liquidity_op_ts: now,
    last_reshape_bin: null,
    last_reshape_ts: 0,
    last_rebalance_ts: 0,
    curve_half_width: curveHalfWidth,
    reopen_target: null,
    last_lifecycle_action: lastAction,
    last_lifecycle_reason: regime ? `entry:${regime}` : lastAction,
    cumulative_entry_sol: entryValueSol,
  });
}

export function statusFromStrategy(strategy) {
  if (strategy === "curve" || strategy === "spot") return PositionStatus.CURVE_ACTIVE;
  return PositionStatus.BIDASK_OPEN;
}

export function inferFsmStatus(tracked) {
  if (!tracked || tracked.closed) return PositionStatus.IDLE;
  if (tracked.fsm_status) return tracked.fsm_status;
  return statusFromStrategy(tracked.strategy);
}

/**
 * Find the single open lifecycle position (or first open).
 */
export function getOpenLifecyclePosition() {
  const state = load();
  const open = Object.values(state.positions || {}).filter((p) => !p.closed);
  if (!open.length) return null;
  // Prefer lifecycle-enabled; else first open
  return open.find((p) => p.lifecycle_enabled) || open[0];
}

export function markLifecycleAction(positionAddress, action, reason, extra = {}) {
  log("lifecycle", `${action}: ${reason}${positionAddress ? ` [${positionAddress.slice(0, 8)}]` : ""}`);
  if (!positionAddress) return;
  patchLifecyclePosition(positionAddress, {
    last_lifecycle_action: action,
    last_lifecycle_reason: reason,
    last_liquidity_op_ts: Date.now(),
    ...extra,
  });
}
