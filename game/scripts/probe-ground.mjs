// Are the ground dashes texture, or geometry, or shadow? Strip each in turn. Diagnostic.
import { launchGame, delay } from "../improve/lib/harness.mjs";
const SC = process.argv[2] ?? "high-ground";
const { page, close } = await launchGame({ port: 5201, viewport: { width: 1400, height: 800 } });
try {
  await page.evaluate((s) => { window.__rht.scenario(s); window.__rht.deselect(); }, SC);
  await delay(1400);
  await page.evaluate(() => window.__rht.setView({ x: 6, z: 2, zoom: 0.9, pitch: 0.62, yaw: 0.2 }));
  await delay(600);
  await page.screenshot({ path: "shots/probe-g0-all.png" });

  // 1. albedo map off (flat colour, normal map kept)
  await page.evaluate(() => {
    window.__rht.sceneRoot().traverse((o) => { if (o.isMesh && o.material && o.material.map && o.receiveShadow) { o.material.map = null; o.material.needsUpdate = true; } });
  });
  await delay(500);
  await page.screenshot({ path: "shots/probe-g1-nomap.png" });

  // 2. normal map off as well
  await page.evaluate(() => {
    window.__rht.sceneRoot().traverse((o) => { if (o.isMesh && o.material && o.material.normalMap) { o.material.normalMap = null; o.material.needsUpdate = true; } });
  });
  await delay(500);
  await page.screenshot({ path: "shots/probe-g2-nonormal.png" });

  // 3. ambient particle bed off
  await page.evaluate(() => {
    window.__rht.sceneRoot().traverse((o) => { if (o.isPoints) o.visible = false; });
  });
  await delay(500);
  await page.screenshot({ path: "shots/probe-g3-nopoints.png" });
  console.log("ok");
} finally { await close(); }
