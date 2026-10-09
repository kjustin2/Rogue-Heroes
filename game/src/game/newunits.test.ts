import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { FACTIONS } from "./factions";
import { recomputeStatus } from "./damageModel";
import { PULSE_EMP, isPulseBlast } from "./sim";
import { DEFAULT_TERRAIN, setActiveTerrain } from "./terrain";

// BATCH 3 (owner 2026-10-03): the new troopers, posts and strikes, each proven through the real sim.
const settle = (sim: TacticalSim, secs = 40): void => { for (let t = 0; t < secs && sim.phase === "resolve"; t += 0.05) sim.update(0.05); };
const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal");
  setActiveTerrain(mapDef("dustbowl").terrain);
  sim.economy.set("player", 3000);
  sim.economy.set("enemy", 0);
  for (const e of sim.entities) if (e.team === "enemy" && e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
  for (const e of sim.entities.filter((x) => isMount(x.kind))) e.status.alive = false; // no free posts muddying a test
  // ...and no map props: a layout change must not move a test's line of fire or placement spot.
  for (let i = sim.entities.length - 1; i >= 0; i -= 1) { const e = sim.entities[i]; if (e.kind === "cover" && !["ridge", "cliff"].includes(e.coverKind ?? "")) sim.entities.splice(i, 1); }
  return sim;
};
const isMount = (k: string): boolean => k === "gunpost" || k === "rocketpost" || k === "flamepost" || k === "mortarpit" || k === "cannonpost";
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
  e.status.canShoot = false; e.status.canMove = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);
/** Five times the health, so a test target survives what it is hit with. */
const tough = (e: { parts: { hp: number; maxHp: number }[] }): void => { for (const p of e.parts) { p.maxHp *= 5; p.hp *= 5; } };

describe("burning", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("a flamer sets a trooper alight for three turns of fire; a tank cannot burn", () => {
    const sim = staged();
    const f = sim.debugSpawn("flamer", "player", { x: -10, z: 0 });
    const soldier = sim.debugSpawn("soldier", "enemy", { x: -4.5, z: 0 });
    const tank = sim.debugSpawn("tank", "enemy", { x: -4.5, z: 6 });
    disarm(soldier); disarm(tank); tough(soldier);
    sim.debugSelect(f.id);
    expect(sim.queueShoot(soldier.id)).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(soldier.id)!.burning, "the trooper is on fire").toBeDefined();
    const before = hp(sim.entity(soldier.id)!);
    sim.endTurn(); settle(sim);
    expect(hp(sim.entity(soldier.id)!), "it burns on the next turn too").toBeLessThan(before);
    sim.debugSelect(f.id);
    expect(sim.queueShoot(tank.id)).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(tank.id)!.burning, "machines do not burn").toBeUndefined();
  });

  it("the fire dies out after its turns", () => {
    const sim = staged();
    const a = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    a.burning = { turns: 2, dmg: 8 };
    sim.endTurn(); settle(sim);
    expect(sim.entity(a.id)!.burning?.turns).toBe(1);
    sim.endTurn(); settle(sim);
    expect(sim.entity(a.id)!.burning, "out after two turns").toBeUndefined();
  });
});

describe("the hammer, the spade and the ricochet", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("Slam hurts and flings everything within 3m of the Sledge, and nothing farther", () => {
    const sim = staged();
    const s = sim.debugSpawn("sledge", "player", { x: -8, z: 0 });
    const near = sim.debugSpawn("soldier", "enemy", { x: -6.4, z: 0 });
    const near2 = sim.debugSpawn("soldier", "enemy", { x: -8, z: 2.2 });
    const far = sim.debugSpawn("soldier", "enemy", { x: -14, z: 0 });
    for (const e of [near, near2, far]) disarm(e);
    const starts = [near, near2, far].map((e) => ({ ...e.position }));
    const hpBefore = [near, near2, far].map((e) => hp(e));
    sim.debugSelect(s.id);
    expect(sim.queueSlam()).toBe(true);
    expect(s.commandPoints).toBe(s.maxCommandPoints - 1);
    sim.endTurn(); settle(sim);
    const moved = (e: typeof near, i: number): number => Math.hypot(sim.entity(e.id)!.position.x - starts[i].x, sim.entity(e.id)!.position.z - starts[i].z);
    expect(hp(sim.entity(near.id)!)).toBeLessThan(hpBefore[0]);
    expect(moved(near, 0), "thrown a good way").toBeGreaterThan(3);
    expect(moved(near2, 1)).toBeGreaterThan(2);
    expect(moved(far, 2), "out of reach, untouched (a flung neighbour may nudge it)").toBeLessThan(1);
    expect(hp(sim.entity(far.id)!)).toBe(hpBefore[2]);
  });

  it("only a Sledge can swing, and a Slam needs an action point", () => {
    const sim = staged();
    const t = sim.debugSpawn("soldier", "player", { x: -8, z: 0 });
    sim.debugSelect(t.id);
    expect(sim.queueSlam()).toBe(false);
    const s = sim.debugSpawn("sledge", "player", { x: -8, z: 4 });
    s.commandPoints = 0;
    sim.debugSelect(s.id);
    expect(sim.queueSlam()).toBe(false);
  });

});

