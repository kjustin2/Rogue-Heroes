import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * Async loaders for the three Blender-authored PART kits in public/models/:
 *
 *   infantry-kit.glb  — trooper shapes (art/infantry)      → kitGeometry(part)
 *   props-kit.glb     — seeded cover props (art/props)     → propGeometry(kind, seed)
 *   vehicles-kit.glb  — vehicle / structure hulls as parts (art/vehicles) → vehicleGeometry(part)
 *
 * Every kit mesh is a unit cube centred on the origin with UVs and baked vertex AO (COLOR_0);
 * the renderer scales it to size through the pooled part-material path, so all three kits take
 * the same toon ramp, ink rim and team paint. The renderer never awaits: a part that has not
 * loaded (or never will — the game runs with public/models/ EMPTY) keeps its procedural builder,
 * and `modelsVersion()` bumps when a kit lands so entity groups rebuild and pick the shapes up.
 *
 * There are no whole-model hulls any more. The Meshy GLBs (tank/apc/artillery/hq/turret/crates/
 * sandbags/barricade, plus the winter retextures) were photoreal meshes posterized at load, and
 * stood next to the flat-banded troopers as a different game; the vehicles kit replaced them in
 * 2026-09 and the pipeline was deleted. Do not reintroduce a per-model texture path.
 *
 * Disposal contract: kit geometry is tagged `userData.shared` so disposeSubtree leaves it alone.
 */

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

let version = 0;

/** Bumps whenever a kit finishes loading; renderers watch it to rebuild groups. */
export function modelsVersion(): number {
  return version;
}

/** Kick off every kit load (call once at boot, behind the loading veil). */
export function preloadAll(): void {
  if (kitState === "idle") loadInfantryKit();
  if (propsState === "idle") loadPropsKit();
  if (vehiclesState === "idle") loadVehiclesKit();
}

function loadKit(url: string, into: Map<string, THREE.BufferGeometry>, onDone: (ok: boolean) => void): void {
  loader.load(
    url,
    (gltf) => {
      gltf.scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        // Bake the node's own transform in and tag it shared: one geometry serves every mesh
        // wearing that part. UVs stay for the pooled materials' shared detail normal map.
        geometry.applyMatrix4(mesh.matrixWorld);
        geometry.userData.shared = true;
        into.set(node.name, geometry);
      });
      onDone(true);
      version += 1;
    },
    undefined,
    () => onDone(false),
  );
}

// Four-step light ramp for every toon surface (pooled parts AND props): deep shade,
// shade, lit, highlight. The ramp is RGB, not grey: the two shade steps lean COOL (blue-violet)
// and the two lit steps lean WARM (a touch of amber), which is how hand-painted / gradient-mapped
// stylized art fakes bounce and sky light — a grey ramp reads as plastic under any sun. The shift
// is small (≤10 units between channels) so the map's own key light still owns the hue; only the
// contrast between a lit plane and its shaded neighbour picks up the warm/cool split.
let _toonGradient: THREE.DataTexture | undefined;
export function toonGradient(): THREE.DataTexture {
  if (_toonGradient) return _toonGradient;
  // Highlight band stops short of white: at 255 every lit crate and pillar bleached to cream.
  // Top step's brightest channel is 226 for that reason — do not push it.
  const data = new Uint8Array([
    70, 74, 88, 255,      // deep shade: cool
    130, 134, 146, 255,   // shade: cool
    192, 188, 180, 255,   // lit: slight warm lift
    226, 222, 210, 255,   // highlight: warm, capped at 226
  ]);
  _toonGradient = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  _toonGradient.minFilter = _toonGradient.magFilter = THREE.NearestFilter;
  _toonGradient.colorSpace = THREE.NoColorSpace;
  _toonGradient.needsUpdate = true;
  return _toonGradient;
}

