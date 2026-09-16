import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * Async cache of Meshy-generated GLB hero models (public/models/*.glb).
 *
 * The renderer never awaits: `instantiate()` returns a ready clone or null, and the
 * caller falls back to its procedural builder. `modelsVersion()` bumps on every
 * finished load so the renderer knows to rebuild entity groups that were born
 * procedural. A missing/failed GLB is cached as "failed" — dev/CI never depend on
 * the assets existing.
 *
 * Disposal contract: template geometry is tagged `userData.shared` so the renderer's
 * disposeSubtree leaves it alone; clones share geometry with the template and get
 * cloned materials (textures stay shared with the template).
 */

export type ModelKey =
  | "tank" | "apc" | "artillery" | "hq" | "turret"
  | "barricade" | "sandbags" | "crates" | "rock";

// Horizontal footprint (max of width/length, world units) each model is scaled to —
// matched to the procedural builder it replaces so silhouettes read at gameplay scale.
const TARGET_SIZE: Record<ModelKey, number> = {
  tank: 3.4,
  apc: 3.2,
  artillery: 4.2,
  hq: 3.6,
  turret: 2.3,
  barricade: 1.9,
  sandbags: 1.7,
  crates: 1.5,
  rock: 1.8,
};

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

const cache = new Map<string, THREE.Group | "loading" | "failed">();
let version = 0;
// Cosmetic skin pack suffix ("" = standard, "winter" = <name>-winter.glb). Kinds without
// a skinned file silently fall back to their standard model.
let activeSkin = "";

export function setModelSkin(skin: string): void {
  if (skin === activeSkin) return;
  activeSkin = skin;
  version += 1; // renderers rebuild; instantiate() resolves against the new skin
}

function cacheKeyFor(key: ModelKey, skin: string): string {
  return skin ? `${key}-${skin}` : key;
}

/** Bumps whenever a model finishes loading; renderers watch it to rebuild groups. */
export function modelsVersion(): number {
  return version;
}

/** Kick off every model load (call once at boot, behind the loading veil). */
export function preloadAll(): void {
  for (const key of Object.keys(TARGET_SIZE) as ModelKey[]) ensureLoad(key);
}

/** Loaded templates (for shader warm-up staging). */
export function loadedTemplates(): THREE.Group[] {
  const out: THREE.Group[] = [];
  for (const value of cache.values()) if (value instanceof THREE.Group) out.push(value);
  return out;
}

/**
 * A ready-to-place clone of the model, or null while loading / after failure.
 * The clone shares geometry with the template and owns cloned materials, listed in
 * `userData.glbMaterials` for per-frame tinting. `userData.dims` holds the template's
 * normalized bounding-box size.
 */
export function instantiate(key: ModelKey): THREE.Group | null {
  let template = ensureLoad(key, activeSkin);
  // Skinned variant missing (still loading counts as missing only if FAILED): fall back
  // to the standard hull so a partial skin pack never blanks a unit.
  if (!template && activeSkin && cache.get(cacheKeyFor(key, activeSkin)) === "failed") {
    template = ensureLoad(key, "");
  }
  if (!template) return null;
  const clone = template.clone(true);
  const mats: { material: THREE.MeshStandardMaterial; base: number }[] = [];
  clone.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.material as THREE.MeshStandardMaterial;
    const material = source.clone();
    mesh.material = material;
    mats.push({ material, base: material.color.getHex() });
  });
  clone.userData.glbMaterials = mats;
  clone.userData.dims = (template.userData.dims as THREE.Vector3).clone();
  return clone;
}

function ensureLoad(key: ModelKey, skin = ""): THREE.Group | null {
  const cacheKey = cacheKeyFor(key, skin);
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit instanceof THREE.Group ? hit : null;
  cache.set(cacheKey, "loading");
  const url = `${import.meta.env.BASE_URL}models/${cacheKey}.glb`;
  loader.load(
    url,
    (gltf) => {
      cache.set(cacheKey, normalize(gltf.scene, TARGET_SIZE[key]));
      version += 1;
    },
    undefined,
    () => {
      cache.set(cacheKey, "failed"); // no asset — fallback (standard skin or procedural)
      if (skin) version += 1; // let instantiate() re-resolve to the standard hull
    },
  );
  return null;
}

// Recenter (feet at y=0), rescale to the target footprint, and apply the material/
// shadow/disposal conventions the renderer expects.
function normalize(root: THREE.Object3D, targetSize: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetSize / Math.max(0.001, Math.max(size.x, size.z));
  root.scale.setScalar(scale);
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
  root.position.set(-center.x, -box.min.y * scale, -center.z);

  const template = new THREE.Group();
  template.add(root);
  template.userData.dims = size.multiplyScalar(scale);
  template.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.geometry.userData.shared = true; // clones share it; disposeSubtree must skip it
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.side = THREE.FrontSide; // Meshy exports DoubleSide
  });
  return template;
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
  | "pack-medic" | "pack-engineer" | "pack-flamer" | "pack-drone" | "pack-jumper";

const kit = new Map<string, THREE.BufferGeometry>();
let kitState: "idle" | "loading" | "ready" | "failed" = "idle";

/** Authored geometry for a part, or undefined — callers fall back to a box. */
export function kitGeometry(part: KitPart): THREE.BufferGeometry | undefined {
  if (kitState === "idle") loadInfantryKit();
  return kit.get(part);
}

function loadInfantryKit(): void {
  kitState = "loading";
  loader.load(
    "models/infantry-kit.glb",
    (gltf) => {
      gltf.scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        // Bake the node's own transform in, drop everything but position+normal, and tag it
        // shared: one geometry serves every trooper wearing that part.
        geometry.applyMatrix4(mesh.matrixWorld);
        geometry.deleteAttribute("uv");
        geometry.userData.shared = true;
        kit.set(node.name, geometry);
      });
      kitState = "ready";
      version += 1; // rebuild entity groups so troopers pick the authored shapes up
    },
    undefined,
    () => { kitState = "failed"; },
  );
}

// A luminance-only copy of a GLB albedo, cached per source texture. Rocks and rubble are generated
// once in a warm desert palette and then placed on every map; multiplying a map tint into an
// orange albedo only ever yields darker orange, which is how a frozen causeway got desert rocks.
// Stripping the hue first lets the material colour carry the whole map tone while the texture
// keeps its crevices.
const greyCache = new WeakMap<THREE.Texture, THREE.Texture>();
export function greyscaleOf(map: THREE.Texture): THREE.Texture {
  const hit = greyCache.get(map);
  if (hit) return hit;
  const image = map.image as HTMLImageElement | ImageBitmap | HTMLCanvasElement;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = "grayscale(1)";
  ctx.drawImage(image, 0, 0);
  const grey = new THREE.CanvasTexture(canvas);
  grey.colorSpace = map.colorSpace;
  grey.flipY = map.flipY;
  grey.wrapS = map.wrapS;
  grey.wrapT = map.wrapT;
  grey.channel = map.channel;
  greyCache.set(map, grey);
  return grey;
}
