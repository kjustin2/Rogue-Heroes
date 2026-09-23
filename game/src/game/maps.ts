import { Rng } from "../core/rng";
import { dist, type Vec2 } from "../core/math";
import { COVER_PROFILES, createCover, type CombatEntity, type CoverKind } from "./damageModel";
import { onTerrainEdge, pointInWater, terrainHeightAt, type TerrainRect, type TerrainSpec } from "./terrain";

// A drifting ambient particle bed that gives each map its own living atmosphere.
export type AmbientKind = "dust" | "embers" | "pollen" | "snow" | "ash";
export interface AmbientSpec {
  kind: AmbientKind;
  color: number;
  density?: number; // ~1 = the default particle count
}

/**
 * The character of the ground itself, not just its colour. Every map used to share one texture
 * generator with a different tint, which is most of why they read as the same battlefield in five
 * palettes. This picks WHAT is drawn: cracks, tufts, clinker, flagstones or fractures.
 */
export type GroundSurfaceKind = "cracked" | "grass" | "slag" | "paved" | "ice";

// The horizon silhouette behind the board: cheap flat-shaded shapes in makeSurroundings, one
// family per map so the distance tells the same story as the ground.
export type SkylineKind = "mountains" | "stacks" | "forest" | "floes" | "ziggurats" | "fences";

export interface MapTheme {
  ground: number;
  skyline?: SkylineKind;
  surface?: GroundSurfaceKind;
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
//
// A SECTION is a group with a `rect`: the objects of one named place on the map (an orchard, a
// rail yard, a fishing village) confined to that place rather than sprinkled across the board.
// A `grid` lays the section out on a lattice — an orchard is rows of trees, a rail yard is lines
// of cars — with a little jitter so it reads as planted, not stamped.
export interface ScatterGroup {
  palette: CoverKind[];
  count: number; // objects per side (mirrored to the other half)
  spacing: number; // minimum gap between object edges
  minZ?: number;
  maxZ?: number;
  centerGap?: number; // keep this far off the centerline
  /** Section bounds in authored (west-half) coordinates; the mirror lands on the east. */
  rect?: TerrainRect;
  /** Lattice layout: cell size in world units (object size, so it is NOT scaled with the map) + jitter. */
  grid?: { dx: number; dz: number; jitter?: number };
}

export interface SignatureObject {
  kind: CoverKind;
  x: number;
  z: number;
  hp?: number;
  radius?: number;
  height?: number;
  mirror?: boolean; // also place a mirrored copy across the map center
  /** Facing in radians (landmarks are placed, not spun); the mirror copy faces the opposite way. */
  yaw?: number;
}

// Dynamic battlefield events — opt-in per map, deterministic (seeded), telegraphed a turn ahead.
//  • sandstorm: a window of turns where accuracy drops and the fog thickens.
//  • barrage: off-map artillery shells a zone during the turn's resolve (hits both sides).
//  • collapse: cover inside a zone crumbles during the turn's resolve.
// "lightning": a storm that strikes ONE telegraphed point per turn, somewhere new each turn.
export type MapEventKind = "sandstorm" | "barrage" | "collapse" | "ionstorm" | "lightning" | "slag";

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
  // Size tier — stamped by scaleMapDef from the authored (pre-scale) area so mapSize() stays
  // correct after every map is enlarged. Authored literals omit it.
  size?: MapSize;
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

export type MapSize = "small" | "medium" | "large";

// Size tier from playable area, so the map-select screen can group Small/Medium/Large. Every map is
// enlarged at load (see scaleMapDef), so the tier is stamped from the authored area onto `size`.
function tierFromArea(bounds: TerrainSpec["bounds"]): MapSize {
  const area = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);
  return area < 1650 ? "small" : area < 2500 ? "medium" : "large";
}

export function mapSize(map: MapDef): MapSize {
  return map.size ?? tierFromArea(map.terrain.bounds);
}

// Every battlefield is enlarged at load so the whole roster plays bigger — large maps ~2× area,
// medium ~1.5×, small ~1.3× (linear factors below). Object SIZES and terrain HEIGHTS stay fixed;
// only positions/extents scale, and scatter counts grow with area so bigger maps aren't sparse.
const SCALE_BY_SIZE: Record<MapSize, number> = { small: 1.14, medium: 1.22, large: 1.41 };

function scaleRect<T extends { minX: number; maxX: number; minZ: number; maxZ: number }>(r: T, f: number): T {
  return { ...r, minX: r.minX * f, maxX: r.maxX * f, minZ: r.minZ * f, maxZ: r.maxZ * f };
}