// ---------------------------------------------------------------------------
// INFANTRY KIT — Blender-authored PART geometry for the procedural trooper rig.
//
// The soldier stays a rig of separate meshes on purpose: per-part damage targets
// each one, the walk cycle and attack choreography swing them from tagged pivots,
// and the pooled-material system repaints them every frame. A single skinned
// character would take all three away. So Blender authors the SHAPES and the game
// keeps the rig — each kit mesh is normalised to a 1x1x1 box centred on the origin
// so the builder can scale it to whatever size a kit wants, and any part with no
// authored mesh keeps its procedural rounded box. The game runs with the GLB gone.
// ---------------------------------------------------------------------------
// Shared chassis parts plus the per-kind identity parts authored in art/infantry/author_kinds.py.
export type KitPart =
  | "helmet" | "torso" | "boot" | "rifle" | "pack"
  | "helmet-scout" | "helmet-sniper" | "helmet-striker" | "helmet-heavy" | "helmet-grenadier" | "helmet-mortar"
  | "helmet-medic" | "helmet-engineer" | "helmet-flamer" | "helmet-droneop" | "helmet-sapper" | "helmet-jumper"
  | "weapon-carbine" | "weapon-longrifle" | "weapon-blade" | "weapon-mg" | "weapon-launcher" | "weapon-mortar"
  | "weapon-pistol" | "weapon-wrench" | "weapon-flamethrower" | "weapon-wand" | "weapon-shotgun"
  | "pack-medic" | "pack-engineer" | "pack-flamer" | "pack-drone" | "pack-jumper"
  | "arm" | "leg" | "hips" | "head"
  // Per-kind BODY variants (art/infantry/author_bodies.py): same rig contract as the chassis part
  // they replace, so the walk cycle / pooled paint / per-part damage never know the difference.
  | "torso-heavy" | "torso-scout" | "torso-sniper" | "torso-striker" | "torso-medic" | "torso-engineer"
  | "torso-flamer" | "torso-droneop" | "torso-sapper" | "torso-mortar" | "torso-grenadier" | "torso-jumper"
  | "arm-striker" | "arm-medic" | "arm-heavy" | "arm-flamer" | "arm-jumper"
  | "leg-engineer" | "leg-jumper" | "leg-heavy" | "leg-scout"
  // Per-kind EXTRAS, hung off an existing part id so they ride the rig.
  | "cape-sniper" | "antenna-droneop" | "hose-flamer" | "sheath-striker" | "pauldron-heavy" | "ammobox-heavy"
  | "stretcher-medic" | "toolroll-engineer" | "detonator-sapper" | "mines-sapper" | "bipod-mortar" | "drums-grenadier"
  | "weapon-smg";

const kit = new Map<string, THREE.BufferGeometry>();
let kitState: "idle" | "loading" | "ready" | "failed" = "idle";

/** Authored geometry for a part, or undefined — callers fall back to a box. */
export function kitGeometry(part: KitPart): THREE.BufferGeometry | undefined {
  if (kitState === "idle") loadInfantryKit();
  return kit.get(part);
}

function loadInfantryKit(): void {
  kitState = "loading";
  loadKit("models/infantry-kit.glb", kit, (ok) => { kitState = ok ? "ready" : "failed"; });
}

// ---------------------------------------------------------------------------
// PROPS KIT — Blender-authored, seeded low-poly cover props (art/props/author_props.py).
//
// N variants per kind in one GLB, each normalised to a unit cube like the infantry parts, so
// buildCover scales them and the pooled part material paints them (map tint + toon ramp). A
// variant is picked by hash(entity.id), so no two neighbouring rocks match and a restored save
// shows the same rock. Every branch keeps its procedural builder as the fallback: the game runs
// with the GLB missing. The kit REPLACED the photoreal Meshy rock.glb (30 credits, greyscaled and
// re-tinted to sit next to the toon troopers, and one silhouette on every map).
// ---------------------------------------------------------------------------
export type PropsKind = "rock" | "stump" | "log" | "bush" | "canopy" | "trunk" | "cactus" | "statue" | "rubble"
  | "convoy" | "derrick" | "furnace" | "railcar" | "chapel" | "mill" | "hull" | "hut" | "colossus" | "cistern" | "gate" | "radar";
