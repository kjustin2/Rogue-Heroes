// PROJECTILE + IMPACT FX in the game's toon language.
//
// Every round, muzzle event and impact in the game is built here, in the same idiom as the units
// and hulls: flat posterised colour, a dark ink rim, bold silhouettes that read at tactical camera
// distance. The rim is an INVERTED HULL — the same pooled geometry drawn again with a BackSide
// material a little larger — so a shape's outline costs one extra draw call and no edge geometry.
// Layered hulls (white core → colour sleeve → ink) are what give a tracer its hot centre and a
// bolt its two-tone body without any additive blending.
//
// Rules that keep this cheap and inside the owner's FX budget:
// - Every geometry and material comes from a bounded cache (`projectileGeometry`,
//   `projectileMaterial`, `fxSolid`). Nothing here allocates a material per frame.
// - NormalBlending everywhere. The only additive light in a shot is the pooled flash light the
//   composition root already drives. Nothing here can stack toward white.
// - Fades are done by SHRINKING (toon smoke and fire die by getting smaller), never by dimming a
//   colour toward black.
// - Sizes are set against the tank hull (3.4 units) and a trooper (1.6 units): a shell must read
//   as a third of a barrel, a tracer as a bright dash a trooper could hold.
import * as THREE from "three";
import { clamp01 } from "../core/math";
import { isAirKind, type EntityKind } from "../game/damageModel";
import type { Projectile, VisualEvent } from "../game/sim";
import { terrainHeightAt } from "../game/terrain";

export const INK = 0x1c1712;
const HOT = 0xfff6d8; // white-hot core
const TRACER = 0xffd866; // tracer yellow
const FLASH = 0xffe58a; // muzzle-flash body
const FLASH_RIM = 0xff8a2e; // muzzle-flash rim (the "outline" of a flash is orange, not ink)
const FIRE = [0xfff0b0, 0xffd24a, 0xff9a2a, 0xf25a1a, 0x9e3a1c, 0x6e6660, 0x8a847a] as const;
const SMOKE = 0x76706a;
const SMOKE_LIGHT = 0x9d968c;
const BRASS = 0xffc857;
const OLIVE = 0x4d5a3a;
const STEEL = 0x34403c;

export type ProjectileFamily =
  | "rifle" | "carbine" | "sniper" | "mg" | "pellet" | "pistol" | "flame"
  | "grenade" | "launcher" | "mortar" | "smoke" | "bomb"
  | "tank" | "artillery" | "siege"
  | "bolt" | "heavybolt" | "airgun";

/** Which visual family a round belongs to. The sim only knows four projectile kinds; the look
 *  comes from who fired it and how. */
export function projectileFamily(p: Projectile): ProjectileFamily {
  const src: EntityKind | undefined = p.sourceKind;
  if (p.kind === "shell") return src === "artillery" ? "artillery" : src === "exturret" ? "siege" : "tank";
  if (p.kind === "bolt") return src === "base" ? "heavybolt" : src && isAirKind(src) || src === "flak" ? "airgun" : "bolt";
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

/** How many past positions a family's trail wants. Long ribbons for the slow lobbed rounds. */
export function trailLength(family: ProjectileFamily): number {
  switch (family) {
    case "flame": return 9;
    case "mortar": case "smoke": case "artillery": case "siege": case "tank": return 8;
    case "sniper": return 7;
    case "pellet": case "pistol": return 4;
    default: return 6;
  }
}

export interface TrailPoint { x: number; y: number; z: number }

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
    case "pellet": case "pistol": return 0.16;
    default: return 0.22;
  }
}

