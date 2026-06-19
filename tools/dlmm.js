import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  getTrackedPositions,
  minutesOutOfRange,
  syncOpenPositions,
  updatePositionSnapshots,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { getPoolCooldown, setTokenCloseCooldown } from "../pool-memory.js";
import { buildManualClosePerformance } from "../manual-close.js";
import {
  safeRecordJournalEntry,
} from "../journal.js";
import { normalizeMint } from "./wallet.js";
import {
  calculateMeteoraPositionPnl,
  calculatePnl,
  fetchLPAgentWalletPnl,
  fetchJupiterPrices,
  fetchMeteoraPoolPnl,
  fetchMeteoraPortfolio,
  pnlNumber,
} from "../pnl-fetcher.js";
import { instrumentConnection } from "./rpc-telemetry.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = instrumentConnection(new Connection(process.env.RPC_URL, "confirmed"), "dlmm");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

function quoteNumber(value) {
  if (value && typeof value.toNumber === "function") return value.toNumber();
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function evaluatePositionCostQuote(quote = {}) {
  const binArraysCount = quoteNumber(quote.binArraysCount);
  const binArrayCost = quoteNumber(quote.binArrayCost);
  const bitmapExtensionCost = quoteNumber(quote.bitmapExtensionCost);
  const avoidedCostSol = binArrayCost + bitmapExtensionCost;

  return {
    blocked: binArraysCount > 0 || binArrayCost > 0 || bitmapExtensionCost > 0,
    bin_arrays_count: binArraysCount,
    bin_array_cost_sol: binArrayCost,
    bitmap_extension_cost_sol: bitmapExtensionCost,
    avoided_cost_sol: avoidedCostSol,
    position_rent_sol: quoteNumber(quote.positionCost),
    position_extension_rent_sol: quoteNumber(quote.positionReallocCost),
    transaction_count: quoteNumber(quote.transactionCount),
  };
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  strategy_label,
  bins_below,
  bins_above,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  volume,
  organic_score,
  base_mint,
  initial_value_usd,
  signal_snapshot,
  momentum,
}, { manualRange = false, dependencies = {} } = {}) {
  pool_address = normalizeMint(pool_address);
  const usesExplicitRange = strategy_label === "bottom_spot_lp" || manualRange;
  const activeStrategy = usesExplicitRange
    ? (strategy || config.strategy.strategy)
    : config.strategy.strategy;
  const trackedStrategy = strategy_label || activeStrategy;

  if (!usesExplicitRange) {
    if (!momentum?.valid || !Number.isFinite(Number(momentum.binsBelow))) {
      throw new Error("Normal deploy requires a valid hardcoded momentum snapshot.");
    }
    const candleStartMs = Date.parse(momentum.latestCandleTime);
    const candleAgeMinutes = Number.isFinite(candleStartMs)
      ? (Date.now() - (candleStartMs + 5 * 60_000)) / 60_000
      : Infinity;
    if (candleAgeMinutes < 0 || candleAgeMinutes > config.momentum.maxCandleAgeMinutes) {
      throw new Error(`Momentum snapshot is stale (${candleAgeMinutes.toFixed(2)} minutes).`);
    }
    if (Number(bins_below) !== Number(momentum.binsBelow) || Number(bins_above ?? 0) !== 0) {
      throw new Error(`Momentum range enforcement failed: expected ${momentum.binsBelow} bins below and 0 above.`);
    }
  }
  const activeBinsBelow = usesExplicitRange
    ? Math.max(1, Math.min(1400, bins_below ?? config.strategy.minBinsBelow))
    : Number(momentum.binsBelow);
  const activeBinsAbove = bins_above ?? 0;

  const poolCooldown = getPoolCooldown(pool_address);
  if (poolCooldown) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown until ${poolCooldown.cooldown_until} (${poolCooldown.remaining_seconds}s left) - skipping`);
    return {
      success: false,
      error: `Pool is on cooldown until ${poolCooldown.cooldown_until} (${poolCooldown.remaining_seconds}s left).`,
      cooldown_until: poolCooldown.cooldown_until,
      cooldown_remaining_seconds: poolCooldown.remaining_seconds,
    };
  }

  if (process.env.DRY_RUN === "true") {
    const totalBins = activeBinsBelow + activeBinsAbove;
    const result = {
      pool_address,
      strategy: activeStrategy,
      strategy_label: trackedStrategy,
      bins_below: activeBinsBelow,
      bins_above: activeBinsAbove,
      amount_x: amount_x || 0,
      amount_y: amount_y || amount_sol || 0,
      wide_range: totalBins > 69,
      momentum: momentum || null,
    };
    if (activeStrategy === "mixed") {
      const ratio = config.strategy.mixedRatio || { bidask: 70, spot: 30 };
      result.mixed_ratio = ratio;
      result.layers = [
        { strategy: "bid_ask", pct: ratio.bidask },
        { strategy: "spot", pct: ratio.spot },
      ];
    }
    return {
      dry_run: true,
      would_deploy: result,
      message: "DRY RUN — no transaction sent",
    };
  }

  const loadDLMM = dependencies.getDLMM || getDLMM;
  const loadPool = dependencies.getPool || getPool;
  const loadWallet = dependencies.getWallet || getWallet;
  const sendTransaction = dependencies.sendAndConfirmTransaction || sendAndConfirmTransaction;
  const generatePosition = dependencies.generatePosition || (() => Keypair.generate());

  const { StrategyType } = await loadDLMM();
  const pool = await loadPool(pool_address);
  const activeBin = await pool.getActiveBin();

  // Range calculation
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const isMixed = activeStrategy === "mixed";
  const strategyType = strategyMap[activeStrategy];
  if (!isMixed && strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, bid_ask, or mixed.`);
  }

  const quoteStrategyType = isMixed ? StrategyType.BidAsk : strategyType;
  let costQuote;
  try {
    costQuote = evaluatePositionCostQuote(await pool.quoteCreatePosition({
      strategy: { minBinId, maxBinId, strategyType: quoteStrategyType },
    }));
  } catch (error) {
    log("deploy_block", `Position cost preflight failed for ${pool_address}: ${error.message}`);
    return {
      success: false,
      blocked: true,
      code: "position_cost_quote_failed",
      error: `Position cost preflight failed: ${error.message}`,
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
    };
  }

  if (costQuote.blocked) {
    const error = [
      "Deploy blocked: range requires non-refundable Meteora infrastructure cost",
      `${costQuote.bin_arrays_count} new bin array(s)`,
      `${costQuote.bin_array_cost_sol.toFixed(8)} SOL bin array cost`,
      `${costQuote.bitmap_extension_cost_sol.toFixed(8)} SOL bitmap extension cost`,
    ].join("; ");
    log("deploy_block", `${error}; avoided ${costQuote.avoided_cost_sol.toFixed(8)} SOL`);
    return {
      success: false,
      blocked: true,
      code: "non_refundable_bin_cost",
      reason: error,
      error,
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      cost_quote: costQuote,
      avoided_cost_sol: costQuote.avoided_cost_sol,
    };
  }

  const wallet = loadWallet();

  // Calculate amounts
  // If amount_y is not provided but amount_sol is, use amount_sol (for backward compatibility)
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const totalBins = activeBinsBelow + activeBinsAbove;
  const isWideRange = totalBins > 69;
  const newPosition = generatePosition();
  const positionAddress = newPosition.publicKey.toString();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${positionAddress}`);
  log("deploy", `Cost preflight: 0 non-refundable bin cost; refundable position rent ${costQuote.position_rent_sol.toFixed(8)} SOL; refundable extension rent ${costQuote.position_extension_rent_sol.toFixed(8)} SOL`);

  try {
    const txHashes = [];
    let mixedPartial = false;
    const completedMixedLayers = [];
    _deployingPositions.add(positionAddress);

    // Pre-calculate mixed ratio split
    let mixedBidaskX, mixedBidaskY, mixedSpotX, mixedSpotY;
    let mixedAllocationY = null;
    if (isMixed) {
      const ratio = config.strategy.mixedRatio || { bidask: 70, spot: 30 };
      const mixedAllocationX = calculateMixedAllocation(Number(totalXLamports), ratio);
      mixedAllocationY = calculateMixedAllocation(Number(totalYLamports), ratio);
      mixedBidaskX = new BN(Math.floor(mixedAllocationX.bidask));
      mixedBidaskY = new BN(Math.floor(mixedAllocationY.bidask));
      mixedSpotX = new BN(Math.floor(mixedAllocationX.spot));
      mixedSpotY = new BN(Math.floor(mixedAllocationY.spot));
    }

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendTransaction(getConnection(), createTxArray[i], signers);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      if (isMixed) {
        // Phase 2: Add the configured BidAsk share.
        const bidaskTxs = await pool.addLiquidityByStrategyChunkable({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: mixedBidaskX,
          totalYAmount: mixedBidaskY,
          strategy: { minBinId, maxBinId, strategyType: StrategyType.BidAsk },
          slippage: 10,
        });
        const bidaskTxArray = Array.isArray(bidaskTxs) ? bidaskTxs : [bidaskTxs];
        for (let i = 0; i < bidaskTxArray.length; i++) {
          const txHash = await sendTransaction(getConnection(), bidaskTxArray[i], [wallet]);
          txHashes.push(txHash);
          log("deploy", `Mixed BidAsk tx ${i + 1}/${bidaskTxArray.length}: ${txHash}`);
        }
        completedMixedLayers.push("bidask");

        // Phase 3: Add the configured Spot share to the same position.
        try {
          const spotTxs = await pool.addLiquidityByStrategyChunkable({
            positionPubKey: newPosition.publicKey,
            user: wallet.publicKey,
            totalXAmount: mixedSpotX,
            totalYAmount: mixedSpotY,
            strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
            slippage: 10,
          });
          const spotTxArray = Array.isArray(spotTxs) ? spotTxs : [spotTxs];
          for (let i = 0; i < spotTxArray.length; i++) {
            const txHash = await sendTransaction(getConnection(), spotTxArray[i], [wallet]);
            txHashes.push(txHash);
            log("deploy", `Mixed Spot tx ${i + 1}/${spotTxArray.length}: ${txHash}`);
          }
          completedMixedLayers.push("spot");
        } catch (spotError) {
          log("deploy_error", `Mixed Spot layer failed (BidAsk succeeded): ${spotError.message}`);
          mixedPartial = true;
        }
      } else {
        // Phase 2: Add liquidity (may be multiple txs)
        const addTxs = await pool.addLiquidityByStrategyChunkable({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: totalXLamports,
          totalYAmount: totalYLamports,
          strategy: { minBinId, maxBinId, strategyType },
          slippage: 10,
        });
        const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
        for (let i = 0; i < addTxArray.length; i++) {
          const txHash = await sendTransaction(getConnection(), addTxArray[i], [wallet]);
          txHashes.push(txHash);
          log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
        }
      }
    } else if (isMixed) {
      // ── Mixed Standard Path (≤69 bins) ──────────────────────────
      // Phase 1: Initialize position and add the configured BidAsk share.
      const bidaskTx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: mixedBidaskX,
        totalYAmount: mixedBidaskY,
        strategy: { maxBinId, minBinId, strategyType: StrategyType.BidAsk },
        slippage: 1000,
      });
      const hash1 = await sendTransaction(getConnection(), bidaskTx, [wallet, newPosition]);
      txHashes.push(hash1);
      log("deploy", `Mixed BidAsk layer tx: ${hash1}`);
      completedMixedLayers.push("bidask");

      // Phase 2: Add the configured Spot share to the same position.
      try {
        const spotTx = await pool.addLiquidityByStrategy({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: mixedSpotX,
          totalYAmount: mixedSpotY,
          strategy: { maxBinId, minBinId, strategyType: StrategyType.Spot },
          slippage: 100,
        });
        const hash2 = await sendTransaction(getConnection(), spotTx, [wallet]);
        txHashes.push(hash2);
        log("deploy", `Mixed Spot layer tx: ${hash2}`);
        completedMixedLayers.push("spot");
      } catch (spotError) {
        log("deploy_error", `Mixed Spot layer failed (BidAsk succeeded): ${spotError.message}`);
        mixedPartial = true;
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000,
      });
      const txHash = await sendTransaction(getConnection(), tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    const layerCount = isMixed ? (mixedPartial ? 1 : 2) : 1;
    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}${isMixed ? ` (${layerCount}/${isMixed ? 2 : 1} layers)` : ""}`);

    const successfulDepositSol = isMixed
      ? completedMixedLayers.reduce(
        (sum, layer) => sum + Number(layer === "bidask" ? mixedBidaskY : mixedSpotY) / 1e9,
        0
      )
      : finalAmountY;
    _positionsCacheAt = 0;
    _pnlDiscoveryAt = 0;
    _pnlCostBasis.delete(positionAddress);
    trackPosition({
      position: positionAddress,
      pool: pool_address,
      pool_name,
      strategy: trackedStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      base_fee,
      volatility,
      fee_tvl_ratio,
      volume,
      organic_score,
      base_mint,
      amount_sol: successfulDepositSol,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      expected_deposit_sol: successfulDepositSol,
      requested_deposit_sol: finalAmountY,
      mixed_ratio: isMixed ? mixedAllocationY.ratio : null,
      mixed_layers_completed: isMixed ? completedMixedLayers : null,
      position_rent_sol: costQuote.position_rent_sol,
      position_extension_rent_sol: costQuote.position_extension_rent_sol,
      deploying: false,
      signal_snapshot,
      momentum,
    });
    const tracked = getTrackedPosition(positionAddress);
    safeRecordJournalEntry({
      position: positionAddress,
      pool: pool_address,
      poolName: pool_name,
      deployedAt: tracked?.deployed_at,
      entrySnapshot: signal_snapshot,
      fallbackEntry: {
        captured_at: tracked?.deployed_at,
        pool: {
          address: pool_address,
          name: pool_name ?? null,
          bin_step: bin_step ?? null,
          fee_pct: base_fee ?? null,
          volume_window_usd: volume ?? null,
          fee_active_tvl_ratio_pct: fee_tvl_ratio ?? null,
          volatility: volatility ?? null,
        },
        token: {
          mint: base_mint ?? null,
          organic_score: organic_score ?? null,
        },
        decision: {
          strategy: activeStrategy,
          strategy_label: trackedStrategy,
          amount_sol: successfulDepositSol,
          bins_below: activeBinsBelow,
          bins_above: activeBinsAbove,
        },
      },
    });
    _deployingPositions.delete(positionAddress);

    const actualBinStep = pool.lbPair.binStep;
    const activePrice = parseFloat(activeBin.price);
    const minPrice = activePrice * Math.pow(1 + actualBinStep / 10000, minBinId - activeBin.binId);
    const maxPrice = activePrice * Math.pow(1 + actualBinStep / 10000, maxBinId - activeBin.binId);

    // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
    const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
    const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

    const result = {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      strategy_label: trackedStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
      momentum: momentum || null,
      cost_quote: costQuote,
    };

    if (isMixed) {
      result.mixed_ratio = config.strategy.mixedRatio || { bidask: 70, spot: 30 };
      if (mixedPartial) {
        result.mixed_partial = true;
        result.mixed_warning = "Spot layer failed — position has only BidAsk liquidity";
      }
    }

    return result;
  } catch (error) {
    _deployingPositions.delete(positionAddress);
    _pnlCostBasis.delete(positionAddress);
    _pnlDiscoveryAt = 0;
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000;
const PNL_DISCOVERY_TTL = Math.max(30_000, config.schedule.pnlDiscoveryTtlMs ?? 120_000);
const EMPTY_POSITIONS_CACHE_TTL = Math.max(30_000, config.schedule.emptyPositionsCacheTtlMs ?? 120_000);

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null;
let _pnlDiscovery = null;
let _pnlDiscoveryAt = 0;
let _pnlSignaturesCheckedAt = 0;
const _pnlCostBasis = new Map();
const _closingPositions = new Set();
const _deployingPositions = new Set();
const _pnlPendingReasons = new Map();
const _lpAgentPnlCache = new Map();

const PNL_DEPOSIT_TOLERANCE_PCT = 1;

export function calculateMixedAllocation(totalAmount, ratio) {
  const bidask = Number(ratio?.bidask);
  const spot = Number(ratio?.spot);
  const total = bidask + spot;
  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new Error("Mixed allocation amount must be a non-negative number");
  }
  if (!Number.isFinite(bidask) || !Number.isFinite(spot) || bidask < 0 || spot < 0 || total <= 0) {
    throw new Error("mixedRatio must contain non-negative bidask and spot weights");
  }
  return {
    bidask: totalAmount * (bidask / total),
    spot: totalAmount * (spot / total),
    total: totalAmount,
    ratio: { bidask, spot },
  };
}

