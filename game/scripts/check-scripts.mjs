// Syntax-check every harness script. `tsc` never sees these files, and an Electron script with a
// syntax error does not exit — it raises a modal error dialog and the run hangs silently (that is
// how smoke:electron sat broken behind a bad regex). Wired into `npm run verify`.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dirs = ["scripts", "scripts/lib", "improve", "improve/lib"];
const files = ["electron-main.cjs", ...dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(mjs|cjs|js)$/.test(f)).map((f) => join(d, f)))];
const bad = [];
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch (e) { bad.push(`${f}\n${String(e.stderr).split("\n").slice(0, 4).join("\n")}`); }
}
if (bad.length) { console.error(`Script syntax errors:\n${bad.join("\n")}`); process.exit(1); }
console.log(`Scripts OK: ${files.length} files parse.`);
