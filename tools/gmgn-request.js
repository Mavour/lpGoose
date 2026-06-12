import { log } from "../logger.js";

const MIN_REQUEST_GAP_MS = 750;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

let requestQueue = Promise.resolve();
let lastRequestStartedAt = 0;
let cooldownUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs)
    ? Math.max(1_000, dateMs - Date.now())
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

async function runRequest(url, options) {
  const now = Date.now();
  if (now < cooldownUntil) {
    const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);
    throw new Error(`GMGN 429: global cooldown active (${remainingSeconds}s remaining)`);
  }

  const waitMs = Math.max(0, MIN_REQUEST_GAP_MS - (now - lastRequestStartedAt));
  if (waitMs > 0) await sleep(waitMs);

  lastRequestStartedAt = Date.now();
  const response = await fetch(url, options);
  if (response.status === 429) {
    const cooldownMs = retryAfterMs(response);
    cooldownUntil = Date.now() + cooldownMs;
    log("gmgn_warn", `Rate limited; pausing all GMGN requests for ${Math.ceil(cooldownMs / 1000)}s`);
  }
  return response;
}

export function fetchGmgn(url, options = {}) {
  const request = requestQueue.then(
    () => runRequest(url, options),
    () => runRequest(url, options),
  );
  requestQueue = request.catch(() => {});
  return request;
}