describe("new strikes", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const call = (sim: TacticalSim, kind: string, point: { x: number; z: number }, team = "player"): void => {
    (sim as unknown as { queuedSupport: { kind: string; point: { x: number; z: number }; dir: { x: number; z: number }; team: string }[] })
      .queuedSupport.push({ kind, point, dir: { x: 1, z: 0 }, team });
    sim.endTurn(); settle(sim);
  };

  it("a Boulder Roll bowls troopers off its lane and breaks on a tank", () => {
    const sim = staged();
    // Victims are the CALLER's foes on the player side (an enemy-side victim is walked off by the enemy AI before the stone arrives).
    const pins = sim.debugSpawn("soldier", "player", { x: -6, z: 6 });
    const at = { ...pins.position };
    const hp0 = hp(pins);
    call(sim, "boulder", { x: -6, z: 6 }, "enemy");
    expect(hp(sim.entity(pins.id)!), "bowled over").toBeLessThan(hp0);
    expect(Math.hypot(pins.position.x - at.x, pins.position.z - at.z), "knocked off the lane").toBeGreaterThan(1);
    // (Kept off Dust Bowl's centre lane: its dust devil sweeps x = 0 on turn 3.)
    const wall = sim.debugSpawn("tank", "player", { x: -14, z: -6 });
    const behind = sim.debugSpawn("soldier", "player", { x: -10, z: -6 });
    const hpBehind = hp(behind), tankAt = { ...wall.position };
    call(sim, "boulder", { x: -12, z: -6 }, "enemy");
    expect(wall.position, "the tank never moves").toEqual(tankAt);
    expect(hp(sim.entity(behind.id)!), "the roll stops at the tank").toBe(hpBehind);
  });
});

describe("the new posts and the roster split", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("every map carries a mirrored pair of each of its OWN two post kinds, and no others (themed, 2026-10-07)", () => {
    const ALL = ["gunpost", "rocketpost", "flamepost", "mortarpit", "cannonpost"];
    for (const id of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      const own = mapDef(id).posts!;
      expect(own.length, id).toBe(2);
      for (const kind of ALL) expect(sim.entities.filter((e) => e.kind === kind && e.team === "neutral").length, `${id}/${kind}`).toBe(own.includes(kind as never) ? 2 : 0);
    }
  });

  it("a Flame Post sets its target alight and a Rocket Post hurts armour", () => {
    const sim = staged();
    const fp = sim.debugStructure("flamepost", "player", { x: -8, z: 0 });
    const crew = sim.debugSpawn("soldier", "player", { x: -9.1, z: 0 });
    fp.occupantId = crew.id;
    const foe = sim.debugSpawn("soldier", "enemy", { x: -3, z: 0 });
    disarm(foe);
    sim.endTurn(); settle(sim); // the crew takes the post at turn start
    sim.debugSelect(fp.id);
    expect(sim.queueShoot(foe.id), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(foe.id)!.burning).toBeDefined();
    const rp = sim.debugStructure("rocketpost", "player", { x: -8, z: 6 });
    const crew2 = sim.debugSpawn("soldier", "player", { x: -9.1, z: 6 });
    rp.occupantId = crew2.id;
    const tank = sim.debugSpawn("tank", "enemy", { x: 6, z: 6 });
    disarm(tank);
    sim.endTurn(); settle(sim);
    sim.debugSelect(rp.id);
    const before = hp(tank);
    expect(sim.queueShoot(tank.id), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    expect(before - hp(sim.entity(tank.id)!)).toBeGreaterThan(50);
  });

  it("each faction fields at least two new kinds of its own, and none is shared", () => {
    const NEW = ["sledge", "breaker", "boomer", "juggernaut", "hookshot", "skater", "molotov", "mole", "chopbike", "bulldozer"];
    for (const f of FACTIONS) {
      const mine = f.roster.filter((k) => NEW.includes(k));
      const own = mine.filter((k) => FACTIONS.every((o) => o.id === f.id || !o.roster.includes(k as never)));
      const shared = mine.filter((k) => FACTIONS.every((o) => o.roster.includes(k as never)));
      expect(own.length, `${f.id} exclusives`).toBeGreaterThanOrEqual(2);
      expect(shared, `${f.id} shared`).toEqual([]);
    }
  });
});

