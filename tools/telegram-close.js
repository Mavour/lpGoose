export function parseFastCloseCommand(text) {
  const trimmed = String(text || "").trim();
  if (/^\/?(?:close|exit|sell)$/i.test(trimmed)) {
    return { target: null, singleOpenPosition: true, closeAll: false };
  }
  const match = trimmed.match(/^\/?(?:close|exit|sell)\s+(.+)$/i);
  if (!match) return null;
  const target = match[1].trim();
  if (!target || /^\d+$/.test(target)) return null;
  if (/^(?:all|semua)$/i.test(target)) {
    return { target: null, singleOpenPosition: false, closeAll: true };
  }
  return { target, singleOpenPosition: false, closeAll: false };
}

export function normalizeCloseTarget(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(sol|dlmm|pool|position)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function positionSearchTerms(position) {
  return [
    position.pair,
    position.pool_name,
    position.symbol,
    position.base_symbol,
    position.base?.symbol,
    position.position,
    position.pool,
  ].filter(Boolean).map(normalizeCloseTarget).filter(Boolean);
}

export function resolveCloseMatches(positions, target) {
  const normalizedTarget = normalizeCloseTarget(target);
  if (!normalizedTarget) return [];
  return (positions || []).map((position, index) => ({ ...position, _closeIndex: index + 1 })).filter((position) => {
    const terms = positionSearchTerms(position);
    return terms.some((term) =>
      term === normalizedTarget ||
      term.includes(normalizedTarget) ||
      normalizedTarget.includes(term)
    );
  });
}
