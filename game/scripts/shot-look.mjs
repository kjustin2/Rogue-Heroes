// Quick look: one gameplay-zoom screenshot per scenario to shots/look-<scenario>.png, with the
// perf counters. The fast pre-handoff check — not a gate. Run: npm run shots:look -- firefight siege
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5199, viewport: { width: 1600, height: 900 } });
const scenarios = process.argv.slice(2);
if (!scenarios.length) scenarios.push("firefight", "high-ground", "siege", "base-defense");
try {
  for (const spec of scenarios) {
    // "<scenario>:select" selects the first player unit; ":shoot" also arms the shoot intent.
    const [s, state] = spec.split(":");
    await page.evaluate((s) => { window.__rht.scenario(s); window.__rht.deselect(); }, s);
    await delay(1400);
    if (state) {
      await page.evaluate((state) => {
        const sim = window.__rht.sim;
        const unit = sim.entities.find((e) => e.team === "player" && (state === "base" ? e.kind === "base" : e.kind !== "base") && e.status.alive && e.kind !== "cover");
        if (unit) sim.select(unit.id);
        if (state === "shoot") window.__rht.setIntent("shoot");
      }, state);
      await delay(400);
    }
    await page.evaluate(() => window.__rht.setView({ zoom: 0.75, pitch: 0.62, yaw: 0.2 }));
    await delay(900);
    await page.screenshot({ path: `shots/look-${spec.replace(":", "-")}.png` });
    const perf = await page.evaluate(() => JSON.stringify(window.__rht.perf?.() ?? {}));
    console.log(s, perf.slice(0, 220));
  }
} finally { await close(); }
