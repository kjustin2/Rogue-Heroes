/**
 * Winter-skin pack via Meshy RETEXTURE (~10 credits each — reuses the committed meshes'
 * refine task ids from the .meshy.json sidecars, no regeneration).
 *
 *   node --env-file=../.env scripts/retexture-models.mjs
 *
 * Raw results cache in assets-raw/, optimized GLBs land in public/models/<name>-winter.glb.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const KEY = process.env.MESHY_API_KEY;
if (!KEY || KEY.length < 8) {
  console.error("MESHY_API_KEY not set (run with --env-file=../.env)");
  process.exit(1);
}
const HEAD = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const API = "https://api.meshy.ai/openapi/v1/retexture";
const MODELS = ["tank", "apc", "artillery", "hq", "turret"];
const PROMPT = "arctic winter camouflage, snow-dusted white and pale gray disruptive camo pattern, weathered metal, frost on edges, military vehicle";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync("assets-raw", { recursive: true });

const run = (cmd, args) => {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: cmd !== "node" && process.platform === "win32" });
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}`);
};

for (const name of MODELS) {
  const out = `public/models/${name}-winter.glb`;
  const raw = `assets-raw/${name}-winter.glb`;
  if (existsSync(out)) {
    console.log(`skip ${name}: ${out} exists`);
    continue;
  }
  if (!existsSync(raw)) {
    const sidecar = JSON.parse(readFileSync(`public/models/${name}.meshy.json`, "utf8"));
    const sourceTask = sidecar.refineId ?? sidecar.previewId;
    console.log(`retexture ${name} (task ${sourceTask}) ...`);
    const res = await fetch(API, {
      method: "POST",
      headers: HEAD,
      body: JSON.stringify({ input_task_id: sourceTask, text_style_prompt: PROMPT, enable_pbr: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`POST ${res.status}: ${JSON.stringify(body)}`);
    const id = body.result;
    for (;;) {
      await sleep(5000);
      const poll = await (await fetch(`${API}/${id}`, { headers: HEAD })).json();
      process.stdout.write(`\r  ${name}: ${poll.status} ${poll.progress ?? 0}%   `);
      if (poll.status === "SUCCEEDED") {
        const glb = poll.model_urls?.glb;
        if (!glb) throw new Error("no glb url");
        const buf = Buffer.from(await (await fetch(glb)).arrayBuffer());
        writeFileSync(raw, buf);
        console.log(`\n  saved raw ${raw} (${(buf.length / 1024).toFixed(0)} KB)`);
        break;
      }
      if (poll.status === "FAILED" || poll.status === "CANCELED") throw new Error(`${name} ${poll.status}: ${JSON.stringify(poll.task_error ?? {})}`);
    }
  }
  run("npx", ["gltf-transform", "optimize", raw, out, "--compress", "meshopt", "--texture-compress", "webp", "--texture-size", "1024", "--simplify-error", "0.001"]);
  console.log(`  ${out}: ${(statSync(out).size / 1024).toFixed(0)} KB`);
}
console.log("done.");
