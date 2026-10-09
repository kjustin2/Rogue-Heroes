import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Vec2 } from "../core/math";
import { terrainIce } from "../game/terrain";

// THE MAP EVENTS AND THE ROLLING STRIKES, DRAWN (owner 2026-10-08: "polish ... like tornado look and animation or cattle animation").
// One function per sweep (a dust devil, a stampede, a boulder, an icebreaker, a car bomb). Each is drawn fresh every frame from the
// sweep's own progress `t` (0..1), so everything is deterministic and screenshot-stable: a trail of dust is the puffs the thing
// kicked up at EARLIER t, already grown and sinking, standing where they were kicked. Every geometry and material is built once and
// marked `userData.shared` (the effect root is disposed every frame and skips them); only Mesh / Group wrappers are made per frame.
// Nothing is additive: dust, foam and smoke are ordinary translucent puffs (no FX may stack additive white).

export type SweepDraw = "devil" | "stampede" | "boulder" | "icebreaker" | "carbomb";

export interface SweepEffect {
  from: Vec2;
  to: Vec2;
  duration: number;
  radius?: number;
}

type GroundAt = (p: Vec2) => number;

const shared = <T extends { userData: Record<string, unknown> }>(o: T): T => { o.userData.shared = true; return o; };
const cache = new Map<string, unknown>();
function once<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (!v) { v = make(); cache.set(key, v); }
  return v;
}
const mat = (key: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial =>
  once(`m:${key}`, () => shared(new THREE.MeshStandardMaterial({ roughness: 0.9, ...params })));
const puffMat = (key: string, color: number, opacity: number): THREE.MeshStandardMaterial =>
  once(`p:${key}`, () => shared(new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, transparent: true, opacity, depthWrite: false })));
const box = (w: number, h: number, d: number): THREE.BufferGeometry => once(`b:${w},${h},${d}`, () => shared(new THREE.BoxGeometry(w, h, d)));
const puffGeo = (): THREE.BufferGeometry => once("puff", () => shared(new THREE.IcosahedronGeometry(1, 1)));
/** A fixed pseudo-random in [0,1) from an integer (no Math.random: frames must be reproducible). */
const rnd = (i: number): number => { const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, s = 1): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.scale.setScalar(s);
  return o;
}

/** Where the sweep is at progress `t`, plus its travel direction (unit) and length. */
function along(e: SweepEffect, t: number): { p: Vec2; dir: Vec2; len: number; yaw: number } {
  const dx = e.to.x - e.from.x, dz = e.to.z - e.from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { p: { x: e.from.x + dx * t, z: e.from.z + dz * t }, dir: { x: dx / len, z: dz / len }, len, yaw: Math.atan2(dx, dz) };
}

/**
 * A trail of puffs kicked up behind a mover: puff j was kicked `j * gap` seconds ago at the mover's position then (offset by
 * `kick`), has grown and drifted up since, and shrinks away at `life`. Only puffs inside the sweep's own time are drawn.
 */
function trail(root: THREE.Object3D, e: SweepEffect, t: number, ground: GroundAt, o: {
  count: number; gap: number; life: number; size: number; rise: number; m: THREE.Material; kick?: (tk: number, j: number) => Vec2; seed: number; lift?: number;
}): void {
  const elapsed = t * e.duration;
  // Puffs are kicked on a fixed clock (every `gap` seconds of sweep time) so a puff does not crawl from frame to frame.
  const newest = Math.floor(elapsed / o.gap);
  for (let j = 0; j < o.count; j += 1) {
    const n = newest - j;
    if (n < 0) break;
    const kickedAt = n * o.gap;
    const age = elapsed - kickedAt;
    if (age > o.life) continue;
    const k = age / o.life;
    const at = o.kick ? o.kick(kickedAt / e.duration, n) : along(e, kickedAt / e.duration).p;
    const jx = (rnd(n * 3 + o.seed) - 0.5) * 0.6, jz = (rnd(n * 7 + o.seed) - 0.5) * 0.6;
    const s = o.size * (0.45 + k * 1.1) * (1 - k * k * 0.9);
    root.add(mesh(puffGeo(), o.m, at.x + jx, ground(at) + (o.lift ?? 0.2) + k * o.rise, at.z + jz, s));
  }
}

