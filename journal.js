import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const SCHEMA_VERSION = 1;
const DEFAULT_JOURNAL_FILE = "./position-journal.json";

function journalFile() {
  return process.env.MERIDIAN_JOURNAL_FILE || DEFAULT_JOURNAL_FILE;
}

function emptyJournal() {
  return {
    schema_version: SCHEMA_VERSION,
    records: {},
    last_updated: null,
  };
}

function clone(value) {
  if (value == null) return value;
  return structuredClone(value);
}

function loadJournal() {
  const file = journalFile();
  if (!fs.existsSync(file)) return emptyJournal();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.records ||= {};
    return data;
  } catch (error) {
    log("journal_warn", `Failed to read ${file}: ${error.message}`);
    return emptyJournal();
  }
}

function saveJournal(data) {
  const file = journalFile();
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  data.schema_version = SCHEMA_VERSION;
  data.last_updated = new Date().toISOString();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function countLegacyIncomplete(records) {
  const journaled = new Set(Object.keys(records || {}));
  try {
    if (!fs.existsSync("./lessons.json")) return 0;
    const legacy = JSON.parse(fs.readFileSync("./lessons.json", "utf8")).performance || [];
    return legacy.filter((record) =>
      record?.position &&
      !journaled.has(record.position) &&
      !record.signal_snapshot
    ).length;
  } catch {
    return 0;
  }
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactConfigSnapshot(activeConfig) {
  if (!activeConfig) return null;
  return clone({
    risk: activeConfig.risk,
    screening: activeConfig.screening,
    confidence: activeConfig.confidence,
    momentum: activeConfig.momentum,
    chartIndicators: activeConfig.chartIndicators,
    strategy: activeConfig.strategy,
    bottomSpotLP: activeConfig.bottomSpotLP,
    management: activeConfig.management,
  });
}

export function buildEntrySnapshot({
  pool,
  tokenInfo = null,
  smartWallets = null,
  decision = {},
  activeConfig = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  const audit = tokenInfo?.audit || {};
  const recentSmartWallets = decision.confidence?.recent_smart_wallets || [];
  const momentum = decision.momentum || pool?.momentum || null;

  return {
    schema_version: SCHEMA_VERSION,
    captured_at: capturedAt,
    sources: {
      pool_metrics: "meteora_pool_discovery",
      pool_metrics_timeframe: activeConfig?.screening?.timeframe ?? null,
      pool_fees: pool?.pool_fees_source ?? null,
      pool_fees_timeframe: pool?.pool_fees_timeframe ?? null,
      token_metrics: tokenInfo ? "jupiter_datapi" : null,
      price_action: momentum ? "gmgn_candles" : null,
    },
    pool: {
      address: pool?.pool ?? pool?.pool_address ?? null,
      name: pool?.name ?? null,
      bin_step: numberOrNull(pool?.bin_step),
      fee_pct: numberOrNull(pool?.fee_pct),
      active_tvl_usd: numberOrNull(pool?.active_tvl),
      fee_window_usd: numberOrNull(pool?.fee_window_usd),
      volume_window_usd: numberOrNull(pool?.volume_window),
      fee_active_tvl_ratio_pct: numberOrNull(pool?.fee_active_tvl_ratio),
      volatility: numberOrNull(pool?.volatility),
      active_positions: numberOrNull(pool?.active_positions),
      active_positions_pct: numberOrNull(pool?.active_pct),
      open_positions: numberOrNull(pool?.open_positions),
      swap_count: numberOrNull(pool?.swap_count),
      unique_traders: numberOrNull(pool?.unique_traders),
      pool_fees_sol: numberOrNull(pool?.pool_fees_sol),
    },
    token: {
      mint: pool?.base?.mint ?? tokenInfo?.mint ?? null,
      symbol: pool?.base?.symbol ?? tokenInfo?.symbol ?? null,
      market_cap_usd: numberOrNull(pool?.mcap ?? tokenInfo?.mcap),
      holders: numberOrNull(pool?.holders),
      organic_score: numberOrNull(pool?.organic_score),
      token_age_hours: numberOrNull(pool?.token_age_hours),
      launchpad: tokenInfo?.launchpad ?? null,
      developer: pool?.dev ?? null,
    },
    price_action: {
      price: numberOrNull(pool?.price ?? pool?.gmgn_price),
      price_change_pct: numberOrNull(pool?.price_change_pct),
      volume_change_pct: numberOrNull(pool?.volume_change_pct),
      fee_change_pct: numberOrNull(pool?.fee_change_pct),
      price_trend: pool?.price_trend ?? null,
      min_price: numberOrNull(pool?.min_price),
      max_price: numberOrNull(pool?.max_price),
      ath: numberOrNull(pool?.ath),
      price_vs_ath_pct: numberOrNull(pool?.price_vs_ath_pct),
      momentum: clone(momentum),
      supertrend_direction: pool?.supertrend_direction ?? null,
      supertrend_reason: pool?.supertrend_reason ?? null,
    },
    safety: {
      hard_gate_pass: pool?.hard_gate_pass === true,
      hard_gate_reason: pool?.hard_gate_reason ?? null,
      memory_risk: pool?.memory_risk ?? null,
      bot_holders_pct: numberOrNull(audit.bot_holders_pct),
      top_holders_pct: numberOrNull(audit.top_holders_pct),
      mint_authority_disabled: audit.mint_authority_disabled ?? null,
      freeze_authority_disabled: audit.freeze_authority_disabled ?? null,
      is_pvp: pool?.is_pvp ?? null,
      pvp_risk: pool?.pvp_risk ?? null,
      pvp_check_status: pool?.pvp_check_status ?? null,
      pvp_check_reason: pool?.pvp_check_reason ?? null,
    },
    decision: {
      strategy: decision.strategy ?? null,
      strategy_label: decision.strategy_label ?? null,
      amount_sol: numberOrNull(decision.amount_sol),
      sizing_action: decision.sizing_action ?? null,
      bins_below: numberOrNull(decision.bins_below),
      bins_above: numberOrNull(decision.bins_above),
      active_bin: numberOrNull(decision.active_bin),
      reason: decision.reason ?? null,
      confidence: clone(decision.confidence ?? null),
      signal: clone(decision.signal ?? null),
      smart_wallet_count: Array.isArray(smartWallets?.in_pool)
        ? smartWallets.in_pool.length
        : recentSmartWallets.length,
      config: compactConfigSnapshot(activeConfig),
    },
  };
}

export function recordJournalEntry({
  position,
  pool,
  poolName,
  deployedAt,
  entrySnapshot,
  fallbackEntry = {},
}) {
  if (!position) throw new Error("Journal entry requires position address");
  const data = loadJournal();
  const existing = data.records[position];
  if (existing?.entry) return { recorded: false, immutable: true };

  const snapshot = clone(entrySnapshot) || {
    schema_version: SCHEMA_VERSION,
    captured_at: deployedAt || new Date().toISOString(),
    ...clone(fallbackEntry),
  };
  data.records[position] = {
    schema_version: SCHEMA_VERSION,
    position,
    pool: pool ?? snapshot?.pool?.address ?? null,
    pool_name: poolName ?? snapshot?.pool?.name ?? null,
    status: "open",
    entry: snapshot,
    outcome: null,
    data_quality: {
      entry_complete: entrySnapshot != null,
      outcome_complete: false,
      historical: false,
    },
  };
  saveJournal(data);
  return { recorded: true };
}

export function recordJournalOutcome(performance) {
  if (!performance?.position) throw new Error("Journal outcome requires position address");
  const data = loadJournal();
  const existing = data.records[performance.position];
  const entrySnapshot = existing?.entry || clone(performance.signal_snapshot) || null;
  const pnlSource = performance.pnl_source || "unknown";

  data.records[performance.position] = {
    schema_version: SCHEMA_VERSION,
    position: performance.position,
    pool: performance.pool ?? existing?.pool ?? null,
    pool_name: performance.pool_name ?? existing?.pool_name ?? null,
    status: "closed",
    entry: entrySnapshot,
    outcome: {
      closed_at: performance.closed_at || performance.recorded_at || new Date().toISOString(),
      close_reason: performance.close_reason ?? null,
      close_source: performance.close_source ?? "agent",
      pnl_source: pnlSource,
      pnl_trusted: performance.pnl_trusted !== false,
      net_pnl_sol: numberOrNull(performance.pnl_sol),
      net_pnl_usd: numberOrNull(performance.pnl_usd),
      net_pnl_pct: numberOrNull(performance.pnl_pct),
      gross_fees_sol: numberOrNull(performance.fees_earned_sol),
      gross_fees_usd: numberOrNull(performance.fees_earned_usd),
      initial_value_usd: numberOrNull(performance.initial_value_usd),
      final_value_usd: numberOrNull(performance.final_value_usd),
      costs: {
        transaction_sol: numberOrNull(performance.transaction_cost_sol),
        position_rent_sol: numberOrNull(performance.position_rent_sol),
        position_extension_rent_sol: numberOrNull(performance.position_extension_rent_sol),
      },
      minutes_held: numberOrNull(performance.minutes_held),
      minutes_in_range: numberOrNull(performance.minutes_in_range),
      range_efficiency_pct: numberOrNull(performance.range_efficiency),
    },
    data_quality: {
      entry_complete: entrySnapshot != null,
      outcome_complete:
        numberOrNull(performance.pnl_sol) != null &&
        numberOrNull(performance.pnl_pct) != null,
      historical: existing?.data_quality?.historical ?? false,
      canonical_pnl: pnlSource === "rpc",
    },
  };
  saveJournal(data);
  return { recorded: true };
}

export function safeRecordJournalEntry(args) {
  try {
    return recordJournalEntry(args);
  } catch (error) {
    log("journal_warn", `Entry journal write failed: ${error.message}`);
    return { recorded: false, error: error.message };
  }
}

export function safeRecordJournalOutcome(performance) {
  try {
    return recordJournalOutcome(performance);
  } catch (error) {
    log("journal_warn", `Outcome journal write failed: ${error.message}`);
    return { recorded: false, error: error.message };
  }
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function groupStats(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()]
    .map(([name, rows]) => {
      const pnls = rows.map((row) => row.outcome.net_pnl_pct);
      const wins = pnls.filter((value) => value > 0).length;
      return {
        name,
        samples: rows.length,
        win_rate_pct: rows.length > 0 ? (wins / rows.length) * 100 : null,
        expectancy_pct: mean(pnls),
        catastrophic_loss_rate_pct:
          rows.length > 0
            ? (pnls.filter((value) => value <= -20).length / rows.length) * 100
            : null,
      };
    })
    .sort((a, b) => b.samples - a.samples);
}

function nestedNumber(record, pathParts) {
  let value = record.entry;
  for (const part of pathParts) value = value?.[part];
  return numberOrNull(value);
}

export function analyzeJournal({ minSamples = 3 } = {}) {
  const data = loadJournal();
  const all = Object.values(data.records || {});
  const legacyIncomplete = countLegacyIncomplete(data.records);
  const closed = all
    .filter((record) =>
      record.status === "closed" &&
      record.entry &&
      record.outcome?.net_pnl_pct != null
    )
    .sort((a, b) =>
      String(a.outcome.closed_at || "").localeCompare(String(b.outcome.closed_at || ""))
    );
  const canonical = closed.filter((record) => record.data_quality?.canonical_pnl);
  const analysisSet = canonical.length >= minSamples ? canonical : closed;
  const pnlPct = analysisSet.map((record) => record.outcome.net_pnl_pct);
  const pnlSol = analysisSet.map((record) => record.outcome.net_pnl_sol || 0);
  const wins = pnlPct.filter((value) => value > 0).length;

  let equity = 0;
  let peak = 0;
  let maxDrawdownSol = 0;
  for (const pnl of pnlSol) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdownSol = Math.max(maxDrawdownSol, peak - equity);
  }

  const numericFeatures = [
    ["pool.fee_active_tvl_ratio_pct", ["pool", "fee_active_tvl_ratio_pct"]],
    ["pool.volatility", ["pool", "volatility"]],
    ["pool.volume_window_usd", ["pool", "volume_window_usd"]],
    ["pool.active_tvl_usd", ["pool", "active_tvl_usd"]],
    ["token.market_cap_usd", ["token", "market_cap_usd"]],
    ["token.holders", ["token", "holders"]],
    ["token.organic_score", ["token", "organic_score"]],
    ["token.token_age_hours", ["token", "token_age_hours"]],
    ["price_action.price_change_pct", ["price_action", "price_change_pct"]],
    ["price_action.volume_change_pct", ["price_action", "volume_change_pct"]],
  ];
  const featureComparison = numericFeatures.map(([feature, parts]) => {
    const winners = analysisSet
      .filter((record) => record.outcome.net_pnl_pct > 0)
      .map((record) => nestedNumber(record, parts))
      .filter((value) => value != null);
    const losses = analysisSet
      .filter((record) => record.outcome.net_pnl_pct <= 0)
      .map((record) => nestedNumber(record, parts))
      .filter((value) => value != null);
    return {
      feature,
      winner_samples: winners.length,
      loss_samples: losses.length,
      winner_mean: mean(winners),
      loss_mean: mean(losses),
    };
  }).filter((row) => row.winner_samples + row.loss_samples >= minSamples);

  const volatilityBand = (record) => {
    const value = nestedNumber(record, ["pool", "volatility"]);
    if (value == null) return null;
    if (value < 2) return "volatility<2";
    if (value < 5) return "volatility_2_to_5";
    return "volatility>=5";
  };

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    data_quality: {
      total_records: all.length,
      closed_with_entry_and_pnl: closed.length,
      canonical_rpc_records: canonical.length,
      incomplete_records: legacyIncomplete + all.filter((record) =>
        !record.data_quality?.entry_complete || !record.data_quality?.outcome_complete
      ).length,
      legacy_incomplete_records: legacyIncomplete,
      analysis_source: analysisSet === canonical ? "rpc_only" : "all_valid_sources",
    },
    summary: {
      samples: analysisSet.length,
      wins,
      losses: analysisSet.length - wins,
      win_rate_pct: analysisSet.length > 0 ? (wins / analysisSet.length) * 100 : null,
      expectancy_pct: mean(pnlPct),
      total_pnl_sol: pnlSol.reduce((sum, value) => sum + value, 0),
      catastrophic_loss_rate_pct:
        analysisSet.length > 0
          ? (pnlPct.filter((value) => value <= -20).length / analysisSet.length) * 100
          : null,
      max_drawdown_sol: maxDrawdownSol,
    },
    cohorts: {
      strategy: groupStats(analysisSet, (record) =>
        record.entry?.decision?.strategy_label ||
        record.entry?.decision?.strategy ||
        null
      ),
      volatility: groupStats(analysisSet, volatilityBand),
    },
    loss_patterns: groupStats(
      analysisSet.filter((record) => record.outcome.net_pnl_pct <= 0),
      (record) => record.outcome.close_reason || "unknown"
    ).slice(0, 10),
    feature_comparison: featureComparison,
  };
}
