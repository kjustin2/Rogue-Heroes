// ============================================================================
//  ORCHESTRATE — run one full improvement cycle and assemble its report.
// ----------------------------------------------------------------------------
//  Pipeline:  vitest (logic) -> capture-flow (visual+trace) -> check-goals.
//
//  Each cycle gets its own immutable directory (improve/cycles/cycle-NNN) so the
//  loop is traceable and safe to stop/resume: a half-finished cycle never
//  corrupts earlier ones. improve/state/latest.json points at the newest cycle.
//
//  Usage:
//    node improve/run-cycle.mjs                 # new auto-numbered cycle
//    node improve/run-cycle.mjs --cycle 3       # (re)run into cycle-003
//    node improve/run-cycle.mjs --check-only --cycle 3   # re-evaluate goals only
//                                               # (after writing visual verdicts)
//    node improve/run-cycle.mjs --no-vitest     # skip the logic tests this pass
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cyclesDir = join(root, "improve", "cycles");
const stateDir = join(root, "improve", "state");
mkdirSync(cyclesDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function nextCycleNumber() {
  const nums = readdirSync(cyclesDir)
    .map((n) => /^cycle-(\d+)$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

const cycleNum = opt("--cycle") ? Number(opt("--cycle")) : nextCycleNumber();
const cycleName = `cycle-${String(cycleNum).padStart(3, "0")}`;
const cycleDir = join(cyclesDir, cycleName);
mkdirSync(join(cycleDir, "shots"), { recursive: true });

const env = { ...process.env, CYCLE_DIR: cycleDir };
const node = process.execPath;

function run(label, args, { allowFail = false } = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const res = spawnSync(node, args, { cwd: root, env, stdio: "inherit" });
  const ok = res.status === 0;
  if (!ok && !allowFail) process.stdout.write(`(${label} exited ${res.status})\n`);
  return ok;
}

const checkOnly = flag("--check-only");
let vitestOk = null;
let captureOk = null;

if (!checkOnly) {
  // 1) Logic tests -> vitest.json (json reporter). Allowed to fail; check-goals reads it.
  if (!flag("--no-vitest")) {
    vitestOk = run("vitest (logic tests)", [
      join("node_modules", "vitest", "vitest.mjs"),
      "run", "--reporter=json", `--outputFile=${join(cycleDir, "vitest.json")}`,
    ], { allowFail: true });
  }
  // 2) Scripted play-through -> shots/*.png + state.json
  captureOk = run("capture-flow (play-through + screenshots)", [
    join("improve", "capture-flow.mjs"),
  ], { allowFail: true });
}

// 3) Evaluate goals -> goals.json + report.md
run("check-goals (evaluate objectives)", [join("improve", "check-goals.mjs")], { allowFail: true });

// Update the latest-cycle pointer + cumulative ledger.
const goals = (() => { try { return JSON.parse(readFileSync(join(cycleDir, "goals.json"), "utf8")); } catch { return null; } })();
const latest = {
  lastCycle: cycleName,
  lastCycleDir: cycleDir,
  updatedAt: new Date().toISOString(),
  vitestOk,
  captureOk,
  met: goals?.met ?? null,
  total: goals?.total ?? null,
  allMet: goals?.allMet ?? false,
  pendingVisualReview: goals?.pendingVisualReview ?? [],
};
writeFileSync(join(stateDir, "latest.json"), JSON.stringify(latest, null, 2));

// Append to the run ledger for traceability.
const ledgerPath = join(stateDir, "ledger.jsonl");
const ledgerLine = JSON.stringify({
  cycle: cycleName, at: latest.updatedAt, met: latest.met, total: latest.total, allMet: latest.allMet,
  vitestOk, captureOk, pending: latest.pendingVisualReview,
}) + "\n";
writeFileSync(ledgerPath, (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "") + ledgerLine);

process.stdout.write(`\n=== ${cycleName} complete ===\n`);
process.stdout.write(`report:  ${join(cycleDir, "report.md")}\n`);
process.stdout.write(`goals:   ${latest.met}/${latest.total} met${latest.allMet ? " — ALL MET ✅" : ""}\n`);
if (latest.pendingVisualReview.length) {
  process.stdout.write(`pending visual review: ${latest.pendingVisualReview.join(", ")}\n`);
  process.stdout.write(`  -> review shots, write ${join(cycleDir, "visual-verdicts.json")}, then: node improve/run-cycle.mjs --check-only --cycle ${cycleNum}\n`);
}