// ---------------------------------------------------------------- the dust devil

const DEVIL_HEIGHT = 6.2;

/** A twisted funnel: a lathe narrow at the ground and flaring up top, its surface banded by two dust tones that wind round it
 *  (the bands follow angle + height, so spinning the funnel reads as a twisting column, not a turning cone). */
function devilGeometry(outer: boolean): THREE.BufferGeometry {
  return once(`devil:${outer}`, () => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i += 1) {
      const h = i / 14;
      const r = (outer ? 0.5 : 0.28) + Math.pow(h, 1.8) * (outer ? 1.9 : 1.45) + Math.sin(h * 9) * 0.06;
      pts.push(new THREE.Vector2(r, h * DEVIL_HEIGHT));
    }
    const g = new THREE.LatheGeometry(pts, 28);
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const colors: number[] = [];
    const light = new THREE.Color(outer ? 0xe2c89c : 0xc9a77a), dark = new THREE.Color(outer ? 0xa8875c : 0x8a6a48), c = new THREE.Color();
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // Twist: each ring turned further the higher it sits.
      const a = (y / DEVIL_HEIGHT) * 2.4;
      pos.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a));
      const theta = Math.atan2(z, x);
      const band = Math.sin(theta * 3 + y * 1.6) * 0.5 + 0.5;
      c.copy(dark).lerp(light, band);
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return shared(g);
  });
}

function drawDevil(root: THREE.Object3D, e: SweepEffect, t: number, ground: GroundAt, now: number): void {
  const { p, dir, len } = along(e, t);
  // It meanders: a slow sideways weave on the lane (visual only; the sim's lane is straight and fair).
  const weave = Math.sin(t * Math.PI * 3.2) * 0.9;
  const at = { x: p.x - dir.z * weave, z: p.z + dir.x * weave };
  const g = ground(at);
  const spin = now * 0.009;
  const funnel = new THREE.Group();
  const inner = new THREE.Mesh(devilGeometry(false), mat("devil-in", { vertexColors: true, side: THREE.DoubleSide }));
  inner.rotation.y = spin * 1.3;
  const outer = new THREE.Mesh(devilGeometry(true), once("devil-out-mat", () => shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false }))));
  outer.rotation.y = spin;
  funnel.add(inner, outer);
  funnel.position.set(at.x, g - 0.1, at.z);
  // Leans INTO its travel and wobbles: the top sways round the foot.
  funnel.rotation.x = 0.16 * dir.z + Math.sin(now * 0.004) * 0.05;
  funnel.rotation.z = -0.16 * dir.x + Math.cos(now * 0.0033) * 0.05;
  root.add(funnel);
  // The skirt: a churning ring of dust round its foot.
  const dust = puffMat("devil-dust", 0xc8aa7e, 0.45);
  for (let i = 0; i < 10; i += 1) {
    const a = spin * 2 + (i / 10) * Math.PI * 2;
    const r = 1.0 + rnd(i) * 0.5 + Math.sin(now * 0.006 + i) * 0.2;
    root.add(mesh(puffGeo(), dust, at.x + Math.cos(a) * r, g + 0.2 + rnd(i + 9) * 0.25, at.z + Math.sin(a) * r, 0.3 + rnd(i + 3) * 0.22));
  }
  // Debris carried round and up the column: clods, a plank, a tumbleweed.
  const clod = mat("clod", { color: 0x5e4630, flatShading: true });
  const wood = mat("plank", { color: 0x8c6a42 });
  const weed = mat("weed", { color: 0x9a8656, flatShading: true });
  for (let i = 0; i < 7; i += 1) {
    const cycle = ((now * 0.00035 + rnd(i + 20)) % 1);
    const h = 0.4 + cycle * (DEVIL_HEIGHT - 1.2);
    const r = 0.8 + (h / DEVIL_HEIGHT) * 2.4;
    const a = spin * 2.2 + i * 0.9;
    const kind = i % 3;
    const o = kind === 1 ? new THREE.Mesh(box(0.9, 0.08, 0.2), wood) : new THREE.Mesh(puffGeo(), kind === 2 ? weed : clod);
    if (kind !== 1) o.scale.setScalar(kind === 2 ? 0.32 : 0.14);
    o.position.set(at.x + Math.cos(a) * r, g + h, at.z + Math.sin(a) * r);
    o.rotation.set(now * 0.01 + i, now * 0.013, i);
    root.add(o);
  }
  // Behind it, the dust it raised settles (a trail, staying where it was kicked).
  trail(root, e, t, ground, { count: 10, gap: 0.12, life: 1.3, size: 0.55, rise: 0.8, m: puffMat("devil-trail", 0xd0b286, 0.35), seed: 1, kick: (tk) => {
    const q = along(e, tk).p, w = Math.sin(tk * Math.PI * 3.2) * 0.9; return { x: q.x - dir.z * w, z: q.z + dir.x * w };
  } });
  void len;
}

