// PROJECTILE + IMPACT FX in the game's toon language.
//
// Every round, muzzle event and impact in the game is built here, in the same idiom as the units
// and hulls: flat posterised colour, a dark ink rim, bold silhouettes that read at tactical camera
// distance. The rim is an INVERTED HULL — the same pooled geometry drawn again with a BackSide
// material a little larger — so a shape's outline costs one extra draw call and no edge geometry.
// Layered hulls (white core → colour sleeve → ink) are what give a tracer its hot centre and a
// bolt its two-tone body without any additive blending. Flat cut-outs (the POW star, the impact
// star) are a colour shape sandwiched between two ink shapes, so they read from either side.
//
// Every family is a small SHOW (2026-09-21): a beat at the muzzle, a body with motion, and an
// impact that lands on the target. The pass that produced it had a verdict per family — the
// families that were "readable but not fun" were the ones that were a body and a ring; each now
// has a muzzle beat, a distinct body, and a hit with a shape of its own.
//
// Rules that keep this cheap and inside the owner's FX budget:
// - Every geometry and material comes from a bounded cache (`projectileGeometry`,
//   `projectileMaterial`, `fxSolid`, `fxFlat`). Nothing here allocates a material per frame.
// - NormalBlending everywhere. The only additive light in a shot is the pooled flash light the
//   composition root already drives. Nothing here can stack toward white.
// - Fades are done by SHRINKING (toon smoke and fire die by getting smaller), never by dimming a
//   colour toward black.
// - Sizes are set against the tank hull (3.4 units) and a trooper (1.6 units): a shell must read
//   as a third of a barrel, a tracer as a bright dash a trooper could hold.
// - Trails are sampled by WORLD DISTANCE (`pushTrailPoint`), never per render frame.
// - Blast shapes scale by `effect.radius / 0.22` (the blob geometry's width) and the column climbs
//   at most `min(radius, 1.3)` — a wide blast is not a tall one.
import * as THREE from "three";
import { clamp01 } from "../core/math";
import { isAirKind, type EntityKind } from "../game/damageModel";
import type { Projectile, VisualEvent } from "../game/sim";
import { terrainHeightAt } from "../game/terrain";

export const INK = 0x1c1712;
const HOT = 0xfff6d8; // white-hot core
const TRACER = 0xffd866; // tracer yellow
const TRACER_ALT = 0xff9a3a; // the MG's every-other round
const FLASH = 0xffe58a; // muzzle-flash body
const FLASH_RIM = 0xff8a2e; // muzzle-flash rim (the "outline" of a flash is orange, not ink)
const FIRE = [0xfff0b0, 0xffd24a, 0xff9a2a, 0xf25a1a, 0x9e3a1c, 0x6e6660, 0x8a847a] as const;
const SMOKE = 0x76706a;
const SMOKE_LIGHT = 0x9d968c;
const DUST = 0xcdbb98; // dry ground thrown up
const DUST_DARK = 0x9a8868;
const PEBBLE = 0x8f7a58;
const BRASS = 0xffc857;
const SHOTSHELL = 0xd8432a;
const OLIVE = 0x4d5a3a;
const STEEL = 0x34403c;
const SPARK = 0xe8f0f2; // metal spark off armour
const ARC = 0xbfe9ff; // electric

export type ProjectileFamily =
  | "rifle" | "carbine" | "sniper" | "mg" | "pellet" | "pistol" | "flame"
  | "grenade" | "launcher" | "mortar" | "smoke" | "bomb"
  | "tank" | "artillery" | "siege";

/** Which visual family a round belongs to. The sim only knows four projectile kinds; the look
 *  comes from who fired it and how. */
export function projectileFamily(p: Projectile): ProjectileFamily {
  const src: EntityKind | undefined = p.sourceKind;
  if (p.kind === "shell") return src === "artillery" ? "artillery" : src === "exturret" ? "siege" : "tank";
  // ONE BALLISTIC LANGUAGE (2026-09-22): the sim's "bolt" rounds used to draw as cyan energy darts
  // with crackling arc impacts -- "laser beams" next to every other gun in the game. Autoguns,
  // aircraft cannon and flak fire warm MG tracers now; the base relay throws a real shell.
  if (p.kind === "bolt") return src === "base" ? "tank" : "mg";
  if (p.kind === "grenade") {
    if (src === "mortar") return p.smoke ? "smoke" : "mortar";
    if (src === "grenadier") return "launcher";
    if (src && isAirKind(src)) return "bomb";
    return "grenade";
  }
  if (src === "sniper") return "sniper";
  if (src === "heavy") return "mg";
  if (src === "sapper") return "pellet";
  if (src === "medic" || src === "droneop" || src === "striker") return "pistol";
  if (src === "flamer") return "flame";
  if (src === "scout" || src === "jumper") return "carbine";
  return "rifle";
}

const LOBBED = new Set<ProjectileFamily>(["mortar", "smoke", "artillery", "siege", "tank", "launcher", "grenade", "bomb"]);
const SMALL_ARMS = new Set<ProjectileFamily>(["rifle", "carbine", "pistol", "mg", "sniper", "pellet"]);
export function isSmallArms(family: ProjectileFamily): boolean { return SMALL_ARMS.has(family); }

/** How many past positions a family's trail wants. Long ribbons for the slow lobbed rounds. */
export function trailLength(family: ProjectileFamily): number {
  switch (family) {
    case "flame": return 9;
    case "mortar": case "smoke": case "artillery": case "siege": case "tank": return 8;
    case "sniper": return 7;
    case "mg": return 7;
    case "pellet": case "pistol": return 4;
    default: return 6;
  }
}

/** A trail sample. `born` = the round's age when it was pushed (drives ease-in), `seq` = its
 *  running index in the history (a STABLE phase key — the array index shifts every push, and any
 *  jitter keyed on it pops when the history rolls). */
/** A bare world point — what the line helpers take. */
export interface Point3 { x: number; y: number; z: number }
export interface TrailPoint extends Point3 { born: number; seq: number }

/** Seconds a fresh trail element takes to scale in. Shorter than a frame at full speed would pop. */
const EASE_IN = 0.07;
/** How far behind the head a family's trail reaches before its elements have eased to nothing. */
export function trailReach(family: ProjectileFamily): number { return trailStep(family) * (trailLength(family) - 1); }
function smooth(u: number): number { const c = clamp01(u); return c * c * (3 - 2 * c); }
/** 1 near the head, easing to 0 by `reach`; flat for the first 55% so bodies do not shrink early. */
function easeOut(behind: number, reach: number): number { return smooth((1 - behind / reach) / 0.45); }

/** World-unit spacing between trail samples. Trails are sampled by DISTANCE, not by render frame:
 *  a frame-sampled history is a different length at every refresh rate and resolve speed (at
 *  quarter speed nine frames of flame stacked inside 20cm and read as one balloon). */
export function trailStep(family: ProjectileFamily): number {
  switch (family) {
    case "flame": return 0.3;
    case "mortar": case "smoke": case "artillery": case "siege": case "bomb": return 0.42;
    case "launcher": case "grenade": return 0.36;
    case "tank": return 0.3;
    case "sniper": return 0.34;
    case "mg": return 0.26;
    case "pellet": case "pistol": return 0.16;
    default: return 0.22;
  }
}

/** Append the round's current position to its history when it has moved a trail step. */
export function pushTrailPoint(history: TrailPoint[], p: Projectile, family: ProjectileFamily): void {
  const last = history[history.length - 1];
  const point: TrailPoint = { x: p.position.x, y: p.height, z: p.position.z, born: p.age, seq: last ? last.seq + 1 : 0 };
  if (last) {
    const step = trailStep(family);
    const d = Math.hypot(point.x - last.x, point.y - last.y, point.z - last.z);
    if (d < step) return;
    // A round that jumped several steps in one frame (fast round, slow frame) fills the gap so the
    // ribbon stays continuous instead of leaving a hole behind the head. Fill samples are given
    // a birth time between the two real ones so they ease in as a run, not as one block.
    const n = Math.min(4, Math.floor(d / step));
    for (let i = 1; i < n; i += 1) {
      const t = i / n;
      history.push({ x: last.x + (point.x - last.x) * t, y: last.y + (point.y - last.y) * t, z: last.z + (point.z - last.z) * t, born: last.born + (p.age - last.born) * t, seq: last.seq + i });
    }
    point.seq = last.seq + n;
  }
  history.push(point);
  const max = trailLength(family);
  while (history.length > max) history.shift();
}

// ---------------------------------------------------------------------------------------------
// Caches

const geometries = new Map<string, THREE.BufferGeometry>();
const materials = new Map<string, THREE.Material>();
const tubeGeometries = new Map<string, THREE.CylinderGeometry>();
const shadowGeometries = new Map<string, THREE.CircleGeometry>();

