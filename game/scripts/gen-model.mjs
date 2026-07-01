/**
 * Portable Meshy text-to-3D asset generator (drop into any Node/Vite project).
 *
 * Reads MESHY_API_KEY from the environment (never logged). Pins ai_model=meshy-6, runs the
 * two-stage flow — preview (mesh) -> refine (texture) — polls, downloads the GLB, prints the
 * credit balance before/after, and writes an auditable <name>.meshy.json sidecar.
 *
 * Setup:
 *   1. MESHY_API_KEY=... in a gitignored .env  (NO VITE_/NEXT_PUBLIC_ prefix — offline only)
 *   2. node --env-file=.env scripts/gen-model.mjs --name gargoyle --prompt "..."
 *   3. node --env-file=.env scripts/gen-model.mjs --balance   # remaining credits, no spend
 *
 * Flags: --name --prompt (<=600 chars) --out <dir> (default public/models/gen)
 *        --polycount N (100..300000, default 12000) --lowpoly --no-pbr --keep-lighting
 *        --preview-only --character (quad + T-pose, for a mesh you'll rig)
 *        --ai-model meshy-6|meshy-5 --pose t-pose|a-pose --topology triangle|quad
 *
 * Run with `node` directly (npm run mangles --flags). On meshy-6, style + symmetry are
 * PROMPT-driven (art_style/symmetry_mode/negative_prompt are no-ops) — put "symmetrical design"
 * and material words in the prompt; avoid FX words (smoke/glow/magic) that cause mesh artifacts.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const KEY = process.env.MESHY_API_KEY;
if (!KEY || KEY.length < 8) {
  console.error("MESHY_API_KEY not set. Run:  node --env-file=.env scripts/gen-model.mjs ...");
  process.exit(1);
}

const API = "https://api.meshy.ai/openapi/v2/text-to-3d";
const BALANCE = "https://api.meshy.ai/openapi/v1/balance";
const HEAD = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getBalance() {
  try {
    const res = await fetch(BALANCE, { headers: HEAD });
    if (!res.ok) return null;
    return (await res.json()).balance ?? null;
  } catch {
    return null;
  }
}

if (flag("balance")) {
  const b = await getBalance();
  console.log(b == null ? "balance: unavailable (check key / plan)" : `balance: ${b} credits`);
  process.exit(0);
}

const prompt = opt("prompt");
const name = opt("name", "asset");
if (!prompt) {
  console.error('Missing --prompt "..."');
  process.exit(1);
}
const aiModel = opt("ai-model", "meshy-6");
const character = flag("character");
const polycount = parseInt(opt("polycount", "12000"), 10);
const lowpoly = flag("lowpoly");
const previewOnly = flag("preview-only");
const pbr = !flag("no-pbr");
const removeLighting = !flag("keep-lighting");
const topology = opt("topology", character ? "quad" : "triangle");
const pose = opt("pose", character ? "t-pose" : undefined);
const outArg = opt("out", "public/models/gen");
const OUTDIR = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
mkdirSync(OUTDIR, { recursive: true });
const outGlb = join(OUTDIR, `${name}.glb`);
const outMeta = join(OUTDIR, `${name}.meshy.json`);

async function post(body) {
  const res = await fetch(API, { method: "POST", headers: HEAD, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status === 402) throw new Error("402 insufficient credits — top up at meshy.ai");
  if (res.status === 429) {
    await sleep(8000);
    return post(body);
  }
  if (!res.ok) throw new Error(`POST ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function poll(id, label) {
  let last = -1;
  for (;;) {
    const res = await fetch(`${API}/${id}`, { headers: HEAD });
    if (res.status === 429) {
      await sleep(8000);
      continue;
    }
    const t = await res.json();
    if (t.progress !== last) {
      process.stdout.write(`\r  ${label}: ${t.status} ${t.progress ?? 0}%   `);
      last = t.progress;
    }
    if (t.status === "SUCCEEDED") {
      process.stdout.write("\n");
      return t;
    }
    if (t.status === "FAILED" || t.status === "CANCELED") {
      process.stdout.write("\n");
      throw new Error(`${label} ${t.status}: ${JSON.stringify(t.task_error || {})}`);
    }
    await sleep(5000);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

const t0 = Date.now();
const bal0 = await getBalance();
console.log(`Meshy text-to-3D  ->  ${name}   [${aiModel}${character ? " · character/quad/T-pose" : ""}]`);
console.log(`  prompt: "${prompt}"`);
if (bal0 != null) console.log(`  credits available: ${bal0}  (full textured meshy-6 asset ≈ 30)`);

const prevBody = {
  mode: "preview",
  prompt,
  ai_model: aiModel,
  should_remesh: true,
  topology,
  target_polycount: polycount,
  auto_size: true,
  origin_at: "bottom",
  target_formats: ["glb"]
};
if (lowpoly) prevBody.model_type = "lowpoly";
if (pose) prevBody.pose_mode = pose;
const { result: previewId } = await post(prevBody);
console.log(`  preview task: ${previewId}`);
const prev = await poll(previewId, "preview");

let final = prev;
let refineId = null;
if (!previewOnly) {
  const refBody = { mode: "refine", preview_task_id: previewId, ai_model: aiModel, enable_pbr: pbr, target_formats: ["glb"] };
  if (removeLighting) refBody.remove_lighting = true;
  const { result: rid } = await post(refBody);
  refineId = rid;
  console.log(`  refine task:  ${refineId}`);
  final = await poll(refineId, "refine");
}

const glbUrl = final.model_urls?.glb;
if (!glbUrl) throw new Error("no GLB url in result");
const bytes = await download(glbUrl, outGlb);
const bal1 = await getBalance();
const credits = bal0 != null && bal1 != null ? bal0 - bal1 : (prev.consumed_credits || 0) + (previewOnly ? 0 : final.consumed_credits || 0);
writeFileSync(
  outMeta,
  JSON.stringify(
    { name, prompt, aiModel, character, previewId, refineId, topology, polycount, lowpoly, pbr, removeLighting, pose: pose || null, consumed_credits: credits, balance_after: bal1, bytes, seconds: Math.round((Date.now() - t0) / 1000), generatedAt: new Date().toISOString() },
    null,
    2
  )
);
console.log(`  saved: ${outGlb} (${(bytes / 1024).toFixed(0)} KB)`);
console.log(`  credits used: ${credits}${bal1 != null ? `  |  ${bal1} left` : ""}  |  ${Math.round((Date.now() - t0) / 1000)}s`);
if (bytes > 4_000_000) console.log(`  tip: ${(bytes / 1e6).toFixed(1)} MB is heavy for web — optimize: gltf-transform optimize in.glb out.glb --texture-size 1024`);