// Pure: return an enlarged copy of an authored map. Stamps the pre-scale size tier onto `size`.
function scaleMapDef(def: MapDef): MapDef {
  const size = tierFromArea(def.terrain.bounds);
  const f = SCALE_BY_SIZE[size];
  const t = def.terrain;
  return {
    ...def,
    size,
    terrain: {
      ...t,
      bounds: scaleRect(t.bounds, f),
      blocks: t.blocks?.map((b) => ({ ...scaleRect(b, f), height: b.height })), // footprints scale, height fixed
      water: t.water?.map((r) => scaleRect(r, f)),
      bridges: t.bridges?.map((r) => scaleRect(r, f)),
    },
    playerBase: { x: def.playerBase.x * f, z: def.playerBase.z * f },
    enemyBase: { x: def.enemyBase.x * f, z: def.enemyBase.z * f },
    flagOffset: def.flagOffset * f,
    hill: { x: def.hill.x * f, z: def.hill.z * f },
    hillRadius: def.hillRadius * f,
    // Same object sizes/gaps, but more of them so the bigger arena keeps its density.
    scatter: def.scatter.map((g) => ({
      ...g,
      count: Math.round(g.count * f * f),
      centerGap: g.centerGap === undefined ? undefined : g.centerGap * f,
      minZ: g.minZ === undefined ? undefined : g.minZ * f,
      maxZ: g.maxZ === undefined ? undefined : g.maxZ * f,
      rect: g.rect ? scaleRect(g.rect, f) : undefined, // the section grows; its lattice cell does not
    })),
    signature: def.signature?.map((s) => ({ ...s, x: s.x * f, z: s.z * f })), // positions scale, object size fixed
    neutrals: def.neutrals?.map((n) => ({ ...n, x: n.x * f, z: n.z * f })),
    events: def.events?.map((e) => (e.zone ? { ...e, zone: { x: e.zone.x * f, z: e.zone.z * f, radius: e.zone.radius * f } } : e)),
  };
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
    // Never into a water channel, and never ONTO A CROSSING. Bridges are not water -- they are the
    // walkable strip over it -- so scatter happily dropped crates on them, which both collided with
    // the destructible span entity now sitting there and blocked the chokepoint the bridge exists to
    // create. A crossing should be an open lane, contested by units rather than furniture.
    if (steepHere(p) || pointInWater(p)) return true;
    return (map.terrain.bridges ?? []).some((b) =>
      p.x >= b.minX - r && p.x <= b.maxX + r && p.z >= b.minZ - r && p.z <= b.maxZ + r);
  };

  const add = (kind: CoverKind, p: Vec2): void => {
    const profile = COVER_PROFILES[kind];
    const entity = createCover(`map-${map.id}-${++seq}`, profile.label, { x: p.x, z: p.z }, { coverKind: kind });
    objects.push(entity);
    placed.push({ x: p.x, z: p.z, r: profile.radius });
  };

  // Capturable neutrals (depots, derelict turrets) are placed by scenario.ts AFTER this runs, so
  // reserve their footprints first: scatter used to drop an ammo cache into a supply depot whenever
  // the palette changed and the rng sequence shifted with it.
  for (const n of map.neutrals ?? []) {
    const r = n.kind === "depot" ? COVER_PROFILES.depot.radius : 1.3;
    placed.push({ x: n.x, z: n.z, r });
    if (n.mirror) placed.push({ x: -n.x, z: -n.z, r });
  }

  // Signature features first (explicit, optionally mirrored).
  for (const sig of map.signature ?? []) {
    const profile = COVER_PROFILES[sig.kind];
    const place = (x: number, z: number, yaw: number): void => {
      const entity = createCover(`map-${map.id}-sig-${++seq}`, profile.label, { x, z }, {
        coverKind: sig.kind,
        hp: sig.hp,
        radius: sig.radius,
        height: sig.height,
      });
      entity.yaw = yaw;
      objects.push(entity);
      placed.push({ x, z, r: sig.radius ?? profile.radius });
    };
    // An authored spot that lands on a block edge after map scaling is nudged to the nearest flat
    // ground, so the prop never straddles a step (half floating, half buried); the mirror copies
    // the nudged point so the layout stays symmetric.
    const at = nudgeOffEdge({ x: sig.x, z: sig.z }, sig.radius ?? profile.radius, map.terrain.bridges ?? []);
    place(at.x, at.z, sig.yaw ?? 0);
    if (sig.mirror && Math.abs(sig.x - center.x) > 0.3) place(2 * center.x - at.x, 2 * center.z - at.z, (sig.yaw ?? 0) + Math.PI);
  }

  // Scatter groups, generated in the west half and mirrored east for fairness. A section (rect)
  // confines the group to its place; a grid lays it on a lattice, row by row, deterministically.
  for (const group of map.scatter) {
    const gap = group.centerGap ?? 2.5;
    const minZ = group.rect?.minZ ?? group.minZ ?? bounds.minZ + 2.5;
    const maxZ = group.rect?.maxZ ?? group.maxZ ?? bounds.maxZ - 2.5;
    const minX = group.rect?.minX ?? bounds.minX + 2.5;
    const maxX = Math.min(group.rect?.maxX ?? center.x - gap, center.x - gap);
    let made = 0;
    // The palette is dealt like a DECK (shuffled, every entry once, then reshuffled) and a kind
    // that does not fit KEEPS its turn for the next spot, rather than a fresh kind being drawn per
    // attempt. Per-attempt draws were rejection sampling that favoured whatever was smallest: the
    // Ironworks foundry floor listed pipes, silos, fuel and crates and came out as twelve gas
    // bottles, and half of every palette never appeared on its map at all.
    let deck: CoverKind[] = [];
    const deal = (): CoverKind => {
      if (!deck.length) {
        deck = [...group.palette];
        for (let i = deck.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rng.range(0, i + 1)) % (i + 1);
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
      }
      return deck.pop() as CoverKind;
    };
    let kind = deal();
    let misses = 0;
    const tryPlace = (x: number, z: number): boolean => {
      const r = COVER_PROFILES[kind].radius + group.spacing;
      const west = { x, z };
      const east = { x: 2 * center.x - x, z: 2 * center.z - z };
      if (blocked(west, r) || blocked(east, r)) {
        // A kind that has had a fair chance and still does not fit (a silo in a crowded yard)
        // yields to the next card, so one big prop can never starve the rest of the section.
        misses += 1;
        if (misses > MISSES_PER_KIND) { kind = deal(); misses = 0; }
        return false;
      }
      add(kind, west);
      add(kind, east);
      made += 1;
      kind = deal();
      misses = 0;
      return true;
    };
    if (group.grid) {
      const { dx, dz } = group.grid;
      const jitter = group.grid.jitter ?? 0;
      const cols = Math.max(1, Math.floor((maxX - minX) / dx));
      const rows = Math.max(1, Math.floor((maxZ - minZ) / dz));
      const x0 = minX + ((maxX - minX) - (cols - 1) * dx) / 2;
      const z0 = minZ + ((maxZ - minZ) - (rows - 1) * dz) / 2;
      for (let row = 0; row < rows && made < group.count; row += 1) {
        for (let col = 0; col < cols && made < group.count; col += 1) {
          tryPlace(x0 + col * dx + rng.range(-jitter, jitter), z0 + row * dz + rng.range(-jitter, jitter));
        }
      }
      continue;
    }
    let attempts = 0;
    const cap = group.count * 160; // crowded maps (Ironworks) need the retries now that neutrals are reserved
    while (made < group.count && attempts < cap) {
      attempts += 1;
      tryPlace(rng.range(minX, maxX), rng.range(minZ, maxZ));
    }
  }

  return objects;
}

