import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, launchGame } from "../improve/lib/harness.mjs";

const PORT = 5179;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });

const { page, errors, close } = await launchGame({ port: PORT, query: "lowfx=1" });

try {
  await page.waitForSelector(".main-menu");
  // Every automated run must be silent — permanent guard on the audio mute gate.
  if (!(await page.evaluate(() => window.__rht.audioMuted()))) throw new Error("audio not muted under automation");
  await page.screenshot({ path: join(OUT, "6-menu.png") });

  // Enter the deploy screen, pick a specific map + mode through the menu, then deploy.
  await page.click('[data-menu="play"]');
  await page.waitForSelector('[data-map="ironworks"]');
  await page.click('[data-map="ironworks"]');
  await page.click('[data-mode="ctf"]');
  await page.click("[data-start]");
  await page.waitForSelector(".title-screen", { state: "detached", timeout: 4000 }).catch(() => {});
  await assertLit(page, "flow command");

  const startState = await page.evaluate(() => ({
    map: window.__rht.sim.mapDef.id,
    mode: window.__rht.sim.mode,
    players: window.__rht.sim.fieldUnitCount("player"),
    enemies: window.__rht.sim.fieldUnitCount("enemy"),
    modeChip: Boolean(document.querySelector(".mode-chip")),
  }));
  if (startState.map !== "ironworks" || startState.mode !== "ctf") {
    throw new Error(`Menu selection not applied: ${JSON.stringify(startState)}`);
  }
  if (startState.players !== 0 || startState.enemies !== 0) {
    throw new Error(`Battle should start with no units deployed: ${JSON.stringify(startState)}`);
  }
  if (!startState.modeChip) throw new Error("Mode/score chip missing from HUD");

  // Research a doctrine, then deploy a couple of troops over the next turns.
  const built = await page.evaluate(async () => {
    const api = window.__rht;
    const sim = api.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    sim.select(base.id);
    // Grant a comfortable treasury so the harness exercises mechanics, not the price curve.
    sim.economy.set("player", 2000);
    api.researchTech("assault");
    api.endTurn();
  });
  void built;
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 2, undefined, { timeout: 16000 });

  await page.evaluate(() => {
    const api = window.__rht;
    api.sim.economy.set("player", 2000);
    api.sim.select(api.sim.entities.find((e) => e.kind === "base" && e.team === "player").id);
    api.queueSpawnTroop("striker");
    api.endTurn();
  });
  await page.waitForFunction(() => window.__rht.sim.phase === "resolve" || window.__rht.sim.turn >= 3, undefined, { timeout: 6000 });
  await assertLit(page, "flow resolve");
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn >= 3, undefined, { timeout: 16000 });
  await page.screenshot({ path: join(OUT, "7-flow-battle.png") });

  const midState = await page.evaluate(() => ({
    players: window.__rht.sim.fieldUnitCount("player"),
    enemies: window.__rht.sim.fieldUnitCount("enemy"),
  }));
  if (midState.players < 1) throw new Error(`Player deployed no troops: ${JSON.stringify(midState)}`);

  // Reset returns to a fresh, empty battle.
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1);
  const resetState = await page.evaluate(() => ({
    turn: window.__rht.sim.turn,
    players: window.__rht.sim.fieldUnitCount("player"),
    enemies: window.__rht.sim.fieldUnitCount("enemy"),
  }));
  if (resetState.players !== 0 || resetState.enemies !== 0) {
    throw new Error(`Reset did not return to an empty start: ${JSON.stringify(resetState)}`);
  }

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  console.log(`Flow passed: menu picked ${startState.map}/${startState.mode}, deployed ${midState.players}, enemy fielded ${midState.enemies}, reset to empty.`);
} finally {
  await close();
}
