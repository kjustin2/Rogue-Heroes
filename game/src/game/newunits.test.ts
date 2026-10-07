import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef, unitStats } from "./sim";
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

  it("a Trencher digs in every friendly trooper within 4m", () => {
    const sim = staged();
    const t = sim.debugSpawn("trencher", "player", { x: -9, z: 0 });
    const near = sim.debugSpawn("soldier", "player", { x: -7, z: 0 });
    const far = sim.debugSpawn("soldier", "player", { x: -9, z: 8 });
    sim.debugSelect(t.id);
    expect(sim.queueDig()).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(near.id)!.dugIn, "the squad is dug in").toBeLessThan(1);
    expect(sim.entity(far.id)!.dugIn, "out of reach").toBeUndefined();
  });

  it("the Ricochet Gunner's hit glances on to the next two foes in a clump", () => {
    const sim = staged();
    const g = sim.debugSpawn("lancer", "player", { x: -9, z: 0 });
    const a = sim.debugSpawn("soldier", "enemy", { x: -5, z: 0 });
    const b = sim.debugSpawn("soldier", "enemy", { x: -5, z: 1.6 });
    const c = sim.debugSpawn("soldier", "enemy", { x: -5, z: -1.6 });
    const lone = sim.debugSpawn("soldier", "enemy", { x: -5, z: 9 });
    for (const e of [a, b, c, lone]) { disarm(e); tough(e); }
    const hpBefore = new Map([a, b, c, lone].map((e) => [e.id, hp(e)] as const));
    sim.debugSelect(g.id);
    expect(sim.queueShoot(a.id)).toBe(true);
    sim.endTurn(); settle(sim);
    const hurt = [a, b, c].filter((e) => hp(sim.entity(e.id)!) < hpBefore.get(e.id)!).length;
    expect(hurt, "the first foe and at least one more").toBeGreaterThanOrEqual(2);
    expect(hp(sim.entity(lone.id)!), "too far for the ricochet").toBe(hpBefore.get(lone.id));
  });

  it("a Bounty Hunter's kill pays $50", () => {
    const sim = staged();
    const h = sim.debugSpawn("bounty", "player", { x: -12, z: 0 });
    const prey = sim.debugSpawn("soldier", "enemy", { x: -6, z: 0 });
    disarm(prey);
    for (const p of prey.parts) p.hp = 1;
    sim.debugSelect(h.id);
    const before = sim.money("player");
    expect(sim.queueShoot(prey.id)).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(prey.id)!.status.alive).toBe(false);
    expect(sim.money("player")).toBeGreaterThan(before + 49);
  });

  it("an Ironclad's shield turns bullets from the front and not from behind", () => {
    const damageFrom = (side: 1 | -1): number => {
      const sim = staged();
      const iron = sim.debugSpawn("ironclad", "enemy", { x: 0, z: 0 });
      iron.yaw = Math.PI / 2; // facing +x
      disarm(iron);
      const shooter = sim.debugSpawn("soldier", "player", { x: side * 8, z: 0 });
      sim.debugSelect(shooter.id);
      const before = hp(iron);
      sim.queueShoot(iron.id);
      sim.endTurn(); settle(sim);
      return before - hp(sim.entity(iron.id)!);
    };
    const front = damageFrom(1), back = damageFrom(-1);
    expect(front).toBeGreaterThan(0);
    expect(back, "much more from behind").toBeGreaterThan(front * 1.8);
  });
});

describe("the Runabout", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("seats five (four riders and a gunner), and its gun needs a gunner aboard", () => {
    const sim = staged();
    const car = sim.debugSpawn("runabout", "player", { x: -12, z: 0 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: -4, z: 0 });
    disarm(foe);
    sim.debugSelect(car.id);
    expect(sim.queueShoot(foe.id), "no gunner, no shot").toBe(false);
    const riders = Array.from({ length: 6 }, (_, i) => sim.debugSpawn("soldier", "player", { x: -12, z: 1.6 + (i % 3) * 0.1 + Math.floor(i / 3) * 0.1 }));
    let boarded = 0;
    for (const r of riders) {
      car.commandPoints = car.maxCommandPoints;
      sim.debugSelect(car.id);
      if (sim.queueLoad(r.id)) { boarded += 1; sim.endTurn(); settle(sim); }
    }
    expect(boarded, "five seats").toBe(5);
    expect(sim.entity(car.id)!.passengerIds?.length).toBe(5);
    car.commandPoints = car.maxCommandPoints;
    sim.debugSelect(car.id);
    expect(sim.queueShoot(foe.id), "a gunner is aboard").toBe(true);
  });

  it("drives far in one move", () => {
    expect(unitStats("runabout").moveRange).toBeGreaterThan(unitStats("tank").moveRange * 2);
  });
});