export const PROPS_VARIANTS: Record<PropsKind, number> = {
  rock: 4, stump: 3, log: 3, bush: 4, canopy: 3, trunk: 3, cactus: 3, statue: 3, rubble: 3,
  // Landmarks: one authored shape each (they are the thing you recognise, so they do not vary),
  // except the two that are laid in lines/clusters and want a second silhouette.
  convoy: 1, derrick: 1, furnace: 1, railcar: 2, chapel: 1, mill: 1, hull: 1, hut: 2, colossus: 1, cistern: 1, gate: 1, radar: 1,
};
// The full name set (kept literal so the Blender validator can diff it against what it built).
export type PropsPart =
  | "rock-0" | "rock-1" | "rock-2" | "rock-3"
  | "stump-0" | "stump-1" | "stump-2"
  | "log-0" | "log-1" | "log-2"
  | "bush-0" | "bush-1" | "bush-2" | "bush-3"
  | "canopy-0" | "canopy-1" | "canopy-2"
  | "trunk-0" | "trunk-1" | "trunk-2"
  | "cactus-0" | "cactus-1" | "cactus-2"
  | "statue-0" | "statue-1" | "statue-2"
  | "rubble-0" | "rubble-1" | "rubble-2"
  | "convoy-0" | "derrick-0" | "furnace-0" | "railcar-0" | "railcar-1" | "chapel-0" | "mill-0" | "hull-0"
  | "hut-0" | "hut-1" | "colossus-0" | "cistern-0" | "gate-0" | "radar-0";

const props = new Map<string, THREE.BufferGeometry>();
let propsState: "idle" | "loading" | "ready" | "failed" = "idle";

/** Authored geometry for variant `seed % N` of a prop kind, or undefined — callers fall back. */
export function propGeometry(kind: PropsKind, seed: number): THREE.BufferGeometry | undefined {
  if (propsState === "idle") loadPropsKit();
  return props.get(`${kind}-${Math.abs(seed) % PROPS_VARIANTS[kind]}`);
}

/** True once the props kit has loaded (or failed) — used to decide when a rebuild is worth it. */
export function propsKitReady(): boolean {
  return propsState === "ready";
}

function loadPropsKit(): void {
  propsState = "loading";
  loadKit("models/props-kit.glb", props, (ok) => { propsState = ok ? "ready" : "failed"; });
}

// ---------------------------------------------------------------------------
// VEHICLES KIT — Blender-authored hulls for every vehicle and structure, AS PARTS
// (art/vehicles/author_vehicles.py → vehicles-kit.glb + the generated vehiclesLayout.ts).
//
// One mesh per damage-model part: `tank-hull` / `tank-turret` / `tank-cannon` / `tank-front` and
// `tank-track` (one mesh placed at ±x for the two treads); the same for the APC (wheeled), the
// artillery, the gun turret, the HQ, and one mesh each for the crate / sandbag / barricade cover.
// The parts are authored at GAME SCALE and the layout file carries each one's bbox, so the
// renderer's kit builders only assemble: per-part damage, cannon recoil, dead-track listing and
// the pooled team paint all keep working because every part is an ordinary part mesh. Every
// kit builder keeps the older procedural builder as its fallback (`vehiclesKitReady()` false).
// This kit REPLACED the Meshy hulls (2026-09) — see the module header.
// ---------------------------------------------------------------------------
export type VehiclesPart =
  | "tank-hull" | "tank-front" | "tank-turret" | "tank-cannon" | "tank-track"
  | "apc-hull" | "apc-front" | "apc-cupola" | "apc-autogun" | "apc-wheels"
  | "arty-hull" | "arty-front" | "arty-mount" | "arty-gun" | "arty-track"
  | "turret-mount" | "turret-gun" | "turret-sensor"
  | "hq-core" | "hq-comms" | "hq-power" | "hq-gate"
  | "crates" | "sandbags" | "barricade";

const vehicles = new Map<string, THREE.BufferGeometry>();
let vehiclesState: "idle" | "loading" | "ready" | "failed" = "idle";

/** Authored geometry for a vehicle part, or undefined — the caller falls back to a box. */
export function vehicleGeometry(part: VehiclesPart): THREE.BufferGeometry | undefined {
  if (vehiclesState === "idle") loadVehiclesKit();
  return vehicles.get(part);
}

/** True once the vehicles kit has loaded: the kit builders take over from the procedural ones. */
export function vehiclesKitReady(): boolean {
  if (vehiclesState === "idle") loadVehiclesKit();
  return vehiclesState === "ready";
}

function loadVehiclesKit(): void {
  vehiclesState = "loading";
  loadKit("models/vehicles-kit.glb", vehicles, (ok) => { vehiclesState = ok ? "ready" : "failed"; });
}