export function evaluatePnlDepositTrust({
  actualDepositSol,
  expectedDepositSol,
  deploying = false,
  tolerancePct = PNL_DEPOSIT_TOLERANCE_PCT,
}) {
  if (deploying) {
    return { trusted: false, reason: "deployment layers still in progress" };
  }
  if (!Number.isFinite(expectedDepositSol) || expectedDepositSol <= 0) {
    return { trusted: true, reason: null };
  }
  if (!Number.isFinite(actualDepositSol) || actualDepositSol < expectedDepositSol * (1 - tolerancePct / 100)) {
    return {
      trusted: false,
      reason: `indexed deposit ${Number.isFinite(actualDepositSol) ? actualDepositSol : "?"} SOL below expected ${expectedDepositSol} SOL`,
    };
  }
  return { trusted: true, reason: null };
}

function applyPnlTrust(position, raw) {
  const tracked = getTrackedPosition(position.position);
  const expectedDepositSol = Number(tracked?.expected_deposit_sol);
  const actualDepositSol = Number.parseFloat(raw?.allTimeDeposits?.total?.sol);
  const trust = evaluatePnlDepositTrust({
    actualDepositSol,
    expectedDepositSol,
    deploying: _deployingPositions.has(position.position) || tracked?.deploying === true,
  });
  position.pnl_trusted = trust.trusted;
  position.pnl_pending_reason = trust.reason;
  position.expected_deposit_sol = Number.isFinite(expectedDepositSol) ? expectedDepositSol : null;
  position.indexed_deposit_sol = Number.isFinite(actualDepositSol) ? actualDepositSol : null;
  if (!trust.trusted) {
    _pnlDiscoveryAt = 0;
    if (_pnlPendingReasons.get(position.position) !== trust.reason) {
      _pnlPendingReasons.set(position.position, trust.reason);
      log(
        "pnl_pending",
        `${position.pair} | ${trust.reason} | ratio=${tracked?.mixed_ratio ? `${tracked.mixed_ratio.bidask}/${tracked.mixed_ratio.spot}` : "n/a"} | layers=${tracked?.mixed_layers_completed?.join("+") || "pending"}`
      );
    }
  } else {
    _pnlPendingReasons.delete(position.position);
  }
  return position;
}

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number.parseFloat(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function calculatePnlWithDepositFallback({ calculated, balance, withdrawals, claimableFees, claimedFees, indexedDeposits, fallbackDeposits }) {
  if (Number.isFinite(calculated?.pnlPct)) return calculated;
  const indexed = Number.parseFloat(indexedDeposits);
  const fallback = Number.parseFloat(fallbackDeposits);
  if (Number.isFinite(indexed) && indexed > 0) return calculated;
  if (!Number.isFinite(fallback) || fallback <= 0) return calculated;
  return calculatePnl({
    balance,
    withdrawals,
    claimableFees,
    claimedFees,
    deposits: fallback,
  });
}

async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

async function fetchClosedPnlForPosition(poolAddress, positionAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const entry = (data.positions || data.data || []).find((position) =>
      (position.positionAddress || position.address || position.position) === positionAddress
    );
    if (!entry) return null;

    return {
      pnl_sol: numberOrNull(entry.pnlSol),
      pnl_pct: config.management.solMode
        ? numberOrNull(entry.pnlSolPctChange ?? entry.pnlPctChange)
        : numberOrNull(entry.pnlPctChange),
      pnl_usd: numberOrNull(entry.pnlUsd),
      fees_earned_sol: numberOrNull(entry.allTimeFees?.total?.sol),
      fees_earned_usd: numberOrNull(entry.allTimeFees?.total?.usd),
      final_value_usd: numberOrNull(entry.allTimeWithdrawals?.total?.usd),
      initial_value_usd: numberOrNull(entry.allTimeDeposits?.total?.usd),
    };
  } catch (error) {
    log("manual_close_warn", `Closed PnL lookup failed for ${positionAddress}: ${error.message}`);
    return null;
  }
}

