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
import { evaluateScreeningGate, getPoolDetail, getTopCandidates, searchPoolsByMint, verifyLiveEntryGuards } from "./tools/screening.js";
import {
  config,
  formatRuntimeConfigSnapshot,
  reloadRuntimeConfig,
  computeDeployAmount,
} from "./config.js";
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
import { closedCandlesOnly, confirmSupertrendFromCandles, fetchKlineGMGN } from "./tools/chart-indicators.js";
import {
  calculateConfidence,
  getConfidenceSizing,
  rankConfidenceCandidates,
  runRankedCandidateAttempts,
} from "./confidence.js";
import { PositionCloseCoordinator } from "./position-close-coordinator.js";
import {
  calculateMomentum,
  calculateWeakMomentumFallback,
  fetchMomentumCandles,
  formatMomentumLog,
  validateMomentumCandles,
} from "./tools/momentum.js";
import { evaluateWhaleExit, selectAdaptivePnlPollIntervalMs } from "./tools/polling.js";
import {
  createCloseSnapshot,
  DEFAULT_CLOSE_SNAPSHOT_TTL_MS,
  parseFastCloseCommand,
  resolveCloseMatches,
  resolveSnapshotCloseIndex,
} from "./tools/telegram-close.js";
import { getGmgnPoolFees } from "./tools/gmgn.js";
import { fetchWithTimeout } from "./tools/http.js";
import {
  addToBlacklist,
  listBlacklist,
  parseBlacklistCommand,
  removeFromBlacklist,
  resolveBlacklistMint,
} from "./token-blacklist.js";
import { safeBuildEntrySnapshot } from "./journal.js";
import { buildDangerDrawdownDecision } from "./danger-exit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
log("config", `Effective entry config: ${formatRuntimeConfigSnapshot()}`);
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

function normalizeVolumeTvlThreshold(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
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
let _screeningBusySince = 0;
let _screeningRunId = 0;
let _shuttingDown = false;
const _autoCloseCoordinator = new PositionCloseCoordinator();
const _supertrendWarningCandles = new Map();
const _whaleGuardCheckedAt = new Map();
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function releaseStaleScreeningLock() {
  if (!_screeningBusy) return false;
  const maxMs = Math.max(60_000, Number(config.schedule.screeningWatchdogMs ?? 10 * 60_000));
  const ageMs = Date.now() - (_screeningBusySince || _screeningLastTriggered || Date.now());
  if (ageMs < maxMs) return false;

  const previousRunId = _screeningRunId;
  _screeningBusy = false;
  _screeningBusySince = 0;
  _screeningRunId += 1;
  log(
    "screening_watchdog",
    `Released stale screening lock after ${Math.round(ageMs / 1000)}s (run ${previousRunId})`
  );
  return true;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

function dangerElapsedMinutes(positionAddress) {
  const tracked = getTrackedPosition(positionAddress);
  if (!tracked?.danger_drawdown_since) return 0;
  const started = new Date(tracked.danger_drawdown_since).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 60_000));
}

function evaluateFastDangerHardExit(position) {
  const currentPnlPct = Number(position.pnl_pct);
  const tracked = getTrackedPosition(position.position);
  if (
    currentPnlPct <= -90 &&
    tracked?.amount_sol &&
    (position.total_value_usd ?? 0) > 0.01
  ) {
    return null;
  }

  const decision = buildDangerDrawdownDecision({
    currentPnlPct,
    dangerPct: Number(config.management.dangerDrawdownPct),
    hardClosePct: Number(config.management.dangerHardClosePct),
    graceExpired: false,
  });
  return decision?.action === "DANGER_DRAWDOWN" ? decision : null;
}

async function evaluateDangerDrawdownExit(position) {
  const currentPnlPct = Number(position.pnl_pct);
  const dangerPct = Number(config.management.dangerDrawdownPct);
  if (!Number.isFinite(currentPnlPct) || !Number.isFinite(dangerPct) || currentPnlPct > dangerPct) {
    return null;
  }
  const tracked = getTrackedPosition(position.position);
  if (
    currentPnlPct <= -90 &&
    tracked?.amount_sol &&
    (position.total_value_usd ?? 0) > 0.01
  ) {
    log("cron_warn", `Danger check skipped for ${position.pair}: suspect PnL ${currentPnlPct.toFixed(2)}%`);
    return null;
  }

  const hardClosePct = Number(config.management.dangerHardClosePct);
  const hardCloseDecision = buildDangerDrawdownDecision({
    currentPnlPct,
    dangerPct,
    hardClosePct,
    graceExpired: false,
  });
  if (hardCloseDecision?.action === "DANGER_DRAWDOWN") {
    return {
      action: hardCloseDecision.action,
      reason: hardCloseDecision.reason,
    };
  }

  const graceMinutes = Number(config.management.dangerGraceMinutes ?? 5);
  const elapsed = dangerElapsedMinutes(position.position);
  const graceExpired = Number.isFinite(graceMinutes) && graceMinutes > 0 && elapsed >= graceMinutes;

  if (!position.base_mint) {
    if (graceExpired) {
      return {
        action: "DANGER_GRACE",
        reason: `Danger drawdown: PnL ${currentPnlPct.toFixed(2)}% still <= ${dangerPct}% after ${elapsed}m`,
      };
    }
    return null;
  }

  try {
    const detail = await getPoolDetail({ pool_address: position.pool, timeframe: "5m" });
    const pool = poolDetailToGatePool(detail, { mint: position.base_mint, symbol: position.pair });
    const feeActiveTvlRatio =
      finiteNumberOrNull(pool.fee_active_tvl_ratio)
      ?? finiteNumberOrNull(tracked?.fee_tvl_ratio)
      ?? finiteNumberOrNull(tracked?.initial_fee_tvl_24h)
      ?? finiteNumberOrNull(position.fee_per_tvl_24h);
    const volatility =
      finiteNumberOrNull(pool.volatility)
      ?? finiteNumberOrNull(tracked?.volatility)
      ?? finiteNumberOrNull(position.volatility);
    const fetched = await fetchMomentumCandles({
      mint: position.base_mint,
      maxRetries: config.momentum.maxRetries,
      retryDelayMs: config.momentum.retryDelayMs,
    });
    if (!fetched.success) {
      if (graceExpired) {
        return {
          action: "DANGER_GRACE",
          reason: `Danger drawdown: PnL ${currentPnlPct.toFixed(2)}% still <= ${dangerPct}% after ${elapsed}m; live signal unavailable (${fetched.errorType || "fetch_error"})`,
        };
      }
      log("cron_warn", `Danger check skipped for ${position.pair}: momentum candles unavailable (${fetched.errorType || "fetch_error"})`);
      return null;
    }

    const validated = validateMomentumCandles(fetched.candles, {
      maxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
    });
    if (!validated.valid) {
      if (graceExpired) {
        return {
          action: "DANGER_GRACE",
          reason: `Danger drawdown: PnL ${currentPnlPct.toFixed(2)}% still <= ${dangerPct}% after ${elapsed}m; live signal stale (${validated.reason})`,
        };
      }
      log("cron_warn", `Danger check skipped for ${position.pair}: stale momentum (${validated.reason})`);
      return null;
    }

    const interval = config.chartIndicators.exitInterval || config.chartIndicators.interval || "15m";
    const supertrendCandles = await fetchKlineGMGN(position.base_mint, interval, 80);
    const closedCandles = closedCandlesOnly(supertrendCandles, interval);
    const supertrend = confirmSupertrendFromCandles(closedCandles, {
      interval,
      period: config.chartIndicators.stPeriod || 10,
      multiplier: config.chartIndicators.stMultiplier || 3,
    });

    let momentum = calculateMomentum({
      candles: fetched.candles,
      feeActiveTvlRatio,
      minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
      volatility,
      volumeChangePct: pool.volume_change_pct,
      strongThreshold: config.momentum.strongThreshold,
      strongMinBins: config.momentum.strongMinBins,
      strongMaxBins: config.momentum.strongMaxBins,
      weakMinBins: config.momentum.weakMinBins,
      weakMaxBins: config.momentum.weakMaxBins,
      tokenAgeHours: pool.token_age_hours,
      ageBands: {
        newMaxHours: config.momentum.ageNewMaxHours,
        youngMaxHours: config.momentum.ageYoungMaxHours,
        matureMaxHours: config.momentum.ageMatureMaxHours,
        newMinBins: config.momentum.newMinBins,
        newMaxBins: config.momentum.newMaxBins,
        youngMinBins: config.momentum.youngMinBins,
        youngMaxBins: config.momentum.youngMaxBins,
        matureMinBins: config.momentum.matureMinBins,
        matureMaxBins: config.momentum.matureMaxBins,
        oldMinBins: config.momentum.oldMinBins,
        oldMaxBins: config.momentum.oldMaxBins,
      },
      maxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
    });
    if (!momentum.valid) {
      momentum = calculateWeakMomentumFallback({
        validatedCandles: validated,
        volatility,
        weakMinBins: config.momentum.weakMinBins,
        weakMaxBins: config.momentum.weakMaxBins,
        tokenAgeHours: pool.token_age_hours,
        ageBands: {
          newMaxHours: config.momentum.ageNewMaxHours,
          youngMaxHours: config.momentum.ageYoungMaxHours,
          matureMaxHours: config.momentum.ageMatureMaxHours,
          newMinBins: config.momentum.newMinBins,
          newMaxBins: config.momentum.newMaxBins,
          youngMinBins: config.momentum.youngMinBins,
          youngMaxBins: config.momentum.youngMaxBins,
          matureMinBins: config.momentum.matureMinBins,
          matureMaxBins: config.momentum.matureMaxBins,
          oldMinBins: config.momentum.oldMinBins,
          oldMaxBins: config.momentum.oldMaxBins,
        },
        reason: `danger_momentum_fallback: ${momentum.reason}`,
      });
    }

    const badReasons = [];
    const signalNotes = [];
    if (!supertrend.confirmed) badReasons.push(`Supertrend ${supertrend.direction || "block"}: ${supertrend.reason}`);

    const momentumScore = finiteNumberOrNull(momentum.score);
    const minMomentum = Number(config.management.dangerCloseMomentumBelow ?? 40);
    if (momentumScore != null && Number.isFinite(minMomentum) && momentumScore < minMomentum) {
      badReasons.push(`momentum ${momentumScore} < ${minMomentum}`);
    } else if (momentumScore == null) {
      signalNotes.push(`momentum unavailable (${momentum.reason || "no score"})`);
    }

    const priceChange5m = finiteNumberOrNull(momentum.priceChange5m);
    const minPriceChange = Number(config.management.dangerClosePriceChange5mPct ?? -1);
    if (priceChange5m != null && Number.isFinite(minPriceChange) && priceChange5m <= minPriceChange) {
      badReasons.push(`price change 5m ${priceChange5m.toFixed(2)}% <= ${minPriceChange}%`);
    }

    const dangerDecision = buildDangerDrawdownDecision({
      currentPnlPct,
      dangerPct,
      hardClosePct,
      graceExpired,
      elapsed,
      badReasons,
      signalNotes,
    });
    if (dangerDecision?.action === "DANGER_DRAWDOWN") {
      return dangerDecision;
    }
    if (dangerDecision?.action === "DANGER_HOLD") {
      log("state", `${dangerDecision.reason}; elapsed ${elapsed}m/${graceMinutes}m`);
      return null;
    }

    log(
      "state",
      `Danger hold for ${position.pair}: PnL ${currentPnlPct.toFixed(2)}%, momentum ${momentumScore ?? `unavailable (${momentum.reason || "no score"})`}, Supertrend ${supertrend.direction || "?"} ${interval}, elapsed ${elapsed}m/${graceMinutes}m`
    );
    return null;
  } catch (error) {
    if (graceExpired) {
      return {
        action: "DANGER_GRACE",
        reason: `Danger drawdown: PnL ${currentPnlPct.toFixed(2)}% still <= ${dangerPct}% after ${elapsed}m; live check failed (${error.message})`,
      };
    }
    log("cron_warn", `Danger check failed for ${position.pair}: ${error.message}`);
    return null;
  }
}