function starShape(points: number, outer: number, inner: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 ? inner : outer;
    const a = (i / (points * 2)) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

export function projectileGeometry(key: string): THREE.BufferGeometry {
  let geometry = geometries.get(key);
  if (!geometry) {
    switch (key) {
      case "tracer": geometry = new THREE.CapsuleGeometry(0.032, 0.34, 2, 7); break;
      case "pellet": geometry = new THREE.SphereGeometry(0.05, 7, 5); break;
      case "shell-body": geometry = new THREE.CylinderGeometry(0.14, 0.16, 0.42, 12); break;
      case "shell-nose": geometry = new THREE.ConeGeometry(0.15, 0.3, 12); break;
      case "shell-band": geometry = new THREE.TorusGeometry(0.16, 0.022, 6, 16); break;
      case "shell-fin": geometry = new THREE.BoxGeometry(0.05, 0.18, 0.34); break;
      case "grenade-body": geometry = new THREE.IcosahedronGeometry(0.18, 1); break;
      case "grenade-band": geometry = new THREE.TorusGeometry(0.18, 0.026, 6, 16); break;
      case "launcher-body": geometry = new THREE.CylinderGeometry(0.11, 0.12, 0.26, 10); break;
      case "launcher-nose": geometry = new THREE.SphereGeometry(0.115, 10, 7); break;
      case "mortar-body": geometry = new THREE.CapsuleGeometry(0.15, 0.22, 3, 10); break;
      case "blob": geometry = new THREE.IcosahedronGeometry(0.22, 1); break;
      case "spike": geometry = new THREE.ConeGeometry(0.07, 0.34, 5); (geometry as THREE.ConeGeometry).translate(0, 0.17, 0); break;
      case "tongue": geometry = new THREE.ConeGeometry(0.17, 0.5, 7); (geometry as THREE.ConeGeometry).translate(0, 0.25, 0); break; // flame tongue, base at origin
      case "disc": geometry = new THREE.CircleGeometry(0.5, 20); break;
      case "ring": geometry = new THREE.RingGeometry(0.42, 0.5, 28); break;
      case "crown": geometry = new THREE.TorusGeometry(0.5, 0.09, 6, 22); break; // dust crown — a ring with volume
      case "shard": geometry = new THREE.TetrahedronGeometry(0.09, 0); break;
      case "ember": geometry = new THREE.SphereGeometry(0.05, 8, 6); break;
      case "bar": geometry = new THREE.BoxGeometry(1, 1, 1); break; // lightning segments, chevrons, speed lines
      case "casing": geometry = new THREE.CylinderGeometry(0.022, 0.022, 0.075, 6); break;
      case "star8": geometry = starShape(8, 0.5, 0.24); break; // the POW burst
      case "star6": geometry = starShape(6, 0.5, 0.2); break; // small-arms hit
      case "star4": geometry = starShape(4, 0.5, 0.14); break; // electric hit / sniper punch
      case "rifle-tail": geometry = new THREE.ConeGeometry(0.055, 0.22, 10); break; // burn-zone flame tongues
      default: geometry = new THREE.SphereGeometry(0.08, 10, 8);
    }
    geometry.userData.shared = true; // pooled — disposeSubtree detaches but never frees it
    geometries.set(key, geometry);
  }
  return geometry;
}

/** Transparent, depth-write-off FX material (trails, ground rings, fading things). */
export function projectileMaterial(key: string, color: number, opacity: number, additive = false): THREE.MeshBasicMaterial {
  const materialKey = `projectile:${key}:${color}:${opacity.toFixed(2)}:${additive ? "a" : "n"}`;
  let material = materials.get(materialKey);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    material.userData.shared = true;
    materials.set(materialKey, material);
  }
  return material as THREE.MeshBasicMaterial;
}

/** Opaque flat-colour material — the toon body of a round. `back` = inverted-hull rim. */
export function fxSolid(color: number, back = false): THREE.MeshBasicMaterial {
  const key = `solid:${color}:${back ? "b" : "f"}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, side: back ? THREE.BackSide : THREE.FrontSide });
    material.userData.shared = true;
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

/** Opaque flat-colour material drawn from both sides — the flat cut-out stars. */
export function fxFlat(color: number): THREE.MeshBasicMaterial {
  const key = `flat:${color}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    material.userData.shared = true;
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

function tubeGeometry(radius: number): THREE.CylinderGeometry {
  const key = radius.toFixed(3);
  let geometry = tubeGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(radius, radius, 1, 8, 1, true);
    geometry.userData.shared = true;
    tubeGeometries.set(key, geometry);
  }
  return geometry;
}

function shadowGeometry(radius: number): THREE.CircleGeometry {
  const key = radius.toFixed(2);
  let geometry = shadowGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.CircleGeometry(radius, 20);
    geometry.userData.shared = true;
    shadowGeometries.set(key, geometry);
  }
  return geometry;
}

/** Materials the stage warm-up must compile: the opaque front/back/double MeshBasic programs this
 *  module introduces (an inverted hull is `flipSided`, a flat star is `doubleSided` — each a
 *  different GL program from every transparent FX material the scene already carried). */
export function projectileFxWarmUpMaterials(): THREE.Material[] {
  return [fxSolid(0xffffff), fxSolid(0xffffff, true), fxFlat(0xffffff), projectileMaterial("warm", 0xffffff, 0.5)];
}

/** Every cached geometry the first resolve will need, built now rather than mid-action. */
export function prewarmProjectileFx(): void {
  for (const key of ["tracer", "pellet", "shell-body", "shell-nose", "shell-band", "shell-fin", "grenade-body", "grenade-band", "launcher-body", "launcher-nose", "mortar-body", "blob", "spike", "tongue", "disc", "ring", "crown", "shard", "ember", "bar", "casing", "star8", "star6", "star4"]) projectileGeometry(key);
  for (const r of [...TRAIL_RADII, 0.045, 0.075, 0.03, 0.05]) tubeGeometry(r);
  for (const r of [0.18, 0.24, 0.3, 0.36, 0.44]) shadowGeometry(r);
  for (const c of [INK, HOT, TRACER, TRACER_ALT, FLASH, FLASH_RIM, SMOKE, SMOKE_LIGHT, DUST, DUST_DARK, PEBBLE, BRASS, SHOTSHELL, OLIVE, STEEL, SPARK, ARC, ...FIRE]) { fxSolid(c); fxSolid(c, true); }
  for (const c of [INK, HOT, FLASH, FLASH_RIM, ARC, FIRE[1]]) fxFlat(c);
}

// ---------------------------------------------------------------------------------------------
// Building blocks

const TRAIL_RADII = [0.05, 0.042, 0.034, 0.026, 0.02, 0.015, 0.012, 0.01];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _side = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const viewer = new THREE.Vector3(30, 40, 30);
/** Where the camera is, so flat cut-outs (stars) can face it. Set once per frame by the renderer. */
export function setFxViewer(position: THREE.Vector3): void { viewer.copy(position); }
/** Quantise an animated opacity so the material cache stays bounded (20 steps). */
function q(opacity: number): number { return Math.round(clamp01(opacity) * 20) / 20; }
function seedOf(id: string): number {
  let h = 7;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 1000003;
  return h;
}
function unit(seed: number, k: number): number { return ((seed * (k * 2 + 1) * 7919) % 1000) / 1000; }

/** Mesh + optional inverted-hull rim. `rim` is the hull's scale; 0 = no rim. */
function solid(geometry: string, color: number, rim = 0, rimColor = INK): THREE.Object3D {
  const mesh = new THREE.Mesh(projectileGeometry(geometry), fxSolid(color));
  mesh.frustumCulled = false;
  if (rim <= 0) return mesh;
  const hull = new THREE.Mesh(projectileGeometry(geometry), fxSolid(rimColor, true));
  hull.scale.setScalar(rim);
  hull.frustumCulled = false;
  mesh.add(hull);
  return mesh;
}

/** A hull whose rim thickness is set per axis (a capsule scaled uniformly rims its ends too much). */
function rimmed(geometry: string, color: number, rimScale: [number, number, number], rimColor = INK): THREE.Mesh {
  const mesh = new THREE.Mesh(projectileGeometry(geometry), fxSolid(color));
  mesh.frustumCulled = false;
  const hull = new THREE.Mesh(projectileGeometry(geometry), fxSolid(rimColor, true));
  hull.scale.set(rimScale[0], rimScale[1], rimScale[2]);
  hull.frustumCulled = false;
  mesh.add(hull);
  return mesh;
}

/** A flat cut-out (star) facing the viewer: colour shape sandwiched between two ink shapes so the
 *  rim reads from either side. `size` is the outer radius in world units (geometry radius 0.5). */
function cutout(geometry: string, color: number, size: number, rimColor = INK, spin = 0): THREE.Group {
  const group = new THREE.Group();
  const face = new THREE.Mesh(projectileGeometry(geometry), fxFlat(color));
  const backA = new THREE.Mesh(projectileGeometry(geometry), fxFlat(rimColor));
  const backB = new THREE.Mesh(projectileGeometry(geometry), fxFlat(rimColor));
  backA.scale.setScalar(1.14); backB.scale.setScalar(1.14);
  backA.position.z = -0.012; backB.position.z = 0.012;
  face.frustumCulled = backA.frustumCulled = backB.frustumCulled = false;
  group.add(backA, face, backB);
  group.scale.setScalar(size * 2);
  group.rotation.z = spin;
  return group;
}
function faceViewer(obj: THREE.Object3D): void { obj.lookAt(viewer); }

function tube(a: Point3, b: Point3, color: number, opacity: number, radius: number): THREE.Object3D | undefined {
  _a.set(a.x, a.y, a.z);
  _b.set(b.x, b.y, b.z);
  _d.subVectors(_b, _a);
  const length = _d.length();
  if (length < 0.005) return undefined;
  const mesh = new THREE.Mesh(tubeGeometry(radius), projectileMaterial("trail", color, opacity));
  mesh.position.copy(_a).add(_b).multiplyScalar(0.5);
  mesh.scale.y = length;
  mesh.quaternion.setFromUnitVectors(UP, _d.normalize());
  mesh.frustumCulled = false;
  return mesh;
}

