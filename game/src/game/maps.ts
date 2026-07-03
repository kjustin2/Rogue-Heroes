import { Rng } from "../core/rng";
import { dist, type Vec2 } from "../core/math";
import { COVER_PROFILES, createCover, type CombatEntity, type CoverKind } from "./damageModel";
import { onTerrainEdge, terrainHeightAt, type TerrainSpec } from "./terrain";

// A drifting ambient particle bed that gives each map its own living atmosphere.
export type AmbientKind = "dust" | "embers" | "pollen" | "snow" | "ash";
export interface AmbientSpec {
  kind: AmbientKind;
  color: number;
  density?: number; // ~1 = the default particle count
}

export interface MapTheme {
  ground: number;
  groundAccent: number;
  grid: number;
  fog: number;
  fogDensity: number;
  playerLight: number;
  enemyLight: number;
  sky: number;
  ambient?: AmbientSpec;
}

// A scatter group authors a cohesive band of objects; positions are generated in the
// west half and mirrored east, guaranteeing a fair, non-clumped, varied layout.
export interface ScatterGroup {
  palette: CoverKind[];
  count: number; // objects per side (mirrored to the other half)
  spacing: number; // minimum gap between object edges
  minZ?: number;
  maxZ?: number;
  centerGap?: number; // keep this far off the centerline
}

export interface SignatureObject {
  kind: CoverKind;
  x: number;
  z: number;
  hp?: number;
  radius?: number;
  height?: number;
  mirror?: boolean; // also place a mirrored copy across the map center
}

// Dynamic battlefield events — opt-in per map, deterministic (seeded), telegraphed a turn ahead.
//  • sandstorm: a window of turns where accuracy drops and the fog thickens.
//  • barrage: off-map artillery shells a zone during the turn's resolve (hits both sides).
//  • collapse: cover inside a zone crumbles during the turn's resolve.
export type MapEventKind = "sandstorm" | "barrage" | "collapse" | "ionstorm";

export interface MapEventConfig {
  kind: MapEventKind;
  startTurn: number; // first turn it fires
  period?: number; // repeat every N turns (omit = one-shot)
  duration?: number; // turns it stays active — sandstorm only (default 1)
  zone?: { x: number; z: number; radius: number }; // affected area (barrage/collapse); omit = map center
  power?: number; // tuning knob (barrage shell damage); omit = sensible default
}

export interface MapDef {
  id: string;
  name: string;
  blurb: string;
  feel: string;
  seed: number;
  theme: MapTheme;
  terrain: TerrainSpec;
  playerBase: Vec2;
  enemyBase: Vec2;
  flagOffset: number; // flag sits this far in front of each base, toward center
  hill: Vec2;
  hillRadius: number;
  scatter: ScatterGroup[];
  signature?: SignatureObject[];
  events?: MapEventConfig[];
  // Capturable neutral field structures; mirror places a point-symmetric twin for fairness.
  neutrals?: Array<{ kind: "turret" | "depot"; x: number; z: number; mirror?: boolean }>;
}

export function mapCenter(map: MapDef): Vec2 {
  const b = map.terrain.bounds;
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
}

export function flagPositions(map: MapDef): { player: Vec2; enemy: Vec2 } {
  const center = mapCenter(map);
  return {
    player: stepToward(map.playerBase, center, map.flagOffset),
    enemy: stepToward(map.enemyBase, center, map.flagOffset),
  };
}

function stepToward(from: Vec2, to: Vec2, distance: number): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: from.x + (dx / len) * distance, z: from.z + (dz / len) * distance };
}

