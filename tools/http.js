const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10_000);

export async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { timeoutMs: _timeoutMs, signal, ...fetchOptions } = options;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, { ...fetchOptions, signal });
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal, signal].filter(Boolean);
  const combinedSignal = signals.length > 1
    ? AbortSignal.any(signals)
    : signals[0];

  try {
    return await fetch(url, { ...fetchOptions, signal: combinedSignal });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new Error(`fetch timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}

export async function fetchJsonWithTimeout(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return response.json();
}