/** An opaque, ink-rimmed line between two points: a sabot streak. */
function solidTube(a: Point3, b: Point3, color: number, radius: number, rimRadius = 0): THREE.Object3D | undefined {
  _a.set(a.x, a.y, a.z);
  _b.set(b.x, b.y, b.z);
  _d.subVectors(_b, _a);
  const length = _d.length();
  if (length < 0.005) return undefined;
  const mesh = new THREE.Mesh(tubeGeometry(radius), fxSolid(color));
  mesh.position.copy(_a).add(_b).multiplyScalar(0.5);
  mesh.scale.y = length;
  mesh.quaternion.setFromUnitVectors(UP, _d.normalize());
  mesh.frustumCulled = false;
  if (rimRadius > radius) {
    const hull = new THREE.Mesh(tubeGeometry(rimRadius), fxSolid(INK, true));
    hull.frustumCulled = false;
    mesh.add(hull);
  }
  return mesh;
}

/** A box segment from a to b with the given width (lightning, chevrons, speed lines). */
function bar(a: THREE.Vector3, b: THREE.Vector3, color: number, width: number, rim = 0): THREE.Object3D | undefined {
  _d.subVectors(b, a);
  const length = _d.length();
  if (length < 0.005) return undefined;
  const mesh = solid("bar", color, rim);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.scale.set(width, length + width * 0.6, width);
  mesh.quaternion.setFromUnitVectors(UP, _d.normalize());
  return mesh;
}

/** Point the object's +Y along the 3D velocity (so a lobbed round noses over its arc). */
export function orientAlongVelocity(obj: THREE.Object3D, from: Point3, to: Point3): void {
  _d.set(to.x - from.x, to.y - from.y, to.z - from.z);
  if (_d.lengthSq() < 0.00001) return;
  obj.quaternion.setFromUnitVectors(UP, _d.normalize());
}

/** A burst of cone spikes: the toon "flash". N spikes in the plane normal to `axis` (plus one
 *  along it when `forward` > 0). Two-tone: body colour spikes with a rim-colour hull. */
function starburst(count: number, length: number, width: number, color: number, rimColor: number, forward = 0, seed = 0, tilt = 0): THREE.Group {
  const group = new THREE.Group();
  for (let i = 0; i < count; i += 1) {
    const spike = solid("spike", color, 1.45, rimColor);
    const angle = seed + (i / count) * Math.PI * 2;
    // Spikes fan in the local XZ plane; local +Y is the shot axis. `tilt` leans them toward +Y.
    _d.set(Math.cos(angle) * Math.cos(tilt), Math.sin(tilt), Math.sin(angle) * Math.cos(tilt)).normalize();
    spike.quaternion.setFromUnitVectors(UP, _d);
    const len = length * (0.7 + ((seed * 7 + i * 13) % 5) * 0.12);
    spike.scale.set(width, len, width);
    group.add(spike);
  }
  if (forward > 0) {
    const spike = solid("spike", color, 1.4, rimColor);
    spike.scale.set(width * 1.2, forward, width * 1.2);
    group.add(spike);
  }
  return group;
}

/** A FLAT flash: `count` petals fanned in the local XY plane (local +Y = shot axis), each a cone
 *  squashed thin. Three petals is a rifle; seven leaning forward is a scattergun cone. */
function petals(count: number, spread: number, length: number, width: number, color: number, rimColor: number, forward = 0.35): THREE.Group {
  const group = new THREE.Group();
  for (let i = 0; i < count; i += 1) {
    const petal = solid("spike", color, 1.4, rimColor);
    const a = count === 1 ? 0 : (i / (count - 1) - 0.5) * spread;
    _d.set(Math.sin(a), Math.cos(a) * (1 + forward), 0).normalize();
    petal.quaternion.setFromUnitVectors(UP, _d);
    const len = length * (i === Math.floor(count / 2) ? 1.25 : 0.85);
    petal.scale.set(width, len, width * 0.35);
    group.add(petal);
  }
  return group;
}

/** A flat grey smoke puff: opaque blob with an ink rim. Toon smoke is solid, never a haze. */
function puff(scale: number, color = SMOKE, rim = 1.16): THREE.Object3D {
  const blob = solid("blob", color, rim);
  blob.scale.setScalar(scale);
  return blob;
}

/** Chunky debris: `count` ink-rimmed tetrahedra thrown out on parabolas from the centre. `t` is
 *  the life fraction; chips fly, arc and land (then shrink away). */
function chips(count: number, cx: number, cy: number, cz: number, reach: number, t: number, color: number, seed: number, size = 1, up = 1.2): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = seed * 0.37 + i * (Math.PI * 2 / count) + unit(seed, i) * 0.5;
    const r = reach * (0.6 + unit(seed, i + 7) * 0.5);
    const fly = Math.min(1, t * 1.25);
    const y = cy + up * (0.4 + unit(seed, i + 3) * 0.5) * Math.sin(Math.min(1, fly) * Math.PI) * (1 - fly * 0.35);
    const scale = size * (0.9 + unit(seed, i + 11) * 0.5) * (t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25);
    if (scale <= 0.03) continue;
    const chip = solid("shard", color, 1.35);
    chip.position.set(cx + Math.cos(a) * r * fly, y, cz + Math.sin(a) * r * fly);
    chip.rotation.set(t * 9 + i, a, t * 6);
    chip.scale.setScalar(scale);
    out.push(chip);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// In-flight models. Local +Y = direction of travel (set by orientAlongVelocity).

function tracerModel(family: ProjectileFamily, age: number, seed: number): THREE.Group {
  const group = new THREE.Group();
  // COMET: a hot round head leading a short ink-rimmed streak. The streak is three hulls — white
  // core, colour sleeve, ink — so the middle always shows through.
  const alt = family === "mg" && seed % 2 === 0;
  // Warm, never team colour: a cyan comet read as a laser. The team read lives on the unit.
  const sleeveColor = alt ? TRACER_ALT : TRACER;
  const core = new THREE.Mesh(projectileGeometry("tracer"), fxSolid(HOT));
  const sleeve = new THREE.Mesh(projectileGeometry("tracer"), fxSolid(sleeveColor, true));
  const rim = new THREE.Mesh(projectileGeometry("tracer"), fxSolid(INK, true));
  core.frustumCulled = sleeve.frustumCulled = rim.frustumCulled = false;
  sleeve.scale.set(1.8, 1.04, 1.8);
  rim.scale.set(2.5, 1.1, 2.5);
  const streak = new THREE.Group();
  streak.add(rim, sleeve, core);
  streak.scale.y = 1.5; // a dash, not a bead: the streak carries the read, the head only tips it
  streak.position.y = -0.16;
  const head = solid("ember", HOT, 1.7, sleeveColor);
  head.scale.setScalar(1.05);
  head.position.y = 0.2;
  const headRim = new THREE.Mesh(projectileGeometry("ember"), fxSolid(INK, true));
  headRim.scale.setScalar(2.3);
  headRim.frustumCulled = false;
  head.add(headRim);
  group.add(streak, head);
  switch (family) {
    case "mg": group.scale.set(1.05, 1.3, 1.05); break;
    case "carbine": group.scale.set(0.85, 0.9, 0.85); break;
    case "pistol": group.scale.set(0.95, 0.62, 0.95); break;
    case "sniper": group.scale.set(1.1, 2.1, 1.1); break;
    default: group.scale.set(1, 1, 1);
  }
  // A short flicker in the core keeps a stationary-looking tracer alive across frames.
  core.scale.y = 1 + Math.sin(age * 40) * 0.06;
  return group;
}

function pelletModel(team: number, seed: number): THREE.Group {
  const group = new THREE.Group();
  const p = solid("pellet", HOT, 1.6, team);
  const rim = new THREE.Mesh(projectileGeometry("pellet"), fxSolid(INK, true));
  rim.scale.setScalar(2.2);
  rim.frustumCulled = false;
  p.add(rim);
  p.scale.setScalar(1.05);
  // A smaller satellite pellet riding beside each round, offset by the round's own seed, so five
  // sim pellets read as a fan of ten and the fan has depth.
  const sat = solid("pellet", HOT, 1.6, team);
  const satRim = new THREE.Mesh(projectileGeometry("pellet"), fxSolid(INK, true));
  satRim.scale.setScalar(2.2);
  satRim.frustumCulled = false;
  sat.add(satRim);
  sat.scale.setScalar(0.7);
  const a = unit(seed, 2) * Math.PI * 2;
  sat.position.set(Math.cos(a) * 0.16, -0.14 - unit(seed, 5) * 0.12, Math.sin(a) * 0.16);
  group.add(p, sat);
  group.scale.set(1, 1.35, 1);
  return group;
}

function shellModel(family: ProjectileFamily, team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  const heavy = family === "artillery";
  const blunt = family === "siege";
  const body = rimmed("shell-body", STEEL, [1.28, 1.08, 1.28]);
  const nose = rimmed("shell-nose", HOT, [1.3, 1.18, 1.3]);
  nose.position.y = 0.34;
  if (blunt) { nose.scale.set(1.3, 0.62, 1.3); nose.position.y = 0.28; }
  const band = new THREE.Mesh(projectileGeometry("shell-band"), fxSolid(team));
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.12;
  band.frustumCulled = false;
  const finCount = heavy ? 6 : 4;
  for (let i = 0; i < finCount; i += 1) {
    const angle = (i / finCount) * Math.PI * 2;
    const fin = rimmed("shell-fin", 0x26302c, [1.6, 1.12, 1.1]);
    fin.position.set(Math.cos(angle) * 0.14, -0.16, Math.sin(angle) * 0.14);
    fin.rotation.y = Math.PI / 2 - angle; // long axis radial
    group.add(fin);
  }
  // Exhaust: a fat orange blob flickering off the base, and the tracer glow behind it.
  const exhaust = solid("blob", FIRE[1], 1.2, FIRE[3]);
  exhaust.position.y = -0.36;
  exhaust.scale.set(0.5, 0.7 + Math.sin(age * 36) * 0.16, 0.5);
  group.add(body, nose, band, exhaust);
  group.rotation.y = age * (heavy ? 5 : 10); // spin-stabilised
  group.scale.setScalar(0.95 * (heavy ? 1.3 : blunt ? 1.12 : 1));
  return group;
}

