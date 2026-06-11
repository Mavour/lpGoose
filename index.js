import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log, logAction } from "./logger.js";
import { getMyPositions, closePosition, claimFees, getActiveBin, deployPosition } from "./tools/dlmm.js";
import { getWalletBalances, swapToken } from "./tools/wallet.js";
import { evaluateScreeningGate, getTopCandidates, verifyLiveEntryGuards } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, formatLearningProposal, getLearningProposal, getPerformanceSummary, listLearningProposals, markLearningProposal } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, sendKeyboard, editKeyboard, answerCallback, notifyClose, notifyOutOfRange, notifySupertrendWarning, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, updatePoolTvl, getPoolTvl } from "./state.js";
import { getActiveStrategy, setActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { BottomSpotLPStrategy } from "./strategies/index.js";
import { fetchKlineGMGN } from "./tools/chart-indicators.js";
import { getConfidenceSizing, selectBestConfidenceCandidate } from "./confidence.js";
import { PositionCloseCoordinator } from "./position-close-coordinator.js";
import { formatMomentumLog } from "./tools/momentum.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
if (!process.env.GMGN_API_KEY && !process.env.GMGN_API_TOKEN) {
  log("startup_warn", "GMGN credentials missing - normal auto-deploy will fail closed at the momentum gate.");
}

const TP_PCT = config.management.takeProfitFeePct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDecimal(value, maxDecimals = 5) {
  if (value == null) return "?";
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  return n.toFixed(maxDecimals).replace(/\.?0+$/, "");
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
const _autoCloseCoordinator = new PositionCloseCoordinator();
const _supertrendWarningCandles = new Map();

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function autoSwapBaseToSol(baseMint, context = "") {
  if (!baseMint) return { swapped: false, reason: "no base mint" };

  const balances = await getWalletBalances();
  const token = balances.tokens?.find(t => t.mint === baseMint);
  if (!token || token.usd == null || token.usd < 0.10) {
    return { swapped: false, reason: "dust or no token balance" };
  }

  const symbol = token.symbol || baseMint.slice(0, 8);
  log("cron", `Auto-swapping ${symbol} ($${token.usd.toFixed(2)}) back to SOL${context ? ` after ${context}` : ""}`);
  const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
  if (swapResult.success || swapResult.dry_run) {
    log("cron", `Auto-swap success: ${symbol} -> SOL`);
    return { swapped: true, token, result: swapResult };
  }

  log("cron_warn", `Auto-swap failed: ${swapResult.error}`);
  return { swapped: false, token, error: swapResult.error };
}

async function evaluateAutoExit(position) {
  if (config.management.whaleGuardEnabled) {
    try {
      const poolUrl = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${position.pool}`)}&timeframe=5m`;
      const poolRes = await fetch(poolUrl);
      if (poolRes.ok) {
        const poolData = await poolRes.json();
        const poolDetail = (poolData.data || [])[0];
        if (poolDetail) {
          const currentTvl = poolDetail.active_tvl ?? poolDetail.tvl ?? 0;
          const previous = getPoolTvl(position.pool);
          updatePoolTvl(position.pool, currentTvl);
          if (previous) {
            const dropUsd = previous.tvl - currentTvl;
            const dropPct = previous.tvl > 0 ? (dropUsd / previous.tvl) * 100 : 0;
            if (dropUsd >= config.management.whaleGuardMinDropUsd || dropPct >= config.management.whaleGuardMinDropPct) {
              return {
                action: "WHALE_EXIT",
                reason: `Whale exit: TVL dropped $${dropUsd.toFixed(0)} (${dropPct.toFixed(1)}%)`,
              };
            }
          }
        }
      }
    } catch (error) {
      log("cron_warn", `Whale check failed for ${position.pool.slice(0, 8)}: ${error.message}`);
    }
  }

  const coreExit = updatePnlAndCheckExits(position.position, position, config.management);
  if (coreExit) return coreExit;

  if (
    config.chartIndicators.enabled &&
    config.chartIndicators.exitOnBearishFlip &&
    position.strategy !== "bottom_spot_lp" &&
    position.base_mint
  ) {
    try {
      const { confirmExitSupertrendFlip } = await import("./tools/chart-indicators.js");
      const result = await confirmExitSupertrendFlip({
        mint: position.base_mint,
        interval: config.chartIndicators.exitInterval || config.chartIndicators.interval || "15m",
        period: config.chartIndicators.stPeriod || 10,
        multiplier: config.chartIndicators.stMultiplier || 3,
      });
      if (result?.triggered) {
        const candleTime = result.signal?.candleTime;
        const warningKey = position.position || position.pool;
        if (warningKey && candleTime != null && _supertrendWarningCandles.get(warningKey) !== candleTime) {
          _supertrendWarningCandles.set(warningKey, candleTime);
          log("state", `Supertrend warning for ${position.pair}: ${result.reason}; position remains open`);
          if (telegramEnabled()) {
            notifySupertrendWarning({
              pair: position.pair,
              interval: result.signal?.interval,
              pnlPct: position.pnl_pct,
              feesEarnedSol: position.fees_earned_sol,
              feesEarnedUsd:
                (position.collected_fees_true_usd || 0) +
                (position.unclaimed_fees_true_usd || 0),
              inRange: position.in_range,
              minutesOOR: position.minutes_out_of_range,
            }).catch((error) => {
              log("telegram_error", `Supertrend warning failed: ${error.message}`);
            });
          }
        }
      }
    } catch (error) {
      log("cron_warn", `Supertrend warning check skipped for ${position.pair}: ${error.message}`);
    }
  }

  if (config.bottomSpotLP?.enabled && position.strategy === "bottom_spot_lp" && position.base_mint) {
    try {
      const candles = await fetchKlineGMGN(
        position.base_mint,
        config.bottomSpotLP.interval || config.chartIndicators.interval || "1m",
        80,
      );
      const tracked = getTrackedPosition(position.position);
      const amountSol = tracked?.amount_sol || position.total_value_usd || 0;
      const feesPct = amountSol > 0 ? ((position.unclaimed_fees_usd || 0) / amountSol) * 100 : 0;
      const strategy = new BottomSpotLPStrategy(config.bottomSpotLP);
      const decision = await strategy.evaluatePosition({
        ...position,
        upperPrice: tracked?.signal_snapshot?.upperPrice,
        lowerPrice: tracked?.signal_snapshot?.lowerPrice,
        ilPct: position.pnl_pct != null && position.pnl_pct < 0 ? Math.abs(position.pnl_pct) : 0,
      }, candles, { pct: feesPct });
      if (decision.action === "close") {
        return { action: "BOTTOM_SPOT_EXIT", reason: `Bottom Spot: ${decision.reason}` };
      }
    } catch (error) {
      log("bottom_spot_warn", `Exit check skipped for ${position.pair}: ${error.message}`);
    }
  }

  return null;
}

async function executeAutoClose(position, exit, source) {
  const locked = await _autoCloseCoordinator.run(position.position, async () => {
    try {
      log("close", `Immediate auto-close [${source}]: ${position.pair} - ${exit.reason}`);
      const result = await closePosition({
        position_address: position.position,
        reason: exit.reason || exit.action || "auto_exit",
      });

      if (!(result.success || result.dry_run)) {
        log("cron_error", `Auto-close failed for ${position.pair}: ${result.error || "unknown error"}`);
        return result;
      }

      let autoSwap = null;
      if (result.success && result.base_mint) {
        autoSwap = await autoSwapBaseToSol(result.base_mint, `${source} auto-exit`).catch((error) => ({
          swapped: false,
          error: error.message,
        }));
      }

      notifyClose({
        pair: position.pair,
        pnlUsd: result.pnl_usd ?? 0,
        pnlPct: result.pnl_pct ?? 0,
        pnlSol: result.pnl_sol,
        feesEarnedUsd: result.fees_earned_usd,
        feesEarnedSol: result.fees_earned_sol,
        deployedSol: result.deployed_sol,
        strategy: result.strategy,
        holdMinutes: result.minutes_held,
        reason: result.close_reason || exit.reason,
      }).catch(() => {});

      return { ...result, auto_swap: autoSwap };
    } catch (error) {
      log("cron_error", `Auto-close error for ${position.pair}: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  if (!locked.acquired) {
    log("close", `Duplicate ${source} close ignored for ${position.pair}`);
    return { skipped: true, reason: "close already in progress" };
  }
  return locked.result;
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  const managementEvents = [];
  let positions = [];
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return null;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    const exitResults = await Promise.all(positionData.map((p) => evaluateAutoExit(p)));
    for (let i = 0; i < positionData.length; i++) {
      const p = positionData[i];
      const exit = exitResults[i];
      if (exit) {
        exitMap.set(p.position, exit);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        const exit = exitMap.get(p.position);
        actionMap.set(p.position, {
          ...exit,
          action: "CLOSE",
          exit_action: exit.action,
          rule: "exit",
        });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${formatDecimal(p.total_value_usd)}` : `$${formatDecimal(p.total_value_usd, 2)}`;
      const unclaimed = config.management.solMode ? `◎${formatDecimal(p.unclaimed_fees_usd)}` : `$${formatDecimal(p.unclaimed_fees_usd, 2)}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${formatDecimal(p.pnl_pct, 4)}% | Yield: ${formatDecimal(p.fee_per_tvl_24h, 2)}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE") line += `\nAuto-exit: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${formatDecimal(totalValue)} | fees: ${cur}${formatDecimal(totalUnclaimed)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    if (managementEvents.length > 0) {
      mgmtReport = `${managementEvents.join("\n")}\n\n${mgmtReport}`;
    }

    const deterministicPositions = positionData.filter((p) => {
      const a = actionMap.get(p.position);
      return a.action === "CLOSE" || a.action === "CLAIM";
    });

    if (deterministicPositions.length > 0) {
      log("cron", `Management: ${deterministicPositions.length} deterministic action(s) needed`);
    }

    for (const p of deterministicPositions) {
      const act = actionMap.get(p.position);

      if (act.action === "CLOSE") {
        const closeResult = await executeAutoClose(p, act, "management");
        mgmtReport += closeResult.success || closeResult.dry_run
          ? `\n\nClosed ${p.pair} (${act.reason})`
          : `\n\nClose failed for ${p.pair}: ${closeResult.error || closeResult.reason}`;
        continue;
      }

      if (act.action === "CLAIM") {
        log("cron", `Deterministic claim: ${p.pair}`);
        try {
          const claimResult = await claimFees({ position_address: p.position });
          if (claimResult.success || claimResult.dry_run) {
            log("cron", `Claim success: ${p.pair}`);
            mgmtReport += `\n\nClaimed fees for ${p.pair}`;
          } else {
            log("cron_error", `Claim failed for ${p.pair}: ${claimResult.error}`);
            mgmtReport += `\n\nClaim failed for ${p.pair}: ${claimResult.error}`;
          }
        } catch (claimErr) {
          log("cron_error", `Claim error for ${p.pair}: ${claimErr.message}`);
          mgmtReport += `\n\nClaim error for ${p.pair}: ${claimErr.message}`;
        }
      }
    }

    if (deterministicPositions.length > 0) {
      const remainingPositions = (await getMyPositions({ force: true }).catch(() => null))?.positions?.length ?? 0;
      log("cron", `Deterministic management done. Remaining positions: ${remainingPositions}/${config.risk.maxPositions}`);
    }

    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action === "INSTRUCTION";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048);

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      for (const p of positions) {
        const isAboveRange = p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin;
        if (isAboveRange && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

async function tryBottomSpotDeploy(passing, prePositions, preBalance) {
  const cfg = config.bottomSpotLP;
  if (!cfg?.enabled) return null;

  const bottomOpen = (prePositions?.positions || [])
    .filter((p) => p.strategy === "bottom_spot_lp").length;
  if (bottomOpen >= cfg.maxBottomSpotPositions) {
    log("bottom_spot", `Skipped - max Bottom Spot positions reached (${bottomOpen})`);
    return null;
  }

  const amountSol = cfg.deployAmountSol;
  const minRequired = amountSol + config.management.gasReserve;
  if (preBalance.sol < minRequired) {
    log("bottom_spot", `Skipped - insufficient SOL (${preBalance.sol} < ${minRequired})`);
    return null;
  }

  const strategy = new BottomSpotLPStrategy(cfg);
  const triggered = [];
  for (const candidate of passing) {
    const pool = candidate.pool;
    const mint = pool.base?.mint;
    if (!mint) continue;

    try {
      const candles = await fetchKlineGMGN(
        mint,
        cfg.interval || config.chartIndicators.interval || "1m",
        Math.max(60, cfg.athLookbackCandles + 10),
      );
      const evaluation = await strategy.shouldDeploy(candles, [pool]);
      if (evaluation.deploy) {
        triggered.push({ ...evaluation, candidate, candles });
        const dump = evaluation.signal.dumpPct.toFixed(2);
        const retrace = evaluation.signal.retracePct.toFixed(2);
        log("bottom_spot", `${pool.name} triggered: dump=${dump}%, retrace=${retrace}%`);
      }
    } catch (e) {
      log("bottom_spot_warn", `Candle check skipped for ${pool.name}: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  if (triggered.length === 0) return null;

  const selectedPool = triggered
    .sort((a, b) =>
      (b.pool.active_tvl ?? b.pool.tvl ?? 0) - (a.pool.active_tvl ?? a.pool.tvl ?? 0)
    )[0];
  const deployParams = strategy.buildDeployParams(
    selectedPool.pool,
    selectedPool.binRange,
    amountSol,
  );
  if (!deployParams.valid) {
    return {
      report: `Bottom Spot signal found, but deploy params invalid: ${deployParams.reason}`,
    };
  }
  deployParams.signal_snapshot = {
    ...deployParams.signal_snapshot,
    dumpPct: selectedPool.signal.dumpPct,
    retracePct: selectedPool.signal.retracePct,
    athPrice: selectedPool.signal.athPrice,
    dumpLow: selectedPool.signal.dumpLow,
    currentPrice: selectedPool.signal.currentPrice,
  };

  if (_autoCloseCoordinator.size > 0) {
    log("bottom_spot", `Deploy skipped - ${_autoCloseCoordinator.size} priority close(s) in progress`);
    return { deployed: false, report: "Bottom Spot deploy skipped while priority close is in progress." };
  }

  const liveEntry = await verifyLiveEntryGuards({
    poolAddress: selectedPool.pool.pool,
    mint: selectedPool.pool.base?.mint,
  });
  if (!liveEntry.pass) {
    log("bottom_spot", `Final live entry guard: dropped ${selectedPool.pool.name} - ${liveEntry.reason}`);
    return {
      deployed: false,
      report: `Bottom Spot deploy skipped: ${liveEntry.reason}`,
    };
  }
  deployParams.signal_snapshot = {
    ...deployParams.signal_snapshot,
    pool_fees_sol: liveEntry.fees.pool_fees_sol,
    pool_fees_source: liveEntry.fees.source,
    pool_fees_timeframe: liveEntry.fees.timeframe || null,
    price_vs_ath_pct: liveEntry.price?.price_vs_ath_pct ?? null,
  };

  const deployResult = await deployPosition(deployParams);
  const pool = selectedPool.pool;
  if (deployResult.success || deployResult.dry_run) {
    const status = deployResult.dry_run ? "DRY RUN" : "DEPLOYED";
    return {
      deployed: true,
      report: [
        `BOTTOM SPOT ${status}: ${pool.name}`,
        `${pool.pool}`,
        ``,
        `Trigger`,
        `Dump from ATH: ${selectedPool.signal.dumpPct.toFixed(2)}%`,
        `Retrace from low: ${selectedPool.signal.retracePct.toFixed(2)}%`,
        `ATH: ${selectedPool.signal.athPrice}`,
        `Dump low: ${selectedPool.signal.dumpLow}`,
        `Current: ${selectedPool.signal.currentPrice}`,
        ``,
        `Allocation`,
        `Amount: ${amountSol} SOL`,
        `Strategy: bottom_spot_lp (on-chain Spot)`,
        `Range: ${selectedPool.binRange.lowerPrice} -> ${selectedPool.binRange.upperPrice}`,
        `Bins below: ${selectedPool.binRange.totalBins}`,
        ``,
        `Pool Quality`,
        `Fee tier: ${pool.fee_pct}%`,
        `Fee/TVL: ${pool.fee_active_tvl_ratio ?? "?"}%`,
        `TVL: $${pool.active_tvl ?? pool.tvl ?? "?"}`,
        `Organic: ${pool.organic_score ?? pool.base?.organic ?? "?"}`,
        `Bin step: ${pool.bin_step}`,
      ].join("\n"),
    };
  }

  return {
    deployed: false,
    report: `Bottom Spot deploy failed for ${pool.name}: ${
      deployResult.error || "unknown error"
    }`,
  };
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_autoCloseCoordinator.size > 0) {
    log("cron", `Screening skipped - ${_autoCloseCoordinator.size} priority close(s) in progress`);
    return null;
  }
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      _screeningBusy = false;
      return null;
    }
    const minimumMultiplier = config.confidence.enabled
      ? config.confidence.halfMultiplier
      : 1;
    const minRequired = (config.management.deployAmountSol * minimumMultiplier) + config.management.gasReserve;
    if (preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      _screeningBusy = false;
      return null;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    _screeningBusy = false;
    return null;
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [auto-deploy mode]`);
  let screenReport = null;
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        pool.token_info ? Promise.resolve({ results: [pool.token_info] }) : (mint ? getTokenInfo({ query: mint }) : Promise.resolve(null)),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        memoryRisk: pool.memory_risk || null,
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Final hard gate after token recon. JS blocks before the LLM sees a candidate.
    const passing = allCandidates.filter(({ pool, ti }) => {
      const gate = evaluateScreeningGate(pool, { tokenInfo: ti });
      if (!gate.pass) {
        log("screening", `Final hard gate: dropped ${pool.name} - ${gate.reason}`);
        return false;
      }
      pool.memory_risk = gate.memoryRisk || pool.memory_risk || null;
      return true;
    });

    if (passing.length === 0) {
      screenReport = `No candidates available (all blocked by hard screening gates).`;
      return screenReport;
    }

    const bottomSpotResult = await tryBottomSpotDeploy(passing, prePositions, currentBalance);
    if (bottomSpotResult?.deployed) {
      screenReport = bottomSpotResult.report;
      return screenReport;
    }
    if (bottomSpotResult?.report) {
      log("bottom_spot_warn", bottomSpotResult.report);
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // ─── Auto-deploy: pick best candidate and deploy directly (no LLM involvement) ───
    const indexed = passing.map((c, i) => ({
      ...c,
      idx: i,
      activeBin: activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null,
    }));
    const best = selectBestConfidenceCandidate(indexed, config.confidence);

    const { pool, sw, n, ti, activeBin, idx: bestIdx, confidence } = best;
    const sizing = getConfidenceSizing(confidence.total, deployAmount, config.confidence);
    const confidenceLog = [
      `Confidence ${pool.name}: total=${confidence.total}%`,
      `volatility=${confidence.volatility_score}/40 raw=${pool.volatility ?? "?"}`,
      `fee_active_tvl=${confidence.fee_active_tvl_score}/40 raw=${pool.fee_active_tvl_ratio ?? "?"}%`,
      `smart_wallet=${confidence.smart_wallet_score}/20 recent=${confidence.recent_smart_wallets.length}/${sw?.in_pool?.length ?? 0}`,
      `action=${sizing.action}`,
      `amount=${sizing.amount} SOL`,
    ].join(" | ");
    log("screening", confidenceLog);
    if (sizing.action === "skip") {
      screenReport = [
        `SKIPPED: ${pool.name}`,
        `Confidence: ${confidence.total}% (< ${config.confidence.skipThreshold}%)`,
        `Volatility score: ${confidence.volatility_score}/40`,
        `Fee/Active TVL score: ${confidence.fee_active_tvl_score}/40`,
        `Smart wallet score: ${confidence.smart_wallet_score}/20`,
      ].join("\n");
      log("screening", `${pool.name} skipped - confidence ${confidence.total}% below ${config.confidence.skipThreshold}%`);
      return screenReport;
    }
    const momentum = pool.momentum;
    if (!momentum?.valid) {
      const reason = momentum?.reason || "momentum snapshot unavailable";
      log("momentum", formatMomentumLog({
        pool: pool.pool,
        mint: pool.base?.mint,
        result: momentum,
        gmgnAttempt: pool.momentum_gmgn_attempt,
        poolFeesSol: pool.pool_fees_sol,
        poolFeesSource: pool.pool_fees_source,
        feeTimeframe: pool.pool_fees_timeframe,
        decision: "skip",
        reason,
      }));
      return `Deploy skipped: ${reason}`;
    }
    const bins_below = momentum.binsBelow;
    log("momentum", formatMomentumLog({
      pool: pool.pool,
      mint: pool.base?.mint,
      result: momentum,
      gmgnAttempt: pool.momentum_gmgn_attempt,
      poolFeesSol: pool.pool_fees_sol,
      poolFeesSource: pool.pool_fees_source,
      feeTimeframe: pool.pool_fees_timeframe,
      decision: "deploy",
      reason: pool.supertrend_reason || "fresh bullish Supertrend break confirmed",
    }));

    if (_autoCloseCoordinator.size > 0) {
      log("screening", `Deploy skipped - ${_autoCloseCoordinator.size} priority close(s) in progress`);
      return "Deploy skipped while priority close is in progress.";
    }

    const liveEntry = await verifyLiveEntryGuards({
      poolAddress: pool.pool,
      mint: pool.base?.mint,
    });
    if (!liveEntry.pass) {
      log("screening", `Final live entry guard: dropped ${pool.name} - ${liveEntry.reason}`);
      return `Deploy skipped: ${liveEntry.reason}`;
    }
    pool.pool_fees_sol = liveEntry.fees.pool_fees_sol;
    pool.pool_fees_source = liveEntry.fees.source;
    pool.pool_fees_timeframe = liveEntry.fees.timeframe || null;
    if (liveEntry.price) {
      pool.price_vs_ath_pct = liveEntry.price.price_vs_ath_pct;
      pool.ath = liveEntry.price.ath;
    }

    const deployStartedAt = Date.now();
    const deployArgs = {
      pool_address: pool.pool,
      amount_sol: sizing.amount,
      strategy: config.strategy.strategy,
      bins_below,
      bins_above: 0,
      pool_name: pool.name,
      bin_step: pool.bin_step,
      fee_tvl_ratio: pool.fee_active_tvl_ratio,
      volatility: pool.volatility,
      organic_score: pool.organic_score,
      momentum,
      signal_snapshot: {
        momentum,
        supertrend_direction: pool.supertrend_direction,
        supertrend_reason: pool.supertrend_reason,
        pool_fees_sol: pool.pool_fees_sol,
        pool_fees_source: pool.pool_fees_source,
        pool_fees_timeframe: pool.pool_fees_timeframe,
      },
    };
    const deployResult = await deployPosition(deployArgs);
    logAction({
      tool: "deploy_position",
      args: deployArgs,
      result: deployResult,
      duration_ms: Date.now() - deployStartedAt,
      success: deployResult?.success === true || deployResult?.dry_run === true,
    });

    if (deployResult.success || deployResult.dry_run) {
      const minPrice = deployResult.price_range?.min ?? "?";
      const maxPrice = deployResult.price_range?.max ?? "?";
      const downsidePct = minPrice !== "?" && maxPrice !== "?" ? ((minPrice / maxPrice - 1) * 100).toFixed(2) : "?";

      const feeTvlStr = pool.fee_active_tvl_ratio != null ? `${pool.fee_active_tvl_ratio}%` : "?";
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = pool.pool_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;

      const rejectedStr = passing.length > 1
        ? indexed.filter(c => c.idx !== bestIdx).map(c => `${c.pool.name} (fee_tvl=${c.pool.fee_active_tvl_ratio ?? "?"}%)`).join("; ")
        : "N/A — single candidate.";

      const thesis = n?.narrative
        ? n.narrative.slice(0, 220)
        : "No narrative available.";

      screenReport = [
        `${deployResult.dry_run ? "DRY RUN" : "DEPLOYED"}: ${pool.name}`,
        `${pool.pool}`,
        ``,
        `Allocation`,
        `Amount: ${sizing.amount} SOL (${sizing.action === "full" ? "full" : "half"} size)`,
        `Confidence: ${confidence.total}%`,
        `Volatility score: ${confidence.volatility_score}/40`,
        `Fee/Active TVL score: ${confidence.fee_active_tvl_score}/40`,
        `Smart wallet score: ${confidence.smart_wallet_score}/20 (${confidence.recent_smart_wallets.length} within ${config.confidence.smartWalletMaxAgeMinutes}m)`,
        `Strategy: ${config.strategy.strategy}`,
        `Momentum: ${momentum.score ?? "N/A"} (${momentum.classification})`,
        `Momentum bins: ${momentum.selectedBand.join("-")} -> ${momentum.binsBelow}`,
        `Price 5m: ${momentum.priceChange5m.toFixed(2)}%`,
        `Volume ratio: ${momentum.volumeRatio.toFixed(2)}x`,
        `Active bin: ${activeBin ?? "?"}`,
        `Range: ${minPrice} → ${maxPrice} SOL`,
        `Downside cover: ${downsidePct}%`,
        ``,
        `Pool Quality`,
        `Fee tier: ${pool.fee_pct}%`,
        `Fee/TVL: ${feeTvlStr}`,
        `${pool.pool_fees_source === "gmgn_token_total" ? "GMGN token total fees" : "Pool fees"}: ${feesSol} SOL${pool.pool_fees_source ? ` (${pool.pool_fees_source}, ${pool.pool_fees_timeframe || "timeframe unknown"})` : ""}`,
        `Window fees: $${pool.fee_window_usd ?? "?"} (${config.screening.timeframe}, Meteora)`,
        `Volume: $${pool.volume_window}`,
        `TVL: $${pool.active_tvl}`,
        `Volatility: ${pool.volatility}`,
        `Bin step: ${pool.bin_step}`,
        ``,
        `Risk Check`,
        `Organic: ${pool.organic_score}`,
        `Market cap: $${pool.mcap}`,
        `Top 10 holders: ${top10Pct}%`,
        `Bot holders: ${botPct}%`,
        pool.token_age_hours != null ? `Token age: ${pool.token_age_hours}h` : null,
        launchpad ? `Launchpad: ${launchpad}` : null,
        `Smart wallets: ${sw?.in_pool?.length ?? 0} present`,
        ``,
        `Thesis`,
        thesis,
        ``,
        `Why Deployed`,
        `Best candidate by confidence score. All configured hard gates passed.`,
        ``,
        `Rejected: ${rejectedStr}`,
      ].filter(Boolean).join("\n");
    } else {
      screenReport = `Decision: DEPLOY FAILED\npool: ${pool.name} | ${pool.pool}\nerror: ${deployResult.error || "Unknown error"}`;
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthInterval = Math.max(1, config.schedule.healthCheckIntervalMin || 60);
  const healthTask = cron.schedule(`*/${healthInterval} * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s poller — evaluates and directly executes deterministic auto-exits.
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      if (getTrackedPositions(true).length === 0) return;
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);

      // Write live cache for dashboard — gives it LPAgent-enriched data instantly
      try {
        if (result) {
          const cachePath = path.join(__dirname, 'live-positions-cache.json');
          fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), positions: result.positions }));
        }
      } catch {}

      if (!result?.positions?.length) return;
      const closeTasks = [];
      const exitResults = await Promise.all(result.positions.map((p) => evaluateAutoExit(p)));
      for (let i = 0; i < result.positions.length; i++) {
        const p = result.positions[i];
        const exit = exitResults[i];
        const tp = getTrackedPosition(p.position);
        const trail = tp?.trailing_active ? "ON" : "OFF";
        const peak = tp?.peak_pnl_pct != null ? tp.peak_pnl_pct.toFixed(2) : "?";
        const range = p.in_range ? "IN" : `OOR ${p.minutes_out_of_range ?? 0}m`;
        log("pnl", `${p.pair} | PnL: ${p.pnl_pct != null ? (p.pnl_pct >= 0 ? "+" : "") + p.pnl_pct.toFixed(2) : "?"}% | Peak: ${peak}% | Trail: ${trail} | ${range} | Yield: ${p.fee_per_tvl_24h ?? "?"}%${exit ? ` | ⚡ ${exit.reason}` : ""}`);
        if (exit) {
          closeTasks.push(executeAutoClose(p, exit, "poller"));
        }
      }
      if (closeTasks.length > 0) await Promise.allSettled(closeTasks);
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  // Telegram bot — queue messages received while busy, drain after each task
  async function drainTelegramQueue() {
    while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
      const queued = _telegramQueue.shift();
      await telegramHandler(queued);
    }
  }

  let pendingMenuEdit = null;

  function parseConfigValue(rawValue) {
    const raw = String(rawValue).trim();
    if (raw === "null" || raw === "undefined") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (!Number.isNaN(Number(raw)) && raw.includes(".")) return parseFloat(raw);
    if (!Number.isNaN(Number(raw))) return parseInt(raw, 10);
    if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
      try { return JSON.parse(raw); } catch { /* fall through */ }
    }
    return raw;
  }

  async function applyTelegramConfig(key, value) {
    const cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    const confidenceFields = {
      "confidence.enabled": "confidenceEnabled",
      "confidence.fullThreshold": "confidenceFullThreshold",
      "confidence.skipThreshold": "confidenceSkipThreshold",
      "confidence.halfMultiplier": "confidenceHalfMultiplier",
      "confidence.smartWalletMaxAgeMinutes": "smartWalletMaxAgeMinutes",
    };
    if (key.startsWith("bottomSpotLP.")) {
      const field = key.split(".")[1];
      cfg.bottomSpotLP = cfg.bottomSpotLP || {};
      cfg.bottomSpotLP[field] = value;
    } else if (confidenceFields[key]) {
      cfg[confidenceFields[key]] = value;
    } else if (config.chartIndicators && key in config.chartIndicators) {
      cfg.chartIndicators = cfg.chartIndicators || {};
      cfg.chartIndicators[key] = value;
      delete cfg[key];
    } else {
      cfg[key] = value;
    }
    if (key === "deployAmountSol") {
      cfg.minSolToOpen = value;
      cfg.maxDeployAmount = value;
    }
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));

    if (key === "dryRun") process.env.DRY_RUN = String(value);

    reloadScreeningThresholds();
    if (config.screening && key in config.screening) config.screening[key] = value;
    if (config.management && key in config.management) config.management[key] = value;
    if (confidenceFields[key]) {
      const field = key.split(".")[1];
      config.confidence[field] = value;
    }
    if (config.schedule && key in config.schedule) {
      config.schedule[key] = value;
      stopCronJobs();
      startCronJobs();
    }
    if (config.llm && key in config.llm) config.llm[key] = value;
    if (config.strategy && key in config.strategy) config.strategy[key] = value;
    if (key.startsWith("bottomSpotLP.")) {
      const field = key.split(".")[1];
      if (field && config.bottomSpotLP && field in config.bottomSpotLP) {
        config.bottomSpotLP[field] = value;
      }
    }
    if (key === "strategy") {
      if (value === "bid_ask") setActiveStrategy({ id: "single_sided_reseed" });
      if (value === "spot") setActiveStrategy({ id: "custom_ratio_spot" });
      if (value === "mixed") setActiveStrategy({ id: "multi_layer" });
    }
    if (config.risk && key in config.risk) config.risk[key] = value;
    if (config.chartIndicators && key in config.chartIndicators) config.chartIndicators[key] = value;
    if (key === "deployAmountSol") {
      config.management.minSolToOpen = value;
      config.risk.maxDeployAmount = value;
    }

    log("config", `Telegram update: ${key} = ${JSON.stringify(value)}`);
  }

  async function applyPreset(name) {
    const presets = {
      custom: {},
      degen: {
        maxPositions: 3,
        deployAmountSol: 0.2,
        gasReserve: 0.05,
        stopLossPct: -60,
        takeProfitFeePct: 20,
        minTokenFeesSol: 20,
        whaleGuardMinDropPct: 35,
      },
      moderate: {
        maxPositions: 2,
        deployAmountSol: 0.1,
        gasReserve: 0.05,
        stopLossPct: -30,
        takeProfitFeePct: 15,
        minTokenFeesSol: 30,
        whaleGuardMinDropPct: 25,
      },
      safe: {
        maxPositions: 1,
        deployAmountSol: 0.1,
        gasReserve: 0.08,
        stopLossPct: -15,
        takeProfitFeePct: 10,
        minTokenFeesSol: 50,
        whaleGuardMinDropPct: 15,
      },
    };
    const changes = presets[name] || {};
    for (const [key, value] of Object.entries(changes)) {
      await applyTelegramConfig(key, value);
    }
  }

  function settingValue(key) {
    if (key === "dryRun") return process.env.DRY_RUN === "true" ? "on" : "off";
    if (key.startsWith("bottomSpotLP.")) {
      const field = key.split(".")[1];
      return config.bottomSpotLP?.[field] ?? "?";
    }
    if (key.startsWith("confidence.")) {
      const field = key.split(".")[1];
      return config.confidence?.[field] ?? "?";
    }
    if (key in config.risk) return config.risk[key];
    if (key in config.screening) return config.screening[key];
    if (key in config.management) return config.management[key];
    if (key in config.schedule) return config.schedule[key];
    if (key in config.llm) return config.llm[key];
    if (config.chartIndicators && key in config.chartIndicators) return config.chartIndicators[key];
    if (key in config.strategy) {
      const v = config.strategy[key];
      return typeof v === "object" ? JSON.stringify(v) : v;
    }
    return "?";
  }

  const menuSections = {
    quick: [
      ["maxPositions", "Max positions"],
      ["deployAmountSol", "Deploy SOL"],
      ["minSolToOpen", "Min SOL open"],
      ["maxDeployAmount", "Max deploy SOL"],
      ["gasReserve", "Gas reserve"],
      ["solMode", "SOL mode"],
      ["dryRun", "Dry run"],
      ["strategy", "Strategy"],
      ["minBinsBelow", "Min bins"],
      ["maxBinsBelow", "Max bins"],
    ],
    screen: [
      ["minFeeActiveTvlRatio", "Min fee/TVL"],
      ["minTvl", "Min TVL"],
      ["maxTvl", "Max TVL"],
      ["minVolume", "Min volume"],
      ["minOrganic", "Min organic"],
      ["minTokenFeesSol", "Min fee SOL"],
      ["maxBotHoldersPct", "Max bots %"],
      ["maxTop10Pct", "Max top10 %"],
      ["minHolders", "Min holders"],
      ["minMcap", "Min mcap"],
      ["maxMcap", "Max mcap"],
      ["minBinStep", "Min bin step"],
      ["maxBinStep", "Max bin step"],
      ["category", "Category"],
      ["minTokenAgeHours", "Min token age"],
      ["maxTokenAgeHours", "Max token age"],
      ["athFilterPct", "ATH filter %"],
      ["timeframe", "Timeframe"],
      ["avoidPvpSymbols", "PvP detect"],
      ["blockPvpSymbols", "PvP block"],
    ],
    risk: [
      ["whaleGuardEnabled", "Whale guard"],
      ["whaleGuardMinDropUsd", "Whale drop USD"],
      ["whaleGuardMinDropPct", "Whale drop %"],
      ["stopLossPct", "Stop loss %"],
      ["maxPositions", "Max positions"],
    ],
    manage: [
      ["minClaimAmount", "Min claim $"],
      ["minFeePerTvl24h", "Min fee/TVL 24h"],
      ["minAgeBeforeYieldCheck", "Min age yield"],
      ["outOfRangeWaitMinutes", "OOR wait min"],
      ["outOfRangeBinsToClose", "OOR bins close"],
      ["positionSizePct", "Position size %"],
      ["autoSwapAfterClaim", "Auto swap"],
      ["minVolumeToRebalance", "Min vol rebalance"],
    ],
    confidence: [
      ["confidence.enabled", "Confidence enabled"],
      ["confidence.fullThreshold", "Full threshold"],
      ["confidence.skipThreshold", "Skip threshold"],
      ["confidence.halfMultiplier", "Half multiplier"],
      ["confidence.smartWalletMaxAgeMinutes", "Smart wallet age"],
    ],
    exits: [
      ["takeProfitFeePct", "Take profit %"],
      ["stopLossPct", "Stop loss %"],
      ["trailingTakeProfit", "Trailing"],
      ["trailingTriggerPct", "Trail trigger %"],
      ["trailingDropPct", "Trail drop %"],
    ],
    schedule: [
      ["managementIntervalMin", "Manage interval"],
      ["screeningIntervalMin", "Screen interval"],
      ["healthCheckIntervalMin", "Health interval"],
    ],
    llm: [
      ["managementModel", "Manage model"],
      ["screeningModel", "Screen model"],
      ["generalModel", "General model"],
      ["temperature", "Temperature"],
      ["maxTokens", "Max tokens"],
      ["maxSteps", "Max steps"],
    ],
    strategy: [
      ["strategy", "Strategy"],
      ["mixedRatio", "Mixed ratio"],
      ["minBinsBelow", "Min bins"],
      ["maxBinsBelow", "Max bins"],
    ],
    indicators: [
      ["stPeriod", "ST Period"],
      ["stMultiplier", "ST Multiplier"],
      ["interval", "ST Interval"],
      ["failOpen", "Fail Open"],
    ],
    bottom: [
      ["bottomSpotLP.enabled", "Enabled"],
      ["bottomSpotLP.deployAmountSol", "Deploy SOL"],
      ["bottomSpotLP.minDumpPct", "Min dump %"],
      ["bottomSpotLP.minRetracePct", "Min retrace %"],
      ["bottomSpotLP.interval", "Interval"],
      ["bottomSpotLP.athLookbackCandles", "Lookback candles"],
      ["bottomSpotLP.rangePct", "Range %"],
      ["bottomSpotLP.minBaseFee", "Min base fee"],
      ["bottomSpotLP.minTvl", "Min TVL"],
      ["bottomSpotLP.maxTvl", "Max TVL"],
      ["bottomSpotLP.minVolume", "Min volume"],
      ["bottomSpotLP.minFeeActiveTvlRatio", "Min fee/TVL"],
      ["bottomSpotLP.minOrganic", "Min organic"],
      ["bottomSpotLP.rsiExitThreshold", "RSI exit"],
      ["bottomSpotLP.takeProfitFeePct", "Fee target %"],
      ["bottomSpotLP.maxILPct", "Max IL %"],
      ["bottomSpotLP.maxBottomSpotPositions", "Max bottom pos"],
    ],
  };

  function buildSettingsMenu(section = "quick", preset = "custom") {
    const activeStrategy = getActiveStrategy();
    const strategyName = activeStrategy?.lp_strategy || config.strategy.strategy;
    const trailing = config.management.trailingTakeProfit ? "ON" : "OFF";
    const solMode = config.management.solMode ? "SOL" : "USD";
    const dryRun = process.env.DRY_RUN === "true" ? "on" : "off";
    const st = config.chartIndicators;
    const supState = st.enabled ? `ON (${st.stPeriod}/${st.stMultiplier}, ${st.interval})` : "OFF";
    const bottomState = config.bottomSpotLP?.enabled
      ? `ON (${config.bottomSpotLP.minDumpPct}% dump)`
      : "OFF";
    const settings = menuSections[section] || menuSections.quick;

    const text = [
      `Settings: ${section[0].toUpperCase()}${section.slice(1)}`,
      "",
      `Mode: ${solMode} | Source: meteora | Strat: ${strategyName}`,
      `Deploy: ${config.management.deployAmountSol} SOL | MaxPos: ${config.risk.maxPositions} | Gas: ${config.management.gasReserve}`,
      `TP/SL: ${config.management.takeProfitFeePct}% / ${config.management.stopLossPct}% | Trailing: ${trailing}`,
      `Bins range: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] | Sup: ${supState} | Dry run: ${dryRun}`,
      `Bottom Spot: ${bottomState}`,
      `PvP: ${config.screening.avoidPvpSymbols ? "detect" : "OFF"}${config.screening.blockPvpSymbols ? " + block" : ""}`,
      "",
      `${settings.length} editable settings. Tap a value to edit.`,
    ].join("\n");

    const sectionRows = [
      ["quick", "screen", "risk"],
      ["strategy", "manage", "exits"],
      ["confidence", "schedule", "indicators"],
      ["llm"],
      ["bottom"],
    ].map((row) => row.map((id) => ({
      text: `${id === section ? "✓ " : ""}${id[0].toUpperCase()}${id.slice(1)}`,
      callback_data: `menu:${id}:${preset}`,
    })));

    const presetRow = ["custom", "degen", "moderate", "safe"].map((id) => ({
      text: `${id === preset ? "✓ " : ""}${id[0].toUpperCase()}${id.slice(1)}`,
      callback_data: `preset:${id}:${section}`,
    }));

    const settingRows = settings.map(([key, label]) => ([{
      text: `${label}: ${settingValue(key)} ✎`,
      callback_data: `edit:${key}:${section}:${preset}`,
    }]));

    return { text, keyboard: [...sectionRows, presetRow, ...settingRows] };
  }

  async function sendSettingsMenu(section = "quick", preset = "custom") {
    const menu = buildSettingsMenu(section, preset);
    await sendKeyboard(menu.text, menu.keyboard);
  }

  async function telegramCallbackHandler(query) {
    const data = query.data || "";
    log("telegram", `Callback: ${data}`);
    const [type, a, b, c, d] = data.split(":");
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;

    if (type === "menu") {
      const section = a || "quick";
      const preset = b || "custom";
      const menu = buildSettingsMenu(section, preset);
      await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
      await answerCallback(query.id);
      return;
    }

    if (type === "preset") {
      const preset = a || "custom";
      const section = b || "quick";
      await applyPreset(preset);
      const menu = buildSettingsMenu(section, preset);
      await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
      await answerCallback(query.id, preset === "custom" ? "Custom selected" : `${preset} preset applied`);
      return;
    }

    if (type === "edit") {
      const key = a;
      const section = b || "quick";
      const preset = c || "custom";

      if (key === "strategy") {
        const keyboard = [
          [{ text: `bid_ask${config.strategy.strategy === "bid_ask" ? " ✓" : ""}`, callback_data: `set_strategy:bid_ask:${section}:${preset}` }],
          [{ text: `spot${config.strategy.strategy === "spot" ? " ✓" : ""}`, callback_data: `set_strategy:spot:${section}:${preset}` }],
          [{ text: `mixed${config.strategy.strategy === "mixed" ? " ✓" : ""}`, callback_data: `set_strategy:mixed:${section}:${preset}` }],
        ];
        await editKeyboard(chatId, messageId, "Choose strategy:", keyboard);
        await answerCallback(query.id);
        return;
      }

      if (key === "mixedRatio") {
        const current = config.strategy.mixedRatio || { bidask: 70, spot: 30 };
        const is = (b, s) => current.bidask === b && current.spot === s;
        const keyboard = [
          [
            { text: `90/10${is(90,10) ? " ✓" : ""}`, callback_data: `set_mixed:90:10:${section}:${preset}` },
            { text: `85/15${is(85,15) ? " ✓" : ""}`, callback_data: `set_mixed:85:15:${section}:${preset}` },
          ],
          [
            { text: `70/30${is(70,30) ? " ✓" : ""}`, callback_data: `set_mixed:70:30:${section}:${preset}` },
            { text: `60/40${is(60,40) ? " ✓" : ""}`, callback_data: `set_mixed:60:40:${section}:${preset}` },
          ],
          [
            { text: `80/20${is(80,20) ? " ✓" : ""}`, callback_data: `set_mixed:80:20:${section}:${preset}` },
            { text: `50/50${is(50,50) ? " ✓" : ""}`, callback_data: `set_mixed:50:50:${section}:${preset}` },
          ],
        ];
        await editKeyboard(chatId, messageId, "Choose BidAsk/Spot split:", keyboard);
        await answerCallback(query.id);
        return;
      }

      pendingMenuEdit = { key, section, preset };
      await answerCallback(query.id, `Send new value for ${key}`);
      await sendMessage(`Send new value for ${key}. Current: ${JSON.stringify(settingValue(key))}`);
      return;
    }

    if (type === "set_strategy") {
      const value = a;
      const section = b || "quick";
      const preset = c || "custom";
      await applyTelegramConfig("strategy", value);
      const menu = buildSettingsMenu(section, preset);
      await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
      await answerCallback(query.id, `Strategy → ${value}`);
      return;
    }

    if (type === "set_mixed") {
      const bidask = parseInt(a);
      const spot = parseInt(b);
      const section = c || "quick";
      const preset = d || "custom";
      await applyTelegramConfig("mixedRatio", { bidask, spot });
      const menu = buildSettingsMenu(section, preset);
      await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
      await answerCallback(query.id, `Mixed ratio → ${bidask}/${spot}`);
      return;
    }

    if (type === "learn_approve" || type === "learn_reject") {
      const id = a;
      const proposal = getLearningProposal(id);
      if (!proposal) {
        await answerCallback(query.id, "Proposal not found");
        return;
      }
      if (proposal.status !== "pending") {
        await editKeyboard(chatId, messageId, formatLearningProposal(proposal), []);
        await answerCallback(query.id, `Already ${proposal.status}`);
        return;
      }

      if (type === "learn_reject") {
        const rejected = markLearningProposal(id, "rejected", "Rejected from Telegram");
        await editKeyboard(chatId, messageId, formatLearningProposal(rejected), []);
        await answerCallback(query.id, "Rejected");
        return;
      }

      try {
        for (const [key, value] of Object.entries(proposal.changes || {})) {
          await applyTelegramConfig(key, value);
        }
        const approved = markLearningProposal(id, "approved", "Approved from Telegram");
        await editKeyboard(chatId, messageId, formatLearningProposal(approved), []);
        await answerCallback(query.id, "Approved and applied");
      } catch (e) {
        await answerCallback(query.id, "Apply failed");
        await sendMessage(`Learning proposal apply failed: ${e.message}`);
      }
      return;
    }

    await answerCallback(query.id);
  }

  async function telegramHandler(text) {
    log("telegram", `Incoming: ${text}`);

    if (pendingMenuEdit && !text.startsWith("/")) {
      const { key, section, preset } = pendingMenuEdit;
      pendingMenuEdit = null;
      const value = parseConfigValue(text);
      try {
        await applyTelegramConfig(key, value);
        await sendMessage(`Updated ${key} = ${JSON.stringify(value)}`);
        await sendSettingsMenu(section, preset);
      } catch (e) {
        await sendMessage(`Failed: ${e.message}`);
      }
      return;
    }

    if (_managementBusy || _screeningBusy || busy) {
      if (_telegramQueue.length < 5) {
        _telegramQueue.push(text);
        log("telegram", `Queued (${_telegramQueue.length}): ${text}`);
        sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
      } else {
        log("telegram", `Queue full, dropped: ${text}`);
        sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
      }
      return;
    }

    if (text === "/screen") {
      await sendMessage("Starting screening cycle...");
      try {
        await runScreeningCycle();
      } catch (e) {
        await sendMessage(`Screening failed: ${e.message}`).catch(() => {});
      } finally {
        drainTelegramQueue().catch(() => {});
      }
      return;
    }

    if (text === "/menu") {
      await sendSettingsMenu("quick", "custom");
      return;
    }

    if (text.startsWith("/config")) {
      try {
        if (!fs.existsSync(USER_CONFIG_PATH)) {
          await sendMessage("No user-config.json found - using defaults.");
          return;
        }
        const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
        const keys = Object.keys(cfg).sort();
        const lines = keys.map(k => `${k}: ${JSON.stringify(cfg[k])}`);
        const body = lines.join("\n").slice(0, 3500);
        await sendMessage(`Config (${keys.length} keys):\n\n${body}`);
      } catch (e) {
        await sendMessage(`Error reading config: ${e.message}`);
      }
      return;
    }

    if (text === "/learning") {
      const proposals = listLearningProposals({ status: "pending", limit: 5 });
      if (proposals.length === 0) {
        await sendMessage("No pending learning proposals.");
        return;
      }
      const latest = proposals[proposals.length - 1];
      await sendKeyboard(formatLearningProposal(latest), [
        [
          { text: "APPROVE", callback_data: `learn_approve:${latest.id}` },
          { text: "REJECT", callback_data: `learn_reject:${latest.id}` },
        ],
      ]);
      return;
    }

    const configSetMatch = text.match(/^\/set\s+(\S+)\s+(.+)$/i);
    if (configSetMatch && !/^\d+$/.test(configSetMatch[1])) {
      const key = configSetMatch[1];
      const rawValue = configSetMatch[2].trim();
      const value = parseConfigValue(rawValue);

      try {
        await applyTelegramConfig(key, value);
        await sendMessage(`Updated ${key} = ${JSON.stringify(value)}`);
      } catch (e) {
        await sendMessage(`Failed: ${e.message}`);
      }
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        await sendHTML(briefing);
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => { });
      }
      return;
    }

    if (text === "/positions") {
      try {
        const { positions, total_positions } = await getMyPositions({ force: true });
        if (total_positions === 0) { await sendMessage("No open positions."); return; }
        const cur = config.management.solMode ? "◎" : "$";
        const lines = positions.map((p, i) => {
          const pnlDecimals = config.management.solMode ? 5 : 2;
          const pnl = p.pnl_usd >= 0 ? `+${cur}${formatDecimal(p.pnl_usd, pnlDecimals)}` : `-${cur}${formatDecimal(Math.abs(p.pnl_usd), pnlDecimals)}`;
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const oor = !p.in_range ? " ⚠️OOR" : "";
          return `${i + 1}. ${p.pair} | ${cur}${formatDecimal(p.total_value_usd, pnlDecimals)} | PnL: ${pnl} | fees: ${cur}${formatDecimal(p.unclaimed_fees_usd, pnlDecimals)} | ${age}${oor}`;
        });
        await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
        const pos = positions[idx];
        await sendMessage(`Closing ${pos.pair}...`);
        const result = await closePosition({ position_address: pos.position });
        if (result.success) {
          const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
          await notifyClose({
            pair: pos.pair,
            pnlUsd: result.pnl_usd ?? 0,
            pnlPct: result.pnl_pct ?? 0,
            pnlSol: result.pnl_sol,
            feesEarnedUsd: result.fees_earned_usd,
            feesEarnedSol: result.fees_earned_sol,
            deployedSol: result.deployed_sol,
            strategy: result.strategy,
            holdMinutes: result.minutes_held,
            reason: result.close_reason,
          });
          await sendMessage(`Close txs: ${closeTxs?.join(", ") || "n/a"}`);
          return;
        } else {
          await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
        }
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
    if (setMatch) {
      try {
        const idx = parseInt(setMatch[1]) - 1;
        const note = setMatch[2].trim();
        const { positions } = await getMyPositions({ force: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
        const pos = positions[idx];
        setPositionInstruction(pos.position, note);
        await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    busy = true;
    try {
      log("telegram", `Incoming: ${text}`);
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, { requireTool: true });
      appendHistory(text, content);
      await sendMessage(stripThink(content));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => { });
    } finally {
      busy = false;
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
      drainTelegramQueue().catch(() => {});
    }
  }

  startPolling(telegramHandler, telegramCallbackHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /screen        Run one screening cycle now
  /menu          Show Telegram config menu
  /config        Show current user-config values
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          console.log("\nLearning proposal created:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log(`\nProposal ${result.proposal?.id || ""} is pending Telegram approval.\n`);
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { requireTool: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
