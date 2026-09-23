import { describe, expect, it } from "vitest";
import { TacticalSim } from "./sim";
import {
  createApc, createArtillery, createBomber, createFlak, createFlamer, createGrenadier, createGunship, createHeavy,
  createInterceptor, createMedic, createMortar, createSapper, createSniper, createSoldier, createTank, createTurret,
  type CombatEntity,
} from "./damageModel";

// PROJECTILES FLY AS THEY SHOULD, per family (2026-09-22 audit). Every shooter fires one order at a
// pinned target on the open flat of DEFAULT_TERRAIN; the flight is sampled each tick. A flat round
// travels in a straight line and never climbs; a lobbed round rises well above its muzzle and comes
// down; every round's path passes near its target, moves every tick (no stuck rounds), and is gone when the
// resolve ends.
type Maker = (id: string, name: string, team: "player" | "enemy", p: { x: number; z: number }) => CombatEntity;
const CASES: { name: string; make: Maker; lobbed: boolean; dist?: number }[] = [
  { name: "rifle", make: createSoldier, lobbed: false },
  { name: "machine gun", make: createHeavy, lobbed: false },
  { name: "marksman", make: createSniper, lobbed: false },
  { name: "scattergun", make: createSapper, lobbed: false, dist: 5 },
  { name: "pistol", make: createMedic, lobbed: false, dist: 6 },
  { name: "flamer", make: createFlamer, lobbed: false, dist: 5 },
  { name: "launcher", make: createGrenadier, lobbed: true },
  { name: "mortar", make: createMortar, lobbed: true },
  { name: "tank shell", make: createTank, lobbed: false },
  { name: "artillery", make: createArtillery, lobbed: true, dist: 14 },
  { name: "APC autogun", make: createApc, lobbed: false },
  { name: "turret", make: createTurret, lobbed: false },
];

function pinned(e: CombatEntity): CombatEntity {
  for (const p of e.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
  e.status.canShoot = false;
  e.status.canMove = false;
  return e;
}

describe("every projectile family flies and lands as expected", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const range = c.dist ?? 10;
      const shooter = c.make("s", "Shooter", "player", { x: -6, z: -2 });
      if (shooter.kind === "artillery") shooter.deployed = true;
      const target = pinned(createHeavy("t", "Target", "enemy", { x: -6 + range, z: -2 }));
      const sim = new TacticalSim([shooter, target]);
      sim.select("s");
      expect(sim.queueShoot("t"), sim.log[0]).toBe(true);
      sim.endTurn();
      const flights = new Map<string, { h: number[]; x: number[]; z: number[]; origin: number }>();
      for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) {
        sim.update(0.05);
        for (const p of sim.projectiles) {
          const f = flights.get(p.id) ?? { h: [], x: [], z: [], origin: p.originHeight };
          f.h.push(p.height); f.x.push(p.position.x); f.z.push(p.position.z);
          flights.set(p.id, f);
        }
      }
      expect(sim.phase).toBe("command"); // the resolve ended
      expect(sim.projectiles).toHaveLength(0); // nothing left hanging in the air
      expect(flights.size).toBeGreaterThan(0);
      for (const f of flights.values()) {
        if (f.h.length < 3) continue;
        const peak = Math.max(...f.h);
        if (c.lobbed) expect(peak, "a lobbed round arcs up").toBeGreaterThan(f.origin + 0.8);
        else expect(peak, "a flat round never climbs far above its muzzle").toBeLessThan(f.origin + 0.9);
        // It moves every tick while in flight (a stuck round is the "frozen shell" glitch class).
        for (let i = 1; i < f.x.length - 1; i += 1) {
          const step = Math.hypot(f.x[i] - f.x[i - 1], f.z[i] - f.z[i - 1], f.h[i] - f.h[i - 1]);
          expect(step, `stalled at sample ${i}`).toBeGreaterThan(0.01);
        }
        // It flies AT the target: its path passes close to it (a miss keeps flying past, and the
        // marksman's round punches through by design, so where a round ENDS proves nothing).
        const closest = Math.min(...f.x.map((x, i) => Math.hypot(x - target.position.x, f.z[i] - target.position.z)));
        // Explosive rounds scatter wider by design (and their blast still reaches); small arms do not.
        const explosive = c.lobbed || c.name === "scattergun" || c.name === "tank shell";
        expect(closest, "passes near its target").toBeLessThan(explosive ? 3.5 : 2.2);
      }
    });
  }
});