function grenadeModel(team: number, age: number, rolling: boolean): THREE.Group {
  const group = new THREE.Group();
  const tumble = new THREE.Group();
  const body = solid("grenade-body", OLIVE, 1.22);
  body.scale.set(0.9, 1.08, 0.9);
  const band = new THREE.Mesh(projectileGeometry("grenade-band"), fxSolid(team));
  band.rotation.x = Math.PI / 2;
  band.frustumCulled = false;
  const cap = solid("ember", 0xc9a55a, 1.5);
  cap.position.y = 0.2;
  cap.scale.setScalar(1.3);
  // Armed-fuse blink: a red pip strobing, with a spark spike while it is lit — "live ordnance".
  const lit = Math.sin(age * 26) > 0;
  const fuse = solid("ember", lit ? 0xff3b30 : 0x5a1a14, 1.4);
  fuse.position.set(0, 0.24, 0.08);
  fuse.scale.setScalar(1.25);
  tumble.add(body, band, cap, fuse);
  if (lit) {
    const spark = starburst(3, 0.22, 0.4, FLASH, FLASH_RIM, 0, age * 3, 0.6);
    spark.position.set(0, 0.28, 0.08);
    tumble.add(spark);
  }
  // Tumble end over end in flight; roll about the travel axis on the ground.
  if (rolling) tumble.rotation.x = age * 10;
  else { tumble.rotation.x = age * 7.5; tumble.rotation.z = age * 2.6; }
  group.add(tumble);
  group.scale.setScalar(rolling ? 1.15 : 1.4);
  return group;
}

function launcherModel(team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  const body = rimmed("launcher-body", STEEL, [1.3, 1.1, 1.3]);
  const nose = solid("launcher-nose", BRASS, 1.24);
  nose.position.y = 0.16;
  const band = new THREE.Mesh(projectileGeometry("shell-band"), fxSolid(team));
  band.scale.setScalar(0.72);
  band.rotation.x = Math.PI / 2;
  band.position.y = -0.04;
  band.frustumCulled = false;
  const exhaust = solid("blob", FIRE[1], 1.2, FIRE[3]);
  exhaust.position.y = -0.22;
  exhaust.scale.set(0.3, 0.45 + Math.sin(age * 40) * 0.12, 0.3);
  group.add(body, nose, band, exhaust);
  group.rotation.y = age * 14;
  group.scale.setScalar(1.3);
  return group;
}

function mortarModel(family: ProjectileFamily, team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  const smoke = family === "smoke";
  const body = rimmed("mortar-body", smoke ? SMOKE_LIGHT : OLIVE, [1.26, 1.14, 1.26]);
  const band = new THREE.Mesh(projectileGeometry("shell-band"), fxSolid(smoke ? 0xf2efe6 : team));
  band.rotation.x = Math.PI / 2;
  band.position.y = -0.02;
  band.frustumCulled = false;
  const tip = solid("ember", smoke ? 0xf2efe6 : HOT, 1.5);
  tip.position.y = 0.3;
  tip.scale.setScalar(1.4);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const fin = rimmed("shell-fin", 0x26302c, [1.6, 1.12, 1.1]);
    fin.position.set(Math.cos(angle) * 0.11, -0.24, Math.sin(angle) * 0.11);
    fin.rotation.y = Math.PI / 2 - angle;
    fin.scale.set(0.8, 0.8, 0.7);
    group.add(fin);
  }
  group.add(body, band, tip);
  group.rotation.y = age * 3; // slow spin about its own axis; the nose follows the arc
  group.scale.setScalar(1.5);
  return group;
}

/** An aircraft bomb: a fat finned barrel that wobbles nose-over as it falls. */
function bombModel(team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  const body = rimmed("shell-body", 0x2c3330, [1.24, 1.08, 1.24]);
  body.scale.set(1.5, 1.35, 1.5);
  const nose = rimmed("shell-nose", 0x3a4542, [1.3, 1.18, 1.3]);
  nose.position.y = 0.42;
  nose.scale.set(1.5, 0.8, 1.5);
  const stripe = new THREE.Mesh(projectileGeometry("shell-band"), fxSolid(team));
  stripe.rotation.x = Math.PI / 2;
  stripe.position.y = 0.16;
  stripe.scale.setScalar(1.45);
  stripe.frustumCulled = false;
  const tail = new THREE.Mesh(projectileGeometry("shell-band"), fxSolid(FLASH));
  tail.rotation.x = Math.PI / 2;
  tail.position.y = -0.3;
  tail.scale.setScalar(1.3);
  tail.frustumCulled = false;
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const fin = rimmed("shell-fin", 0x26302c, [1.6, 1.12, 1.1]);
    fin.position.set(Math.cos(angle) * 0.17, -0.3, Math.sin(angle) * 0.17);
    fin.rotation.y = Math.PI / 2 - angle;
    fin.scale.set(1.1, 1.2, 1.1);
    group.add(fin);
  }
  group.add(body, nose, stripe, tail);
  // Tumble: a slow nose-over wobble on top of the velocity orientation, plus a roll.
  group.rotation.x = Math.sin(age * 4) * 0.35;
  group.rotation.y = age * 2.5;
  group.scale.setScalar(1.55);
  return group;
}

function flameHead(age: number): THREE.Group {
  const group = new THREE.Group();
  const core = solid("blob", FIRE[0], 0);
  const sleeve = new THREE.Mesh(projectileGeometry("blob"), fxSolid(FIRE[1], true));
  const rim = new THREE.Mesh(projectileGeometry("blob"), fxSolid(FIRE[3], true));
  sleeve.scale.setScalar(1.45);
  rim.scale.setScalar(1.8);
  sleeve.frustumCulled = rim.frustumCulled = false;
  group.add(rim, sleeve, core);
  const wobble = 1 + Math.sin(age * 28) * 0.12;
  group.scale.set(wobble * 0.95, 1.05, 0.95 / wobble);
  return group;
}

/** The round itself, at the projectile's current position. */
export function makeProjectileModel(p: Projectile, family: ProjectileFamily): THREE.Group {
  const team = p.color;
  const seed = seedOf(p.id);
  switch (family) {
    case "tank": case "artillery": case "siege": return shellModel(family, team, p.age);
    case "grenade": return grenadeModel(team, p.age, p.state === "rolling");
    case "launcher": return launcherModel(team, p.age);
    case "mortar": case "smoke": return mortarModel(family, team, p.age);
    case "bomb": return bombModel(team, p.age);
    case "flame": return flameHead(p.age);
    case "pellet": return pelletModel(team, seed);
    case "sniper": return p.age < SNIPER_PAUSE ? new THREE.Group() : tracerModel(family, p.age, seed);
    default: return tracerModel(family, p.age, seed);
  }
}

// ---------------------------------------------------------------------------------------------
// Trails

/** The marksman holds a half-beat at the muzzle (ripple ring, no round) before the round leaves. */
export const SNIPER_PAUSE = 0.11;

