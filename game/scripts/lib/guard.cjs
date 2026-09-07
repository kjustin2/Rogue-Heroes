/* eslint-disable */
// TEST-RUN GOVERNOR — the "never crash the computer again" layer.
//
// Every test script (node smoke, Electron harness, the improvement loop) inits
// this guard. It enforces, machine-wide:
//
//   1. WATCHDOG   — a hard wall-clock budget. If the script (or a hung renderer
//                   IPC await) blocks past it, the guard force-exits and kills
//                   every tracked child. A hung test must die, not squat the GPU.
//   2. LOCK      — one guarded test at a time on this machine (lock file in the
//                   OS temp dir). Parallel test fan-out is how N Chromiums
//                   saturate the CPU/GPU and freeze the desktop. Children of a
//                   guarded parent (suite runner / loop stages) inherit the lock
//                   via GUARD_OWNER_PID and skip acquiring.
//   3. MEMORY    — a sentinel polls available system RAM; below the floor it
//                   aborts the run before the machine starts swapping to death.
//   4. PRIORITY  — the test drops to BELOW_NORMAL so the desktop stays
//                   responsive (Windows children inherit iff parent is
//                   below-normal/idle — so this covers Chromium/renderers too).
//   5. CLEANUP   — tracked child processes are tree-killed (taskkill /T /F) on
//                   every exit path: success, failure, timeout, signal, throw.
//
// Usage (node .mjs — named import from CJS works):
//   import { guard } from "./lib/guard.cjs";
//   guard({ name: "smoke-flow" });                    // defaults: 10 min budget
//
// Usage (Electron .cjs main):
//   const { guard, guardWindow, track } = require("./lib/guard.cjs");
//   guard({ name: "perf-soak", maxMinutes: 20 });
//   ... guardWindow(win);   // unresponsive / renderer-gone → abort, not log
//
// guard() is idempotent; calling again with a larger maxMinutes re-arms the
// watchdog (the orchestrator does this to extend past the lib default).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCK_FILE = path.join(os.tmpdir(), "game-test-guard.lock");
const IS_WIN = process.platform === "win32";
const IS_ELECTRON = !!process.versions.electron;

const state = {
  inited: false,
  name: "test",
  startedAt: 0,
  maxMs: 0,
  ownsLock: false,
  watchdog: null,
  memTimer: null,
  children: new Set(), // pids
  aborting: false,
};

const log = (...a) => console.error(`[guard:${state.name}]`, ...a);

// ── process-tree kill ───────────────────────────────────────────────────────
function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch { /* already gone */ }
}

/** Track a child process (or raw pid) for guaranteed cleanup on every exit path. */
function track(childOrPid) {
  const pid = typeof childOrPid === "number" ? childOrPid : childOrPid?.pid;
  if (pid) state.children.add(pid);
  return childOrPid;
}
function untrack(childOrPid) {
  const pid = typeof childOrPid === "number" ? childOrPid : childOrPid?.pid;
  if (pid) state.children.delete(pid);
}
function killTracked() {
  for (const pid of state.children) killTree(pid);
  state.children.clear();
}

/** Abort-time backstop: also tree-kill any UNTRACKED direct children (a spawned
 *  electron/npm the script forgot to track) so an abort never orphans them. */
function killDirectChildren() {
  if (!IS_WIN) return;
  try {
    const ps = spawnSync("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: "utf8", timeout: 10000 });
    for (const line of (ps.stdout || "").split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (pid && pid !== process.pid) killTree(pid);
    }
  } catch { /* best effort */ }
}

// ── the one exit path ───────────────────────────────────────────────────────
function abort(reason, code = 3) {
  if (state.aborting) return;
  state.aborting = true;
  log(`ABORT: ${reason}`);
  log(`ran ${Math.round((Date.now() - state.startedAt) / 1000)}s of a ${Math.round(state.maxMs / 60000)}min budget`);
  killTracked();
  killDirectChildren();
  releaseLock();
  if (IS_ELECTRON) {
    try {
      const { app, BrowserWindow } = require("electron");
      for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch { /* gone */ } }
      app.exit(code);
    } catch { /* fall through */ }
  }
  process.exit(code);
}

// ── machine-wide lock ───────────────────────────────────────────────────────
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function releaseLock() {
  if (!state.ownsLock) return;
  try { const l = readLock(); if (l && l.pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch { /* fine */ }
  state.ownsLock = false;
}

const sleepSync = (ms) => {
  // Blocking sleep is fine here: we're serializing on purpose, before any work starts.
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
};

function acquireLock(lockWaitMs) {
  // A guarded ancestor (suite runner, loop orchestrator) already holds the lock
  // for this process tree — inherit it instead of deadlocking against it.
  const owner = Number(process.env.GUARD_OWNER_PID || 0);
  if (owner && owner !== process.pid && pidAlive(owner)) return;

  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      fs.writeFileSync(
        LOCK_FILE,
        JSON.stringify({ pid: process.pid, name: state.name, startedAt: Date.now(), expiresAt: Date.now() + state.maxMs + 60_000 }),
        { flag: "wx" },
      );
      state.ownsLock = true;
      process.env.GUARD_OWNER_PID = String(process.pid); // children inherit → they skip locking
      return;
    } catch { /* lock exists */ }

    const l = readLock();
    if (!l || !pidAlive(l.pid)) {
      try { fs.unlinkSync(LOCK_FILE); } catch { /* raced */ }
      continue; // stale (holder died) — reclaim
    }
    if (Date.now() > (l.expiresAt || 0)) {
      log(`lock holder "${l.name}" (pid ${l.pid}) exceeded its budget — killing its tree and reclaiming`);
      killTree(l.pid);
      try { fs.unlinkSync(LOCK_FILE); } catch { /* raced */ }
      continue;
    }
    if (Date.now() > deadline) {
      abort(`another guarded test ("${l.name}", pid ${l.pid}) holds the machine lock and hasn't finished — refusing to run in parallel`, 4);
    }
    log(`waiting for lock held by "${l.name}" (pid ${l.pid}) …`);
    sleepSync(5000);
  }
}