// ---------------------------------------------------------------- the stampede

const HIDES = [0x6b4a2e, 0x2b2420, 0xa07a4e];

/** One low-poly cow, legs and tail as named pivots so the gallop can swing them. */
function buildCow(variant: number): THREE.Group {
  const hide = mat(`hide${variant}`, { color: HIDES[variant], flatShading: true });
  const patch = mat("patch", { color: 0xe8e2d6, flatShading: true });
  const horn = mat("horn", { color: 0xe8dcc0 });
  const dark = mat("hoof", { color: 0x1d1814 });
  const nose = mat("muzzle", { color: 0xc99a8a });
  const cow = new THREE.Group();
  const body = new THREE.Group(); body.name = "body"; cow.add(body);
  body.add(mesh(box(0.74, 0.62, 1.4), hide, 0, 0.98, 0));
  body.add(mesh(box(0.64, 0.24, 1.1), hide, 0, 0.62, 0)); // the belly drop
  body.add(mesh(box(0.78, 0.66, 0.5), hide, 0, 1.02, 0.42)); // the deep chest
  if (variant !== 1) for (const [x, z, w] of [[0.38, -0.2, 0.5], [-0.38, 0.25, 0.4]] as const) body.add(mesh(box(0.03, 0.36, w), patch, x, 1.02, z));
  else body.add(mesh(box(0.76, 0.06, 0.5), patch, 0, 1.3, -0.2)); // a white saddle on the black one
  const head = new THREE.Group(); head.name = "head"; head.position.set(0, 1.0, 0.82); body.add(head);
  head.add(mesh(box(0.4, 0.42, 0.5), hide, 0, -0.05, 0.12));
  head.add(mesh(box(0.34, 0.24, 0.2), nose, 0, -0.18, 0.42));
  for (const s of [-1, 1]) {
    const h = mesh(box(0.34, 0.07, 0.07), horn, s * 0.3, 0.16, 0.05); h.rotation.z = s * 0.35; head.add(h);
    const ear = mesh(box(0.18, 0.06, 0.1), hide, s * 0.26, 0.04, -0.06); ear.rotation.z = -s * 0.3; head.add(ear);
  }
  const tail = new THREE.Group(); tail.name = "tail"; tail.position.set(0, 1.2, -0.7); body.add(tail);
  tail.add(mesh(box(0.06, 0.6, 0.06), hide, 0, -0.3, 0));
  tail.add(mesh(box(0.12, 0.14, 0.12), dark, 0, -0.62, 0));
  for (const [x, z, name] of [[-0.24, 0.5, "fl"], [0.24, 0.5, "fr"], [-0.24, -0.5, "bl"], [0.24, -0.5, "br"]] as const) {
    const leg = new THREE.Group(); leg.name = name; leg.position.set(x, 0.72, z);
    leg.add(mesh(box(0.15, 0.6, 0.16), hide, 0, -0.3, 0));
    leg.add(mesh(box(0.17, 0.12, 0.18), dark, 0, -0.66, 0.01));
    cow.add(leg);
  }
  return cow;
}

const HERD = 6;
const STRIDE = 1.9; // metres a full gallop cycle covers: the legs are driven by distance, so the hooves do not skate

