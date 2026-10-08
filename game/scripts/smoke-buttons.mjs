// Exercises every interactive button across the menus and the in-battle HUD, asserting that
// each one does something sensible and that no console/page errors fire along the way.
import { mkdirSync } from "node:fs";
import { launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "smoke-buttons" });

const PORT = Number(process.env.SMOKE_PORT ?? 5191);
const OUT = "shots";
mkdirSync(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };
// EVERY PICK IS HEARD (owner 2026-10-07): a real pointer click on a menu or HUD control must request a sound (muted or not).
const silent = [];
const clickHeard = async (sel) => {
  await page.hover(sel).catch(() => undefined); // the hover whisper is not the click's sound: settle it first
  const before = await page.evaluate(() => window.__rht?.sfxPlayed?.() ?? -1);
  await page.click(sel);
  const after = await page.evaluate(() => window.__rht?.sfxPlayed?.() ?? -1);
  if (before >= 0 && after <= before) silent.push(sel);
};

const { page, errors, close } = await launchGame({
  port: PORT,
  viewport: { width: 1500, height: 900 },
  query: "lowfx=1",
  init: () => { try { localStorage.clear(); localStorage.setItem("rht.progression.v1", JSON.stringify({ points: 500, unlocked: ["default"], accent: "default" })); } catch {} },
});

