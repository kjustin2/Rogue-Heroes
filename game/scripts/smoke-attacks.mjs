// EVERY ATTACK ANIMATES, in the real renderer.
//
// attackCoverage.test.ts proves the sim hands the renderer something to draw for every attack and
// that the renderer's choreography tables cover it. This is the other half: each attack is staged
// in a live battle and watched frame by frame through the real sim -> render path, and it has to
//   1. MOVE its attacker (the weapon -- or, for a hand grenade, the throwing arm -- leaves rest),
//   2. put a round in flight (the projectile root draws something) where the attack fires one,
//   3. draw its landing (the effect root draws something),
// with no console error and no guarded frame error along the way. Every gap it exists for shipped:
// the gunship's gun run was a two-pixel line on the ground, the bomber's carpet bombs detonated on
// the tick they were born and were never on screen, the mortar's smoke round left a motionless
// tube, and a Recruit "fired" its hand grenade from its rifle.
// Out: shots/attacks/<case>.png (mid-resolve frame of each case)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deployBattle, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

// ~25 staged resolves; on a software GPU each is a few hundred frames at a few fps.
guard({ name: "smoke-attacks", maxMinutes: 30 });

const PORT = 5212;
const OUT = join("shots", "attacks");
mkdirSync(OUT, { recursive: true });

// actor/target kinds, target distance along +x, the order, which limb must move, and what must fly.
// `limb`: "weapon" (rifle/cannon/gun part) or "arm-l" (the free arm); null = nothing to swing
// (a bomb bay, a whole-body move). `round`: the projectile root must draw a round. `air`: effect
// objects must appear well above the ground (the gun run's tracers leave the aircraft).
const CASES = [
  { name: "rifle", actor: "soldier", target: "heavy", dist: 7, order: "shoot", limb: "weapon", round: true },
  { name: "carbine", actor: "scout", target: "heavy", dist: 7, order: "shoot", limb: "weapon", round: true },
  { name: "marksman", actor: "sniper", target: "heavy", dist: 9, order: "shoot", limb: "weapon", round: true },
  { name: "machine-gun", actor: "heavy", target: "heavy", dist: 7, order: "shoot", limb: "weapon", round: true },
  { name: "launcher", actor: "grenadier", target: "heavy", dist: 8, order: "shoot", limb: "weapon", round: true },
  { name: "mortar", actor: "mortar", target: "heavy", dist: 10, order: "shoot", limb: "weapon", round: true },
  { name: "mortar-smoke", actor: "mortar", target: "heavy", dist: 10, order: "smoke", limb: "weapon", round: true },
  { name: "pistol", actor: "medic", target: "heavy", dist: 6, order: "shoot", limb: "weapon", round: true },
  { name: "engineer", actor: "engineer", target: "heavy", dist: 7, order: "shoot", limb: "weapon", round: true },
  { name: "marker-carbine", actor: "droneop", target: "heavy", dist: 7, order: "shoot", limb: "weapon", round: true },
  { name: "jumper-carbine", actor: "jumper", target: "heavy", dist: 7, order: "shoot", limb: "weapon", round: true },
  { name: "flamer", actor: "flamer", target: "heavy", dist: 4.5, order: "shoot", limb: "weapon", round: true },
  { name: "scattergun", actor: "sapper", target: "heavy", dist: 4.5, order: "shoot", limb: "weapon", round: true },
  // The throw is a full windmill of the free arm (~2π); a twitch of the torso brace is ~0.1.
  { name: "grenade-throw", actor: "soldier", target: "heavy", dist: 6, order: "grenade", limb: "arm-l", round: true, minMove: 1.5 },
  { name: "melee", actor: "striker", target: "heavy", dist: 1.6, order: "melee", limb: "weapon", round: false },
  { name: "tank", actor: "tank", target: "heavy", dist: 9, order: "shoot", limb: "weapon", round: true },
  { name: "apc", actor: "apc", target: "heavy", dist: 8, order: "shoot", limb: "weapon", round: true },
  { name: "artillery", actor: "artillery", target: "heavy", dist: 14, order: "shoot", limb: "weapon", round: true },
  { name: "flak", actor: "flak", target: "interceptor", dist: 9, order: "shoot", limb: "weapon", round: true },
  { name: "gunship-gun", actor: "gunship", target: "interceptor", dist: 8, order: "shoot", limb: "weapon", round: true },
  { name: "interceptor-gun", actor: "interceptor", target: "interceptor", dist: 8, order: "shoot", limb: "weapon", round: true },
  { name: "gunship-bomb", actor: "gunship", target: "heavy", dist: 0.4, order: "bomb", limb: null, round: true },
  { name: "bomber-carpet", actor: "bomber", target: "heavy", dist: 0.4, order: "bomb", limb: null, round: true },
  { name: "gunship-strafe", actor: "gunship", target: "heavy", dist: 5, order: "strafe", limb: null, round: false, air: true },
  { name: "tank-ram", actor: "tank", target: "heavy", dist: 4, order: "ram", limb: null, round: false },
];
const only = process.argv.slice(2);
const cases = only.length ? CASES.filter((c) => only.includes(c.name)) : CASES;
if (!cases.length) throw new Error(`no such case; known: ${CASES.map((c) => c.name).join(" ")}`);

