// PROP VARIETY REVIEW: per map, a census of every cover kind on the board and a HUD-less close frame
// of each named section, so "does this map's furniture belong to its biome" is judged from pictures
// and a count, not from reading palettes. Output: shots/<prefix>props-<map>-<section>.png.
// Run: npm run shots:props [-- dustbowl karak]   (SHOT_PREFIX=before- for a baseline)
//      npm run shots:props -- lineup   -> every biome prop in two rows on open ground (close review)
import { mkdirSync } from "node:fs";
import { launchGame, assertLit, delay } from "../improve/lib/harness.mjs";

// Sections in WORLD (scaled) coordinates: [name, x, z, zoom].
const VIEWS = {
  dustbowl: [["river", -24, 0, 0.5], ["plateau", -18, 12, 0.5], ["scrub", -30, -12, 0.5]],
  ironworks: [["foundry", -18, 10, 0.5], ["railyard", -14, -11, 0.5], ["overpass", -6, 0, 0.5]],
  verdant: [["orchard", -21, -14, 0.5], ["chapel", -24, 5, 0.5], ["field", -16, 0, 0.5]],
  causeway: [["harbour", -30, 14, 0.5], ["village", -32, -16, 0.5], ["causeway", -14, 0, 0.5]],
  karak: [["precinct", -6, 6, 0.5], ["amphitheatre", -20, -16, 0.5], ["approach", -20, -2, 0.5]],
  crossfire: [["checkpoint", -10, 0, 0.5], ["radar", -24, 11, 0.5], ["trench", -12, -9, 0.5]],
};

const prefix = process.env.SHOT_PREFIX ?? "";
const args = process.argv.slice(2);
const lineup = args.includes("lineup");
const maps = args.filter((m) => VIEWS[m]);
if (!maps.length && !lineup) maps.push(...Object.keys(VIEWS));
// The biome props (plus the concrete wall), two rows of eight, on the Dust Bowl's flat river bed.
const LINEUP = [
  ["girder", "coil", "ingot", "wall", "haybale", "fence", "grave", "boat"],
  ["rack", "iceblock", "obelisk", "urn", "brazier", "hedgehog", "tower", "bones"],
];
mkdirSync("shots", { recursive: true });

const { page, errors, close } = await launchGame({ port: 5207, viewport: { width: 1600, height: 900 } });
try {
  await page.addStyleTag({ content: "#ui, .toast, .tooltip { display: none !important; }" });
  for (const map of maps) {
    await page.evaluate((map) => { window.__rht.startBattle(map, "destroy", "normal"); window.__rht.deselect(); }, map);
    await page.waitForFunction((map) => window.__rht.sim.mapDef.id === map, map);
    await delay(2500);
    const census = await page.evaluate(() => {
      const counts = {};
      for (const e of window.__rht.sim.entities) {
        if (e.kind !== "cover" || e.coverKind === "span") continue;
        counts[e.coverKind] = (counts[e.coverKind] ?? 0) + 1;
      }
      return counts;
    });
    const kinds = Object.keys(census).sort();
    console.log(`${map}: ${kinds.length} kinds  ${kinds.map((k) => `${k}×${census[k]}`).join(" ")}`);
    for (const [name, x, z, zoom] of VIEWS[map]) {
      await page.evaluate((v) => window.__rht.setView(v), { x, z, zoom, pitch: 0.72, yaw: 0.35 });
      await delay(900);
      await assertLit(page, `${map}-${name}`);
      await page.screenshot({ path: `shots/${prefix}props-${map}-${name}.png` });
    }
  }
  if (lineup) {
    await page.evaluate(() => { window.__rht.startBattle("dustbowl", "destroy", "normal"); window.__rht.deselect(); });
    await page.waitForFunction(() => window.__rht.sim.mapDef.id === "dustbowl");
    await delay(2000);
    await page.evaluate((rows) => {
      const sim = window.__rht.sim;
      // Clear the scenery near the rows so each prop stands alone.
      for (const e of sim.entities) if (e.kind === "cover" && Math.abs(e.position.z) < 8 && e.position.x > -34 && e.position.x < -4) e.position = { x: 200, z: 200 };
      sim.entities.splice(0, sim.entities.length, ...sim.entities.filter((e) => e.position.x !== 200));
      rows.forEach((row, r) => row.forEach((kind, i) => { const c = sim.debugCover(kind, { x: -30 + i * 3, z: r === 0 ? -2.4 : 2.6 }); c.yaw = 0.4; }));
    }, LINEUP);
    for (const [name, view] of [["lineup-a", { x: -24, z: 0.2, zoom: 0.46, pitch: 0.62, yaw: 0.3 }], ["lineup-b", { x: -13, z: 0.2, zoom: 0.46, pitch: 0.62, yaw: 0.3 }]]) {
      await page.evaluate((v) => window.__rht.setView(v), view);
      await delay(1200);
      await assertLit(page, name);
      await page.screenshot({ path: `shots/${prefix}props-${name}.png` });
    }
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
} finally {
  await close();
}