// How many spots a dealt kind may try before it yields its turn (see `deal` in buildMapObjects).
const MISSES_PER_KIND = 48;

// Slide a point to the nearest spot whose footprint sits on one level (spiral search, 0.5m rings).
function nudgeOffEdge(p: Vec2, r: number, bridges: TerrainRect[] = []): Vec2 {
  const margin = Math.min(0.7, r * 0.8);
  // A crossing is an open lane: nothing may sit on a bridge or lean over its mouth.
  const onBridge = (q: Vec2): boolean => bridges.some((b) => q.x >= b.minX - r && q.x <= b.maxX + r && q.z >= b.minZ - r && q.z <= b.maxZ + r);
  const bad = (q: Vec2): boolean => onTerrainEdge(q, margin) || pointInWater(q) || onBridge(q);
  if (!bad(p)) return p;
  for (let ring = 0.5; ring <= 4; ring += 0.5) {
    for (let i = 0; i < 12; i += 1) {
      const a = (Math.PI * 2 * i) / 12;
      const q = { x: p.x + Math.cos(a) * ring, z: p.z + Math.sin(a) * ring };
      if (!bad(q)) return q;
    }
  }
  return p;
}

// Reject spots straddling a block edge (cliff face) or on tall stacked tops, so props sit
// flush on flat ground or low ledges instead of floating or clipping into a vertical side.
function steepHere(p: Vec2): boolean {
  return onTerrainEdge(p, 0.7) || terrainHeightAt(p) > 1.2;
}

// ---------------------------------------------------------------------------
// The six battlefields. Each has its own size, terrain, palette, and character.
// ---------------------------------------------------------------------------

