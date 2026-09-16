// Quick look: one gameplay-zoom screenshot per scenario to shots/look-<scenario>.png, with the
// perf counters. The fast pre-handoff check — not a gate. Run: npm run shots:look -- firefight siege
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5199, viewport: { width: 1600, height: 900 } });
const scenarios = process.argv.slice(2);
if (!scenarios.length) scenarios.push("firefight", "high-ground", "siege", "base-defense");
try {
  for (const s of scenarios) {
    await page.evaluate((s) => { window.__rht.scenario(s); window.__rht.deselect(); }, s);
    await delay(1400);
    await page.evaluate(() => window.__rht.setView({ zoom: 0.75, pitch: 0.62, yaw: 0.2 }));
    await delay(900);
    await page.screenshot({ path: `shots/look-${s}.png` });
    const perf = await page.evaluate(() => JSON.stringify(window.__rht.perf?.() ?? {}));
    console.log(s, perf.slice(0, 220));
  }
} finally { await close(); }