// Build the neutral cover/prop layout for a map. Deterministic per seed, symmetric, and
// spaced so objects never clump and always leave the bases, flags, and hill clear.
export function buildMapObjects(map: MapDef): CombatEntity[] {
  const rng = new Rng(map.seed);
  const bounds = map.terrain.bounds;
  const center = mapCenter(map);
  const flags = flagPositions(map);
  const placed: Array<{ x: number; z: number; r: number }> = [];
  const objects: CombatEntity[] = [];
  let seq = 0;

  const anchors: Array<{ p: Vec2; clear: number }> = [
    { p: map.playerBase, clear: 4.2 },
    { p: map.enemyBase, clear: 4.2 },
    { p: flags.player, clear: 2.4 },
    { p: flags.enemy, clear: 2.4 },
    { p: map.hill, clear: map.hillRadius + 1.6 },
  ];

  const blocked = (p: Vec2, r: number): boolean => {
    if (p.x < bounds.minX + 2 || p.x > bounds.maxX - 2 || p.z < bounds.minZ + 2 || p.z > bounds.maxZ - 2) return true;
    for (const a of anchors) {
      if (dist(p, a.p) < a.clear + r) return true;
    }
    for (const o of placed) {
      if (dist(p, o) < o.r + r) return true;
    }
    return steepHere(p);
  };

  const add = (kind: CoverKind, p: Vec2): void => {
    const profile = COVER_PROFILES[kind];
    const entity = createCover(`map-${map.id}-${++seq}`, profile.label, { x: p.x, z: p.z }, { coverKind: kind });
    objects.push(entity);
    placed.push({ x: p.x, z: p.z, r: profile.radius });
  };

  // Signature features first (explicit, optionally mirrored).
  for (const sig of map.signature ?? []) {
    const profile = COVER_PROFILES[sig.kind];
    const place = (x: number, z: number): void => {
      objects.push(
        createCover(`map-${map.id}-sig-${++seq}`, profile.label, { x, z }, {
          coverKind: sig.kind,
          hp: sig.hp,
          radius: sig.radius,
          height: sig.height,
        })
      );
      placed.push({ x, z, r: sig.radius ?? profile.radius });
    };
    place(sig.x, sig.z);
    if (sig.mirror && Math.abs(sig.x - center.x) > 0.3) place(2 * center.x - sig.x, 2 * center.z - sig.z);
  }

  // Scatter groups, generated in the west half and mirrored east for fairness.
  for (const group of map.scatter) {
    const gap = group.centerGap ?? 2.5;
    const minZ = group.minZ ?? bounds.minZ + 2.5;
    const maxZ = group.maxZ ?? bounds.maxZ - 2.5;
    let made = 0;
    let attempts = 0;
    const cap = group.count * 60;
    while (made < group.count && attempts < cap) {
      attempts += 1;
      const x = rng.range(bounds.minX + 2.5, center.x - gap);
      const z = rng.range(minZ, maxZ);
      const kind = group.palette[Math.floor(rng.range(0, group.palette.length)) % group.palette.length];
      const r = COVER_PROFILES[kind].radius + group.spacing;
      const west = { x, z };
      const east = { x: 2 * center.x - x, z: 2 * center.z - z };
      if (blocked(west, r) || blocked(east, r)) continue;
      add(kind, west);
      add(kind, east);
      made += 1;
    }
  }

  return objects;
}

// Reject spots straddling a block edge (cliff face) or on tall stacked tops, so props sit
// flush on flat ground or low ledges instead of floating or clipping into a vertical side.
function steepHere(p: Vec2): boolean {
  return onTerrainEdge(p, 0.7) || terrainHeightAt(p) > 1.2;
}

// ---------------------------------------------------------------------------
// The six battlefields. Each has its own size, terrain, palette, and character.
// ---------------------------------------------------------------------------

