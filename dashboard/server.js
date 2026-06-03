const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

// load .env
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
  for (const line of envText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const eq = t.indexOf('=');
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const SENSITIVE = /api[_.]?key|apikey|secret|private|password|chat[_.]?id|wallet|url$/i;

function filterSensitive(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(filterSensitive);
  const out = {};
  for (const [k, v] of Object.entries(obj))
    if (!SENSITIVE.test(k)) out[k] = filterSensitive(v);
  return out;
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function err(res, msg, code = 500) {
  json(res, { error: msg }, code);
}
function fail(res, code) {
  res.writeHead(code);
  res.end();
}

function serveFile(res, fp) {
  const ext = path.extname(fp).toLowerCase();
  fs.readFile(fp, (e, d) => {
    if (e) { fail(res, 404); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(d);
  });
}

// ─── helpers ──────────────────────────────────────────────
function httpGetJson(url, cb) {
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, { timeout: 8000 }, (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      try { cb(null, JSON.parse(d)); } catch (e) { cb(e); }
    });
  }).on('error', cb);
}

function getWalletPubkey() {
  try {
    const pk = process.env.WALLET_PRIVATE_KEY;
    if (!pk) return null;
    const bs58 = require(path.join(ROOT, 'node_modules', 'bs58'));
    return bs58.encode(bs58.decode(pk).slice(32, 64));
  } catch { return null; }
}

// ─── API: positions ───────────────────────────────────────
function apiPositions(req, res) {
  const sp = path.join(ROOT, 'state.json');
  fs.readFile(sp, 'utf-8', (e, d) => {
    if (e) return json(res, []);
    try {
      const state = JSON.parse(d);
      const positions = Object.values(state.positions || {}).filter(p => !p.closed);
      if (!positions.length) return json(res, []);

      let solMode = false;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'user-config.json'), 'utf-8'));
        solMode = !!cfg.solMode;
      } catch {}

      const baseList = positions.map(p => ({
        position:      p.position,
        pool:          p.pool,
        pool_name:     p.pool_name,
        strategy:      p.strategy,
        amount_sol:    p.amount_sol,
        amount_x:      p.amount_x,
        bin_range:     p.bin_range,
        bin_step:      p.bin_step,
        volatility:    p.volatility,
        fee_tvl_ratio: p.fee_tvl_ratio,
        organic_score: p.organic_score,
        initial_value_usd: p.initial_value_usd,
        out_of_range_since: p.out_of_range_since,
        deployed_at:   p.deployed_at,
        total_fees_claimed_usd: p.total_fees_claimed_usd,
        rebalance_count: p.rebalance_count,
        notes:         p.notes,
      }));

      const wallet = getWalletPubkey();
      if (!wallet) return json(res, baseList);

      const pools = [...new Set(positions.map(p => p.pool))];
      let pending = pools.length;
      const pnlByPos = {};

      for (const pool of pools) {
        const url = `https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${wallet}&status=open&pageSize=100&page=1`;
        httpGetJson(url, (err, data) => {
          if (!err && data) {
            const items = data.positions || data.data || [];
            for (const item of items) {
              const addr = item.positionAddress || item.address || item.position;
              if (addr) pnlByPos[addr] = item;
            }
          }
          pending--;
          if (pending === 0) respond();
        });
      }

      function respond() {
        const list = baseList.map(p => {
          const v = pnlByPos[p.position];
          return {
            ...p,
            pnl_sol: Number.isFinite(+(v?.pnlSol ?? NaN)) || Number.isFinite(+(v?.pnlUsd ?? NaN))
              ? +(v?.pnlSol ?? v?.pnlUsd ?? 0) : null,
            pnl_pct: Number.isFinite(+(v?.pnlSolPctChange ?? NaN))
                    || Number.isFinite(+(v?.pnlPctChange ?? NaN))
              ? +Math.round(+(v?.pnlSolPctChange ?? v?.pnlPctChange ?? 0) * 100) / 100 : null,
            unclaimed_fees_sol: Number.isFinite(+(v?.unrealizedPnl?.unclaimedFeeTokenX?.amountSol ?? NaN))
                            || Number.isFinite(+(v?.unrealizedPnl?.unclaimedFeeTokenY?.amountSol ?? NaN))
                            ? +Math.round((
                                +(v?.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0)
                              + +(v?.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                            ) * 1e8) / 1e8 : null,
            all_time_fees_sol:  Number.isFinite(+(v?.allTimeFees?.total?.sol ?? NaN))
                               ? +Math.round(+(v.allTimeFees.total.sol) * 1e8) / 1e8 : null,
          };
        });
        json(res, list);
      }

      if (!pools.length) respond();
    } catch { json(res, []); }
  });
}