// ── init ────────────────────────────────────────────────────────────────────
/**
 * @param {object} [opts]
 * @param {string} [opts.name]           label for logs + the lock (default: script basename)
 * @param {number} [opts.maxMinutes=10]  hard wall-clock budget; force-exit past it
 * @param {number} [opts.minFreeMemMB=1500]  abort if available system RAM drops below this
 * @param {number} [opts.lockWaitMinutes=15] how long to wait for another test to finish
 * @param {boolean} [opts.keepPriority]  timing-GATED tests set this: below-normal priority
 *                                       skews absolute-ms frame budgets (a boot budget tripped
 *                                       the day the governor landed). Watchdog/lock/memory
 *                                       still apply — only the priority drop is skipped.
 */
function guard(opts = {}) {
  const maxMs = Math.round((opts.maxMinutes ?? 10) * 60_000);

  if (state.inited) {
    if (opts.name) state.name = opts.name;
    // Re-arm: an explicit call may extend the auto-guard's default budget.
    if (maxMs > state.maxMs) {
      state.maxMs = maxMs;
      clearTimeout(state.watchdog);
      armWatchdog();
      const l = readLock();
      if (state.ownsLock && l && l.pid === process.pid) {
        try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ ...l, expiresAt: state.startedAt + maxMs + 60_000 })); } catch { /* fine */ }
      }
      log(`budget extended to ${Math.round(maxMs / 60000)}min`);
    }
    return api;
  }

  state.inited = true;
  state.name = opts.name || path.basename(process.argv[1] || "test").replace(/\.(mjs|cjs|js)$/, "");
  state.startedAt = Date.now();
  state.maxMs = maxMs;

  // 4) priority first — everything we spawn inherits it (Windows inherits
  // the class only when the parent is below-normal/idle, which we now are).
  // keepPriority RAISES back to normal: when the suite runner (below-normal)
  // spawns a timing-gated smoke, the child inherits the drop — it must undo it
  // or absolute-ms frame budgets measure the scheduler, not the game.
  try {
    os.setPriority(process.pid, opts.keepPriority
      ? os.constants.priority.PRIORITY_NORMAL
      : os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch { /* unsupported */ }

  // 2) machine-wide serialization
  acquireLock(Math.round((opts.lockWaitMinutes ?? 15) * 60_000));

  // 1) watchdog — fires even while the script is stuck awaiting a dead renderer
  // IPC (the timer needs only a live event loop). unref'd so it never keeps a
  // finished script alive.
  armWatchdog();

  // 3) memory sentinel
  const minFree = (opts.minFreeMemMB ?? 1500) * 1024 * 1024;
  state.memTimer = setInterval(() => {
    if (os.freemem() < minFree) abort(`available system memory below ${Math.round(minFree / 1048576)}MB — stopping before the machine swaps to death`, 5);
  }, 5000);
  state.memTimer.unref();

  // 5) cleanup on every exit path
  process.on("exit", () => { killTracked(); releaseLock(); });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try { process.on(sig, () => abort(`received ${sig}`, 130)); } catch { /* not on this platform */ }
  }
  process.on("uncaughtException", (e) => abort(`uncaughtException: ${e && e.stack || e}`, 1));
  process.on("unhandledRejection", (e) => abort(`unhandledRejection: ${e && e.stack || e}`, 1));

  log(`armed — budget ${Math.round(maxMs / 60000)}min, mem floor ${opts.minFreeMemMB ?? 1500}MB, priority below-normal, lock ${state.ownsLock ? "acquired" : "inherited"}`);
  return api;
}

function armWatchdog() {
  const left = state.startedAt + state.maxMs - Date.now();
  state.watchdog = setTimeout(() => abort(`wall-clock budget exceeded (${Math.round(state.maxMs / 60000)}min) — likely a hung renderer/await`, 3), Math.max(1000, left));
  state.watchdog.unref();
}

// ── Electron helpers ────────────────────────────────────────────────────────
/** Wire a BrowserWindow so a dead/hung renderer ABORTS the test instead of
 *  being logged while the script waits forever on the next executeJavaScript. */
function guardWindow(win) {
  win.on("unresponsive", () => abort("renderer unresponsive (GPU/CPU starvation) — aborting instead of hanging"));
  win.webContents.on("render-process-gone", (_e, d) => abort(`renderer process gone: ${d.reason}`));
  return win;
}

/** Kill leftover test processes from previous crashed runs: electron/chrome
 *  whose command line references THIS repo's scripts (never the user's editor,
 *  never an unrelated app). Safe to call when no guarded test is running. */
function sweepOrphans(repoMarker = "Rogue-Hero-3") {
  if (!IS_WIN) return 0;
  let killed = 0;
  try {
    const ps = spawnSync("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -like '*${repoMarker}*' } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: "utf8", timeout: 15000 });
    const self = new Set([process.pid, process.ppid]);
    for (const line of (ps.stdout || "").split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (pid && !self.has(pid)) { killTree(pid); killed++; }
    }
  } catch { /* best effort */ }
  if (killed) log(`swept ${killed} orphaned test process tree(s)`);
  return killed;
}

// Literal export object — cjs-module-lexer needs this exact shape so ESM
// consumers can `import { guard } from "./lib/guard.cjs"` with named imports.
module.exports = { guard, guardWindow, track, untrack, killTree, sweepOrphans, abort };
const api = module.exports;
