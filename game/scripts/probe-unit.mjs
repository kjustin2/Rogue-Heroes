// Resolved part colours for one unit kind — what is actually bright on a trooper. Diagnostic.
import { startServer, killServer, findChromium, delay } from "../improve/lib/harness.mjs";
import { chromium } from "playwright-core";
const KIND = process.argv[2] ?? "heavy";
const { server, url } = await startServer(5193);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu", { timeout: 15000 });
  await page.evaluate(() => { window.__rht.scenario("roster"); window.__rht.deselect(); });
  await delay(1500);
  console.log(JSON.stringify(await page.evaluate((k) => {
    const e = window.__rht.sim.entities.find((x) => x.kind === k);
    if (!e) return { error: "not spawned" };
    const lum = (h) => { const n = parseInt(h.slice(1), 16); return Math.round((((n>>16)&255)*0.299 + ((n>>8)&255)*0.587 + (n&255)*0.114)); };
    return window.__rht.partColors(e.id).map((p) => ({ ...p, lum: lum(p.color) })).sort((a,b) => b.lum - a.lum).slice(0, 12);
  }, KIND), null, 1));
} finally { await browser.close(); killServer(server); }