export const MAPS: readonly MapDef[] = [
  {
    id: "dustbowl",
    name: "Dust Bowl",
    blurb: "Sun-baked flats walled in by two towering rock ranges.",
    feel: "Open desert basin between great mountain ranges — long sightlines reward snipers and armor; climb the slopes for overwatch.",
    seed: 0x44555354,
    theme: { ground: 0x9c6f3e, groundAccent: 0xc79a5c, grid: 0xd6ad6d, fog: 0xd9b27a, fogDensity: 0.012, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0xe8c98f, ambient: { kind: "dust", color: 0xe6c98a, density: 1.1 } },
    terrain: {
      bounds: { minX: -30, maxX: 30, minZ: -19, maxZ: 19 },
      maxHeight: 3.6,
      blocks: [
        { minX: -4.5, maxX: 4.5, minZ: -4.5, maxZ: 4.5, height: 0.7 }, // central rise (the contested hill)
        { minX: -17, maxX: -9, minZ: 5, maxZ: 12, height: 0.85 },      // west mesa
        { minX: 9, maxX: 17, minZ: -12, maxZ: -5, height: 0.85 },      // east mesa (mirror)
        { minX: -22, maxX: -17, minZ: -13, maxZ: -7, height: 0.8 },    // west butte (lower step)
        { minX: -21, maxX: -18, minZ: -12, maxZ: -8, height: 1.6 },    // west butte (stacked = sniper perch)
        { minX: 17, maxX: 22, minZ: 7, maxZ: 13, height: 0.8 },        // east butte (lower step)
        { minX: 18, maxX: 21, minZ: 8, maxZ: 12, height: 1.6 },        // east butte (stacked)
        // North range — a big stepped massif walling off the basin (climbable 0.85 steps).
        { minX: -8, maxX: 8, minZ: 12, maxZ: 19, height: 0.85 },       // north range — foothill
        { minX: -6, maxX: 6, minZ: 13, maxZ: 18, height: 1.7 },        // north range — mid slope
        { minX: -4, maxX: 4, minZ: 14, maxZ: 17.5, height: 2.55 },     // north range — upper
        { minX: -2, maxX: 2, minZ: 15, maxZ: 17, height: 3.4 },        // north range — peak
        // South range — the mirrored massif across the basin.
        { minX: -8, maxX: 8, minZ: -19, maxZ: -12, height: 0.85 },     // south range — foothill
        { minX: -6, maxX: 6, minZ: -18, maxZ: -13, height: 1.7 },      // south range — mid slope
        { minX: -4, maxX: 4, minZ: -17.5, maxZ: -14, height: 2.55 },   // south range — upper
        { minX: -2, maxX: 2, minZ: -17, maxZ: -15, height: 3.4 },      // south range — peak
      ],
    },
    playerBase: { x: -25, z: 0 },
    enemyBase: { x: 25, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 4.2,
    scatter: [
      { palette: ["rock", "rock", "sandbag", "barricade"], count: 7, spacing: 2.4, centerGap: 3 },
      { palette: ["fuel", "ammo"], count: 3, spacing: 3.0, centerGap: 5 },
    ],
    signature: [
      { kind: "rock", x: -6, z: 4, mirror: true, radius: 1.3, height: 1.6 },
      { kind: "sandbag", x: -3.2, z: -2.4, mirror: true },
      { kind: "fuel", x: -12, z: 3, mirror: true },
      { kind: "ammo", x: -11.5, z: -3, mirror: true },
      { kind: "rock", x: -8, z: -10, mirror: true, radius: 1.1 },
      { kind: "barricade", x: -2, z: 7, mirror: true },
    ],
    // Recurring sandstorms sweep the open basin — accuracy and visibility drop in waves.
    events: [{ kind: "sandstorm", startTurn: 3, duration: 2, period: 6 }],
    // Twin supply depots on the flanks: hold them for extra income.
    neutrals: [{ kind: "depot", x: -13, z: 8, mirror: true }],
  },
  {
    id: "ironworks",
    name: "Ironworks",
    blurb: "A cramped foundry of steel and shipping crates.",
    feel: "Tight industrial maze — dense cover and chokepoints favor infantry brawls.",
    seed: 0x49524f4e,
    theme: { ground: 0x3a3f47, groundAccent: 0x586170, grid: 0x6f7c8c, fog: 0x2b3038, fogDensity: 0.02, playerLight: 0x5fd7ff, enemyLight: 0xff6d57, sky: 0x394150, ambient: { kind: "embers", color: 0xff9a4a, density: 0.85 } },
    terrain: {
      bounds: { minX: -24, maxX: 24, minZ: -15, maxZ: 15 },
      maxHeight: 1.3,
      blocks: [
        { minX: -3.5, maxX: 3.5, minZ: -3.5, maxZ: 3.5, height: 0.6 }, // central gantry platform
        { minX: -13, maxX: -7, minZ: 4, maxZ: 9, height: 0.7 },        // west catwalk
        { minX: 7, maxX: 13, minZ: -9, maxZ: -4, height: 0.7 },        // east catwalk (mirror)
        // The overpass: an elevated causeway spanning the center lane. Walk up a ramp
        // (each step <= TERRAIN_STEP), hold the span, and shoot down into both lanes.
        { minX: -10, maxX: -8, minZ: -1.3, maxZ: 1.3, height: 0.65 },  // west ramp
        { minX: 8, maxX: 10, minZ: -1.3, maxZ: 1.3, height: 0.65 },    // east ramp
        { minX: -8, maxX: 8, minZ: -1.3, maxZ: 1.3, height: 1.25 },    // causeway deck
      ],
    },
    playerBase: { x: -20, z: 0 },
    enemyBase: { x: 20, z: 0 },
    flagOffset: 3.2,
    hill: { x: 0, z: 0 },
    hillRadius: 3.4,
    scatter: [
      { palette: ["crate", "crate", "rubble", "wall"], count: 9, spacing: 1.4, centerGap: 2.2 },
      { palette: ["pillar", "pillar", "conduit", "fuel", "ammo"], count: 7, spacing: 1.8, centerGap: 3 },
    ],
    signature: [
      { kind: "wall", x: -2.2, z: 4.5, mirror: true },
      { kind: "wall", x: -2.2, z: 6.5, mirror: true },
      { kind: "wall", x: -4.4, z: -5.5, mirror: true },
      { kind: "crate", x: -6, z: 0, mirror: true },
      { kind: "crate", x: -5, z: -2.6, mirror: true },
      { kind: "conduit", x: -9.5, z: 1.5, mirror: true },
      { kind: "pillar", x: -11, z: -2.2, mirror: true },
      { kind: "fuel", x: -8, z: 11, mirror: true },
    ],
    // Overstressed gantries give way: cover around the central platform crumbles periodically.
    events: [{ kind: "collapse", startTurn: 5, period: 5, zone: { x: 0, z: 0, radius: 7 } }],
    // Derelict foundry turrets guard the catwalk flanks — first squad to reach one owns it.
    neutrals: [{ kind: "turret", x: -10, z: -6.5, mirror: true }],
  },
  {
    id: "verdant",
    name: "Verdant Pass",
    blurb: "A green valley walled by forested mountains around a central hill.",
    feel: "Towering wooded mountain flanks and a true high-ground center — hold the hill, watch the slopes.",
    seed: 0x56455244,
    theme: { ground: 0x4a6b34, groundAccent: 0x6f8f4a, grid: 0x86a85f, fog: 0xa8c6a0, fogDensity: 0.011, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0xbcd6b0, ambient: { kind: "pollen", color: 0xd8f0a0, density: 1 } },
    terrain: {
      bounds: { minX: -28, maxX: 28, minZ: -19, maxZ: 19 },
      maxHeight: 3.6,
      blocks: [
        { minX: -5.5, maxX: 5.5, minZ: -5, maxZ: 5, height: 0.8 },     // hill base (climbable lower step)
        { minX: -3.4, maxX: 3.4, minZ: -3.2, maxZ: 3.2, height: 1.6 }, // commanding hilltop (stacked)
        { minX: -19, maxX: -12, minZ: -13, maxZ: -7, height: 0.7 },    // west wooded knoll
        { minX: 12, maxX: 19, minZ: 7, maxZ: 13, height: 0.7 },        // east wooded knoll (mirror)
        // North mountain — a tall forested massif closing off the valley (climbable 0.85 steps).
        { minX: -9, maxX: 9, minZ: 11, maxZ: 19, height: 0.85 },       // north mountain — foothill
        { minX: -7, maxX: 7, minZ: 12, maxZ: 18, height: 1.7 },        // north mountain — mid slope
        { minX: -5, maxX: 5, minZ: 13, maxZ: 17.5, height: 2.55 },     // north mountain — upper
        { minX: -3, maxX: 3, minZ: 14, maxZ: 17, height: 3.4 },        // north mountain — peak
        // South mountain — the mirrored massif closing the far side of the valley.
        { minX: -9, maxX: 9, minZ: -19, maxZ: -11, height: 0.85 },     // south mountain — foothill
        { minX: -7, maxX: 7, minZ: -18, maxZ: -12, height: 1.7 },      // south mountain — mid slope
        { minX: -5, maxX: 5, minZ: -17.5, maxZ: -13, height: 2.55 },   // south mountain — upper
        { minX: -3, maxX: 3, minZ: -17, maxZ: -14, height: 3.4 },      // south mountain — peak
      ],
    },
    playerBase: { x: -24, z: 0 },
    enemyBase: { x: 24, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 5.0,
    scatter: [
      { palette: ["tree", "tree", "rock"], count: 10, spacing: 1.6, centerGap: 6 },
      { palette: ["sandbag", "rubble"], count: 3, spacing: 2.4, centerGap: 7 },
    ],
    signature: [
      { kind: "rock", x: -4.5, z: 4, mirror: true, radius: 1.1 },
      { kind: "tree", x: -7, z: -3, mirror: true },
      { kind: "tree", x: -10, z: 6, mirror: true },
      { kind: "tree", x: -8.5, z: -7.5, mirror: true },
      { kind: "rock", x: -15, z: -3, mirror: true },
      { kind: "tree", x: -21, z: 4, mirror: true },
    ],
  },
  {
    id: "causeway",
    name: "Frozen Causeway",
    blurb: "A narrow land bridge between frozen basins.",
    feel: "Linear and funneled — a single icy causeway forces brutal head-on fights.",
    seed: 0x46524f5a,
    theme: { ground: 0xa9c2d6, groundAccent: 0xd6e6f0, grid: 0xbfd6e6, fog: 0xcfe0ec, fogDensity: 0.016, playerLight: 0x7fd7ff, enemyLight: 0xff8f7f, sky: 0xdcebf4, ambient: { kind: "snow", color: 0xeaf4ff, density: 1.2 } },
    terrain: {
      bounds: { minX: -32, maxX: 32, minZ: -16, maxZ: 16 },
      maxHeight: 1.4,
      // A raised central causeway funnels the fight; bases sit on the flat outer ground.
      blocks: [
        { minX: -18, maxX: 18, minZ: -5, maxZ: 5, height: 0.5 },   // central land bridge
        { minX: -3, maxX: 3, minZ: -3, maxZ: 3, height: 1.0 },     // contested high point
      ],
    },
    playerBase: { x: -28, z: 0 },
    enemyBase: { x: 28, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 3.6,
    scatter: [
      { palette: ["rubble", "rock", "wall"], count: 5, spacing: 1.6, minZ: -6, maxZ: 6, centerGap: 2.5 },
      { palette: ["crate", "sandbag"], count: 2, spacing: 1.8, minZ: -5, maxZ: 5, centerGap: 3 },
    ],
    signature: [
      { kind: "wall", x: -3, z: 0, mirror: true },
      { kind: "rubble", x: -7, z: 2.6, mirror: true },
      { kind: "rubble", x: -7, z: -2.6, mirror: true },
      { kind: "crate", x: -10.5, z: 2.8, mirror: true },
      { kind: "sandbag", x: -12, z: -1, mirror: true },
      { kind: "rock", x: -15, z: 1.5, mirror: true },
    ],
    // Ion storms rake the exposed causeway, scrambling command links (units lose command points).
    events: [{ kind: "ionstorm", startTurn: 3, duration: 1, period: 4 }],
  },
  {
    id: "karak",
    name: "Ruins of Karak",
    blurb: "Toppled colonnades over stepped stone mesas.",
    feel: "Vertical ruins — climb the mesas and fight among broken pillars and cliffs.",
    seed: 0x4b415241,
    theme: { ground: 0x8a6a3c, groundAccent: 0xb08a4e, grid: 0xc6a567, fog: 0xc7a877, fogDensity: 0.013, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0xd8bd8c, ambient: { kind: "ash", color: 0xcbb083, density: 0.9 } },
    terrain: {
      bounds: { minX: -26, maxX: 26, minZ: -18, maxZ: 18 },
      maxHeight: 2.1,
      blocks: [
        { minX: -4, maxX: 4, minZ: -3.5, maxZ: 3.5, height: 0.8 },   // central dais (lower step)
        { minX: -3, maxX: 3, minZ: -2.5, maxZ: 2.5, height: 1.5 },   // toppled altar (stacked)
        { minX: -22, maxX: -12, minZ: 6, maxZ: 14, height: 0.8 },    // NW stone mesa (lower)
        { minX: -20, maxX: -14, minZ: 8, maxZ: 13, height: 1.6 },    // NW stone mesa (upper)
        { minX: 12, maxX: 22, minZ: -14, maxZ: -6, height: 0.8 },    // SE stone mesa (lower, mirror)
        { minX: 14, maxX: 20, minZ: -13, maxZ: -8, height: 1.6 },    // SE stone mesa (upper)
      ],
    },
    playerBase: { x: -22, z: 0 },
    enemyBase: { x: 22, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 3.2,
    scatter: [
      { palette: ["pillar", "rubble", "rock"], count: 8, spacing: 1.8, centerGap: 4 },
      { palette: ["wall", "cliff"], count: 3, spacing: 2.6, centerGap: 6 },
    ],
    signature: [
      { kind: "pillar", x: -5.5, z: 4.5, mirror: true },
      { kind: "pillar", x: -5.5, z: -4.5, mirror: true },
      { kind: "cliff", x: -9, z: 0, mirror: true },
      { kind: "rubble", x: -8, z: 7, mirror: true },
      { kind: "pillar", x: -10.5, z: -8.5, mirror: true },
      { kind: "rock", x: -16, z: 2.5, mirror: true },
    ],
    // The ancient colonnades give way: cover near the central dais collapses every few turns.
    events: [{ kind: "collapse", startTurn: 4, period: 4, zone: { x: 0, z: 0, radius: 9 } }],
  },
  {
    id: "crossfire",
    name: "Crossfire Basin",
    blurb: "A symmetric bowl built for honest, balanced duels.",
    feel: "Balanced competitive arena — mirrored cover nests and a sunken central basin.",
    seed: 0x43524f53,
    theme: { ground: 0x5a6348, groundAccent: 0x7c8760, grid: 0x97a277, fog: 0x9fb091, fogDensity: 0.012, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0xb6c4a6, ambient: { kind: "pollen", color: 0xc6d8a8, density: 0.7 } },
    terrain: {
      bounds: { minX: -26, maxX: 26, minZ: -17, maxZ: 17 },
      maxHeight: 1.6,
      blocks: [
        { minX: -3, maxX: 3, minZ: -3, maxZ: 3, height: 0.9 },          // central platform
        { minX: -16, maxX: -11, minZ: -11, maxZ: -6, height: 0.7 },     // SW nest
        { minX: 11, maxX: 16, minZ: 6, maxZ: 11, height: 0.7 },         // NE nest (mirror)
        { minX: 11, maxX: 16, minZ: -11, maxZ: -6, height: 0.7 },       // SE nest
        { minX: -16, maxX: -11, minZ: 6, maxZ: 11, height: 0.7 },       // NW nest
      ],
    },
    playerBase: { x: -22, z: 0 },
    enemyBase: { x: 22, z: 0 },
    flagOffset: 3.2,
    hill: { x: 0, z: 0 },
    hillRadius: 3.8,
    scatter: [
      { palette: ["sandbag", "crate", "barricade"], count: 7, spacing: 2.0, centerGap: 3 },
      { palette: ["ammo", "fuel"], count: 2, spacing: 3.0, centerGap: 5 },
    ],
    signature: [
      { kind: "sandbag", x: -9, z: 3.5, mirror: true },
      { kind: "sandbag", x: -9, z: -3.5, mirror: true },
      { kind: "crate", x: -5, z: 0, mirror: true },
      { kind: "barricade", x: -7, z: 0, mirror: true },
      { kind: "ammo", x: -12.5, z: 3.5, mirror: true },
      { kind: "fuel", x: -8.5, z: 8, mirror: true },
    ],
    // Off-map artillery ranges in on the central basin on a steady cadence — don't loiter there.
    events: [{ kind: "barrage", startTurn: 3, period: 4, zone: { x: 0, z: 0, radius: 6 }, power: 34 }],
  },
];

export function mapDef(id: string): MapDef {
  return MAPS.find((map) => map.id === id) ?? MAPS[0];
}
