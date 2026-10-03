import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "smoke-flow" });

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
  // Syndicate: the Striker this smoke fields is theirs (rosters differ per faction since 2026-09-23).
  await page.evaluate((n) => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < n; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector(`[data-step-jump="${n}"]`).click(); }, 2);
  await page.click('[data-faction="syndicate"]');
  await page.evaluate((n) => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < n; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector(`[data-step-jump="${n}"]`).click(); }, 3); // Rules step of the set-up flow
  // MENU CONSISTENCY (owner 2026-10-03: picked one mode, the summary at the bottom showed the other). After EVERY pick the
  // highlighted chip, the blurb and the summary must name the same thing -- flip back and forth and read all three each time.
  const modeIds = await page.evaluate(() => [...document.querySelectorAll("[data-mode]")].map((el) => el.dataset.mode));
  for (const id of [...modeIds, ...modeIds.slice().reverse(), "ctf"]) {
    await page.click(`[data-mode="${id}"]`);
    const seen = await page.evaluate(() => {
      const on = document.querySelector("[data-mode].on");
      const dd = [...document.querySelectorAll("[data-summary] dt")].find((dt) => dt.textContent === "Mode")?.nextElementSibling;
      return { chip: on?.textContent?.trim(), summary: dd?.textContent?.trim(), picks: document.querySelectorAll("[data-mode].on").length };
    });
    if (seen.picks !== 1 || seen.chip !== seen.summary) throw new Error(`Mode menu disagrees with itself after picking ${id}: ${JSON.stringify(seen)}`);
  }
  await page.evaluate(() => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < 3; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector("[data-start]").click(); });
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
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 2, undefined, { timeout: 120000 });

  await page.evaluate(() => {
    const api = window.__rht;
    api.sim.economy.set("player", 2000);
    const base = api.sim.entities.find((e) => e.kind === "base" && e.team === "player");
    api.sim.select(base.id);
    // Placed deploy through the seam: pick the spot inside the ring around the base.
    if (!api.queueDeployAt("striker", { x: base.position.x + 3, z: base.position.z + 3 })) throw new Error("queueDeployAt(striker) rejected: " + api.sim.log[0]);
    api.endTurn();
  });
  await page.waitForFunction(() => window.__rht.sim.phase === "resolve" || window.__rht.sim.turn >= 3, undefined, { timeout: 60000 });
  await assertLit(page, "flow resolve");
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn >= 3, undefined, { timeout: 120000 });
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