const RAW_MAPS: readonly MapDef[] = [
  // DUST BOWL — a dead supply road across a desert basin. Sections: the DRY RIVER BED (the centre
  // lane, sunk between two low banks, where the convoy died — its wrecked trucks are the landmark
  // and the only hard cover on the straight shot), the CANYON PASSES (a walled corridor along each
  // long edge, the flank route: one lane wide, no sightline into the basin, a chokepoint at each
  // mouth), and the PLATEAU OUTPOSTS (each side's mesa, with a derrick landmark and a tent camp:
  // the overwatch position over the river bed). The buttes stay as sniper perches. Long armour
  // lanes down the river, infantry through the canyons, and the mesas decide who sees whom.
  {
    id: "dustbowl",
    name: "Dust Bowl",
    blurb: "A dead supply road through a desert basin, walled by canyons.",
    feel: "Armour down the dry river bed, infantry through the canyon passes; the plateau derricks watch it all.",
    seed: 0x44555354,
    theme: { ground: 0x7a5530, skyline: "mountains", surface: "cracked", groundAccent: 0xd9a05a, grid: 0xd6ad6d, fog: 0x8fa6b8, fogDensity: 0.009, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0x7fa8c9, ambient: { kind: "dust", color: 0xe6c98a, density: 1.1 } },
    terrain: {
      bounds: { minX: -35, maxX: 35, minZ: -22, maxZ: 22 }, // LARGE: wide basin, long armor/sniper lanes
      maxHeight: 3.6,
      blocks: [
        { minX: -4.5, maxX: 4.5, minZ: -4.5, maxZ: 4.5, height: 0.7 }, // central rise (the contested hill)
        // The dry river bed: low banks either side of the centre lane (a step, not a wall). They
        // stop short of each base so a gun parked at home still has the whole bed as a firing lane.
        { minX: -21, maxX: -6.5, minZ: 3.6, maxZ: 5.2, height: 0.5 },   // west bed, north bank
        { minX: -21, maxX: -6.5, minZ: -5.2, maxZ: -3.6, height: 0.5 }, // west bed, south bank
        { minX: 6.5, maxX: 21, minZ: 3.6, maxZ: 5.2, height: 0.5 },     // east bed, north bank
        { minX: 6.5, maxX: 21, minZ: -5.2, maxZ: -3.6, height: 0.5 },   // east bed, south bank
        // Plateau outposts (climbable mesas that overlook the river bed).
        { minX: -17, maxX: -9, minZ: 5.5, maxZ: 12, height: 0.85 },    // west plateau
        { minX: 9, maxX: 17, minZ: -12, maxZ: -5.5, height: 0.85 },    // east plateau (mirror)
        { minX: -22, maxX: -17, minZ: -13, maxZ: -7, height: 0.8 },    // west butte (lower step)
        { minX: -21, maxX: -18, minZ: -12, maxZ: -8, height: 1.6 },    // west butte (stacked = sniper perch)
        { minX: 17, maxX: 22, minZ: 7, maxZ: 13, height: 0.8 },        // east butte (lower step)
        { minX: 18, maxX: 21, minZ: 8, maxZ: 12, height: 1.6 },        // east butte (stacked)
        // The canyon passes: sheer sandstone walls (unclimbable) with a one-lane corridor between,
        // open at both ends and through one gap in the inner wall at the middle.
        // The inner walls are SHORT buttresses, not a second range: a full-length pair sheltered
        // the whole flank and took the basin's firing lanes with it (balance self-play: the
        // artillery row halved on this map).
        { minX: -13, maxX: 13, minZ: 18.5, maxZ: 22, height: 2.4 },    // north canyon, outer wall
        { minX: -12, maxX: -6.5, minZ: 12.5, maxZ: 15, height: 2.4 },  // north canyon, buttress (west)
        { minX: 6.5, maxX: 12, minZ: 12.5, maxZ: 15, height: 2.4 },    // north canyon, buttress (east)
        { minX: -13, maxX: 13, minZ: -22, maxZ: -18.5, height: 2.4 },  // south canyon, outer wall
        { minX: -12, maxX: -6.5, minZ: -15, maxZ: -12.5, height: 2.4 }, // south canyon, buttress (west)
        { minX: 6.5, maxX: 12, minZ: -15, maxZ: -12.5, height: 2.4 },  // south canyon, buttress (east)
        // Spires off the river bed: they break the long straight shot without closing the lane.
        { minX: -14, maxX: -12, minZ: -10.5, maxZ: -8, height: 2.4 },   // west spire (short: a long one walled the basin)
        { minX: 12, maxX: 14, minZ: 8, maxZ: 10.5, height: 2.4 },       // east spire (mirror)
      ],
    },
    playerBase: { x: -31, z: 0 },
    enemyBase: { x: 31, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 4.2,
    scatter: [
      // The river bed: what fell off the convoy.
      { palette: ["wreck", "crate", "fuel", "ammo", "barricade", "sandbag"], count: 3, spacing: 1.2, rect: { minX: -25, maxX: -16, minZ: -3.2, maxZ: 3.2 } },
      // The plateau camp around the derrick.
      // The derrick's crew camp: tents, a guard post, stores.
      { palette: ["tent", "tent", "sandbag", "ammo", "crate"], count: 4, spacing: 1.0, rect: { minX: -16.4, maxX: -9.6, minZ: 6.2, maxZ: 11.4 } },
      // Scrub at the canyon mouths and across the open basin: saguaro, boulders, a bleached carcass.
      { palette: ["rock", "cactus", "cactus", "bones", "rubble"], count: 3, spacing: 1.5, rect: { minX: -31, maxX: -14, minZ: 12, maxZ: 20 } },
      { palette: ["rock", "cactus", "bones", "cactus", "rock"], count: 3, spacing: 1.5, rect: { minX: -31, maxX: -12, minZ: -12, maxZ: -6 } },
    ],
    signature: [
      // The dead convoy, strung along the river bed where it was caught in the open.
      { kind: "convoy", x: -15.5, z: 2.9, yaw: 0.18, mirror: true },
      { kind: "convoy", x: -6.5, z: -2.9, yaw: -0.35, mirror: true },
      { kind: "derrick", x: -13, z: 8.6, yaw: 0.4, mirror: true },
      // The oil camp: the derrick's storage tank and the pipe run that fed it, placed before the
      // camp scatter so the tents fill in round them (scattered, they never found room).
      { kind: "silo", x: -10.3, z: 10.8, mirror: true },
      { kind: "pipe", x: -15.6, z: 11.0, mirror: true },
      { kind: "rock", x: -6, z: 4, mirror: true, radius: 1.3, height: 1.6 },
      { kind: "sandbag", x: -3.2, z: -2.4, mirror: true },
      { kind: "bunker", x: -6.5, z: 9.2, mirror: true, yaw: 0.6 },
    ],
    // Recurring sandstorms sweep the open basin — accuracy and visibility drop in waves.
    events: [{ kind: "sandstorm", startTurn: 3, duration: 2, period: 6 }],
    // Twin supply depots by the spires: hold them for extra income.
    neutrals: [{ kind: "depot", x: -19, z: -3, mirror: true }],
  },
  // IRONWORKS — one working foundry, seen from above. Sections: the FOUNDRY FLOOR (the north-west
  // quarter: a blast-furnace landmark still lit, the catwalk beside it, the slag heap behind it,
  // pipe runs and gas bottles between), the RAIL YARD (the south-west quarter: two lines of rail
  // cars and containers on stub track — long parallel cover with lanes between), and the OVERPASS
  // (the centre: a ramped causeway over the middle lane, the one place that sees both quarters).
  // Mirrored, so each side owns a furnace and a yard; the fight is over the overpass and the yard
  // lanes, and the furnaces are the walls at the corners.
  {
    id: "ironworks",
    name: "Ironworks",
    blurb: "A working foundry: furnace, rail yard, and the overpass between.",
    feel: "Rail-car lanes for infantry, the overpass for whoever holds the middle, a lit furnace at each corner.",
    seed: 0x49524f4e,
    theme: { ground: 0x333a44, skyline: "stacks", surface: "slag", groundAccent: 0x7d8794, grid: 0x6f7c8c, fog: 0x5a4632, fogDensity: 0.011, playerLight: 0x5fd7ff, enemyLight: 0xff6d57, sky: 0x8a5a32, ambient: { kind: "embers", color: 0xff9a4a, density: 0.85 } },
    terrain: {
      bounds: { minX: -24, maxX: 24, minZ: -15, maxZ: 15 },
      maxHeight: 2.6,
      blocks: [
        { minX: -3.5, maxX: 3.5, minZ: -3.5, maxZ: 3.5, height: 0.6 }, // central gantry platform
        { minX: -13, maxX: -7, minZ: 3.5, maxZ: 8.5, height: 0.7 },    // foundry catwalk (west)
        { minX: 7, maxX: 13, minZ: -8.5, maxZ: -3.5, height: 0.7 },    // foundry catwalk (east, mirror)
        // The overpass: an elevated causeway spanning the center lane. Walk up a ramp
        // (each step <= TERRAIN_STEP), hold the span, and shoot down into both lanes.
        { minX: -10, maxX: -8, minZ: -1.3, maxZ: 1.3, height: 0.65 },  // west ramp
        { minX: 8, maxX: 10, minZ: -1.3, maxZ: 1.3, height: 0.65 },    // east ramp
        { minX: -8, maxX: 8, minZ: -1.3, maxZ: 1.3, height: 1.25 },    // causeway deck
        // Slag heaps behind each furnace: a climbable skirt and an unclimbable crown.
        { minX: -14, maxX: -8, minZ: 9.5, maxZ: 13.5, height: 0.8 },   // west slag heap (skirt)
        { minX: -12, maxX: -9.5, minZ: 10, maxZ: 12.8, height: 1.9 },  // west slag heap (crown)
        { minX: 8, maxX: 14, minZ: -13.5, maxZ: -9.5, height: 0.8 },   // east slag heap (skirt, mirror)
        { minX: 9.5, maxX: 12, minZ: -12.8, maxZ: -10, height: 1.9 },  // east slag heap (crown)
      ],
    },
    playerBase: { x: -20, z: 0 },
    enemyBase: { x: 20, z: 0 },
    flagOffset: 3.2,
    hill: { x: 0, z: 0 },
    hillRadius: 3.4,
    scatter: [
      // The rail yard: lines of cars on stub track, a container or two between them.
      { palette: ["railcar", "railcar", "railcar", "container"], count: 5, spacing: 0.3, rect: { minX: -21, maxX: -5, minZ: -13.5, maxZ: -4.5 }, grid: { dx: 4.6, dz: 4.5, jitter: 0.2 } },
      // The foundry floor: plant around the furnace.
      { palette: ["pipe", "conduit", "gas", "silo", "coil", "crate", "fuel"], count: 5, spacing: 1.1, rect: { minX: -21, maxX: -4, minZ: 3, maxZ: 14 } },
      // The shop floor along the middle: finished steel waiting to ship, and the gantry's legs.
      { palette: ["ingot", "coil", "girder", "wall"], count: 3, spacing: 1.6, minZ: -3.5, maxZ: 3.5, centerGap: 4 },
    ],
    signature: [
      { kind: "furnace", x: -17, z: 8.5, yaw: -0.5, mirror: true },
      { kind: "wall", x: -2.2, z: 4.5, mirror: true },
      { kind: "wall", x: -4.4, z: -5.5, mirror: true },
      { kind: "crate", x: -3.6, z: 0, mirror: true }, // cover ON the deck; at x -6 it plugged the top of the ramp and nobody could get onto the span
      { kind: "conduit", x: -9.5, z: 1.5, mirror: true },
      { kind: "girder", x: -11.5, z: -4.2, mirror: true }, // clear of the overpass ramp mouth: at z -2.2 it shut the ramp to vehicles
      { kind: "gas", x: -6.5, z: -3.8, mirror: true },
    ],
    // SLAG SPILL: the furnaces vent every third turn, alternating corners -- molten slag floods
    // the marked foundry floor (a hit on the spill, then burning ground for two turns). Ironworks'
    // own hazard; Karak keeps the collapse.
    events: [{ kind: "slag", startTurn: 3, period: 3, zone: { x: -12, z: 6.5, radius: 3.4 }, power: 18 }],
    // Derelict foundry turrets guard the throat of each rail yard — first squad to reach one owns it.
    neutrals: [{ kind: "turret", x: -3.5, z: -8, mirror: true }],
  },
  // VERDANT PASS — a farmed valley between two wooded mountains. Sections: the ORCHARD (the
  // south-west quarter: rows of fruit trees on a grid, a wood you fight through lane by lane),
  // CHAPEL GREEN (the north-west quarter: a roofless chapel ruin landmark on open turf with its
  // yard of stones and stumps), the MILL POND (a pond against the hill's north shoulder with the
  // old mill landmark on its bank — water the ground lanes must go round) and THE HILL (the
  // stacked centre). Mirrored: orchard and chapel swap quarters across the map, so each side
  // has one wood to hide in and one green to be seen on.
  {
    id: "verdant",
    name: "Verdant Pass",
    blurb: "A farmed valley: orchard rows, a chapel ruin, the mill pond and the hill.",
    feel: "Fight through the orchard rows or cross the open chapel green; the pond bends every lane toward the hill.",
    seed: 0x56455244,
    theme: { ground: 0x35502a, skyline: "forest", surface: "grass", groundAccent: 0x93b04a, grid: 0x86a85f, fog: 0x93b0c4, fogDensity: 0.009, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0x86b2d4, ambient: { kind: "pollen", color: 0xd8f0a0, density: 1 } },
    terrain: {
      bounds: { minX: -28, maxX: 28, minZ: -19, maxZ: 19 },
      maxHeight: 3.6,
      blocks: [
        { minX: -5.5, maxX: 5.5, minZ: -5, maxZ: 5, height: 0.8 },     // hill base (climbable lower step)
        { minX: -3.4, maxX: 3.4, minZ: -3.2, maxZ: 3.2, height: 1.6 }, // commanding hilltop (stacked)
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
      // The mill ponds: still water on the hill's shoulders; ground units go round, flyers over.
      water: [
        { minX: -14, maxX: -9, minZ: 6.5, maxZ: 10.5 },   // west mill pond
        { minX: 9, maxX: 14, minZ: -10.5, maxZ: -6.5 },   // east mill pond (mirror)
      ],
    },
    playerBase: { x: -24, z: 0 },
    enemyBase: { x: 24, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 5.0,
    // A storm rolls through the valley: from turn 4, lightning strikes one marked point every turn.
    events: [{ kind: "lightning", startTurn: 4, period: 1, power: 46 }],
    scatter: [
      // The orchard: fruit trees planted in rows.
      { palette: ["tree"], count: 9, spacing: 0.5, rect: { minX: -23, maxX: -10, minZ: -15.5, maxZ: -7 }, grid: { dx: 3.4, dz: 3.4, jitter: 0.25 } },
      // Chapel green: the churchyard's headstones, fallen masonry, stumps and scrub around the ruin.
      { palette: ["grave", "grave", "rubble", "stump", "bush"], count: 5, spacing: 1.2, rect: { minX: -24, maxX: -16, minZ: -1, maxZ: 9 } },
      // Field edge between the orchard and the pass: bales left out, harvest crates, a hedge.
      { palette: ["haybale", "crate", "bush", "rock"], count: 3, spacing: 1.6, rect: { minX: -20, maxX: -7, minZ: -4, maxZ: 3 }, centerGap: 6.5 },
      // The farmstead above the mill: the hay stack, the woodpile and a run of fence.
      { palette: ["haybale", "haybale", "fence", "log", "crate"], count: 3, spacing: 1.2, rect: { minX: -25, maxX: -12, minZ: 11.5, maxZ: 17.5 } },
    ],
    signature: [
      { kind: "chapel", x: -21, z: 3.5, yaw: 0.35, mirror: true },
      // The orchard's fence line, between the rows and the open field.
      { kind: "fence", x: -18.2, z: -5.6, mirror: true },
      { kind: "fence", x: -14.8, z: -5.6, mirror: true },
      { kind: "mill", x: -16.2, z: 8.6, yaw: 0, mirror: true },
      { kind: "rock", x: -4.5, z: -6.8, mirror: true, radius: 1.1 },
      { kind: "tree", x: -7.6, z: 3.2, mirror: true },
      { kind: "tree", x: -11.5, z: 1.6, mirror: true },
    ],
  },
  // FROZEN CAUSEWAY — a harbour the ice took. Sections: THE CAUSEWAY (the raised land bridge down
  // the middle, the head-on lane), the FROZEN HARBOUR (the north-west flank: a freighter beached and
  // listing on the ice — the landmark — with its cargo spilled around it), the FISHING VILLAGE (the
  // south-west flank: a cluster of ice-fishing huts and tents on a loose grid, low cover in numbers)
  // and the CHANNELS (frozen water either side of the causeway, crossed by timber bridges). Mirrored:
  // the far side's harbour is on your south, its village on your north.
  {
    id: "causeway",
    name: "Frozen Causeway",
    blurb: "A harbour the ice took: a beached freighter, a fishing village, one land bridge between.",
    feel: "Head-on down the causeway, or take the bridges out to the harbour and the village on the flanks.",
    seed: 0x46524f5a,
    theme: { ground: 0x64798f, skyline: "floes", surface: "ice", groundAccent: 0xe2eef6, grid: 0xbfd6e6, fog: 0xc9b294, fogDensity: 0.011, playerLight: 0x7fd7ff, enemyLight: 0xff8f7f, sky: 0xd8b58a, ambient: { kind: "snow", color: 0xeaf4ff, density: 1.2 } },
    terrain: {
      bounds: { minX: -37, maxX: 37, minZ: -19, maxZ: 19 }, // LARGE: long land bridge, deep flanks
      maxHeight: 2.8,
      // A raised central causeway funnels the fight; bases sit on the flat outer ground.
      blocks: [
        { minX: -18, maxX: 18, minZ: -5, maxZ: 5, height: 0.5 },   // central land bridge
        { minX: -3, maxX: 3, minZ: -3, maxZ: 3, height: 1.0 },     // contested high point
        // Pressure ridges: the ice has heaved up along the channel banks. They give the flanks
        // cover and a silhouette, and they are what casts shadow across an otherwise white field.
        { minX: -16, maxX: -9, minZ: 5.2, maxZ: 7, height: 0.8 },   // north bank ridge (west)
        { minX: 9, maxX: 16, minZ: 5.2, maxZ: 7, height: 0.8 },     // north bank ridge (east)
        { minX: -16, maxX: -9, minZ: -7, maxZ: -5.2, height: 0.8 }, // south bank ridge (west)
        { minX: 9, maxX: 16, minZ: -7, maxZ: -5.2, height: 0.8 },   // south bank ridge (east)
        // The harbour mole: a grounded berg at the harbour mouth, sheer and unclimbable.
        { minX: -35, maxX: -31, minZ: 12, maxZ: 17, height: 2.4 },  // west berg
        { minX: 31, maxX: 35, minZ: -17, maxZ: -12, height: 2.4 },  // east berg (mirror)
      ],
      // Frozen channels flood the flanks: you cross the middle on the land bridge, or take one of
      // the timber bridges out wide. The centre lane is always open, so there's never a soft-lock.
      water: [
        { minX: -15, maxX: 15, minZ: 7, maxZ: 18 },    // north frozen channel
        { minX: -15, maxX: 15, minZ: -18, maxZ: -7 },  // south frozen channel
      ],
      bridges: [
        { minX: -10, maxX: -7, minZ: 7, maxZ: 18 },    // NW crossing
        { minX: 7, maxX: 10, minZ: 7, maxZ: 18 },      // NE crossing
        { minX: -10, maxX: -7, minZ: -18, maxZ: -7 },  // SW crossing
        { minX: 7, maxX: 10, minZ: -18, maxZ: -7 },    // SE crossing
      ],
    },
    playerBase: { x: -34, z: 0 },
    enemyBase: { x: 34, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 3.6,
    scatter: [
      // The fishing village: huts on a loose grid, the catch on drying racks, boats hauled up for
      // the winter and the woodpile between.
      { palette: ["hut", "hut", "rack", "boat", "hut", "log"], count: 6, spacing: 0.4, rect: { minX: -33, maxX: -19, minZ: -17, maxZ: -8 }, grid: { dx: 4.2, dz: 4.2, jitter: 0.5 } },
      // The harbour: the freighter's cargo, spilled and frozen in, and the ice it heaved up.
      { palette: ["container", "container", "crate", "fuel", "iceblock", "barricade"], count: 5, spacing: 1.0, rect: { minX: -31, maxX: -17, minZ: 6, maxZ: 17 } },
      // The causeway: a wrecked supply route's debris among the pressure ice.
      { palette: ["iceblock", "rubble", "wall", "wreck", "sandbag", "crate"], count: 4, spacing: 1.8, minZ: -6, maxZ: 6, centerGap: 2.5, rect: { minX: -18, maxX: -6, minZ: -6, maxZ: 6 } },
    ],
    signature: [
      { kind: "hull", x: -24.5, z: 11.5, yaw: 0.55, mirror: true },
      { kind: "wall", x: -3, z: 0, mirror: true },
      { kind: "rubble", x: -7, z: 2.6, mirror: true },
      { kind: "crate", x: -10.5, z: 2.8, mirror: true },
      { kind: "sandbag", x: -12, z: -1, mirror: true },
    ],
    // Ion storms rake the exposed causeway, scrambling command links (units lose command points).
    events: [{ kind: "ionstorm", startTurn: 3, duration: 1, period: 4 }],
  },
  // RUINS OF KARAK — a temple city gone to ruin. Sections: the TEMPLE PRECINCT (the centre: the
  // dais, a colonnade of standing pillars down each side of it, and the FALLEN COLOSSUS landmark
  // toppled across the precinct's north edge — a wall of stone you can hold), the CISTERN (each
  // side's approach: a ring well landmark on the flat between the base and the ravine, cover
  // that shapes the crossing), the AMPHITHEATRE (the south-west quarter: a stepped stone bowl with
  // broken statues on its tiers — climbable high ground on the flank), the MESAS (the north-west
  // stone terraces) and the RAVINES (the burst aqueduct, three spans a side). Mirrored: your
  // amphitheatre faces their mesa across the ravines.
  {
    id: "karak",
    name: "Ruins of Karak",
    blurb: "A temple city in ruin: colonnade, fallen colossus, amphitheatre and cistern.",
    feel: "Cross the ravines into the precinct, hold the colossus or climb the amphitheatre steps.",
    seed: 0x4b415241,
    theme: { ground: 0x664d2c, skyline: "ziggurats", surface: "paved", groundAccent: 0xc79149, grid: 0xc6a567, fog: 0x6a5f86, fogDensity: 0.012, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0x6e5f96, ambient: { kind: "ash", color: 0xcbb083, density: 0.9 } },
    terrain: {
      bounds: { minX: -26, maxX: 26, minZ: -18, maxZ: 18 },
      maxHeight: 3.6,
      blocks: [
        { minX: -4, maxX: 4, minZ: -3.5, maxZ: 3.5, height: 0.8 },   // central dais (lower step)
        { minX: -3, maxX: 3, minZ: -2.5, maxZ: 2.5, height: 1.5 },   // toppled altar (stacked)
        { minX: -22, maxX: -12, minZ: 6, maxZ: 14, height: 0.8 },    // NW stone mesa (lower)
        { minX: -20, maxX: -14, minZ: 8, maxZ: 13, height: 1.6 },    // NW stone mesa (mid)
        { minX: -19, maxX: -16, minZ: 9, maxZ: 12, height: 2.4 },    // NW stone mesa (crown)
        { minX: 12, maxX: 22, minZ: -14, maxZ: -6, height: 0.8 },    // SE stone mesa (lower, mirror)
        { minX: 14, maxX: 20, minZ: -13, maxZ: -8, height: 1.6 },    // SE stone mesa (mid)
        { minX: 16, maxX: 19, minZ: -12, maxZ: -9, height: 2.4 },    // SE stone mesa (crown)
        // The amphitheatre: a stepped bowl, each tier climbable, the top a stage.
        { minX: -22, maxX: -11, minZ: -17, maxZ: -9, height: 0.8 },  // SW amphitheatre (lowest tier)
        { minX: -20, maxX: -13, minZ: -17, maxZ: -11.5, height: 1.6 }, // SW amphitheatre (mid tier)
        { minX: -18, maxX: -15, minZ: -17, maxZ: -14, height: 2.4 }, // SW amphitheatre (stage)
        { minX: 11, maxX: 22, minZ: 9, maxZ: 17, height: 0.8 },      // NE amphitheatre (lowest, mirror)
        { minX: 13, maxX: 20, minZ: 11.5, maxZ: 17, height: 1.6 },   // NE amphitheatre (mid)
        { minX: 15, maxX: 18, minZ: 14, maxZ: 17, height: 2.4 },     // NE amphitheatre (stage)
        // Tower stumps: sheer ruin walls framing the precinct's south and north corners.
        { minX: -13, maxX: -10.5, minZ: -16, maxZ: -12.5, height: 3.2 }, // west tower stump
        { minX: 10.5, maxX: 13, minZ: 12.5, maxZ: 16, height: 3.2 },     // east tower stump (mirror)
      ],
      // The old aqueduct burst: a flooded ravine runs down each side of the centre. Ground units
      // take one of three crossings per side (or go the long way around the ends); flyers overfly.
      water: [
        { minX: -11, maxX: -8.5, minZ: -9, maxZ: 9 },   // west ravine
        { minX: 8.5, maxX: 11, minZ: -9, maxZ: 9 },     // east ravine
      ],
      bridges: [
        { minX: -11, maxX: -8.5, minZ: -1.8, maxZ: 1.8 },   // west centre span
        { minX: -11, maxX: -8.5, minZ: 5.5, maxZ: 8 },      // west north span
        { minX: -11, maxX: -8.5, minZ: -8, maxZ: -5.5 },    // west south span
        { minX: 8.5, maxX: 11, minZ: -1.8, maxZ: 1.8 },     // east centre span
        { minX: 8.5, maxX: 11, minZ: 5.5, maxZ: 8 },        // east north span
        { minX: 8.5, maxX: 11, minZ: -8, maxZ: -5.5 },      // east south span
      ],
    },
    playerBase: { x: -22, z: 0 },
    enemyBase: { x: 22, z: 0 },
    flagOffset: 3.4,
    hill: { x: 0, z: 0 },
    hillRadius: 3.2,
    scatter: [
      // The colonnade: standing pillars in a line down each side of the precinct.
      { palette: ["pillar"], count: 3, spacing: 0.3, rect: { minX: -7.6, maxX: -6.0, minZ: -9, maxZ: 9 }, grid: { dx: 2, dz: 4.6, jitter: 0.15 }, centerGap: 5.5 },
      // The amphitheatre tiers: broken statues on the steps.
      { palette: ["statue", "statue", "obelisk", "urn", "rubble"], count: 3, spacing: 1.0, rect: { minX: -21.5, maxX: -11.5, minZ: -16.5, maxZ: -9.5 } },
      // The approaches: fallen city between the cistern and the ravine — a toppled obelisk's twin
      // still standing, the temple's oil braziers and store jars, scrub reclaiming it all.
      { palette: ["rubble", "urn", "brazier", "statue", "rubble"], count: 5, spacing: 1.6, rect: { minX: -20, maxX: -12, minZ: -8, maxZ: 5 } },
      // The temple garden north of the ravine, gone wild: scrub, stumps and boulders round the
      // store jars.
      { palette: ["bush", "stump", "rock", "urn"], count: 3, spacing: 1.4, rect: { minX: -12, maxX: -5, minZ: 10.5, maxZ: 16.5 } },
    ],
    signature: [
      { kind: "colossus", x: -2.6, z: 9.6, yaw: 0.25, mirror: true },
      { kind: "cistern", x: -15.5, z: 1.5, mirror: true },
      // An obelisk at the colonnade's south end, the precinct's gatepost.
      { kind: "obelisk", x: -6.8, z: -11, mirror: true },
      { kind: "cliff", x: -9.5, z: 4.2, mirror: true },
      { kind: "rubble", x: -12.5, z: 7.5, mirror: true },
    ],
    // The ancient colonnades give way: cover near the central dais collapses every few turns.
    events: [{ kind: "collapse", startTurn: 4, period: 4, zone: { x: 0, z: 0, radius: 9 } }],
  },
  // CROSSFIRE BASIN — a militarised border. Sections: the CHECKPOINT (the centre lane: each side's
  // gate landmark — booth, raised boom, sign — facing the other across the knoll, the crossing
  // itself), the RADAR STATION (the north-west flank: a dish on a trailer landmark inside a
  // fenced plant of conduits and ammo, beside the nest), the TRENCH LINE (the south flank: a run
  // of sandbags from the nest toward the centre, ending in a pillbox — cover in a line, so an
  // advance along it is a fight for each bag), and the FORDS (the streams and their bridges out
  // wide). Mirrored, so each side has a station to hold and a trench to push down.
  {
    id: "crossfire",
    name: "Crossfire Basin",
    blurb: "A militarised border: checkpoint gates, a radar station, a trench line.",
    feel: "Push the trench line, hold the radar station, meet at the checkpoint — mirrored to the bag.",
    seed: 0x43524f53,
    theme: { ground: 0x414833, skyline: "fences", surface: "grass", groundAccent: 0x98a15c, grid: 0x97a277, fog: 0x94a3b4, fogDensity: 0.010, playerLight: 0x6fd7ff, enemyLight: 0xff7c5e, sky: 0x8fa3ba, ambient: { kind: "pollen", color: 0xc6d8a8, density: 0.7 } },
    terrain: {
      bounds: { minX: -26, maxX: 26, minZ: -17, maxZ: 17 },
      maxHeight: 3.0,
      blocks: [
        // Central knoll, three steps: holding the top now means holding real high ground rather
        // than standing on a kerb.
        { minX: -5, maxX: 5, minZ: -5, maxZ: 5, height: 0.9 },          // knoll base
        { minX: -3.4, maxX: 3.4, minZ: -3.4, maxZ: 3.4, height: 1.7 },  // knoll mid
        { minX: -2, maxX: 2, minZ: -2, maxZ: 2, height: 2.5 },          // knoll crown
        // Each nest gets a second step, so it commands the ground around it and casts a shadow.
        { minX: -16, maxX: -11, minZ: -11, maxZ: -6, height: 0.7 },     // SW nest
        { minX: -15, maxX: -12, minZ: -10, maxZ: -7, height: 1.5 },     // SW nest crown
        { minX: 11, maxX: 16, minZ: 6, maxZ: 11, height: 0.7 },         // NE nest (mirror)
        { minX: 12, maxX: 15, minZ: 7, maxZ: 10, height: 1.5 },         // NE nest crown
        { minX: 11, maxX: 16, minZ: -11, maxZ: -6, height: 0.7 },       // SE nest
        { minX: 12, maxX: 15, minZ: -10, maxZ: -7, height: 1.5 },       // SE nest crown
        { minX: -16, maxX: -11, minZ: 6, maxZ: 11, height: 0.7 },       // NW nest
        { minX: -15, maxX: -12, minZ: 7, maxZ: 10, height: 1.5 },       // NW nest crown
      ],
      // A stream cuts the north and south approaches; the centre stays open past the knoll, so
      // the fast lane is always the exposed one.
      water: [
        { minX: -20, maxX: 20, minZ: 12, maxZ: 16 },    // north stream
        { minX: -20, maxX: 20, minZ: -16, maxZ: -12 },  // south stream
      ],
      bridges: [
        { minX: -13.5, maxX: -10.5, minZ: 12, maxZ: 16 },   // NW ford
        { minX: 10.5, maxX: 13.5, minZ: 12, maxZ: 16 },     // NE ford
        { minX: -13.5, maxX: -10.5, minZ: -16, maxZ: -12 }, // SW ford
        { minX: 10.5, maxX: 13.5, minZ: -16, maxZ: -12 },   // SE ford
      ],
    },
    playerBase: { x: -22, z: 0 },
    enemyBase: { x: 22, z: 0 },
    flagOffset: 3.2,
    hill: { x: 0, z: 0 },
    hillRadius: 3.8,
    scatter: [
      // The trench line: a run of sandbags from the nest toward the checkpoint.
      { palette: ["sandbag"], count: 3, spacing: 0.15, rect: { minX: -13, maxX: -7, minZ: -9.4, maxZ: -8.6 }, grid: { dx: 2.4, dz: 1, jitter: 0.1 }, centerGap: 6 },
      // The radar station's plant.
      { palette: ["conduit", "ammo", "container", "tower", "crate"], count: 4, spacing: 1.0, rect: { minX: -24, maxX: -17, minZ: 4, maxZ: 13.5 } },
      // No-man's-land between the nests and the streams: scrub, and the tank traps the border
      // guards sowed across the approaches.
      { palette: ["bush", "hedgehog", "tree", "rock", "hedgehog", "stump"], count: 5, spacing: 1.6, rect: { minX: -23, maxX: -6, minZ: -11.5, maxZ: 11.5 }, centerGap: 6 },
    ],
    signature: [
      { kind: "gate", x: -8, z: 0, yaw: 0, mirror: true },
      { kind: "radar", x: -19, z: 9, yaw: 0.8, mirror: true },
      { kind: "bunker", x: -1.6, z: -9, yaw: 0.2, mirror: true },
      { kind: "sandbag", x: -9, z: 3.5, mirror: true },
      { kind: "ammo", x: -12.5, z: 3.5, mirror: true },
    ],
    // Off-map artillery ranges in on the central basin on a steady cadence — don't loiter there.
    events: [{ kind: "barrage", startTurn: 3, period: 4, zone: { x: 0, z: 0, radius: 6 }, power: 34 }],
  },
];

// Every consumer sees the enlarged maps; the authored RAW_MAPS above stay readable at base scale.
export const MAPS: readonly MapDef[] = RAW_MAPS.map(scaleMapDef);

export function mapDef(id: string): MapDef {
  return MAPS.find((map) => map.id === id) ?? MAPS[0];
}
