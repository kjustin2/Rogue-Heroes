// ============================================================================
//  mapPreview — the Skirmish page's illustrated battlefield preview.
// ----------------------------------------------------------------------------
//  A tilted isometric drawing of the ACTUAL map on a 2D canvas: the terrain
//  blocks as stepped, side-shaded slabs in the theme palette, water with the
//  wave-stroke look, bridges, every scatter prop as a tiny glyph (from the same
//  seeded placement the battle uses), the two bases in team colours, and the
//  mode's own markers (flags / hill ring / domination sectors / assault arrows).
//  Inked outlines + a hard offset shadow, like every other toon-UI plate.
//
//  Three-free and deterministic: the same map + mode + tilt always paints the
//  same pixels, so a screenshot of it is a regression artefact. Hover / a new
//  selection eases the tilt over ~250ms (reduce-motion: instant).
// ============================================================================

import type { CombatEntity, CoverKind } from "../game/damageModel";
import { buildMapObjects, flagPositions, mapCenter, mapSize, type MapDef } from "../game/maps";
import type { ModeId } from "../game/modes";
import { activeTerrainSpec, setActiveTerrain } from "../game/terrain";

export interface MapPreviewHandle {
  update(map: MapDef, mode: ModeId): void;
  setHover(hover: boolean): void;
  destroy(): void;
}

// --- colour helpers ---------------------------------------------------------
type Rgb = [number, number, number];
const rgb = (n: number): Rgb => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const css = ([r, g, b]: Rgb, a = 1): string => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lighten = (c: Rgb, t: number): Rgb => mix(c, [255, 250, 236], t);
const darken = (c: Rgb, t: number): Rgb => mix(c, [11, 14, 18], t);
const INK = "#0b0e12";

// --- the projection ---------------------------------------------------------
interface Proj {
  /** world (x, z, elevation) → canvas px */
  p(x: number, z: number, y?: number): [number, number];
  /** vertical pixels per world unit of height */
  lift: number;
}

function makeProj(map: MapDef, w: number, h: number, tilt: number): Proj {
  const b = map.terrain.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const cosA = Math.SQRT1_2;
  // Isometric: rotate 45° about the vertical, then foreshorten depth by `tilt` (0.5 = classic
  // 2:1 dimetric, higher = more top-down). Fit the rotated footprint in the canvas with a margin.
  const corners: [number, number][] = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]];
  const rot = corners.map(([x, z]) => [(x - cx - (z - cz)) * cosA, (x - cx + (z - cz)) * cosA * tilt] as [number, number]);
  const spanX = Math.max(...rot.map((r) => r[0])) - Math.min(...rot.map((r) => r[0]));
  const spanY = Math.max(...rot.map((r) => r[1])) - Math.min(...rot.map((r) => r[1]));
  const maxH = map.terrain.maxHeight ?? 1.9;
  const liftPerUnit = 0.55; // world units of height drawn as this many world units of screen rise
  // The diamond may bleed past the plate's sides a little: its corners are empty ground and the
  // clipped edge reads as a diorama in a box rather than a drawing floating in one.
  const scale = Math.min((w * 1.18) / spanX, (h - 18) / (spanY + maxH * liftPerUnit + 1.2));
  const ox = w / 2;
  const oy = h / 2 + (maxH * liftPerUnit * scale) / 2 - 4;
  return {
    lift: liftPerUnit * scale,
    p(x, z, y = 0) {
      const sx = (x - cx - (z - cz)) * cosA * scale + ox;
      const sy = (x - cx + (z - cz)) * cosA * tilt * scale + oy - y * liftPerUnit * scale;
      return [sx, sy];
    },
  };
}

// --- primitives -------------------------------------------------------------
function poly(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string, stroke = INK, lw = 1.5): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

function footprint(proj: Proj, r: Rect, y: number): [number, number][] {
  return [proj.p(r.minX, r.minZ, y), proj.p(r.maxX, r.minZ, y), proj.p(r.maxX, r.maxZ, y), proj.p(r.minX, r.maxZ, y)];
}

/** An extruded slab: two visible side faces (shaded) under a lit cap. */
function slab(ctx: CanvasRenderingContext2D, proj: Proj, r: Rect, base: number, top: number, cap: Rgb, lw = 1.5): void {
  const lo = footprint(proj, r, base);
  const hi = footprint(proj, r, top);
  // Visible faces in this projection: the +Z side (front-left) and the +X side (front-right).
  poly(ctx, [lo[3], lo[2], hi[2], hi[3]], css(darken(cap, 0.42)), INK, lw); // +Z face (left-front)
  poly(ctx, [lo[2], lo[1], hi[1], hi[2]], css(darken(cap, 0.24)), INK, lw); // +X face (right-front)
  poly(ctx, hi, css(cap), INK, lw);
}

