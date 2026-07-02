// Capture the support-power fly-ins: airstrike jet + bomb line, and the orbital lance
// beam. Burst-captures the resolve so different frames catch the jet, bombs and beam.
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5188;
const URL = `http://127.0.0.1:${PORT}`;
mkdirSync("shots/support", { recursive: true });

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
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");

  async function stageAndCall(kind, name) {
    await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    await page.evaluate(({ kind }) => {
      const sim = window.__rht.sim;
      sim.debugGrant("player", 9999);
      const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
      base.unlockedTech = ["assault", "ordnance", "armor", "siege"];
      for (const [x, z] of [[4, -2], [5.5, 0], [4, 2], [6.5, -1]]) sim.debugSpawn("soldier", "enemy", { x, z });
      sim.debugSelect(base.id);
      window.__rht.beginSupport(kind);
      window.__rht.queueSupportAt({ x: 5, z: 0 });
      window.__rht.setView({ x: 2, z: 0, zoom: 0.85, pitch: 0.5, yaw: 0.2 });
      window.__rht.endTurn();
    }, { kind });
    for (let i = 0; i < 16; i += 1) {
      await delay(380);
      // Re-pin the camera every frame — the resolve camera-assist drifts it away.
      await page.evaluate(() => window.__rht.setView({ x: 3, z: 0, zoom: 0.8, pitch: 0.46, yaw: 0.2 }));
      await page.screenshot({ path: `shots/support/${name}-${String(i).padStart(2, "0")}.png` });
      const phase = await page.evaluate(() => window.__rht.sim.phase);
      if (phase !== "resolve") break;
    }
  }

  await stageAndCall("airstrike", "airstrike");
  await stageAndCall("laser", "laser");
  await stageAndCall("cluster", "cluster");
  console.log("OK -> shots/support");
} finally {
  await browser?.close();
  server?.kill();
}
