import { describe, expect, it } from "vitest";
import { CARPET_BOMBS, TacticalSim, carpetDropPoints, type Projectile, type TroopKind, type VisualEvent } from "../game/sim";
import { TROOP_CATALOG, SUPPORT_POWERS } from "../game/units";
import {
  createApc, createArtillery, createBomber, createDroneOp, createEngineer, createExTurret, createFlak,
  createFlamer, createGrenadier, createGunship, createHeavy, createInterceptor, createJumper, createMedic, createMortar,
  createSapper, createScout, createSniper, createSoldier, createStriker, createTank, createTransport, createTurret,
  type CombatEntity,
} from "../game/damageModel";
import { carpetFallU, makeCarpetFall, makeProjectileModel, projectileFamily, SNIPER_PAUSE, type ProjectileFamily } from "./projectileFx";
import { attackFamilyForOrder, attackPose, WEAPON_FAMILIES } from "./worldRenderer";
import { hasMotionBank, sampleMotion } from "./infantryMotion";

// EVERY ATTACK HAS A WORKING ANIMATION (2026-09-23 audit).
//
// An attack is three things on screen: the attacker MOVES (wind-up / recoil / swing), something
// TRAVELS (a round, a blade arc, a jet, a beam) and something LANDS (an impact, a blast, a strike).
// Each can silently go missing without failing any other test -- a new kind falls through a
// family switch, an order kind is left out of the renderer's attack filter, an effect type is
// drawn as a leftover debug line -- and the game still plays. This test runs every attack in the
// game through the real sim and checks all three against what the renderer will do with it.
//
// The table is keyed on TroopKind, so a new troop that is not listed here is a COMPILE error.

type Maker = (id: string, name: string, team: "player" | "enemy", p: { x: number; z: number }) => CombatEntity;
const MAKERS: Record<TroopKind, Maker> = {
  soldier: createSoldier, scout: createScout, sniper: createSniper, striker: createStriker, heavy: createHeavy,
  grenadier: createGrenadier, mortar: createMortar, medic: createMedic, engineer: createEngineer, droneop: createDroneOp,
  jumper: createJumper, flamer: createFlamer, sapper: createSapper, tank: createTank, apc: createApc,
  artillery: createArtillery, flak: createFlak, gunship: createGunship, interceptor: createInterceptor,
  bomber: createBomber, transport: createTransport,
};

/** How each troop's main gun is exercised. `null` = the kind has no gun, and says why. */
const GUN: Record<TroopKind, { dist?: number; air?: boolean } | { none: string }> = {
  soldier: {}, scout: {}, sniper: {}, heavy: {}, engineer: {}, droneop: {}, jumper: {},
  medic: { dist: 6 }, flamer: { dist: 5 }, sapper: { dist: 5 }, grenadier: {}, mortar: {},
  tank: {}, apc: {}, artillery: { dist: 14 }, flak: { air: true },
  gunship: { air: true }, interceptor: { air: true },
  striker: { none: "melee only (its strike is covered below)" },
  bomber: { none: "bombs only (carpet covered below)" },
  transport: { none: "unarmed airlift" },
};

/** A target that cannot move or shoot back, so the enemy AI never muddies the trace. */
function pinned(e: CombatEntity): CombatEntity {
  for (const p of e.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
  e.status.canShoot = false;
  e.status.canMove = false;
  return e;
}

interface Trace {
  /** Every round that flew, first sighting (a snapshot, so later mutation does not matter). */
  rounds: Projectile[];
  families: Set<ProjectileFamily>;
  effects: Set<VisualEvent["type"]>;
  /** Every (actor, order kind) the renderer was handed as an attack while it ran. */
  animated: { actorKind: CombatEntity["kind"]; family: string }[];
  hpLost: number;
}

const hp = (e: CombatEntity) => e.parts.reduce((s, p) => s + p.hp, 0);

function resolve(sim: TacticalSim, watch: CombatEntity[]): Trace {
  const before = watch.map(hp);
  const trace: Trace = { rounds: [], families: new Set(), effects: new Set(), animated: [], hpLost: 0 };
  const seenRounds = new Set<string>();
  const seenFx = new Set<string>();
  sim.endTurn();
  for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) {
    sim.update(0.05);
    for (const p of sim.projectiles) {
      if (seenRounds.has(p.id)) continue;
      seenRounds.add(p.id);
      trace.rounds.push(structuredClone(p));
      trace.families.add(projectileFamily(p));
    }
    for (const e of sim.effects) {
      if (seenFx.has(e.id)) continue;
      seenFx.add(e.id);
      trace.effects.add(e.type);
    }
    for (const order of sim.orders) {
      if (order.done) continue;
      const actor = sim.entity(order.actorId);
      const family = actor && attackFamilyForOrder(actor.kind, order.kind);
      if (actor && family) trace.animated.push({ actorKind: actor.kind, family });
    }
  }
  expect(sim.phase, "the resolve ended").not.toBe("resolve");
  trace.hpLost = watch.reduce((s, e, i) => s + (before[i] - hp(e)), 0);
  return trace;
}