/** Everything a round drags behind it, from its position history (newest last). */
export function makeProjectileTrail(p: Projectile, family: ProjectileFamily, history: readonly TrailPoint[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const n = history.length;
  const head = { x: p.position.x, y: p.height, z: p.position.z };
  // The marksman's round is a long tracer with a pale VAPOUR trail -- the old solid lance from
  // muzzle to target was a laser beam in a game where every other gun fires bullets.
  if (family === "sniper" && p.age < SNIPER_PAUSE) return out;
  if (n < 1) return out;
  // Every element is placed by CONTINUOUS quantities: how long ago its sample was pushed (ease-in)
  // and how far behind the head it now sits (ease-out, growth, colour). Nothing keys on the array
  // index — the array rolls every push, and an index-keyed size or phase pops between two frames.
  const step = trailStep(family);
  const reach = trailReach(family);
  const behind: number[] = new Array(n);
  let acc = 0;
  let px = head.x, py = head.y, pz = head.z;
  for (let i = n - 1; i >= 0; i -= 1) {
    const pt = history[i];
    acc += Math.hypot(pt.x - px, pt.y - py, pt.z - pz);
    behind[i] = acc;
    px = pt.x; py = pt.y; pz = pt.z;
  }
  const easeIn = (pt: TrailPoint): number => smooth((p.age - pt.born) / EASE_IN);
  if (family === "flame") {
    // FIRE STREAM: fat blobs grow out of the nozzle, stretch into tongues that lick upward, then
    // darken and curl into small grey puffs that rise off the line and shrink away. Growth and
    // colour follow distance behind the head; the puffs rise with their own age, so nothing hangs
    // at head height after the round has passed, and a puff is never more than ~0.4 of the head.
    for (let i = n - 1; i >= 0; i -= 1) {
      const pt = history[i];
      const k = behind[i] / step; // 0 at the head, ~8 at the tail
      const stage = Math.min(FIRE.length - 1, Math.floor(k));
      const age = p.age - pt.born;
      const flick = 1 + Math.sin(p.age * 20 + pt.seq * 1.9) * 0.1;
      // Grow to k=3, shrink through the dark-red stage to the puff size by k=5, then ease out.
      const body = k < 3 ? 0.5 + k * 0.23 : k < 5 ? 1.19 - (k - 3) * 0.37 : 0.45;
      const scale = body * flick * easeIn(pt) * easeOut(behind[i], reach);
      if (scale < 0.04) continue;
      const smoke = k >= 5;
      const rise = smoke ? Math.min(0.9, (k - 5) * 0.2) + age * 0.35 : k * 0.03;
      const jx = Math.sin(p.age * 9 + pt.seq * 2.3) * 0.08;
      const jz = Math.cos(p.age * 7 + pt.seq * 1.3) * 0.08;
      const blob = solid("blob", FIRE[stage], 1.2, smoke ? INK : FIRE[Math.min(FIRE.length - 3, stage + 2)]);
      blob.position.set(pt.x + jx, pt.y + rise, pt.z + jz);
      blob.scale.setScalar(scale);
      blob.rotation.set(pt.seq * 1.1, p.age * 2, pt.seq * 0.7);
      out.push(blob);
      if (k >= 1.5 && k < 4.6 && pt.seq % 2 === 0) {
        // Tongues: a cone licking up and off the blob, the flame's edge curling. One per OTHER
        // sample — two on every sample cost four times the draw calls and read identically.
        const tongueLife = Math.min(1, (k - 1.5) / 0.5) * Math.min(1, (4.6 - k) / 0.6);
        for (let c = 0; c < 1; c += 1) {
          const tongue = solid("tongue", FIRE[Math.max(0, stage - 1)], 1.3, FIRE[Math.min(4, stage + 1)]);
          const lean = Math.sin(p.age * 16 + pt.seq * 2.1 + c * 2.4) * 0.5;
          _d.set(lean, 1, Math.cos(p.age * 11 + pt.seq + c * 1.7) * 0.45).normalize();
          tongue.quaternion.setFromUnitVectors(UP, _d);
          tongue.position.set(pt.x + jx + (c ? -0.12 : 0.12), pt.y + rise + scale * 0.1, pt.z + jz + (c ? 0.1 : -0.1));
          const ts = scale * tongueLife;
          tongue.scale.set(ts * 0.8, ts * (0.9 + Math.sin(p.age * 24 + pt.seq + c) * 0.25), ts * 0.8);
          out.push(tongue);
        }
      }
    }
    return out;
  }
  const tapered = family === "grenade" || family === "launcher" || family === "bomb" ? 0.45 : family === "pistol" || family === "carbine" ? 0.7 : 1;
  const trailColor = family === "mg" ? (seedOf(p.id) % 2 === 0 ? TRACER_ALT : TRACER) : family === "grenade" || family === "mortar" || family === "smoke" || family === "bomb" ? SMOKE_LIGHT : family === "launcher" ? BRASS : family === "sniper" ? SMOKE_LIGHT : TRACER;
  const lobbed = LOBBED.has(family);
  // Tapered ribbon from the HEAD back: fat and bright at the round, thin and faint at the tail.
  // The first segment runs head → newest sample, so it grows continuously instead of the ribbon
  // lagging a whole step behind the round; width and opacity follow distance, so a sample
  // rolling off the end is already invisible.
  const ribbonReach = lobbed && family !== "tank" ? step * 3 : reach;
  const width = family === "tank" || family === "artillery" || family === "siege" ? 2.2 : family === "mg" ? 1.5 : 1;
  let from: Point3 = head;
  let fromBehind = 0;
  let segments = 0;
  for (let i = n - 1; i >= 0 && segments < 5; i -= 1) {
    segments += 1;
    const to = history[i];
    const mid = (fromBehind + behind[i]) / 2;
    const u = clamp01(1 - mid / ribbonReach);
    if (u <= 0.02) break;
    const seg = tube(from, to, trailColor, q(0.8 * u * u), (0.012 + 0.04 * u * u) * tapered * width);
    if (seg) out.push(seg);
    from = to;
    fromBehind = behind[i];
  }
  if (family === "tank" && n >= 2) {
    // SABOT STREAK: a hard bright line over the round's last metre — the AP round is the fastest
    // thing on the board and its trail is a ruled line, not a ribbon. Grows from the head.
    let tail = history[n - 1];
    for (let i = n - 1; i >= 0 && behind[i] < 1.0; i -= 1) tail = history[i];
    const streak = solidTube(tail, head, HOT, 0.03, 0.055);
    if (streak) out.push(streak);
  }
  if (lobbed && family !== "grenade" && family !== "tank") {
    // Smoke ribbon behind a lobbed round: puffs hang where the round WAS, so they thin out behind
    // it in space rather than towing along. Every other SAMPLE (by its stable seq) carries a puff,
    // so the ribbon has gaps — a solid chain read as a caterpillar on the arc. A puff is born
    // small, swells with distance, rises with its age, and eases away by the reach.
    const puffScale = family === "artillery" ? 1.35 : family === "launcher" ? 0.7 : family === "bomb" ? 0.8 : 1;
    for (let i = n - 1; i >= 0; i -= 1) {
      const pt = history[i];
      if (pt.seq % 2) continue;
      const k = behind[i] / step;
      if (k < 1.2) continue;
      const age = p.age - pt.born;
      const swell = (0.28 + Math.min(k, 6) * 0.07) * puffScale * smooth((k - 1.2) / 1.0) * easeOut(behind[i], reach);
      if (swell < 0.04) continue;
      const s = puff(swell, (pt.seq >> 1) % 2 ? SMOKE : SMOKE_LIGHT);
      const side = ((pt.seq >> 1) % 2 ? 1 : -1) * (0.08 + k * 0.03);
      s.position.set(pt.x + Math.sin(pt.seq * 2.1) * side, pt.y + 0.05 + age * 0.25 + k * 0.03, pt.z + Math.cos(pt.seq * 1.7) * side);
      s.rotation.set(pt.seq * 0.9, pt.seq * 0.4 + age, 0);
      out.push(s);
    }
  }
  const descending = p.height < p.previousHeight - 0.01;
  if (descending && n >= 1 && (family === "mortar" || family === "artillery" || family === "siege" || family === "bomb" || family === "smoke")) {
    // WHISTLE-FALL: two thin white speed lines trailing the round as it noses down, flickering in
    // length, and the ground shadow (below) swelling under it. They grow with the descent rate so
    // the top of the arc eases them in.
    const fall = smooth((p.previousHeight - p.height) / 0.04);
    const prev = history[n - 1];
    _a.set(prev.x, prev.y, prev.z);
    _b.set(head.x, head.y, head.z);
    _d.subVectors(_b, _a).normalize();
    _side.crossVectors(_d, UP).normalize();
    for (const s of [-1, 1]) {
      const len = (0.9 + Math.sin(p.age * 30 + s) * 0.35) * fall;
      const off = 0.22 * (family === "bomb" ? 1.4 : 1);
      _a.copy(_b).addScaledVector(_side, s * off).addScaledVector(_d, -0.3);
      const end = _a.clone().addScaledVector(_d, -len);
      const line = bar(_a, end, HOT, 0.03 * fall + 0.004);
      if (line) out.push(line);
    }
  }
  return out;
}

/** Flat ground shadow under a round — shrinking and paling as it climbs, so an arc's height reads;
 *  swelling again under a shell coming down so the fall has a target. */
export function makeProjectileShadow(p: Projectile, family: ProjectileFamily): THREE.Mesh {
  const groundY = terrainHeightAt(p.position) + 0.028;
  const above = Math.max(0, p.height - groundY);
  const base = family === "artillery" || family === "bomb" ? 0.44 : family === "tank" || family === "siege" || family === "mortar" || family === "smoke" ? 0.36 : family === "grenade" || family === "launcher" ? 0.3 : family === "flame" ? 0.3 : family === "pellet" || family === "pistol" ? 0.18 : 0.24;
  const radius = [0.18, 0.24, 0.3, 0.36, 0.44].reduce((best, r) => Math.abs(r - base) < Math.abs(best - base) ? r : best, 0.24);
  const descending = LOBBED.has(family) && p.height < p.previousHeight - 0.01 && family !== "tank";
  const shrink = clamp01(1 - above * 0.05);
  // A falling shell's shadow grows as it closes on the ground: the last two metres are the
  // whistle-fall, and the blob under the target is the cue for where it lands.
  const swell = descending ? 1 + clamp01(1 - above / 6) * 0.9 : 1;
  const opacity = p.state === "rolling" ? 0.34 : Math.max(0.12, (descending ? 0.5 : 0.38) - above * 0.025);
  const shadow = new THREE.Mesh(shadowGeometry(radius), projectileMaterial("shadow", INK, q(opacity)));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(p.position.x, groundY, p.position.z);
  const s = 1.4 * (0.5 + shrink * 0.5) * swell;
  shadow.scale.set(s, s * 0.7, 1);
  shadow.frustumCulled = false;
  return shadow;
}

// ---------------------------------------------------------------------------------------------
// Muzzle events

export const MUZZLE_FLASH_TIME = 0.13;
const CASING_TIME = 0.6;

/** The flash at the barrel for the first frames of a round's life. Shape per family. */
export function makeMuzzleFlash(p: Projectile, family: ProjectileFamily): THREE.Object3D | undefined {
  if (family === "grenade" || family === "bomb") return undefined;
  const group = new THREE.Group();
  const seed = seedOf(p.id) % 9;
  const flashing = p.age <= MUZZLE_FLASH_TIME;
  const t = clamp01(p.age / MUZZLE_FLASH_TIME);
  // Pop: full size almost at once, then shrink away — a flash is a single frame of light.
  const pop = t < 0.2 ? 0.25 + (t / 0.2) * 0.75 : 1 - ((t - 0.2) / 0.8) * 0.9;
  if (family === "sniper") {
    // The half-beat: a ripple ring pulsing out of the muzzle while the round waits, then the round
    // leaves with two long petals. Nothing else on the board pauses before it fires.
    if (p.age < SNIPER_PAUSE + 0.1) {
      const u = clamp01(p.age / (SNIPER_PAUSE + 0.1));
      const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("muzzle-ring", HOT, q(0.95 - u * 0.7)));
      ring.scale.setScalar(0.5 + u * 1.7);
      ring.frustumCulled = false;
      group.add(ring);
      const ring2 = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("muzzle-ring", p.color, q(0.8 - u * 0.6)));
      ring2.scale.setScalar(0.3 + u * 1.2);
      ring2.frustumCulled = false;
      group.add(ring2);
    }
    if (p.age >= SNIPER_PAUSE && p.age < SNIPER_PAUSE + MUZZLE_FLASH_TIME) {
      const u = (p.age - SNIPER_PAUSE) / MUZZLE_FLASH_TIME;
      const f = petals(3, 0.5, 1.5, 0.55, FLASH, FLASH_RIM, 0.9);
      f.scale.setScalar(0.7 * (u < 0.25 ? 0.2 + u * 3.2 : 1 - (u - 0.25) * 1.25));
      group.add(f);
    }
  } else if (flashing) {
    switch (family) {
      case "rifle": case "carbine": case "pistol": {
        // Three flat petals fanned in the vertical plane of the shot, ink-free orange rim.
        const small = family === "pistol";
        group.add(petals(3, 1.5, small ? 0.6 : 0.85, small ? 0.6 : 0.75, FLASH, FLASH_RIM, 0.5));
        group.scale.setScalar(0.62 * pop);
        break;
      }
      case "mg": {
        // A different fan on every round — the rhythm of the burst is the flash changing shape.
        const shapes: [number, number][] = [[4, 1.9], [3, 1.3], [5, 2.2]];
        const [count, spread] = shapes[seed % shapes.length];
        group.add(petals(count, spread, 1.0, 0.8, FLASH, FLASH_RIM, 0.55));
        group.rotation.y = (seed % 3 - 1) * 0.4; // slew the fan so consecutive rounds don't stack
        group.scale.setScalar(0.72 * pop);
        break;
      }
      case "pellet": {
        // Scattergun: a wide flat cone of seven petals leaning forward, wider than it is long.
        group.add(petals(7, 2.3, 0.75, 0.7, FLASH, FLASH_RIM, 0.35));
        group.scale.setScalar(0.72 * pop);
        break;
      }
      case "flame": {
        // Ignition: a yellow blob that the stream grows out of.
        const blob = solid("blob", FIRE[1], 1.3, FIRE[3]);
        blob.scale.setScalar(0.7 * pop);
        group.add(blob);
        break;
      }
      case "tank": case "artillery": case "siege": {
        const big = family === "artillery";
        group.add(starburst(8, 1.5, 0.95, FLASH, FLASH_RIM, 3.6, seed));
        // A flat smoke ring blown out of the muzzle brake, expanding through the flash's life.
        const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("muzzle-ring", SMOKE_LIGHT, q(0.7 - t * 0.5)));
        ring.scale.setScalar(1.2 + t * 2.6);
        ring.frustumCulled = false;
        group.add(ring);
        group.scale.setScalar((big ? 1.2 : 1.0) * pop);
        break;
      }
      case "launcher": case "mortar": case "smoke": {
        const s = puff(0.5 * pop + t * 0.4, SMOKE_LIGHT);
        group.add(s);
        if (family === "launcher") group.add(starburst(4, 0.5, 0.6, FLASH, FLASH_RIM, 0.9, seed));
        group.scale.setScalar(0.85);
        break;
      }
    }
  }
  // BRASS: a casing kicked out of the ejection port, arcing up and to the right of the barrel and
  // tumbling as it falls. One per round, so an MG burst pours a stream of them.
  if (isSmallArms(family) && p.age < CASING_TIME && !(family === "sniper" && p.age < SNIPER_PAUSE)) {
    const u = family === "sniper" ? (p.age - SNIPER_PAUSE) / CASING_TIME : p.age / CASING_TIME;
    const casing = solid("casing", family === "pellet" ? SHOTSHELL : BRASS, 1.9);
    // Local frame: +Y along the shot, +X to its right. The casing leaves at 0.3 back from the muzzle.
    const sideways = 0.25 + u * 1.1;
    const lift = 0.1 + 2.2 * u - 5.2 * u * u;
    casing.position.set(sideways, -0.35 - u * 0.2, lift);
    casing.rotation.set(u * 18 + seed, u * 7, u * 12);
    casing.scale.setScalar((family === "pellet" ? 1.6 : family === "mg" || family === "sniper" ? 1.35 : 1.1) * Math.min(1, (1 - u) * 5));
    group.add(casing);
  }
  if (group.children.length === 0) return undefined;
  group.position.set(p.origin.x, p.originHeight, p.origin.z);
  // Local +Y is the shot axis for every fan above; local +Z is up-ish so casings arc upward.
  _d.set(p.direction.x, p.verticalSlope, p.direction.z).normalize();
  group.quaternion.setFromUnitVectors(UP, _d);
  // Petal fans live in local XY: spin the group about the shot axis so that plane stands vertical
  // (the fan reads as a flat flash from the tactical camera, not as a disc seen edge-on).
  _side.set(0, 0, 1).applyQuaternion(group.quaternion);
  const roll = Math.atan2(_side.y, Math.hypot(_side.x, _side.z));
  group.rotateY(-roll); // local Y is the axis: a rotateY rolls the fan about the shot line
  group.traverse((o) => { o.frustumCulled = false; });
  return group;
}