function drawStampede(root: THREE.Object3D, e: SweepEffect, t: number, ground: GroundAt): void {
  const { dir, len, yaw } = along(e, t);
  const dust = puffMat("herd-dust", 0xa8895e, 0.42);
  for (let k = 0; k < HERD; k += 1) {
    // A loose wedge: a leader, then pairs, each a little behind and to a side, jostling.
    const lag = [0, 1.5, 1.7, 3.1, 3.3, 4.6][k];
    const side = [0, -0.85, 0.9, -0.4, 0.55, 0.1][k] + Math.sin(t * 9 + k * 1.7) * 0.18;
    const travelled = t * len - lag;
    if (travelled < -1 || travelled > len + 1) continue;
    const at = { x: e.from.x + dir.x * travelled - dir.z * side, z: e.from.z + dir.z * travelled + dir.x * side };
    const phase = ((travelled + k * 0.37) / STRIDE) * Math.PI * 2;
    const cow = buildCow(k % 3);
    // The rotary gallop: fore and hind pairs a half-cycle apart, each pair a little out of step.
    const swing = (name: string, off: number): void => { const l = cow.getObjectByName(name); if (l) l.rotation.x = Math.sin(phase + off) * 0.75; };
    swing("fl", 0); swing("fr", 0.5); swing("bl", Math.PI); swing("br", Math.PI + 0.5);
    const body = cow.getObjectByName("body")!;
    body.position.y = Math.abs(Math.sin(phase)) * 0.14; // the bound
    body.rotation.x = Math.sin(phase) * 0.08; // rocking fore and aft
    const head = cow.getObjectByName("head")!;
    head.rotation.x = 0.25 + Math.sin(phase + 0.8) * 0.12; // head down, nodding
    const tail = cow.getObjectByName("tail")!;
    tail.rotation.x = -0.9 + Math.sin(phase * 0.5) * 0.25;
    tail.rotation.z = Math.sin(phase * 0.7 + k) * 0.35;
    cow.position.set(at.x, ground(at), at.z);
    cow.rotation.y = yaw + Math.sin(t * 6 + k) * 0.06;
    root.add(cow);
  }
  // The dust the herd raises: a broad trail behind the pack.
  trail(root, e, t, ground, { count: 14, gap: 0.09, life: 1.4, size: 0.85, rise: 0.9, m: dust, seed: 7, kick: (tk, n) => {
    const q = along(e, tk).p, lag = 1.5 + (n % 3) * 1.4, s = ((n * 5) % 3 - 1) * 0.8;
    return { x: q.x - dir.x * lag - dir.z * s, z: q.z - dir.z * lag + dir.x * s };
  } });
}

// ---------------------------------------------------------------- the boulder

function boulderGeometry(): THREE.BufferGeometry {
  return once("boulder", () => {
    // Welded first: the icosahedron's triangles each own their corners, so lumping per vertex index tore the stone into loose
    // triangles with holes (visual QA 2026-10-08). After the weld each corner is shared, and one scale moves every face on it.
    const g = mergeVertices(new THREE.IcosahedronGeometry(1, 1).deleteAttribute("normal").deleteAttribute("uv"));
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 1) {
      const k = 0.86 + rnd(i) * 0.22; // fixed lumps
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
    }
    g.computeVertexNormals();
    return shared(g);
  });
}

