// What is that pink? Dump entity kinds + resolved part colours for a scenario. Diagnostic.
import { startServer, killServer, findChromium, delay } from "../improve/lib/harness.mjs";
import { chromium } from "playwright-core";
const SC = process.argv[2] ?? "siege";
const { server, url } = await startServer(5192);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu", { timeout: 15000 });
  await page.evaluate((s) => { window.__rht.scenario(s); window.__rht.deselect(); }, SC);
  await delay(1200);
  console.log(JSON.stringify(await page.evaluate(() => window.__rht.sim.entities
    .filter((e) => e.kind !== "cover")
    .map((e) => ({ id: e.id, kind: e.kind, team: e.team, colors: window.__rht.partColors(e.id).slice(0, 4) }))), null, 1));
} finally { await browser.close(); killServer(server); }
