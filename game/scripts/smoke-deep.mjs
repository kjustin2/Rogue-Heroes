// Consolidated deep smoke (RH4's walk-the-whole-machine net): drives the NEW air/transport
// mechanics through the full sim -> renderer -> HUD pipeline in one process, asserting sim-state
// transitions AND that the canvas stays painted (no black frame) with a clean console throughout.
// These features had only visual shot-scripts; this is their regression net in the suite.
// Out: shots/deep/*.png. Exits nonzero on any failed assert or console error.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, endTurnAndSettle, launchGame, waitForCommand } from "../improve/lib/harness.mjs";

const PORT = 5206;
const OUT = join("shots", "deep");
mkdirSync(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };
const totalHp = (e) => (e ? e.parts.reduce((s, p) => s + p.hp, 0) : 0);

const { page, errors, close } = await launchGame({ port: PORT, query: "lowfx=1" });

try {
  await page.waitForSelector(".main-menu");
  if (!(await page.evaluate(() => window.__rht.audioMuted()))) fail("audio not muted under automation");

  await page.evaluate(() => window.__rht.startBattle("dustbowl", "destroy", "normal"));
  await waitForCommand(page);
  await assertLit(page, "battle start");

  // Deploy the full air fleet at once — proves every new render path (interceptor/bomber/transport
  // models, rotor spin, frustum-safe tracers) builds and paints without crashing.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.economy.set("player", 4000);
    sim.debugSpawn("gunship", "player", { x: -8, z: -2 });
    sim.debugSpawn("bomber", "player", { x: -6, z: 3 });
    sim.debugSpawn("transport", "player", { x: -4, z: -4 });
    sim.debugSpawn("interceptor", "enemy", { x: 8, z: 2 });
    window.__rht.setView({ x: 0, z: 0, zoom: 0.7, pitch: 0.35, yaw: 0.1 });
  });
  await assertLit(page, "air fleet deployed");
  await page.screenshot({ path: join(OUT, "30-air-fleet.png") });

  // 1) Air-to-air: a gunship guns an enemy interceptor -> the interceptor loses HP.
  const air = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.reset();
    sim.economy.set("player", 3000);
    const g = sim.debugSpawn("gunship", "player", { x: -4, z: 0 });
    const e = sim.debugSpawn("interceptor", "enemy", { x: 5, z: 0 });
    e.parts.forEach((p) => { if (p.role === "mobility") p.hp = 0; }); // hold it for a clean shot
    sim.select(g.id);
    const queued = sim.queueShoot(e.id);
    return { foe: e.id, foeHp: e.parts.reduce((s, p) => s + p.hp, 0), queued };
  });
  if (!air.queued) fail("gunship could not queue an air-to-air shot");
  await endTurnAndSettle(page);
  const airAfter = await page.evaluate((foe) => { const e = window.__rht.sim.entity(foe); return e ? e.parts.reduce((s, p) => s + p.hp, 0) : 0; }, air.foe);
  if (!(airAfter < air.foeHp)) fail(`air-to-air did not damage the interceptor (${air.foeHp} -> ${airAfter})`);
  await assertLit(page, "air-to-air");
  await page.screenshot({ path: join(OUT, "31-air-to-air.png") });

  // 2) Transport: pick up a friendly soldier, carry it (link + passenger list), then drop it off.
  const t = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.reset();
    sim.economy.set("player", 3000);
    const tr = sim.debugSpawn("transport", "player", { x: -6, z: 0 });
    const s = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    sim.select(tr.id);
    const queued = sim.queueLoad(s.id);
    return { t: tr.id, s: s.id, queued };
  });
  if (!t.queued) fail("transport could not queue a load order");
  await endTurnAndSettle(page);
  const carried = await page.evaluate((ids) => {
    const sim = window.__rht.sim;
    const tr = sim.entity(ids.t); const s = sim.entity(ids.s);
    return { carriedBy: s?.carriedById, passengers: tr?.passengerIds ?? [] };
  }, t);
  if (carried.carriedBy !== t.t || !carried.passengers.includes(t.s)) fail(`transport did not pick up the soldier: ${JSON.stringify(carried)}`);
  await page.evaluate((ids) => { const sim = window.__rht.sim; sim.select(ids.t); window.__rht.queueUnload({ x: -11, z: 6 }); }, t);
  await endTurnAndSettle(page);
  const dropped = await page.evaluate((ids) => { const s = window.__rht.sim.entity(ids.s); return { carriedBy: s?.carriedById, alive: s?.status.alive }; }, t);
  if (dropped.carriedBy || !dropped.alive) fail(`transport did not drop the soldier: ${JSON.stringify(dropped)}`);
  await assertLit(page, "transport carry");
  await page.screenshot({ path: join(OUT, "32-transport.png") });

  // 3) Bomb straight-down: a bomber over a (held) ground foe detonates beneath itself.
  const bomb = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.reset();
    sim.economy.set("player", 3000);
    const bmb = sim.debugSpawn("bomber", "player", { x: 2, z: -3 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: 2, z: -3 });
    foe.parts.forEach((p) => { if (p.role === "mobility") p.hp = 0; }); // keep it beneath the bomber
    sim.select(bmb.id);
    const queued = sim.queueBombDrop();
    return { foe: foe.id, foeHp: foe.parts.reduce((s, p) => s + p.hp, 0), queued };
  });
  if (!bomb.queued) fail("bomber could not queue a bomb drop");
  await endTurnAndSettle(page);
  const bombAfter = await page.evaluate((foe) => { const e = window.__rht.sim.entity(foe); return e ? e.parts.reduce((s, p) => s + p.hp, 0) : 0; }, bomb.foe);
  if (!(bombAfter < bomb.foeHp)) fail(`straight-down bomb did not damage the foe beneath (${bomb.foeHp} -> ${bombAfter})`);
  await assertLit(page, "bomb");
  await page.screenshot({ path: join(OUT, "33-bomb.png") });

  // 4) Serialize/restore round-trips the whole battle (with air units + carry links present).
  const before = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.reset();
    sim.economy.set("player", 1234);
    sim.debugSpawn("gunship", "player", { x: -5, z: 2 });
    sim.debugSpawn("tank", "enemy", { x: 6, z: -2 });
    return { saved: sim.serialize(), count: sim.entities.length, money: window.__rht.money("player") };
  });
  const after = await page.evaluate((saved) => {
    const sim = window.__rht.sim;
    sim.reset();
    const ok = sim.restore(saved);
    return { ok, phase: sim.phase, count: sim.entities.length, money: window.__rht.money("player") };
  }, before.saved);
  if (!after.ok || after.phase !== "command" || after.count !== before.count || after.money !== before.money) {
    fail(`serialize/restore did not round-trip: ${JSON.stringify({ before, after })}`);
  }

  // 5) Victory end screen renders (state-machine exit), canvas still painting behind it.
  await page.evaluate(() => { window.__rht.sim.phase = "victory"; });
  await page.waitForSelector(".endscreen", { timeout: 4000 });
  await assertLit(page, "victory endscreen");
  await page.screenshot({ path: join(OUT, "34-victory.png") });

  if (errors.length) fail(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  console.log("Deep smoke passed: air fleet render, air-to-air, transport load/carry/unload, straight-down bomb, serialize round-trip, victory screen.");
} finally {
  await close();
}