describe("gunships", () => {
  it("fly, hit aircraft with the gun, refuse ground targets with it, and bomb straight down", () => {
    const gunship = createGunship("g", "Hawk", "player", { x: -4, z: 0 });
    const enemyAir = pinned(createInterceptor("i", "Bandit", "enemy", { x: 4, z: 0 }));
    enemyAir.status.alive = true;
    const ground = pinned(createSoldier("s", "Grunt", "enemy", { x: -4, z: 0.4 }));
    const sim = new TacticalSim([gunship, enemyAir, ground]);
    expect(gunship.flying).toBe(true);
    expect(gunship.elevation).toBeGreaterThan(3); // it is up in the air, not on the ground

    sim.select("g");
    expect(sim.queueShoot("s")).toBe(false); // the gun is air-to-air only
    expect(sim.queueShoot("i")).toBe(true);
    const airHp = enemyAir.parts.reduce((s, p) => s + p.hp, 0);
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(enemyAir.parts.reduce((s, p) => s + p.hp, 0)).toBeLessThan(airHp);

    // Bomb: straight down onto the trooper underneath it.
    gunship.commandPoints = gunship.maxCommandPoints;
    const groundHp = ground.parts.reduce((s, p) => s + p.hp, 0);
    sim.select("g");
    expect(sim.queueBombDrop()).toBe(true);
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(ground.parts.reduce((s, p) => s + p.hp, 0)).toBeLessThan(groundHp);
  });

  it("move to a new spot and stay airborne; strafe the ground units under their path", () => {
    const gunship = createGunship("g", "Hawk", "player", { x: -8, z: 0 });
    const victim = pinned(createSoldier("v", "Grunt", "enemy", { x: -2, z: 0.5 }));
    const sim = new TacticalSim([gunship, victim]);
    const hp0 = victim.parts.reduce((s, p) => s + p.hp, 0);
    sim.select("g");
    expect(sim.queueMove({ x: 4, z: 0 })).toBe(true);
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(gunship.position.x).toBeGreaterThan(0);
    expect(gunship.flying).toBe(true);
    expect(victim.parts.reduce((s, p) => s + p.hp, 0)).toBeLessThan(hp0); // the gun run
  });

  it("can be shot down from the ground by flak", () => {
    const flak = createFlak("f", "Flak", "player", { x: -6, z: 0 });
    const gunship = pinned(createGunship("g", "Hawk", "enemy", { x: 4, z: 0 }));
    const sim = new TacticalSim([flak, gunship]);
    const hp0 = gunship.parts.reduce((s, p) => s + p.hp, 0);
    sim.select("f");
    expect(sim.queueShoot("g")).toBe(true);
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(gunship.parts.reduce((s, p) => s + p.hp, 0)).toBeLessThan(hp0);
  });

  it("a bomber carpets its line and has no gun", () => {
    const bomber = createBomber("b", "Fortress", "player", { x: -2, z: 0 });
    const victim = pinned(createSoldier("v", "Grunt", "enemy", { x: -2, z: 0.3 }));
    const sim = new TacticalSim([bomber, victim]);
    sim.select("b");
    expect(sim.queueShoot("v")).toBe(false);
    const hp0 = victim.parts.reduce((s, p) => s + p.hp, 0);
    expect(sim.queueBombDrop()).toBe(true);
    sim.endTurn();
    for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(victim.parts.reduce((s, p) => s + p.hp, 0)).toBeLessThan(hp0);
  });
});