describe("Home Base upgrades", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const base = (sim: TacticalSim) => sim.entities.find((e) => e.kind === "base" && e.team === "player")!;

  it("the Fortress Cannon fires by itself every second turn at the dearest ground foe in 40m, and stops when it is shot out", () => {
    const sim = staged();
    const b = base(sim);
    b.unlockedTech = ["assault", "shock"];
    sim.select(b.id);
    expect(b.status.canShoot, "no gun yet").toBe(false);
    expect(sim.upgradeBaseWith("cannon"), sim.log[0]).toBe(true);
    expect(b.status.canShoot).toBe(true);
    const cheap = sim.debugSpawn("soldier", "enemy", { x: b.position.x + 12, z: 4 });
    const dear = sim.debugSpawn("tank", "enemy", { x: b.position.x + 22, z: -4 });
    for (const e of [cheap, dear]) { disarm(e); tough(e); }
    sim.endTurn(); settle(sim); // not ready on the turn it was built
    expect(sim.log.some((l) => l.startsWith("Home Base fires")), "silent on the build turn").toBe(false);
    sim.endTurn(); settle(sim);
    expect(sim.log.some((l) => /^Home Base fires at Tank/.test(l)), "the shell went for the tank, not the trooper").toBe(true);
    expect(b.cannonReadyTurn).toBeGreaterThan(sim.turn - 1);
    const cannon = b.parts.find((p) => p.id === "cannon")!;
    cannon.hp = 0;
    recomputeStatus(b);
    expect(sim.entity(b.id)!.status.canShoot, "shot out").toBe(false);
  });

  it("a Hard bot with an army and money buys the cannon", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    const e = sim.entities.find((x) => x.kind === "base" && x.team === "enemy")!;
    e.unlockedTech = ["assault", "shock", "motorpool"];
    for (let i = 0; i < 6; i += 1) sim.debugSpawn("soldier", "enemy", { x: 10 + i, z: -8 });
    sim.debugSpawn("soldier", "player", { x: -10, z: 0 });
    sim.economy.set("enemy", 3000);
    sim.turn = 6;
    for (let t = 0; t < 4; t += 1) { sim.endTurn(); settle(sim); sim.economy.set("enemy", 3000); }
    expect(e.parts.some((p) => p.id === "cannon"), "bought the cannon").toBe(true);
  });
});

describe("pulses are not explosions (2026-10-03 review)", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("a fire blast is not a pulse; an electrical burst is", () => {
    expect(isPulseBlast(PULSE_EMP)).toBe(true);
    expect(isPulseBlast(0xff7a2a), "a fire blast is not a pulse").toBe(false);
  });

  it("a burst of rounds meeting in the air is one log line a turn per pair", () => {
    const sim = staged();
    const a = sim.debugSpawn("heavy", "player", { x: -6, z: 0 });
    const b = sim.debugSpawn("heavy", "enemy", { x: 4, z: 0 });
    sim.debugSelect(a.id);
    sim.queueShoot(b.id);
    sim.endTurn();
    // The enemy answers on its own; run the whole resolve and count the lines.
    for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(sim.log.filter((l) => l.includes("collide in mid-air")).length).toBeLessThanOrEqual(1);
  });
});