// ---------------------------------------------------------------------------------------------
// Impacts

/** Direction the round was travelling when it landed (unit XZ), when the renderer knows it. */
export interface LandingHint { family: ProjectileFamily; dirX: number; dirZ: number }

/** A round striking a body: a hard little star at the hit point, sized by the effect radius, in
 *  the shape of the family that fired it. */
export function makeImpact(effect: VisualEvent, t: number, ground: number, hint?: LandingHint): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const size = Math.max(0.4, effect.radius ?? 0.5);
  const seed = seedOf(effect.id);
  const family = hint?.family;
  const cx = effect.to.x;
  const cz = effect.to.z;
  const hitY = ground + 0.9;
  // Star pops to full size in the first fifth and shrinks away over the rest.
  const pop = t < 0.14 ? 0.15 + (t / 0.14) * 0.85 : Math.max(0, 1 - (t - 0.14) / 0.86);
  const burn = effect.color === 0xff7a2a || family === "flame";
  if (burn) {
    // THE TARGET CATCHES: three flame tongues flickering up the body and a ring of embers at the
    // feet — never a white flash on a burn.
    for (let i = 0; i < 3; i += 1) {
      const tongue = solid("tongue", i === 1 ? FIRE[0] : FIRE[1], 1.3, FIRE[3]);
      const lean = Math.sin(t * 26 + i * 2.1 + seed) * 0.45;
      _d.set(lean, 1, Math.cos(t * 19 + i * 1.3) * 0.4).normalize();
      tongue.quaternion.setFromUnitVectors(UP, _d);
      const a = seed * 0.3 + i * 2.1;
      tongue.position.set(cx + Math.cos(a) * 0.28, ground + 0.35 + i * 0.28, cz + Math.sin(a) * 0.28);
      const s = size * (0.9 + Math.sin(t * 31 + i) * 0.25) * (t < 0.8 ? 1 : 1 - (t - 0.8) * 5);
      tongue.scale.set(s * 0.8, s * 1.2, s * 0.8);
      out.push(tongue);
    }
    const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("impact-ring", FIRE[2], q((1 - t) * 0.6)));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, ground + 0.06, cz);
    ring.scale.setScalar(size * (0.7 + t * 1.2));
    out.push(ring);
    for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
    return out;
  }
  if (pop > 0.02) {
    {
      // CARTOON STAR BURST: a flat six-point star facing the camera, plus two or three chunky
      // sparks flying back toward the shooter.
      const punch = family === "sniper";
      const star = cutout(punch ? "star4" : "star6", HOT, size * (punch ? 0.7 : 0.5) * pop, effect.color === 0xffd166 ? FLASH_RIM : INK, seed * 0.4);
      star.position.set(cx, hitY, cz);
      faceViewer(star);
      out.push(star);
      const back = hint ? { x: -hint.dirX, z: -hint.dirZ } : { x: Math.cos(seed), z: Math.sin(seed) };
      const sparks = family === "mg" ? 3 : 2 + (seed % 2);
      for (let i = 0; i < sparks; i += 1) {
        const spread = (i - (sparks - 1) / 2) * 0.55;
        const dx = back.x * Math.cos(spread) - back.z * Math.sin(spread);
        const dz = back.x * Math.sin(spread) + back.z * Math.cos(spread);
        const fly = Math.min(1, t * 1.6);
        const r = size * 1.1 * fly;
        const spark = solid("spike", FLASH, 1.5, FLASH_RIM);
        _d.set(dx, 0.5 - fly * 1.2, dz).normalize();
        spark.quaternion.setFromUnitVectors(UP, _d);
        spark.position.set(cx + dx * r, hitY + 0.3 * Math.sin(fly * Math.PI), cz + dz * r);
        spark.scale.set(0.8, 0.9 * (1 - fly * 0.5), 0.8);
        out.push(spark);
      }
      if (punch && hint) {
        // PUNCH-THROUGH: two sparks blown out of the far side -- the round kept going.
        const fly = Math.min(1, t * 1.6);
        for (const off of [-0.25, 0.25]) {
          const spark = solid("spike", FLASH, 1.5, FLASH_RIM);
          _d.set(hint.dirX + off * hint.dirZ, 0.2, hint.dirZ - off * hint.dirX).normalize();
          spark.quaternion.setFromUnitVectors(UP, _d);
          spark.position.set(cx + _d.x * size * 1.4 * fly, hitY, cz + _d.z * size * 1.4 * fly);
          spark.scale.set(0.9, 1.1 * (1 - fly * 0.5), 0.9);
          out.push(spark);
        }
      }
    }
  }
  // A thin ground ring pushed out from the feet.
  const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("impact-ring", effect.color, q((1 - t) * 0.5)));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cx, ground + 0.06, cz);
  ring.scale.setScalar(size * (0.6 + t * 1.4));
  out.push(ring);
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** A small-arms round hitting the ground: a dust puff and pebble chips. The renderer draws this
 *  on its own clock where a tracer ended with no impact event — an MG burst chews the ground in
 *  a line, a stray pellet kicks dirt. `t` is 0..1 over `GROUND_CHEW_S`. */
