import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlToPlainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendMessage failed: ${e.message}`);
  }
}

export async function sendKeyboard(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendKeyboard ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendKeyboard failed: ${e.message}`);
  }
}

export async function editKeyboard(chat_id, message_id, text, inlineKeyboard) {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${BASE}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        message_id,
        text: String(text).slice(0, 4096),
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `editKeyboard ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `editKeyboard failed: ${e.message}`);
  }
}

export async function answerCallback(callbackQueryId, text = "") {
  if (!TOKEN) return;
  try {
    await fetch(`${BASE}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: String(text).slice(0, 200) }),
    });
  } catch (e) {
    log("telegram_error", `answerCallback failed: ${e.message}`);
  }
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  try {
    const htmlText = String(html).slice(0, 4096);
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendHTML ${res.status}: ${err.slice(0, 100)}`);
      await sendMessage(htmlToPlainText(htmlText));
    }
  } catch (e) {
    log("telegram_error", `sendHTML failed: ${e.message}`);
    await sendMessage(htmlToPlainText(html));
  }
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage, onCallback) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback) {
          const callbackChatId = String(callback.message?.chat?.id || "");
          if (callbackChatId !== chatId) {
            const from = callback.from?.username || callback.from?.first_name || "unknown";
            log("telegram", `Ignored callback from unauthorized chat ${callbackChatId} (${from}): ${callback.data}`);
            continue;
          }
          Promise.resolve(onCallback?.(callback)).catch((e) => {
            log("telegram_error", `Callback handler failed: ${e.message}`);
          });
          continue;
        }

        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        // Auto-register first sender as the owner
        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("telegram", `Registered chat ID: ${chatId}`);
          await sendMessage("Connected! I'm your LP agent. Ask me anything or use commands like /status.");
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) {
          const from = msg.from?.username || msg.from?.first_name || "unknown";
          log("telegram", `Ignored message from unauthorized chat ${incomingChatId} (${from}): ${msg.text}`);
          continue;
        }

        Promise.resolve(onMessage(msg.text)).catch((e) => {
          log("telegram_error", `Handler failed: ${e.message}`);
        });
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage, onCallback = null) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage, onCallback); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, binStep, baseFee }) {
  const safePair = escapeHtml(pair);
  const safeAmount = escapeHtml(amountSol);
  const safePosition = escapeHtml(position?.slice(0, 8));
  const safeTx = escapeHtml(tx?.slice(0, 16));
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${escapeHtml(binStep ?? "?")}  |  Base fee: ${escapeHtml(baseFee != null ? baseFee + "%" : "?")}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${safePair}\n` +
    `Amount: ${safeAmount} SOL\n` +
    priceStr +
    poolStr +
    `Position: <code>${safePosition}...</code>\n` +
    `Tx: <code>${safeTx}...</code>`
  );
}

function fmtSol(n, decimals = 4) {
  return n == null || !Number.isFinite(Number(n)) ? "?" : Number(n).toFixed(decimals);
}

function fmtUsd(n) {
  return n == null || !Number.isFinite(Number(n)) ? "?" : Number(n).toFixed(2);
}

function fmtMinutes(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return "?";
  const m = Math.max(0, Math.round(Number(minutes)));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export async function notifyClose({
  pair,
  pnlUsd,
  pnlPct,
  pnlSol,
  feesEarnedUsd,
  feesEarnedSol,
  deployedSol,
  strategy,
  holdMinutes,
  reason,
}) {
  const safePair = escapeHtml(pair);
  const safeStrategy = escapeHtml(strategy || "?");
  const safeReason = escapeHtml(reason || "agent decision");
  const safeDeployedSol = escapeHtml(deployedSol ?? "?");
  const displayPnlSol = pnlSol ?? (
    deployedSol != null && pnlPct != null ? Number(deployedSol) * (Number(pnlPct) / 100) : null
  );
  const pnlBasis = displayPnlSol ?? pnlUsd ?? 0;
  const isProfit = pnlBasis >= 0;
  const icon = isProfit ? "🟢" : "🔴";
  const sign = isProfit ? "+" : "-";
  const pct = `${sign}${fmtUsd(Math.abs(pnlPct ?? 0))}%`;

  if (config.management.solMode) {
    await sendHTML(
      `${icon} <b>Position Closed — ${safePair}</b>\n\n` +
      `💵 PnL: ${sign}◎${fmtSol(displayPnlSol == null ? null : Math.abs(displayPnlSol))} (${pct})\n` +
      `💰 Fees earned: ◎${fmtSol(feesEarnedSol ?? 0)} ($${fmtUsd(feesEarnedUsd ?? 0)})\n` +
      `🏦 Deployed: ${safeDeployedSol} SOL\n` +
      `📐 Strategy: ${safeStrategy}\n` +
      `⏱️ Hold time: ${fmtMinutes(holdMinutes)}\n` +
      `📋 Reason: ${safeReason}`
    );
    return;
  }

  await sendHTML(
    `${icon} <b>Position Closed — ${safePair}</b>\n\n` +
    `💵 PnL: ${sign}$${fmtUsd(Math.abs(pnlUsd ?? 0))} (${pct})\n` +
    `💰 Fees earned: $${fmtUsd(feesEarnedUsd ?? 0)}\n` +
    `🏦 Deployed: ${safeDeployedSol} SOL\n` +
    `📐 Strategy: ${safeStrategy}\n` +
    `⏱️ Hold time: ${fmtMinutes(holdMinutes)}\n` +
    `📋 Reason: ${safeReason}`
  );
  return;
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  const safeInput = escapeHtml(inputSymbol);
  const safeOutput = escapeHtml(outputSymbol);
  const safeAmountIn = escapeHtml(amountIn ?? "?");
  const safeAmountOut = escapeHtml(amountOut ?? "?");
  const safeTx = escapeHtml(tx?.slice(0, 16));
  await sendHTML(
    `🔄 <b>Swapped</b> ${safeInput} → ${safeOutput}\n` +
    `In: ${safeAmountIn} | Out: ${safeAmountOut}\n` +
    `Tx: <code>${safeTx}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${escapeHtml(pair)}\n` +
    `Been OOR for ${escapeHtml(minutesOOR)} minutes`
  );
}

export async function notifySupertrendWarning({
  pair,
  interval,
  pnlPct,
  feesEarnedSol,
  feesEarnedUsd,
  inRange,
  minutesOOR,
}) {
  const rangeStatus = inRange
    ? "IN RANGE"
    : `OUT OF RANGE${minutesOOR != null ? ` (${escapeHtml(minutesOOR)}m)` : ""}`;
  const fees = config.management.solMode
    ? `SOL ${fmtSol(feesEarnedSol ?? 0)} ($${fmtUsd(feesEarnedUsd ?? 0)})`
    : `$${fmtUsd(feesEarnedUsd ?? 0)}`;

  await sendHTML(
    `<b>Supertrend Warning - ${escapeHtml(pair)}</b>\n\n` +
    `Fresh bearish flip: ${escapeHtml(interval || "?")}\n` +
    `PnL: ${escapeHtml(pnlPct == null ? "?" : `${Number(pnlPct).toFixed(2)}%`)}\n` +
    `Fees: ${fees}\n` +
    `Range: ${rangeStatus}\n\n` +
    `<b>Position remains open.</b> Normal SL/TP and risk rules still apply.`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
