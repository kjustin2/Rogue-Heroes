// Is the pooled part-material cache bounded? Diagnostic.
import { startServer, killServer, findChromium, delay } from "../improve/lib/harness.mjs";
import { chromium } from "playwright-core";
const { server, url } = await startServer(5190);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu", { timeout: 15000 });
  await page.evaluate(() => { window.__rht.scenario("stress"); window.__rht.deselect(); });
  const count = () => page.evaluate(() => {
    const mats = new Set(); window.__rht.sceneRoot().traverse((o) => { if (o.material) mats.add(o.material.uuid); });
    return mats.size;
  });
  for (const t of [1, 3, 6, 12]) { await delay(t * 1000); console.log(`t+${t}s  scene materials: ${await count()}`); }
} finally { await browser.close(); killServer(server); }
