// LOCAL 2 PLAYERS: menu -> set-up -> handoff to Player 1 -> End Turn hands to Player 2 (sides
// swapped, the AI queued nothing) -> End Turn resolves -> turn 2 opens with PLAYER 2 planning first.
// Also guards what the second planner must NOT see (the first planner's order arrows
// and log lines), that Space behind the handoff card cannot skip a player, and that Play
// Again after a win opens turn 1 on Player 1's handoff again.
import { mkdirSync } from "node:fs";
import { assertLit, delay, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "smoke-hotseat" });
mkdirSync("shots", { recursive: true });
const { page, errors, close } = await launchGame({ port: 5208, query: "lowfx=1" });
const handoff = () => page.evaluate(() => document.querySelector(".hotseat-card .menu-heading")?.textContent ?? "");
const endLabel = () => page.evaluate(() => document.querySelector(".end-turn")?.firstChild?.textContent?.trim() ?? "");
const fail = (msg) => { throw new Error(msg); };
// A resolve is a few seconds of sim time; on a software-GL runner at ~1 fps that is most of a minute.
const RESOLVE_MS = 150000;
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector('[data-opponent="local"]');
  if (await page.$('[data-menu="versus"]')) fail("Local 2 Players should live on the Skirmish page, not the main menu");
  await page.click('[data-opponent="local"]');
  await page.waitForSelector('[data-opponent="local"].on');
  if (await page.$('[data-mode="survival"]')) fail("Last Stand offered in 2-player set-up");
  await page.click('[data-map="verdant"]');
  await page.click("[data-start]");
  await page.waitForSelector(".hotseat-card", { timeout: 8000 });
  if ((await handoff()) !== "Player 1") fail(`turn 1 should open with Player 1, got ${await handoff()}`);
  await page.screenshot({ path: "shots/hotseat-handoff.png" });
  await page.click("[data-hotseat-ready]");
  await assertLit(page, "hotseat P1 planning");
  const p1 = await page.evaluate(() => ({ hotseat: window.__rht.sim.hotseat, swapped: window.__rht.sim.sidesSwapped, money: [window.__rht.sim.money("player"), window.__rht.sim.money("enemy")] }));
  if (!p1.hotseat || p1.swapped) fail(`P1 planning state wrong: ${JSON.stringify(p1)}`);
  if (p1.money[0] !== p1.money[1]) fail(`the two players should start with the same money, got ${p1.money}`);
  if ((await endLabel()) !== "Pass to P2") fail(`first planner's End Turn should read "Pass to P2", got "${await endLabel()}"`);

  // Player 1 plans something the other seat must not see: two moves and their log lines.
  const plan = await page.evaluate(() => {
    const r = window.__rht, s = r.sim;
    const pb = s.entities.find((e) => e.kind === "base" && e.team === "player").position;
    const eb = s.entities.find((e) => e.kind === "base" && e.team === "enemy").position;
    const mid = { x: (pb.x + eb.x) / 2, z: (pb.z + eb.z) / 2 };
    const a = s.debugSpawn("soldier", "player", { x: mid.x - 4, z: mid.z }, { clearTerrain: true });
    const b = s.debugSpawn("heavy", "player", { x: mid.x - 4, z: mid.z + 3 }, { clearTerrain: true });
    s.select(a.id);
    const moved = s.queueMove({ x: mid.x - 2, z: mid.z - 1 });
    s.select(b.id);
    const watched = s.queueMove({ x: mid.x - 2, z: mid.z + 4 });
    s.select(a.id);
    r.setIntent("move");
    return { moved, watched, names: [a.name, b.name] };
  });
  if (!plan.moved || !plan.watched) fail(`P1 could not stage its plan: ${JSON.stringify(plan)}`);
  await delay(600);
  const seenByP1 = await page.evaluate(() => window.__rht.overlayCounts());
  if (!seenByP1.orders) fail(`P1 should see its own orders: ${JSON.stringify(seenByP1)}`);

  // Pass with the mouse, then press Space behind the card: it must not resolve Player 2's turn away.
  await page.click(".end-turn");
  await page.waitForSelector(".hotseat-card");
  await page.keyboard.press("Space");
  await delay(400);
  const behindCard = await page.evaluate(() => ({ phase: window.__rht.sim.phase, card: Boolean(document.querySelector(".hotseat-card")) }));
  if (behindCard.phase !== "command" || !behindCard.card) fail(`Space behind the handoff card skipped Player 2: ${JSON.stringify(behindCard)}`);
  if ((await handoff()) !== "Player 2") fail(`second planner should be Player 2, got ${await handoff()}`);
  await page.click("[data-hotseat-ready]");
  await delay(600);
  const p2 = await page.evaluate(() => {
    const s = window.__rht.sim;
    return { swapped: s.sidesSwapped, phase: s.phase, intent: s.intent, log: s.log.slice(), seen: window.__rht.overlayCounts() };
  });
  if (!p2.swapped || p2.phase !== "command") fail(`P2 planning state wrong: ${JSON.stringify(p2)}`);
  if (p2.intent !== "select") fail(`P2 inherited Player 1's armed action "${p2.intent}"`);
  if (p2.seen.orders) fail(`P2 can see Player 1's plan on the board: ${JSON.stringify(p2.seen)}`);
  if (p2.log.some((line) => plan.names.some((n) => line.includes(n)))) fail(`P2 can read Player 1's orders in the log: ${p2.log.join(" | ")}`);
  if ((await endLabel()) !== "End Turn") fail(`second planner's button should read "End Turn", got "${await endLabel()}"`);
  await page.screenshot({ path: "shots/hotseat-p2.png" });

  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForFunction(() => window.__rht.sim.turn === 2 && window.__rht.sim.phase === "command", undefined, { timeout: RESOLVE_MS });
  await page.waitForSelector(".hotseat-card");
  await delay(200);
  if ((await handoff()) !== "Player 2") fail(`turn 2 should open with Player 2, got ${await handoff()}`);
  const t2 = await page.evaluate(() => window.__rht.sim.sidesSwapped);
  if (!t2) fail("turn 2: Player 2 plans first but sides are not swapped");

  // Turn 2: Player 2 passes, then Player 1 wins.
  await page.click("[data-hotseat-ready]");
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForSelector(".hotseat-card");
  if ((await handoff()) !== "Player 1") fail(`turn 2 second planner should be Player 1, got ${await handoff()}`);
  await page.click("[data-hotseat-ready]");
  // Player 1 is planning unswapped here, so a victory is Player 1's (the end state is only checked
  // on damage, so stamp it the way smoke:deep does rather than play a whole battle out).
  await page.evaluate(() => { window.__rht.sim.phase = "victory"; });
  await page.waitForSelector(".endscreen", { timeout: 8000 });
  const verdict = await page.evaluate(() => document.querySelector(".endscreen__title")?.textContent ?? "");
  if (verdict !== "PLAYER 1 WINS") fail(`end screen should read PLAYER 1 WINS, got "${verdict}"`);
  await page.click('.endscreen [data-command="reset"]');
  await page.waitForSelector(".hotseat-card", { timeout: 8000 });
  const again = await page.evaluate(() => ({ turn: window.__rht.sim.turn, hotseat: window.__rht.sim.hotseat, swapped: window.__rht.sim.sidesSwapped }));
  if ((await handoff()) !== "Player 1" || again.turn !== 1 || !again.hotseat || again.swapped) fail(`Play Again should reopen turn 1 on Player 1: ${await handoff()} ${JSON.stringify(again)}`);
  await page.click("[data-hotseat-ready]");
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForSelector(".hotseat-card");
  if ((await handoff()) !== "Player 2") fail(`after Play Again, End Turn should hand to Player 2, got ${await handoff()}`);

  if (errors.length) fail(`console errors: ${errors.join(" | ")}`);
  console.log("Hotseat smoke passed: handoff P1 -> P2 hides P1's plan, Space can't skip a seat, turn 2 opens with Player 2, Play Again restarts on Player 1.");
} finally {
  await close();
}