// ─── API: history ─────────────────────────────────────────
function apiHistory(req, res) {
  const lp = path.join(ROOT, 'lessons.json');
  fs.readFile(lp, 'utf-8', (e, d) => {
    if (e) return json(res, []);
    try {
      const lessons = JSON.parse(d);
      const perf = (lessons.performance || []).map(p => {
        const pnlSol = p.pnl_sol ?? (
          p.amount_sol > 0 && p.initial_value_usd > 0
            ? (((p.final_value_usd ?? 0) + (p.fees_earned_usd ?? 0)) - (p.initial_value_usd ?? 0)) / (p.initial_value_usd / p.amount_sol)
            : 0
        );
        const feesSol = p.fees_earned_sol ?? (p.amount_sol > 0 && p.initial_value_usd > 0 ? (p.fees_earned_usd ?? 0) / (p.initial_value_usd / p.amount_sol) : 0);
        return {
          pool_name:        p.pool_name,
          strategy:         p.strategy,
          pnl_sol:          pnlSol,
          pnl_pct:          p.amount_sol > 0 ? (pnlSol / p.amount_sol) * 100 : 0,
          pnl_usd:          p.pnl_usd ?? 0,
          minutes_held:     p.minutes_held ?? 0,
          fees_earned_sol:  feesSol,
          fees_earned_usd:  p.fees_earned_usd ?? 0,
          close_reason:     p.close_reason || '-',
          range_efficiency: p.range_efficiency ?? 0,
          amount_sol:       p.amount_sol ?? 0,
          recorded_at:      p.recorded_at,
        };
      }).reverse();
      json(res, perf);
    } catch { json(res, []); }
  });
}

// ─── API: config ──────────────────────────────────────────
function apiConfig(req, res) {
  const cp = path.join(ROOT, 'user-config.json');
  fs.readFile(cp, 'utf-8', (e, d) => {
    if (e) return json(res, {});
    try { json(res, filterSensitive(JSON.parse(d))); }
    catch { json(res, {}); }
  });
}

// ─── RPC balance helper ──────────────────────────────────
function fetchRpcBalance(cb) {
  try {
    const rpcUrl = process.env.RPC_URL;
    const privB58 = process.env.WALLET_PRIVATE_KEY;
    if (!rpcUrl || !privB58) return cb(null);

    const bs58 = require(path.join(ROOT, 'node_modules', 'bs58'));
    const keyBytes = bs58.decode(privB58);
    // 64-byte Solana secret key: last 32 = pubkey
    const pubkey = bs58.encode(keyBytes.slice(32, 64));

    const u = new URL(rpcUrl);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey] });

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    };

    const cl = mod.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j?.result?.value != null) return cb(j.result.value / 1e9);
        } catch {}
        cb(null);
      });
    });
    cl.on('error', () => cb(null));
    cl.write(body);
    cl.end();
  } catch { cb(null); }
}

// ─── API: balance ─────────────────────────────────────────
function apiBalance(req, res) {
  fetchRpcBalance((sol) => {
    if (sol !== null) return json(res, { balance: +sol.toFixed(2) });
    // fallback: last wallet line from agent log
    try {
      const files = fs.readdirSync(LOGS_DIR)
        .filter(f => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse();
      for (const f of files) {
        const txt = fs.readFileSync(path.join(LOGS_DIR, f), 'utf-8');
        const m = txt.match(/(?:wallet)\s*[:\s]\s*([\d.]+)\s*SOL/i);
        if (m) return json(res, { balance: +Number(m[1]).toFixed(2) });
      }
    } catch {}
    json(res, { balance: 0 });
  });
}

// ─── API: log list ────────────────────────────────────────
function apiLogsList(req, res) {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort().reverse();
    json(res, files);
  } catch { json(res, []); }
}

// ─── API: log content ─────────────────────────────────────
function apiLogContent(req, res, u) {
  const name = u.searchParams.get('file');
  if (!name) return err(res, 'file param required', 400);
  const safe = path.basename(name);
  const fp = path.join(LOGS_DIR, safe);
  fs.readFile(fp, 'utf-8', (e, d) => {
    if (e) return err(res, 'not found', 404);
    json(res, { content: d, file: safe });
  });
}

// ─── API: log SSE stream ──────────────────────────────────
function apiLogStream(req, res, u) {
  const name = u.searchParams.get('file');
  if (!name) { res.writeHead(400); res.end('file param required'); return; }
  const safe = path.basename(name);
  const fp = path.join(LOGS_DIR, safe);
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const content = fs.readFileSync(fp, 'utf-8');
    res.write('event: full\ndata: ' + JSON.stringify(content) + '\n\n');
  } catch { res.write('event: error\ndata: "read fail"\n\n'); }

  let lastSize = fs.statSync(fp).size;

  const interval = setInterval(() => {
    try {
      if (!fs.existsSync(fp)) { clearInterval(interval); return; }
      const stats = fs.statSync(fp);
      if (stats.size > lastSize) {
        const buf = Buffer.alloc(stats.size - lastSize);
        const fd = fs.openSync(fp, 'r');
        fs.readSync(fd, buf, 0, buf.length, lastSize);
        fs.closeSync(fd);
        res.write('event: append\ndata: ' + JSON.stringify(buf.toString('utf-8')) + '\n\n');
        lastSize = stats.size;
      }
    } catch {}
  }, 1000);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 30000);

  req.on('close', () => { clearInterval(interval); clearInterval(ping); });
}

// ─── Router ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  switch (p) {
    case '/api/positions': return apiPositions(req, res);
    case '/api/history':   return apiHistory(req, res);
    case '/api/config':    return apiConfig(req, res);
    case '/api/balance':   return apiBalance(req, res);
    case '/api/logs':      return apiLogsList(req, res);
    case '/api/logs/content': return apiLogContent(req, res, u);
    case '/api/logs/stream':  return apiLogStream(req, res, u);
  }

  let filePath = p === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, p);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(__dirname)) { fail(res, 403); return; }
  serveFile(res, resolved);
});

server.listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
});
