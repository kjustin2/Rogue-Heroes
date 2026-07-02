// One-off: capture the base command deck showing classified troop cards + encrypted R&D,
// then research a doctrine and capture the reveal (NEW badges).
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5187;
const URL = `http://127.0.0.1:${PORT}`;
mkdirSync("shots/discovery", { recursive: true });

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
  return join(base, dir, "chrome-win", "chrome.exe");
}

let server = null;
let browser = null;
try {
  const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
  const until = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(URL)).ok) break; } catch {}
    if (Date.now() > until) throw new Error("no server");
    await delay(200);
  }
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${URL}/?lowfx=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");
  // Select the player base so the command deck shows the troop/tech decks.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 5000);
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    sim.debugSelect(base.id);
  });
  await delay(600);
  await page.screenshot({ path: "shots/discovery/1-classified-deck.png" });
  // Research Assault Doctrine -> reveal moment.
  await page.evaluate(() => window.__rht.researchTech("assault"));
  await delay(700);
  await page.screenshot({ path: "shots/discovery/2-revealed.png" });
  console.log("OK -> shots/discovery");
} finally {
  await browser?.close();
  server?.kill();
}
