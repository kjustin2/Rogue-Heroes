// Gas cloud look: rupture a canister on Ironworks, grow it two turns, then light it. Diagnostic.
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5201, viewport: { width: 1400, height: 800 } });
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click('[data-map="ironworks"]');
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
  const at = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const can = sim.debugCover("gas", { x: 2, z: 1 });
    const bystander = sim.debugSpawn("soldier", "enemy", { x: 3.5, z: 1 });
    for (const p of bystander.parts) if (p.role === "mobility") p.hp = 0;
    bystander.status.canMove = false;
    sim.debugDamage(can.id, can.parts[0].id, 999, bystander.id);
    window.__rht.setView({ x: 2, z: 1, zoom: 0.55, pitch: 0.6, yaw: 0.4 });
    window.__rht.deselect();
    return sim.gasClouds.length;
  });
  console.log("clouds:", at);
  await delay(800);
  await page.screenshot({ path: "shots/gas-1-leak.png" });
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() => window.__rht.endTurn());
    await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 });
    await page.evaluate(() => { window.__rht.setView({ x: 2, z: 1, zoom: 0.55, pitch: 0.6, yaw: 0.4 }); window.__rht.deselect(); });
    await delay(500);
  }
  await page.screenshot({ path: "shots/gas-2-grown.png" });
  console.log("log:", JSON.stringify(await page.evaluate(() => window.__rht.sim.log.slice(0, 6))));
} finally { await close(); }
