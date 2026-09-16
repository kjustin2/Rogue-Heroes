// Infantry lineup: every infantry kind in a row, three-quarter view, two zooms, for proportion and
// identity review. Out: shots/lineup-near.png, shots/lineup-far.png
import { launchGame, delay } from "../improve/lib/harness.mjs";
const KINDS = ["soldier", "scout", "sniper", "striker", "heavy", "grenadier", "mortar", "medic", "engineer", "flamer", "droneop", "sapper", "jumper"];
const { page, close } = await launchGame({ port: 5204, viewport: { width: 1800, height: 700 } });
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click('[data-map="dustbowl"]');
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
  await page.evaluate((kinds) => {
    const sim = window.__rht.sim;
    kinds.forEach((kind, i) => { const u = sim.debugSpawn(kind, "player", { x: -9 + i * 1.5, z: 0 }); u.yaw = 0.5; });
    window.__rht.deselect();
  }, KINDS);
  await delay(2500); // let the kit GLB land and the rigs rebuild
  for (const [name, zoom] of [["near", 0.34], ["far", 0.62]]) {
    await page.evaluate((z) => window.__rht.setView({ x: 0, z: 0.6, zoom: z, pitch: 0.5, yaw: 0.35 }), zoom);
    await delay(500);
    await page.screenshot({ path: `shots/lineup-${name}.png` });
  }
  console.log("wrote shots/lineup-{near,far}.png");
} finally { await close(); }