async function fetchLPAgentClosedPnlForPosition(positionAddress, walletAddress, { urgent = true } = {}) {
  try {
    const lpAgentMap = await fetchLPAgentPnlMap(walletAddress, { urgent });
    const entry = lpAgentMap.get(positionAddress);
    if (!entry) return null;
    return {
      pnl_sol: numberOrNull(entry.pnlSol),
      pnl_pct: numberOrNull(entry.pnlPct),
      pnl_usd: numberOrNull(entry.pnlUsd),
      fees_earned_sol: null,
      fees_earned_usd: numberOrNull(entry.feesCollected),
      final_value_usd: numberOrNull(entry.currentValue),
      initial_value_usd: null,
      pnl_source: "lpagent_fallback",
      pnl_trusted: true,
    };
  } catch (error) {
    log("close_warn", `LPAgent closed PnL fallback failed for ${positionAddress}: ${error.message}`);
    return null;
  }
}

async function recordExternalClose(tracked, walletAddress) {
  const snapshot = tracked.last_snapshot || {};
  let closedPnl = null;
  if (
    snapshot.pnl_source === "rpc" &&
    snapshot.pnl_trusted !== false &&
    (numberOrNull(snapshot.pnl_sol) != null || numberOrNull(snapshot.pnl_pct) != null)
  ) {
    closedPnl = {
      pnl_sol: numberOrNull(snapshot.pnl_sol),
      pnl_pct: numberOrNull(snapshot.pnl_pct),
      pnl_usd: numberOrNull(snapshot.pnl_usd),
      fees_earned_sol: numberOrNull(snapshot.fees_earned_sol),
      fees_earned_usd: numberOrNull(snapshot.fees_earned_usd),
      final_value_usd: numberOrNull(snapshot.final_value_usd),
      initial_value_usd: numberOrNull(tracked.initial_value_usd),
      pnl_source: "rpc",
      pnl_trusted: true,
    };
  } else {
    closedPnl = await fetchClosedPnlForPosition(tracked.pool, tracked.position, walletAddress);
    if (closedPnl) closedPnl.pnl_source = "meteora_closed_api";
    if (!closedPnl) {
      closedPnl = await fetchLPAgentClosedPnlForPosition(tracked.position, walletAddress, { urgent: true });
    }
  }
  const performance = buildManualClosePerformance(tracked, closedPnl);

  if (tracked.base_mint) {
    setTokenCloseCooldown({
      base_mint: tracked.base_mint,
      pool_name: tracked.pool_name || tracked.pool.slice(0, 8),
      position: tracked.position,
      reason: "External/manual close detected",
    });
  }

  if (!performance) {
    log("manual_close_warn", `External close ${tracked.position} detected but no reliable PnL snapshot was available; performance not recorded`);
    return;
  }

  const result = await recordPerformance(performance);
  if (result?.recorded) {
    log("manual_close", `Recorded external close for ${tracked.pool_name || tracked.pool}: pnl=${performance.pnl_sol ?? "?"} SOL source=${performance.pnl_source}`);
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
async function latestPositionSignature(positionAddress) {
  const signatures = await getConnection().getSignaturesForAddress(
    new PublicKey(positionAddress),
    { limit: 1 }
  );
  return signatures[0]?.signature || null;
}

async function refreshPnlDiscovery(walletAddress, { force = false } = {}) {
  if (!force && _pnlDiscovery && Date.now() - _pnlDiscoveryAt < PNL_DISCOVERY_TTL) {
    return _pnlDiscovery;
  }

  const portfolio = await fetchMeteoraPortfolio(walletAddress);
  const pools = Array.isArray(portfolio?.pools) ? portfolio.pools : [];
  const fallbackMaps = await Promise.all(
    pools.map((pool) => fetchMeteoraPoolPnl(pool.poolAddress, walletAddress).catch((error) => {
      log("pnl_api", `Meteora cost basis fetch failed for ${pool.poolAddress.slice(0, 8)}: ${error.message}`);
      return new Map();
    }))
  );

  for (let index = 0; index < pools.length; index++) {
    const pool = pools[index];
    const fallbackMap = fallbackMaps[index];
    for (const positionAddress of pool.listPositions || []) {
      const raw = fallbackMap.get(positionAddress);
      if (!raw) {
        log("pnl_api", `Meteora cost basis missing for ${positionAddress}`);
        continue;
      }
      const previous = _pnlCostBasis.get(positionAddress);
      _pnlCostBasis.set(positionAddress, {
        poolAddress: pool.poolAddress,
        raw,
        signature: previous?.signature ?? null,
      });
    }
  }

  const openAddresses = new Set(pools.flatMap((pool) => pool.listPositions || []));
  for (const address of _pnlCostBasis.keys()) {
    if (!openAddresses.has(address)) _pnlCostBasis.delete(address);
  }

  _pnlDiscovery = { walletAddress, pools };
  _pnlDiscoveryAt = Date.now();
  return _pnlDiscovery;
}

async function refreshChangedCostBasis(discovery, walletAddress) {
  const intervalMs = Math.max(0, config.schedule.pnlSignatureCheckIntervalMs ?? 60_000);
  if (Date.now() - _pnlSignaturesCheckedAt < intervalMs) return;
  _pnlSignaturesCheckedAt = Date.now();

  const entries = discovery.pools.flatMap((pool) =>
    (pool.listPositions || []).map((positionAddress) => ({ pool, positionAddress }))
  );
  const signatures = await Promise.allSettled(
    entries.map(({ positionAddress }) => latestPositionSignature(positionAddress))
  );
  const changedPools = new Set();

  for (let index = 0; index < entries.length; index++) {
    if (signatures[index].status !== "fulfilled") continue;
    const { pool, positionAddress } = entries[index];
    const signature = signatures[index].value;
    const cached = _pnlCostBasis.get(positionAddress);
    if (cached?.signature && signature && cached.signature !== signature) {
      changedPools.add(pool.poolAddress);
    }
    if (cached) cached.signature = signature;
  }

  await Promise.all([...changedPools].map(async (poolAddress) => {
    const latest = await fetchMeteoraPoolPnl(poolAddress, walletAddress);
    for (const [positionAddress, raw] of latest) {
      const cached = _pnlCostBasis.get(positionAddress);
      _pnlCostBasis.set(positionAddress, {
        poolAddress,
        raw,
        signature: cached?.signature ?? null,
      });
    }
  }));
}

function fallbackPosition(pool, positionAddress, raw) {
  const tracked = getTrackedPosition(positionAddress);
  const unclaimedUsd =
    pnlNumber(raw?.unrealizedPnl?.unclaimedFeeTokenX?.usd) +
    pnlNumber(raw?.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const unclaimedSol =
    pnlNumber(raw?.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) +
    pnlNumber(raw?.unrealizedPnl?.unclaimedFeeTokenY?.amountSol);
  const expectedSol = firstFiniteNumber(
    tracked?.expected_deposit_sol,
    tracked?.amount_sol,
    tracked?.requested_deposit_sol
  );
  const expectedUsd = firstFiniteNumber(tracked?.initial_value_usd);
  const rawUsd = calculateMeteoraPositionPnl(raw, "usd");
  const rawSol = calculateMeteoraPositionPnl(raw, "sol");
  const usd = calculatePnlWithDepositFallback({
    calculated: rawUsd,
    balance: raw?.unrealizedPnl?.balances,
    withdrawals: raw?.allTimeWithdrawals?.total?.usd,
    claimableFees: unclaimedUsd,
    claimedFees: raw?.allTimeFees?.total?.usd,
    indexedDeposits: raw?.allTimeDeposits?.total?.usd,
    fallbackDeposits: expectedUsd,
  });
  const sol = calculatePnlWithDepositFallback({
    calculated: rawSol,
    balance: raw?.unrealizedPnl?.balancesSol,
    withdrawals: raw?.allTimeWithdrawals?.total?.sol,
    claimableFees: unclaimedSol,
    claimedFees: raw?.allTimeFees?.total?.sol,
    indexedDeposits: raw?.allTimeDeposits?.total?.sol,
    fallbackDeposits: expectedSol,
  });
  const selected = config.management.solMode ? sol : usd;

  return applyPnlTrust({
    position: positionAddress,
    pool: pool.poolAddress,
    pair: tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
    base_mint: pool.tokenXMint,
    lower_bin: raw.lowerBinId ?? tracked?.bin_range?.min ?? null,
    upper_bin: raw.upperBinId ?? tracked?.bin_range?.max ?? null,
    active_bin: raw.poolActiveBinId ?? null,
    strategy: tracked?.strategy ?? null,
    in_range: !raw.isOutOfRange,
    unclaimed_fees_usd: config.management.solMode ? unclaimedSol : unclaimedUsd,
    total_value_usd: config.management.solMode
      ? pnlNumber(raw?.unrealizedPnl?.balancesSol)
      : pnlNumber(raw?.unrealizedPnl?.balances),
    total_value_true_usd: pnlNumber(raw?.unrealizedPnl?.balances),
    collected_fees_usd: config.management.solMode
      ? pnlNumber(raw?.allTimeFees?.total?.sol)
      : pnlNumber(raw?.allTimeFees?.total?.usd),
    collected_fees_true_usd: pnlNumber(raw?.allTimeFees?.total?.usd),
    pnl_usd: selected.pnl,
    pnl_true_usd: usd.pnl,
    pnl_sol: sol.pnl,
    pnl_pct: roundOrNull(selected.pnlPct, 4),
    pnl_source: "meteora_fallback",
    unclaimed_fees_true_usd: unclaimedUsd,
    fees_earned_sol: pnlNumber(raw?.allTimeFees?.total?.sol) + unclaimedSol,
    fee_per_tvl_24h: Math.round(pnlNumber(raw?.feePerTvl24h) * 100) / 100,
    age_minutes: raw?.createdAt
      ? Math.floor((Date.now() - raw.createdAt * 1000) / 60000)
      : null,
    minutes_out_of_range: minutesOutOfRange(positionAddress),
    instruction: tracked?.instruction ?? null,
  }, raw);
}

function unknownPnlPosition(pool, positionAddress, reason) {
  const tracked = getTrackedPosition(positionAddress);
  return {
    position: positionAddress,
    pool: pool.poolAddress,
    pair: tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
    base_mint: pool.tokenXMint,
    lower_bin: tracked?.bin_range?.min ?? null,
    upper_bin: tracked?.bin_range?.max ?? null,
    active_bin: tracked?.bin_range?.active ?? null,
    strategy: tracked?.strategy ?? null,
    in_range: !(pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress)),
    unclaimed_fees_usd: 0,
    total_value_usd: null,
    total_value_true_usd: null,
    collected_fees_usd: 0,
    collected_fees_true_usd: 0,
    pnl_usd: null,
    pnl_true_usd: null,
    pnl_sol: null,
    pnl_pct: null,
    pnl_source: "unknown",
    pnl_trusted: false,
    pnl_pending_reason: reason,
    unclaimed_fees_true_usd: 0,
    fees_earned_sol: null,
    fee_per_tvl_24h: null,
    age_minutes: tracked?.deployed_at
      ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
      : null,
    minutes_out_of_range: minutesOutOfRange(positionAddress),
    instruction: tracked?.instruction ?? null,
  };
}

function applyLpAgentPnl(position, lpAgentPnl) {
  if (!lpAgentPnl) return position;
  const pnlPct = numberOrNull(lpAgentPnl.pnlPct);
  const pnlUsd = numberOrNull(lpAgentPnl.pnlUsd);
  const pnlSol = numberOrNull(lpAgentPnl.pnlSol);
  if (pnlPct == null && pnlUsd == null && pnlSol == null) return position;

  const tracked = getTrackedPosition(position.position);
  const maxAbsPct = 500;
  if (pnlPct != null && Math.abs(pnlPct) > maxAbsPct) {
    log("positions_warn", `Rejected implausible LPAgent PnL for ${position.pair}: ${pnlPct}%`);
    return position;
  }

  position.pnl_source = "lpagent_fallback";
  position.pnl_trusted = true;
  position.pnl_pending_reason = null;
  if (pnlPct != null) position.pnl_pct = roundOrNull(pnlPct, 4);
  if (pnlUsd != null) {
    position.pnl_true_usd = pnlUsd;
    if (!config.management.solMode) position.pnl_usd = pnlUsd;
  }
  if (pnlSol != null) {
    position.pnl_sol = pnlSol;
    if (config.management.solMode) position.pnl_usd = pnlSol;
  } else if (config.management.solMode && pnlPct != null && tracked?.amount_sol) {
    position.pnl_sol = tracked.amount_sol * (pnlPct / 100);
    position.pnl_usd = position.pnl_sol;
  }
  if (lpAgentPnl.currentValue != null && Number.isFinite(Number(lpAgentPnl.currentValue))) {
    position.total_value_true_usd = Number(lpAgentPnl.currentValue);
    if (!config.management.solMode) position.total_value_usd = Number(lpAgentPnl.currentValue);
  }
  if (lpAgentPnl.feesCollected != null && Number.isFinite(Number(lpAgentPnl.feesCollected))) {
    position.collected_fees_true_usd = Number(lpAgentPnl.feesCollected);
    if (!config.management.solMode) position.collected_fees_usd = Number(lpAgentPnl.feesCollected);
  }
  return position;
}

function needsLpAgentFallback(position) {
  return position?.pnl_trusted === false ||
    (
      position?.pnl_pct == null &&
      position?.pnl_sol == null &&
      position?.pnl_true_usd == null &&
      position?.pnl_usd == null
    );
}

async function fetchLPAgentPnlMap(walletAddress, { urgent = false } = {}) {
  const ttl = Math.max(1_000, Number(
    urgent
      ? config.schedule.lpAgentPnlUrgentTtlMs
      : config.schedule.lpAgentPnlNormalTtlMs
  ) || (urgent ? 15_000 : 30_000));
  const cacheKey = walletAddress;
  const cached = _lpAgentPnlCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < ttl) return cached.map;
  if (cached?.retryAfterAt && now < cached.retryAfterAt) {
    if (cached.map?.size > 0) return cached.map;
    const waitSeconds = Math.ceil((cached.retryAfterAt - now) / 1000);
    throw new Error(`LPAgent fallback cooling down after ${cached.error || "rate limit"} (${waitSeconds}s)`);
  }

  try {
    const walletPnl = await fetchLPAgentWalletPnl(walletAddress);
    const map = new Map((walletPnl.positions || []).map((position) => [position.positionAddress, position]));
    _lpAgentPnlCache.set(cacheKey, { at: now, map });
    return map;
  } catch (error) {
    const backoffMs = error.status === 429
      ? Math.max(ttl, Number(config.schedule.lpAgentPnlRateLimitBackoffMs) || 60_000)
      : ttl;
    _lpAgentPnlCache.set(cacheKey, {
      at: cached?.at || 0,
      map: cached?.map || new Map(),
      error: error.message,
      retryAfterAt: now + backoffMs,
    });
    throw error;
  }
}

async function fetchOnChainPoolPositions(poolMeta, priceMap) {
  const pool = await getPool(poolMeta.poolAddress);
  const positionAddresses = poolMeta.listPositions || [];
  const [activeBin, ...onChainPositions] = await Promise.all([
    pool.getActiveBin(),
    ...positionAddresses.map((address) => pool.getPosition(new PublicKey(address))),
  ]);

  const tokenXMint = pool.tokenX.publicKey.toString();
  const tokenYMint = pool.tokenY.publicKey.toString();
  if (tokenYMint !== config.tokens.SOL) {
    throw new Error(`Unsupported non-SOL quote pool ${poolMeta.poolAddress}`);
  }

  const tokenXDecimals = pool.tokenX.mint.decimals;
  const tokenYDecimals = pool.tokenY.mint.decimals;
  const tokenXPriceSol = Number(pool.fromPricePerLamport(Number(activeBin.price)));
  const tokenXPriceUsd = priceMap.get(tokenXMint);
  const solPriceUsd = priceMap.get(tokenYMint);

  return onChainPositions.map((position, index) => {
    const positionAddress = positionAddresses[index];
    const costBasis = _pnlCostBasis.get(positionAddress)?.raw;
    if (!costBasis) throw new Error(`Cost basis unavailable for ${positionAddress}`);
    const tracked = getTrackedPosition(positionAddress);

    const data = position.positionData;
    if (!data.rewardOne.isZero() || !data.rewardTwo.isZero()) {
      throw new Error(`Reward valuation requires Meteora fallback for ${positionAddress}`);
    }

    const amountX = pnlNumber(data.totalXAmount) / (10 ** tokenXDecimals);
    const amountY = pnlNumber(data.totalYAmount) / (10 ** tokenYDecimals);
    const feeX = pnlNumber(data.feeX) / (10 ** tokenXDecimals);
    const feeY = pnlNumber(data.feeY) / (10 ** tokenYDecimals);
    const balanceSol = amountX * tokenXPriceSol + amountY;
    const claimableSol = feeX * tokenXPriceSol + feeY;
    const expectedSol = firstFiniteNumber(
      tracked?.expected_deposit_sol,
      tracked?.amount_sol,
      tracked?.requested_deposit_sol
    );
    const rawSolPnl = calculatePnl({
      balance: balanceSol,
      withdrawals: costBasis?.allTimeWithdrawals?.total?.sol,
      claimableFees: claimableSol,
      claimedFees: costBasis?.allTimeFees?.total?.sol,
      deposits: costBasis?.allTimeDeposits?.total?.sol,
    });
    const solPnl = calculatePnlWithDepositFallback({
      calculated: rawSolPnl,
      balance: balanceSol,
      withdrawals: costBasis?.allTimeWithdrawals?.total?.sol,
      claimableFees: claimableSol,
      claimedFees: costBasis?.allTimeFees?.total?.sol,
      indexedDeposits: costBasis?.allTimeDeposits?.total?.sol,
      fallbackDeposits: expectedSol,
    });

    if (!Number.isFinite(tokenXPriceUsd) || !Number.isFinite(solPriceUsd)) {
      throw new Error(`Jupiter price unavailable for ${positionAddress}`);
    }
    const balanceUsd = amountX * tokenXPriceUsd + amountY * solPriceUsd;
    const claimableUsd = feeX * tokenXPriceUsd + feeY * solPriceUsd;
    const expectedUsd = firstFiniteNumber(
      tracked?.initial_value_usd,
      expectedSol != null && Number.isFinite(solPriceUsd) ? expectedSol * solPriceUsd : null
    );
    const rawUsdPnl = calculatePnl({
      balance: balanceUsd,
      withdrawals: costBasis?.allTimeWithdrawals?.total?.usd,
      claimableFees: claimableUsd,
      claimedFees: costBasis?.allTimeFees?.total?.usd,
      deposits: costBasis?.allTimeDeposits?.total?.usd,
    });
    const usdPnl = calculatePnlWithDepositFallback({
      calculated: rawUsdPnl,
      balance: balanceUsd,
      withdrawals: costBasis?.allTimeWithdrawals?.total?.usd,
      claimableFees: claimableUsd,
      claimedFees: costBasis?.allTimeFees?.total?.usd,
      indexedDeposits: costBasis?.allTimeDeposits?.total?.usd,
      fallbackDeposits: expectedUsd,
    });
    const selected = config.management.solMode ? solPnl : usdPnl;
    if (!Number.isFinite(selected.pnlPct)) {
      throw new Error(`Invalid on-chain PnL for ${positionAddress}`);
    }

    const inRange = activeBin.binId >= data.lowerBinId && activeBin.binId <= data.upperBinId;
    return applyPnlTrust({
      position: positionAddress,
      pool: poolMeta.poolAddress,
      pair: tracked?.pool_name || `${poolMeta.tokenX}/${poolMeta.tokenY}`,
      base_mint: tokenXMint,
      lower_bin: data.lowerBinId,
      upper_bin: data.upperBinId,
      active_bin: activeBin.binId,
      strategy: tracked?.strategy ?? null,
      in_range: inRange,
      unclaimed_fees_usd: config.management.solMode ? claimableSol : claimableUsd,
      total_value_usd: config.management.solMode ? balanceSol : balanceUsd,
      total_value_true_usd: balanceUsd,
      collected_fees_usd: config.management.solMode
        ? pnlNumber(costBasis?.allTimeFees?.total?.sol)
        : pnlNumber(costBasis?.allTimeFees?.total?.usd),
      collected_fees_true_usd: pnlNumber(costBasis?.allTimeFees?.total?.usd),
      pnl_usd: selected.pnl,
      pnl_true_usd: usdPnl.pnl,
      pnl_sol: solPnl.pnl,
      pnl_pct: roundOrNull(selected.pnlPct, 4),
      pnl_source: "rpc",
      unclaimed_fees_true_usd: claimableUsd,
      fees_earned_sol: pnlNumber(costBasis?.allTimeFees?.total?.sol) + claimableSol,
      fee_per_tvl_24h: Math.round(pnlNumber(costBasis?.feePerTvl24h) * 100) / 100,
      age_minutes: costBasis?.createdAt
        ? Math.floor((Date.now() - costBasis.createdAt * 1000) / 60000)
        : null,
      minutes_out_of_range: minutesOutOfRange(positionAddress),
      instruction: tracked?.instruction ?? null,
    }, costBasis);
  });
}

export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  try {
    const snapshot = await getMyPositions({ force: true, silent: true, liveOnly: true });
    if (snapshot.stale) return { error: snapshot.error || "PnL snapshot is stale" };
    const position = snapshot.positions.find((item) =>
      item.position === position_address && item.pool === pool_address
    );
    if (!position) return { error: "Position not found in PnL snapshot" };

    return {
      pnl_usd: position.pnl_true_usd,
      pnl_sol: position.pnl_sol,
      pnl_pct: position.pnl_pct,
      pnl_trusted: position.pnl_trusted,
      pnl_pending_reason: position.pnl_pending_reason,
      current_value_usd: position.total_value_true_usd,
      unclaimed_fee_usd: position.unclaimed_fees_true_usd,
      all_time_fees_usd: position.collected_fees_true_usd,
      fee_per_tvl_24h: position.fee_per_tvl_24h,
      in_range: position.in_range,
      lower_bin: position.lower_bin,
      upper_bin: position.upper_bin,
      active_bin: position.active_bin,
      age_minutes: position.age_minutes,
      source: position.pnl_source,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, liveOnly = false, urgent = false } = {}) {
  if (!force && !liveOnly && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (
    force &&
    !liveOnly &&
    _positionsCache?.total_positions === 0 &&
    getTrackedPositions(true).length === 0 &&
    Date.now() - _positionsCacheAt < EMPTY_POSITIONS_CACHE_TTL
  ) {
    return _positionsCache;
  }
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => {
    try {
      const discovery = await refreshPnlDiscovery(walletAddress, {
        force: force && !liveOnly,
      });
      await refreshChangedCostBasis(discovery, walletAddress);

      let priceMap = new Map();
      try {
        priceMap = await fetchJupiterPrices(
          discovery.pools.flatMap((pool) => [pool.tokenXMint, pool.tokenYMint])
        );
      } catch (error) {
        log("pnl_price", `Jupiter price fetch failed: ${error.message}`);
      }

      const poolSnapshots = await Promise.all(discovery.pools.map(async (poolMeta) => {
        try {
          return await fetchOnChainPoolPositions(poolMeta, priceMap);
        } catch (error) {
          log("pnl_rpc_fallback", `${poolMeta.poolAddress.slice(0, 8)}: ${error.message}`);
          let meteoraError = null;
          try {
            const latest = await fetchMeteoraPoolPnl(poolMeta.poolAddress, walletAddress);
            const meteoraPositions = (poolMeta.listPositions || []).map((positionAddress) => {
              const raw = latest.get(positionAddress);
              if (!raw) throw new Error(`Fallback PnL missing for ${positionAddress}`);
              _pnlCostBasis.set(positionAddress, {
                poolAddress: poolMeta.poolAddress,
                raw,
                signature: _pnlCostBasis.get(positionAddress)?.signature ?? null,
              });
              return fallbackPosition(poolMeta, positionAddress, raw);
            });

            if (!meteoraPositions.some(needsLpAgentFallback)) {
              return meteoraPositions;
            }

            try {
              const lpAgentMap = await fetchLPAgentPnlMap(walletAddress, { urgent });
              return meteoraPositions.map((position) =>
                needsLpAgentFallback(position)
                  ? applyLpAgentPnl(position, lpAgentMap.get(position.position))
                  : position
              );
            } catch (lpAgentError) {
              if (!/cooling down/i.test(lpAgentError.message)) {
                log("pnl_lpagent_fallback", `${poolMeta.poolAddress.slice(0, 8)}: Meteora fallback had no trusted PnL; LPAgent fallback failed: ${lpAgentError.message}`);
              }
              return meteoraPositions;
            }
          } catch (fallbackError) {
            meteoraError = fallbackError;
            log("pnl_lpagent_fallback", `${poolMeta.poolAddress.slice(0, 8)}: Meteora fallback failed: ${fallbackError.message}`);
          }

          try {
            const lpAgentMap = await fetchLPAgentPnlMap(walletAddress, { urgent });
            return (poolMeta.listPositions || []).map((positionAddress) => {
              const base = unknownPnlPosition(poolMeta, positionAddress, meteoraError?.message || error.message);
              return applyLpAgentPnl(base, lpAgentMap.get(positionAddress));
            });
          } catch (lpAgentError) {
            log("pnl_unknown", `${poolMeta.poolAddress.slice(0, 8)}: LPAgent fallback failed: ${lpAgentError.message}`);
            return (poolMeta.listPositions || []).map((positionAddress) =>
              unknownPnlPosition(poolMeta, positionAddress, lpAgentError.message)
            );
          }
        }
      }));

      const positions = poolSnapshots.flat();
      for (const position of positions) {
        if (position.in_range) markInRange(position.position);
        else markOutOfRange(position.position);
      }

      const result = {
        wallet: walletAddress,
        total_positions: positions.length,
        positions,
        source: positions.every((position) => position.pnl_source === "rpc")
          ? "rpc"
          : "rpc_with_meteora_fallback",
        snapshot_at: Date.now(),
      };
      updatePositionSnapshots(positions);
      const detectedClosures = syncOpenPositions(
        positions.map((position) => position.position),
        { ignore_addresses: [..._closingPositions] }
      );
      _positionsCache = result;
      _positionsCacheAt = Date.now();
      if (detectedClosures.length > 0) {
        await Promise.allSettled(
          detectedClosures.map((tracked) => recordExternalClose(tracked, walletAddress))
        );
      }
      if (!silent) log("positions", `Fetched ${positions.length} position(s) via ${result.source}`);
      return result;
    } catch (error) {
      log("positions_error", `PnL snapshot failed: ${error.stack || error.message}`);
      if (_positionsCache) return { ..._positionsCache, stale: true, error: error.message };
      return {
        wallet: walletAddress,
        total_positions: 0,
        positions: [],
        stale: true,
        error: error.message,
      };
    } finally {
      _positionsInflight = null;
    }
  })();
  return _positionsInflight;
}

async function getMyPositionsLegacy({ force = false, silent = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    // Single portfolio API call — returns all positions with full PnL data
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          strategy:           tracked?.strategy ?? null,
          in_range:           !isOOR,
          unclaimed_fees_usd: (binData
            ? config.management.solMode
              ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
              : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
            : parseFloat(config.management.solMode ? (pool.unclaimedFeesSol || 0) : (pool.unclaimedFees || 0))),
          total_value_usd:    (binData
            ? config.management.solMode
              ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
              : parseFloat(binData.unrealizedPnl?.balances || 0)
            : parseFloat(config.management.solMode ? (pool.balancesSol || 0) : (pool.balances || 0))),
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: (binData
            ? parseFloat(binData.unrealizedPnl?.balances || 0)
            : parseFloat(pool.balances || 0)),
          collected_fees_usd: parseFloat(config.management.solMode ? (binData?.allTimeFees?.total?.sol || 0) : (binData?.allTimeFees?.total?.usd || 0)),
          collected_fees_true_usd: parseFloat(binData?.allTimeFees?.total?.usd || 0),
          pnl_usd:            parseFloat(binData
            ? config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)
            : config.management.solMode ? (pool.pnlSol || 0) : (pool.pnl || 0)),
          pnl_true_usd:       parseFloat(binData?.pnlUsd || 0),
          pnl_sol:            numberOrNull(binData?.pnlSol ?? pool.pnlSol),
          pnl_pct:            roundOrNull(binData
            ? config.management.solMode ? binData.pnlSolPctChange : binData.pnlPctChange
            : config.management.solMode ? pool.pnlSolPctChange : pool.pnlPctChange, 4),
          unclaimed_fees_true_usd: (binData
            ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
            : parseFloat(pool.unclaimedFees || 0)),
          fees_earned_sol: [
            binData?.allTimeFees?.total?.sol,
            binData?.unrealizedPnl?.unclaimedFeeTokenX?.amountSol,
            binData?.unrealizedPnl?.unclaimedFeeTokenY?.amountSol,
          ].some((value) => value != null)
            ? parseFloat(binData?.allTimeFees?.total?.sol ?? 0)
              + parseFloat(binData?.unrealizedPnl?.unclaimedFeeTokenX?.amountSol ?? 0)
              + parseFloat(binData?.unrealizedPnl?.unclaimedFeeTokenY?.amountSol ?? 0)
            : null,
          fee_per_tvl_24h:    Math.round(parseFloat(binData?.feePerTvl24h || pool.feePerTvl24h || 0) * 100) / 100,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    // ── LPAgent PnL enrichment (primary) ──
    // Override Meteora SDK PnL with LPAgent data for accuracy
    // Skip if no positions — saves API quota
    if (positions.length > 0) try {
      const walletPnl = await getWalletPnl(walletAddress);
      if (walletPnl?.source === "lpagent" && walletPnl.positions.length > 0) {
        const pnlMap = new Map(walletPnl.positions.map(p => [p.positionAddress, p]));
        for (const pos of positions) {
          const pnl = pnlMap.get(pos.position);
          if (!pnl) continue;
          const tracked = getTrackedPosition(pos.position);
          const meteoraPnlPct = pos.pnl_pct;
          const trustedPnl = selectTrustedPnlPct(pnl.pnlPct, meteoraPnlPct);
          if (trustedPnl.value != null) {
            pos.pnl_pct = Math.round(trustedPnl.value * 10000) / 10000;
            pos.pnlSolPctChange = pos.pnl_pct;
            pos.pnl_source = trustedPnl.source;
          }
          if (trustedPnl.rejected) {
            pos.pnl_integrity_reset = true;
            log(
              "positions_warn",
              `Rejected inconsistent LPAgent PnL for ${pos.pair}: lpagent=${pnl.pnlPct.toFixed(4)}%, meteora=${meteoraPnlPct.toFixed(4)}%, difference=${trustedPnl.differencePct.toFixed(4)}%`
            );
          }
          if (pnl.pnlUsd != null) pos.pnl_true_usd = pnl.pnlUsd;
          if (!config.management.solMode && pnl.pnlUsd != null) pos.pnl_usd = pnl.pnlUsd;
          if (pnl.currentValue > 0) {
            const expectedUsd = tracked?.initial_value_usd && pnl.pnlPct != null
              ? tracked.initial_value_usd * (1 + pnl.pnlPct / 100)
              : null;
            const valueMatchesPnl = !expectedUsd || Math.abs(pnl.currentValue - expectedUsd) / expectedUsd <= 0.5;
            if (valueMatchesPnl) {
              pos.total_value_true_usd = pnl.currentValue;
              if (!config.management.solMode) pos.total_value_usd = pnl.currentValue;
            } else {
              log("positions_warn", `Ignoring inconsistent LPAgent value for ${pos.pair}: current=${pnl.currentValue}, expected~${expectedUsd.toFixed(4)} from PnL ${pnl.pnlPct}%`);
            }
          }
          if (pnl.feesCollected > 0) {
            pos.collected_fees_true_usd = pnl.feesCollected;
            if (!config.management.solMode) pos.collected_fees_usd = pnl.feesCollected;
          }
        }
        if (!silent) log("positions", `LPAgent enriched ${positions.length} position(s) with PnL data`);
      }
    } catch (e) {
      log("positions_warn", `LPAgent enrichment failed: ${e.message}`);
    }

    if (config.management.solMode) {
      for (const pos of positions) {
        const tracked = getTrackedPosition(pos.position);
        const maxPlausibleSol = tracked?.amount_sol ? tracked.amount_sol * 10 : null;
        if (maxPlausibleSol && pos.total_value_usd > maxPlausibleSol) {
          const fallbackSol = pos.pnl_pct != null
            ? tracked.amount_sol * (1 + pos.pnl_pct / 100)
            : tracked.amount_sol;
          log("positions_warn", `Capped implausible SOL-mode value for ${pos.pair}: ${pos.total_value_usd} SOL -> ${fallbackSol.toFixed(6)} SOL`);
          pos.total_value_usd = Math.max(0, Math.round(fallbackSol * 1_000_000) / 1_000_000);
        }
      }
    }

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    updatePositionSnapshots(positions);
    const detectedClosures = syncOpenPositions(
      positions.map(p => p.position),
      { ignore_addresses: [..._closingPositions] }
    );
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    if (detectedClosures.length > 0) {
      await Promise.allSettled(
        detectedClosures.map((tracked) => recordExternalClose(tracked, walletAddress))
      );
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round((p?.pnlPctChange ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    _pnlDiscoveryAt = 0;
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
function isClosedPositionLookupError(error, positionAddress) {
  const message = String(error?.message || error || "");
  if (!message) return false;
  if (/position account .*not found/i.test(message)) return true;
  if (/account .*not found/i.test(message) && message.includes(positionAddress)) return true;
  if (/fallback pnl missing/i.test(message) && message.includes(positionAddress)) return true;
  return false;
}

export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  _closingPositions.add(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    let preClosePnl = _positionsCache?.positions?.find(
      (position) => position.position === position_address
    ) || null;
    if (!preClosePnl && tracked?.last_snapshot) {
      const snapshot = tracked.last_snapshot;
      preClosePnl = {
        pnl_source: snapshot.pnl_source,
        pnl_trusted: snapshot.pnl_trusted,
        pnl_pct: snapshot.pnl_pct,
        pnl_sol: snapshot.pnl_sol,
        pnl_true_usd: snapshot.pnl_usd,
        fees_earned_sol: snapshot.fees_earned_sol,
        collected_fees_true_usd: tracked.total_fees_claimed_usd || 0,
        unclaimed_fees_true_usd: Math.max(
          0,
          Number(snapshot.fees_earned_usd || 0) -
            Number(tracked.total_fees_claimed_usd || 0)
        ),
        total_value_true_usd: snapshot.final_value_usd,
      };
    }
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    _positionsCacheAt = 0;
    _pnlDiscoveryAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const accountInfo = await getConnection().getAccountInfo(positionPubKey);
        if (!accountInfo) {
          closedConfirmed = true;
          break;
        }
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/8)`);
      } catch (e) {
        if (isClosedPositionLookupError(e, position_address)) {
          log("close", `Close verification treated missing position account as success: ${e.message}`);
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/8): ${e.message}`);
      }
      if (attempt < 7) await new Promise((r) => setTimeout(r, 1000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      // Prefer trusted RPC PnL captured immediately before close.
      const rpcSnapshot = preClosePnl?.pnl_source === "rpc" &&
        preClosePnl?.pnl_trusted !== false
        ? preClosePnl
        : null;
      let pnlUsd = rpcSnapshot?.pnl_true_usd ?? rpcSnapshot?.pnl_usd ?? null;
      let pnlPct = rpcSnapshot?.pnl_pct ?? null;
      let finalValueUsd = rpcSnapshot?.total_value_true_usd ?? rpcSnapshot?.total_value_usd ?? null;
      let initialUsd = tracked.initial_value_usd ?? null;
      let feesUsd = rpcSnapshot
        ? (rpcSnapshot.collected_fees_true_usd || 0) + (rpcSnapshot.unclaimed_fees_true_usd || 0)
        : tracked.total_fees_claimed_usd ?? null;
      let pnlSol = rpcSnapshot?.pnl_sol ?? null;
      let feesSol = rpcSnapshot?.fees_earned_sol ?? null;
      let pnlSource = rpcSnapshot ? "rpc" : null;
      let pnlTrusted = rpcSnapshot != null;
      let posEntry = null;
      for (let retry = 0; !rpcSnapshot && retry < 3; retry++) {
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              pnlSol        = numberOrNull(posEntry.pnlSol);
              feesSol       = numberOrNull(posEntry.allTimeFees?.total?.sol);
              pnlUsd        = numberOrNull(posEntry.pnlUsd);
              pnlPct        = config.management.solMode
                ? numberOrNull(posEntry.pnlSolPctChange ?? posEntry.pnlPctChange)
                : numberOrNull(posEntry.pnlPctChange);
              finalValueUsd = numberOrNull(posEntry.allTimeWithdrawals?.total?.usd);
              initialUsd    = numberOrNull(posEntry.allTimeDeposits?.total?.usd);
              feesUsd       = numberOrNull(posEntry.allTimeFees?.total?.usd) ?? feesUsd;
              pnlSource     = (pnlSol != null || pnlUsd != null || pnlPct != null)
                ? "meteora_closed_api"
                : null;
              pnlTrusted    = pnlSource != null;
              log("close", `Closed PnL API fallback: pnl=${pnlUsd ?? "?"} USD (${pnlPct ?? "?"}%), withdrawn=${finalValueUsd ?? "?"}, deposited=${initialUsd ?? "?"}`);
              if (pnlSource) break;
              log("close_warn", `Closed PnL retry ${retry + 1}/3: Meteora entry had no usable PnL`);
            }
            log("close_warn", `Closed PnL retry ${retry + 1}/3: position not settled yet`);
          }
        } catch (e) {
          log("close_warn", `Closed PnL retry ${retry + 1}/3 failed: ${e.message}`);
        }
        if (retry < 2) await new Promise(r => setTimeout(r, 2000));
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd == null || finalValueUsd === 0) {
        const cachedPos = preClosePnl || _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlUsd        = cachedPos.pnl_true_usd ?? cachedPos.pnl_usd ?? null;
          pnlPct        = cachedPos.pnl_pct   ?? null;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd ?? null;
          pnlSol        = cachedPos.pnl_sol ?? (tracked.amount_sol && pnlPct != null ? tracked.amount_sol * (pnlPct / 100) : null);
          feesSol       = cachedPos.fees_earned_sol ?? null;
          pnlSource     = (pnlUsd != null || pnlPct != null || pnlSol != null)
            ? (cachedPos.pnl_source || "last_open_snapshot")
            : null;
          pnlTrusted    = pnlSource != null && cachedPos.pnl_trusted !== false;
          if (initialUsd > 0 && pnlUsd != null) {
            finalValueUsd = Math.max(0, initialUsd + pnlUsd - feesUsd);
            pnlPct = (pnlUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? null;
            if (finalValueUsd != null && pnlUsd != null) {
              initialUsd = Math.max(0, finalValueUsd + (feesUsd || 0) - pnlUsd);
            }
          }
          log("close_warn", `Using cached PnL fallback because canonical RPC data was unavailable`);
        }
      }
      if (!pnlSource) {
        const lpAgentClosed = await fetchLPAgentClosedPnlForPosition(position_address, wallet.publicKey.toString(), { urgent: true });
        if (lpAgentClosed) {
          pnlUsd = lpAgentClosed.pnl_usd;
          pnlPct = lpAgentClosed.pnl_pct;
          pnlSol = lpAgentClosed.pnl_sol ?? (tracked.amount_sol && pnlPct != null ? tracked.amount_sol * (pnlPct / 100) : null);
          feesUsd = lpAgentClosed.fees_earned_usd;
          feesSol = lpAgentClosed.fees_earned_sol;
          finalValueUsd = lpAgentClosed.final_value_usd;
          initialUsd = tracked.initial_value_usd ?? lpAgentClosed.initial_value_usd;
          pnlSource = "lpagent_fallback";
          pnlTrusted = true;
        }
      }

      recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility || null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        signal_snapshot: tracked.signal_snapshot || null,
        deployed_at: tracked.deployed_at || null,
        amount_sol: tracked.amount_sol,
        pnl_sol: pnlSol,
        pnl_usd: pnlUsd,
        pnl_source: pnlSource || "unknown",
        pnl_trusted: pnlTrusted,
        fees_earned_sol: feesSol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        close_source: "agent",
        position_rent_sol: tracked.position_rent_sol ?? null,
        position_extension_rent_sol: tracked.position_extension_rent_sol ?? null,
      }).catch(e => log("close_warn", `Async PnL record failed: ${e.message}`));

      const baseMint = pool.lbPair.tokenXMint.toString();
      const closeCooldown = setTokenCloseCooldown({
        base_mint: baseMint,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        position: position_address,
        reason: reason || "agent decision",
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        pnl_sol: pnlSol,
        fees_earned_usd: feesUsd,
        fees_earned_sol: feesSol,
        deployed_sol: tracked.amount_sol,
        strategy: tracked.strategy,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        base_mint: baseMint,
        close_cooldown: closeCooldown,
      };
    }

    const baseMint = pool.lbPair.tokenXMint.toString();
    const closeCooldown = setTokenCloseCooldown({
      base_mint: baseMint,
      pool_name: poolAddress.slice(0, 8),
      position: position_address,
      reason: reason || "agent decision",
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: baseMint,
      close_cooldown: closeCooldown,
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  } finally {
    _closingPositions.delete(position_address);
  }
}

// ─── Helpers ──────────────────────────────────────────────────
function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundOrNull(value, decimals = 2) {
  const number = numberOrNull(value);
  if (number == null) return null;
  const multiplier = 10 ** decimals;
  return Math.round(number * multiplier) / multiplier;
}

async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