function drawBoulder(root: THREE.Object3D, e: SweepEffect, t: number, ground: GroundAt): void {
  const { p, len, yaw, dir } = along(e, t);
  const r = e.radius ?? 1.4;
  const d = t * len;
  // Small hops as it rolls over the ground's bumps.
  const hop = Math.abs(Math.sin(d * 0.9)) * 0.22 * r * (1 - Math.abs(Math.sin(d * 0.37)) * 0.5);
  const stone = new THREE.Mesh(boulderGeometry(), mat("boulder", { color: 0x8a7a66, roughness: 0.95, flatShading: true }));
  stone.scale.setScalar(r);
  stone.position.set(p.x, ground(p) + r * 0.92 + hop, p.z);
  stone.rotation.y = yaw;
  stone.rotateX(d / r); // rolling without slipping
  stone.castShadow = true;
  root.add(stone);
  // Grit flung off its contact point, sideways and back.
  const grit = mat("grit", { color: 0x6e604e, flatShading: true });
  for (let i = 0; i < 6; i += 1) {
    const k = ((d * 1.3 + rnd(i) * 3) % 1);
    const s = i % 2 ? 1 : -1;
    const q = { x: p.x - dir.x * (k * 1.6) - dir.z * s * (0.6 + k * 1.4), z: p.z - dir.z * (k * 1.6) + dir.x * s * (0.6 + k * 1.4) };
    root.add(mesh(puffGeo(), grit, q.x, ground(q) + 0.15 + Math.sin(k * Math.PI) * 0.9, q.z, 0.09 + rnd(i + 4) * 0.06));
  }
  // A dust plume behind it.
  trail(root, e, t, ground, { count: 9, gap: 0.1, life: 1.1, size: 0.75 * r, rise: 0.6, m: puffMat("boulder-dust", 0xb0a084, 0.45), seed: 3 });
}

// ---------------------------------------------------------------- the icebreaker

