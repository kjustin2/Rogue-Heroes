import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5176;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });

const serverLog = [];
let server = null;
let browser = null;

try {
  if (!(await isServerReady(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
    server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  }

  await waitForServer(URL, 20000);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  // Navigate the landing menu into a battle (Start Game -> Deploy) so HUD clicks land.
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-start]");
  await page.click("[data-start]");
  await page.waitForSelector(".menu-screen", { state: "detached", timeout: 4000 }).catch(() => {});

  const baseId = await page.evaluate(() => {
    window.__rht.reset();
    // Grant a comfortable treasury so the harness exercises mechanics, not the price curve.
    window.__rht.sim.economy.set("player", 2500);
    const base = window.__rht.sim.entities.find((entity) => entity.kind === "base" && entity.team === "player");
    return base ? base.id : null;
  });
  if (!baseId) throw new Error("No player base in scenario");
  const startMoney = await page.evaluate(() => window.__rht.money("player"));

  // 1) Deploy a Recruit straight from the base, through the real HUD command deck.
  await page.click(`[data-select="${baseId}"]`);
  try {
    await page.waitForSelector('[data-spawn="soldier"]', { timeout: 4000 });
  } catch {
    const diag = await page.evaluate(() => ({
      selectedId: window.__rht.sim.selectedId,
      phase: window.__rht.sim.phase,
      commandbar: document.querySelector(".commandbar")?.textContent?.slice(0, 300),
    }));
    throw new Error(`Base command deck never appeared: ${JSON.stringify(diag)}`);
  }
  const fieldBefore = await page.evaluate(() => window.__rht.sim.fieldUnitCount("player"));
  await page.click('[data-spawn="soldier"]');
  const afterDeploy = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    return {
      money: window.__rht.money("player"),
      field: sim.fieldUnitCount("player"),
      baseCp: base.commandPoints,
      spawned: sim.entities.some((e) => e.id.startsWith("p-spawn-")),
    };
  });
  if (!afterDeploy.spawned) throw new Error(`Deploy did not place a troop: ${JSON.stringify(afterDeploy)}`);
  if (afterDeploy.field !== fieldBefore + 1) throw new Error(`Field count did not grow: ${JSON.stringify({ fieldBefore, ...afterDeploy })}`);
  if (afterDeploy.money >= startMoney) throw new Error(`Deploy did not spend money: ${JSON.stringify({ startMoney, ...afterDeploy })}`);
  if (afterDeploy.baseCp !== 0) throw new Error(`Deploy did not spend the base CP: ${JSON.stringify(afterDeploy)}`);

  const moneyBar = await page.evaluate(() => document.querySelector(".money-bar")?.textContent ?? "");
  if (!/\d/.test(moneyBar)) throw new Error(`Missing treasury bar in HUD: "${moneyBar}"`);

  // 2) Next turn: upgrade income from the base.
  await resolveToCommand(page);
  await page.click(`[data-select="${baseId}"]`);
  await page.waitForSelector('[data-base-upgrade="income"]', { timeout: 4000 });
  const incomeBefore = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").incomeLevel ?? 0);
  const moneyBeforeIncome = await page.evaluate(() => window.__rht.money("player"));
  await page.click('[data-base-upgrade="income"]');
  const afterIncome = await page.evaluate(() => {
    const base = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
    return { incomeLevel: base.incomeLevel ?? 0, money: window.__rht.money("player") };
  });
  if (afterIncome.incomeLevel !== incomeBefore + 1) throw new Error(`Income upgrade did not raise the tier: ${JSON.stringify({ incomeBefore, ...afterIncome })}`);
  if (afterIncome.money >= moneyBeforeIncome) throw new Error(`Income upgrade did not spend money: ${JSON.stringify({ moneyBeforeIncome, ...afterIncome })}`);

  // 3) Next turn: research a tech-tree doctrine to unlock new troops.
  await resolveToCommand(page);
  await page.click(`[data-select="${baseId}"]`);
  await page.waitForSelector('[data-tech="assault"]', { timeout: 4000 });
  await page.click('[data-tech="assault"]');
  const techAfter = await page.evaluate(() => (window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").unlockedTech ?? []).includes("assault"));
  if (!techAfter) throw new Error("Research did not unlock the Assault doctrine");

  // 4) Next turn: the now-unlocked Striker can be deployed.
  await resolveToCommand(page);
  await page.click(`[data-select="${baseId}"]`);
  await page.waitForSelector('[data-spawn="striker"]:not([data-disabled="true"])', { timeout: 4000 });
  await page.click('[data-spawn="striker"]');
  const striker = await page.evaluate(() => window.__rht.sim.entities.some((e) => e.kind === "striker" && e.team === "player" && e.id.startsWith("p-spawn-")));
  if (!striker) throw new Error("Tech-unlocked Striker did not deploy");

  await page.screenshot({ path: join(OUT, "8-economy-deploy.png") });

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  const finalMoney = await page.evaluate(() => window.__rht.money("player"));
  console.log(`Economy passed: deployed troops, researched Assault, upgraded income, treasury $${finalMoney}`);
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}

async function resolveToCommand(page) {
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForFunction(() => window.__rht.sim.phase === "command", undefined, { timeout: 16000 });
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server still starting
    }
    await delay(250);
  }
  throw new Error(`Server did not start at ${url}\n${serverLog.join("")}`);
}

async function isServerReady(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const root = join(local, "ms-playwright");
  if (!existsSync(root)) throw new Error(`Missing Playwright browser cache: ${root}`);

  const matches = readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => join(root, name, "chrome-win64", "chrome.exe"))
    .filter((path) => existsSync(path))
    .sort();

  if (!matches.length) throw new Error(`No cached Chromium executable under ${root}`);
  return matches[matches.length - 1];
}
