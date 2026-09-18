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
  ["targeting", async (page) => {
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
      console.log(`  FAIL ${label} — ${findings.length} finding(s)`);
      for (const f of findings.slice(0, 6)) console.log(`         ${f.rule}: ${f.sel} — ${f.detail}`);
    }
  }
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
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 6).join("\n")); failures += 1; }
  if (failures) { console.error(`UI audit: ${failures} finding(s)`); process.exitCode = 1; }
  else console.log("UI audit passed: no overlap, truncation, clipping or occlusion.");
} finally {
  await close();
}
