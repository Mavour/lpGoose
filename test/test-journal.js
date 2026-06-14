import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeJournal,
  buildEntrySnapshot,
  recordJournalEntry,
  recordJournalOutcome,
  safeRecordJournalEntry,
} from "../journal.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-journal-"));
const journalPath = path.join(tempDir, "position-journal.json");
const previousPath = process.env.MERIDIAN_JOURNAL_FILE;
process.env.MERIDIAN_JOURNAL_FILE = journalPath;

try {
  const capturedAt = "2026-06-14T00:00:00.000Z";
  const poolInput = {
    pool: "PoolA",
    name: "TEST-SOL",
    bin_step: 100,
    fee_pct: 2,
    active_tvl: 50_000,
    fee_window_usd: 500,
    volume_window: 12_000,
    fee_active_tvl_ratio: 1,
    volatility: 3.5,
    holders: 2_000,
    mcap: 800_000,
    organic_score: 80,
    token_age_hours: 48,
    pool_fees_sol: 50,
    pool_fees_source: "gmgn_pool",
    pool_fees_timeframe: "24h",
    hard_gate_pass: true,
    base: { mint: "MintA", symbol: "TEST" },
  };
  const poolBefore = structuredClone(poolInput);
  const snapshot = buildEntrySnapshot({
    capturedAt,
    pool: poolInput,
    tokenInfo: {
      launchpad: "test",
      audit: {
        bot_holders_pct: 5,
        top_holders_pct: 20,
        mint_authority_disabled: true,
        freeze_authority_disabled: true,
      },
    },
    decision: {
      strategy: "bid_ask",
      amount_sol: 1,
      bins_below: 70,
      bins_above: 0,
      reason: "test",
      momentum: { valid: true, score: 80 },
    },
    activeConfig: {
      screening: { timeframe: "5m", minVolume: 500 },
      strategy: { strategy: "bid_ask" },
      management: { stopLossPct: -50 },
    },
  });

  assert.equal(snapshot.captured_at, capturedAt);
  assert.equal(snapshot.pool.volume_window_usd, 12_000);
  assert.equal(snapshot.token.market_cap_usd, 800_000);
  assert.equal(snapshot.safety.top_holders_pct, 20);
  assert.deepEqual(poolInput, poolBefore);

  assert.equal(recordJournalEntry({
    position: "PositionA",
    pool: "PoolA",
    poolName: "TEST-SOL",
    entrySnapshot: snapshot,
  }).recorded, true);

  const changed = structuredClone(snapshot);
  changed.pool.volume_window_usd = 999_999;
  assert.equal(recordJournalEntry({
    position: "PositionA",
    pool: "PoolA",
    poolName: "TEST-SOL",
    entrySnapshot: changed,
  }).immutable, true);

  recordJournalOutcome({
    position: "PositionA",
    pool: "PoolA",
    pool_name: "TEST-SOL",
    signal_snapshot: changed,
    pnl_sol: 0.1,
    pnl_usd: 10,
    pnl_pct: 10,
    fees_earned_sol: 0.02,
    fees_earned_usd: 2,
    initial_value_usd: 100,
    final_value_usd: 108,
    minutes_held: 60,
    minutes_in_range: 45,
    range_efficiency: 75,
    close_reason: "take profit",
    close_source: "agent",
    pnl_source: "rpc",
    pnl_trusted: true,
  });

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const record = journal.records.PositionA;
  assert.equal(record.entry.pool.volume_window_usd, 12_000);
  assert.equal(record.outcome.net_pnl_sol, 0.1);
  assert.equal(record.outcome.gross_fees_sol, 0.02);
  assert.equal(record.data_quality.canonical_pnl, true);

  const beforeAnalysis = fs.readFileSync(journalPath, "utf8");
  const analysis = analyzeJournal({ minSamples: 1 });
  const afterAnalysis = fs.readFileSync(journalPath, "utf8");
  assert.equal(afterAnalysis, beforeAnalysis);
  assert.equal(analysis.summary.samples, 1);
  assert.equal(analysis.summary.expectancy_pct, 10);
  assert.equal(analysis.summary.total_pnl_sol, 0.1);
  assert.equal(analysis.data_quality.analysis_source, "rpc_only");

  process.env.MERIDIAN_JOURNAL_FILE = tempDir;
  const failed = safeRecordJournalEntry({
    position: "PositionB",
    entrySnapshot: snapshot,
  });
  assert.equal(failed.recorded, false);
  assert.ok(failed.error);

  console.log("Journal tests passed");
} finally {
  if (previousPath == null) delete process.env.MERIDIAN_JOURNAL_FILE;
  else process.env.MERIDIAN_JOURNAL_FILE = previousPath;
  fs.rmSync(tempDir, { recursive: true, force: true });
}