/** Append the round's current position to its history when it has moved a trail step. */
export function pushTrailPoint(history: TrailPoint[], p: Projectile, family: ProjectileFamily): void {
  const last = history[history.length - 1];
  const point = { x: p.position.x, y: p.height, z: p.position.z };
  if (last) {
    const step = trailStep(family);
    const d = Math.hypot(point.x - last.x, point.y - last.y, point.z - last.z);
    if (d < step) return;
    // A round that jumped several steps in one frame (fast round, slow frame) fills the gap so the
    // ribbon stays continuous instead of leaving a hole behind the head.
    const n = Math.min(4, Math.floor(d / step));
    for (let i = 1; i < n; i += 1) {
      const t = i / n;
      history.push({ x: last.x + (point.x - last.x) * t, y: last.y + (point.y - last.y) * t, z: last.z + (point.z - last.z) * t });
    }
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
      case "bolt-core": geometry = new THREE.OctahedronGeometry(0.2, 0); break;
      case "bolt-ring": geometry = new THREE.TorusGeometry(0.26, 0.03, 6, 20); break;
      case "grenade-body": geometry = new THREE.IcosahedronGeometry(0.18, 1); break;
      case "grenade-band": geometry = new THREE.TorusGeometry(0.18, 0.026, 6, 16); break;
      case "launcher-body": geometry = new THREE.CylinderGeometry(0.11, 0.12, 0.26, 10); break;
      case "launcher-nose": geometry = new THREE.SphereGeometry(0.115, 10, 7); break;
      case "mortar-body": geometry = new THREE.CapsuleGeometry(0.15, 0.22, 3, 10); break;
      case "blob": geometry = new THREE.IcosahedronGeometry(0.22, 1); break;
      case "spike": geometry = new THREE.ConeGeometry(0.07, 0.34, 5); (geometry as THREE.ConeGeometry).translate(0, 0.17, 0); break;
      case "disc": geometry = new THREE.CircleGeometry(0.5, 20); break;
      case "ring": geometry = new THREE.RingGeometry(0.42, 0.5, 28); break;
      case "shard": geometry = new THREE.TetrahedronGeometry(0.09, 0); break;
      case "ember": geometry = new THREE.SphereGeometry(0.05, 8, 6); break;
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

/** Materials the stage warm-up must compile: the opaque front/back MeshBasic programs this module
 *  introduces (an inverted hull is `flipSided`, a different GL program from every transparent FX
 *  material the scene already carried). */
export function projectileFxWarmUpMaterials(): THREE.Material[] {
  return [fxSolid(0xffffff), fxSolid(0xffffff, true), projectileMaterial("warm", 0xffffff, 0.5)];
}

/** Every cached geometry the first resolve will need, built now rather than mid-action. */
export function prewarmProjectileFx(): void {
  for (const key of ["tracer", "pellet", "shell-body", "shell-nose", "shell-band", "shell-fin", "bolt-core", "bolt-ring", "grenade-body", "grenade-band", "launcher-body", "launcher-nose", "mortar-body", "blob", "spike", "disc", "ring", "shard", "ember"]) projectileGeometry(key);
  for (const r of TRAIL_RADII) tubeGeometry(r);
  for (const r of [0.18, 0.24, 0.3, 0.36, 0.44]) shadowGeometry(r);
  for (const c of [INK, HOT, TRACER, FLASH, FLASH_RIM, SMOKE, SMOKE_LIGHT, BRASS, OLIVE, STEEL, ...FIRE]) { fxSolid(c); fxSolid(c, true); }
}

// ---------------------------------------------------------------------------------------------
// Building blocks

const TRAIL_RADII = [0.05, 0.042, 0.034, 0.026, 0.02, 0.015, 0.012, 0.01];
const TRAIL_OPACITIES = [0.78, 0.6, 0.44, 0.3, 0.2, 0.12, 0.07, 0.04];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
/** Quantise an animated opacity so the material cache stays bounded (20 steps). */
function q(opacity: number): number { return Math.round(clamp01(opacity) * 20) / 20; }

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

function tube(a: TrailPoint, b: TrailPoint, color: number, opacity: number, radius: number): THREE.Object3D | undefined {
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

/** Point the object's +Y along the 3D velocity (so a lobbed round noses over its arc). */
export function orientAlongVelocity(obj: THREE.Object3D, from: TrailPoint, to: TrailPoint): void {
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

/** A flat grey smoke puff: opaque blob with an ink rim. Toon smoke is solid, never a haze. */
function puff(scale: number, color = SMOKE, rim = 1.16): THREE.Object3D {
  const blob = solid("blob", color, rim);
  blob.scale.setScalar(scale);
  return blob;
}

// ---------------------------------------------------------------------------------------------
// In-flight models. Local +Y = direction of travel (set by orientAlongVelocity).

function tracerModel(family: ProjectileFamily, team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  // Three hulls: white-hot core, team-colour sleeve, ink rim. Each is the same capsule at a larger
  // size drawn back-face only, so the inner layer always shows through the middle.
  const core = new THREE.Mesh(projectileGeometry("tracer"), fxSolid(HOT));
  const sleeve = new THREE.Mesh(projectileGeometry("tracer"), fxSolid(family === "mg" ? TRACER : team, true));
  const rim = new THREE.Mesh(projectileGeometry("tracer"), fxSolid(INK, true));
  core.frustumCulled = sleeve.frustumCulled = rim.frustumCulled = false;
  sleeve.scale.set(1.9, 1.06, 1.9);
  rim.scale.set(2.7, 1.14, 2.7);
  group.add(rim, sleeve, core);
  switch (family) {
    case "sniper": {
      // A needle: long, thin, brilliant. The long trail (below) is its signature.
      group.scale.set(0.8, 2.3, 0.8);
      break;
    }
    case "mg": {
      group.scale.set(1.35, 1.0, 1.35);
      break;
    }
    case "carbine": group.scale.set(0.85, 0.9, 0.85); break;
    case "pistol": group.scale.set(0.9, 0.62, 0.9); break;
    case "airgun": {
      group.scale.set(1.2, 0.8, 1.2);
      break;
    }
    default: group.scale.set(1, 1, 1);
  }
  // A short flicker in the core keeps a stationary-looking tracer alive across frames.
  core.scale.y = 1 + Math.sin(age * 40) * 0.06;
  return group;
}

function pelletModel(team: number): THREE.Group {
  const group = new THREE.Group();
  const p = solid("pellet", HOT, 1.7, team);
  const rim = new THREE.Mesh(projectileGeometry("pellet"), fxSolid(INK, true));
  rim.scale.setScalar(2.3);
  rim.frustumCulled = false;
  group.add(rim, p);
  group.scale.set(1, 1.5, 1);
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
  // Exhaust: a fat orange blob flickering off the base, and a yellow tracer glow behind it.
  const exhaust = solid("blob", FIRE[1], 1.2, FIRE[3]);
  exhaust.position.y = -0.36;
  exhaust.scale.set(0.5, 0.7 + Math.sin(age * 36) * 0.16, 0.5);
  group.add(body, nose, band, exhaust);
  group.rotation.y = age * (heavy ? 5 : 10); // spin-stabilised
  group.scale.setScalar(0.95 * (heavy ? 1.3 : blunt ? 1.12 : 1));
  return group;
}

function boltModel(family: ProjectileFamily, team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  const big = family === "heavybolt";
  const air = family === "airgun";
  const core = new THREE.Mesh(projectileGeometry("bolt-core"), fxSolid(HOT));
  const sleeve = new THREE.Mesh(projectileGeometry("bolt-core"), fxSolid(team, true));
  const rim = new THREE.Mesh(projectileGeometry("bolt-core"), fxSolid(INK, true));
  core.frustumCulled = sleeve.frustumCulled = rim.frustumCulled = false;
  core.scale.set(0.62, 1.5, 0.62);
  sleeve.scale.set(1.15, 1.75, 1.15);
  rim.scale.set(1.5, 1.95, 1.5);
  const pulse = 1 + Math.sin(age * 24) * 0.08;
  core.scale.multiplyScalar(pulse);
  group.add(rim, sleeve, core);
  if (big) {
    // The base relay's bolt carries a counter-spinning containment ring.
    const ring = solid("bolt-ring", team, 1.3);
    ring.rotation.x = Math.PI / 2;
    ring.rotation.z = age * 6;
    group.add(ring);
  }
  group.scale.setScalar(air ? 0.7 : big ? 1.3 : 0.85);
  if (air) group.scale.y *= 1.5; // aircraft cannon: a dash, not a diamond
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
  // Armed-fuse blink: a red pip strobing — reads as "live ordnance".
  const fuse = solid("ember", Math.sin(age * 26) > 0 ? 0xff3b30 : 0x5a1a14, 1.4);
  fuse.position.set(0, 0.22, 0.07);
  fuse.scale.setScalar(0.9);
  tumble.add(body, band, cap, fuse);
  // Tumble end over end in flight; roll about the travel axis on the ground.
  if (rolling) tumble.rotation.x = age * 10;
  else { tumble.rotation.x = age * 7.5; tumble.rotation.z = age * 2.6; }
  group.add(tumble);
  group.scale.setScalar(rolling ? 1.1 : 1.3);
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
  group.add(body, nose, band);
  group.rotation.y = age * 14;
  group.scale.setScalar(1.25);
  return group;
}

function mortarModel(family: ProjectileFamily, team: number, age: number): THREE.Group {
  const group = new THREE.Group();
  const smoke = family === "smoke";
  const bomb = family === "bomb";
  const body = rimmed("mortar-body", smoke ? SMOKE_LIGHT : bomb ? 0x2c3330 : OLIVE, [1.26, 1.14, 1.26]);
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
  group.scale.setScalar(bomb ? 1.8 : 1.45);
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
  group.scale.set(wobble * 1.2, 1.3, 1.2 / wobble);
  return group;
}

/** The round itself, at the projectile's current position. */
export function makeProjectileModel(p: Projectile, family: ProjectileFamily): THREE.Group {
  const team = p.color;
  switch (family) {
    case "tank": case "artillery": case "siege": return shellModel(family, team, p.age);
    case "bolt": case "heavybolt": case "airgun": return boltModel(family, team, p.age);
    case "grenade": return grenadeModel(team, p.age, p.state === "rolling");
    case "launcher": return launcherModel(team, p.age);
    case "mortar": case "smoke": case "bomb": return mortarModel(family, team, p.age);
    case "flame": return flameHead(p.age);
    case "pellet": return pelletModel(team);
    default: return tracerModel(family, team, p.age);
  }
}

// ---------------------------------------------------------------------------------------------
// Trails

/** Everything a round drags behind it, from its position history (newest last). */
export function makeProjectileTrail(p: Projectile, family: ProjectileFamily, history: readonly TrailPoint[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const n = history.length;
  if (n < 2) return out;
  const team = p.color;
  if (family === "flame") {
    // A chain of fat blobs that grow, darken and turn to smoke as they fall behind the head: yellow
    // near the nozzle, orange, red, then two grey puffs that shrink away. The fire stages grow; the
    // smoke stages do not (a growing grey ball read as a balloon towed behind the stream).
    for (let i = n - 2; i >= 0; i -= 1) {
      const back = n - 1 - i;
      const pt = history[i];
      const stage = Math.min(FIRE.length - 1, back);
      const smoke = back >= 5;
      // Smoke puffs start small and shrink fast: at the old 1.1 they read as grey discs hanging at
      // head height in a firing line.
      const scale = (smoke ? 0.6 - (back - 5) * 0.22 : 0.7 + back * 0.13) * (1 + Math.sin(p.age * 20 + i * 1.9) * 0.12);
      if (scale < 0.15) continue;
      const blob = solid("blob", FIRE[stage], 1.2, smoke ? INK : FIRE[Math.min(FIRE.length - 3, stage + 2)]);
      blob.position.set(pt.x + Math.sin(p.age * 9 + i * 2.3) * 0.1, pt.y + back * 0.06, pt.z + Math.cos(p.age * 7 + i * 1.3) * 0.1);
      blob.scale.setScalar(scale);
      blob.rotation.set(i * 1.1, p.age * 2, i * 0.7);
      out.push(blob);
    }
    return out;
  }
  const tapered = family === "grenade" || family === "launcher" || family === "bomb" ? 0.45 : family === "pistol" || family === "carbine" ? 0.7 : family === "sniper" ? 0.8 : 1;
  const trailColor = family === "mg" ? TRACER : family === "grenade" || family === "mortar" || family === "smoke" || family === "bomb" ? SMOKE_LIGHT : family === "launcher" ? BRASS : family === "tank" ? TRACER : team;
  const lobbed = family === "mortar" || family === "smoke" || family === "artillery" || family === "siege" || family === "tank" || family === "launcher" || family === "grenade" || family === "bomb";
  // Tapered ribbon: fat and bright at the round, thin and faint at the tail.
  const segments = lobbed && family !== "tank" ? Math.min(n - 1, 3) : n - 1;
  const width = family === "tank" || family === "artillery" || family === "siege" ? 2.2 : family === "mg" ? 1.4 : 1;
  for (let i = n - 1; i > n - 1 - segments && i > 0; i -= 1) {
    const back = n - 1 - i;
    const seg = tube(history[i - 1], history[i], trailColor, TRAIL_OPACITIES[Math.min(TRAIL_OPACITIES.length - 1, back)], TRAIL_RADII[Math.min(TRAIL_RADII.length - 1, back)] * tapered * width);
    if (seg) out.push(seg);
  }
  if (family === "sniper" && n >= 4) {
    // The marksman's signature: one long white line across the round's last metres, sitting over
    // a thicker team-colour line — a graphic "pierce" stroke, not a vapour haze.
    const tail = history[Math.max(0, n - 6)];
    const head = history[n - 1];
    const under = tube(tail, head, team, 0.5, 0.05);
    const over = tube(tail, head, HOT, 0.9, 0.022);
    if (under) out.push(under);
    if (over) out.push(over);
  }
  if (lobbed && family !== "grenade" && family !== "tank") {
    // Smoke ribbon behind a lobbed round: puffs hang where the round WAS, so they thin out behind
    // it in space rather than towing along. Fresh puffs are small and light; they swell and drift
    // upward and sideways as they age, and the two oldest shrink away. Every other sample is
    // skipped so the ribbon has gaps — a solid chain read as a caterpillar on the arc.
    const count = family === "launcher" ? 3 : 5;
    let placed = 0;
    for (let i = n - 3; i >= 0 && placed < count; i -= 2) {
      const back = n - 1 - i;
      const pt = history[i];
      const swell = 0.42 + back * 0.09;
      const scale = placed >= count - 2 ? swell * (placed === count - 1 ? 0.45 : 0.75) : swell;
      const s = puff(scale * (family === "artillery" ? 1.35 : family === "launcher" ? 0.7 : 1), placed % 2 ? SMOKE : SMOKE_LIGHT);
      const side = (i % 2 ? 1 : -1) * (0.08 + back * 0.03);
      s.position.set(pt.x + Math.sin(i * 2.1) * side, pt.y + back * 0.08 + 0.05, pt.z + Math.cos(i * 1.7) * side);
      s.rotation.set(i * 0.9, i * 0.4, 0);
      out.push(s);
      placed += 1;
    }
  }
  return out;
}

/** Flat ground shadow under a round — shrinking and paling as it climbs, so an arc's height reads. */
export function makeProjectileShadow(p: Projectile, family: ProjectileFamily): THREE.Mesh {
  const groundY = terrainHeightAt(p.position) + 0.028;
  const above = Math.max(0, p.height - groundY);
  const base = family === "artillery" || family === "bomb" ? 0.44 : family === "tank" || family === "siege" || family === "mortar" || family === "smoke" ? 0.36 : family === "grenade" || family === "launcher" || family === "heavybolt" ? 0.3 : family === "flame" ? 0.3 : family === "pellet" || family === "pistol" ? 0.18 : 0.24;
  const radius = [0.18, 0.24, 0.3, 0.36, 0.44].reduce((best, r) => Math.abs(r - base) < Math.abs(best - base) ? r : best, 0.24);
  const shrink = clamp01(1 - above * 0.05);
  const opacity = p.state === "rolling" ? 0.34 : Math.max(0.12, 0.38 - above * 0.025);
  const shadow = new THREE.Mesh(shadowGeometry(radius), projectileMaterial("shadow", INK, q(opacity)));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(p.position.x, groundY, p.position.z);
  shadow.scale.set(1.4 * (0.5 + shrink * 0.5), 1.4 * (0.5 + shrink * 0.5) * 0.7, 1);
  shadow.frustumCulled = false;
  return shadow;
}

// ---------------------------------------------------------------------------------------------
// Muzzle events

export const MUZZLE_FLASH_TIME = 0.13;

/** The flash at the barrel for the first frames of a round's life. Shape per family. */
export function makeMuzzleFlash(p: Projectile, family: ProjectileFamily): THREE.Object3D | undefined {
  if (family === "grenade" || family === "bomb" || p.age > MUZZLE_FLASH_TIME) return undefined;
  const t = clamp01(p.age / MUZZLE_FLASH_TIME);
  // Pop: full size almost at once, then shrink away — a flash is a single frame of light.
  const pop = t < 0.25 ? 0.6 + (t / 0.25) * 0.4 : 1 - ((t - 0.25) / 0.75) * 0.85;
  const group = new THREE.Group();
  const seed = (p.id.length * 7 + p.id.charCodeAt(p.id.length - 1)) % 9;
  switch (family) {
    case "rifle": case "carbine": case "pistol": {
      const small = family === "pistol";
      group.add(starburst(4, small ? 0.5 : 0.7, small ? 0.5 : 0.65, FLASH, FLASH_RIM, small ? 0.9 : 1.4, seed));
      group.scale.setScalar(0.55 * pop);
      break;
    }
    case "mg": {
      group.add(starburst(6, 0.8, 0.75, FLASH, FLASH_RIM, 1.6, seed));
      group.scale.setScalar(0.7 * pop);
      break;
    }
    case "sniper": {
      group.add(starburst(2, 1.2, 0.45, FLASH, FLASH_RIM, 2.4, seed));
      group.scale.setScalar(0.6 * pop);
      break;
    }
    case "pellet": {
      // Scattergun: a wide forward fan, no side spikes.
      group.add(starburst(5, 0.9, 0.7, FLASH, FLASH_RIM, 1.0, seed, 0.95));
      group.scale.setScalar(0.62 * pop);
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
      group.add(starburst(8, 1.4, 0.9, FLASH, FLASH_RIM, 3.2, seed));
      // A flat smoke ring blown out of the muzzle brake, expanding through the flash's life.
      const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("muzzle-ring", SMOKE_LIGHT, q(0.7 - t * 0.5)));
      ring.scale.setScalar(1.2 + t * 2.4);
      ring.frustumCulled = false;
      group.add(ring);
      group.scale.setScalar((big ? 1.15 : 0.95) * pop);
      break;
    }
    case "launcher": case "mortar": case "smoke": {
      const s = puff(0.5 * pop + t * 0.4, SMOKE_LIGHT);
      group.add(s);
      if (family === "launcher") group.add(starburst(4, 0.5, 0.6, FLASH, FLASH_RIM, 0.9, seed));
      group.scale.setScalar(0.8);
      break;
    }
    case "bolt": case "heavybolt": case "airgun": {
      // Energy weapon: a team-colour disc pulse with a hot centre, no gas.
      const disc = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("muzzle-ring", p.color, q(0.9 - t * 0.6)));
      disc.scale.setScalar(0.5 + t * 1.1);
      disc.frustumCulled = false;
      const core = solid("ember", HOT, 1.6, p.color);
      core.scale.setScalar(3.2 * pop);
      group.add(disc, core);
      group.scale.setScalar(family === "heavybolt" ? 1.3 : family === "airgun" ? 0.6 : 0.85);
      break;
    }
  }
  group.position.set(p.origin.x, p.originHeight, p.origin.z);
  // Local +Y is the shot axis for every spike fan above.
  _d.set(p.direction.x, p.verticalSlope, p.direction.z).normalize();
  group.quaternion.setFromUnitVectors(UP, _d);
  group.traverse((o) => { o.frustumCulled = false; });
  return group;
}

// ---------------------------------------------------------------------------------------------
// Impacts

/** A round striking a body: a hard little star at the hit point, sized by the effect radius. */
export function makeImpact(effect: VisualEvent, t: number, ground: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const size = Math.max(0.4, effect.radius ?? 0.5);
  const seed = (effect.id.length * 31) % 7;
  // Star pops to full size in the first fifth and shrinks away over the rest.
  const pop = t < 0.2 ? 0.5 + (t / 0.2) * 0.5 : Math.max(0, 1 - (t - 0.2) / 0.8);
  if (pop > 0.02) {
    const star = new THREE.Group();
    // A 3D star (spikes on six axes plus a tilted ring) reads from any camera angle.
    for (let i = 0; i < 6; i += 1) {
      const spike = solid("spike", HOT, 1.5, effect.color);
      const axis = i % 3;
      const sign = i < 3 ? 1 : -1;
      _d.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      spike.quaternion.setFromUnitVectors(UP, _d);
      spike.scale.set(0.9, 0.7 + ((seed + i) % 3) * 0.25, 0.9);
      star.add(spike);
    }
    star.rotation.set(seed * 0.4, seed * 0.9, seed * 0.2);
    star.scale.setScalar(size * 0.9 * pop);
    star.position.set(effect.to.x, ground + 0.9, effect.to.z);
    out.push(star);
  }
  // A thin ground ring pushed out from the feet.
  const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("impact-ring", effect.color, q((1 - t) * 0.5)));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(effect.to.x, ground + 0.06, effect.to.z);
  ring.scale.setScalar(size * (0.6 + t * 1.4));
  out.push(ring);
  for (const o of out) o.traverse((c) => { c.frustumCulled = false; });
  return out;
}

/** An explosion: flash → spiky fireball → solid smoke, plus the ground ring. `effect.radius` is the
 *  sim's blast radius in world units; the `blob` geometry is 0.22 wide, so shape scales carry a
 *  ~/0.22 factor to make the fireball fill roughly half the damage radius. */
export function makeBlast(effect: VisualEvent, t: number, ground: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const radius = effect.radius ?? 1;
  const R = radius / 0.22; // blob scale that spans the blast radius
  const lift = Math.min(radius, 1.3); // how high the column climbs — a wide blast is not a tall one
  const seed = (effect.id.length * 17 + effect.id.charCodeAt(effect.id.length - 1)) % 11;
  const cx = effect.to.x;
  const cz = effect.to.z;
  // 1. Flash frame: a white disc that is there and gone.
  if (t < 0.1) {
    const flash = solid("blob", HOT, 0);
    flash.scale.setScalar(R * (0.25 + t * 4));
    flash.position.set(cx, ground + lift * 0.35, cz);
    out.push(flash);
  }
  // 2. Fireball: a cluster of flat blobs that lifts and grows, stepping yellow → orange → dark,
  //    then shrinks into the smoke. Spikes fly out of it for the first third.
  if (t < 0.6) {
    const life = t / 0.6;
    const stage = life < 0.3 ? 1 : life < 0.6 ? 2 : 3;
    const grow = life < 0.45 ? 0.45 + life * 1.2 : 1 - (life - 0.45) * 1.7;
    for (let i = 0; i < 6; i += 1) {
      const a = seed * 0.7 + i * 1.05;
      const r = radius * 0.36 * (i === 0 ? 0 : 1) * (0.5 + life);
      const blob = solid("blob", FIRE[stage], 1.16, FIRE[Math.min(4, stage + 2)]);
      blob.position.set(cx + Math.cos(a) * r, ground + lift * 0.3 + life * lift * 0.6 + (i === 0 ? lift * 0.25 : (i % 2) * lift * 0.2), cz + Math.sin(a) * r);
      blob.scale.setScalar(R * (i === 0 ? 0.55 : 0.34) * grow);
      blob.rotation.set(i, a, seed);
      out.push(blob);
    }
    if (t < 0.28) {
      // Spike geometry is 0.34 long, so length is in spike-scale units: ~1.7x the radius.
      const star = starburst(7, R * 0.6, R * 0.16, FIRE[0], FIRE[2], 0, seed * 0.5, 0.35);
      star.scale.setScalar(0.5 + (t / 0.28) * 0.6);
      star.position.set(cx, ground + lift * 0.35, cz);
      out.push(star);
    }
  }
  // 3. Smoke: solid grey puffs rising off the fireball, largest mid-life, shrinking away.
  if (t > 0.22) {
    const life = (t - 0.22) / 0.78;
    const scale = life < 0.45 ? 0.55 + life : 1 - (life - 0.45) * 1.7;
    if (scale > 0.03) {
      for (let i = 0; i < 5; i += 1) {
        const a = seed * 0.9 + i * 1.26 + 0.4;
        const r = radius * 0.34 * (0.4 + life);
        const s = puff(R * (i % 2 ? 0.3 : 0.4) * scale, i % 2 ? SMOKE : SMOKE_LIGHT);
        s.position.set(cx + Math.cos(a) * r, ground + lift * 0.35 + life * lift * 1.0 + i * lift * 0.08, cz + Math.sin(a) * r);
        s.rotation.set(i * 0.8, a, 0);
        out.push(s);
      }
    }
  }
  // 4. Ground ring: the shockwave line racing outward, thinning as it goes.
  const ring = new THREE.Mesh(projectileGeometry("ring"), projectileMaterial("blast-ring", effect.color, q((1 - t) * 0.8)));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cx, ground + 0.07, cz);
  ring.scale.setScalar(radius * (0.4 + t * 2.4));
  out.push(ring);
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