export const GROUND_CHEW_S = 0.45;
export function makeGroundChew(x: number, z: number, t: number, ground: number, seed: number, size = 1): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const s = size * (t < 0.3 ? t * 3.3 : 1 - (t - 0.3) * 1.3);
  if (s > 0.05) {
    const p = puff(s * 0.55, DUST, 1.2);
    p.position.set(x, ground + 0.12 + t * 0.25 * size, z);
    p.rotation.set(seed, t * 2, seed * 0.3);
    out.push(p);
  }
  out.push(...chips(2, x, ground + 0.05, z, 0.55 * size, t, PEBBLE, seed, 0.8, 0.7));
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** An explosion: POW star → spiky fireball + debris → solid smoke, plus the ground ring. `effect.radius`
 *  is the sim's blast radius in world units; the `blob` geometry is 0.22 wide, so shape scales carry a
 *  ~/0.22 factor to make the fireball fill roughly half the damage radius. Shape per family: a
 *  shell lands a multi-ring blast with a dust crown; an AP round a sharp cone with a metal-spark
 *  fan; a burn zone catches with tongues, never a white flash. */
export function makeBlast(effect: VisualEvent, t: number, ground: number, hint?: LandingHint): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const radius = effect.radius ?? 1;
  const R = radius / 0.22; // blob scale that spans the blast radius
  const lift = Math.min(radius, 1.3); // how high the column climbs — a wide blast is not a tall one
  const seed = seedOf(effect.id) % 11;
  const cx = effect.to.x;
  const cz = effect.to.z;
  const family = hint?.family;
  const burn = effect.color === 0xff7a2a;
  const shell = family === "mortar" || family === "artillery" || family === "siege" || family === "bomb";
  const ap = family === "tank";
  if (burn) {
    // FIRE CATCHES: a low ring of tongues licking up out of the ground, orange puffs above them,
    // no white frame at all. The lingering burn zone is drawn elsewhere; this is the ignition.
    const tongues = 5;
    for (let i = 0; i < tongues; i += 1) {
      const a = seed * 0.7 + i * (Math.PI * 2 / tongues);
      const r = radius * 0.45 * (0.5 + t * 0.5);
      const tongue = solid("tongue", i % 2 ? FIRE[1] : FIRE[0], 1.3, FIRE[3]);
      const lean = Math.sin(t * 24 + i * 1.7) * 0.4;
      _d.set(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize();
      tongue.quaternion.setFromUnitVectors(UP, _d);
      tongue.position.set(cx + Math.cos(a) * r, ground + 0.05, cz + Math.sin(a) * r);
      const s = radius * 0.9 * (t < 0.5 ? 0.6 + t * 0.8 : 1 - (t - 0.5) * 1.6) * (1 + Math.sin(t * 30 + i) * 0.2);
      if (s > 0.05) { tongue.scale.set(s * 0.7, s, s * 0.7); out.push(tongue); }
    }
    if (t > 0.15) {
      const life = (t - 0.15) / 0.85;
      const scale = life < 0.5 ? 0.5 + life : 1 - (life - 0.5) * 1.8;
      for (let i = 0; i < 3 && scale > 0.05; i += 1) {
        const a = seed * 0.9 + i * 2.1;
        const s = puff(R * 0.26 * scale, i === 1 ? FIRE[3] : FIRE[4], 1.16);
        s.position.set(cx + Math.cos(a) * radius * 0.3, ground + 0.3 + life * lift * 0.7 + i * 0.15, cz + Math.sin(a) * radius * 0.3);
        out.push(s);
      }
    }
    const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("blast-ring", FIRE[2], q((1 - t) * 0.7)));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, ground + 0.07, cz);
    ring.scale.setScalar(radius * (0.4 + t * 2.0));
    out.push(ring);
    for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
    return out;
  }
  // 1. POW: a flat eight-point star facing the camera for the first frames — the cartoon "bang"
  //    with no letters in it. It IS the flash frame (a rim-less white ball popped to full size in
  //    one frame and read as a splotch).
  if (t < 0.2 && !ap) {
    const u = t / 0.2;
    const star = cutout("star8", HOT, radius * (0.5 + u * 0.28) * (1 - u * 0.45) * smooth(u / 0.25), FLASH_RIM, seed * 0.5 + u * 0.6);
    star.position.set(cx, ground + lift * 0.55, cz);
    faceViewer(star);
    out.push(star);
  }
  if (ap && hint) {
    // ARMOUR-PIERCING HIT: a sharp cone of light driven on through the hit point along the shot,
    // and a fan of metal sparks thrown back at the gun. Short and hard; the smoke is brief.
    const pop = t < 0.1 ? 0.1 + (t / 0.1) * 0.9 : Math.max(0, 1 - (t - 0.1) / 0.8);
    if (pop > 0.02) {
      const cone = solid("spike", HOT, 1.35, FLASH_RIM);
      _d.set(hint.dirX, -0.15, hint.dirZ).normalize();
      cone.quaternion.setFromUnitVectors(UP, _d);
      cone.position.set(cx - hint.dirX * 0.2, ground + 0.8, cz - hint.dirZ * 0.2);
      cone.scale.set(radius * 2.3 * pop, radius * 3.8 * pop, radius * 2.3 * pop);
      out.push(cone);
      const fan = 7;
      for (let i = 0; i < fan; i += 1) {
        const spread = (i / (fan - 1) - 0.5) * 1.6;
        const dx = -hint.dirX * Math.cos(spread) + hint.dirZ * Math.sin(spread);
        const dz = -hint.dirX * Math.sin(spread) - hint.dirZ * Math.cos(spread);
        const fly = Math.min(1, t * 1.4);
        const r = radius * 1.3 * fly;
        const spark = solid("spike", SPARK, 1.5, STEEL);
        _d.set(dx, 0.7 - fly * 1.6, dz).normalize();
        spark.quaternion.setFromUnitVectors(UP, _d);
        spark.position.set(cx + dx * r, ground + 0.8 + 0.6 * Math.sin(fly * Math.PI), cz + dz * r);
        spark.scale.set(1.2, 1.8 * (1 - fly * 0.4), 1.2);
        out.push(spark);
      }
    }
  }
  // 2. Fireball: a cluster of flat blobs that lifts and grows, stepping yellow → orange → dark,
  //    then shrinks into the smoke. Spikes fly out of it for the first third.
  if (t < 0.6) {
    const life = t / 0.6;
    const stage = life < 0.3 ? 1 : life < 0.6 ? 2 : 3;
    const grow = life < 0.45 ? 0.15 + life * 1.85 : 1 - (life - 0.45) * 1.7;
    const blobs = ap ? 3 : 5;
    for (let i = 0; i < blobs; i += 1) {
      const a = seed * 0.7 + i * 1.05;
      const r = radius * 0.36 * (i === 0 ? 0 : 1) * (0.5 + life);
      const blob = solid("blob", FIRE[stage], 1.16, FIRE[Math.min(4, stage + 2)]);
      blob.position.set(cx + Math.cos(a) * r, ground + lift * 0.3 + life * lift * 0.6 + (i === 0 ? lift * 0.25 : (i % 2) * lift * 0.2), cz + Math.sin(a) * r);
      blob.scale.setScalar(R * (i === 0 ? 0.55 : 0.34) * grow * (ap ? 0.7 : 1));
      blob.rotation.set(i, a, seed);
      out.push(blob);
    }
    if (t < 0.28) {
      // Spike geometry is 0.34 long, so length is in spike-scale units: ~1.7x the radius.
      const star = starburst(shell ? 7 : 5, R * 0.68, R * 0.18, FIRE[0], FIRE[2], 0, seed * 0.5, 0.35);
      star.scale.setScalar(0.5 + (t / 0.28) * 0.6);
      star.position.set(cx, ground + lift * 0.35, cz);
      out.push(star);
    }
  }
  // 3. Debris: chunky chips thrown out on parabolas and landing around the crater.
  out.push(...chips(shell ? 6 : ap ? 3 : 4, cx, ground + 0.2, cz, radius * (shell ? 1.3 : 1.0), t, shell ? DUST_DARK : 0x4a4038, seed + 3, radius * 1.05, lift * 1.3));
  // 4. Smoke: solid grey puffs rising off the fireball, largest mid-life, shrinking away.
  if (t > 0.22) {
    const life = (t - 0.22) / 0.78;
    const scale = life < 0.45 ? 0.55 + life : 1 - (life - 0.45) * 1.7;
    if (scale > 0.03) {
      for (let i = 0; i < (ap ? 2 : 4); i += 1) {
        const a = seed * 0.9 + i * 1.26 + 0.4;
        const r = radius * 0.34 * (0.4 + life);
        const s = puff(R * (i % 2 ? 0.3 : 0.4) * scale, i % 2 ? SMOKE : SMOKE_LIGHT);
        s.position.set(cx + Math.cos(a) * r, ground + lift * 0.35 + life * lift * 1.0 + i * lift * 0.08, cz + Math.sin(a) * r);
        s.rotation.set(i * 0.8, a, 0);
        out.push(s);
      }
    }
  }
  // 5. Ground rings: the shockwave line racing outward, thinning as it goes. A shell lands three of
  //    them in sequence, and a DUST CROWN — a ring with volume — lifts off the ground behind them.
  const rings = shell ? 3 : 1;
  for (let i = 0; i < rings; i += 1) {
    const tt = clamp01((t - i * 0.14) / (1 - i * 0.14));
    if (t < i * 0.14) continue;
    const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("blast-ring", i === 1 ? DUST : effect.color, q((1 - tt) * 0.8)));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, ground + 0.07 + i * 0.004, cz);
    ring.scale.setScalar(radius * (0.4 + tt * 2.4) * (1 - i * 0.18));
    out.push(ring);
  }
  if (shell && t > 0.06) {
    const u = clamp01((t - 0.06) / 0.94);
    const crown = solid("crown", DUST, 1.25);
    crown.rotation.x = Math.PI / 2;
    crown.position.set(cx, ground + 0.25 + Math.sin(u * Math.PI) * lift * 0.35, cz);
    const spread = radius * (0.6 + u * 1.3);
    crown.scale.set(spread, spread, 0.8 + Math.sin(u * Math.PI) * 1.6);
    out.push(crown);
  }
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** What lingers after the sim's blast has ended: the smoke column (two or three stacked blobs
 *  rising and shrinking) and, for a shell, the dust crown settling. `u` is 0..1 over
 *  `blastAfterlife(family)` seconds, on the renderer's own resolve-paced clock. */