function drawIcebreaker(root: THREE.Object3D, e: SweepEffect, t: number, ground: GroundAt, now: number): void {
  const { p, dir, yaw } = along(e, t);
  const red = mat("ship-red", { color: 0xa8322a, roughness: 0.7 });
  const black = mat("ship-black", { color: 0x1d1f22 });
  const white = mat("ship-white", { color: 0xeef0ee, roughness: 0.6 });
  const ship = new THREE.Group();
  ship.add(mesh(box(2.4, 1.0, 6), red, 0, 0.3, 0));
  ship.add(mesh(box(2.45, 0.35, 6.05), black, 0, -0.05, 0));
  const prow = new THREE.Mesh(once("prow", () => shared(new THREE.ConeGeometry(1.2, 1.6, 4))), red);
  prow.rotation.x = Math.PI / 2; prow.rotation.y = Math.PI / 4; prow.position.set(0, 0.3, 3.7); ship.add(prow);
  ship.add(mesh(box(1.8, 1.2, 1.8), white, 0, 1.4, -1.2));
  ship.add(mesh(box(1.9, 0.12, 0.5), black, 0, 1.75, -0.35)); // the bridge windows
  ship.add(new THREE.Mesh(once("funnel", () => shared(new THREE.CylinderGeometry(0.3, 0.35, 1.2, 10).translate(0, 2.4, -1.8))), black));
  ship.position.set(p.x, -0.2 + Math.sin(t * 9) * 0.06, p.z);
  ship.rotation.y = yaw;
  ship.rotation.z = Math.sin(t * 7) * 0.03;
  root.add(ship);
  const water = (): number => -0.05;
  // THE CHANNEL IT OPENS: over thin ice, the hull's width behind it is broken water with floes along its edges (visual QA
  // 2026-10-08: the ice stayed whole behind the ship). Clipped to the ice sheets, so open water gets no strip.
  const half = 1.4;
  const lo = { x: Math.min(e.from.x, p.x) - (Math.abs(dir.z) > 0.5 ? half : 0), z: Math.min(e.from.z, p.z) - (Math.abs(dir.x) > 0.5 ? half : 0) };
  const hi = { x: Math.max(e.from.x, p.x) + (Math.abs(dir.z) > 0.5 ? half : 0), z: Math.max(e.from.z, p.z) + (Math.abs(dir.x) > 0.5 ? half : 0) };
  const open = mat("open-water", { color: 0x1f3b52, roughness: 0.2 });
  const floe = mat("floe", { color: 0xe4f2f8, flatShading: true });
  for (const r of terrainIce()) {
    const minX = Math.max(lo.x, r.minX), maxX = Math.min(hi.x, r.maxX), minZ = Math.max(lo.z, r.minZ), maxZ = Math.min(hi.z, r.maxZ);
    if (maxX - minX < 0.2 || maxZ - minZ < 0.2) continue;
    const strip = new THREE.Mesh(box(1, 1, 1), open);
    strip.scale.set(maxX - minX, 0.02, maxZ - minZ);
    strip.position.set((minX + maxX) / 2, 0.05, (minZ + maxZ) / 2);
    root.add(strip);
    const along = Math.abs(dir.x) > 0.5;
    const span = along ? maxX - minX : maxZ - minZ;
    for (let k = 0; k < span; k += 0.9) for (const sd of [-1, 1]) {
      const n = Math.round(k * 10) + (sd > 0 ? 7 : 0);
      const u = (along ? minX : minZ) + k + rnd(n) * 0.5;
      const v = (along ? (minZ + maxZ) / 2 : (minX + maxX) / 2) + sd * (half - 0.25 - rnd(n + 3) * 0.5);
      const f = mesh(box(1, 1, 1), floe, along ? u : v, 0.07, along ? v : u, 1);
      f.scale.set(0.35 + rnd(n + 1) * 0.4, 0.08, 0.3 + rnd(n + 2) * 0.35);
      f.rotation.y = rnd(n + 4) * 3;
      root.add(f);
    }
  }
  // Bow spray: white puffs thrown up and out either side of the prow.
  const foam = puffMat("foam", 0xf2f6f8, 0.75);
  const bow = { x: p.x + dir.x * 3.9, z: p.z + dir.z * 3.9 };
  for (let i = 0; i < 8; i += 1) {
    const k = ((now * 0.0016 + rnd(i)) % 1);
    const s = i % 2 ? 1 : -1;
    root.add(mesh(puffGeo(), foam, bow.x - dir.x * k * 1.4 - dir.z * s * (0.5 + k * 1.6), water() + Math.sin(k * Math.PI) * 1.1, bow.z - dir.z * k * 1.4 + dir.x * s * (0.5 + k * 1.6), 0.28 * (1 - k * 0.6)));
  }
  // The wake: two lines of foam spreading in a V behind the hull, standing where the ship passed.
  for (const s of [-1, 1]) {
    trail(root, e, t, () => water(), { count: 12, gap: 0.1, life: 1.6, size: 0.55, rise: 0, lift: 0, m: foam, seed: s > 0 ? 11 : 13, kick: (tk) => {
      const q = along(e, tk).p, age = t - tk;
      const spread = 1.3 + age * e.duration * 1.2;
      return { x: q.x - dir.x * 3 - dir.z * s * spread, z: q.z - dir.z * 3 + dir.x * s * spread };
    } });
  }
  // Ice shards thrown off the channel walls at the bow.
  const ice = mat("ice-shard", { color: 0xd8ecf4, flatShading: true, roughness: 0.3 });
  const shardGeo = once("shard", () => shared(new THREE.TetrahedronGeometry(1)));
  for (let i = 0; i < 6; i += 1) {
    const k = ((now * 0.0011 + rnd(i + 30)) % 1);
    const s = i % 2 ? 1 : -1;
    const o = mesh(shardGeo, ice, bow.x - dir.z * s * (1.4 + k * 2.4), water() + 0.2 + Math.sin(k * Math.PI) * 1.5, bow.z + dir.x * s * (1.4 + k * 2.4), 0.22 + rnd(i) * 0.12);
    o.rotation.set(now * 0.006 + i, i, now * 0.004);
    root.add(o);
  }
  // Funnel smoke drifting back.
  trail(root, e, t, () => 2.7, { count: 10, gap: 0.14, life: 1.5, size: 0.5, rise: 1.6, lift: 0.3, m: puffMat("ship-smoke", 0x3a3c40, 0.55), seed: 17, kick: (tk) => {
    const q = along(e, tk).p; return { x: q.x - dir.x * 1.8, z: q.z - dir.z * 1.8 };
  } });
  void ground;
}

// ---------------------------------------------------------------- the car bomb