describe("sentries", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("a Turret Tech sets down two, shows its supply, and the third is refused", () => {
    const sim = staged();
    const tt = sim.debugSpawn("turrettech", "player", { x: -4, z: 0 });
    expect(tt.grenades).toBe(2);
    sim.debugSelect(tt.id);
    expect(sim.queuePlace({ x: -2, z: 2 }), sim.log[0]).toBe(true);
    tt.commandPoints = tt.maxCommandPoints;
    expect(sim.queuePlace({ x: -2, z: -2 }), sim.log[0]).toBe(true);
    tt.commandPoints = tt.maxCommandPoints;
    expect(tt.grenades).toBe(0);
    expect(sim.queuePlace({ x: -3, z: 4 })).toBe(false);
    expect(sim.entities.filter((e) => e.kind === "sentry")).toHaveLength(2);
    expect(sim.money("player")).toBe(3000 - 140);
  });

  it("a sentry shoots the nearest foe by itself, and packs up after its turns", () => {
    const sim = staged();
    const tt = sim.debugSpawn("turrettech", "player", { x: -8, z: 0 });
    const foe = sim.debugSpawn("soldier", "enemy", { x: 4, z: 0 });
    disarm(foe); tough(foe);
    sim.debugSelect(tt.id);
    expect(sim.queuePlace({ x: -6, z: 0 }), sim.log[0]).toBe(true);
    const sentry = sim.entities.find((e) => e.kind === "sentry")!;
    const before = hp(foe);
    sim.endTurn(); settle(sim);
    expect(hp(sim.entity(foe.id)!), "it fired on its own").toBeLessThan(before);
    for (let i = 0; i < 4; i += 1) { sim.endTurn(); settle(sim); }
    expect(sim.entity(sentry.id)!.status.alive, "packed up").toBe(false);
  });
});

describe("new strikes", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const call = (sim: TacticalSim, kind: string, point: { x: number; z: number }): void => {
    (sim as unknown as { queuedSupport: { kind: string; point: { x: number; z: number }; dir: { x: number; z: number }; team: string }[] })
      .queuedSupport.push({ kind, point, dir: { x: 1, z: 0 }, team: "player" });
    sim.endTurn(); settle(sim);
  };

  it("EMP Burst leaves vehicles in range with no actions next turn and spares troopers", () => {
    const sim = staged();
    const tank = sim.debugSpawn("tank", "enemy", { x: 2, z: 0 });
    tank.status.canMove = false; // stays put under the pulse
    const man = sim.debugSpawn("soldier", "enemy", { x: 2, z: 3 });
    man.status.canMove = false;
    call(sim, "emp", { x: 2, z: 0 });
    expect(sim.entity(tank.id)!.commandPoints, "dead in the water").toBe(0);
    expect(sim.entity(man.id)!.commandPoints).toBeGreaterThan(0);
  });

  it("Minefield Drop seeds mines, Medevac heals to full, Sentry Drop lands a sentry, Rail Strike hits hard", () => {
    const sim = staged();
    call(sim, "minedrop", { x: 4, z: 0 });
    expect(sim.mines.filter((m) => m.team === "player").length).toBeGreaterThanOrEqual(3);
    const hurt = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    for (const p of hurt.parts) p.hp = 2;
    call(sim, "medevac", { x: -6, z: 0 });
    expect(hp(sim.entity(hurt.id)!)).toBe(hurt.parts.reduce((s, p) => s + p.maxHp, 0));
    call(sim, "sentrydrop", { x: -4, z: 4 });
    expect(sim.entities.some((e) => e.kind === "sentry" && e.team === "player")).toBe(true);
    const hull = sim.debugSpawn("tank", "enemy", { x: 8, z: -6 });
    disarm(hull);
    const before = hp(hull);
    call(sim, "railstrike", { x: 8, z: -6 });
    expect(before - hp(sim.entity(hull.id)!)).toBeGreaterThan(90);
  });
});

