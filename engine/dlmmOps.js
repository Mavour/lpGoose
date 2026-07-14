/**
 * Low-level Meteora DLMM ops for fee-maxi style lifecycle
 * (remove-all, re-add same position, open bid-ask/curve with raw amounts).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { instrumentConnection } from "../tools/rpc-telemetry.js";

const BASIS_POINT_MAX = 10_000;
const ZERO = new BN(0);

let _DLMM = null;
let _StrategyType = null;
let _connection = null;
let _wallet = null;
const poolCache = new Map();

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

function getConnection() {
  if (!_connection) {
    _connection = instrumentConnection(
      new Connection(process.env.RPC_URL, "confirmed"),
      "lifecycle-dlmm",
    );
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

export async function loadPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  const pool = poolCache.get(key);
  await pool.refetchStates();
  return pool;
}

export function encodeSecret(kp) {
  return bs58.encode(kp.secretKey);
}

export function loadPositionKeypair(secretB58) {
  return Keypair.fromSecretKey(bs58.decode(secretB58));
}

export async function getSolBalanceLamports() {
  const lamports = await getConnection().getBalance(getWallet().publicKey, "confirmed");
  return new BN(lamports);
}

export async function getTokenBalanceRaw(mint) {
  const mintPk = new PublicKey(mint);
  const res = await getConnection().getParsedTokenAccountsByOwner(
    getWallet().publicKey,
    { mint: mintPk },
    "confirmed",
  );
  let total = new BN(0);
  for (const { account } of res.value) {
    const amount = account.data?.parsed?.info?.tokenAmount?.amount ?? "0";
    total = total.add(new BN(amount));
  }
  return total;
}

export function maxDeployableSolLamports(minSolReserveSol, txFeeBufferSol, solBal, overheadSol = 0) {
  const reserve = new BN(Math.floor((Number(minSolReserveSol) || 0) * 1e9));
  const feeBuf = new BN(Math.floor((Number(txFeeBufferSol) || 0) * 1e9));
  const inTx = new BN(Math.floor((Number(overheadSol) || 0) * 1e9));
  const spendable = reserve.add(feeBuf).add(inTx);
  const bal = solBal || ZERO;
  return bal.gt(spendable) ? bal.sub(spendable) : ZERO;
}

export function clampPos(v) {
  return v.isNeg() ? ZERO : v;
}

export function applySafetyBps(amount, safetyBps = 9950) {
  if (amount.isZero() || safetyBps >= 10_000) return amount;
  return amount.muln(safetyBps).divn(10_000);
}

export async function getActiveBinInfo(poolAddress) {
  const pool = await loadPool(poolAddress);
  const bin = await pool.getActiveBin();
  return {
    binId: bin.binId,
    price: bin.price,
    pricePerToken: pool.fromPricePerLamport(Number(bin.price)),
  };
}

export async function findOnChainPosition(poolAddress, positionPubkey) {
  const pool = await loadPool(poolAddress);
  const wallet = getWallet();
  const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
  const pk = new PublicKey(positionPubkey);
  return userPositions.find((p) => p.publicKey.equals(pk)) ?? null;
}

async function sendAll(txs, signers, label) {
  const list = Array.isArray(txs) ? txs : [txs];
  const hashes = [];
  for (let i = 0; i < list.length; i++) {
    const hash = await sendAndConfirmTransaction(getConnection(), list[i], signers);
    hashes.push(hash);
    log("lifecycle_tx", `${label} ${i + 1}/${list.length}: ${hash}`);
  }
  return hashes;
}

/**
 * Remove 100% liquidity. claimClose=true also claims fees and closes account.
 */
export async function removeAll(poolAddress, positionPubkey, lower, upper, claimClose) {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would: "removeAll", position: positionPubkey, claimClose };
  }
  const pool = await loadPool(poolAddress);
  const wallet = getWallet();
  const txs = await pool.removeLiquidity({
    position: new PublicKey(positionPubkey),
    user: wallet.publicKey,
    fromBinId: lower,
    toBinId: upper,
    bps: new BN(BASIS_POINT_MAX),
    shouldClaimAndClose: claimClose,
  });
  return sendAll(txs, [wallet], claimClose ? "remove-close" : "remove-keep");
}

/**
 * Re-add Curve liquidity into the SAME position + SAME bin range (true reshape).
 */
export async function addCurveSameRange(poolAddress, positionPubkey, minBinId, maxBinId, totalX, totalY, slippagePct = 1) {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would: "addCurveSameRange", position: positionPubkey };
  }
  const { StrategyType } = await getDLMM();
  const pool = await loadPool(poolAddress);
  const wallet = getWallet();
  const txOrTxs = await pool.addLiquidityByStrategy({
    positionPubKey: new PublicKey(positionPubkey),
    user: wallet.publicKey,
    totalXAmount: totalX,
    totalYAmount: totalY,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType.Curve,
    },
    slippage: slippagePct,
  });
  return sendAll(txOrTxs, [wallet], "add-curve-same");
}

/**
 * Open new bid-ask single-side SOL position. Returns { position, secret, lower, upper, sigs }.
 */
export async function openSingleSideSol(poolAddress, minBinId, maxBinId, solLamports, slippagePct = 1) {
  if (process.env.DRY_RUN === "true") {
    const fake = Keypair.generate();
    return {
      dry_run: true,
      position: fake.publicKey.toBase58(),
      secret: encodeSecret(fake),
      lowerBin: minBinId,
      upperBin: maxBinId,
      signatures: [],
    };
  }
  const { StrategyType } = await getDLMM();
  const pool = await loadPool(poolAddress);
  const wallet = getWallet();
  const positionKp = Keypair.generate();
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    user: wallet.publicKey,
    totalXAmount: ZERO,
    totalYAmount: solLamports,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType.BidAsk,
    },
    slippage: slippagePct,
  });
  const signatures = await sendAll(tx, [wallet, positionKp], "open-bidask");
  return {
    position: positionKp.publicKey.toBase58(),
    secret: encodeSecret(positionKp),
    lowerBin: minBinId,
    upperBin: maxBinId,
    signatures,
  };
}

/**
 * Open new centered curve with raw X/Y amounts.
 */
export async function openCurveDouble(poolAddress, minBinId, maxBinId, totalX, totalY, slippagePct = 1) {
  if (process.env.DRY_RUN === "true") {
    const fake = Keypair.generate();
    return {
      dry_run: true,
      position: fake.publicKey.toBase58(),
      secret: encodeSecret(fake),
      lowerBin: minBinId,
      upperBin: maxBinId,
      signatures: [],
    };
  }
  const { StrategyType } = await getDLMM();
  const pool = await loadPool(poolAddress);
  const wallet = getWallet();
  const positionKp = Keypair.generate();
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    user: wallet.publicKey,
    totalXAmount: totalX,
    totalYAmount: totalY,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType.Curve,
    },
    slippage: slippagePct,
  });
  const signatures = await sendAll(tx, [wallet, positionKp], "open-curve");
  return {
    position: positionKp.publicKey.toBase58(),
    secret: encodeSecret(positionKp),
    lowerBin: minBinId,
    upperBin: maxBinId,
    signatures,
  };
}

export async function sleep(ms) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export function solToLamports(sol) {
  return new BN(Math.floor(Number(sol) * 1e9));
}

export function bnMin(...vals) {
  return vals.reduce((a, b) => (a.lte(b) ? a : b));
}

export { BN, ZERO };