// ROUND 6 (owner 2026-10-06: "only FUN units"): the kamikaze, the rocket fist and the blast cannon.
describe("the fun units", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const where = (e: { position: { x: number; z: number } }): { x: number; z: number } => ({ ...e.position });
  const moved = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

  it("a Boomer runs in, detonates, dies, and wrecks and flings everything near it; one out of reach is untouched", () => {
    const sim = staged();
    const b = sim.debugSpawn("boomer", "player", { x: -12, z: 0 });
    const near = sim.debugSpawn("soldier", "enemy", { x: -4, z: 0 });
    const far = sim.debugSpawn("soldier", "enemy", { x: -4, z: 10 });
    disarm(near); disarm(far); tough(near);
    const nearAt = where(near), hpNear = hp(near), hpFar = hp(far);
    sim.debugSelect(b.id);
    expect(sim.queueShoot(near.id), "no gun").toBe(false);
    expect(sim.queueMove({ x: -5.5, z: 0 })).toBe(true);
    expect(sim.queueDetonate()).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(b.id)!.status.alive, "the Boomer is gone").toBe(false);
    expect(hp(sim.entity(near.id)!)).toBeLessThan(hpNear - 40);
    expect(moved(sim.entity(near.id)!.position, nearAt), "flung").toBeGreaterThan(1.5);
    expect(hp(sim.entity(far.id)!)).toBe(hpFar);
  });

  it("a Boomer shot before it gets there blows where it falls", () => {
    const sim = staged();
    const b = sim.debugSpawn("boomer", "enemy", { x: -6, z: 0 });
    const friend = sim.debugSpawn("soldier", "enemy", { x: -6, z: 2 });
    disarm(friend); tough(friend);
    disarm(b); // pinned: left free, the bot's Boomer runs at the Marksman and blows on it instead
    const shooter = sim.debugSpawn("sniper", "player", { x: 4, z: 0 }); // from BEHIND: the barrel rides on its back
    b.yaw = -Math.PI / 2;
    const before = hp(friend);
    sim.debugSelect(shooter.id);
    const pack = b.parts.find((p) => p.id === "pack")!;
    for (const p of b.parts) if (p.id !== "pack") { p.maxHp *= 20; p.hp *= 20; }
    pack.hp = 1;
    expect(sim.queueShootPart(b.id, pack.id)).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(b.id)!.status.alive, sim.log.slice(0, 12).join(" | ")).toBe(false);
    expect(hp(sim.entity(friend.id)!), "its own side is caught too").toBeLessThan(before);
  });

  it("a Breaker's punch throws a trooper about twice as far as a soldier's strike, and never moves a tank", () => {
    const throwOf = (kind: "breaker" | "soldier", foeKind: "soldier" | "tank"): number => {
      const sim = staged();
      const a = sim.debugSpawn(kind, "player", { x: -12, z: -3 });
      const foe = sim.debugSpawn(foeKind, "enemy", { x: -10.4, z: -3 });
      disarm(foe); tough(foe);
      const at = where(foe);
      sim.debugSelect(a.id);
      expect(kind === "breaker" ? sim.queueShove(foe.id) : sim.queueMelee(foe.id)).toBe(true);
      sim.endTurn(); settle(sim);
      return moved(sim.entity(foe.id)!.position, at);
    };
    const punch = throwOf("breaker", "soldier");
    const strike = throwOf("soldier", "soldier");
    expect(punch, `punch ${punch.toFixed(1)}m vs strike ${strike.toFixed(1)}m`).toBeGreaterThan(strike * 1.6);
    expect(throwOf("breaker", "tank")).toBe(0);
  });

  it("a Breaker's punch reaches a foe 7m away in one order; a soldier's push does not", () => {
    const sim = staged();
    const a = sim.debugSpawn("breaker", "player", { x: -12, z: -3 });
    const s = sim.debugSpawn("soldier", "player", { x: -12, z: 3 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: -5.6, z: -3 });
    const foe2 = sim.debugSpawn("soldier", "enemy", { x: -5.6, z: 3 });
    disarm(foe); disarm(foe2);
    sim.debugSelect(a.id);
    expect(sim.queueShove(foe.id)).toBe(true);
    sim.debugSelect(s.id);
    expect(sim.queueShove(foe2.id)).toBe(false);
  });

  it("a Juggernaut's blast throws a trooper further than a Tank shell does", () => {
    const throwOf = (kind: "juggernaut" | "tank"): number => {
      const sim = staged();
      const a = sim.debugSpawn(kind, "player", { x: -16, z: -8 }); // z = -8: flat for 20m (z = -3 throws into a 0.7m step)
      const foe = sim.debugSpawn("soldier", "enemy", { x: -6, z: -8 });
      disarm(foe); tough(foe);
      const at = where(foe);
      sim.debugSelect(a.id);
      expect(sim.queueShoot(foe.id)).toBe(true);
      sim.endTurn(); settle(sim);
      return moved(sim.entity(foe.id)!.position, at);
    };
    const jug = throwOf("juggernaut");
    const tank = throwOf("tank");
    expect(jug, `juggernaut ${jug.toFixed(1)}m vs tank ${tank.toFixed(1)}m`).toBeGreaterThan(tank + 1);
  });

  it("the new units survive a save and the bot uses them (a Boomer near a clump blows; a Breaker punches)", () => {
    const sim = staged();
    sim.debugSpawn("boomer", "player", { x: -12, z: 0 });
    sim.debugSpawn("breaker", "player", { x: -12, z: 3 });
    sim.debugSpawn("juggernaut", "player", { x: -12, z: 6 });
    const clone = new TacticalSim();
    expect(clone.restore(sim.serialize())).toBe(true);
    expect(["boomer", "breaker", "juggernaut"].every((k) => clone.entities.some((e) => e.kind === k))).toBe(true);

    // debugCommandAsAi drives the PLAYER seat with the bot's brain.
    const bot = staged();
    const boom = bot.debugSpawn("boomer", "player", { x: -2, z: 0 });
    for (const z of [-1, 0.6, 2.2]) disarm(bot.debugSpawn("soldier", "enemy", { x: 6, z }));
    const breaker = bot.debugSpawn("breaker", "player", { x: -2, z: 12 });
    disarm(bot.debugSpawn("soldier", "enemy", { x: 3, z: 12 }));
    bot.debugCommandAsAi();
    expect(bot.orders.some((o) => o.actorId === boom.id && o.kind === "detonate"), "boomer detonates").toBe(true);
    expect(bot.orders.some((o) => o.actorId === breaker.id && o.kind === "melee" && o.shove), "breaker punches").toBe(true);
  });

  it("an old save that holds a retired unit still loads, without it", () => {
    const sim = staged();
    const keep = sim.debugSpawn("soldier", "player", { x: -12, z: 0 });
    const gone = sim.debugSpawn("soldier", "player", { x: -12, z: 3 });
    const raw = JSON.parse(sim.serialize());
    for (const e of raw.entities) if (e.id === gone.id) e.kind = "trencher";
    const clone = new TacticalSim();
    expect(clone.restore(JSON.stringify(raw))).toBe(true);
    expect(clone.entity(keep.id)).toBeDefined();
    expect(clone.entity(gone.id)).toBeUndefined();
    expect(() => { clone.endTurn(); settle(clone); }).not.toThrow();
  });
});

