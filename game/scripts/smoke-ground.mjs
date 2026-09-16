// ============================================================================
//  GROUND SMOKE — the anti-hatching gate.
// ----------------------------------------------------------------------------
//  THE BUG THIS EXISTS TO PREVENT (it cost most of a day, twice):
//
//  A fine dashed hatching appeared across the ground on every map. It was chased
//  through three rounds of ground-texture tuning, two shadow-bias changes and a
//  whole shadow-frustum rewrite — none of which was where it lived. The cause was
//  the OUTER PLAIN: nine times the arena's extent, tiling the same detail texture
//  across all of it, minified into aliasing hash.
//
//  The class is general: a tiled detail texture is only safe on a surface the camera sees at a
//  workable angle and distance. Stretch one across a plane that runs off to the horizon and mip
//  selection gives up at the grazing end, which is what produces the hatching. So the invariant is
//  DON'T TEXTURE THE DISTANCE: no ground-lying surface materially larger than the playable arena
//  may carry a map. That is checkable, it is exactly the mistake that was made, and unlike "the
//  screenshot looks clean" it cannot be waved through by eye.
//
//  Run: npm run smoke:ground   (wired into smoke:core, so test:full runs it)
// ============================================================================
import { launchGame, delay } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard("smoke-ground");

const MAPS = ["ironworks", "dustbowl", "verdant", "causeway", "karak"];
// A textured ground surface may be at most this much bigger than the arena it belongs to. The
// legitimate ones (floor, mesa caps, the scattered plate layer) land at 1.0-1.8x because the plate
// blobs overshoot the bounds a little; the mistake this catches was NINE times.
const MAX_TEXTURED_SPAN = 2.2;

const { page, errors, close } = await launchGame({ port: 5202, query: "lowfx=1" });
let failures = 0;
try {
  for (const mapId of MAPS) {
    await page.evaluate((id) => window.__rht.startBattle(id, "destroy", "normal"), mapId);
    await page.waitForFunction((id) => window.__rht.sim.mapDef.id === id, mapId);
    await delay(500);
    const findings = await page.evaluate(() => {
      const b = window.__rht.sim.mapDef.terrain.bounds;
      const arenaW = b.maxX - b.minX;
      const arenaD = b.maxZ - b.minZ;
      const out = [];
      const root = window.__rht.sceneRoot();
      root.updateMatrixWorld(true);
      // WORLD-space bounds, not local. A ground plane is a PlaneGeometry rotated flat, so in local
      // space its depth sits on Y and its Z extent is zero — measuring locally skipped every plane
      // in the scene, which is how the first version of this gate passed the very bug it exists to
      // catch. (Proven by fault injection; do not "simplify" this back to geometry.boundingBox.)
      root.traverse((o) => {
        if (!o.isMesh || !o.material || !o.material.map) return;
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const m = o.matrixWorld.elements;
        // Transform the eight local corners by matrixWorld and take the extent. Plain arithmetic,
        // so the probe needs no THREE constructor of its own.
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (const cx of [bb.min.x, bb.max.x]) {
          for (const cy of [bb.min.y, bb.max.y]) {
            for (const cz of [bb.min.z, bb.max.z]) {
              const p = [
                m[0] * cx + m[4] * cy + m[8] * cz + m[12],
                m[1] * cx + m[5] * cy + m[9] * cz + m[13],
                m[2] * cx + m[6] * cy + m[10] * cz + m[14],
              ];
              for (let i = 0; i < 3; i += 1) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; }
            }
          }
        }
        const w = hi[0] - lo[0];
        const h = hi[1] - lo[1];
        const d = hi[2] - lo[2];
        // Ground-lying = wide, deep and flat. Props, units and the sky are not what this is about.
        if (w < 20 || d < 20 || h > 4) return;
        out.push({ name: o.name || o.type, w: Math.round(w), d: Math.round(d), spanW: w / arenaW, spanD: d / arenaD });
      });
      return out;
    });
    // SECOND INVARIANT — NO COPLANAR GROUND PLATES (ledger #3, found again 2026-09-15). The plate
    // layer is three variant meshes of overlapping blobs. When two blobs from different meshes sat
    // at the same height, every overlap z-fought into dashed "teeth" along the patch rims — which
    // read as a shadow artefact and survived a shadow bisection because it never was one. So: every
    // distinct plate height must be unique across the whole layer and clear of the floor top (-0.02)
    // and water surface (-0.015) by more than the depth buffer resolves at the far edge (~2mm at
    // near=1; we demand 1cm).
    const plateHeights = await page.evaluate(() => {
      const ys = [];
      window.__rht.sceneRoot().traverse((o) => {
        if (o.name !== "plates") return;
        o.traverse((m) => {
          if (!m.isMesh) return;
          const pos = m.geometry.getAttribute("position");
          const seen = new Set();
          for (let i = 0; i < pos.count; i += 1) seen.add(Math.round(pos.getY(i) * 1e4) / 1e4);
          ys.push([...seen]);
        });
      });
      return ys;
    });
    const all = plateHeights.flat();
    const sorted = [...all].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] < 0.004) {
        failures += 1;
        console.log(`  FAIL ${mapId}: two ground-plate heights ${sorted[i - 1]} and ${sorted[i]} are within 4mm — coplanar plates z-fight into dashed teeth.`);
        break;
      }
    }
    if (sorted.length && sorted[0] < -0.015 + 0.01) {
      failures += 1;
      console.log(`  FAIL ${mapId}: lowest ground plate at y=${sorted[0]} sits within 1cm of the water/floor surface.`);
    }
    for (const f of findings) {
      if (f.spanW <= MAX_TEXTURED_SPAN && f.spanD <= MAX_TEXTURED_SPAN) continue;
      failures += 1;
      console.log(
        `  FAIL ${mapId}: a textured ground surface spans ${f.w}x${f.d} units — ` +
        `${f.spanW.toFixed(1)}x${f.spanD.toFixed(1)} times the arena. Tiled detail on a plane that ` +
        `runs to the horizon aliases into hatching; give the distance a flat tone.`
      );
    }
    if (!failures) console.log(`  ok   ${mapId}: ${findings.length} textured ground surface(s), none oversized; ${all.length} plate heights, all distinct`);
  }
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 6).join("\n")); failures += 1; }
  if (failures) { console.error(`Ground smoke: ${failures} failure(s) — see the header of this file.`); process.exitCode = 1; }
  else console.log("Ground smoke passed: no tiled detail texture runs off to the horizon.");
} finally {
  await close();
}
