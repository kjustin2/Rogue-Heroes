// Scene census: what actually gets drawn in the stress scenario. Diagnostic.
import { startServer, killServer, findChromium, delay } from "../improve/lib/harness.mjs";
import { chromium } from "playwright-core";
const PORT = Number(process.env.CENSUS_PORT ?? 5189);
const { server, url } = await startServer(PORT);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu", { timeout: 15000 });
  await page.evaluate(() => { window.__rht.scenario("stress"); window.__rht.deselect(); });
  await delay(1500);
  console.log(JSON.stringify(await page.evaluate(() => {
    const scene = window.__rht.sceneRoot();
    const bucket = {}; const mats = new Set(); const geos = new Set();
    let visibleMeshes = 0, casters = 0, lines = 0, sprites = 0;
    scene.traverse((o) => {
      if (o.isLineSegments || o.isLine) { lines++; }
      if (o.isSprite) sprites++;
      if (!o.isMesh) return;
      if (o.visible === false) return;
      visibleMeshes++;
      if (o.castShadow) casters++;
      mats.add(o.material.uuid); geos.add(o.geometry.uuid);
      const k = o.userData.partId ? "part" : o.userData.decor ? "decor" : o.userData.pickProxy ? "proxy" : (o.parent && o.parent.name) || "other";
      bucket[k] = (bucket[k] ?? 0) + 1;
    });
    return { visibleMeshes, casters, lines, sprites, uniqueMaterials: mats.size, uniqueGeometries: geos.size, bucket, entities: window.__rht.sim.entities.length };
  }), null, 1));
} finally { await browser.close(); killServer(server); }
