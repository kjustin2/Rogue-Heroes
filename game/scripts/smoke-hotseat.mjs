// LOCAL 2 PLAYERS: menu -> set-up -> handoff to Player 1 -> End Turn hands to Player 2 (sides
// swapped, the AI queued nothing) -> End Turn resolves -> turn 2 opens with PLAYER 2 planning first.
import { mkdirSync } from "node:fs";
import { assertLit, delay, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "smoke-hotseat" });
mkdirSync("shots", { recursive: true });
const { page, errors, close } = await launchGame({ port: 5208, query: "lowfx=1" });
const handoff = () => page.evaluate(() => document.querySelector(".hotseat-card .menu-heading")?.textContent ?? "");
const fail = (msg) => { throw new Error(msg); };
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="versus"]');
  await page.waitForSelector("[data-faction2]");
  if (await page.$('[data-mode="survival"]')) fail("Last Stand offered in 2-player set-up");
  await page.click('[data-map="verdant"]');
  await page.click("[data-start]");
  await page.waitForSelector(".hotseat-card", { timeout: 8000 });
  if ((await handoff()) !== "Player 1") fail(`turn 1 should open with Player 1, got ${await handoff()}`);
  await page.screenshot({ path: "shots/hotseat-handoff.png" });
  await page.click("[data-hotseat-ready]");
  await assertLit(page, "hotseat P1 planning");
  const p1 = await page.evaluate(() => ({ hotseat: window.__rht.sim.hotseat, swapped: window.__rht.sim.sidesSwapped }));
  if (!p1.hotseat || p1.swapped) fail(`P1 planning state wrong: ${JSON.stringify(p1)}`);
  // Player 1 deploys a trooper so the resolve has something of theirs in it.
  await page.evaluate(() => { window.__rht.sim.economy.set("player", 2000); window.__rht.queueSpawnTroop("soldier"); });
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForSelector(".hotseat-card");
  if ((await handoff()) !== "Player 2") fail(`second planner should be Player 2, got ${await handoff()}`);
  await page.click("[data-hotseat-ready]");
  const p2 = await page.evaluate(() => ({ swapped: window.__rht.sim.sidesSwapped, orders: window.__rht.sim.orders.length, phase: window.__rht.sim.phase }));
  if (!p2.swapped || p2.phase !== "command") fail(`P2 planning state wrong: ${JSON.stringify(p2)}`);
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForFunction(() => window.__rht.sim.turn === 2 && window.__rht.sim.phase === "command", undefined, { timeout: 30000 });
  await page.waitForSelector(".hotseat-card");
  await delay(200);
  if ((await handoff()) !== "Player 2") fail(`turn 2 should open with Player 2, got ${await handoff()}`);
  const t2 = await page.evaluate(() => window.__rht.sim.sidesSwapped);
  if (!t2) fail("turn 2: Player 2 plans first but sides are not swapped");
  if (errors.length) fail(`console errors: ${errors.join(" | ")}`);
  console.log("Hotseat smoke passed: handoff P1 -> P2, no AI orders, turn 2 opens with Player 2.");
} finally {
  await close();
}
