import { describe, expect, it } from "vitest";
import { MAPS, mapSize } from "./maps";
import { TROOP_CATALOG, unitStats, type TroopKind } from "./units";
import { MOVE_RANGE_SCALE } from "./sim";

// SCALE COHERENCE.
//
// Movement distance, weapon range and accuracy falloff are three separate systems that currently
// agree only by accident. Map size is authored independently of all three, and scaleMapDef then
// enlarges every map at load. So a map can be made bigger without anything telling you that every
// unit just became slower and shorter-ranged relative to the board, and that every engagement
// slid into the accuracy-falloff tail. This measures the relationship and asserts it holds.
const walkers: readonly TroopKind[] = TROOP_CATALOG.map((s) => s.kind).filter((k) => unitStats(k).moveRange > 0);

const span = (map: (typeof MAPS)[number]): { width: number; depth: number; diagonal: number } => {
  const width = map.terrain.bounds.maxX - map.terrain.bounds.minX;
  const depth = map.terrain.bounds.maxZ - map.terrain.bounds.minZ;
  return { width, depth, diagonal: Math.hypot(width, depth) };
};

/** Turns for a unit to walk the long axis of a map, at full move orders. */
const turnsToCross = (kind: TroopKind, map: (typeof MAPS)[number]): number =>
  span(map).width / (unitStats(kind).moveRange * MOVE_RANGE_SCALE);

/**
 * Turns for a unit to reach the contested middle from its own base. This, not crossing the whole
 * map, is the number that decides whether a unit gets to participate: a siege gun is supposed to
 * shell from depth and will never walk the full width, but if it cannot reach midfield before the
 * fight is decided it is simply a unit you never build.
 */
const turnsToMidfield = (kind: TroopKind, map: (typeof MAPS)[number]): number =>
  (span(map).width / 2) / (unitStats(kind).moveRange * MOVE_RANGE_SCALE);

describe("map scale stays coherent with movement, range and accuracy", () => {
  it("reports the scale table", () => {
    // Not an assertion -- this prints the actual numbers so a balance change is a readable diff
    // rather than a guess. Run with `npx vitest run src/game/scale.test.ts` to read it.
    const rows = MAPS.map((map) => {
      const { width, depth } = span(map);
      const soldier = turnsToCross("soldier", map);
      const scout = turnsToCross("scout", map);
      const artillery = turnsToCross("artillery", map);
      return `${map.id.padEnd(11)} ${mapSize(map).padEnd(7)} ${width.toFixed(0)}x${depth.toFixed(0)}  cross: soldier ${soldier.toFixed(1)}t  scout ${scout.toFixed(1)}t  artillery ${artillery.toFixed(1)}t`;
    });
    console.log("\n" + rows.join("\n") + "\n");
    expect(rows.length).toBe(MAPS.length);
  });

  it("keeps every map crossable in a sane number of turns", () => {
    // The pacing knob. Too few turns and positioning is free; too many and the game is a commute.
    // Measured on the line infantry, which is the pace the player actually experiences.
    for (const map of MAPS) {
      const turns = turnsToCross("soldier", map);
      expect(turns, `${map.id}: infantry crosses in ${turns.toFixed(1)} turns`).toBeGreaterThan(1.5);
      expect(turns, `${map.id}: infantry crosses in ${turns.toFixed(1)} turns`).toBeLessThan(9);
    }
  });

  it("lets every unit reach the fight", () => {
    // The failure this catches is a unit that is technically buildable and practically useless.
    // Artillery at its original 3.6 move needed 14.5 turns to cross Causeway and 7.2 just to reach
    // the middle of it -- by which point the battle it was bought for is over.
    for (const map of MAPS) {
      for (const kind of walkers) {
        const turns = turnsToMidfield(kind, map);
        expect(turns, `${map.id}: ${kind} reaches midfield in ${turns.toFixed(1)} turns`).toBeLessThan(7);
      }
    }
  });

  it("keeps the fastest and slowest units within one band of each other", () => {
    // If the spread between a scout and a siege gun is too wide, one of them is playing a
    // different game: either the scout crosses the map in a turn or the artillery never arrives.
    for (const map of MAPS) {
      const times = walkers.map((k) => turnsToCross(k, map));
      const ratio = Math.max(...times) / Math.min(...times);
      expect(ratio, `${map.id}: slowest unit takes ${ratio.toFixed(1)}x the fastest`).toBeLessThan(6);
    }
  });

  it("never lets a weapon out-range the battlefield", () => {
    // A gun that reaches across the whole map removes positioning from the game entirely.
    for (const map of MAPS) {
      const { diagonal } = span(map);
      for (const kind of walkers) {
        const range = unitStats(kind).weaponRange;
        expect(range, `${map.id}: ${kind} range ${range} vs diagonal ${diagonal.toFixed(0)}`).toBeLessThan(diagonal * 0.85);
      }
    }
  });

  it("gives every unit an accurate band that is a real fraction of its own range", () => {
    // THE accuracy-coherence rule. spreadStart is authored in absolute metres while weaponRange
    // varies from 7.5 to 42, so without this the relationship is arbitrary: a unit can be pinpoint
    // everywhere it can shoot, or penalized everywhere it can shoot, purely by accident.
    for (const kind of walkers) {
      const s = unitStats(kind);
      const fraction = s.accurateFraction;
      expect(fraction, `${kind}: accurate to ${Math.round(fraction * 100)}% of its ${s.weaponRange}m range`).toBeGreaterThanOrEqual(0.3);
      expect(fraction, `${kind}: accurate to ${Math.round(fraction * 100)}% of its ${s.weaponRange}m range`).toBeLessThanOrEqual(0.95);
    }
  });

  it("keeps a unit's worst-case spread inside a usable cone", () => {
    // At its maximum range, a unit's total spread must still be able to hit something. Otherwise
    // its top end of range is a lie -- the shot is legal but never connects.
    for (const kind of walkers) {
      const s = unitStats(kind);
      const worst = s.spread + Math.max(0, s.weaponRange * (1 - s.accurateFraction)) * s.spreadPerMeter;
      expect(worst, `${kind}: ${worst.toFixed(1)} degree spread at max range`).toBeLessThan(12);
    }
  });
});