/** The round the renderer would draw for this projectile actually has geometry in it. */
function drawsSomething(p: Projectile): boolean {
  const family = projectileFamily(p);
  const flying = { ...p, age: Math.max(p.age, SNIPER_PAUSE + 0.05) };
  let meshes = 0;
  makeProjectileModel(flying, family).traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) meshes += 1; });
  return meshes > 0;
}

/** Landing visuals: a hit, a burst, or a blade. */
const LANDS = (t: Trace) => t.effects.has("impact") || t.effects.has("blast") || t.effects.has("strike");

describe("every unit's gun has an animation from trigger to landing", () => {
  for (const spec of TROOP_CATALOG) {
    const kind = spec.kind;
    const gun = GUN[kind];
    if ("none" in gun) {
      it(`${kind}: has no gun (${gun.none})`, () => {
        const sim = new TacticalSim([MAKERS[kind]("s", "Shooter", "player", { x: -6, z: -2 }), pinned(createSoldier("t", "T", "enemy", { x: 2, z: -2 }))]);
        sim.select("s");
        expect(sim.queueShoot("t")).toBe(false);
      });
      continue;
    }
    it(kind, () => {
      const range = gun.dist ?? 10;
      const shooter = MAKERS[kind]("s", "Shooter", "player", { x: -6, z: -2 });
      if (shooter.kind === "artillery") shooter.deployed = true;
      const target = gun.air
        ? pinned(createInterceptor("t", "Target", "enemy", { x: -6 + range, z: -2 }))
        : pinned(createHeavy("t", "Target", "enemy", { x: -6 + range, z: -2 }));
      target.status.alive = true;
      const sim = new TacticalSim([shooter, target]);
      sim.select("s");
      expect(sim.queueShoot("t"), sim.log[0]).toBe(true);
      const trace = resolve(sim, [target]);

      // 1. The shooter animates: the renderer is handed the order as an attack, and that family's
      //    pose actually moves (the Blender bank for infantry, the procedural curve otherwise).
      const families = new Set(trace.animated.filter((a) => a.actorKind === kind).map((a) => a.family));
      expect(families.size, `${kind}'s shot is never animated`).toBeGreaterThan(0);
      for (const family of families) {
        const peak = Math.max(...Array.from({ length: 41 }, (_, i) => {
          const phase = i / 40;
          if (hasMotionBank(family as never)) {
            const m = sampleMotion(family as never, phase);
            return Math.abs(m.weaponDraw) + Math.abs(m.weaponPitch) + Math.abs(m.shoulderPitch);
          }
          const p = attackPose(family as never, phase);
          return Math.abs(p.draw) + Math.abs(p.lift) + Math.abs(p.brace);
        }));
        expect(peak, `${kind}: family ${family} never moves`).toBeGreaterThan(0.02);
      }

      // 2. Something flies, and the renderer has a model for it.
      expect(trace.rounds.length, `${kind} fired nothing`).toBeGreaterThan(0);
      for (const round of trace.rounds) {
        expect(round.sourceKind, "a round that forgets its shooter draws as the default rifle").toBe(kind);
        expect(drawsSomething(round), `${kind}'s ${projectileFamily(round)} round has no geometry`).toBe(true);
      }

      // 3. It lands visibly and does its job.
      expect(LANDS(trace), `${kind}: no impact/blast on landing (effects: ${[...trace.effects].join(",")})`).toBe(true);
      expect(trace.hpLost, `${kind} never hurt its target`).toBeGreaterThan(0);
    });
  }

  it("the emplacements fire visible rounds and animate too", () => {
    // (The HQ has a stat line for a relay gun but never fires: canShoot is false for a base.)
    for (const [make, name] of [[createTurret, "turret"], [createExTurret, "exturret"]] as const) {
      const gun = make("s", "Gun", "player", { x: -6, z: -2 });
      const target = pinned(createHeavy("t", "Target", "enemy", { x: 4, z: -2 }));
      const sim = new TacticalSim([gun, target]);
      sim.select("s");
      expect(sim.queueShoot("t"), `${name}: ${sim.log[0]}`).toBe(true);
      const trace = resolve(sim, [target]);
      expect(trace.rounds.length, `${name} fired nothing`).toBeGreaterThan(0);
      for (const round of trace.rounds) expect(drawsSomething(round), `${name} round has no geometry`).toBe(true);
      expect(LANDS(trace), `${name}: nothing lands`).toBe(true);
      expect(trace.animated.some((a) => a.actorKind === name), `${name} never animates`).toBe(true);
    }
  });
});