async function evaluateAutoExit(position) {
  if (config.management.whaleGuardEnabled) {
    try {
      const cooldownMs = Math.max(0, Number(config.management.whaleGuardCooldownMin ?? 30)) * 60_000;
      const lastCheckedAt = _whaleGuardCheckedAt.get(position.pool) || 0;
      if (Date.now() - lastCheckedAt >= cooldownMs) {
        _whaleGuardCheckedAt.set(position.pool, Date.now());
        const poolUrl = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${position.pool}`)}&timeframe=5m`;
        const poolRes = await fetchWithTimeout(poolUrl);
        if (poolRes.ok) {
          const poolData = await poolRes.json();
          const poolDetail = (poolData.data || [])[0];
          if (poolDetail) {
            const currentTvl = poolDetail.active_tvl ?? poolDetail.tvl ?? 0;
            const previous = getPoolTvl(position.pool);
            updatePoolTvl(position.pool, currentTvl);
            const whaleExit = evaluateWhaleExit({ previous, currentTvl, position, management: config.management });
            if (whaleExit) return whaleExit;
          }
        }
      }
    } catch (error) {
      log("cron_warn", `Whale check failed for ${position.pool.slice(0, 8)}: ${error.message}`);
    }
  }

  const coreExit = updatePnlAndCheckExits(position.position, position, config.management);
  if (coreExit) return coreExit;

  const dangerExit = await evaluateDangerDrawdownExit(position);
  if (dangerExit) return dangerExit;

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
        upperPrice: tracked?.signal_snapshot?.decision?.signal?.upper_price
          ?? tracked?.signal_snapshot?.upperPrice,
        lowerPrice: tracked?.signal_snapshot?.decision?.signal?.lower_price
          ?? tracked?.signal_snapshot?.lowerPrice,
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

function isAutoCloseInFlight(positionAddress) {
  return _autoCloseCoordinator.has(positionAddress);
}

function formatCloseChoices(matches) {
  return matches.map((position, index) => {
    const pnl = position.pnl_usd != null
      ? ` | PnL: ${position.pnl_usd >= 0 ? "+" : ""}$${formatDecimal(position.pnl_usd, 2)}`
      : "";
    const age = position.age_minutes != null ? ` | ${position.age_minutes}m` : "";
    return `${position._closeIndex || index + 1}. ${position.pair || position.pool_name || position.position}${pnl}${age}`;
  }).join("\n");
}

function parseFastCheckCommand(text) {
  const match = String(text || "").trim().match(/^\/?(?:cek|check|inspect|info)\s+(\S+)$/i);
  if (!match) return null;
  const target = match[1].trim();
  if (!SOLANA_ADDRESS_RE.test(target)) return null;
  return target;
}

function isDirectTelegramCommand(text) {
  const trimmed = String(text || "").trim();
  return (
    /^\/?(?:screen|menu|config|learning|briefing|positions)$/i.test(trimmed) ||
    /^\/?(?:close|exit|sell)\s+(?:all|semua)$/i.test(trimmed) ||
    /^\/close\s+\d+$/i.test(trimmed) ||
    /^\/set\s+\S+\s+.+$/i.test(trimmed) ||
    /^\/?(?:ask|agent)\s+.+$/i.test(trimmed)
  );
}

function parseExplicitTelegramLlmCommand(text) {
  const match = String(text || "").trim().match(/^\/?(?:ask|agent)\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function isDeployQuestion(text) {
  const normalized = String(text || "").toLowerCase();
  return /\bdeploy\b/.test(normalized) && /\b(kenapa|knp|why|kok|ga|gak|nggak|tidak|belum)\b/.test(normalized);
}

function parseDeployQuestionTarget(text) {
  if (!isDeployQuestion(text)) return null;
  const match = String(text || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  return match?.[0] || null;
}

function poolAddressOf(rawPool) {
  return rawPool?.address || rawPool?.pool_address || rawPool?.poolAddress || rawPool?.pool || rawPool?.id || null;
}

function numberValue(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function poolDetailToGatePool(detail, token) {
  const activeTvl = numberValue(detail.active_tvl ?? detail.tvl);
  const feeWindow = numberValue(detail.fee);
  const feeTvl = numberValue(detail.fee_active_tvl_ratio)
    ?? (activeTvl > 0 && feeWindow != null ? (feeWindow / activeTvl) * 100 : null);
  return {
    pool: detail.pool_address,
    name: detail.name,
    quote: {
      symbol: detail.token_y?.symbol,
      mint: detail.token_y?.address,
    },
    base: {
      symbol: detail.token_x?.symbol || token?.symbol,
      mint: detail.token_x?.address || token?.mint,
    },
    active_tvl: activeTvl,
    volume_window: numberValue(detail.volume),
    organic_score: numberValue(detail.token_x?.organic_score ?? token?.organic_score),
    mcap: numberValue(detail.token_x?.market_cap ?? token?.mcap),
    bin_step: numberValue(detail.dlmm_params?.bin_step),
    fee_active_tvl_ratio: feeTvl != null ? Number(feeTvl.toFixed(4)) : null,
    volatility: numberValue(detail.volatility),
    volume_change_pct: numberValue(detail.volume_change_pct),
    token_age_hours: detail.token_x?.created_at
      ? Math.floor((Date.now() - Number(detail.token_x.created_at)) / 3_600_000)
      : null,
    pool_fees_sol: null,
    pool_fees_source: null,
    pool_fees_timeframe: null,
    pool_fees_unit: null,
    ath: null,
    current_price: numberValue(detail.pool_price),
  };
}

function formatGateMetrics(pool) {
  const volumeTvl = pool.active_tvl > 0 && pool.volume_window != null
    ? pool.volume_window / pool.active_tvl
    : null;
  const minVolumeTvl = normalizeVolumeTvlThreshold(config.screening.minVolumeToActiveTvlRatio);
  return [
    `TVL: $${formatDecimal(pool.active_tvl, 0)} (min $${config.screening.minTvl})`,
    `Volume: $${formatDecimal(pool.volume_window, 0)} (min $${config.screening.minVolume})`,
    `Volume/TVL: ${volumeTvl == null ? "?" : `${formatDecimal(volumeTvl * 100, 2)}%`} (min ${minVolumeTvl == null ? "off" : `${formatDecimal(minVolumeTvl * 100, 2)}%`})`,
    `Fee/TVL: ${formatDecimal(pool.fee_active_tvl_ratio, 4)}% (min ${config.screening.minFeeActiveTvlRatio}%)`,
    `Pool fees: ${pool.pool_fees_sol ?? "?"} SOL (min ${config.screening.minTokenFeesSol})`,
    `Organic: ${formatDecimal(pool.organic_score, 0)} (min ${config.screening.minOrganic})`,
    `Mcap: $${formatDecimal(pool.mcap, 0)} (${config.screening.minMcap}-${config.screening.maxMcap})`,
    `Bin step: ${pool.bin_step ?? "?"} (${config.screening.minBinStep}-${config.screening.maxBinStep})`,
    `Volatility: ${formatDecimal(pool.volatility, 2)}`,
    `Token age: ${pool.token_age_hours ?? "?"}h`,
  ].join("\n");
}

async function evaluateLiveDeploySignals(pool) {
  const blockers = [];
  const lines = [];

  const smartWallets = await checkSmartWalletsOnPool({ pool_address: pool.pool }).catch((error) => ({
    in_pool: [],
    error: error.message,
  }));
  const confidence = calculateConfidence(pool, smartWallets, config.confidence);
  const sizing = getConfidenceSizing(confidence.total, config.management.deployAmountSol, config.confidence);
  lines.push(`Confidence: ${confidence.total} (${sizing.action}) | vol ${confidence.volatility_score}/40, fee ${confidence.fee_active_tvl_score}/40, smart ${confidence.smart_wallet_score}/20`);
  if (sizing.action === "skip") {
    blockers.push(`confidence ${confidence.total} < ${config.confidence.skipThreshold}`);
  }
  if (smartWallets.error) lines.push(`Smart wallets: lookup failed (${smartWallets.error})`);

  const fetched = await fetchMomentumCandles({
    mint: pool.base?.mint,
    maxRetries: config.momentum.maxRetries,
    retryDelayMs: config.momentum.retryDelayMs,
  });
  if (!fetched.success) {
    blockers.push(`momentum candles unavailable: ${fetched.errorType || "error"} ${fetched.error || ""}`.trim());
    lines.push(`Supertrend: not checked (candles unavailable)`);
    lines.push(`Momentum: not checked (candles unavailable)`);
    return { blockers, lines, confidence, sizing, momentum: null, supertrend: null };
  }

  const validated = validateMomentumCandles(fetched.candles, {
    maxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
  });
  if (!validated.valid) {
    blockers.push(`momentum snapshot stale: ${validated.reason}`);
    lines.push(`Supertrend: not checked (${validated.reason})`);
    lines.push(`Momentum: stale (${validated.reason})`);
    return { blockers, lines, confidence, sizing, momentum: validated, supertrend: null };
  }

  const {
    closedCandlesOnly,
    confirmSupertrendFromCandles,
    evaluateEntrySupertrend,
  } = await import("./tools/chart-indicators.js");
  const entryInterval = config.chartIndicators.entryInterval || config.chartIndicators.interval || "5m";
  const closedCandles = closedCandlesOnly(fetched.candles, entryInterval);
  const supertrend = evaluateEntrySupertrend(confirmSupertrendFromCandles(closedCandles, {
    interval: entryInterval,
    period: config.chartIndicators.stPeriod || 10,
    multiplier: config.chartIndicators.stMultiplier || 3,
  }), {
    entryPreset: config.chartIndicators.entryPreset,
    ath: pool.ath,
    athFilterPct: config.screening.athFilterPct,
    minPriceChangePct: config.chartIndicators.entryMinPriceChangePct,
  });
  lines.push(`Supertrend: ${supertrend.confirmed ? "PASS" : "BLOCK"} - ${supertrend.reason}`);
  if (!supertrend.confirmed) blockers.push(`Supertrend: ${supertrend.reason}`);

  let momentum = calculateMomentum({
    candles: fetched.candles,
    feeActiveTvlRatio: pool.fee_active_tvl_ratio,
    minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
    volatility: pool.volatility,
    volumeChangePct: pool.volume_change_pct,
    strongThreshold: config.momentum.strongThreshold,
    strongMinBins: config.momentum.strongMinBins,
    strongMaxBins: config.momentum.strongMaxBins,
    weakMinBins: config.momentum.weakMinBins,
    weakMaxBins: config.momentum.weakMaxBins,
    tokenAgeHours: pool.token_age_hours,
    ageBands: {
      newMaxHours: config.momentum.ageNewMaxHours,
      youngMaxHours: config.momentum.ageYoungMaxHours,
      matureMaxHours: config.momentum.ageMatureMaxHours,
      newMinBins: config.momentum.newMinBins,
      newMaxBins: config.momentum.newMaxBins,
      youngMinBins: config.momentum.youngMinBins,
      youngMaxBins: config.momentum.youngMaxBins,
      matureMinBins: config.momentum.matureMinBins,
      matureMaxBins: config.momentum.matureMaxBins,
      oldMinBins: config.momentum.oldMinBins,
      oldMaxBins: config.momentum.oldMaxBins,
    },
    maxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
  });
  if (!momentum.valid) {
    momentum = calculateWeakMomentumFallback({
      validatedCandles: validated,
      volatility: pool.volatility,
      weakMinBins: config.momentum.weakMinBins,
      weakMaxBins: config.momentum.weakMaxBins,
      tokenAgeHours: pool.token_age_hours,
      ageBands: {
        newMaxHours: config.momentum.ageNewMaxHours,
        youngMaxHours: config.momentum.ageYoungMaxHours,
        matureMaxHours: config.momentum.ageMatureMaxHours,
        newMinBins: config.momentum.newMinBins,
        newMaxBins: config.momentum.newMaxBins,
        youngMinBins: config.momentum.youngMinBins,
        youngMaxBins: config.momentum.youngMaxBins,
        matureMinBins: config.momentum.matureMinBins,
        matureMaxBins: config.momentum.matureMaxBins,
        oldMinBins: config.momentum.oldMinBins,
        oldMaxBins: config.momentum.oldMaxBins,
      },
      reason: `fast_explain_momentum_fallback: ${momentum.reason}`,
    });
  }
  const momentumScore = finiteNumberOrNull(momentum.score);
  lines.push(`Momentum: ${momentumScore ?? "unavailable"} (${momentum.classification}) | bins ${momentum.binsBelow ?? "?"}`);
  if (
    config.screening.minMomentumScore != null &&
    (momentumScore == null || momentumScore < Number(config.screening.minMomentumScore))
  ) {
    blockers.push(`momentum ${momentumScore ?? "unavailable"} < ${config.screening.minMomentumScore}`);
  }

  return { blockers, lines, confidence, sizing, momentum, supertrend };
}

async function explainWhyNoDeploy(target) {
  const tokenInfo = await getTokenInfo({ query: target }).catch((error) => ({ found: false, error: error.message }));
  const token = tokenInfo?.results?.[0] || null;
  const mint = token?.mint || target;
  const positionsResult = await getMyPositions({ force: true, silent: true }).catch(() => ({ positions: [], total_positions: 0 }));
  const positionFailures = [];
  if ((positionsResult.total_positions || 0) >= config.risk.maxPositions) {
    positionFailures.push(`max positions reached: ${positionsResult.total_positions}/${config.risk.maxPositions}`);
  }
  if (positionsResult.positions?.some((p) => p.base_mint === mint)) {
    positionFailures.push("already holding same base mint");
  }

  const rawPools = SOLANA_ADDRESS_RE.test(target)
    ? await searchPoolsByMint(target).catch(() => [])
    : [];
  const poolAddresses = [
    target,
    ...rawPools.map(poolAddressOf).filter(Boolean),
  ].filter((addr, index, arr) => SOLANA_ADDRESS_RE.test(addr) && arr.indexOf(addr) === index);

  const details = [];
  for (const address of poolAddresses.slice(0, 4)) {
    const detail = await getPoolDetail({ pool_address: address, timeframe: config.screening.timeframe }).catch(() => null);
    if (detail) details.push(detail);
  }

  if (!details.length) {
    return [
      `Deploy check: ${token?.symbol || target}`,
      `Mint: ${mint}`,
      tokenInfo?.error ? `Token lookup error: ${tokenInfo.error}` : null,
      "No Meteora DLMM pool detail found for this address/mint.",
      positionFailures.length ? `Position gate: ${positionFailures.join("; ")}` : null,
    ].filter(Boolean).join("\n");
  }

  const evaluated = await Promise.all(details.map(async (detail) => {
    const gatePool = poolDetailToGatePool(detail, token);
    const fees = await getGmgnPoolFees({ mint: gatePool.base?.mint || mint, pool_address: gatePool.pool });
    gatePool.pool_fees_sol = fees.pool_fees_sol;
    gatePool.pool_fees_source = fees.source;
    gatePool.pool_fees_timeframe = fees.timeframe || null;
    gatePool.pool_fees_unit = fees.pool_fees_sol != null ? "SOL" : null;
    gatePool.ath = fees.ath ?? null;
    if (fees.price != null) gatePool.current_price = fees.price;
    const gate = evaluateScreeningGate(gatePool, { tokenInfo: token });
    return { detail, gatePool, gate, fees };
  }));

  const best = evaluated.find((item) => item.gate.pass) || evaluated[0];
  const signal = best.gate.pass
    ? await evaluateLiveDeploySignals(best.gatePool).catch((error) => ({
        blockers: [`live signal check failed: ${error.message}`],
        lines: [`Signal check failed: ${error.message}`],
      }))
    : { blockers: [], lines: [] };
  const failures = [
    ...positionFailures,
    best.gate.pass ? null : best.gate.reason,
    best.fees?.error ? `fees lookup: ${best.fees.error}` : null,
    ...signal.blockers,
  ].filter(Boolean);

  return [
    `Deploy check: ${best.gatePool.name || token?.symbol || target}`,
    `Pool: ${best.gatePool.pool}`,
    `Mint: ${best.gatePool.base?.mint || mint}`,
    "",
    best.gate.pass && !failures.length
      ? "All checked gates pass right now. Kalau tetap tidak deploy saat screening, kemungkinan kandidat lain ranking lebih tinggi atau execution deploy sedang skip infrastruktur."
      : `Blocked: ${failures.join("; ")}`,
    "",
    formatGateMetrics(best.gatePool),
    signal.lines?.length ? ["", "Live Signal", ...signal.lines].join("\n") : null,
  ].filter((line) => line != null).join("\n");
}

function formatFastDeployStatus() {
  const s = config.screening;
  const c = config.confidence;
  return [
    "Fast status: deploy cuma jalan kalau hard gates lolos.",
    `Open limit: max ${config.risk.maxPositions} posisi.`,
    `Size: ${config.management.deployAmountSol} SOL fixed.`,
    `Confidence: ${c.enabled ? `ON, skip < ${c.skipThreshold}, full >= ${c.fullThreshold}` : "OFF"}.`,
    `Volume: min $${s.minVolume}, volume/TVL min ${s.minVolumeToActiveTvlRatio ?? "off"}.`,
    `Momentum: min ${s.minMomentumScore ?? "off"}, strong threshold ${config.momentum.strongThreshold}.`,
    `Supertrend: ${config.chartIndicators.enabled ? "ON" : "OFF"}.`,
    "Pakai /screen untuk paksa screening sekarang, /positions untuk posisi, /ask <teks> kalau memang mau LLM.",
  ].join("\n");
}

function formatTokenCheckResult(target, tokenInfo, poolDetail, poolError) {
  const token = tokenInfo?.results?.[0] || null;
  const audit = token?.audit || {};
  const poolLines = poolDetail
    ? [
        "",
        "Pool",
        `Name: ${poolDetail.name || "?"}`,
        `TVL: $${formatDecimal(poolDetail.active_tvl ?? poolDetail.tvl, 2)}`,
        `Volume: $${formatDecimal(poolDetail.volume, 2)} (${config.screening.timeframe})`,
        `Fee/TVL: ${formatDecimal(poolDetail.fee_active_tvl_ratio, 4)}%`,
        `Bin step: ${poolDetail.dlmm_params?.bin_step ?? "?"}`,
      ]
    : poolError
      ? ["", `Pool: not found (${poolError})`]
      : [];

  if (!token) {
    return [
      `Fast check: ${target}`,
      "Token: not found in Jupiter assets search",
      ...poolLines,
    ].join("\n");
  }

  return [
    `Fast check: ${token.symbol || "UNKNOWN"}${token.name ? ` (${token.name})` : ""}`,
    `Mint: ${token.mint}`,
    `Price: $${formatDecimal(token.price, 8)}`,
    `Mcap: $${formatDecimal(token.mcap, 0)}`,
    `Liquidity: $${formatDecimal(token.liquidity, 0)}`,
    `Holders: ${formatDecimal(token.holders, 0)}`,
    `Organic: ${token.organic_score ?? "?"} (${token.organic_label || "?"})`,
    `Launchpad: ${token.launchpad || "?"}`,
    `Audit: mint ${audit.mint_disabled ? "disabled" : "open/?"}, freeze ${audit.freeze_disabled ? "disabled" : "open/?"}, top10 ${audit.top_holders_pct ?? "?"}%, bots ${audit.bot_holders_pct ?? "?"}%`,
    token.stats_1h
      ? `1h: price ${token.stats_1h.price_change ?? "?"}%, buy $${token.stats_1h.buy_vol ?? "?"}, sell $${token.stats_1h.sell_vol ?? "?"}, net buyers ${token.stats_1h.net_buyers ?? "?"}`
      : null,
    ...poolLines,
  ].filter(Boolean).join("\n");
}

async function executeFastCheck(target) {
  log("telegram", `Fast check: ${target}`);
  const [tokenInfo, poolResult] = await Promise.all([
    getTokenInfo({ query: target }).catch((error) => ({ found: false, error: error.message })),
    resolveFastCheckPool(target)
      .then((pool) => ({ pool }))
      .catch((error) => ({ error: error.message })),
  ]);
  return formatTokenCheckResult(target, tokenInfo, poolResult.pool, poolResult.error);
}

async function resolveFastCheckPool(target) {
  try {
    return await getPoolDetail({ pool_address: target, timeframe: config.screening.timeframe });
  } catch (directError) {
    const pools = await searchPoolsByMint(target);
    const best = pools
      .filter((pool) => {
        const name = String(pool?.name || "").toUpperCase();
        const quoteMint = pool?.mint_y || pool?.token_y?.address;
        const quoteSymbol = String(pool?.token_y?.symbol || "").toUpperCase();
        return name.endsWith("-SOL") ||
          quoteMint === config.tokens.SOL ||
          quoteSymbol === "SOL";
      })
      .sort((a, b) => Number(b?.tvl || b?.liquidity || 0) - Number(a?.tvl || a?.liquidity || 0))[0]
      || pools.sort((a, b) => Number(b?.tvl || b?.liquidity || 0) - Number(a?.tvl || a?.liquidity || 0))[0];
    const poolAddress = poolAddressOf(best);
    if (!poolAddress) throw directError;
    return getPoolDetail({ pool_address: poolAddress, timeframe: config.screening.timeframe });
  }
}

async function executeTelegramClose(position, reason = "telegram fast close") {
  const label = position.pair || position.pool_name || position.position;
  const locked = await _autoCloseCoordinator.run(position.position, async () => {
    try {
      log("close", `Telegram fast close: ${label} (${position.position})`);
      await sendMessage(`Closing ${label}...`);
      const result = await closePosition({
        position_address: position.position,
        reason,
      });

      if (!(result.success || result.dry_run)) {
        await sendMessage(`Close failed: ${result.error || JSON.stringify(result)}`);
        return result;
      }

      let autoSwap = null;
      if (result.success && result.base_mint) {
        autoSwap = await autoSwapBaseToSol(result.base_mint, "telegram close").catch((error) => ({
          swapped: false,
          error: error.message,
        }));
      }

      await notifyClose({
        pair: label,
        pnlUsd: result.pnl_usd ?? 0,
        pnlPct: result.pnl_pct ?? 0,
        pnlSol: result.pnl_sol,
        feesEarnedUsd: result.fees_earned_usd,
        feesEarnedSol: result.fees_earned_sol,
        deployedSol: result.deployed_sol,
        strategy: result.strategy,
        holdMinutes: result.minutes_held,
        reason: result.close_reason || reason,
      });

      const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
      const swapLine = autoSwap?.swapped
        ? "\nAuto-swap: done"
        : autoSwap?.error
          ? `\nAuto-swap failed: ${autoSwap.error}`
          : "";
      await sendMessage(`Close txs: ${closeTxs?.join(", ") || "n/a"}${swapLine}`);
      return { ...result, auto_swap: autoSwap };
    } catch (error) {
      log("close_error", `Telegram fast close failed for ${label}: ${error.message}`);
      await sendMessage(`Close failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  if (!locked.acquired) {
    log("close", `Duplicate telegram close ignored for ${label}`);
    await sendMessage(`Close already in progress for ${label}.`);
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
  if (_cronTasks._pnlPollInterval) clearTimeout(_cronTasks._pnlPollInterval);
  if (_cronTasks._pnlSlowCheckInterval) clearInterval(_cronTasks._pnlSlowCheckInterval);
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
  if (_autoCloseCoordinator.size > 0) {
    log("bottom_spot", `Deploy skipped - ${_autoCloseCoordinator.size} priority close(s) in progress`);
    return { deployed: false, report: "Bottom Spot deploy skipped while priority close is in progress." };
  }

  const liveEntry = await verifyLiveEntryGuards({
    poolAddress: selectedPool.pool.pool,
    mint: selectedPool.pool.base?.mint,
  }, {
    feesSnapshot: {
      pool_fees_sol: selectedPool.pool.pool_fees_sol,
      source: selectedPool.pool.pool_fees_source,
      timeframe: selectedPool.pool.pool_fees_timeframe,
      price: selectedPool.pool.gmgn_price,
      ath: selectedPool.pool.ath,
      price_vs_ath_pct: selectedPool.pool.price_vs_ath_pct,
    },
  });
  if (!liveEntry.pass) {
    log("bottom_spot", `Final live entry guard: dropped ${selectedPool.pool.name} - ${liveEntry.reason}`);
    return {
      deployed: false,
      report: `Bottom Spot deploy skipped: ${liveEntry.reason}`,
    };
  }
  deployParams.signal_snapshot = safeBuildEntrySnapshot({
    pool: {
      ...selectedPool.pool,
      pool_fees_sol: liveEntry.fees.pool_fees_sol,
      pool_fees_source: liveEntry.fees.source,
      pool_fees_timeframe: liveEntry.fees.timeframe || null,
      price_vs_ath_pct: liveEntry.price?.price_vs_ath_pct
        ?? selectedPool.pool.price_vs_ath_pct,
      ath: liveEntry.price?.ath ?? selectedPool.pool.ath,
    },
    tokenInfo: selectedPool.candidate?.ti,
    smartWallets: selectedPool.candidate?.sw,
    activeConfig: config,
    decision: {
      strategy: deployParams.strategy,
      strategy_label: deployParams.strategy_label,
      amount_sol: amountSol,
      sizing_action: "bottom_spot_fixed",
      bins_below: deployParams.bins_below,
      bins_above: deployParams.bins_above,
      reason: selectedPool.reason,
      signal: {
        dump_pct: selectedPool.signal.dumpPct,
        retrace_pct: selectedPool.signal.retracePct,
        ath_price: selectedPool.signal.athPrice,
        dump_low: selectedPool.signal.dumpLow,
        current_price: selectedPool.signal.currentPrice,
        lower_price: selectedPool.binRange.lowerPrice,
        upper_price: selectedPool.binRange.upperPrice,
      },
    },
  });

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

async function attemptStandardDeploy(candidate, deployAmount) {
  const { pool, sw, ti, activeBin, confidence } = candidate;
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
    return {
      status: "failed",
      report: [
        `SKIPPED: ${pool.name}`,
        `Confidence: ${confidence.total}% (< ${config.confidence.skipThreshold}%)`,
        `Volatility score: ${confidence.volatility_score}/40`,
        `Fee/Active TVL score: ${confidence.fee_active_tvl_score}/40`,
        `Smart wallet score: ${confidence.smart_wallet_score}/20`,
      ].join("\n"),
    };
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
    return { status: "failed", report: `Deploy skipped: ${reason}` };
  }

  const freshCandles = validateMomentumCandles(pool.momentum_candles, {
    maxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
  });
  if (!freshCandles.valid) {
    const reason = `momentum snapshot no longer fresh: ${freshCandles.reason}`;
    log("momentum", formatMomentumLog({
      pool: pool.pool,
      mint: pool.base?.mint,
      result: { ...momentum, ...freshCandles },
      gmgnAttempt: pool.momentum_gmgn_attempt,
      poolFeesSol: pool.pool_fees_sol,
      poolFeesSource: pool.pool_fees_source,
      feeTimeframe: pool.pool_fees_timeframe,
      decision: "skip",
      reason,
    }));
    return { status: "failed", report: `Deploy skipped: ${reason}` };
  }

  const minMomentumScore = config.screening.minMomentumScore;
  const momentumScore = finiteNumberOrNull(momentum.score);
  if (
    minMomentumScore != null &&
    (momentumScore == null || momentumScore < Number(minMomentumScore))
  ) {
    const scoreText = momentumScore ?? "unavailable";
    const reason = `Momentum score ${scoreText} < min ${minMomentumScore}`;
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
    return { status: "failed", report: `Deploy skipped: ${reason}` };
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
    reason: pool.supertrend_reason || "bullish Supertrend confirmed",
  }));

  if (_autoCloseCoordinator.size > 0) {
    log("screening", `Deploy skipped - ${_autoCloseCoordinator.size} priority close(s) in progress`);
    return { status: "failed", report: "Deploy skipped while priority close is in progress." };
  }

  const liveEntry = await verifyLiveEntryGuards({
    poolAddress: pool.pool,
    mint: pool.base?.mint,
  }, {
    feesSnapshot: {
      pool_fees_sol: pool.pool_fees_sol,
      source: pool.pool_fees_source,
      timeframe: pool.pool_fees_timeframe,
      price: pool.gmgn_price,
      ath: pool.ath,
      price_vs_ath_pct: pool.price_vs_ath_pct,
    },
  });
  if (!liveEntry.pass) {
    log("screening", `Final live entry guard: dropped ${pool.name} - ${liveEntry.reason}`);
    return { status: "failed", report: `Deploy skipped: ${liveEntry.reason}` };
  }

  pool.pool_fees_sol = liveEntry.fees.pool_fees_sol;
  pool.pool_fees_source = liveEntry.fees.source;
  pool.pool_fees_timeframe = liveEntry.fees.timeframe || null;
  if (liveEntry.price) {
    pool.price_vs_ath_pct = liveEntry.price.price_vs_ath_pct;
    pool.ath = liveEntry.price.ath;
  }

  const deployArgs = {
    pool_address: pool.pool,
    amount_sol: sizing.amount,
    strategy: config.strategy.strategy,
    bins_below,
    bins_above: 0,
    pool_name: pool.name,
    bin_step: pool.bin_step,
    base_fee: pool.fee_pct,
    fee_tvl_ratio: pool.fee_active_tvl_ratio,
    volume: pool.volume_window,
    volatility: pool.volatility,
    organic_score: pool.organic_score,
    base_mint: pool.base?.mint,
    momentum,
    signal_snapshot: safeBuildEntrySnapshot({
      pool,
      tokenInfo: ti,
      smartWallets: sw,
      activeConfig: config,
      decision: {
        strategy: config.strategy.strategy,
        amount_sol: sizing.amount,
        sizing_action: sizing.action,
        bins_below,
        bins_above: 0,
        active_bin: activeBin,
        reason: "best candidate by confidence score; all hard gates passed",
        confidence,
        momentum,
      },
    }),
  };

  const deployStartedAt = Date.now();
  const deployResult = await deployPosition(deployArgs);
  logAction({
    tool: "deploy_position",
    args: deployArgs,
    result: deployResult,
    duration_ms: Date.now() - deployStartedAt,
    success: deployResult?.success === true || deployResult?.dry_run === true,
  });

  if (deployResult.code === "non_refundable_bin_cost") {
    log("screening", `Skipped ${pool.name}: avoided ${deployResult.avoided_cost_sol?.toFixed?.(8) ?? deployResult.avoided_cost_sol ?? 0} SOL non-refundable cost`);
    return { status: "non_refundable_bin_cost", deployResult };
  }
  if (!deployResult.success && !deployResult.dry_run) {
    return {
      status: "failed",
      report: `Decision: DEPLOY FAILED\npool: ${pool.name} | ${pool.pool}\nerror: ${deployResult.error || "Unknown error"}`,
    };
  }

  return {
    status: "success",
    candidate,
    sizing,
    momentum,
    deployResult,
  };
}

export async function runScreeningCycle({ silent = false, force = false } = {}) {
  if (_shuttingDown) {
    log("cron", "Screening skipped - shutdown in progress");
    return null;
  }
  releaseStaleScreeningLock();
  const runtimeReload = reloadRuntimeConfig();
  if (runtimeReload.error) {
    log("config_warn", `Runtime config reload failed: ${runtimeReload.error}`);
  } else if (runtimeReload.changes.length > 0) {
    const changedKeys = runtimeReload.changes.map((change) => change.key).join(", ");
    log("config", `Runtime config reloaded: ${changedKeys}`);
    log("config", `Effective entry config: ${formatRuntimeConfigSnapshot()}`);
  }
  if (_autoCloseCoordinator.size > 0) {
    log("cron", `Screening skipped - ${_autoCloseCoordinator.size} priority close(s) in progress`);
    return null;
  }
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  const recentScreeningCooldownMs = 60_000;
  const sinceLastScreeningMs = Date.now() - _screeningLastTriggered;
  if (!force && _screeningLastTriggered > 0 && sinceLastScreeningMs < recentScreeningCooldownMs) {
    log(
      "cron",
      `Screening skipped - last cycle started ${Math.ceil(sinceLastScreeningMs / 1000)}s ago`,
    );
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  const screeningRunId = ++_screeningRunId;
  _screeningBusySince = Date.now();
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      if (_screeningRunId === screeningRunId) {
        _screeningBusy = false;
        _screeningBusySince = 0;
      }
      return null;
    }
    const minimumMultiplier = config.confidence.enabled
      ? config.confidence.halfMultiplier
      : 1;
    const minRequired = (config.management.deployAmountSol * minimumMultiplier) + config.management.gasReserve;
    if (preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      if (_screeningRunId === screeningRunId) {
        _screeningBusy = false;
        _screeningBusySince = 0;
      }
      return null;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    if (_screeningRunId === screeningRunId) {
      _screeningBusy = false;
      _screeningBusySince = 0;
    }
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

    // Check at most five Meteora-ranked pools sequentially and stop on the
    // first candidate that passes the expensive GMGN-backed gates.
    let candidates = [];
    for (let rank = 0; rank < 5; rank++) {
      const result = await getTopCandidates({
        limit: 1,
        evaluationLimit: 1,
        evaluationOffset: rank,
      }).catch(() => null);
      const candidate = (result?.candidates || result?.pools || [])[0];
      if (candidate) {
        candidates = [candidate];
        log("screening", `Selected GMGN-verified candidate at Meteora rank ${rank + 1}`);
        break;
      }
      log("screening", `Meteora rank ${rank + 1} failed candidate gates; trying next rank`);
    }

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
    const ranked = rankConfidenceCandidates(indexed, config.confidence);
    const {
      selectedAttempt,
      failedAttempt,
      infrastructureSkips,
    } = await runRankedCandidateAttempts(
      ranked,
      (candidate) => attemptStandardDeploy(candidate, deployAmount),
    );
    if (failedAttempt) screenReport = failedAttempt.report;

    if (!selectedAttempt) {
      if (!screenReport) {
        const avoidedTotal = infrastructureSkips.reduce(
          (sum, item) => sum + Number(item.avoided_cost_sol || 0),
          0,
        );
        screenReport = [
          "No deploy: every eligible candidate required non-refundable bin infrastructure.",
          `Candidates skipped: ${infrastructureSkips.length}`,
          `Total non-refundable cost avoided: ${avoidedTotal.toFixed(8)} SOL`,
          ...infrastructureSkips.map((item) =>
            `${item.pool} | ${item.address} | avoided ${Number(item.avoided_cost_sol || 0).toFixed(8)} SOL`
          ),
        ].join("\n");
      }
      return screenReport;
    }

    const { candidate: best, sizing, momentum, deployResult } = selectedAttempt;
    const { pool, sw, n, ti, activeBin, idx: bestIdx, confidence } = best;

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
        infrastructureSkips.length > 0
          ? `Highest-ranked zero-cost candidate. ${infrastructureSkips.length} higher-ranked candidate(s) skipped for non-refundable bin cost.`
          : `Best candidate by confidence score. All configured hard gates passed.`,
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
    if (_screeningRunId === screeningRunId) {
      _screeningBusy = false;
      _screeningBusySince = 0;
    }
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

  // Adaptive poller — evaluates and directly executes deterministic auto-exits.
  let _pnlPollBusy = false;
  let _pnlPollTimer = null;
  let _pnlPollDelayMs = config.schedule.pnlPollIntervalMs;
  const pnlPollInterval = () => _pnlPollTimer;
  // Fast floor remains config.schedule.pnlPollIntervalMs; adaptive polling only lengthens safe periods.
  const scheduleNextPnlPoll = (delayMs) => {
    _pnlPollDelayMs = Math.max(1_000, delayMs);
    _pnlPollTimer = setTimeout(runPnlPoll, Math.max(1_000, delayMs));
    _pnlPollTimer.unref?.();
    if (_cronTasks) _cronTasks._pnlPollInterval = _pnlPollTimer;
  };
  const runPnlPoll = async () => {
    if (_pnlPollBusy) return;
    _pnlPollBusy = true;
    let nextDelayMs = config.schedule.pnlNoPositionPollIntervalMs;
    try {
      const trackedPositions = getTrackedPositions(true);
      if (trackedPositions.length === 0) {
        nextDelayMs = selectAdaptivePnlPollIntervalMs({
          trackedPositions,
          result: { positions: [] },
          schedule: config.schedule,
          management: config.management,
          getTracked: getTrackedPosition,
        });
        return;
      }
      const result = await getMyPositions({
        force: true,
        silent: true,
        liveOnly: true,
        urgent: _pnlPollDelayMs <= config.schedule.pnlPollIntervalMs,
      }).catch(() => null);
      nextDelayMs = selectAdaptivePnlPollIntervalMs({
        trackedPositions,
        result,
        schedule: config.schedule,
        management: config.management,
        getTracked: getTrackedPosition,
      });

      // Publish only a complete, current PnL snapshot.
      try {
        if (result && !result.stale) {
          const cachePath = path.join(__dirname, 'live-positions-cache.json');
          fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), positions: result.positions }));
        }
      } catch {}

      if (!result?.positions?.length || result.stale) return;
      const closeTasks = [];
      const exitResults = result.positions.map((p) =>
        updatePnlAndCheckExits(p.position, p, config.management)
      );
      const hardDangerResults = result.positions.map((p) => evaluateFastDangerHardExit(p));
      for (let i = 0; i < result.positions.length; i++) {
        const p = result.positions[i];
        if (isAutoCloseInFlight(p.position)) continue;
        const exit = hardDangerResults[i] || exitResults[i];
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
      scheduleNextPnlPoll(nextDelayMs);
    }
  };
  scheduleNextPnlPoll(1_000);

  let _pnlSlowCheckBusy = false;
  const pnlSlowCheckInterval = setInterval(async () => {
    if (_pnlSlowCheckBusy) return;
    _pnlSlowCheckBusy = true;
    try {
      const result = await getMyPositions({ silent: true }).catch(() => null);
      if (!result?.positions?.length || result.stale) return;
      const exits = await Promise.all(result.positions.map((position) => evaluateAutoExit(position)));
      const closeTasks = [];
      for (let index = 0; index < result.positions.length; index++) {
        if (isAutoCloseInFlight(result.positions[index].position)) continue;
        if (exits[index]) {
          closeTasks.push(executeAutoClose(result.positions[index], exits[index], "slow-poller"));
        }
      }
      if (closeTasks.length > 0) await Promise.allSettled(closeTasks);
    } finally {
      _pnlSlowCheckBusy = false;
    }
  }, Math.max(3_000, config.schedule.pnlSlowCheckIntervalMs));

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store timer refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = _pnlPollTimer;
  _cronTasks._pnlSlowCheckInterval = pnlSlowCheckInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  log("shutdown", `Received ${signal}. Shutting down...`);
  const forceTimer = setTimeout(() => {
    log("shutdown", `Forced exit after ${config.schedule.shutdownTimeoutMs}ms`);
    process.exit(1);
  }, Math.max(1_000, Number(config.schedule.shutdownTimeoutMs ?? 8_000)));
  forceTimer.unref?.();

  stopPolling();
  stopCronJobs();
  try {
    const positions = await withTimeout(
      getMyPositions({ urgent: true }),
      Math.max(1_000, Number(config.schedule.shutdownTimeoutMs ?? 8_000) - 1_000),
      "shutdown position snapshot"
    );
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } catch (error) {
    log("shutdown_warn", `Skipped position snapshot during shutdown: ${error.message}`);
  } finally {
    clearTimeout(forceTimer);
    process.exit(0);
  }
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
let _telegramCloseSnapshot = null;

function rememberTelegramCloseSnapshot(positions) {
  _telegramCloseSnapshot = createCloseSnapshot(positions);
}

function closeSnapshotErrorMessage(reason) {
  if (reason === "missing_snapshot" || reason === "stale_snapshot") {
    return "Close number expired. Send /positions again, then retry /close <n>.";
  }
  return "Invalid number. Use /positions first.";
}

async function handleTelegramBlacklistCommand(text) {
  const blacklistCommand = parseBlacklistCommand(text);
  if (!blacklistCommand) return false;

  try {
    if (blacklistCommand.action === "add") {
      const result = addToBlacklist(blacklistCommand);
      await sendMessage(
        result.already_blacklisted
          ? `${result.symbol || blacklistCommand.symbol} is already blacklisted.\nMint: ${blacklistCommand.mint}`
          : `Blacklisted ${blacklistCommand.symbol}.\nMint: ${blacklistCommand.mint}\nReason: ${blacklistCommand.reason}`
      );
      return true;
    }

    if (blacklistCommand.action === "remove") {
      const mint = resolveBlacklistMint(blacklistCommand.target);
      if (!mint) {
        await sendMessage(`Blacklist entry not found or symbol is ambiguous: ${blacklistCommand.target}`);
        return true;
      }
      const result = removeFromBlacklist({ mint });
      await sendMessage(`Removed ${result.was?.symbol || mint} from blacklist.\nMint: ${mint}`);
      return true;
    }

    const entries = listBlacklist();
    const lines = entries.blacklist.map((entry, index) =>
      `${index + 1}. ${entry.symbol || "UNKNOWN"} ${entry.mint}\n${entry.reason || "No reason"}`
    );
    await sendMessage(lines.length ? `Blacklist:\n\n${lines.join("\n\n")}` : "Blacklist is empty.");
  } catch (e) {
    await sendMessage(`Blacklist command failed: ${e.message}`).catch(() => {});
  }
  return true;
}

async function handleTelegramCloseCommand(text) {
  const closeNumber = String(text || "").trim().match(/^\/close\s+(\d+)$/i);
  if (closeNumber) {
    try {
      const resolved = resolveSnapshotCloseIndex(_telegramCloseSnapshot, closeNumber[1], {
        ttlMs: DEFAULT_CLOSE_SNAPSHOT_TTL_MS,
      });
      if (!resolved.ok) {
        await sendMessage(closeSnapshotErrorMessage(resolved.reason));
        return true;
      }
      await executeTelegramClose(resolved.position, "telegram /close number");
    } catch (e) {
      await sendMessage(`Close failed: ${e.message}`).catch(() => {});
    }
    return true;
  }

  const fastCloseCommand = parseFastCloseCommand(text);
  if (!fastCloseCommand) return false;

  try {
    const { positions = [], total_positions = 0 } = await getMyPositions({ force: true, urgent: true });
    if (total_positions === 0 || positions.length === 0) {
      await sendMessage("No open positions to close.");
      return true;
    }

    if (fastCloseCommand.closeAll) {
      await sendMessage(`Closing all ${positions.length} open position(s) sequentially...`);
      for (const position of positions.map((p, index) => ({ ...p, _closeIndex: index + 1 }))) {
        await executeTelegramClose(position, "telegram close all");
      }
      rememberTelegramCloseSnapshot([]);
      await sendMessage("Close all command finished.");
      return true;
    }

    const matches = fastCloseCommand.singleOpenPosition
      ? positions.map((position, index) => ({ ...position, _closeIndex: index + 1 }))
      : resolveCloseMatches(positions, fastCloseCommand.target);
    if (matches.length === 0) {
      await sendMessage(`No open position matched "${fastCloseCommand.target}". Use /positions or /close <n>.`);
      return true;
    }
    if (matches.length > 1) {
      await sendMessage(`Multiple positions matched${fastCloseCommand.target ? ` "${fastCloseCommand.target}"` : ""}. Use /close <n>:\n\n${formatCloseChoices(matches)}`);
      return true;
    }

    await executeTelegramClose(matches[0], fastCloseCommand.target
      ? `telegram fast close: ${fastCloseCommand.target}`
      : "telegram fast close: single open position");
  } catch (e) {
    await sendMessage(`Close failed: ${e.message}`).catch(() => {});
  }
  return true;
}

async function sendTelegramPositionsSnapshot() {
  const { positions, total_positions } = await getMyPositions({ force: true, urgent: true });
  if (total_positions === 0) {
    await sendMessage("No open positions.");
    return;
  }
  const cur = config.management.solMode ? "◎" : "$";
  const lines = positions.map((p, i) => {
    const pnlDecimals = config.management.solMode ? 5 : 2;
    const pnlValue = p.pnl_usd ?? p.pnl_sol ?? 0;
    const pnl = pnlValue >= 0
      ? `+${cur}${formatDecimal(pnlValue, pnlDecimals)}`
      : `-${cur}${formatDecimal(Math.abs(pnlValue), pnlDecimals)}`;
    const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
    const oor = !p.in_range ? " OOR" : "";
    return `${i + 1}. ${p.pair} | ${cur}${formatDecimal(p.total_value_usd, pnlDecimals)} | PnL: ${pnl} | fees: ${cur}${formatDecimal(p.unclaimed_fees_usd, pnlDecimals)} | ${age}${oor}`;
  });
  rememberTelegramCloseSnapshot(positions);
  await sendMessage(`Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /close all to close all`);
}

async function handleTelegramPositionsCommand(text) {
  if (!/^\/?(?:positions|posisi|position|status)$/i.test(String(text || "").trim())) return false;
  try {
    await sendTelegramPositionsSnapshot();
  } catch (e) {
    await sendMessage(`Error: ${e.message}`).catch(() => {});
  }
  return true;
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

let nonTtyPendingMenuEdit = null;

const CONFIDENCE_CONFIG_KEYS = {
  "confidence.enabled": "confidenceEnabled",
  "confidence.fullThreshold": "confidenceFullThreshold",
  "confidence.skipThreshold": "confidenceSkipThreshold",
  "confidence.halfMultiplier": "confidenceHalfMultiplier",
  "confidence.smartWalletMaxAgeMinutes": "smartWalletMaxAgeMinutes",
};

const CONFIDENCE_LIVE_FIELDS = {
  "confidence.enabled": "enabled",
  "confidence.fullThreshold": "fullThreshold",
  "confidence.skipThreshold": "skipThreshold",
  "confidence.halfMultiplier": "halfMultiplier",
  "confidence.smartWalletMaxAgeMinutes": "smartWalletMaxAgeMinutes",
};

const MOMENTUM_MENU_FIELDS = {
  momentumStrongThreshold: "strongThreshold",
  momentumStrongMinBins: "strongMinBins",
  momentumStrongMaxBins: "strongMaxBins",
  momentumWeakMinBins: "weakMinBins",
  momentumWeakMaxBins: "weakMaxBins",
  momentumAgeNewMaxHours: "ageNewMaxHours",
  momentumAgeYoungMaxHours: "ageYoungMaxHours",
  momentumAgeMatureMaxHours: "ageMatureMaxHours",
  momentumNewMinBins: "newMinBins",
  momentumNewMaxBins: "newMaxBins",
  momentumYoungMinBins: "youngMinBins",
  momentumYoungMaxBins: "youngMaxBins",
  momentumMatureMinBins: "matureMinBins",
  momentumMatureMaxBins: "matureMaxBins",
  momentumOldMinBins: "oldMinBins",
  momentumOldMaxBins: "oldMaxBins",
  momentumMaxCandleAgeMinutes: "maxCandleAgeMinutes",
  momentumMaxRetries: "maxRetries",
  momentumRetryDelayMs: "retryDelayMs",
};

const MENU_SECTION_ROWS = [
  ["quick", "sizing", "screen"],
  ["launch", "safety", "strategy"],
  ["momentum", "manage", "exits"],
  ["confidence", "schedule", "indicators"],
  ["bottomEntry", "bottomExit"],
  ["llm", "learning"],
];

const MENU_SECTIONS = {
  quick: [
    ["dryRun", "Dry run"],
    ["strategy", "Strategy"],
    ["deployAmountSol", "Deploy SOL"],
    ["maxPositions", "Max positions"],
    ["takeProfitFeePct", "Take profit %"],
    ["stopLossPct", "Stop loss %"],
    ["minFeeActiveTvlRatio", "Min fee/TVL"],
    ["minTokenFeesSol", "Min fee SOL"],
    ["minBinsBelow", "Min bins"],
    ["maxBinsBelow", "Max bins"],
  ],
  sizing: [
    ["deployAmountSol", "Deploy SOL"],
    ["minSolToOpen", "Min SOL open"],
    ["maxDeployAmount", "Max deploy SOL"],
    ["gasReserve", "Gas reserve"],
    ["positionSizePct", "Position size %"],
    ["maxPositions", "Max positions"],
    ["solMode", "SOL mode"],
  ],
  screen: [
    ["timeframe", "Timeframe"],
    ["category", "Category"],
    ["minTvl", "Min TVL"],
    ["maxTvl", "Max TVL"],
    ["minVolume", "Min volume"],
    ["minVolumeToActiveTvlRatio", "Min vol/TVL"],
    ["minFeeActiveTvlRatio", "Min fee/TVL"],
    ["minTokenFeesSol", "Min fee SOL"],
    ["minMomentumScore", "Min momentum"],
    ["minOrganic", "Min organic"],
    ["minHolders", "Min holders"],
    ["minMcap", "Min mcap"],
    ["maxMcap", "Max mcap"],
    ["minBinStep", "Min bin step"],
    ["maxBinStep", "Max bin step"],
  ],
  launch: [
    ["blockedLaunchpads", "Blocked launchpads"],
    ["allowedLaunchpads", "Allowed launchpads"],
    ["minTokenAgeHours", "Min token age h"],
    ["maxTokenAgeHours", "Max token age h"],
    ["athFilterPct", "ATH filter %"],
    ["avoidPvpSymbols", "PvP detect"],
    ["blockPvpSymbols", "PvP block"],
  ],
  safety: [
    ["maxBotHoldersPct", "Max bots %"],
    ["maxTop10Pct", "Max top10 %"],
    ["whaleGuardEnabled", "Whale guard"],
    ["whaleGuardMinDropUsd", "Whale drop USD"],
    ["whaleGuardMinDropPct", "Whale drop %"],
    ["whaleGuardCooldownMin", "Whale cooldown min"],
    ["tokenCloseCooldownMinutes", "Token close cooldown"],
    ["dangerDrawdownPct", "Danger %"],
    ["dangerHardClosePct", "Danger hard %"],
    ["dangerGraceMinutes", "Danger grace min"],
    ["dangerCloseMomentumBelow", "Danger momentum <"],
    ["dangerClosePriceChange5mPct", "Danger 5m change %"],
  ],
  strategy: [
    ["strategy", "Strategy"],
    ["mixedRatio", "Mixed ratio"],
    ["minBinsBelow", "Min bins"],
    ["maxBinsBelow", "Max bins"],
  ],
  momentum: [
    ["momentumStrongThreshold", "Strong threshold"],
    ["momentumStrongMinBins", "Strong min bins"],
    ["momentumStrongMaxBins", "Strong max bins"],
    ["momentumWeakMinBins", "Weak min bins"],
    ["momentumWeakMaxBins", "Weak max bins"],
    ["momentumAgeNewMaxHours", "New max age h"],
    ["momentumNewMinBins", "New min bins"],
    ["momentumNewMaxBins", "New max bins"],
    ["momentumAgeYoungMaxHours", "Young max age h"],
    ["momentumYoungMinBins", "Young min bins"],
    ["momentumYoungMaxBins", "Young max bins"],
    ["momentumAgeMatureMaxHours", "Mature max age h"],
    ["momentumMatureMinBins", "Mature min bins"],
    ["momentumMatureMaxBins", "Mature max bins"],
    ["momentumOldMinBins", "Old min bins"],
    ["momentumOldMaxBins", "Old max bins"],
    ["momentumMaxCandleAgeMinutes", "Max candle age min"],
    ["momentumMaxRetries", "Max retries"],
    ["momentumRetryDelayMs", "Retry delay ms"],
  ],
  manage: [
    ["minClaimAmount", "Min claim $"],
    ["autoSwapAfterClaim", "Auto swap"],
    ["outOfRangeBinsToClose", "OOR bins close"],
    ["outOfRangeWaitMinutes", "OOR wait min"],
    ["downsideOutOfRangeWaitMinutes", "Downside OOR wait"],
    ["downsideOutOfRangeLossPct", "Downside OOR loss %"],
    ["minVolumeToRebalance", "Min vol rebalance"],
    ["minFeePerTvl24h", "Min fee/TVL 24h"],
    ["minAgeBeforeYieldCheck", "Min age yield min"],
  ],
  exits: [
    ["takeProfitFeePct", "Take profit %"],
    ["stopLossPct", "Stop loss %"],
    ["trailingTakeProfit", "Trailing"],
    ["trailingTriggerPct", "Trail trigger %"],
    ["trailingDropPct", "Trail drop %"],
    ["dangerDrawdownPct", "Danger %"],
    ["dangerHardClosePct", "Danger hard %"],
    ["dangerGraceMinutes", "Danger grace min"],
  ],
  confidence: [
    ["confidence.enabled", "Confidence enabled"],
    ["confidence.fullThreshold", "Full threshold"],
    ["confidence.skipThreshold", "Skip threshold"],
    ["confidence.halfMultiplier", "Half multiplier"],
    ["confidence.smartWalletMaxAgeMinutes", "Smart wallet age"],
  ],
  schedule: [
    ["managementIntervalMin", "Manage interval"],
    ["screeningIntervalMin", "Screen interval"],
    ["healthCheckIntervalMin", "Health interval"],
    ["pnlPollIntervalMs", "PNL fast poll ms"],
    ["pnlNormalPollIntervalMs", "PNL normal poll ms"],
    ["pnlNoPositionPollIntervalMs", "PNL idle poll ms"],
    ["pnlSlowCheckIntervalMs", "PNL slow check ms"],
    ["pnlSignatureCheckIntervalMs", "PNL signature ms"],
    ["pnlDiscoveryTtlMs", "PNL discovery TTL"],
    ["lpAgentPnlNormalTtlMs", "LP PNL normal TTL"],
    ["lpAgentPnlUrgentTtlMs", "LP PNL urgent TTL"],
    ["lpAgentPnlRateLimitBackoffMs", "LP PNL backoff"],
    ["emptyPositionsCacheTtlMs", "Empty pos cache TTL"],
    ["screeningWatchdogMs", "Screen watchdog ms"],
    ["urgentPositionsTimeoutMs", "Urgent pos timeout"],
    ["shutdownTimeoutMs", "Shutdown timeout"],
  ],
  indicators: [
    ["enabled", "Indicators enabled"],
    ["entryPreset", "Entry preset"],
    ["entryMinPriceChangePct", "Entry min change %"],
    ["stPeriod", "ST period"],
    ["stMultiplier", "ST multiplier"],
    ["interval", "ST default interval"],
    ["entryInterval", "Entry interval"],
    ["exitInterval", "Exit interval"],
    ["failOpen", "Fail open"],
    ["exitOnBearishFlip", "Exit bearish flip"],
  ],
  bottomEntry: [
    ["bottomSpotLP.enabled", "Enabled"],
    ["bottomSpotLP.deployAmountSol", "Deploy SOL"],
    ["bottomSpotLP.minBaseFee", "Min base fee"],
    ["bottomSpotLP.minTvl", "Min TVL"],
    ["bottomSpotLP.maxTvl", "Max TVL"],
    ["bottomSpotLP.minVolume", "Min volume"],
    ["bottomSpotLP.minFeeActiveTvlRatio", "Min fee/TVL"],
    ["bottomSpotLP.minOrganic", "Min organic"],
    ["bottomSpotLP.rangePct", "Range %"],
    ["bottomSpotLP.minDumpPct", "Min dump %"],
    ["bottomSpotLP.minRetracePct", "Min retrace %"],
    ["bottomSpotLP.interval", "Interval"],
    ["bottomSpotLP.athLookbackCandles", "Lookback candles"],
    ["bottomSpotLP.maxBottomSpotPositions", "Max bottom pos"],
    ["bottomSpotLP.logLevel", "Log level"],
  ],
  bottomExit: [
    ["bottomSpotLP.rsiExitThreshold", "RSI exit"],
    ["bottomSpotLP.takeProfitFeePct", "Fee target %"],
    ["bottomSpotLP.maxILPct", "Max IL %"],
    ["bottomSpotLP.minFeesToOverrideStopLoss", "Fees override SL"],
    ["bottomSpotLP.outOfRangeWaitMinutes", "OOR wait min"],
    ["bottomSpotLP.outOfRangeTolerance", "OOR tolerance"],
    ["bottomSpotLP.feesForReposition", "Fees reposition %"],
    ["bottomSpotLP.enableTAExit", "TA exit"],
  ],
  llm: [
    ["managementModel", "Manage model"],
    ["screeningModel", "Screen model"],
    ["generalModel", "General model"],
    ["temperature", "Temperature"],
    ["maxTokens", "Max tokens"],
    ["maxSteps", "Max steps"],
  ],
  learning: [
    ["learning.enabled", "Learning enabled"],
    ["learning.minClosedPositions", "Min closed pos"],
    ["learning.proposalCooldownHours", "Proposal cooldown h"],
    ["learning.maxChangesPerProposal", "Max changes/proposal"],
  ],
};

MENU_SECTIONS.risk = MENU_SECTIONS.safety;
MENU_SECTIONS.bottom = MENU_SECTIONS.bottomEntry;

function parseTelegramConfigValue(rawValue, key = null) {
  const raw = String(rawValue).trim();
  if (raw === "null" || raw === "undefined") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  const current = key ? menuSettingValue(key) : undefined;
  if (Array.isArray(current) && raw.includes(",")) {
    return raw.split(",").map((part) => part.trim()).filter(Boolean);
  }
  if (!Number.isNaN(Number(raw)) && raw.includes(".")) return parseFloat(raw);
  if (!Number.isNaN(Number(raw))) return parseInt(raw, 10);
  return raw;
}

function parseNonTtyConfigValue(rawValue, key = null) {
  return parseTelegramConfigValue(rawValue, key);
}

function readUserConfigFile() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { return {}; }
}

function writeUserConfigFile(cfg) {
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function persistMenuConfigValue(cfg, key, value) {
  if (key === "dryRun") {
    cfg.dryRun = value;
    return;
  }
  if (key.startsWith("bottomSpotLP.")) {
    const field = key.split(".")[1];
    cfg.bottomSpotLP = cfg.bottomSpotLP || {};
    cfg.bottomSpotLP[field] = value;
    delete cfg[key];
    return;
  }
  if (key.startsWith("learning.")) {
    const field = key.split(".")[1];
    cfg.learning = cfg.learning || {};
    cfg.learning[field] = value;
    delete cfg[key];
    return;
  }
  if (CONFIDENCE_CONFIG_KEYS[key]) {
    cfg[CONFIDENCE_CONFIG_KEYS[key]] = value;
    delete cfg[key];
    return;
  }
  if (config.chartIndicators && key in config.chartIndicators) {
    cfg.chartIndicators = cfg.chartIndicators || {};
    cfg.chartIndicators[key] = value;
    delete cfg[key];
    return;
  }
  cfg[key] = value;
  if (key === "deployAmountSol") {
    cfg.minSolToOpen = value;
    cfg.maxDeployAmount = value;
  }
}

function applyLiveMenuConfigValue(key, value) {
  if (key === "dryRun") {
    process.env.DRY_RUN = String(value);
    return;
  }
  if (key.startsWith("bottomSpotLP.")) {
    const field = key.split(".")[1];
    if (field && config.bottomSpotLP && field in config.bottomSpotLP) config.bottomSpotLP[field] = value;
    return;
  }
  if (key.startsWith("learning.")) {
    const field = key.split(".")[1];
    if (field && config.learning && field in config.learning) config.learning[field] = value;
    return;
  }
  if (CONFIDENCE_LIVE_FIELDS[key]) {
    config.confidence[CONFIDENCE_LIVE_FIELDS[key]] = value;
    return;
  }
  if (MOMENTUM_MENU_FIELDS[key]) {
    config.momentum[MOMENTUM_MENU_FIELDS[key]] = value;
    return;
  }
  if (config.risk && key in config.risk) config.risk[key] = value;
  if (config.screening && key in config.screening) config.screening[key] = value;
  if (config.management && key in config.management) config.management[key] = value;
  if (config.schedule && key in config.schedule) config.schedule[key] = value;
  if (config.llm && key in config.llm) config.llm[key] = value;
  if (config.strategy && key in config.strategy) config.strategy[key] = value;
  if (config.chartIndicators && key in config.chartIndicators) config.chartIndicators[key] = value;
  if (key === "deployAmountSol") {
    config.management.minSolToOpen = value;
    config.risk.maxDeployAmount = value;
  }
}

async function applyMenuConfig(key, value, { restartCron = true } = {}) {
  const cfg = readUserConfigFile();
  persistMenuConfigValue(cfg, key, value);
  writeUserConfigFile(cfg);

  if (key === "dryRun") process.env.DRY_RUN = String(value);
  const runtimeReload = reloadRuntimeConfig();
  if (runtimeReload.error) {
    throw new Error(`Runtime config reload failed: ${runtimeReload.error}`);
  }
  applyLiveMenuConfigValue(key, value);

  const scheduleChanged = config.schedule && key in config.schedule;
  if (scheduleChanged && restartCron) {
    stopCronJobs();
    startCronJobs();
  }
  if (key === "strategy") {
    if (value === "bid_ask") setActiveStrategy({ id: "single_sided_reseed" });
    if (value === "spot") setActiveStrategy({ id: "custom_ratio_spot" });
    if (value === "mixed") setActiveStrategy({ id: "multi_layer" });
  }

  log("config", `Effective entry config: ${formatRuntimeConfigSnapshot()}`);
  log("config", `Telegram update: ${key} = ${JSON.stringify(value)}`);
}

function menuSettingValue(key) {
  if (key === "dryRun") return process.env.DRY_RUN === "true" ? "on" : "off";
  if (key.startsWith("bottomSpotLP.")) return config.bottomSpotLP?.[key.split(".")[1]] ?? "?";
  if (key.startsWith("learning.")) return config.learning?.[key.split(".")[1]] ?? "?";
  if (CONFIDENCE_LIVE_FIELDS[key]) return config.confidence?.[CONFIDENCE_LIVE_FIELDS[key]] ?? "?";
  if (MOMENTUM_MENU_FIELDS[key]) return config.momentum?.[MOMENTUM_MENU_FIELDS[key]] ?? "?";
  if (key in config.risk) return config.risk[key];
  if (key in config.screening) return config.screening[key];
  if (key in config.management) return config.management[key];
  if (key in config.schedule) return config.schedule[key];
  if (key in config.llm) return config.llm[key];
  if (config.chartIndicators && key in config.chartIndicators) return config.chartIndicators[key];
  if (key in config.strategy) {
    const value = config.strategy[key];
    return typeof value === "object" ? JSON.stringify(value) : value;
  }
  return "?";
}

function isToggleSetting(key) {
  const value = menuSettingValue(key);
  return typeof value === "boolean" || key === "dryRun";
}

function toggledSettingValue(key) {
  if (key === "dryRun") return !(process.env.DRY_RUN === "true");
  return !Boolean(menuSettingValue(key));
}

function sectionTitle(id) {
  const special = {
    llm: "LLM",
    bottomEntry: "Bottom Entry",
    bottomExit: "Bottom Exit",
  };
  if (special[id]) return special[id];
  return id.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function buildMenuSectionRows(section, preset) {
  return MENU_SECTION_ROWS.map((row) => row.map((id) => ({
    text: `${id === section ? "* " : ""}${sectionTitle(id)}`,
    callback_data: `menu:${id}:${preset}`,
  })));
}

async function applyNonTtyTelegramConfig(key, value) {
  await applyMenuConfig(key, value);
}

function nonTtySettingValue(key) {
  return menuSettingValue(key);
}

const nonTtyMenuSections = MENU_SECTIONS;

function buildNonTtySettingsMenu(section = "quick", preset = "custom") {
  const activeStrategy = getActiveStrategy();
  const strategyName = activeStrategy?.lp_strategy || config.strategy.strategy;
  const trailing = config.management.trailingTakeProfit ? "ON" : "OFF";
  const solMode = config.management.solMode ? "SOL" : "USD";
  const dryRun = process.env.DRY_RUN === "true" ? "on" : "off";
  const st = config.chartIndicators;
  const supState = st.enabled ? `${st.stPeriod}/${st.stMultiplier}, ${st.interval}` : "off";
  const bottomState = config.bottomSpotLP?.enabled ? `ON (${config.bottomSpotLP.minDumpPct}% dump)` : "OFF";
  const settings = nonTtyMenuSections[section] || nonTtyMenuSections.quick;
  const text = [
    `Settings: ${sectionTitle(section)}`,
    "",
    `Mode: ${solMode} | Source: meteora | Strat: ${strategyName}`,
    `Deploy: ${config.management.deployAmountSol} SOL | MaxPos: ${config.risk.maxPositions} | Gas: ${config.management.gasReserve}`,
    `TP/SL: ${config.management.takeProfitFeePct}% / ${config.management.stopLossPct}% | Trailing: ${trailing}`,
    `Bins range: [${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow}] | Sup: ${supState} | Dry run: ${dryRun}`,
    `Bottom Spot: ${bottomState}`,
    `PvP: ${config.screening.avoidPvpSymbols ? "detect" : "off"} + ${config.screening.blockPvpSymbols ? "block" : "allow"}`,
    "",
    `${settings.length} editable settings. Tap a value to edit.`,
  ].join("\n");
  const oldSectionRows = [
    [
      { text: `${section === "quick" ? "✓ " : ""}Quick`, callback_data: `menu:quick:${preset}` },
      { text: `${section === "screen" ? "✓ " : ""}Screen`, callback_data: `menu:screen:${preset}` },
      { text: `${section === "risk" ? "✓ " : ""}Risk`, callback_data: `menu:risk:${preset}` },
    ],
    [
      { text: `${section === "strategy" ? "✓ " : ""}Strategy`, callback_data: `menu:strategy:${preset}` },
      { text: `${section === "manage" ? "✓ " : ""}Manage`, callback_data: `menu:manage:${preset}` },
      { text: `${section === "exits" ? "✓ " : ""}Exits`, callback_data: `menu:exits:${preset}` },
    ],
    [
      { text: `${section === "confidence" ? "✓ " : ""}Confidence`, callback_data: `menu:confidence:${preset}` },
      { text: `${section === "schedule" ? "✓ " : ""}Schedule`, callback_data: `menu:schedule:${preset}` },
      { text: `${section === "indicators" ? "✓ " : ""}Indicators`, callback_data: `menu:indicators:${preset}` },
    ],
    [{ text: `${section === "llm" ? "✓ " : ""}Llm`, callback_data: `menu:llm:${preset}` }],
    [{ text: `${section === "bottom" ? "✓ " : ""}Bottom`, callback_data: `menu:bottom:${preset}` }],
  ];
  const sectionRows = buildMenuSectionRows(section, preset);
  const oldPresetRow = [
    { text: `${preset === "custom" ? "✓ " : ""}Custom`, callback_data: `preset:custom:${section}` },
    { text: `${preset === "degen" ? "✓ " : ""}Degen`, callback_data: `preset:degen:${section}` },
    { text: `${preset === "moderate" ? "✓ " : ""}Moderate`, callback_data: `preset:moderate:${section}` },
    { text: `${preset === "safe" ? "✓ " : ""}Safe`, callback_data: `preset:safe:${section}` },
  ];
  const presetRow = ["custom", "degen", "moderate", "safe"].map((id) => ({
    text: `${id === preset ? "* " : ""}${sectionTitle(id)}`,
    callback_data: `preset:${id}:${section}`,
  }));
  const oldSettingRows = settings.map(([key, label]) => ([{
    text: `${label}: ${nonTtySettingValue(key)} ✎`,
    callback_data: `edit:${key}:${section}:${preset}`,
  }]));
  const settingRows = settings.map(([key, label]) => ([{
    text: `${label}: ${nonTtySettingValue(key)} edit`,
    callback_data: `edit:${key}:${section}:${preset}`,
  }]));
  return { text, keyboard: [...sectionRows, presetRow, ...settingRows] };
}

async function sendNonTtyMenu(section = "quick", preset = "custom") {
  const menu = buildNonTtySettingsMenu(section, preset);
  await sendKeyboard(menu.text, menu.keyboard);
}

async function applyNonTtyPreset(name) {
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
  for (const [key, value] of Object.entries(presets[name] || {})) {
    await applyNonTtyTelegramConfig(key, value);
  }
}

async function handleNonTtyMenuCommand(text) {
  const trimmed = String(text || "").trim();
  if (nonTtyPendingMenuEdit && !trimmed.startsWith("/")) {
    const { key, section, preset } = nonTtyPendingMenuEdit;
    nonTtyPendingMenuEdit = null;
    const value = parseNonTtyConfigValue(trimmed, key);
    try {
      await applyNonTtyTelegramConfig(key, value);
      await sendMessage(`Updated ${key} = ${JSON.stringify(value)}`);
      await sendNonTtyMenu(section, preset);
    } catch (e) {
      await sendMessage(`Failed: ${e.message}`);
    }
    return true;
  }
  if (!/^\/?menu$/i.test(trimmed)) return false;
  await sendNonTtyMenu("quick", "custom");
  return true;
}

async function nonTtyTelegramCallbackHandler(query) {
  const data = query.data || "";
  log("telegram", `Callback: ${data}`);
  const [type, a, b, c, d] = data.split(":");
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  if (type === "menu") {
    const section = a || "quick";
    const preset = b || "custom";
    const menu = buildNonTtySettingsMenu(section, preset);
    await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
    await answerCallback(query.id);
    return;
  }

  if (type === "preset") {
    const preset = a || "custom";
    const section = b || "quick";
    await applyNonTtyPreset(preset);
    const menu = buildNonTtySettingsMenu(section, preset);
    await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
    await answerCallback(query.id, preset === "custom" ? "Custom selected" : `${preset} preset applied`);
    return;
  }

  if (type === "edit") {
    const key = a;
    const section = b || "quick";
    const preset = c || "custom";

    if (isToggleSetting(key)) {
      const value = toggledSettingValue(key);
      await applyNonTtyTelegramConfig(key, value);
      const menu = buildNonTtySettingsMenu(section, preset);
      await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
      await answerCallback(query.id, `${key} ${value ? "ON" : "OFF"}`);
      return;
    }

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
      const is = (bidask, spot) => current.bidask === bidask && current.spot === spot;
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

    nonTtyPendingMenuEdit = { key, section, preset };
    await answerCallback(query.id, `Send new value for ${key}`);
    await sendMessage(`Send new value for ${key}. Current: ${JSON.stringify(nonTtySettingValue(key))}`);
    return;
  }

  if (type === "set_strategy") {
    const value = a;
    const section = b || "quick";
    const preset = c || "custom";
    await applyNonTtyTelegramConfig("strategy", value);
    const menu = buildNonTtySettingsMenu(section, preset);
    await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
    await answerCallback(query.id, `Strategy → ${value}`);
    return;
  }

  if (type === "set_mixed") {
    const bidask = parseInt(a);
    const spot = parseInt(b);
    const section = c || "quick";
    const preset = d || "custom";
    await applyNonTtyTelegramConfig("mixedRatio", { bidask, spot });
    const menu = buildNonTtySettingsMenu(section, preset);
    await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
    await answerCallback(query.id, `Mixed ratio → ${bidask}/${spot}`);
    return;
  }

  await answerCallback(query.id);
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
      getTopCandidates({
        limit: 5,
        evaluationLimit: 5,
        signalGate: false,
      }),
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

  function parseConfigValue(rawValue, key = null) {
    return parseTelegramConfigValue(rawValue, key);
  }

  async function applyTelegramConfig(key, value) {
    return applyMenuConfig(key, value);
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

    const runtimeReload = reloadRuntimeConfig();
    if (runtimeReload.error) {
      throw new Error(`Runtime config reload failed: ${runtimeReload.error}`);
    }
    log("config", `Effective entry config: ${formatRuntimeConfigSnapshot()}`);
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
    return menuSettingValue(key);
    if (key === "dryRun") return process.env.DRY_RUN === "true" ? "on" : "off";
    if (key.startsWith("bottomSpotLP.")) {
      const field = key.split(".")[1];
      return config.bottomSpotLP?.[field] ?? "?";
    }
    if (key.startsWith("confidence.")) {
      const field = key.split(".")[1];
      return config.confidence?.[field] ?? "?";
    }
    const momentumFields = {
      momentumStrongThreshold: "strongThreshold",
      momentumAgeNewMaxHours: "ageNewMaxHours",
      momentumAgeYoungMaxHours: "ageYoungMaxHours",
      momentumAgeMatureMaxHours: "ageMatureMaxHours",
      momentumNewMinBins: "newMinBins",
      momentumNewMaxBins: "newMaxBins",
      momentumYoungMinBins: "youngMinBins",
      momentumYoungMaxBins: "youngMaxBins",
      momentumMatureMinBins: "matureMinBins",
      momentumMatureMaxBins: "matureMaxBins",
      momentumOldMinBins: "oldMinBins",
      momentumOldMaxBins: "oldMaxBins",
    };
    if (momentumFields[key]) return config.momentum[momentumFields[key]];
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
      ["minVolumeToActiveTvlRatio", "Min vol/TVL"],
      ["minMomentumScore", "Min momentum"],
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
      ["dangerDrawdownPct", "Danger %"],
      ["dangerHardClosePct", "Danger hard %"],
      ["dangerGraceMinutes", "Danger grace min"],
      ["dangerCloseMomentumBelow", "Danger momentum <"],
      ["dangerClosePriceChange5mPct", "Danger 5m change %"],
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
      ["dangerDrawdownPct", "Danger %"],
      ["dangerHardClosePct", "Danger hard %"],
      ["dangerGraceMinutes", "Danger grace min"],
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
      ["momentumStrongThreshold", "Strong threshold"],
      ["momentumAgeNewMaxHours", "New max age h"],
      ["momentumNewMinBins", "New min bins"],
      ["momentumNewMaxBins", "New max bins"],
      ["momentumAgeYoungMaxHours", "Young max age h"],
      ["momentumYoungMinBins", "Young min bins"],
      ["momentumYoungMaxBins", "Young max bins"],
      ["momentumAgeMatureMaxHours", "Mature max age h"],
      ["momentumMatureMinBins", "Mature min bins"],
      ["momentumMatureMaxBins", "Mature max bins"],
      ["momentumOldMinBins", "Old min bins"],
      ["momentumOldMaxBins", "Old max bins"],
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
    const settings = MENU_SECTIONS[section] || MENU_SECTIONS.quick;

    const text = [
      `Settings: ${sectionTitle(section)}`,
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

    const oldSectionRows = [
      ["quick", "screen", "risk"],
      ["strategy", "manage", "exits"],
      ["confidence", "schedule", "indicators"],
      ["llm"],
      ["bottom"],
    ].map((row) => row.map((id) => ({
      text: `${id === section ? "✓ " : ""}${id[0].toUpperCase()}${id.slice(1)}`,
      callback_data: `menu:${id}:${preset}`,
    })));

    const sectionRows = buildMenuSectionRows(section, preset);

    const oldPresetRow = ["custom", "degen", "moderate", "safe"].map((id) => ({
      text: `${id === preset ? "✓ " : ""}${id[0].toUpperCase()}${id.slice(1)}`,
      callback_data: `preset:${id}:${section}`,
    }));

    const presetRow = ["custom", "degen", "moderate", "safe"].map((id) => ({
      text: `${id === preset ? "* " : ""}${sectionTitle(id)}`,
      callback_data: `preset:${id}:${section}`,
    }));

    const oldSettingRows = settings.map(([key, label]) => ([{
      text: `${label}: ${settingValue(key)} ✎`,
      callback_data: `edit:${key}:${section}:${preset}`,
    }]));

    const settingRows = settings.map(([key, label]) => ([{
      text: `${label}: ${settingValue(key)} edit`,
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

      if (isToggleSetting(key)) {
        const value = toggledSettingValue(key);
        await applyTelegramConfig(key, value);
        const menu = buildSettingsMenu(section, preset);
        await editKeyboard(chatId, messageId, menu.text, menu.keyboard);
        await answerCallback(query.id, `${key} ${value ? "ON" : "OFF"}`);
        return;
      }

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

  async function sendTelegramPositionsSnapshot() {
    const { positions, total_positions } = await getMyPositions({ force: true, urgent: true });
    if (total_positions === 0) {
      await sendMessage("No open positions.");
      return;
    }
    const cur = config.management.solMode ? "◎" : "$";
    const lines = positions.map((p, i) => {
      const pnlDecimals = config.management.solMode ? 5 : 2;
      const pnl = p.pnl_usd >= 0 ? `+${cur}${formatDecimal(p.pnl_usd, pnlDecimals)}` : `-${cur}${formatDecimal(Math.abs(p.pnl_usd), pnlDecimals)}`;
      const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
      const oor = !p.in_range ? " ⚠️OOR" : "";
      return `${i + 1}. ${p.pair} | ${cur}${formatDecimal(p.total_value_usd, pnlDecimals)} | PnL: ${pnl} | fees: ${cur}${formatDecimal(p.unclaimed_fees_usd, pnlDecimals)} | ${age}${oor}`;
    });
    await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /close all to close all | /set <n> <note> to set instruction`);
  }

  async function telegramHandler(text) {
    log("telegram", `Incoming: ${text}`);

    const explicitLlmPrompt = parseExplicitTelegramLlmCommand(text);
    if (explicitLlmPrompt) {
      if (_managementBusy || _screeningBusy || busy) {
        if (_telegramQueue.length < 5) {
          _telegramQueue.push(text);
          log("telegram", `Queued explicit LLM (${_telegramQueue.length}): ${text}`);
          sendMessage(`Queued for LLM (${_telegramQueue.length}): "${explicitLlmPrompt.slice(0, 60)}"`).catch(() => {});
        } else {
          log("telegram", `Explicit LLM queue full, dropped: ${text}`);
          sendMessage("LLM queue is full (5 messages). Direct commands still work.").catch(() => {});
        }
        return;
      }

      busy = true;
      try {
        const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(explicitLlmPrompt);
        const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(explicitLlmPrompt);
        const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
        const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
        const { content } = await agentLoop(explicitLlmPrompt, config.llm.maxSteps, sessionHistory, agentRole, agentModel);
        appendHistory(explicitLlmPrompt, content);
        await sendMessage(stripThink(content));
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      } finally {
        busy = false;
        rl.setPrompt(buildPrompt());
        rl.prompt(true);
        drainTelegramQueue().catch(() => {});
      }
      return;
    }

    if (await handleTelegramCloseCommand(text)) {
      return;
    }

    if (await handleTelegramPositionsCommand(text)) {
      return;
    }

    const fastCheckTarget = parseFastCheckCommand(text);
    if (fastCheckTarget) {
      try {
        const report = await executeFastCheck(fastCheckTarget);
        await sendMessage(report);
      } catch (e) {
        await sendMessage(`Fast check failed: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (pendingMenuEdit && !text.startsWith("/")) {
      const { key, section, preset } = pendingMenuEdit;
      pendingMenuEdit = null;
      const value = parseConfigValue(text, key);
      try {
        await applyTelegramConfig(key, value);
        await sendMessage(`Updated ${key} = ${JSON.stringify(value)}`);
        await sendSettingsMenu(section, preset);
      } catch (e) {
        await sendMessage(`Failed: ${e.message}`);
      }
      return;
    }

    if (/^\/?(?:halo|hai|hi|hello)$/i.test(text.trim())) {
      await sendMessage("Halo. Meridian aktif.");
      return;
    }

    if (await handleTelegramBlacklistCommand(text)) {
      return;
    }

    if (false && (_managementBusy || _screeningBusy || busy) && !isDirectTelegramCommand(text)) {
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
        await runScreeningCycle({ force: true });
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
        const { positions, total_positions } = await getMyPositions({ force: true, urgent: true });
        if (total_positions === 0) { await sendMessage("No open positions."); return; }
        const cur = config.management.solMode ? "◎" : "$";
        const lines = positions.map((p, i) => {
          const pnlDecimals = config.management.solMode ? 5 : 2;
          const pnl = p.pnl_usd >= 0 ? `+${cur}${formatDecimal(p.pnl_usd, pnlDecimals)}` : `-${cur}${formatDecimal(Math.abs(p.pnl_usd), pnlDecimals)}`;
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const oor = !p.in_range ? " ⚠️OOR" : "";
          return `${i + 1}. ${p.pair} | ${cur}${formatDecimal(p.total_value_usd, pnlDecimals)} | PnL: ${pnl} | fees: ${cur}${formatDecimal(p.unclaimed_fees_usd, pnlDecimals)} | ${age}${oor}`;
        });
        await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /close all to close all | /set <n> <note> to set instruction`);
      } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => { }); }
      return;
    }

    const closeMatch = text.match(/^\/close\s+(\d+)$/i);
    if (closeMatch) {
      try {
        const idx = parseInt(closeMatch[1]) - 1;
        const { positions } = await getMyPositions({ force: true, urgent: true });
        if (idx < 0 || idx >= positions.length) { await sendMessage(`Invalid number. Use /positions first.`); return; }
        const pos = positions[idx];
        await executeTelegramClose(pos, "telegram /close number");
        return;
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

    if (/^\/?(?:screen sekarang|scan|scan sekarang|cari kandidat|cek kandidat)$/i.test(text.trim())) {
      await sendMessage("Starting screening cycle...");
      try {
        await runScreeningCycle({ force: true });
      } catch (e) {
        await sendMessage(`Screening failed: ${e.message}`).catch(() => {});
      } finally {
        drainTelegramQueue().catch(() => {});
      }
      return;
    }

    const deployQuestionTarget = parseDeployQuestionTarget(text);
    if (deployQuestionTarget) {
      try {
        await sendMessage(await explainWhyNoDeploy(deployQuestionTarget));
      } catch (e) {
        await sendMessage(`Deploy check failed: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (isDeployQuestion(text)) {
      await sendMessage(formatFastDeployStatus());
      return;
    }

    if (/^\/?(?:status|posisi|position|cek posisi|lihat posisi)$/i.test(text.trim())) {
      try {
        await sendTelegramPositionsSnapshot();
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    log("telegram", `Fast fallback without LLM: ${text}`);
    await sendMessage("Fast mode: command tidak dikenali. Pakai /positions, /screen, /menu, cek <mint/pool>, close <symbol>, blacklist, atau /ask <teks> untuk LLM.");
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

    if (input === "/screen") {
      await runBusy(async () => {
        console.log("\nStarting deterministic screening cycle...\n");
        const report = await runScreeningCycle({ silent: true, force: true });
        if (report) console.log(`\n${report}\n`);
      });
      return;
    }

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
        const { candidates, total_eligible, total_screened } = await getTopCandidates({
          limit: 5,
          evaluationLimit: 5,
          signalGate: false,
        });
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
          const { candidates } = await getTopCandidates({
            limit: 10,
            evaluationLimit: 10,
            signalGate: false,
          });
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

  async function drainNonTtyTelegramQueue() {
    while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
      const queued = _telegramQueue.shift();
      await nonTtyTelegramHandler(queued);
    }
  }

  async function runNonTtyLlm(text) {
    const explicitPrompt = parseExplicitTelegramLlmCommand(text);
    const prompt = explicitPrompt || String(text || "").trim();
    if (!prompt) return;

    if (_managementBusy || _screeningBusy || busy) {
      if (_telegramQueue.length < 5) {
        _telegramQueue.push(explicitPrompt ? `/ask ${explicitPrompt}` : prompt);
        await sendMessage(`Queued for LLM (${_telegramQueue.length}): "${prompt.slice(0, 60)}"`).catch(() => {});
      } else {
        await sendMessage("LLM queue is full (5 messages). Direct commands still work.").catch(() => {});
      }
      return;
    }

    busy = true;
    try {
      const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(prompt);
      const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(prompt);
      const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
      const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
      const { content } = await agentLoop(prompt, config.llm.maxSteps, sessionHistory, agentRole, agentModel);
      appendHistory(prompt, content);
      await sendMessage(stripThink(content));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      busy = false;
      drainNonTtyTelegramQueue().catch(() => {});
    }
  }
  async function nonTtyTelegramHandler(text) {
    log("telegram", `Incoming: ${text}`);
    if (await handleNonTtyMenuCommand(text)) return;
    if (/^\/?(?:screen|screen sekarang|scan|scan sekarang|cari kandidat|cek kandidat)$/i.test(String(text || "").trim())) {
      await sendMessage("Starting screening cycle...");
      runScreeningCycle({ force: true }).catch((e) => {
        log("cron_error", `Non-TTY manual screening failed: ${e.message}`);
        sendMessage(`Screening failed: ${e.message}`).catch(() => {});
      });
      return;
    }
    if (await handleTelegramPositionsCommand(text)) return;
    if (await handleTelegramCloseCommand(text)) return;
    if (await handleTelegramBlacklistCommand(text)) return;

    const fastCheckTarget = parseFastCheckCommand(text);
    if (fastCheckTarget) {
      try {
        await sendMessage(await executeFastCheck(fastCheckTarget));
      } catch (e) {
        await sendMessage(`Fast check failed: ${e.message}`).catch(() => {});
      }
      return;
    }

    const deployQuestionTarget = parseDeployQuestionTarget(text);
    if (deployQuestionTarget) {
      try {
        await sendMessage(await explainWhyNoDeploy(deployQuestionTarget));
      } catch (e) {
        await sendMessage(`Deploy check failed: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (isDeployQuestion(text)) {
      await sendMessage(formatFastDeployStatus());
      return;
    }

    await runNonTtyLlm(text);
  }

  startPolling(nonTtyTelegramHandler, nonTtyTelegramCallbackHandler);
  log("startup", "Non-TTY startup screening enabled; running one screening cycle now.");
  runScreeningCycle({ force: true }).catch((e) => log("cron_error", `Non-TTY startup screening failed: ${e.message}`));
}
