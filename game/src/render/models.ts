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
  | "tank" | "apc" | "artillery" | "hq" | "turret" | "mortar-turret"
  | "barricade" | "sandbags" | "crates" | "rock";

// Horizontal footprint (max of width/length, world units) each model is scaled to —
// matched to the procedural builder it replaces so silhouettes read at gameplay scale.
const TARGET_SIZE: Record<ModelKey, number> = {
  tank: 3.4,
  apc: 3.2,
  artillery: 4.2,
  hq: 3.6,
  turret: 2.3,
  "mortar-turret": 2.1,
  barricade: 1.9,
  sandbags: 1.7,
  crates: 1.5,
  rock: 1.8,
};

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

const cache = new Map<ModelKey, THREE.Group | "loading" | "failed">();
let version = 0;

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
  const template = ensureLoad(key);
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

function ensureLoad(key: ModelKey): THREE.Group | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit instanceof THREE.Group ? hit : null;
  cache.set(key, "loading");
  const url = `${import.meta.env.BASE_URL}models/${key}.glb`;
  loader.load(
    url,
    (gltf) => {
      cache.set(key, normalize(gltf.scene, TARGET_SIZE[key]));
      version += 1;
    },
    undefined,
    () => {
      cache.set(key, "failed"); // no asset — procedural fallback stays in charge
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