function drawCarBomb(root: THREE.Object3D, e: SweepEffect, t: number, ground: GroundAt, now: number): void {
  const { p, len, yaw } = along(e, t);
  const rust = mat("car-rust", { color: 0x7a3a22, flatShading: true });
  const dark = mat("car-dark", { color: 0x22201e });
  const glass = mat("car-glass", { color: 0x0e1214, roughness: 0.3 });
  const barrel = mat("car-barrel", { color: 0xb42a1e });
  const car = new THREE.Group();
  const body = new THREE.Group();
  body.add(mesh(box(1.5, 0.5, 2.8), rust, 0, 0.62, 0));
  body.add(mesh(box(1.32, 0.48, 1.2), rust, 0, 1.1, -0.15));
  body.add(mesh(box(1.34, 0.32, 1.0), glass, 0, 1.12, -0.15));
  body.add(mesh(box(1.52, 0.18, 0.3), dark, 0, 0.5, 1.45)); // bumper
  // The payload in the open back: red barrels lashed together, and a fizzing fuse.
  for (const x of [-0.35, 0.35]) {
    const b = new THREE.Mesh(once("car-drum", () => shared(new THREE.CylinderGeometry(0.28, 0.28, 0.7, 12))), barrel);
    b.position.set(x, 1.15, -1.05); body.add(b);
  }
  const fuse = mat("fuse", { color: 0xffd27a, emissive: 0xffa040 });
  fuse.emissiveIntensity = 1.2 + Math.sin(now * 0.05) * 0.6; // it fizzes (a shared material, so one write a frame)
  const spark = mesh(puffGeo(), fuse, 0, 1.6, -1.05, 0.09 + Math.abs(Math.sin(now * 0.04)) * 0.05);
  body.add(spark);
  body.position.y = Math.abs(Math.sin(t * len * 2.1)) * 0.05; // a rattle
  car.add(body);
  const wheelGeo = once("car-wheel", () => shared(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14).rotateZ(Math.PI / 2)));
  for (const [x, z] of [[-0.75, 0.95], [0.75, 0.95], [-0.75, -0.95], [0.75, -0.95]] as const) {
    const w = new THREE.Mesh(wheelGeo, dark); w.position.set(x, 0.34, z); w.rotation.x = (t * len) / 0.34; car.add(w);
  }
  car.position.set(p.x, ground(p), p.z);
  car.rotation.y = yaw;
  root.add(car);
  trail(root, e, t, ground, { count: 8, gap: 0.09, life: 0.9, size: 0.45, rise: 0.8, m: puffMat("car-smoke", 0x4a4440, 0.5), seed: 23 });
}

/** Draw one sweep at progress `t` (0..1) into `root`. */
export function drawSweep(root: THREE.Object3D, kind: SweepDraw, e: SweepEffect, t: number, ground: GroundAt, now = performance.now()): void {
  if (kind === "devil") drawDevil(root, e, t, ground, now);
  else if (kind === "stampede") drawStampede(root, e, t, ground);
  else if (kind === "boulder") drawBoulder(root, e, t, ground);
  else if (kind === "icebreaker") drawIcebreaker(root, e, t, ground, now);
  else drawCarBomb(root, e, t, ground, now);
}

/** Every sweep drawn once mid-run, for stage.warmUp(): their materials compile at load, not when a herd first appears. */
export function sweepWarmUp(): THREE.Group {
  const g = new THREE.Group();
  const e: SweepEffect = { from: { x: -4, z: 0 }, to: { x: 4, z: 0 }, duration: 2, radius: 1.4 };
  for (const kind of ["devil", "stampede", "boulder", "icebreaker", "carbomb"] as const) drawSweep(g, kind, e, 0.5, () => 0, 1000);
  g.add(makeChute());
  return g;
}

/** The Commando Drop's canopy: a team-neutral olive dome on four lines, hung over a trooper's head (worldRenderer folds it away). */
export function makeChute(): THREE.Group {
  const g = new THREE.Group();
  g.name = "chute";
  const canopy = new THREE.Mesh(once("chute-dome", () => shared(new THREE.SphereGeometry(1.5, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2.4))), mat("chute", { color: 0x6e7a4a, side: THREE.DoubleSide }));
  canopy.position.y = 2.7; // low over the trooper so the canopy stays in frame with him
  g.add(canopy);
  const line = mat("chute-line", { color: 0x2a2a24 });
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const l = new THREE.Mesh(box(0.03, 1.2, 0.03), line);
    l.position.set(Math.cos(a) * 0.55, 2.1, Math.sin(a) * 0.55);
    l.rotation.set(Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42);
    g.add(l);
  }
  return g;
}
