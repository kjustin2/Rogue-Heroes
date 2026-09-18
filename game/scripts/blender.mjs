// Run Blender headless with the given python script. Finds blender on PATH or under Program Files
// (the owner's install is not on PATH), so `npm run art:*` works on a fresh shell.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const candidates = ["blender"];
const root = "C:/Program Files/Blender Foundation";
if (existsSync(root)) for (const d of readdirSync(root).sort().reverse()) candidates.push(join(root, d, "blender.exe"));
for (const exe of candidates) {
  const r = spawnSync(exe, ["--background", "--python-exit-code", "1", "--python", ...process.argv.slice(2)], { stdio: "inherit", shell: false });
  if (r.error?.code === "ENOENT") continue;
  process.exit(r.status ?? 1);
}
console.error("blender not found on PATH or under Program Files/Blender Foundation");
process.exit(1);
