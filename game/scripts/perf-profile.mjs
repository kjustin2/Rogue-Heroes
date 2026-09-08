// ============================================================================
//  PERF PROFILE — where does the frame actually go?
// ----------------------------------------------------------------------------
//  Boots the stress scenario headless and records a V8 CPU profile via CDP, then
//  prints the heaviest self-time functions. Answers "what is slow" with a
//  measurement instead of a guess. Diagnostic tool: `node scripts/perf-profile.mjs`.
// ============================================================================
import { startServer, killServer, findChromium, delay } from "../improve/lib/harness.mjs";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PROFILE_PORT ?? 5188);
const SECONDS = Number(process.env.PROFILE_SECONDS ?? 5);
const QUERY = process.env.PROFILE_QUERY ?? "?lowfx=1";

const { server, url } = await startServer(PORT);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${url}/${QUERY}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu", { timeout: 15000 });
  await page.evaluate(() => { window.__rht.scenario("stress"); window.__rht.deselect(); });
  await delay(1200);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await delay(SECONDS * 1000);
  const { profile } = await cdp.send("Profiler.stop");

  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const total = profile.samples.length;
  for (const id of profile.samples) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"}  ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + 1);
  }
  console.log(`samples: ${total} over ${SECONDS}s  (${QUERY})`);
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
    .forEach(([k, v]) => console.log(`  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`));
} finally {
  await browser.close();
  killServer(server);
}