export function blastAfterlife(family: ProjectileFamily | undefined, burn: boolean): number {
  if (burn) return 0;
  if (family === "tank") return 0.7;
  if (family === "mortar" || family === "artillery" || family === "siege" || family === "bomb") return 1.7;
  return 1.4;
}
export function makeBlastAfterlife(effect: VisualEvent, u: number, ground: number, hint?: LandingHint): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const radius = effect.radius ?? 1;
  const R = radius / 0.22;
  const lift = Math.min(radius, 1.3);
  const seed = seedOf(effect.id) % 11;
  const cx = effect.to.x;
  const cz = effect.to.z;
  const family = hint?.family;
  const shell = family === "mortar" || family === "artillery" || family === "siege" || family === "bomb";
  // The column: three blobs stacked, each born a beat after the last, drifting up and shrinking.
  const stack = shell ? 3 : 2;
  for (let i = 0; i < stack; i += 1) {
    const born = i * 0.16;
    if (u < born) continue;
    const life = (u - born) / (1 - born);
    const scale = life < 0.35 ? 0.15 + (life / 0.35) * 0.85 : Math.max(0, 1 - (life - 0.35) / 0.65);
    if (scale <= 0.03) continue;
    const s = puff(R * (0.34 - i * 0.05) * scale, i % 2 ? SMOKE : SMOKE_LIGHT);
    const drift = (i % 2 ? 1 : -1) * radius * 0.12 * life;
    s.position.set(cx + drift + Math.cos(seed + i) * radius * 0.1, ground + lift * 0.5 + i * lift * 0.32 + life * lift * 0.7, cz - drift + Math.sin(seed + i * 2) * radius * 0.1);
    s.rotation.set(i * 0.8 + life, seed, life * 0.5);
    out.push(s);
  }
  if (shell) {
    // The dust crown settles: wide, low, and thinning to nothing.
    const settle = 1 - u;
    if (settle > 0.05) {
      const crown = solid("crown", DUST, 1.25);
      crown.rotation.x = Math.PI / 2;
      crown.position.set(cx, ground + 0.16 + settle * 0.15, cz);
      const spread = radius * (1.9 + u * 0.5);
      crown.scale.set(spread, spread, settle * 0.9);
      out.push(crown);
    }
  }
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** LIGHTNING: a jagged bolt of ink-rimmed white bars from the sky with three forks, a ground flash
 *  and a scorch star. Every kink is rolled from the effect id, so each strike has its own shape and
 *  a restored save draws the same bolt. Two-frame life: the bars thin as `t` runs. */
export function makeLightning(effect: VisualEvent, t: number, ground: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const seed = seedOf(effect.id);
  const fade = t < 0.15 ? 1 : Math.max(0, 1 - (t - 0.15) / 0.5);
  const cx = effect.to.x;
  const cz = effect.to.z;
  const top = 26;
  if (fade > 0.02) {
    const kinks = 7;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= kinks; k += 1) {
      const f = k / kinks;
      const y = top - (top - ground) * f;
      const wander = (1 - f) * 1.4;
      pts.push(new THREE.Vector3(cx + (unit(seed, k) - 0.5) * wander * 2, y, cz + (unit(seed, k + 9) - 0.5) * wander * 2));
    }
    pts[kinks].set(cx, ground + 0.05, cz);
    for (let k = 1; k <= kinks; k += 1) {
      const seg = bar(pts[k - 1], pts[k], HOT, 0.09 * fade + 0.02, 1.9);
      if (seg) out.push(seg);
      const glow = bar(pts[k - 1], pts[k], ARC, 0.2 * fade + 0.04, 0);
      if (glow) out.push(glow);
    }
    // Three forks off the middle kinks, each two short segments angling away and down.
    for (let f = 0; f < 3; f += 1) {
      const k = 2 + f * 2;
      if (k >= kinks) break;
      const start = pts[k];
      const a = unit(seed, 20 + f) * Math.PI * 2;
      let prev = start;
      for (let s = 1; s <= 2; s += 1) {
        const next = new THREE.Vector3(start.x + Math.cos(a) * s * 1.3 + (unit(seed, 30 + f * 3 + s) - 0.5) * 0.6, start.y - s * 1.6, start.z + Math.sin(a) * s * 1.3 + (unit(seed, 40 + f * 3 + s) - 0.5) * 0.6);
        const seg = bar(prev, next, HOT, 0.05 * fade + 0.012, 1.9);
        if (seg) out.push(seg);
        prev = next;
      }
    }
  }
  // Ground flash: a hot disc that is there and gone, then the ring, then the scorch star.
  if (t < 0.22) {
    const disc = new THREE.Mesh(projectileGeometry("disc"), projectileMaterial("bolt-disc", HOT, q(0.95 - (t / 0.22) * 0.8)));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(cx, ground + 0.09, cz);
    disc.scale.setScalar(1.6 + t * 6);
    disc.frustumCulled = false;
    out.push(disc);
  }
  const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("bolt-ring", ARC, q((1 - t) * 0.8)));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cx, ground + 0.08, cz);
  ring.scale.setScalar(1.2 + t * 4.5);
  out.push(ring);
  out.push(...chips(4, cx, ground + 0.1, cz, 1.6, t, 0x3a3128, seed, 1.3, 1.6));
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** The scorch a strike leaves: a flat ink star on the ground. The renderer keeps it for the battle. */
export function makeScorchStar(effect: VisualEvent, ground: number, scale = 1): THREE.Mesh {
  const star = new THREE.Mesh(projectileGeometry("star8"), projectileMaterial("scorch-star", INK, 0.45));
  star.rotation.x = -Math.PI / 2;
  star.rotation.z = seedOf(effect.id) % 6;
  star.position.set(effect.to.x, ground + 0.015, effect.to.z);
  star.scale.setScalar(scale * 2.6);
  star.frustumCulled = false;
  return star;
}

/** A melee blow landing: a small hard starburst at the contact point (a blade is a line, never a
 *  fireball; the slash arc itself is drawn by the renderer). */
export function makeStrikeFlash(effect: VisualEvent, t: number, ground: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  if (t < 0.35) {
    const u = t / 0.35;
    const seed = seedOf(effect.id) % 7;
    const star = cutout("star4", HOT, 0.42 * (0.6 + u * 0.8) * (1 - u * 0.5), effect.color, seed * 0.4 + u);
    star.position.set(effect.to.x, ground + 0.95, effect.to.z);
    faceViewer(star);
    out.push(star);
  }
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** A generic marker pulse (overwatch, pickups, marks, captures): a flat ring plus a soft disc that
 *  pops and shrinks. Never a glowing ball — the old additive sphere read as a hit on anything. */
export function makePing(effect: VisualEvent, t: number, ground: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const radius = effect.radius ?? 0.45;
  const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("ping-ring", effect.color, q((1 - t) * 0.7)));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(effect.to.x, ground + 0.11, effect.to.z);
  ring.scale.setScalar(radius * (0.7 + t * 1.7));
  out.push(ring);
  if (t < 0.5) {
    const disc = new THREE.Mesh(projectileGeometry("disc"), projectileMaterial("ping-disc", effect.color, q((1 - t / 0.5) * 0.35)));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(effect.to.x, ground + 0.1, effect.to.z);
    disc.scale.setScalar(radius * (0.5 + t * 1.2));
    out.push(disc);
  }
  for (const o of out) o.frustumCulled = false;
  return out;
}
