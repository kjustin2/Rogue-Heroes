import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, pointInWater, setActiveTerrain, terrainBridges } from "./terrain";

// Dropping a bridge is the most consequential destructible on the board, and it is the one most
// likely to break quietly: terrain is a module singleton rebuilt from the MapDef, so a destroyed
// span comes back on reload unless the loss is recorded and re-applied. These pin that.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};

/** A map with authored bridge crossings. */
const BRIDGED = "karak";

const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef(BRIDGED), "destroy", "normal");
  return sim;
};

describe("bridge spans", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("puts a destructible span on every authored crossing", () => {
    // Bridges used to be pure terrain, so the crossing could not be attacked at all.
    const sim = staged();
    const authored = mapDef(BRIDGED).terrain.bridges ?? [];
    expect(authored.length).toBeGreaterThan(0);
    const spans = sim.entities.filter((e) => e.coverKind === "span");
    expect(spans.length).toBe(authored.length);
    // And each sits on the crossing it represents: a span floating off its own bridge would drop
    // the wrong one, or nothing.
    for (const span of spans) {
      const onABridge = authored.some((r) =>
        span.position.x >= r.minX && span.position.x <= r.maxX
        && span.position.z >= r.minZ && span.position.z <= r.maxZ);
      expect(onABridge, `${span.id} is not on a bridge rect`).toBe(true);
    }
  });

  it("a span is walkable ground until it is destroyed, and water afterwards", () => {
    const sim = staged();
    const span = sim.entities.find((e) => e.coverKind === "span")!;
    const at = { ...span.position };
    expect(pointInWater(at), "the crossing should be passable to begin with").toBe(false);

    const before = terrainBridges().length;
    expect(sim.dropBridgeAt(at)).toBeGreaterThanOrEqual(0);
    expect(terrainBridges().length, "the span was not removed from the terrain").toBe(before - 1);
    expect(pointInWater(at), "the gap left behind should block ground movement").toBe(true);
  });

  it("refuses to drop the same span twice, or empty water", () => {
    const sim = staged();
    const at = { ...sim.entities.find((e) => e.coverKind === "span")!.position };
    expect(sim.dropBridgeAt(at)).toBeGreaterThanOrEqual(0);
    expect(sim.dropBridgeAt(at), "dropped the same span twice").toBe(-1);
    expect(sim.dropBridgeAt({ x: 999, z: 999 }), "dropped a span that is not there").toBe(-1);
  });

  it("does not leave a unit standing in the gap", () => {
    // The span was walkable, so a unit can be standing ON it when it goes. Leaving it there puts a
    // ground unit in water, a state the movement rules say is unreachable.
    const sim = staged();
    const span = sim.entities.find((e) => e.coverKind === "span")!;
    const unit = sim.debugSpawn("soldier", "player", { ...span.position });
    expect(pointInWater(unit.position)).toBe(false);
    sim.dropBridgeAt({ ...span.position });
    expect(pointInWater(unit.position), "a trooper was left standing in the channel").toBe(false);
  });

  it("keeps the crossing gone across a save and reload", () => {
    // THE regression this file exists for. Terrain comes from the MapDef, so without persisting the
    // loss a reload silently rebuilds the bridge a player spent a turn destroying.
    const sim = staged();
    const at = { ...sim.entities.find((e) => e.coverKind === "span")!.position };
    sim.dropBridgeAt(at);
    expect(sim.bridgesDropped().length).toBe(1);

    const saved = sim.serialize();
    expect(JSON.parse(saved).droppedBridges).toHaveLength(1);

    const fresh = new TacticalSim();
    expect(fresh.restore(saved)).toBe(true);
    expect(fresh.bridgesDropped().length, "the drop did not survive the reload").toBe(1);
    expect(pointInWater(at), "the bridge came back after loading").toBe(true);
  });

  it("restores every crossing when a new battle is configured", () => {
    const sim = staged();
    sim.dropBridgeAt({ ...sim.entities.find((e) => e.coverKind === "span")!.position });
    const authored = (mapDef(BRIDGED).terrain.bridges ?? []).length;
    sim.configure(mapDef(BRIDGED), "destroy", "normal");
    expect(sim.bridgesDropped().length).toBe(0);
    expect(terrainBridges().length).toBe(authored);
  });

  it("drops the crossing when the span is actually shot down", () => {
    // End to end through the damage funnel rather than by calling dropBridgeAt directly.
    const sim = staged();
    const span = sim.entities.find((e) => e.coverKind === "span")!;
    const at = { ...span.position };
    const sapper = sim.debugSpawn("sapper", "player", { x: at.x - 3, z: at.z });
    for (const part of span.parts) part.hp = 1; // this test is about the consequence, not the grind
    sim.select(sapper.id);
    expect(sim.queueShoot(span.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(span.status.alive, "the span survived").toBe(false);
    expect(pointInWater(at), "the span died but the crossing remained").toBe(true);
  });
});
