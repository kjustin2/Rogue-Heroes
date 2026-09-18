// Print every mesh node in a GLB: name, triangle count, vertex attributes, bounding box.
// Usage: node scripts/inspect-glb.mjs public/models/infantry-kit.glb
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
let total = 0;
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    const pos = prim.getAttribute("POSITION");
    const tris = idx ? idx.getCount() / 3 : pos.getCount() / 3;
    total += tris;
    const mn = pos.getMin([]).map((v) => v.toFixed(2)).join(",");
    const mx = pos.getMax([]).map((v) => v.toFixed(2)).join(",");
    let colStats = "";
    const col = prim.getAttribute("COLOR_0");
    if (col) {
      const n = col.getCount(); const el = col.getElementSize(); const v = [];
      let lo = 1, hi = 0, sum = 0;
      for (let i = 0; i < n; i += 1) { col.getElement(i, v); const r = v[0]; lo = Math.min(lo, r); hi = Math.max(hi, r); sum += r; }
      colStats = ` ao[min ${lo.toFixed(2)} mean ${(sum / n).toFixed(2)} max ${hi.toFixed(2)} x${el}]`;
    }
    console.log(node.getName().padEnd(24), String(tris).padStart(6), prim.listSemantics().join(",").padEnd(36), `[${mn}] [${mx}]` + colStats);
  }
}
console.log("nodes", root.listNodes().length, "tris", total);
