import { log } from "../logger.js";

const RPC_METHODS = [
  "getAccountInfo",
  "getParsedAccountInfo",
  "getMultipleAccountsInfo",
  "getBalance",
  "getProgramAccounts",
  "getLatestBlockhash",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "simulateTransaction",
  "sendTransaction",
  "sendRawTransaction",
  "confirmTransaction",
];

const counts = new Map();
let started = false;

function bump(method) {
  counts.set(method, (counts.get(method) || 0) + 1);
}

export function recordRpcMethod(method) {
  bump(method);
}

export function instrumentConnection(connection, label = "rpc") {
  if (!connection || connection.__meridianRpcInstrumented) return connection;
  for (const method of RPC_METHODS) {
    const original = connection[method];
    if (typeof original !== "function") continue;
    connection[method] = function instrumentedRpcMethod(...args) {
      bump(method);
      return original.apply(this, args);
    };
  }
  Object.defineProperty(connection, "__meridianRpcInstrumented", {
    value: { label },
    enumerable: false,
  });
  startRpcTelemetry();
  return connection;
}

export function snapshotRpcTelemetry({ reset = false } = {}) {
  const snapshot = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  if (reset) counts.clear();
  return snapshot;
}

export function startRpcTelemetry(intervalMs = 5 * 60_000) {
  if (started || process.env.RPC_TELEMETRY_DISABLED === "true") return;
  started = true;
  const timer = setInterval(() => {
    const snapshot = snapshotRpcTelemetry({ reset: true });
    if (Object.keys(snapshot).length === 0) return;
    const summary = Object.entries(snapshot)
      .map(([method, count]) => `${method}=${count}`)
      .join(" ");
    log("rpc", summary);
  }, intervalMs);
  timer.unref?.();
}
