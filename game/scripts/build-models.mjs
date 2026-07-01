/**
 * Batch Meshy generation + optimization for the hero model set.
 *
 * Usage (node directly — npm run mangles flags):
 *   node --env-file=.env scripts/build-models.mjs --balance      # credit preflight only
 *   node --env-file=.env scripts/build-models.mjs                # generate ALL missing + optimize
 *   node --env-file=.env scripts/build-models.mjs --only tank    # one model
 *   node scripts/build-models.mjs --optimize-only                # re-optimize existing raws (no credits)
 *
 * Raw GLBs land in assets-raw/ (gitignored, kept so re-optimizing never re-spends credits).
 * Optimized GLBs + .meshy.json audit sidecars land in public/models/ (committed).
 * A model that already has a raw GLB is never regenerated — delete the raw to force it.
 */
import { existsSync, copyFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The hero set: gritty near-future military, weathered materials, symmetry via prompt
// (meshy-6 ignores the symmetry flag), no FX words (glow/smoke cause mesh artifacts).
const MANIFEST = [
  { name: "tank", polycount: 80000, prompt: "near-future main battle tank, low angular hull, layered composite armor plates, long smoothbore cannon with muzzle brake, commander cupola, weathered olive drab and gunmetal steel, chipped paint, dust-caked tracks, oil streaks, symmetrical design, game asset" },
  { name: "apc", polycount: 40000, prompt: "near-future tracked armored personnel carrier, tall boxy troop compartment, rear ramp, roof hatch with small remote autogun, vision slits, weathered desert tan armor plating, scratched panels, mud-spattered tracks, symmetrical design, game asset" },
  { name: "artillery", polycount: 40000, prompt: "near-future self-propelled howitzer, tracked chassis, extra long artillery barrel with slotted muzzle brake, hydraulic recoil cylinders, rear stabilizer spades, weathered gunmetal and olive drab, dusty chipped paint, symmetrical design, game asset" },
  { name: "hq", polycount: 80000, prompt: "near-future military command post building, low fortified bunker with angular armored plating, sandbag perimeter, tall comms mast with antenna array, rooftop floodlights, heavy blast door entrance, weathered concrete and rusted steel, battle-worn, game asset" },
  { name: "turret", polycount: 30000, prompt: "near-future automated defense turret, twin-barrel autocannon on rotating armored pedestal mount, ammunition feed box, sensor pod, weathered gunmetal steel, chipped paint, symmetrical design, game asset" },
  { name: "mortar-turret", polycount: 30000, prompt: "near-future stationary mortar battery emplacement, two upward-angled heavy mortar tubes on a reinforced armored platform, ammunition drum, hydraulic frame, weathered steel, dusty, game asset" },
  { name: "barricade", polycount: 12000, prompt: "concrete jersey barrier segment, exposed steel rebar at chipped corners, bullet pockmarks, cracked weathered gray concrete, dusty base, game asset" },
  { name: "sandbags", polycount: 12000, prompt: "military sandbag wall emplacement, two stacked rows of burlap sandbags in a shallow arc, worn faded khaki fabric, dusty, game asset" },
  { name: "crates", polycount: 12000, prompt: "stack of military supply crates, olive drab steel ammunition boxes and wooden crates with stenciled markings, scuffed edges, cargo straps, game asset" },
  { name: "rock", polycount: 12000, prompt: "large weathered desert boulder cluster, layered sandstone rock formation, wind-eroded, sun-bleached, dusty base, game asset" },
];

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 ? argv[i + 1] : null;
})();
const optimizeOnly = argv.includes("--optimize-only");

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
};

if (argv.includes("--balance")) {
  run("node", ["scripts/gen-model.mjs", "--balance"]);
  process.exit(0);
}

const jobs = MANIFEST.filter((m) => !only || m.name === only);
if (!jobs.length) {
  console.error(`no manifest entry named "${only}"`);
  process.exit(1);
}

for (const job of jobs) {
  const raw = `assets-raw/${job.name}.glb`;
  const out = `public/models/${job.name}.glb`;
  if (!existsSync(raw)) {
    if (optimizeOnly) { console.log(`skip ${job.name}: no raw GLB`); continue; }
    console.log(`\n=== generate ${job.name} (~30 credits) ===`);
    run("node", ["scripts/gen-model.mjs", "--name", job.name, "--prompt", job.prompt, "--polycount", String(job.polycount), "--out", "assets-raw"]);
  } else {
    console.log(`\n=== ${job.name}: raw exists, skipping generation ===`);
  }
  console.log(`--- optimize ${job.name} -> ${out}`);
  const texSize = job.polycount >= 40000 ? "1024" : "512";
  run("npx", ["gltf-transform", "optimize", raw, out, "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", texSize, "--simplify-error", "0.001"]);
  if (existsSync(`assets-raw/${job.name}.meshy.json`)) copyFileSync(`assets-raw/${job.name}.meshy.json`, `public/models/${job.name}.meshy.json`);
  console.log(`    ${(statSync(out).size / 1024).toFixed(0)} KB`);
}
console.log("\ndone.");