// ROUND 7 (owner 2026-10-07, second fun audit): the grapple, the bowler, the fire bottle and the burrower.
describe("round 7 units", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const gap = (a: { position: { x: number; z: number } }, b: { position: { x: number; z: number } }): number => Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);

  it("a Hookshot's harpoon drags a trooper to its feet; a tank barely budges; its Reel reaches 10m", () => {
    const pull = (foeKind: "soldier" | "tank"): number => {
      const sim = staged();
      const h = sim.debugSpawn("hookshot", "player", { x: -16, z: -8 });
      const foe = sim.debugSpawn(foeKind, "enemy", { x: -5, z: -8 });
      disarm(foe); tough(foe);
      sim.debugSelect(h.id);
      expect(sim.queueShoot(foe.id), sim.log[0]).toBe(true);
      sim.endTurn(); settle(sim);
      return gap(sim.entity(h.id)!, sim.entity(foe.id)!);
    };
    expect(pull("soldier"), "dragged to its feet").toBeLessThan(3);
    expect(pull("tank"), "armour barely moves").toBeGreaterThan(7);
    const sim = staged();
    expect(sim.leapRange(sim.debugSpawn("hookshot", "player", { x: -16, z: -8 }))).toBeGreaterThan(sim.leapRange(sim.debugSpawn("soldier", "player", { x: -16, z: -4 })) * 2);
  });

  it("a Rocket Skater's boost bowls over the troopers on its line and leaves the one off it alone", () => {
    const sim = staged();
    const k = sim.debugSpawn("skater", "player", { x: -16, z: -8 });
    const on = sim.debugSpawn("soldier", "enemy", { x: -10, z: -8.3 });
    const off = sim.debugSpawn("soldier", "enemy", { x: -10, z: -5 });
    disarm(on); disarm(off); tough(on);
    const hpOn = hp(on), hpOff = hp(off), at = { ...on.position };
    sim.debugSelect(k.id);
    expect(sim.queueMove({ x: -5, z: -8 }), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    expect(hp(sim.entity(on.id)!)).toBeLessThan(hpOn);
    expect(Math.hypot(sim.entity(on.id)!.position.x - at.x, sim.entity(on.id)!.position.z - at.z), "bowled aside").toBeGreaterThan(1.5);
    expect(hp(sim.entity(off.id)!)).toBe(hpOff);
  });

  it("a Molotov's bottle leaves burning ground and sets the troopers in it alight", () => {
    const sim = staged();
    const m = sim.debugSpawn("molotov", "player", { x: -16, z: -8 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: -4, z: -8 });
    disarm(foe); tough(foe);
    sim.debugSelect(m.id);
    expect(sim.queueShoot(foe.id), sim.log[0]).toBe(true);
    const zones = sim.burnZones.length;
    sim.endTurn(); settle(sim);
    expect(sim.burnZones.length).toBeGreaterThan(zones);
    expect(sim.entity(foe.id)!.burning, "alight").toBeTruthy();
  });

  it("a Mole Sapper burrows under a wall of bodies, can't be hit on the way, and erupts under a foe", () => {
    const sim = staged();
    const mole = sim.debugSpawn("mole", "player", { x: -16, z: -8 });
    const blocker = sim.debugSpawn("soldier", "enemy", { x: -12, z: -8 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: -8.4, z: -8 });
    disarm(blocker); disarm(foe); tough(foe);
    const hpFoe = hp(foe), at = { ...foe.position };
    sim.debugSelect(mole.id);
    expect(sim.queueMove({ x: -9, z: -8 }), sim.log[0]).toBe(true);
    sim.endTurn();
    let seenBurrowed = false;
    for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) { sim.update(0.05); if (sim.entity(mole.id)!.burrowed) seenBurrowed = true; }
    expect(seenBurrowed, "it went underground").toBe(true);
    expect(sim.entity(mole.id)!.burrowed).toBeFalsy();
    expect(gap(sim.entity(mole.id)!, { position: { x: -9, z: -8 } }), "surfaced at the spot, past the blocker").toBeLessThan(1.6);
    expect(hp(sim.entity(foe.id)!)).toBeLessThan(hpFoe);
    expect(Math.hypot(sim.entity(foe.id)!.position.x - at.x, sim.entity(foe.id)!.position.z - at.z), sim.log.slice(0, 10).join(" | ")).toBeGreaterThan(1);
    // ...and it refuses to surface in water or inside a prop.
    const wet = staged();
    const m2 = wet.debugSpawn("mole", "player", { x: -16, z: -8 });
    wet.debugSelect(m2.id);
    const water = wet.mapDef.terrain.water?.[0];
    if (water) expect(wet.queueMove({ x: (water.minX + water.maxX) / 2, z: (water.minZ + water.maxZ) / 2 })).toBe(false);
  });
});

