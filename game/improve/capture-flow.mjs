// ============================================================================
//  CAPTURE — scripted play-through that is the loop's VISUAL + STATE source.
// ----------------------------------------------------------------------------
//  Drives the real menu + HUD + window.__rht across every meaningful state and,
//  at each step, writes:
//    * a named screenshot  -> <cycleDir>/shots/NN-step.png   (visual evidence)
//    * a state snapshot    -> appended to <cycleDir>/state.json (logical trace)
//
//  Output dir comes from CYCLE_DIR (absolute); defaults to improve/cycles/adhoc.
//  Steps are isolated: a thrown step records { error } and the run continues so
//  the trace is always written (safe to stop / inspect a partial cycle).
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { chromium } from "playwright-core";
import { startServer, findChromium, sampleCanvas, waitForCommand, delay } from "./lib/harness.mjs";

const PORT = Number(process.env.IMPROVE_PORT ?? 5180);
const cycleDir = process.env.CYCLE_DIR
  ? (isAbsolute(process.env.CYCLE_DIR) ? process.env.CYCLE_DIR : join(process.cwd(), process.env.CYCLE_DIR))
  : join(process.cwd(), "improve", "cycles", "adhoc");
const shotsDir = join(cycleDir, "shots");
mkdirSync(shotsDir, { recursive: true });

const steps = [];
const consoleErrors = [];

/** Capture a screenshot + base state probe for a step, merging step-specific extra data. */
async function snap(page, name, label, extra = {}) {
  const shot = `${name}.png`;
  let base = {};
  try {
    await page.screenshot({ path: join(shotsDir, shot) });
    base = await page.evaluate(() => {
      const api = window.__rht;
      const sim = api?.sim;
      const sel = sim ? sim.entity(sim.selectedId) : undefined;
      return {
        phase: sim?.phase,
        turn: sim?.turn,
        money: sim ? { player: api.money("player"), enemy: api.money("enemy") } : undefined,
        field: sim ? { player: sim.fieldUnitCount("player"), enemy: sim.fieldUnitCount("enemy") } : undefined,
        selectedId: sim?.selectedId,
        selectedKind: sel?.kind,
      };
    });
    base.canvas = await sampleCanvas(page).catch(() => ({ ok: false }));
  } catch (err) {
    base.error = String(err?.message ?? err);
  }
  steps.push({ step: name, label, shot, ...base, ...extra });
  return steps[steps.length - 1];
}