describe("the new posts and the roster split", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("every map has a mirrored pair each of Gun Posts, Rocket Posts and Flame Posts", () => {
    for (const id of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      for (const kind of ["gunpost", "rocketpost", "flamepost"]) expect(sim.entities.filter((e) => e.kind === kind && e.team === "neutral").length, `${id}/${kind}`).toBe(2);
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

  it("each faction fields four of the new kinds: two it shares with the others and two that are its own", () => {
    const NEW = ["runabout", "turrettech", "hornet", "lancer", "sledge", "bounty", "ironclad", "trencher"];
    for (const f of FACTIONS) {
      const mine = f.roster.filter((k) => NEW.includes(k));
      expect(mine, f.id).toHaveLength(4);
      const own = mine.filter((k) => FACTIONS.every((o) => o.id === f.id || !o.roster.includes(k as never)));
      const shared = mine.filter((k) => FACTIONS.every((o) => o.roster.includes(k as never)));
      expect(own, `${f.id} exclusives`).toHaveLength(2);
      expect([...shared].sort(), `${f.id} shared`).toEqual(["runabout", "turrettech"]);
    }
  });
});

describe("Home Base upgrades", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  const base = (sim: TacticalSim) => sim.entities.find((e) => e.kind === "base" && e.team === "player")!;

  it("armour adds 30% health a level, in order, behind its tech and its price", () => {
    const sim = staged();
    const b = base(sim);
    sim.select(b.id);
    expect(sim.baseUpgradeFailureReason(b, "armor1")).toMatch(/Research/);
    b.unlockedTech = ["assault", "shock"];
    const before = b.parts.reduce((s, p) => s + p.maxHp, 0);
    expect(sim.baseUpgradeFailureReason(b, "armor2")).toMatch(/Needs Base Armor I/);
    expect(sim.upgradeBaseWith("armor1"), sim.log[0]).toBe(true);
    expect(b.parts.reduce((s, p) => s + p.maxHp, 0)).toBeGreaterThanOrEqual(Math.round(before * 1.29));
    b.commandPoints = b.maxCommandPoints;
    expect(sim.upgradeBaseWith("armor2"), sim.log[0]).toBe(true);
    expect(b.armorLevel).toBe(2);
  });

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

  it("the Watch Radar reveals the enemy's orders at the start of every turn", () => {
    const sim = staged();
    const b = base(sim);
    b.unlockedTech = ["recon", "radar"];
    sim.select(b.id);
    expect(sim.upgradeBaseWith("radar"), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    expect((sim as unknown as { revealedOrders: boolean }).revealedOrders).toBe(true);
  });

  it("a Hard bot with an army and money buys armour and the cannon", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    const e = sim.entities.find((x) => x.kind === "base" && x.team === "enemy")!;
    e.unlockedTech = ["assault", "shock", "motorpool"];
    for (let i = 0; i < 6; i += 1) sim.debugSpawn("soldier", "enemy", { x: 10 + i, z: -8 });
    sim.debugSpawn("soldier", "player", { x: -10, z: 0 });
    sim.economy.set("enemy", 3000);
    sim.turn = 6;
    for (let t = 0; t < 4; t += 1) { sim.endTurn(); settle(sim); sim.economy.set("enemy", 3000); }
    expect(e.armorLevel ?? 0, "bought armour").toBeGreaterThanOrEqual(1);
  });
});

describe("pulses are not explosions (2026-10-03 review)", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("an EMP burst draws as a pulse, never as a fire blast", () => {
    const sim = staged();
    const blasts: number[] = [];
    const seen = new Set<string>();
    const watch = (): void => { for (const e of sim.effects) if (e.type === "blast" && !seen.has(e.id)) { seen.add(e.id); blasts.push(e.color); } };
    sim.debugSpawn("tank", "enemy", { x: 2, z: 0 });
    (sim as unknown as { queuedSupport: unknown[] }).queuedSupport.push({ kind: "emp", point: { x: 2, z: 0 }, dir: { x: 1, z: 0 }, team: "player" });
    sim.endTurn(); watch();
    for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) { sim.update(0.05); watch(); }
    expect(blasts).toContain(PULSE_EMP);
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
