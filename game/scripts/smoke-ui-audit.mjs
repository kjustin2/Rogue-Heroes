// ============================================================================
//  UI AUDIT SMOKE — the HUD's geometry, checked instead of eyeballed.
// ----------------------------------------------------------------------------
//  Drives window.__rht.auditUI() across several viewports and several screens.
//  Every rule is a geometric fact (rect intersection, scrollWidth vs clientWidth,
//  elementFromPoint), so a failure is never a matter of taste — it is a panel on
//  top of a button, a card cut in half, or a label that lost its last word.
//
//  Run: npm run smoke:ui-audit
// ============================================================================
import { launchGame, delay } from "../improve/lib/harness.mjs";

// Includes the two that have actually broken here: a 16:9 laptop and an ultrawide.
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
];

const SCREENS = [
  // Back to the menu first, or "title" just re-audits whatever the previous screen left up.
  ["title", async (page) => { await page.evaluate(() => window.__rht.toMenu()); await delay(600); }],
  ["deploy", async (page) => { await page.click('[data-menu="play"]'); await delay(500); }],
  ["settings", async (page) => { await page.evaluate(() => window.__rht.toMenu()); await delay(400); await page.click('[data-menu="settings"]'); await delay(500); }],
  ["pause", async (page) => {
    await page.evaluate(() => window.__rht.scenario("firefight"));
    await delay(500);
    await page.click('[data-command="open-menu"]');
    await delay(400);
  }],
  ["victory", async (page) => {
    await page.evaluate(() => { document.querySelectorAll(".pause-overlay").forEach((e) => e.remove()); window.__rht.scenario("victory"); });
    await delay(700);
  }],
  ["battle", async (page) => {
    await page.evaluate(() => window.__rht.scenario("firefight"));
    await delay(700);
  }],
  ["roster", async (page) => {
    // Twenty units: the state that clipped the roster's last card.
    await page.evaluate(() => window.__rht.scenario("stress"));
    await delay(700);
  }],
  ["deck", async (page) => {
    // The base command deck (Deploy tab): the densest card grid in the game.
    await page.evaluate(() => {
      window.__rht.scenario("firefight");
      const sim = window.__rht.sim;
      sim.economy.set("player", 9000);
      const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
      if (base) sim.select(base.id);
    });
    await delay(700);
  }],
  ["tech", async (page) => { await page.click('[data-base-tab="tech"]'); await delay(500); }],
  ["defenses", async (page) => { await page.click('[data-base-tab="defenses"]'); await delay(500); }],
  ["support", async (page) => { await page.click('[data-base-tab="support"]'); await delay(500); }],
  ["upgrade", async (page) => { await page.click('[data-base-tab="upgrade"]'); await delay(500); }],
  ["info", async (page) => {
    // The unit Info panel beside the roster.
    await page.evaluate(() => {
      const sim = window.__rht.sim;
      const u = sim.entities.find((e) => e.team === "player" && e.kind !== "base");
      if (u) sim.select(u.id);
    });
    await delay(300);
    await page.click("[data-detail]");
    await delay(500);
  }],
  ["controls", async (page) => {
    await page.evaluate(() => document.querySelectorAll(".unit-detail-panel .close-btn").forEach((b) => b.click()));
    await page.click('[data-command="open-menu"]');
    await delay(300);
    await page.click('[data-pause="controls"]');
    await delay(500);
    await page.evaluate(() => document.querySelectorAll(".pause-overlay").forEach((e) => e.remove()));
  }],
  ["armory", async (page) => { await page.evaluate(() => window.__rht.toMenu()); await delay(400); await page.click('[data-menu="armory"]'); await delay(500); }],
  ["campaign", async (page) => { await page.evaluate(() => window.__rht.toMenu()); await delay(400); await page.click('[data-menu="campaign"]'); await delay(500); }],
  ["run", async (page) => { await page.evaluate(() => window.__rht.toMenu()); await delay(400); await page.click('[data-menu="run"]'); await delay(500); }],
  ["targeting", async (page) => {
    await page.evaluate(() => window.__rht.scenario("firefight"));
    await delay(500);
    // The state where the target panel used to open on top of the Menu button.
    await page.evaluate(() => {
      const sim = window.__rht.sim;
      const actor = sim.entities.find((e) => e.team === "player" && !e.kind.includes("base"));
      if (actor) { sim.debugSelect(actor.id); window.__rht.setIntent("shoot"); }
    });
    await delay(600);
  }],
];