describe("every non-gun attack has an animation", () => {
  it("hand grenade: an overhand THROW (not a rifle shot), a thrown grenade, a burst", () => {
    const sim = new TacticalSim([createSoldier("s", "S", "player", { x: -6, z: -2 }), pinned(createHeavy("t", "T", "enemy", { x: 1, z: -2 }))]);
    sim.select("s");
    expect(sim.queueGrenade("t"), sim.log[0]).toBe(true);
    const trace = resolve(sim, [sim.entity("t")!]);
    expect([...new Set(trace.animated.map((a) => a.family))]).toEqual(["throw"]);
    expect([...trace.families]).toEqual(["grenade"]);
    expect(trace.effects.has("blast")).toBe(true);
  });

  it("mortar smoke: the tube animates and fires a smoke round that bursts", () => {
    const sim = new TacticalSim([createMortar("s", "M", "player", { x: -6, z: -2 }), pinned(createHeavy("t", "T", "enemy", { x: 8, z: 6 }))]);
    sim.select("s");
    expect(sim.queueSmokeAt({ x: 4, z: -2 }), sim.log[0]).toBe(true);
    const trace = resolve(sim, []);
    expect(trace.animated.some((a) => a.actorKind === "mortar" && a.family === "launcher"), "the smoke shot never animates the mortar").toBe(true);
    expect([...trace.families]).toEqual(["smoke"]);
    for (const round of trace.rounds) expect(drawsSomething(round)).toBe(true);
    expect(trace.effects.has("blast")).toBe(true);
  });

  it("striker: a melee swing, a slash arc, damage", () => {
    const sim = new TacticalSim([createStriker("s", "S", "player", { x: -6, z: -2 }), pinned(createHeavy("t", "T", "enemy", { x: -4.4, z: -2 }))]);
    sim.select("s");
    expect(sim.queueMelee("t"), sim.log[0]).toBe(true);
    const trace = resolve(sim, [sim.entity("t")!]);
    expect(trace.animated.some((a) => a.family === "melee")).toBe(true);
    expect(trace.effects.has("strike"), "a blade lands as a slash arc, never a blast").toBe(true);
    expect(trace.hpLost).toBeGreaterThan(0);
  });

  it("rifle butt: any trooper's melee swings the melee pose and lands a strike", () => {
    const sim = new TacticalSim([createSoldier("s", "S", "player", { x: -6, z: -2 }), pinned(createHeavy("t", "T", "enemy", { x: -4.9, z: -2 }))]);
    sim.select("s");
    expect(sim.queueMelee("t"), sim.log[0]).toBe(true);
    const trace = resolve(sim, [sim.entity("t")!]);
    expect(trace.animated.some((a) => a.family === "melee")).toBe(true);
    expect(trace.effects.has("strike")).toBe(true);
  });

  it("tank ram: the hull drives in and the contact bursts", () => {
    const tank = createTank("s", "T", "player", { x: -6, z: -2 });
    const sim = new TacticalSim([tank, pinned(createHeavy("t", "T", "enemy", { x: -2, z: -2 }))]);
    sim.select("s");
    expect(sim.queueRam("t"), sim.log[0]).toBe(true);
    const x0 = tank.position.x;
    const trace = resolve(sim, [sim.entity("t")!]);
    expect(tank.position.x - x0, "the tank never moved into the ram").toBeGreaterThan(0.5);
    expect(trace.effects.has("blast")).toBe(true);
    expect(trace.hpLost).toBeGreaterThan(0);
  });

  it("jump slam: the arc lands with dust and a strike on the unit beside it", () => {
    const jumper = createJumper("s", "J", "player", { x: -6, z: -2 });
    const sim = new TacticalSim([jumper, pinned(createHeavy("t", "T", "enemy", { x: 0, z: -2 }))]);
    sim.select("s");
    expect(sim.queueMove({ x: -1.1, z: -2 }), sim.log[0]).toBe(true);
    let peak = 0;
    sim.endTurn();
    const fx = new Set<string>();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) {
      sim.update(0.05);
      peak = Math.max(peak, jumper.agl ?? 0);
      for (const e of sim.effects) fx.add(e.type);
    }
    expect(peak, "the jump never left the ground").toBeGreaterThan(0.5);
    expect(fx.has("land")).toBe(true);
    expect(fx.has("strike")).toBe(true);
  });

  it("gunship strafe: every burst is a real round drawn from the aircraft, not a ground line", () => {
    const gunship = createGunship("g", "G", "player", { x: -8, z: 0 });
    const sim = new TacticalSim([gunship, pinned(createSoldier("v", "V", "enemy", { x: -2, z: 0.5 }))]);
    sim.select("g");
    expect(sim.queueMove({ x: 4, z: 0 })).toBe(true);
    sim.endTurn();
    const shots: VisualEvent[] = [];
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) {
      sim.update(0.05);
      for (const e of sim.effects) if (e.type === "shot" && !shots.some((s) => s.id === e.id)) shots.push({ ...e });
    }
    expect(shots.length, "the gun run drew nothing").toBeGreaterThan(0);
    for (const s of shots) {
      // The strafe tracer starts at the aircraft's gun, up in the air -- a from-height of zero is
      // the old flat line drawn along the ground.
      expect(s.fromHeight ?? 0, "strafe tracer must start at the aircraft").toBeGreaterThan(2);
    }
  });

  it("bombs: a gunship's bomb falls as a round; a bomber's carpet of three is drawn falling onto its blasts", () => {
    const gunship = createGunship("b", "B", "player", { x: -2, z: 0 });
    let sim = new TacticalSim([gunship, pinned(createSoldier("v", "V", "enemy", { x: -2, z: 0.3 }))]);
    sim.select("b");
    expect(sim.queueBombDrop(), sim.log[0]).toBe(true);
    const trace = resolve(sim, [sim.entity("v")!]);
    expect(trace.rounds.length).toBe(1);
    expect([...trace.families]).toEqual(["bomb"]);
    expect(drawsSomething(trace.rounds[0])).toBe(true);
    expect(trace.effects.has("blast")).toBe(true);

    // The carpet lands on the tick it is released, so the sim never has a bomb in flight; the
    // renderer draws the fall off the order's clock (makeCarpetFall) onto carpetDropPoints. That
    // fall must be drawn for a good stretch of frames, reach the ground, and end where the blasts are.
    const bomber = createBomber("b", "B", "player", { x: -2, z: 0 });
    sim = new TacticalSim([bomber, pinned(createSoldier("v", "V", "enemy", { x: -2, z: 0.3 }))]);
    sim.select("b");
    expect(sim.queueBombDrop(), sim.log[0]).toBe(true);
    const drawn: number[] = [];
    let points = carpetDropPoints(bomber);
    const blasts: { x: number; z: number }[] = [];
    const seen = new Set<string>();
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.02) {
      const order = sim.orders.find((o) => o.actorId === "b" && o.kind === "grenade" && !o.done && !o.fired);
      if (order && carpetFallU(order.elapsed) > 0) {
        points = carpetDropPoints(bomber);
        let meshes = 0;
        for (const o of makeCarpetFall(points, carpetFallU(order.elapsed), bomber.elevation - 0.6, 0xffffff)) o.traverse((c) => { if ((c as { isMesh?: boolean }).isMesh) meshes += 1; });
        expect(meshes, "three bombs and their shadows").toBeGreaterThan(CARPET_BOMBS * 2);
        drawn.push(carpetFallU(order.elapsed));
      }
      sim.update(0.02);
      for (const e of sim.effects) if (e.type === "blast" && !seen.has(e.id)) { seen.add(e.id); blasts.push({ ...e.to }); }
    }
    expect(drawn.length, "the carpet's fall is on screen for a good stretch of frames").toBeGreaterThan(10);
    expect(Math.max(...drawn), "the drawn fall reaches the ground").toBeGreaterThan(0.9);
    expect(blasts.length).toBeGreaterThanOrEqual(CARPET_BOMBS);
    for (const p of points) expect(Math.min(...blasts.map((b) => Math.hypot(b.x - p.x, b.z - p.z))), "a blast where each drawn bomb lands").toBeLessThan(0.05);
  });

  it("mines: a planted mine bursts under the unit that steps on it", () => {
    const sapper = createSapper("s", "S", "player", { x: -6, z: -2 });
    const walker = createSoldier("w", "W", "player", { x: -2, z: -2 });
    const sim = new TacticalSim([sapper, walker]);
    sim.economy.set("player", 500);
    sim.select("s");
    expect(sim.queueMine(), sim.log[0]).toBe(true);
    // Hand the mine to the other side so our own trooper can trip it without an AI turn in between,
    // and step the sapper off it so the walker's path is clear.
    sim.mines[0].team = "enemy";
    sapper.position = { x: -6, z: 3 };
    sim.select("w");
    expect(sim.queueMove({ x: -8, z: -2 }), sim.log[0]).toBe(true);
    const trace = resolve(sim, [walker]);
    // Only the visual is asserted: the borrowed mine's damage is credited to a team with no HQ here,
    // which friendly-fire rules zero out. Mine damage itself is covered by the sim tests.
    expect(trace.effects.has("blast")).toBe(true);
  });

  it("support powers: every one flies in and bursts on the ground", () => {
    for (const power of SUPPORT_POWERS) {
      const sim = new TacticalSim([pinned(createHeavy("t", "T", "enemy", { x: 2, z: 0 }))]);
      // Straight into the resolve queue: which faction may call which power is roster data (and is
      // being reshuffled elsewhere); this checks the strike's visuals, not who is allowed it.
      (sim as unknown as { queuedSupport: { kind: string; point: { x: number; z: number }; dir: { x: number; z: number } }[] })
        .queuedSupport.push({ kind: power.kind, point: { x: 2, z: 0 }, dir: { x: 1, z: 0 } });
      const trace = resolve(sim, [sim.entity("t")!]);
      const delivery = trace.effects.has("jet") || trace.effects.has("beam") || trace.rounds.length > 0;
      expect(delivery, `${power.kind}: nothing flies in (${[...trace.effects].join(",")})`).toBe(true);
      expect(trace.effects.has("blast"), `${power.kind}: nothing lands`).toBe(true);
      expect(trace.hpLost, `${power.kind}: no damage`).toBeGreaterThan(0);
    }
  });
});

describe("the renderer's attack choreography covers every family", () => {
  it("maps every order that attacks onto an animated family", () => {
    expect(attackFamilyForOrder("soldier", "shoot")).toBe("rifle");
    expect(attackFamilyForOrder("soldier", "grenade")).toBe("throw");
    expect(attackFamilyForOrder("soldier", "melee")).toBe("melee");
    expect(attackFamilyForOrder("mortar", "smoke")).toBe("launcher");
    expect(attackFamilyForOrder("gunship", "grenade")).toBeUndefined(); // a bomb bay, not a gun
    expect(attackFamilyForOrder("soldier", "move")).toBeUndefined();
  });

  it("lists every family exactly once", () => {
    expect(new Set(WEAPON_FAMILIES).size).toBe(WEAPON_FAMILIES.length);
  });
});
