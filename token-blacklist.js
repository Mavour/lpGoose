/**
 * Token blacklist — mints the agent should never deploy into.
 *
 * Agent can blacklist via Telegram ("blacklist this token, it rugged").
 * Screening filters blacklisted tokens before passing pools to the LLM.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLACKLIST_FILE = path.join(__dirname, "token-blacklist.json");

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

export function parseBlacklistCommand(text) {
  const input = String(text || "").trim();
  if (/^\/?(?:list\s+blacklist|blacklist\s+list)$/i.test(input)) {
    return { action: "list" };
  }

  const remove = input.match(/^\/?(?:remove\s+blacklist|unblacklist)\s+(\S+)$/i);
  if (remove) {
    return { action: "remove", target: remove[1] };
  }

  const add = input.match(/^\/?blacklist\s+(\S+)\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+(.+))?$/i);
  if (add) {
    return {
      action: "add",
      symbol: add[1],
      mint: add[2],
      reason: add[3]?.trim() || "Manually blacklisted from Telegram",
    };
  }

  return null;
}

export function resolveBlacklistMint(target) {
  if (!target) return null;
  const db = load();
  if (db[target]) return target;
  const normalized = String(target).toUpperCase();
  const matches = Object.entries(db)
    .filter(([, info]) => String(info?.symbol || "").toUpperCase() === normalized)
    .map(([mint]) => mint);
  return matches.length === 1 ? matches[0] : null;
}

// ─── Check ─────────────────────────────────────────────────────

/**
 * Returns true if the mint is on the blacklist.
 * Used in screening.js before returning pools to the LLM.
 */
export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = load();
  return !!db[mint];
}

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Tool handler: add_to_blacklist
 */
export function addToBlacklist({ mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
    };
  }

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

/**
 * Tool handler: remove_from_blacklist
 */
export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };

  const db = load();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

/**
 * Tool handler: list_blacklist
 */
export function listBlacklist() {
  const db = load();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}
