import { describe, expect, it } from "vitest";
import { CARPET_BOMBS, TacticalSim, carpetDropPoints, type Projectile, type TroopKind, type VisualEvent } from "../game/sim";
import { TROOP_CATALOG, SUPPORT_POWERS } from "../game/units";
import {
  createArtillery, createBomber, createExTurret, createFlak,
  createBase, createFlamer, createGunship, createHeavy, createJumper, createMortar,
  createBazooka,
  createSledge, createHookshot, createSkater, createMolotov, createMole, createBreaker, createBoomer, createJuggernaut, createRunabout, createChopBike, createBulldozer,
  createSniper, createSoldier, createStriker, createTank, createTurret,
  type CombatEntity,
} from "../game/damageModel";
import { makeProjectileModel, projectileFamily, SNIPER_PAUSE, type ProjectileFamily } from "./projectileFx";
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
  soldier: createSoldier, sniper: createSniper, striker: createStriker, heavy: createHeavy,
  mortar: createMortar,
  jumper: createJumper, flamer: createFlamer, tank: createTank, 
  artillery: createArtillery, flak: createFlak, gunship: createGunship,
  bomber: createBomber,
  bazooka: createBazooka,
  sledge: createSledge, hookshot: createHookshot, skater: createSkater, molotov: createMolotov, mole: createMole, breaker: createBreaker, boomer: createBoomer, juggernaut: createJuggernaut,
  runabout: createRunabout, chopbike: createChopBike, bulldozer: createBulldozer,
};

