const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

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

// ─── API: positions ───────────────────────────────────────
function apiPositions(req, res) {
  const sp = path.join(ROOT, 'state.json');
  fs.readFile(sp, 'utf-8', (e, d) => {
    if (e) return json(res, []);
    try {
      const state = JSON.parse(d);
      const list = Object.values(state.positions || {}).filter(p => !p.closed).map(p => ({
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
      json(res, list);
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
      const perf = (lessons.performance || []).map(p => ({
        pool_name:        p.pool_name,
        strategy:         p.strategy,
        pnl_usd:          p.pnl_usd ?? 0,
        pnl_pct:          p.pnl_pct ?? 0,
        minutes_held:     p.minutes_held ?? 0,
        fees_earned_usd:  p.fees_earned_usd ?? 0,
        close_reason:     p.close_reason || '-',
        range_efficiency: p.range_efficiency ?? 0,
        amount_sol:       p.amount_sol ?? 0,
        recorded_at:      p.recorded_at,
      })).reverse();
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

// ─── API: balance ─────────────────────────────────────────
function apiBalance(req, res) {
  try {
    // read all agent log files in chronological order
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    if (!files.length) return json(res, { balance: 0 });

    let balance = 0;
    let hasWalletLine = false;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(LOGS_DIR, file), 'utf-8').trim().split('\n');
      for (const line of lines) {
        // precise wallet balance → reset tracker
        const wm = line.match(/(?:wallet|balance)\s*[:\s]\s*([\d.]+)\s*SOL/i);
        if (wm) {
          balance = +wm[1];
          hasWalletLine = true;
          continue;
        }
        // SOL Balance | X.XX SOL format
        const bm = line.match(/SOL\s*Balance\s*[|\s]\s*([\d.]+)\s*SOL/i);
        if (bm) {
          balance = +bm[1];
          hasWalletLine = true;
          continue;
        }
        // deploy → subtract SOL (amount after comma = Y side = SOL)
        const dm = line.match(/\[DEPLOY\]\s*Amount:\s*[\d.]+\s*\w+,\s*([\d.]+)\s*Y/i);
        if (dm && hasWalletLine) {
          balance -= +dm[1];
          continue;
        }
        // close → add back withdrawn SOL (only if we have a known balance)
        const cm = line.match(/withdrawn=([\d.]+)/i);
        if (cm && hasWalletLine) {
          // withdrawn may be in USD; only use if units match — skip for now
        }
      }
    }

    if (hasWalletLine) {
      return json(res, { balance: +Math.max(balance, 0).toFixed(2) });
    }

    // last wallet line value if no deploy deductions needed
    const lastLog = files[files.length - 1];
    const allLines = fs.readFileSync(path.join(LOGS_DIR, lastLog), 'utf-8');
    const m = allLines.match(/(?:wallet|balance)\s*[:\s]\s*([\d.]+)\s*SOL/i);
    if (m) return json(res, { balance: +Number(m[1]).toFixed(2) });
  } catch {}

  json(res, { balance: 0 });
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