const failures = [];
const { page, errors, close } = await launchGame({ port: PORT, query: "lowfx=1", viewport: { width: 800, height: 450 } });
try {
  await deployBattle(page, { map: "dustbowl", mode: "destroy" });
  await page.evaluate(() => { window.__rht.sim.economy.set("player", 99999); });
  // The frame loop clamps dt at 50ms, so a slow (software) GPU already gets ~20 samples per
  // simulated second -- and a long flight (the artillery shell) then takes minutes of wall clock.
  // Below 20 fps the resolve clock runs double (10 samples per simulated second is still plenty
  // to see a wind-up that lasts half a second); a real GPU runs it at 1.
  const fps = await page.evaluate(async () => { const t0 = performance.now(); let n = 0; while (performance.now() - t0 < 2000) { await new Promise((r) => requestAnimationFrame(r)); n += 1; } return n / 2; });
  const scale = fps < 20 ? 2 : 1;
  await page.evaluate((k) => window.__rht.setResolveScale(k), scale);
  console.log(`  ${fps.toFixed(1)} fps -> resolve clock x${scale}`);

  for (const c of cases) {
    // Each case starts from a command phase (the last case's resolve may still be settling).
    await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 120000 });
    // Stage: a pinned enemy target, the attacker to its west, camera on the pair.
    const staged = await page.evaluate((c) => {
      const rht = window.__rht;
      const sim = rht.sim;
      // Leave nothing from the last case on the board to muddy this one, and keep the enemy bot
      // broke so it never fields an army of its own across twenty-odd turns.
      const staged = (window.__smokeAttacks ??= new Set());
      for (let i = sim.entities.length - 1; i >= 0; i -= 1) if (staged.has(sim.entities[i].id)) sim.entities.splice(i, 1);
      sim.economy.set("enemy", 0);
      // ...and clear the lasting hazards earlier cases left on the lane: the mortar's smoke cloud
      // (correctly) swallows every flat shot through it for three turns, and fire burns for two.
      sim.smokeClouds.length = 0;
      sim.burnZones.length = 0;
      const actor = sim.debugSpawn(c.actor, "player", { x: -4, z: -6 }, { clearTerrain: true });
      const target = sim.debugSpawn(c.target, "enemy", { x: actor.position.x + c.dist, z: actor.position.z });
      staged.add(actor.id);
      staged.add(target.id);
      for (const p of target.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
      target.status.canShoot = false;
      target.status.canMove = false;
      if (c.actor === "artillery") actor.deployed = true;
      if (c.actor === "soldier") actor.grenades = actor.maxGrenades = Math.max(1, actor.maxGrenades);
      if (c.actor === "gunship" || c.actor === "bomber") actor.grenades = actor.maxGrenades = Math.max(1, actor.maxGrenades);
      actor.yaw = Math.PI / 2; // heading +x, toward the target (the carpet is laid along it)
      rht.setView({ x: actor.position.x + c.dist / 2, z: actor.position.z, zoom: 0.8 });
      return { actor: actor.id, target: target.id };
    }, c);
    await page.waitForTimeout(350); // let the renderer build the groups

    const queued = await page.evaluate(({ c, ids }) => {
      const sim = window.__rht.sim;
      const actor = sim.entity(ids.actor);
      const target = sim.entity(ids.target);
      sim.debugSelect(ids.actor);
      const ok = c.order === "shoot" ? sim.queueShoot(ids.target)
        : c.order === "grenade" ? sim.queueGrenade(ids.target)
        : c.order === "smoke" ? sim.queueSmokeAt({ x: target.position.x, z: target.position.z })
        : c.order === "melee" ? sim.queueMelee(ids.target)
        : c.order === "bomb" ? sim.queueBombDrop()
        : c.order === "ram" ? sim.queueRam(ids.target)
        : c.order === "strafe" ? sim.queueMove({ x: target.position.x + 5, z: actor.position.z })
        : false;
      return { ok, log: sim.log.slice(0, 2) }; // newest first
    }, { c, ids: staged });
    if (!queued.ok) { failures.push(`${c.name}: order refused (${queued.log.join(" | ")})`); continue; }

    // Watch the whole resolve inside the page, one sample per rendered frame.
    const trace = await page.evaluate(async ({ c, ids }) => {
      const rht = window.__rht;
      const pick = (id, limb) => rht.limbPose(id).find((p) => p.limb === limb);
      const rest = c.limb ? pick(ids.actor, c.limb) : undefined;
      const framesBefore = rht.frameErrors();
      rht.endTurn();
      let moved = 0, rounds = 0, effects = 0, air = 0, frames = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 240000) {
        await new Promise((r) => requestAnimationFrame(r));
        frames += 1;
        const fx = rht.fxCounts();
        rounds = Math.max(rounds, fx.projectiles);
        effects = Math.max(effects, fx.effects);
        air = Math.max(air, fx.airborneEffects);
        if (rest) {
          const now = pick(ids.actor, c.limb);
          if (now) moved = Math.max(moved, Math.abs(now.rotX - rest.rotX) + Math.abs(now.posZ - rest.posZ) + Math.abs(now.posY - rest.posY));
        }
        if (rht.sim.phase !== "resolve" && frames > 3) break;
      }
      return { moved, rounds, effects, air, frames, hasLimb: Boolean(rest), frameErrors: rht.frameErrors() - framesBefore, phase: rht.sim.phase };
    }, { c, ids: staged });
    await page.screenshot({ path: join(OUT, `${c.name}.png`) });

    const why = [];
    if (trace.phase === "resolve") why.push("resolve never ended");
    if (c.limb && !trace.hasLimb) why.push(`no ${c.limb} mesh on the ${c.actor}`);
    // 0.07 = the threshold smoke:animation measured between idle sway (~0.03) and real motion.
    if (c.limb && trace.hasLimb && trace.moved < (c.minMove ?? 0.07)) why.push(`${c.limb} barely moved (${trace.moved.toFixed(3)} < ${c.minMove ?? 0.07})`);
    if (c.round && trace.rounds === 0) why.push("no round was ever drawn");
    if (trace.effects === 0) why.push("nothing was drawn on landing");
    if (c.air && trace.air === 0) why.push("no tracer left the aircraft");
    if (trace.frameErrors) why.push(`${trace.frameErrors} frame error(s)`);
    console.log(`  ${why.length ? "FAIL" : "ok  "} ${c.name.padEnd(16)} limb ${trace.moved.toFixed(3)} · rounds ${trace.rounds} · fx ${trace.effects} · airborne ${trace.air} · ${trace.frames} frames`);
    if (why.length) failures.push(`${c.name}: ${why.join("; ")}`);

  }

  if (errors.length) failures.push(`console errors:\n${errors.slice(0, 6).join("\n")}`);
  if (failures.length) throw new Error(`smoke:attacks failed:\n  ${failures.join("\n  ")}`);
  console.log(`Attack smoke passed: ${cases.length} attacks each moved their attacker, drew their round and their landing.`);
} finally {
  await close();
}
