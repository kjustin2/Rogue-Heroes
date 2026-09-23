// Faction identity sheet: one row per faction, HUD hidden, same framing. Each row stands the SHARED
// units (rifleman, marksman, medic) beside the faction's own signature units and one vehicle, so
// the same trooper can be compared across factions and the rosters read side by side. Bastion's
// rank is dug in (the sandbag ring). Out: shots/factions-{vanguard,syndicate,bastion}.png and the
// stacked sheet shots/factions.png. SwiftShader is fine for this: it judges shape and hue, not light.
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { launchGame, delay } from "../improve/lib/harness.mjs";

const ROWS = {
  vanguard: { units: ["soldier", "sniper", "medic", "scout", "jumper", "engineer"], vehicle: "tank" },
  syndicate: { units: ["soldier", "sniper", "medic", "striker", "flamer", "sapper"], vehicle: "apc" },
  bastion: { units: ["soldier", "sniper", "medic", "heavy", "mortar", "engineer"], vehicle: "tank" },
};
const prefix = process.env.SHOT_PREFIX ?? "";
mkdirSync("shots", { recursive: true });
const { page, close } = await launchGame({ port: 5207, viewport: { width: 1500, height: 640 } });
try {
  await page.waitForSelector(".main-menu");
  await page.addStyleTag({ content: "#ui, .toast, .mission-intro, .loading-veil { visibility: hidden !important; }" });
  const files = [];
  for (const [faction, row] of Object.entries(ROWS)) {
    const enemy = faction === "vanguard" ? "bastion" : "vanguard";
    await page.evaluate(([f, e]) => window.__rht.startBattle("dustbowl", "destroy", "normal", f, e), [faction, enemy]);
    await page.waitForFunction((f) => window.__rht?.sim?.phase === "command" && window.__rht.sim.factionIdOf("player") === f, faction, { timeout: 20000 });
    const center = await page.evaluate(([units, vehicle]) => {
      const sim = window.__rht.sim;
      const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
      const cx = base.position.x + (base.position.x < 0 ? 9 : -9);
      const cz = base.position.z;
      units.forEach((kind, i) => {
        const u = sim.debugSpawn(kind, "player", { x: cx - 4.5 + i * 1.5, z: cz }, { clearTerrain: true });
        u.yaw = 0.15;
        if (sim.factionOf("player").doctrine?.digIn) u.dugIn = sim.factionOf("player").doctrine.digIn; // staged: skip the turn of digging
      });
      const v = sim.debugSpawn(vehicle, "player", { x: cx + 6, z: cz - 0.5 }, { clearTerrain: true });
      v.yaw = -0.5; // nose toward the camera: the ram plough / dozer blade are on the front
      window.__rht.deselect();
      return { x: cx + 1, z: cz };
    }, [row.units, row.vehicle]);
    await delay(2500); // kits land, rigs rebuild with the faction dress
    await page.evaluate((c) => window.__rht.setView({ x: c.x, z: c.z - 0.3, zoom: 0.3, pitch: 0.48, yaw: 0.3 }), center);
    await delay(700);
    const file = `shots/${prefix}factions-${faction}.png`;
    await page.screenshot({ path: file });
    files.push(file);
  }
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(1125, 480).png().toBuffer()));
  await sharp({ create: { width: 1125, height: 480 * tiles.length, channels: 3, background: "#000" } })
    .composite(tiles.map((input, i) => ({ input, left: 0, top: i * 480 }))).png()
    .toFile(`shots/${prefix}factions.png`);
  console.log(`wrote shots/${prefix}factions.png`);
} finally { await close(); }