try {
  // 1) The game must boot to the main menu.
  await page.waitForSelector(".main-menu");
  for (const sel of ['[data-menu="play"]', '[data-menu="tutorial"]', '[data-menu="armory"]', '[data-menu="settings"]']) {
    if (!(await page.$(sel))) fail(`Main menu missing button ${sel}`);
  }

  // 2) Settings — every control.
  await clickHeard('[data-menu="settings"]');
  await page.waitForSelector('[data-set="mute"]');
  await clickHeard('[data-set="mute"]');
  if (await muted(page) !== true) fail("Mute toggle did not mute");
  await clickHeard('[data-set="mute"]');
  if (await muted(page) !== false) fail("Mute toggle did not unmute");
  await clickHeard('[data-set="motion"]');
  await page.$$eval('[data-set="diff"]', (els) => els.forEach((e) => e.click()));
  await page.evaluate(() => { const r = document.querySelector('input[data-set="volume"]'); if (r) { r.value = "40"; r.dispatchEvent(new Event("input", { bubbles: true })); } });
  await clickHeard('[data-back]');
  await page.waitForSelector(".main-menu");

  // 3) Armory — unlock + equip a cosmetic.
  await clickHeard('[data-menu="armory"]');
  await page.waitForSelector(".armory-grid");
  const unlockBtn = await page.$('[data-unlock]');
  if (unlockBtn) {
    await unlockBtn.click();
    await page.waitForSelector(".armory-grid");
  }
  const equipBtn = await page.$('[data-equip]:not(.on)');
  if (equipBtn) { await equipBtn.click(); await page.waitForSelector(".armory-grid"); }
  await clickHeard('[data-back]');
  await page.waitForSelector(".main-menu");

  // 4) Deploy screen — every map preview renders, mode + difficulty selectable.
  await clickHeard('[data-menu="play"]');
  await page.waitForSelector(".map-preview-canvas");
  const mapIds = await page.$$eval("[data-map]", (els) => els.map((e) => e.dataset.map));
  for (const id of mapIds) {
    await clickHeard(`[data-map="${id}"]`);
    // The illustrated preview must actually PAINT the picked map: a non-trivial spread of colours
    // on the canvas (a blank or single-tone canvas fails) and a caption naming the map.
    const painted = await page.evaluate((mapId) => {
      const c = document.querySelector(".map-preview-canvas");
      const ctx = c && c.getContext("2d");
      if (!ctx) return { ok: false, why: "no canvas" };
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      const tones = new Set();
      for (let i = 0; i < data.length; i += 4 * 97) tones.add((data[i] >> 4) * 4096 + (data[i + 1] >> 4) * 256 + (data[i + 2] >> 4));
      const name = document.querySelector(".map-preview-caption strong")?.textContent || "";
      const card = document.querySelector(`[data-map="${mapId}"] strong`)?.textContent || "";
      return { ok: tones.size >= 12 && name.startsWith(card.replace(/(small|medium|large)$/i, "").trim()), tones: tones.size, name, card };
    }, id);
    if (!painted.ok) throw new Error(`map preview for ${id} not painted/captioned: ${JSON.stringify(painted)}`);
  }
  await clickHeard('[data-map="dustbowl"]');
  await page.evaluate((n) => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < n; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector(`[data-step-jump="${n}"]`).click(); }, 3); // the set-up is a step flow: mode + difficulty live on Rules
  await clickHeard('[data-mode="hill"]');
  await clickHeard('[data-diff="normal"]');
  await page.evaluate(() => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < 3; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector("[data-start]").click(); });
  await page.waitForSelector(".title-screen", { state: "detached", timeout: 4000 }).catch(() => {});
  if (await page.$(".main-menu")) fail("Start Game did not dismiss the menu");

  // 5) Base command deck — deploy, research, income, command, build.
  const baseId = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.economy.set("player", 4000);
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    base.commandPoints = 6;
    base.maxCommandPoints = 1;
    sim.select(base.id);
    return base.id;
  });
  await clickHeard(`[data-select="${baseId}"]`);
  await page.waitForSelector('[data-spawn="soldier"]');
  // Placed deploy: the card click arms the ring (nothing spent yet), then a ground point inside it
  // fields the troop THERE. Mirrors the build flow below.
  await clickHeard('[data-spawn="soldier"]');
  const armed = await page.evaluate(() => ({ pending: window.__rht.sim.pendingDeploy, intent: window.__rht.sim.intent, ring: Boolean(window.__rht.sim.deployPlacement()), spawned: window.__rht.sim.entities.some((e) => e.id.startsWith("p-spawn-")) }));
  if (armed.pending !== "soldier" || armed.intent !== "deploy" || !armed.ring) fail(`Deploy card did not arm placement: ${JSON.stringify(armed)}`);
  if (armed.spawned) fail("Arming placement must not spawn");
  if (!(await page.$(".placing-note"))) fail("Placing note missing while a deploy is armed");
  const placed = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    const point = { x: base.position.x + 2.5, z: base.position.z - 3.5 }; // clear of the turret spot below
    const ok = window.__rht.queueDeployAt("soldier", point);
    const unit = sim.entities.find((e) => e.id.startsWith("p-spawn-"));
    return { ok, point, at: unit && unit.position, pending: sim.pendingDeploy };
  });
  if (!placed.ok || !placed.at) fail(`Placed deploy failed: ${JSON.stringify(placed)}`);
  if (Math.hypot(placed.at.x - placed.point.x, placed.at.z - placed.point.z) > 2.2) fail(`Troop not fielded at the chosen point: ${JSON.stringify(placed)}`);
  if (placed.pending) fail("Placement did not clear after the deploy");
  await refreshBaseCp(page, baseId);
  // The base deck is now split into subcategory tabs — open each tab before its buttons.
  await clickHeard('[data-base-tab="tech"]');
  await clickHeard('[data-tech-lane="recon"]'); // one lane shows at a time
  await page.waitForSelector('[data-tech="recon"]');
  await clickHeard('[data-tech="recon"]');
  if (!(await page.evaluate(() => (window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").unlockedTech ?? []).includes("recon")))) fail("Tech button did not research");
  await refreshBaseCp(page, baseId);
  await clickHeard('[data-base-tab="upgrade"]');
  await page.waitForSelector('[data-base-upgrade="income"]');
  await clickHeard('[data-base-upgrade="income"]');
  if (await page.evaluate(() => (window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").incomeLevel ?? 0)) < 1) fail("Income upgrade button failed");
  await refreshBaseCp(page, baseId);
  await clickHeard('[data-base-upgrade="command"]');
  if (await page.evaluate(() => window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").maxCommandPoints) !== 2) fail("Command upgrade button failed");
  await refreshBaseCp(page, baseId);
  // The Gun Turret is research-gated (Assault doctrine) since batch 3: unlock it the way the tech
  // button would, so this step tests the Build button and placement, not the tree.
  await page.evaluate(() => {
    const base = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
    base.unlockedTech = [...(base.unlockedTech ?? []), "assault"];
  });
  await clickHeard('[data-base-tab="defenses"]');
  await page.waitForSelector('[data-build="turret"]');
  await clickHeard('[data-build="turret"]');
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    window.__rht.queueBuildStructure({ x: base.position.x + 4, z: base.position.z + 3 });
  });
  if (!(await page.evaluate(() => window.__rht.sim.entities.some((e) => e.kind === "turret")))) fail("Build button + placement failed");

  // 6) Unit action chain — select, Move arms, Shoot -> part -> Confirm queues an order.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const sol = sim.entities.find((e) => e.id.startsWith("p-spawn-") && e.kind === "soldier");
    const ebase = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
    // clear any cover near the line, set the soldier just in front of the enemy base
    sim.entities.filter((e) => e.kind === "cover").forEach((c) => { c.position.x = 0; c.position.z = 14; });
    sol.position = { x: ebase.position.x - 4, z: ebase.position.z };
    sol.commandPoints = 4;
    sol.stance = "standing";
    sim.select(sol.id);
  });
  const solId = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.id.startsWith("p-spawn-") && e.kind === "soldier").id);
  await clickHeard(`[data-select="${solId}"]`);
  await clickHeard('[data-order-action="move"]');
  if (await page.evaluate(() => window.__rht.sim.intent) !== "move") fail("Move button did not arm move mode");
  // Re-select to return to the action deck, then arm Shoot (the deck collapses once focused).
  await clickHeard(`[data-select="${solId}"]`);
  await page.waitForSelector('[data-order-action="shoot"]');
  await clickHeard('[data-order-action="shoot"]');
  await page.waitForSelector(".target-panel");
  const ebaseId = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "enemy").id);
  await clickHeard(`[data-select="${ebaseId}"]`);
  await page.waitForSelector(".part-choice");
  await clickHeard(".part-choice");
  const confirm = await page.$('[data-confirm="shoot"][data-disabled="false"]');
  if (!confirm) fail("Shoot confirm button was not enabled against a close base");
  await confirm.click();
  if (await page.evaluate(() => window.__rht.sim.orders.length) < 1) fail("Confirm Shoot did not queue an order");

  // Crouch the soldier via its action button.
  await page.evaluate(() => { const sim = window.__rht.sim; const sol = sim.entities.find((e) => e.id.startsWith("p-spawn-") && e.kind === "soldier"); sol.commandPoints = 2; sim.select(sol.id); });
  await clickHeard(`[data-select="${solId}"]`);
  await clickHeard('[data-order-action="defend"]');
  await clickHeard('[data-confirm="defend"]');
  if (await page.evaluate(() => window.__rht.sim.orders.some((o) => o.kind === "defend")) !== true) fail("Crouch/defend button did not queue");

  // 7) Log toggle open + close.
  await clickHeard(".log-toggle");
  await page.waitForSelector(".compact-log.expanded");
  await clickHeard(".log-toggle");
  await page.waitForFunction(() => !document.querySelector(".compact-log.expanded"));

  // 8) Unit Edit overlay.
  await clickHeard(`[data-detail="${solId}"]`);
  await page.waitForSelector(".unit-detail-panel");
  await clickHeard(`[data-edit-unit="${solId}"]`);
  await page.waitForSelector(".edit-overlay");
  await page.fill(".edit-name", "Sentinel");
  const accentBtn = await page.$(".edit-accent");
  if (accentBtn) await accentBtn.click();
  await clickHeard("[data-apply]");
  if (await page.evaluate((id) => window.__rht.sim.entity(id)?.name, solId) !== "Sentinel") fail("Edit overlay apply failed");

  // 9) Pause menu: Save, Controls (+ back), Resume.
  await clickHeard('[data-command="open-menu"]');
  await page.waitForSelector(".pause-overlay .pause-buttons");
  await clickHeard('[data-pause="save"]');
  await page.waitForFunction(() => document.querySelector("[data-feedback]")?.textContent?.includes("saved"));
  await clickHeard('[data-pause="controls"]');
  await page.waitForSelector(".controls-grid");
  await clickHeard('[data-back]');
  await page.waitForSelector(".pause-buttons");
  await clickHeard('[data-pause="resume"]');
  await page.waitForFunction(() => !document.querySelector(".pause-overlay"));

  // 10) End Turn button resolves.
  const turnBefore = await page.evaluate(() => window.__rht.sim.turn);
  await clickHeard('[data-command="end"]');
  await page.waitForFunction((t) => window.__rht.sim.phase === "command" && window.__rht.sim.turn > t, turnBefore, { timeout: 16000 });

  // 11) End screen buttons -> Play Again and Main Menu. (Flag a victory to surface the screen.)
  await page.evaluate(() => { window.__rht.sim.phase = "victory"; });
  await page.waitForSelector(".endscreen");
  if (!(await page.$('[data-command="reset"]')) || !(await page.$('[data-command="to-menu"]'))) fail("End screen missing Play Again / Main Menu buttons");
  await clickHeard('[data-command="to-menu"]');
  await page.waitForSelector(".main-menu");
  if (!(await page.$('[data-menu="continue"]'))) fail("Continue button missing after a save");

  if (errors.length) fail(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  if (silent.length) fail(`These clicks made no sound: ${[...new Set(silent)].join(", ")}`);
  console.log("Buttons smoke passed: menus, base deck, unit actions, log, edit, pause/save, end turn, end screen; every click heard.");
} finally {
  await close();
}

async function muted(page) {
  return page.evaluate(() => document.querySelector('[data-set="mute"]')?.textContent?.trim() === "Muted");
}
async function refreshBaseCp(page, baseId) {
  await page.evaluate((id) => { const b = window.__rht.sim.entity(id); b.commandPoints = 6; window.__rht.sim.select(id); }, baseId);
  await clickHeard(`[data-select="${baseId}"]`);
}