/** How each troop's main gun is exercised. `null` = the kind has no gun, and says why. */
const GUN: Record<TroopKind, { dist?: number; air?: boolean } | { none: string }> = {
  soldier: {}, sniper: {}, heavy: {}, jumper: {}, bazooka: {},
  flamer: { dist: 5 }, mortar: {},
  tank: {}, artillery: { dist: 14 }, flak: { air: true },
  gunship: { air: true },
  sledge: {}, hookshot: {}, skater: {}, molotov: {}, mole: {}, runabout: {}, chopbike: {}, bulldozer: {}, breaker: {}, juggernaut: {},
  striker: { none: "melee only (its strike is covered below)" },
  bomber: { none: "bombs only (carpet covered below)" },
  boomer: { none: "no gun: it detonates" },
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
        ? pinned(createBomber("t", "Target", "enemy", { x: -6 + range, z: -2 }))
        : pinned(createHeavy("t", "Target", "enemy", { x: -6 + range, z: -2 }));
      target.status.alive = true;
      target.grenades = 0; // an air target must not bomb back (the old one was the unarmed transport)
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

  it("gunship gun: aimed fire at a ground target is a real round from the aircraft; nothing fires unasked", () => {
    const gunship = createGunship("g", "G", "player", { x: -8, z: 0 });
    const sim = new TacticalSim([gunship, pinned(createSoldier("v", "V", "enemy", { x: -2, z: 0.5 }))]);
    sim.select("g");
    // A move past a hostile must NOT gun it (owner 2026-10-02: "gunship auto shot at targets below me").
    expect(sim.queueMove({ x: 4, z: 0 })).toBe(true);
    sim.endTurn();
    const idle: VisualEvent[] = [];
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) {
      sim.update(0.05);
      for (const e of sim.effects) if (e.type === "shot" && !idle.some((s) => s.id === e.id)) idle.push({ ...e });
      expect(sim.projectiles.length, "the move fired a round").toBe(0);
    }
    expect(idle.length, "a gun run happened without being ordered").toBe(0);
    // Ordered, it fires from up in the air.
    const g2 = createGunship("g", "G", "player", { x: -8, z: 0 });
    const sim2 = new TacticalSim([g2, pinned(createSoldier("v", "V", "enemy", { x: -2, z: 0.5 }))]);
    sim2.select("g");
    expect(sim2.queueShootPart("v", "body"), sim2.log[0]).toBe(true);
    const trace = resolve(sim2, [sim2.entity("v")!]);
    expect(trace.rounds.length, "the ordered burst fired nothing").toBeGreaterThan(0);
    expect(trace.rounds[0].originHeight, "the round must leave the aircraft").toBeGreaterThan(2);
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

    // The carpet: a bomber bombs a spot 6m off without flying there. Three bombs leave its rack, fall steeply on a line across the
    // spot, and each blasts where carpetDropPoints says.
    const bomber = createBomber("b", "B", "player", { x: -8, z: 0 });
    sim = new TacticalSim([bomber, pinned(createSoldier("v", "V", "enemy", { x: -2, z: 0.3 }))]);
    sim.select("b");
    const spot = { x: -2, z: 0 };
    expect(sim.queueBombDrop(spot), sim.log[0]).toBe(true);
    expect(sim.orders.filter((o) => o.actorId === "b").map((o) => o.kind), "no auto-move").toEqual(["grenade"]);
    const points = carpetDropPoints(bomber, spot);
    const blasts: { x: number; z: number }[] = [];
    const seen = new Set<string>();
    let inFlight = 0;
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.02) {
      sim.update(0.02);
      inFlight = Math.max(inFlight, sim.projectiles.filter((p) => p.sourceKind === "bomber").length);
      for (const e of sim.effects) if (e.type === "blast" && !seen.has(e.id)) { seen.add(e.id); blasts.push({ ...e.to }); }
    }
    expect(inFlight, "three bombs fall from the rack").toBe(CARPET_BOMBS);
    expect(blasts.length).toBeGreaterThanOrEqual(CARPET_BOMBS);
    for (const p of points) expect(Math.min(...blasts.map((b) => Math.hypot(b.x - p.x, b.z - p.z))), "a blast where each bomb lands (a bomb may burst early beside a unit)").toBeLessThan(1.5);
  });

  it("support powers: strikes fly in and burst; utility powers are delivered and harm no one", () => {
    for (const power of SUPPORT_POWERS) {
      // A player HQ well clear of the point: the paradrop lands the caller's troopers, so needs one.
      const sim = new TacticalSim([pinned(createHeavy("t", "T", "enemy", { x: 2, z: 0 })), createBase("pb", "Home Base", "player", { x: -16, z: 0 })]);
      // Straight into the resolve queue: which faction may call which power is roster data (and is
      // being reshuffled elsewhere); this checks the strike's visuals, not who is allowed it.
      (sim as unknown as { queuedSupport: { kind: string; point: { x: number; z: number }; dir: { x: number; z: number } }[] })
        .queuedSupport.push({ kind: power.kind, point: { x: 2, z: 0 }, dir: { x: 1, z: 0 } });
      const trace = resolve(sim, [sim.entity("t")!]);
      const delivery = trace.effects.has("jet") || trace.effects.has("beam") || trace.rounds.length > 0;
      const seen = delivery || trace.effects.has("blast") || trace.effects.has("ping") || trace.effects.has("land");
      expect(seen, `${power.kind}: nothing on screen (${[...trace.effects].join(",")})`).toBe(true);
      if (["airstrike", "cluster", "laser", "napalm", "barrage", "railstrike"].includes(power.kind)) {
        // The barrage is off-map guns: its shells arrive, nothing flies over.
        if (power.kind !== "barrage") expect(delivery, `${power.kind}: nothing flies in (${[...trace.effects].join(",")})`).toBe(true);
        expect(trace.effects.has("blast"), `${power.kind}: nothing lands`).toBe(true);
        expect(trace.hpLost, `${power.kind}: no damage`).toBeGreaterThan(0);
      } else {
        // Utility powers (recon sweep, smoke screen, resupply) are delivered, not detonated.
        expect(trace.hpLost, `${power.kind}: a utility power hurt someone`).toBe(0);
        if (power.kind === "paradrop") expect(sim.entities.filter((e) => e.kind === "soldier" && e.team === "player").length, "two troopers landed").toBe(2);
      }
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

