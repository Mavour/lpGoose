import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = path.join(__dirname, "lessons.json");
const STATE_FILE = path.join(__dirname, "state.json");
const VPS_WALLET = "B3AKqvNjVmT5ZKRNPff6Vc4RmL54uscVzsyUvnvy1Bxm";

async function fetchClosedPnl(poolAddress, positionAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const entry = (data.positions || []).find(p => p.positionAddress === positionAddress);
  if (!entry) return null;
  return {
    pnlSol: parseFloat(entry.pnlSol ?? 0),
    feesSol: parseFloat(entry.allTimeFees?.total?.sol ?? 0),
  };
}

async function migrate() {
  const walletAddress = VPS_WALLET;
  console.log("Wallet:", walletAddress);

  // ── lessons.json ──
  if (fs.existsSync(LESSONS_FILE)) {
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    const perf = data.performance || [];
    const toUpdate = perf.filter(p => p.pnl_sol == null && p.position && p.pool);
    console.log(`\nlessons.json: ${perf.length} records, ${toUpdate.length} need pnl_sol`);

    let updated = 0, skipped = 0;
    for (let i = 0; i < toUpdate.length; i++) {
      const rec = toUpdate[i];
      const pnl = await fetchClosedPnl(rec.pool, rec.position, walletAddress);
      if (pnl) {
        rec.pnl_sol = pnl.pnlSol;
        rec.fees_earned_sol = rec.fees_earned_sol ?? pnl.feesSol;
        updated++;
      } else {
        skipped++;
      }
      if ((i + 1) % 10 === 0 || i === toUpdate.length - 1) {
        console.log(`  progress: ${i + 1}/${toUpdate.length} (updated=${updated}, skipped=${skipped})`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
    console.log(`lessons.json saved: ${updated} updated, ${skipped} skipped`);
  }

  // ── state.json ──
  if (fs.existsSync(STATE_FILE)) {
    const stateData = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const positions = Object.values(stateData.positions || {});
    const closed = positions.filter(p => p.closed && p.pnl_sol == null && p.position && p.pool);
    console.log(`\nstate.json: ${positions.length} positions, ${closed.length} closed need pnl_sol`);

    let updated = 0, skipped = 0;
    for (let i = 0; i < closed.length; i++) {
      const pos = closed[i];
      const pnl = await fetchClosedPnl(pos.pool, pos.position, walletAddress);
      if (pnl) {
        pos.pnl_sol = pnl.pnlSol;
        pos.fees_earned_sol = pos.fees_earned_sol ?? pnl.feesSol;
        updated++;
      } else {
        skipped++;
      }
      if ((i + 1) % 10 === 0 || i === closed.length - 1) {
        console.log(`  progress: ${i + 1}/${closed.length} (updated=${updated}, skipped=${skipped})`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
    console.log(`state.json saved: ${updated} updated, ${skipped} skipped`);
  }

  console.log("\nDone!");
}

migrate().catch(e => console.error("Migration failed:", e));
