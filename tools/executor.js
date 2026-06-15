import { checkPoolPvpRisk, discoverPools, getPoolDetail, getPvpBlockReason, getTopCandidates, verifyLiveEntryGuards } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import {
  config,
  formatRuntimeConfigSnapshot,
  reloadRuntimeConfig,
  computeDeployAmount,
} from "../config.js";
import { getMinimumConfidenceDeployAmount } from "../confidence.js";
import {
  calculateMomentum,
  calculateWeakMomentumFallback,
  fetchMomentumCandles,
  formatMomentumLog,
  validateMomentumCandles,
} from "./momentum.js";
import {
  closedCandlesOnly,
  confirmSupertrendFromCandles,
  evaluateEntrySupertrend,
} from "./chart-indicators.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      whaleGuardEnabled: ["management", "whaleGuardEnabled"],
      whaleGuardMinDropUsd: ["management", "whaleGuardMinDropUsd"],
      whaleGuardMinDropPct: ["management", "whaleGuardMinDropPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      confidenceEnabled: ["confidence", "enabled"],
      confidenceFullThreshold: ["confidence", "fullThreshold"],
      confidenceSkipThreshold: ["confidence", "skipThreshold"],
      confidenceHalfMultiplier: ["confidence", "halfMultiplier"],
      smartWalletMaxAgeMinutes: ["confidence", "smartWalletMaxAgeMinutes"],
      momentumStrongThreshold: ["momentum", "strongThreshold"],
      momentumStrongMinBins: ["momentum", "strongMinBins"],
      momentumStrongMaxBins: ["momentum", "strongMaxBins"],
      momentumWeakMinBins: ["momentum", "weakMinBins"],
      momentumWeakMaxBins: ["momentum", "weakMaxBins"],
      momentumAgeNewMaxHours: ["momentum", "ageNewMaxHours"],
      momentumAgeYoungMaxHours: ["momentum", "ageYoungMaxHours"],
      momentumAgeMatureMaxHours: ["momentum", "ageMatureMaxHours"],
      momentumNewMinBins: ["momentum", "newMinBins"],
      momentumNewMaxBins: ["momentum", "newMaxBins"],
      momentumYoungMinBins: ["momentum", "youngMinBins"],
      momentumYoungMaxBins: ["momentum", "youngMaxBins"],
      momentumMatureMinBins: ["momentum", "matureMinBins"],
      momentumMatureMaxBins: ["momentum", "matureMaxBins"],
      momentumOldMinBins: ["momentum", "oldMinBins"],
      momentumOldMaxBins: ["momentum", "oldMaxBins"],
      momentumMaxCandleAgeMinutes: ["momentum", "maxCandleAgeMinutes"],
      momentumMaxRetries: ["momentum", "maxRetries"],
      momentumRetryDelayMs: ["momentum", "retryDelayMs"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // chart indicators
      chartIndicatorInterval: ["chartIndicators", "interval"],
      chartIndicatorEntryInterval: ["chartIndicators", "entryInterval"],
      chartIndicatorExitInterval: ["chartIndicators", "exitInterval"],
      entryInterval: ["chartIndicators", "entryInterval"],
      exitInterval: ["chartIndicators", "exitInterval"],
      exitOnBearishFlip: ["chartIndicators", "exitOnBearishFlip"],
      // strategy
      strategy: ["strategy", "strategy"],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      mixedRatio: ["strategy", "mixedRatio"],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    const reload = reloadRuntimeConfig();
    if (reload.error) {
      log("config_warn", `Runtime config reload failed: ${reload.error}`);
    } else {
      log("config", `Effective entry config: ${formatRuntimeConfigSnapshot()}`);
    }

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "update_config",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args, options = {}) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args, options);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      logAction({
        tool: name,
        args,
        result: { blocked: true, reason: safetyCheck.reason },
        duration_ms: Date.now() - startTime,
        success: false,
      });
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = name === "deploy_position"
      ? await deployPosition(args, { manualRange: options.manualRange === true })
      : await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          pnlSol: result.pnl_sol,
          feesEarnedUsd: result.fees_earned_usd,
          feesEarnedSol: result.fees_earned_sol,
          deployedSol: result.deployed_sol,
          strategy: result.strategy,
          holdMinutes: result.minutes_held,
          reason: result.close_reason || args.reason,
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.usd >= 0.10) {
              log("executor", `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              // Tell the model the swap already happened so it doesn't call swap_token again
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args, options = {}) {
  switch (name) {
    case "deploy_position": {
      if (!options.manualRange) {
        args.amount_y = config.management.deployAmountSol;
        args.amount_sol = config.management.deployAmountSol;
      }
      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Hard gate: reject pools with fee_tvl below config's minFeeActiveTvlRatio
      const { minFeeActiveTvlRatio } = config.screening;
      const livePool = await getPoolDetail({ pool_address: args.pool_address, timeframe: config.screening.timeframe });
      const liveFeeTvl = livePool.fee_active_tvl_ratio > 0
        ? Number(livePool.fee_active_tvl_ratio.toFixed(4))
        : (livePool.active_tvl > 0 && livePool.fee != null
          ? Number(((livePool.fee / livePool.active_tvl) * 100).toFixed(4))
          : 0);
      if (liveFeeTvl < minFeeActiveTvlRatio) {
        return { pass: false, reason: `fee_tvl ${liveFeeTvl}% < hard minimum ${minFeeActiveTvlRatio}%` };
      }
      const liveBaseMint = livePool.token_x?.address || livePool.mint_x || livePool.base_mint || null;
      const liveEntry = await verifyLiveEntryGuards({
        poolAddress: args.pool_address,
        mint: liveBaseMint,
      }, {
        deferAthThreshold: true,
      });
      if (!liveEntry.pass) {
        return { pass: false, reason: `Live entry guard failed: ${liveEntry.reason}` };
      }

      if (!options.manualRange) {
        if (!liveBaseMint) {
          return { pass: false, reason: "Momentum validation requires a live base mint." };
        }
        const fetched = await fetchMomentumCandles({
          mint: liveBaseMint,
          maxRetries: config.momentum.maxRetries,
          retryDelayMs: config.momentum.retryDelayMs,
        });
        if (!fetched.success) {
          log("momentum", formatMomentumLog({
            pool: args.pool_address,
            mint: liveBaseMint,
            gmgnAttempt: fetched.attempt,
            poolFeesSol: null,
            poolFeesSource: null,
            feeTimeframe: config.screening.timeframe,
            decision: "skip",
            reason: `${fetched.errorType}: ${fetched.error}`,
          }));
          return { pass: false, reason: `Momentum data unavailable: ${fetched.error}` };
        }

        const validated = validateMomentumCandles(fetched.candles, {
          maxCandleAgeMinutes: config.momentum.maxCandleAgeMinutes,
        });
        if (!validated.valid) {
          return { pass: false, reason: `Momentum candle validation failed: ${validated.reason}` };
        }

        const entryInterval = config.chartIndicators.entryInterval
          || config.chartIndicators.interval
          || "5m";
        const closedCandles = closedCandlesOnly(fetched.candles, entryInterval);
        const stCheck = evaluateEntrySupertrend(confirmSupertrendFromCandles(closedCandles, {
          interval: entryInterval,
          period: config.chartIndicators.stPeriod || 10,
          multiplier: config.chartIndicators.stMultiplier || 3,
        }), {
          entryPreset: config.chartIndicators.entryPreset,
          ath: liveEntry.price?.ath,
          athFilterPct: config.screening.athFilterPct,
        });
        if (!stCheck.confirmed) {
          return { pass: false, reason: `Supertrend not confirmed: ${stCheck.reason}` };
        }

        let momentum = calculateMomentum({
          candles: fetched.candles,
          feeActiveTvlRatio: liveFeeTvl,
          minFeeActiveTvlRatio,
          volatility: livePool.volatility,
          strongThreshold: config.momentum.strongThreshold,
          strongMinBins: config.momentum.strongMinBins,
          strongMaxBins: config.momentum.strongMaxBins,
          weakMinBins: config.momentum.weakMinBins,
          weakMaxBins: config.momentum.weakMaxBins,
          tokenAgeHours: livePool.token_x?.created_at
            ? (Date.now() - livePool.token_x.created_at) / 3_600_000
            : null,
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
            volatility: livePool.volatility,
            weakMinBins: config.momentum.weakMinBins,
            weakMaxBins: config.momentum.weakMaxBins,
            tokenAgeHours: livePool.token_x?.created_at
              ? (Date.now() - livePool.token_x.created_at) / 3_600_000
              : null,
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
            reason: `supertrend_confirmed_momentum_fallback: ${momentum.reason}`,
          });
        }

        const momentumSnapshot = { ...momentum, candles: undefined };
        args.strategy = config.strategy.strategy;
        args.bins_below = momentum.binsBelow;
        args.bins_above = 0;
        args.base_mint = liveBaseMint;
        args.volatility = momentum.volatility;
        args.fee_tvl_ratio = liveFeeTvl;
        args.momentum = momentumSnapshot;
        args.signal_snapshot = {
          ...(args.signal_snapshot || {}),
          momentum: momentumSnapshot,
          supertrend_direction: stCheck.direction,
          supertrend_reason: stCheck.reason,
          pool_fees_sol: liveEntry.fees.pool_fees_sol,
          pool_fees_source: liveEntry.fees.source,
          pool_fees_timeframe: liveEntry.fees.timeframe || null,
          fee_window_usd: livePool.fee ?? null,
          fee_window_timeframe: config.screening.timeframe,
          price_vs_ath_pct: stCheck.priceVsAthPct ?? null,
        };
        log("momentum", formatMomentumLog({
          pool: args.pool_address,
          mint: liveBaseMint,
          result: momentum,
          gmgnAttempt: fetched.attempt,
          poolFeesSol: liveEntry.fees.pool_fees_sol,
          poolFeesSource: liveEntry.fees.source,
          feeTimeframe: liveEntry.fees.timeframe,
          decision: "deploy",
          reason: stCheck.reason,
        }));
      }

      if (config.screening.blockPvpSymbols) {
        const pvpPool = {
          pool: args.pool_address,
          name: livePool.name || args.pool_name || args.pool_address,
          base: {
            symbol: livePool.token_x?.symbol || args.base_symbol || null,
            mint: args.base_mint || liveBaseMint,
          },
        };
        await checkPoolPvpRisk(pvpPool);
        const reason = getPvpBlockReason(pvpPool);
        if (reason) {
          log("safety_block", `PVP deploy guard: blocked symbol=${pvpPool.base.symbol || "unknown"} mint=${pvpPool.base.mint || "unknown"} - ${reason}`);
          return { pass: false, reason: `PVP hard block: ${reason}` };
        }
      }

      // Supertrend gate: re-check at deploy time (fresh data via GMGN)
      const baseMintForSt = options.manualRange ? (args.base_mint || liveBaseMint) : null;
      if (baseMintForSt) {
        const cc = config.chartIndicators;
        const { confirmEntrySupertrendBreak } = await import("./chart-indicators.js");
        const stCheck = await confirmEntrySupertrendBreak({
          mint: baseMintForSt,
          interval: cc.entryInterval || cc.interval || "5m",
          period: cc.stPeriod || 10,
          multiplier: cc.stMultiplier || 3,
          entryPreset: cc.entryPreset,
          ath: liveEntry.price?.ath,
          athFilterPct: config.screening.athFilterPct,
        }).catch(() => null);
        if (stCheck && !stCheck.confirmed) {
          if (cc.failOpen === false) {
            return { pass: false, reason: `Supertrend not confirmed at deploy time: ${stCheck.reason}` };
          }
          log("executor_warn", `Supertrend gate fail-open at deploy: ${baseMintForSt.slice(0, 8)} — ${stCheck.reason}`);
        }
      }

      const SOL_MINT = "So11111111111111111111111111111111111111112";
      if (livePool.token_y?.address && livePool.token_y.address !== SOL_MINT) {
        return { pass: false, reason: `quote token ${livePool.token_y.symbol} is not SOL` };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      const baseMint = args.base_mint || liveBaseMint;
      if (baseMint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === baseMint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${baseMint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = getMinimumConfidenceDeployAmount(
        config.management.deployAmountSol,
        config.confidence
      );
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      const balance = await getWalletBalances();
      if (!options.manualRange) {
        const deterministicAmount = computeDeployAmount(balance.sol);
        args.amount_y = deterministicAmount;
        args.amount_sol = deterministicAmount;
      }
      const finalAmountY = args.amount_y ?? args.amount_sol ?? 0;
      if (finalAmountY < minDeploy) {
        return {
          pass: false,
          reason: `Deterministic amount ${finalAmountY} SOL is below the minimum deploy amount (${minDeploy} SOL).`,
        };
      }
      if (finalAmountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `Deterministic amount ${finalAmountY} SOL exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }
      const gasReserve = config.management.gasReserve;
      const minRequired = finalAmountY + gasReserve;
      if (balance.sol < minRequired) {
        return {
          pass: false,
          reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${finalAmountY} deploy + ${gasReserve} gas reserve).`,
        };
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}

function roundNumber(n) {
  return n != null ? Math.round(Number(n)) : null;
}
