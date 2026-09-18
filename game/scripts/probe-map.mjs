// Start a battle on one map headless and print any page error / frame error. Usage: node scripts/probe-map.mjs crossfire
import { launchGame, delay } from "../improve/lib/harness.mjs";
const map = process.argv[2] ?? "crossfire";
const { page, errors, close } = await launchGame({ port: 5209, query: "lowfx=1" });
try {
  await page.waitForFunction(() => Boolean(window.__rht), null, { timeout: 30000 });
  const err = await page.evaluate(async (m) => {
    try { window.__rht.startBattle(m, "destroy", "normal"); } catch (e) { return String(e.stack ?? e); }
    await new Promise((r) => setTimeout(r, 2500));
    return JSON.stringify(window.__rht.frameErrors?.() ?? null);
  }, map);
  console.log("in-page:", err);
  console.log("page errors:", errors.length ? errors : "none");
} finally { await close(); }