const { page, errors, close } = await launchGame({ port: 5197, query: "?lowfx=1" });
let failures = 0;
const byRule = {};
const seen = new Map(); // sel+detail -> count, so the summary names each distinct offender once
try {
  await page.evaluate(() => document.fonts.ready);
  for (const size of VIEWPORTS) {
    await page.setViewportSize(size);
    await delay(250);
    for (const [name, setup] of SCREENS) {
      await setup(page);
      await delay(250);
      const findings = await page.evaluate(() => window.__rht.auditUI());
      const label = `${size.width}x${size.height} ${name}`;
      if (!findings.length) { console.log(`  ok   ${label}`); continue; }
      failures += findings.length;
      for (const f of findings) { byRule[f.rule] = (byRule[f.rule] || 0) + 1; const k = `${f.rule} ${f.sel} — ${f.detail}`; seen.set(k, (seen.get(k) || 0) + 1); }
      console.log(`  FAIL ${label} — ${findings.length} finding(s)`);
      for (const f of findings.slice(0, process.env.AUDIT_VERBOSE ? 400 : 6)) console.log(`         ${f.rule}: ${f.sel} — ${f.detail}`);
    }
  }
  // ONE-SCREEN RULE — at 720p the Skirmish page shows Map, Faction, Mode, Difficulty and Deploy
  // without scrolling the card body (CLAUDE.md: "every choice on a set-up page fits one 1280x720
  // screen"). The offscreen rule cannot see it because the body is a legitimate scroll container.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__rht.toMenu());
  await delay(400);
  await page.click('[data-menu="play"]');
  await delay(500);
  const oneScreen = await page.evaluate(() => {
    const body = document.querySelector(".menu-screen > .menu-content > .start-layout");
    const diff = document.querySelector("[data-diff]");
    const start = document.querySelector("[data-start]");
    const r = (el) => el ? el.getBoundingClientRect() : null;
    return { scroll: body ? body.scrollHeight - body.clientHeight : -1, diff: r(diff)?.bottom, start: r(start)?.bottom, h: window.innerHeight };
  });
  if (oneScreen.scroll > 1 || !oneScreen.diff || oneScreen.diff > oneScreen.h || oneScreen.start > oneScreen.h) {
    console.error(`ONE-SCREEN: the Skirmish page scrolls at 1280x720 (${JSON.stringify(oneScreen)})`);
    failures += 1;
  } else console.log("  ok   one-screen — Skirmish choices + Deploy all on a 720p screen");
  // FAULT INJECTION — the gate must be able to fail. Lay a strip over the Skirmish page's
  // Difficulty row (the shape of the real bug: the sticky Deploy bar over the faction cards) and
  // demand the occluded rule names it; then take the strip away and demand it goes quiet again.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(() => window.__rht.toMenu());
  await delay(400);
  await page.click('[data-menu="play"]');
  await delay(500);
  const injected = await page.evaluate(() => {
    const card = document.querySelector(".menu-screen > .menu-content");
    const strip = document.createElement("div");
    strip.id = "audit-fault";
    strip.textContent = "FAULT STRIP";
    strip.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:45%;z-index:5;background:#f00";
    card?.appendChild(strip);
    const found = window.__rht.auditUI().filter((f) => f.rule === "occluded").length;
    strip.remove();
    const after = window.__rht.auditUI().filter((f) => f.rule === "occluded").length;
    return { found, after };
  });
  if (injected.found === 0) { console.error("FAULT INJECTION: a strip over the Skirmish choices produced no 'occluded' finding — the gate is decorative"); failures += 1; }
  else if (injected.after !== 0) { console.error("FAULT INJECTION: findings persisted after the strip was removed"); failures += 1; }
  else console.log(`  ok   fault injection — ${injected.found} occluded control(s) under the strip, 0 without it`);
  // FAULT INJECTION 2 — readability. A 9px label in near-surface grey inside a card, and a bare
  // label floating over the canvas with no plate or halo; the size, contrast and surface rules
  // must each name their offender, and go quiet once it is gone.
  const readable = await page.evaluate(() => {
    const card = document.querySelector(".menu-screen > .menu-content");
    const tiny = document.createElement("div");
    tiny.id = "audit-fault-tiny";
    tiny.textContent = "tiny grey";
    tiny.style.cssText = "font-size:9px;color:#3a4652;position:absolute;left:20px;top:20px";
    card?.appendChild(tiny);
    const bare = document.createElement("div");
    bare.id = "audit-fault-bare";
    bare.textContent = "floating over the board";
    bare.style.cssText = "position:fixed;left:8px;bottom:8px;font-size:14px;color:#fff;background:transparent;text-shadow:none";
    document.body.appendChild(bare);
    const rules = (f) => f.rule;
    const found = window.__rht.auditUI().filter((f) => f.sel.includes("audit-fault")).map(rules);
    tiny.remove(); bare.remove();
    const after = window.__rht.auditUI().filter((f) => f.sel.includes("audit-fault")).length;
    return { found, after };
  });
  for (const rule of ["small-text", "contrast", "no-owned-surface"]) {
    if (!readable.found.includes(rule)) { console.error(`FAULT INJECTION: the '${rule}' rule did not fire on its planted offender — the gate is decorative`); failures += 1; }
  }
  if (readable.after !== 0) { console.error("FAULT INJECTION: readability findings persisted after the plants were removed"); failures += 1; }
  else console.log(`  ok   fault injection — readability rules fired: ${readable.found.join(", ")}`);
  const summary = Object.entries(byRule).map(([r, n]) => `${r}=${n}`).join(" ");
  if (summary) console.log(`  by rule: ${summary}  (${seen.size} distinct offenders)`);
  if (process.env.AUDIT_LIST) for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`    x${n} ${k}`);
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 6).join("\n")); failures += 1; }
  if (failures) { console.error(`UI audit: ${failures} finding(s)`); process.exitCode = 1; }
  else console.log("UI audit passed: no overlap, truncation, clipping, occlusion, small text or low contrast.");
} finally {
  await close();
}