// ROUND 8 (owner 2026-10-07, third fun audit): the bike that rides through, the dozer that shoves, the jump that lands like a bomb.
describe("round 8 units", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const moved = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

  it("a Chop Bike rides through a line of troopers, slashing and scattering each one", () => {
    const sim = staged();
    const bike = sim.debugSpawn("chopbike", "player", { x: -18, z: -8 });
    // One on the line, one 1.7m off it: only the bike's wider sweep (not the Skater's) reaches the second.
    const foes = [[-12, -8.2], [-9, -9.7]].map(([x, z]) => { const f = sim.debugSpawn("soldier", "enemy", { x, z }); disarm(f); tough(f); return f; });
    const hp0 = foes.map(hp), at = foes.map((f) => ({ ...f.position }));
    sim.debugSelect(bike.id);
    expect(sim.queueMove({ x: -5, z: -8 }), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    foes.forEach((f, i) => {
      expect(hp(sim.entity(f.id)!), `trooper ${i} slashed`).toBeLessThan(hp0[i]);
      expect(moved(sim.entity(f.id)!.position, at[i]), `trooper ${i} scattered`).toBeGreaterThan(1.5);
    });
  });

  it("a Bulldozer shoves a trooper and a prop ahead of its blade, and drives where a prop would have stopped anything else", () => {
    const sim = staged();
    const dozer = sim.debugSpawn("bulldozer", "player", { x: -18, z: -8 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: -14, z: -8 });
    disarm(foe); tough(foe);
    const crate = sim.debugCover("crate", { x: -11, z: -8.4 });
    const crateAt = { ...crate.position };
    sim.debugSelect(dozer.id);
    expect(sim.queueMove({ x: -8, z: -8 }), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    const d = sim.entity(dozer.id)!;
    expect(d.position.x, "the dozer got through").toBeGreaterThan(-9.5);
    expect(sim.entity(foe.id)!.position.x, "the trooper ends ahead of the blade").toBeGreaterThan(d.position.x);
    expect(moved(sim.entity(crate.id)!.position, crateAt), "the prop was pushed").toBeGreaterThan(1.5);
  });

  it("a Jump Trooper lands like a bomb: every foe within 2.5m is hurt and thrown", () => {
    const sim = staged();
    const j = sim.debugSpawn("jumper", "player", { x: -16, z: -8 });
    const near = sim.debugSpawn("soldier", "enemy", { x: -9.8, z: -8 });
    const near2 = sim.debugSpawn("soldier", "enemy", { x: -8, z: -9.6 });
    for (const f of [near, near2]) { disarm(f); tough(f); }
    const h = [hp(near), hp(near2)], at = [{ ...near.position }, { ...near2.position }];
    sim.debugSelect(j.id);
    expect(sim.queueMove({ x: -8, z: -8 }), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    [near, near2].forEach((f, i) => {
      expect(hp(sim.entity(f.id)!), `foe ${i} hurt`).toBeLessThan(h[i] - 20);
      expect(moved(sim.entity(f.id)!.position, at[i]), `foe ${i} thrown`).toBeGreaterThan(1.5);
    });
  });
});

// THE FUN DECK (owner 2026-10-07: scans, heals, stat bumps and soft utility cut; these three in).
describe("shockwave, spring trap and tank drop", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const call = (sim: TacticalSim, kind: string, point: { x: number; z: number }, team = "player"): void => {
    (sim as unknown as { queuedSupport: unknown[] }).queuedSupport.push({ kind, point, dir: { x: 1, z: 0 }, team });
  };
  const run = (sim: TacticalSim): void => { sim.endTurn(); for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) sim.update(0.05); };

  it("a shockwave flings troopers far, nudges a light bike and never moves a tank", () => {
    const sim = staged();
    const trooper = sim.debugSpawn("soldier", "enemy", { x: 1.5, z: 0 });
    const car = sim.debugSpawn("chopbike", "enemy", { x: -2, z: 1.5 });
    const tank = sim.debugSpawn("tank", "enemy", { x: 0, z: -2.6 });
    for (const e of [trooper, car, tank]) { disarm(e); tough(e); }
    const t0 = { ...trooper.position }, c0 = { ...car.position }, k0 = { ...tank.position };
    call(sim, "shockwave", { x: 0, z: 0 });
    run(sim);
    const d = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
    expect(d(trooper.position, t0), "trooper flung").toBeGreaterThan(4);
    expect(d(car.position, c0), "car nudged").toBeLessThan(3);
    expect(d(tank.position, k0), "tank never moves").toBe(0);
  });

  it("a spring trap launches the first foe to step on it, once", () => {
    const sim = staged();
    const at = { x: 0, z: 0 };
    (sim as unknown as { mines: unknown[] }).mines.push({ id: "spring-t", x: at.x, z: at.z, team: "enemy", spring: true });
    const foe = sim.debugSpawn("soldier", "player", { x: at.x - 3, z: at.z });
    tough(foe);
    sim.debugSelect(foe.id);
    expect(sim.queueMove({ x: at.x + 2, z: at.z })).toBe(true);
    run(sim);
    expect(Math.hypot(foe.position.x - at.x, foe.position.z - at.z), "thrown well past the plate").toBeGreaterThan(6);
    expect(sim.mines.some((m) => m.id === "spring-t"), "one use").toBe(false);
  });

  it("a tank drop crushes troopers under it, lands a tank that fights for 3 turns, then is scuttled into a wreck", () => {
    const sim = staged();
    const victim = sim.debugSpawn("soldier", "enemy", { x: 0, z: 0 });
    disarm(victim);
    const hp0 = hp(victim);
    call(sim, "tankdrop", { x: 0, z: 0 });
    run(sim);
    expect(hp(victim), "crushed").toBeLessThan(hp0);
    const tank = sim.entities.find((e) => e.kind === "tank" && e.team === "player" && e.dropTtl !== undefined)!;
    expect(tank, "landed").toBeTruthy();
    const restored = new TacticalSim();
    restored.restore(sim.serialize());
    expect(restored.entities.find((e) => e.id === tank.id)?.dropTtl, "rides the save").toBe(tank.dropTtl);
    for (let i = 0; i < 4; i += 1) run(sim);
    expect(sim.entity(tank.id)?.status.alive, "scuttled").toBe(false);
    expect(sim.entities.some((e) => e.coverKind === "wreck" && e.id === `wreck-${tank.id}`), "left a wreck").toBe(true);
  });

  it("a commando drop lands a Jump Trooper that slams everyone near it (2026-10-08)", () => {
    const sim = staged();
    const near = sim.debugSpawn("soldier", "enemy", { x: 1.6, z: 0 });
    const far = sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });
    for (const e of [near, far]) { disarm(e); tough(e); }
    const n0 = { ...near.position }, hpNear = hp(near), hpFar = hp(far);
    call(sim, "commando", { x: 0, z: 0 });
    run(sim);
    const commando = sim.entities.find((e) => e.kind === "jumper" && e.team === "player" && e.chuted);
    expect(commando, "landed").toBeTruthy();
    expect(hp(near), "slammed").toBeLessThan(hpNear);
    expect(Math.hypot(near.position.x - n0.x, near.position.z - n0.z), "thrown").toBeGreaterThan(1.5);
    expect(hp(far), "out of reach").toBe(hpFar);
  });

  it("a car bomb bowls troopers down its line and blows up at the end; a tank in the way sets it off there", () => {
    const sim = staged();
    const inLine = sim.debugSpawn("soldier", "enemy", { x: -3, z: 0 });
    const atEnd = sim.debugSpawn("soldier", "enemy", { x: 7.5, z: 1.2 });
    for (const e of [inLine, atEnd]) { disarm(e); tough(e); }
    const hpLine = hp(inLine), hpEnd = hp(atEnd);
    call(sim, "carbomb", { x: 0, z: 0 });
    run(sim);
    expect(hp(inLine), "rammed").toBeLessThan(hpLine);
    expect(hp(atEnd), "caught in the blast at the end").toBeLessThan(hpEnd);
    expect(sim.log.some((l) => l.includes("car bomb goes up"))).toBe(true);
    const sim2 = staged();
    const tank = sim2.debugSpawn("tank", "enemy", { x: -2, z: 0 });
    const behind = sim2.debugSpawn("soldier", "enemy", { x: 7.5, z: 0 });
    for (const e of [tank, behind]) { disarm(e); tough(e); }
    const hpTank = hp(tank), hpBehind = hp(behind), at = { ...tank.position };
    call(sim2, "carbomb", { x: 0, z: 0 });
    run(sim2);
    expect(hp(tank), "blown up against the tank").toBeLessThan(hpTank);
    expect(tank.position, "a tank never moves").toEqual(at);
    expect(hp(behind), "the run stopped at the tank").toBe(hpBehind);
  });

  it("a car bomb goes up against a solid prop in its path, never through it (visual QA 2026-10-08)", () => {
    const sim = staged();
    const crate = sim.debugCover("crate", { x: -1, z: 0 });
    const past = sim.debugSpawn("soldier", "enemy", { x: 5, z: 0 });
    disarm(past); tough(past);
    const hpPast = hp(past);
    call(sim, "carbomb", { x: 0, z: 0 });
    run(sim);
    expect(sim.log.some((l) => l.includes("car bomb goes up"))).toBe(true);
    expect(crate.parts.reduce((a, p) => a + p.hp, 0), "the crate took the blast").toBeLessThan(crate.parts.reduce((a, p) => a + p.maxHp, 0));
    expect(hp(past), "nothing past the crate was rammed").toBe(hpPast);
    expect(sim.effects.some((e) => e.type === "roll"), "the car is no longer drawn").toBe(false);
  });
});

describe("harpoon tower (2026-10-07)", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  it("fires by itself each turn and drags the nearest foe to its foot; a tank never moves", () => {
    const sim = staged();
    const tower = sim.debugStructure("harpoon", "player", { x: -10, z: 0 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: -1, z: 0 });
    disarm(foe); tough(foe);
    const d0 = Math.hypot(foe.position.x - tower.position.x, foe.position.z - tower.position.z);
    sim.endTurn(); settle(sim);
    const d1 = Math.hypot(foe.position.x - tower.position.x, foe.position.z - tower.position.z);
    expect(d1, `dragged in: ${d0.toFixed(1)}m -> ${d1.toFixed(1)}m`).toBeLessThan(d0 - 3);
    const sim2 = staged();
    sim2.debugStructure("harpoon", "player", { x: -10, z: 0 });
    const tank = sim2.debugSpawn("tank", "enemy", { x: -2, z: 0 });
    disarm(tank); tough(tank);
    const at = { ...tank.position };
    sim2.endTurn(); settle(sim2);
    expect(tank.position).toEqual(at);
  });
});