// --- scatter glyphs ---------------------------------------------------------
type Glyph = "tree" | "bush" | "stone" | "box" | "bar" | "tank" | "post";
const GLYPH: Partial<Record<CoverKind, Glyph>> = {
  tree: "tree", cactus: "tree", stump: "bush", log: "bar", bush: "bush",
  rock: "stone", rubble: "stone", statue: "post", pillar: "post", cliff: "stone", ridge: "stone",
  crate: "box", container: "box", sandbag: "bar", barricade: "bar", wall: "bar", bunker: "box",
  tent: "box", wreck: "box", fuel: "tank", gas: "tank", ammo: "box", silo: "tank", pipe: "bar", conduit: "bar",
  depot: "box", span: "bar",
  girder: "post", coil: "tank", ingot: "box", haybale: "bush", fence: "bar", grave: "post",
  boat: "bar", rack: "bar", iceblock: "stone", obelisk: "post", urn: "tank", brazier: "tank",
  hedgehog: "box", tower: "post", bones: "stone",
};

function drawGlyph(ctx: CanvasRenderingContext2D, kind: Glyph, x: number, y: number, s: number, tint: { foliage: Rgb; stone: Rgb; wood: Rgb; metal: Rgb }): void {
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  switch (kind) {
    case "tree": {
      ctx.fillStyle = css(darken(tint.wood, 0.3));
      ctx.fillRect(x - s * 0.12, y - s * 0.5, s * 0.24, s * 0.6);
      ctx.strokeRect(x - s * 0.12, y - s * 0.5, s * 0.24, s * 0.6);
      ctx.beginPath();
      ctx.arc(x, y - s * 0.72, s * 0.46, 0, Math.PI * 2);
      ctx.fillStyle = css(tint.foliage);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - s * 0.14, y - s * 0.84, s * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = css(lighten(tint.foliage, 0.3));
      ctx.fill();
      break;
    }
    case "bush": {
      ctx.beginPath();
      ctx.ellipse(x, y - s * 0.22, s * 0.42, s * 0.3, 0, 0, Math.PI * 2);
      ctx.fillStyle = css(darken(tint.foliage, 0.15));
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "stone": {
      poly(ctx, [[x - s * 0.45, y], [x - s * 0.3, y - s * 0.5], [x + s * 0.1, y - s * 0.62], [x + s * 0.48, y - s * 0.28], [x + s * 0.34, y + s * 0.05]], css(tint.stone), INK, 1.2);
      poly(ctx, [[x - s * 0.3, y - s * 0.5], [x + s * 0.1, y - s * 0.62], [x + s * 0.05, y - s * 0.3], [x - s * 0.2, y - s * 0.28]], css(lighten(tint.stone, 0.28)), "", 0);
      break;
    }
    case "box": {
      const h = s * 0.5;
      const w = s * 0.42;
      poly(ctx, [[x - w, y - h * 0.5], [x, y], [x, y - h], [x - w, y - h * 1.5]], css(darken(tint.wood, 0.3)), INK, 1.2);
      poly(ctx, [[x, y], [x + w, y - h * 0.5], [x + w, y - h * 1.5], [x, y - h]], css(darken(tint.wood, 0.12)), INK, 1.2);
      poly(ctx, [[x - w, y - h * 1.5], [x, y - h], [x + w, y - h * 1.5], [x, y - h * 2]], css(lighten(tint.wood, 0.18)), INK, 1.2);
      break;
    }
    case "bar": {
      const h = s * 0.3;
      const w = s * 0.62;
      poly(ctx, [[x - w, y - h * 0.4], [x + w * 0.3, y + h * 0.5], [x + w * 0.3, y - h * 0.6], [x - w, y - h * 1.5]], css(darken(tint.metal, 0.3)), INK, 1.2);
      poly(ctx, [[x - w, y - h * 1.5], [x + w * 0.3, y - h * 0.6], [x + w, y - h * 1.1], [x - w * 0.3, y - h * 2]], css(lighten(tint.metal, 0.1)), INK, 1.2);
      break;
    }
    case "tank": {
      ctx.beginPath();
      ctx.ellipse(x, y - s * 0.7, s * 0.3, s * 0.15, 0, 0, Math.PI * 2);
      ctx.fillStyle = css(lighten(tint.metal, 0.2));
      ctx.fillRect(x - s * 0.3, y - s * 0.7, s * 0.6, s * 0.6);
      ctx.strokeRect(x - s * 0.3, y - s * 0.7, s * 0.6, s * 0.6);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "post": {
      ctx.fillStyle = css(tint.stone);
      ctx.fillRect(x - s * 0.16, y - s * 1.1, s * 0.32, s * 1.1);
      ctx.strokeRect(x - s * 0.16, y - s * 1.1, s * 0.32, s * 1.1);
      ctx.fillStyle = css(lighten(tint.stone, 0.3));
      ctx.fillRect(x - s * 0.24, y - s * 1.2, s * 0.48, s * 0.14);
      ctx.strokeRect(x - s * 0.24, y - s * 1.2, s * 0.48, s * 0.14);
      break;
    }
  }
}

// --- the drawing ------------------------------------------------------------
interface Scene {
  map: MapDef;
  mode: ModeId;
  props: CombatEntity[];
}

function collectProps(map: MapDef): CombatEntity[] {
  // buildMapObjects reads the terrain singleton (steep / water rejection), so swap the map's
  // terrain in for the call and put the live one back — synchronous, so the running diorama or
  // battle never sees the change.
  const live = activeTerrainSpec();
  setActiveTerrain(map.terrain);
  try {
    return buildMapObjects(map);
  } finally {
    setActiveTerrain(live);
  }
}

function terrainHeight(map: MapDef, x: number, z: number): number {
  let h = 0;
  for (const b of map.terrain.blocks ?? []) {
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) h = Math.max(h, b.height);
  }
  return h;
}

export function drawMapPreview(ctx: CanvasRenderingContext2D, scene: Scene, w: number, h: number, tilt: number): void {
  const { map, mode } = scene;
  const t = map.theme;
  const ground = rgb(t.ground);
  const accent = rgb(t.groundAccent);
  const proj = makeProj(map, w, h, tilt);
  const b = map.terrain.bounds;
  const unit = proj.p(1, 0)[0] - proj.p(0, 0)[0]; // px per world unit along the iso x axis
  const glyphSize = Math.max(7, Math.min(15, unit * 2.6));

  // The plate behind the board is the map's own sky, deepened — a diorama in a box, not a
  // drawing on the panel.
  ctx.fillStyle = css(darken(rgb(t.sky), 0.55));
  ctx.fillRect(0, 0, w, h);

  // Hard offset shadow under the whole board, then the board itself as a lit slab.
  ctx.save();
  ctx.translate(6, 6);
  poly(ctx, footprint(proj, b, 0), INK, "", 0);
  ctx.restore();
  slab(ctx, proj, b, -0.9, 0, mix(ground, accent, 0.18), 2);

  // Water: a flat pool at grade with wave strokes, clipped to its rect.
  const waterFill = rgb(0x3f7ea8);
  for (const r of map.terrain.water ?? []) {
    const pts = footprint(proj, r, 0.02);
    poly(ctx, pts, css(waterFill), INK, 1.5);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = css(lighten(waterFill, 0.5));
    ctx.lineWidth = 1.2;
    const step = Math.max(2.2, unit * 1.4);
    let row = 0;
    for (let z = r.minZ + step * 0.5; z < r.maxZ; z += step, row += 1) {
      for (let x = r.minX + (row % 2 ? step * 0.5 : 0) + step * 0.3; x < r.maxX; x += step * 1.6) {
        const [ax, ay] = proj.p(x, z, 0.02);
        ctx.beginPath();
        ctx.arc(ax, ay + 2, unit * 0.55, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Bridges: plank strips just above the water.
  const plank = rgb(0x8a6236);
  for (const r of map.terrain.bridges ?? []) {
    slab(ctx, proj, r, 0.02, 0.14, plank, 1.2);
    ctx.strokeStyle = css(darken(plank, 0.4));
    ctx.lineWidth = 1;
    const along = r.maxX - r.minX >= r.maxZ - r.minZ;
    const len = along ? r.maxX - r.minX : r.maxZ - r.minZ;
    for (let i = 0.6; i < len; i += 0.9) {
      const a = along ? proj.p(r.minX + i, r.minZ, 0.14) : proj.p(r.minX, r.minZ + i, 0.14);
      const c = along ? proj.p(r.minX + i, r.maxZ, 0.14) : proj.p(r.maxX, r.minZ + i, 0.14);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.stroke();
    }
  }

  // Terrain: every block is an extruded slab; painter's order is low-to-high, then back-to-front.
  const blocks = [...(map.terrain.blocks ?? [])].sort((p, q) => (p.height - q.height) || ((p.minX + p.minZ) - (q.minX + q.minZ)));
  for (const blk of blocks) {
    const cap = lighten(mix(ground, accent, 0.55), Math.min(0.5, blk.height * 0.18));
    slab(ctx, proj, blk, 0, blk.height, cap, 1.4);
  }

  // Mode markers on the ground, under the props.
  const amber = "#f6b93b";
  const ring = (x: number, z: number, radius: number, colour: string, dash: number[] = [5, 4]): void => {
    const y = terrainHeight(map, x, z) + 0.03;
    ctx.beginPath();
    const n = 40;
    for (let i = 0; i <= n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const [px, py] = proj.p(x + Math.cos(a) * radius, z + Math.sin(a) * radius, y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const center = mapCenter(map);
  if (mode === "hill") ring(map.hill.x, map.hill.z, map.hillRadius, amber);
  if (mode === "domination") {
    const mid = (a: { x: number; z: number }, c: { x: number; z: number }) => ({ x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 });
    for (const s of [map.hill, mid(map.playerBase, map.hill), mid(map.enemyBase, map.hill)]) ring(s.x, s.z, map.hillRadius * 0.7, amber);
  }
  if (mode === "destroy" || mode === "ctf") ring(map.hill.x, map.hill.z, map.hillRadius * 0.6, css(lighten(accent, 0.3), 0.7), [3, 5]);

  // Props: one glyph per scatter entity, painted back to front.
  const tint = {
    foliage: t.surface === "ice" ? rgb(0x4f7a5a) : t.surface === "slag" ? rgb(0x5d6b3e) : t.surface === "cracked" ? rgb(0x7f9a4a) : rgb(0x5f9a44),
    stone: lighten(mix(ground, accent, 0.4), 0.2),
    wood: rgb(0xa0703c),
    metal: rgb(0x8b929b),
  };
  const drawables: Array<{ depth: number; x: number; y: number; glyph: Glyph }> = [];
  for (const e of scene.props) {
    const glyph = GLYPH[e.coverKind ?? "crate"] ?? "box";
    const y = terrainHeight(map, e.position.x, e.position.z);
    const [px, py] = proj.p(e.position.x, e.position.z, y);
    drawables.push({ depth: e.position.x + e.position.z, x: px, y: py, glyph });
  }
  drawables.sort((p, q) => p.depth - q.depth);
  for (const d of drawables) drawGlyph(ctx, d.glyph, d.x, d.y, glyphSize, tint);

  // Flags (ctf) and bases, on top of everything.
  const flagAt = (x: number, z: number, colour: string): void => {
    const y = terrainHeight(map, x, z);
    const [px, py] = proj.p(x, z, y);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py - glyphSize * 1.8);
    ctx.stroke();
    poly(ctx, [[px, py - glyphSize * 1.8], [px + glyphSize * 1.1, py - glyphSize * 1.45], [px, py - glyphSize * 1.1]], colour, INK, 1.3);
  };
  const playerCol = css(rgb(t.playerLight));
  const enemyCol = css(rgb(t.enemyLight));
  if (mode === "ctf") {
    const f = flagPositions(map);
    flagAt(f.player.x, f.player.z, playerCol);
    flagAt(f.enemy.x, f.enemy.z, enemyCol);
  }
  const baseAt = (x: number, z: number, colour: string, letter: string): void => {
    const y = terrainHeight(map, x, z);
    const [px, py] = proj.p(x, z, y);
    const r = Math.max(8, glyphSize * 1.25);
    // A hex plate with an ink rim and a hard shadow, then the letter.
    const hex = (cx: number, cy: number, rad: number): [number, number][] =>
      Array.from({ length: 6 }, (_, i) => [cx + Math.cos((i / 6) * Math.PI * 2 + Math.PI / 6) * rad, cy + Math.sin((i / 6) * Math.PI * 2 + Math.PI / 6) * rad] as [number, number]);
    poly(ctx, hex(px + 2.5, py - r * 0.6 + 2.5, r), INK, "", 0);
    poly(ctx, hex(px, py - r * 0.6, r), colour, INK, 2);
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.round(r * 1.05)}px Rajdhani, Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, px, py - r * 0.6 + 1);
  };
  baseAt(map.playerBase.x, map.playerBase.z, playerCol, "P");
  if (mode === "survival") {
    // Last Stand: no enemy base — assault arrows pressing in from the far edge.
    const dir = { x: center.x - map.enemyBase.x, z: center.z - map.enemyBase.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    const ux = dir.x / len;
    const uz = dir.z / len;
    for (const off of [-0.32, 0, 0.32]) {
      const sx = map.enemyBase.x - uz * off * (b.maxZ - b.minZ);
      const sz = map.enemyBase.z + ux * off * (b.maxZ - b.minZ);
      const a = proj.p(sx, sz, 0.1);
      const c = proj.p(sx + ux * 5, sz + uz * 5, 0.1);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      ctx.strokeStyle = enemyCol;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      const ang = Math.atan2(c[1] - a[1], c[0] - a[0]);
      poly(ctx, [[c[0], c[1]], [c[0] - Math.cos(ang - 0.5) * 8, c[1] - Math.sin(ang - 0.5) * 8], [c[0] - Math.cos(ang + 0.5) * 8, c[1] - Math.sin(ang + 0.5) * 8]], enemyCol, INK, 1.4);
    }
  } else {
    baseAt(map.enemyBase.x, map.enemyBase.z, enemyCol, "E");
  }
}

// --- the DOM host -----------------------------------------------------------
const TILT_REST = 0.52;
const TILT_HOVER = 0.6;
const TILT_MS = 250;

/**
 * Mount the preview into `host`: a canvas plus a caption (name, size badge, feel line — DOM,
 * so the ui-audit measures it like any other text). Returns a handle to swap the map / mode.
 */
export function mountMapPreview(host: HTMLElement, map: MapDef, mode: ModeId, opts: { caption?: boolean } = {}): MapPreviewHandle {
  host.innerHTML = "";
  host.classList.add("map-preview--illustrated");
  const canvas = document.createElement("canvas");
  canvas.className = "map-preview-canvas";
  canvas.setAttribute("role", "img");
  host.appendChild(canvas);
  const caption = document.createElement("div");
  caption.className = "map-preview-caption";
  if (opts.caption !== false) host.appendChild(caption);

  let scene: Scene = { map, mode, props: collectProps(map) };
  let tilt = TILT_REST;
  let target = TILT_REST;
  let raf = 0;
  let lastTs = 0;
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const paint = (): void => {
    // Fit the plate to the host's width AND the canvas's CSS max-height, so a short viewport
    // gets a shorter (not squashed) plate; the board is re-projected to whatever box results.
    const maxH = parseFloat(getComputedStyle(canvas).maxHeight) || Infinity;
    const cssW = Math.max(200, Math.round(host.clientWidth - 12));
    const cssH = Math.round(Math.min(cssW * 0.58, maxH));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMapPreview(ctx, scene, cssW, cssH, tilt);
    canvas.setAttribute("aria-label", `${scene.map.name} preview`);
  };
  const setCaption = (): void => {
    const size = mapSize(scene.map);
    caption.innerHTML = `<strong>${scene.map.name}<em class="map-size-badge size-${size}">${size}</em></strong><span>${scene.map.feel}</span>`;
  };
  const tick = (ts: number): void => {
    raf = 0;
    const dt = lastTs ? Math.min(64, ts - lastTs) : 16;
    lastTs = ts;
    const step = dt / TILT_MS;
    if (Math.abs(target - tilt) <= step * Math.abs(TILT_HOVER - TILT_REST)) tilt = target;
    else tilt += Math.sign(target - tilt) * step * (TILT_HOVER - TILT_REST);
    paint();
    if (tilt !== target) raf = requestAnimationFrame(tick);
    else lastTs = 0;
  };
  const animateTo = (value: number): void => {
    target = value;
    if (reduceMotion) { tilt = target; paint(); return; }
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const onEnter = (): void => animateTo(TILT_HOVER);
  const onLeave = (): void => animateTo(TILT_REST);
  host.addEventListener("pointerenter", onEnter);
  host.addEventListener("pointerleave", onLeave);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => paint()) : null;
  ro?.observe(host);

  setCaption();
  paint();
  return {
    update(nextMap, nextMode) {
      const changed = nextMap.id !== scene.map.id;
      scene = { map: nextMap, mode: nextMode, props: changed ? collectProps(nextMap) : scene.props };
      setCaption();
      if (changed) {
        // A new pick "lands": dip the tilt and ease back to rest.
        tilt = TILT_HOVER;
        animateTo(TILT_REST);
      }
      paint();
    },
    setHover(hover) { animateTo(hover ? TILT_HOVER : TILT_REST); },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      host.removeEventListener("pointerenter", onEnter);
      host.removeEventListener("pointerleave", onLeave);
    },
  };
}
