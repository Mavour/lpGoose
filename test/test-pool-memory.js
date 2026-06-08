import assert from "node:assert/strict";
import fs from "fs";
import { getTokenCloseCooldown, setTokenCloseCooldown } from "../pool-memory.js";

const file = "./pool-memory.json";
const backup = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

try {
  if (fs.existsSync(file)) fs.unlinkSync(file);

  const beforeDefault = Date.now();
  const defaultCooldown = setTokenCloseCooldown({
    base_mint: "DefaultDurationMint",
    pool_name: "DEFAULT-SOL",
  });

  assert.equal(defaultCooldown.saved, true);
  assert.ok(defaultCooldown.duration_minutes >= 1);
  assert.ok(new Date(defaultCooldown.cooldown_until).getTime() > beforeDefault);
  assert.ok(getTokenCloseCooldown("DefaultDurationMint"));

  const beforeExplicit = Date.now();
  const explicitCooldown = setTokenCloseCooldown({
    base_mint: "ExplicitDurationMint",
    pool_name: "EXPLICIT-SOL",
    duration_minutes: 2,
  });

  assert.equal(explicitCooldown.duration_minutes, 2);
  assert.ok(new Date(explicitCooldown.cooldown_until).getTime() > beforeExplicit);

  console.log("Pool memory cooldown tests passed");
} finally {
  if (backup == null) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, backup);
  }
}
