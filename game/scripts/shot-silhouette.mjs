// ============================================================================
//  SILHOUETTE SHEET — the black-shape test.
// ----------------------------------------------------------------------------
//  Renders every unit kind as a flat black shape on white (window.__rht.silhouette)
//  and tiles them in rows. The judgement is binary and you make it by eye: can you
//  NAME each unit from its outline alone? A recolour variant or a shared chassis
//  fails on sight, which is what colour and kit detail hide in a normal shot.
//
//  Run: npm run shots:silhouette   ->  shots/silhouette/
// ============================================================================
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchGame, delay } from "../improve/lib/harness.mjs";

const OUT = join("shots", "silhouette");
mkdirSync(OUT, { recursive: true });

const ROWS = [
  ["01-line", ["soldier", "scout", "sniper", "striker"]],
  ["02-weight", ["heavy", "grenadier", "mortar", "flamer"]],
  ["03-support", ["medic", "engineer", "sapper", "droneop", "jumper"]],
  ["04-vehicles", ["tank", "apc", "artillery"]],
];

const { page, errors, close } = await launchGame({ port: 5194, query: "?lowfx=1", viewport: { width: 1600, height: 560 } });
try {
  // The sheet is the SHAPES; the HUD panels were covering the first and last of a five-wide rank.
  await page.addStyleTag({ content: "#ui, .toast { visibility: hidden !important; }" });
  for (const [name, kinds] of ROWS) {
    await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    await page.evaluate(({ kinds, spacing }) => {
      const sim = window.__rht.sim;
      sim.debugGrant("player", 9000);
      // Only the staged kinds belong in a shape test: drop the bases and starting units the
      // battle sets up, or the row is a crowd and every outline overlaps its neighbour.
      sim.debugClearField();
      kinds.forEach((k, i) => {
        sim.debugSpawn(k, "player", { x: 0, z: -(kinds.length - 1) * 0.5 * spacing + i * spacing });
      });
      window.__rht.deselect();
      // Side-on, low pitch. The outline is the whole point, and shooting a rank of troopers
      // head-on foreshortens the long rifles, tool rigs and blades that distinguish them into
      // nothing — the first version of this sheet failed four kits that were actually fine.
      // Units are staged along x, so the camera looks down the rank from the side.
      window.__rht.setView({ x: 0, z: 0, zoom: kinds.length > 4 ? 0.4 : 0.34, pitch: 0.26, yaw: 1.5 });
      window.__rht.silhouette(true);
    }, { kinds, spacing: kinds.length > 3 ? 2.6 : 4.4 });
    await delay(800);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await page.evaluate(() => window.__rht.silhouette(false));
    console.log("  shot", name, "->", kinds.join(", "));
  }
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} finally {
  await close();
}
