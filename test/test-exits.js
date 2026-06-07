import assert from "node:assert/strict";
import { evaluateOutOfRangeExit } from "../state.js";

const now = Date.parse("2026-06-07T12:00:00.000Z");
const fourMinutesAgo = "2026-06-07T11:56:00.000Z";
const nineMinutesAgo = "2026-06-07T11:51:00.000Z";
const config = {
  outOfRangeWaitMinutes: 8,
  downsideOutOfRangeWaitMinutes: 3,
  downsideOutOfRangeLossPct: -5,
};

assert.deepEqual(
  evaluateOutOfRangeExit(
    { active_bin: 89, lower_bin: 90, upper_bin: 100, pnl_pct: -6 },
    fourMinutesAgo,
    config,
    now
  ),
  {
    action: "OUT_OF_RANGE",
    reason: "Out of range below for 4m (limit: 3m, PnL <= -5%)",
  }
);

assert.deepEqual(
  evaluateOutOfRangeExit(
    { active_bin: 101, lower_bin: 90, upper_bin: 100 },
    nineMinutesAgo,
    config,
    now
  ),
  {
    action: "OUT_OF_RANGE",
    reason: "Out of range above for 9m (limit: 8m)",
  }
);

assert.equal(
  evaluateOutOfRangeExit(
    { active_bin: 95, lower_bin: 90, upper_bin: 100 },
    fourMinutesAgo,
    config,
    now
  ),
  null
);

assert.equal(
  evaluateOutOfRangeExit(
    { active_bin: 89, lower_bin: 90, upper_bin: 100, pnl_pct: -6 },
    "2026-06-07T11:58:00.000Z",
    config,
    now
  ),
  null
);

assert.equal(
  evaluateOutOfRangeExit(
    { active_bin: 89, lower_bin: 90, upper_bin: 100, pnl_pct: -0.2 },
    fourMinutesAgo,
    config,
    now
  ),
  null
);

console.log("Exit rule tests passed");