const main = async () => {
  const { server, url } = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu", { timeout: 15000 });
    await delay(700); // fonts + first frames settle

    // 01 — Main menu ---------------------------------------------------------
    {
      const dom = await page.evaluate(() => ({
        mainMenu: Boolean(document.querySelector(".main-menu")),
        startButton: Boolean(document.querySelector('[data-menu="play"], .title-start')),
        pointsBadge: Boolean(document.querySelector(".main-menu .menu-points")),
        hints: Boolean(document.querySelector(".main-menu .title-hints")),
      }));
      await snap(page, "01-main-menu", "Main menu", { dom });
    }

    // 01b — Settings screen (action-pace control) ---------------------------
    await page.click('[data-menu="settings"]').catch(() => {});
    await page.waitForSelector('[data-set="pace"]', { timeout: 5000 }).catch(() => {});
    await delay(300);
    {
      const dom = await page.evaluate(() => ({
        paceChips: document.querySelectorAll('[data-set="pace"]').length,
      }));
      await snap(page, "01b-settings", "Settings — action pace", { dom });
    }
    // Back to the main menu, then into the deploy flow.
    await page.click('[data-back], .menu-back').catch(() => {});
    await page.waitForSelector(".main-menu", { timeout: 5000 }).catch(() => {});
    await delay(250);

    // 02 — Deploy / map-select screen ---------------------------------------
    await page.click('[data-menu="play"]');
    await page.waitForSelector("[data-start]", { timeout: 8000 });
    await page.waitForSelector('[data-map="ironworks"]', { timeout: 8000 }).catch(() => {});
    await delay(400);
    {
      const dom = await page.evaluate(() => ({
        maps: document.querySelectorAll(".map-card").length,
        modes: document.querySelectorAll(".mode-card").length,
        diffs: document.querySelectorAll(".diff-card").length,
        preview: Boolean(document.querySelector(".map-preview-svg, .map-preview svg")),
      }));
      await snap(page, "02-deploy-screen", "Deploy / map select", { dom });
    }

    // Deploy onto Ironworks, Annihilation, normal difficulty.
    await page.click('[data-map="ironworks"]').catch(() => {});
    await page.click('[data-mode="destroy"]').catch(() => {});
    await page.click("[data-start]");
    await page.waitForSelector(".menu-screen", { state: "detached", timeout: 6000 }).catch(() => {});
    await waitForCommand(page, 12000);
    await delay(500);

    // 03 — Battle start (REAL opening state — probed before any cheats) -------
    // Deselect so the auto-opened base deck doesn't cover the objective HUD / battlefield.
    await page.evaluate(() => window.__rht.deselect());
    await delay(350);
    {
      const dom = await page.evaluate(() => ({
        modeChip: Boolean(document.querySelector(".mode-chip")),
        // A real turn counter — match "Turn <n>" specifically, not the "End Turn" button.
        turnIndicator: /turn\s*\d+/i.test(document.querySelector(".turn-chip")?.textContent ?? ""),
        topbarText: (document.querySelector(".topbar")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      }));
      await snap(page, "03-battle-start", "Battle start (turn 1)", { dom });
    }

    // 03b — Zoom in on a raised mesa to verify the land-layer z-fighting is gone on zoom.
    await page.mouse.move(1040, 360);
    for (let i = 0; i < 7; i += 1) await page.mouse.wheel(0, -120);
    await delay(450);
    await snap(page, "03b-terrain-zoom", "Zoomed terrain (z-fighting check)", {});
    for (let i = 0; i < 7; i += 1) await page.mouse.wheel(0, 120); // restore zoom
    await delay(250);

    // From here on, grant a comfortable treasury so the harness exercises mechanics.
    const ids = await page.evaluate(() => {
      const sim = window.__rht.sim;
      sim.economy.set("player", 3000);
      const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
      const enemyBase = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
      return { baseId: base?.id, enemyBaseId: enemyBase?.id };
    });

    // 04 — Home Base command deck -------------------------------------------
    await page.click(`[data-select="${ids.baseId}"]`).catch(() => {});
    await delay(350);
    await snap(page, "04-base-deck", "Home Base command deck", {});

    // 05 — Deploy a Recruit (cost + CP + field-count contract) ---------------
    {
      const before = await page.evaluate(() => {
        const sim = window.__rht.sim;
        const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
        return { money: window.__rht.money("player"), field: sim.fieldUnitCount("player"), baseCp: base.commandPoints };
      });
      await page.click('[data-spawn="soldier"]').catch(() => {});
      await delay(350);
      const after = await page.evaluate(() => {
        const sim = window.__rht.sim;
        const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
        const recruit = sim.entities.find((e) => e.team === "player" && e.kind === "soldier" && e.id.startsWith("p-spawn-"));
        return { money: window.__rht.money("player"), field: sim.fieldUnitCount("player"), baseCp: base.commandPoints, recruitId: recruit?.id, spawned: Boolean(recruit) };
      });
      // Frame the freshly deployed recruit (centers the camera on it) so the screenshot
      // actually shows the new unit instead of the base command deck.
      if (after.recruitId) {
        await page.evaluate((id) => { window.__rht.deselect(); window.__rht.chooseBoardEntity(id); }, after.recruitId);
        await delay(450);
      }
      await snap(page, "05-deploy-unit", "Deployed a Recruit", {
        probe: {
          fieldDelta: after.field - before.field,
          moneyDelta: after.money - before.money,
          baseCpAfter: after.baseCp,
          spawned: after.spawned,
          recruitId: after.recruitId,
        },
      });
      ids.recruitId = after.recruitId;
    }

    // End turn so the recruit becomes ready and the base refills its CP.
    await page.evaluate(() => window.__rht.endTurn());
    await waitForCommand(page, 16000);
    await page.evaluate(() => window.__rht.sim.economy.set("player", 3000));

    // 06 — Research a doctrine ----------------------------------------------
    await page.click(`[data-select="${ids.baseId}"]`).catch(() => {});
    await page.waitForSelector('[data-tech="assault"]', { timeout: 6000 }).catch(() => {});
    await page.click('[data-tech="assault"]').catch(() => {});
    await delay(300);
    {
      const probe = await page.evaluate(() => {
        const base = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
        return { unlocked: base.unlockedTech ?? [] };
      });
      await snap(page, "06-research", "Researched Assault doctrine", { probe });
    }

    // End turn again so the recruit has fresh CP for the readability previews.
    await page.evaluate(() => window.__rht.endTurn());
    await waitForCommand(page, 16000);
    await page.evaluate(() => window.__rht.sim.economy.set("player", 3000));

    // 07 — Move-range ring ---------------------------------------------------
    {
      const probe = await page.evaluate((recruitId) => {
        const api = window.__rht;
        api.chooseBoardEntity(recruitId);
        api.setIntent("move");
        const r = api.sim.selectedActionRange();
        return { actionRange: r ? { kind: r.kind, radius: Math.round(r.radius * 100) / 100 } : null };
      }, ids.recruitId);
      await delay(450); // let the renderer draw the ring
      await snap(page, "07-move-range", "Move-range ring shown", { probe });
    }

    // 08 — Explosive ground-aim blast preview (recruit hand grenade) ---------
    {
      const probe = await page.evaluate((recruitId) => {
        const api = window.__rht;
        const sim = api.sim;
        api.chooseBoardEntity(recruitId);
        api.setIntent("grenade");
        const r = sim.entity(recruitId);
        // A spot a short toss in front of the recruit (toward the enemy half, +x).
        const point = { x: r.position.x + 3.5, z: r.position.z };
        const g = sim.groundAimPreview(point);
        return { groundAim: g ? { radius: Math.round(g.radius * 100) / 100, reachable: g.reachable, blocked: g.blocked } : null };
      }, ids.recruitId);
      // Hover the cursor over open ground to the unit's right so the renderer paints the
      // blast ring at a clear landing spot (the recruit is centered from the move-range step).
      await page.mouse.move(560, 470);
      await page.mouse.move(980, 455);
      await delay(500);
      await snap(page, "08-ground-aim", "Explosive ground-aim blast preview", { probe });
      await page.evaluate(() => window.__rht.setIntent("select"));
    }

    // 09 / 10 — Real combat: lob an arcing grenade at the enemy base so the resolve shows a
    // clear projectile + blast (a point-blank rifle bullet has no visible flight).
    await page.evaluate(({ recruitId, enemyBaseId }) => {
      const sim = window.__rht.sim;
      const recruit = sim.entity(recruitId);
      const enemyBase = sim.entity(enemyBaseId);
      // Stand a short, in-range toss away so the grenade visibly arcs across the gap.
      recruit.position = { x: enemyBase.position.x - (enemyBase.radius + 4), z: enemyBase.position.z };
      recruit.commandPoints = recruit.maxCommandPoints;
      recruit.grenades = Math.max(1, recruit.grenades);
      sim.select(recruitId);
      const part = enemyBase.parts.find((p) => p.hp > 0) ?? enemyBase.parts[0];
      if (!sim.queueGrenadePart(enemyBaseId, part.id)) {
        // Fall back to a rifle shot if the grenade can't reach.
        sim.queueShootPart(enemyBaseId, part.id);
      }
    }, ids);
    const enemyHpBefore = await page.evaluate((enemyBaseId) => {
      const e = window.__rht.sim.entity(enemyBaseId);
      return e.parts.reduce((a, p) => a + p.hp, 0);
    }, ids.enemyBaseId);
    await page.evaluate(() => window.__rht.endTurn());
    // 09 — poll the resolve and capture the exact frame the blast/impact is on screen (a
    // single arcing grenade is otherwise easy to miss).
    let captured09 = false;
    let sawProjectile = false;
    for (let i = 0; i < 80 && !captured09; i += 1) {
      const st = await page.evaluate(() => {
        const sim = window.__rht.sim;
        return {
          phase: sim.phase,
          proj: sim.projectiles.length,
          burst: sim.effects.some((e) => e.type === "blast" || e.type === "impact"),
        };
      });
      sawProjectile = sawProjectile || st.proj > 0;
      if (st.burst) { await snap(page, "09-resolve", "Resolve phase — grenade blast", {}); captured09 = true; break; }
      if (st.phase !== "resolve") break;
      await delay(45);
    }
    if (!captured09) {
      // Fall back: at least show a projectile-in-flight frame if we have orders still resolving.
      await page.waitForFunction(() => window.__rht.sim.projectiles.length > 0, undefined, { timeout: 2000 }).catch(() => {});
      await snap(page, "09-resolve", "Resolve phase", { probe: { sawProjectile } });
    }
    await waitForCommand(page, 16000);
    await delay(300);

    // 10 — post-resolve damage ----------------------------------------------
    {
      const enemyHpAfter = await page.evaluate((enemyBaseId) => {
        const e = window.__rht.sim.entity(enemyBaseId);
        return e.parts.reduce((a, p) => a + p.hp, 0);
      }, ids.enemyBaseId);
      const damageEntries = await page.evaluate(() => {
        const reports = window.__rht.sim.turnReports;
        const last = reports[reports.length - 1];
        return last ? last.entries.length : 0;
      });
      await snap(page, "10-post-resolve", "Post-resolve (damage applied)", {
        probe: { enemyHpDelta: enemyHpAfter - enemyHpBefore, damageEntries },
      });
    }

    // 10b — Destroyed enemy part still listed at 0 HP, via the real shoot-targeting flow ---
    {
      const setup = await page.evaluate(({ recruitId, enemyBaseId }) => {
        const sim = window.__rht.sim;
        const e = sim.entity(enemyBaseId);
        // Force a non-critical part to 0 to guarantee a destroyed part, and ready the recruit.
        const part = e.parts.find((p) => !p.critical && p.hp > 0) ?? e.parts.find((p) => !p.critical) ?? e.parts[0];
        part.hp = 0;
        const recruit = sim.entity(recruitId);
        recruit.commandPoints = recruit.maxCommandPoints;
        recruit.status.canShoot = true;
        return { partId: part.id, hadDestroyedPart: part.hp <= 0 };
      }, ids);
      // Drive the HUD exactly as a player would: select the recruit, arm Shoot, click the
      // enemy base as the target — the part list must then show the destroyed part at 0 HP.
      await page.click(`[data-select="${ids.recruitId}"]`).catch(() => {});
      await delay(150);
      const shootBtn = await page.$('[data-order-action="shoot"]');
      if (shootBtn) await shootBtn.click();
      await delay(150);
      const enemyChip = await page.$(`[data-select="${ids.enemyBaseId}"]`);
      if (enemyChip) await enemyChip.click();
      await delay(400);
      const destroyedPartListed = await page.evaluate((partId) => Boolean(document.querySelector(`[data-part="${partId}"]`)), setup.partId);
      await snap(page, "10-detail-destroyed", "Destroyed enemy part still listed while targeting", {
        probe: { hadDestroyedPart: setup.hadDestroyedPart, destroyedPartListed },
      });
      await page.evaluate(() => window.__rht.deselect());
    }

    // 11 — Build-placement range ring ---------------------------------------
    {
      const probe = await page.evaluate((baseId) => {
        const api = window.__rht;
        api.sim.economy.set("player", 3000);
        api.chooseBoardEntity(baseId);
        api.beginBuild("turret");
        const b = api.sim.buildPlacement();
        return { buildPlacement: b ? { radius: Math.round(b.radius * 100) / 100, center: b.center } : null };
      }, ids.baseId);
      await delay(450);
      const dom = await page.evaluate(() => ({
        placementBar: Boolean(document.querySelector(".placement-bar")),
        deckDucked: !document.querySelector(".spawn-options"), // full deck hidden during placement
      }));
      await snap(page, "11-build-placement", "Defense placement — deck ducked", { probe, dom });
      await page.evaluate(() => { window.__rht.sim.setPendingBuild(undefined); window.__rht.deselect(); });
    }

    // 11b — Unit roster: deploy a spread of types so the overhead role glyphs and the
    // map-tinted props can be reviewed for at-a-glance differentiation.
    {
      const probe = await page.evaluate(() => {
        const api = window.__rht;
        const sim = api.sim;
        const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
        base.unlockedTech = ["recon", "assault", "support", "ordnance", "armor", "siege"];
        for (const k of ["scout", "sniper", "heavy", "grenadier", "mortar", "tank", "artillery"]) {
          sim.economy.set("player", 99999);
          base.maxCommandPoints = 9;
          base.commandPoints = 9;
          base.spawnCooldowns = {};
          sim.select(base.id);
          api.queueSpawnTroop(k);
        }
        // Lay every player combat unit out in a tidy grid around the map centre.
        const units = sim.entities.filter((e) => e.team === "player" && !["base", "turret", "exturret", "wall", "cover"].includes(e.kind));
        const cols = 4;
        units.forEach((u, i) => {
          u.position = { x: -3.6 + (i % cols) * 2.5, z: -2.6 + Math.floor(i / cols) * 2.6 };
          u.commandPoints = 0;
        });
        const mid = units[Math.floor(units.length / 2)];
        if (mid) api.chooseBoardEntity(mid.id);
        return {
          kinds: [...new Set(units.map((u) => u.kind))],
          unitCount: units.length,
          coverCount: sim.entities.filter((e) => e.kind === "cover").length,
          markers: api.renderDebug().unitMarkers,
        };
      });
      await delay(250);
      await page.evaluate(() => window.__rht.deselect());
      // Zoom in on the cluster so the per-unit role glyphs are legible for review.
      await page.mouse.move(760, 440);
      for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -120);
      await delay(550);
      await snap(page, "11b-unit-roster", "Unit roster — role glyphs & themed props", { probe });
    }

    // 12 — Victory end-state -------------------------------------------------
    {
      const pointsBefore = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem("rht.progression.v1") || "{}").points ?? 0; } catch { return 0; }
      });
      // Reduce the enemy to its base on a 1-HP core, then land a REAL killing blow so the
      // sim's own checkEndState (which only runs on a damage event) declares victory.
      await page.evaluate(({ recruitId, enemyBaseId }) => {
        const sim = window.__rht.sim;
        for (const e of sim.entities.filter((x) => x.team === "enemy" && x.id !== enemyBaseId)) {
          for (const p of e.parts) p.hp = 0;
          e.status.alive = false;
        }
        const base = sim.entity(enemyBaseId);
        const core = base.parts.find((p) => p.role === "core") ?? base.parts.find((p) => p.critical) ?? base.parts[0];
        for (const p of base.parts) p.hp = p.id === core.id ? 1 : 0;
        base.status.alive = true;
        // Heal + ready the recruit point-blank so its shot reliably connects.
        const recruit = sim.entity(recruitId);
        for (const p of recruit.parts) p.hp = p.maxHp;
        recruit.status.alive = true;
        recruit.status.canShoot = true;
        recruit.commandPoints = recruit.maxCommandPoints;
        recruit.position = { x: base.position.x - (base.radius + 2.2), z: base.position.z };
        sim.select(recruitId);
        sim.queueShootPart(enemyBaseId, core.id);
      }, ids);
      await page.evaluate(() => window.__rht.endTurn());
      await page.waitForFunction(() => window.__rht.sim.phase === "victory" || window.__rht.sim.phase === "defeat", undefined, { timeout: 16000 }).catch(() => {});
      await delay(700); // let the frame loop award points + render the end screen
      const probeAndDom = await page.evaluate((pb) => {
        let pointsAfter = 0;
        try { pointsAfter = JSON.parse(localStorage.getItem("rht.progression.v1") || "{}").points ?? 0; } catch {}
        return {
          probe: { reward: pointsAfter - pb },
          dom: {
            endscreen: Boolean(document.querySelector(".endscreen")),
            endReturnControl: Boolean(document.querySelector('.endscreen [data-command="to-menu"]')),
          },
        };
      }, pointsBefore);
      await snap(page, "12-victory", "Victory end-state", probeAndDom);
    }

    // 13 — Debug scenario system: cut straight to a staged scenario and screenshot it.
    {
      const probe = await page.evaluate(() => {
        const list = window.__rht.scenarios();
        const ok = window.__rht.scenario("siege");
        const sim = window.__rht.sim;
        window.__rht.deselect();
        return {
          count: list.length,
          ok,
          map: sim.mapDef.id,
          enemyWalls: sim.entities.filter((e) => e.team === "enemy" && e.kind === "wall").length,
          playerTank: sim.entities.some((e) => e.team === "player" && e.kind === "tank"),
        };
      });
      await delay(650);
      await snap(page, "13-scenario-siege", "Debug scenario: siege (cut-to)", { probe });
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
};

let runError;
try {
  await main();
} catch (err) {
  runError = String(err?.stack ?? err?.message ?? err);
  console.error("capture-flow error:", runError);
}

const trace = {
  port: PORT,
  cycleDir,
  steps,
  consoleErrors,
  runError: runError ?? null,
};
writeFileSync(join(cycleDir, "state.json"), JSON.stringify(trace, null, 2));
console.log(`Captured ${steps.length} steps -> ${join(cycleDir, "state.json")} (${consoleErrors.length} console errors)`);
if (runError) process.exitCode = 1;
