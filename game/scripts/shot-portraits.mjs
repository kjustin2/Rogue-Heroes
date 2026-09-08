// UNIT PORTRAIT SHEET.
//
// A close, consistently framed shot of every single unit, structure and prop in the game, one per
// image, so model quality can actually be judged. The existing unit showcase stages units in rows
// at gameplay distance, which is the right test for READABILITY but useless for judging detail --
// at that size a beautifully built trooper and a placeholder box look identical.
//
// Every portrait uses the same camera, the same lighting and the same ground, so the sheet is a
// like-for-like comparison and a diff between rounds is meaningful.
// Out: shots/portraits/*.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "shot-portraits" });

const PORT = 5197;
const OUT = join("shots", "portraits");
mkdirSync(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };

// Troops get a tight lens; vehicles and structures are bigger so they need a little more room.
const TROOPS = [
  "soldier", "scout", "sniper", "striker", "heavy", "grenadier",
  "mortar", "medic", "engineer", "flamer", "droneop", "sapper",
];
const VEHICLES = ["tank", "apc", "artillery", "flak"];
const AIR = ["gunship", "interceptor", "bomber", "transport"];
// Structures and scenery. The owner asks about characters, BASES and OBJECTS, and until now the
// sheet only covered things that walk -- so the half of the screen made of emplacements and props
// was never actually looked at.
const STRUCTURES = ["base", "turret", "exturret", "wall"];
const COVER = ["fuel", "ammo", "conduit", "crate", "sandbag", "rock", "tree", "pillar", "container", "bunker", "depot", "barricade"];

const { page, errors, close } = await launchGame({
  port: PORT,
  viewport: { width: 900, height: 900 },
});

try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click("[data-map]");
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });

  // Clear the field so nothing else is in frame, and hide the HUD so the whole image is model.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.entities.splice(0, sim.entities.length);
    window.__rht.deselect();
    // Hide EVERYTHING that is not the canvas. The HUD lives in #ui, but the deploy veil, hint
    // toasts and objective banners are appended straight to <body>, so hiding #ui alone left them
    // sitting across the portrait.
    for (const node of document.body.children) {
      if (node.id !== "game") node.style.display = "none";
    }
    const style = document.createElement("style");
    style.textContent = "body > *:not(canvas){display:none !important}";
    document.head.appendChild(style);
  });
  // Let the deploy veil finish and be removed before the first frame is captured.
  await page.waitForTimeout(1400);

  const shoot = async (kind, zoom) => {
    const ok = await page.evaluate((k) => {
      const sim = window.__rht.sim;
      // One subject at the origin, facing slightly across the key light so the bevels read.
      sim.entities.splice(0, sim.entities.length);
      const unit = sim.debugSpawn(k, "player", { x: 0, z: 0 });
      // Face the camera. All the character is on a unit's front -- weapon, chest rig, visor --
      // and the previous angle photographed its back.
      unit.yaw = -0.72;
      return Boolean(unit) && unit.kind === k;
    }, kind);
    if (!ok) fail(`${kind}: debugSpawn produced the wrong kind`);
    await page.evaluate((z) => window.__rht.setView({ x: 0, z: -0.6, zoom: z, yaw: 0.7, pitch: 0.2 }), zoom);
    await page.waitForTimeout(420);
    await assertLit(page, `portrait ${kind}`);
    await page.screenshot({ path: join(OUT, `${kind}.png`) });
  };

  // debugSetView allows down to 0.18 (the interactive floor is 0.62), which is the whole reason
  // it exists -- close enough to actually inspect a model. Lower is nearer.
  const shootStructure = async (kind, zoom) => {
    await page.evaluate((k) => {
      const sim = window.__rht.sim;
      sim.entities.splice(0, sim.entities.length);
      const unit = k === "base"
        ? sim.debugStructure("base", "player", { x: 0, z: 0 })
        : sim.debugStructure(k, "player", { x: 0, z: 0 });
      if (unit) unit.yaw = -0.72;
    }, kind);
    await page.evaluate((z) => window.__rht.setView({ x: 0, z: -0.6, zoom: z, yaw: 0.7, pitch: 0.2 }), zoom);
    await page.waitForTimeout(420);
    await assertLit(page, `portrait ${kind}`);
    await page.screenshot({ path: join(OUT, `${kind}.png`) });
  };

  const shootCover = async (coverKind, zoom) => {
    await page.evaluate((k) => {
      const sim = window.__rht.sim;
      sim.entities.splice(0, sim.entities.length);
      sim.debugCover(k, { x: 0, z: 0 });
    }, coverKind);
    await page.evaluate((z) => window.__rht.setView({ x: 0, z: -0.6, zoom: z, yaw: 0.7, pitch: 0.2 }), zoom);
    await page.waitForTimeout(420);
    await assertLit(page, `portrait ${coverKind}`);
    await page.screenshot({ path: join(OUT, `cover-${coverKind}.png`) });
  };

  for (const kind of TROOPS) await shoot(kind, 0.34);
  for (const kind of VEHICLES) await shoot(kind, 0.46);
  for (const kind of AIR) await shoot(kind, 0.52);
  for (const kind of STRUCTURES) await shootStructure(kind, kind === "base" ? 0.62 : 0.4);
  for (const kind of COVER) await shootCover(kind, 0.36);

  if (errors.length) fail(`console errors:\n${errors.slice(0, 6).join("\n")}`);
  console.log(`Portraits: ${TROOPS.length + VEHICLES.length + AIR.length} units, ${STRUCTURES.length} structures, ${COVER.length} props -> ${OUT}`);
} finally {
  await close();
}
