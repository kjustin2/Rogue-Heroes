// TERRAIN-CLIP PROBE: does any unit's model sit inside the drawn terrain? Runs the renderer's
// auditTerrainClip on the title diorama, then on every map after each of five AI-vs-AI turns (both
// seats played by the bot, so units walk everywhere they normally would). Exits 1 on any offender.
// Run: npm run probe:terrain  (add a map id to run just that map)
import { launchGame, waitForCommand } from "../improve/lib/harness.mjs";

const only = process.argv[2];
const { page, close } = await launchGame({ port: 5210, query: "lowfx=1" });
const found = [];
const audit = async (where) => {
  const hits = await page.evaluate(() => window.__rht.auditTerrainClip());
  for (const h of hits) found.push({ where, ...h });
  return hits.length;
};
try {
  await page.waitForSelector(".main-menu");
  await page.waitForTimeout(800);
  if (!only) console.log(`title: ${await audit("title")} offender(s)`);
  const maps = only ? [only] : ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"];
  for (const map of maps) {
    await page.evaluate((m) => { window.__rht.startBattle(m, "destroy", "normal"); const s = window.__rht.sim; s.economy.set("player", 3000); s.economy.set("enemy", 3000); }, map);
    let n = 0;
    for (let turn = 0; turn < 5; turn += 1) {
      await page.evaluate(() => { const s = window.__rht.sim; for (const b of s.entities) if (b.kind === "base") b.unlockedTech = ["assault", "armor", "recon", "ordnance", "support"]; s.debugCommandAsAi(); window.__rht.setResolveScale(4); window.__rht.sim.endTurn(); });
      await waitForCommand(page, 60000).catch(() => {});
      await page.waitForTimeout(400); // let the renderer ease units onto their final ground
      n += await audit(`${map} t${turn + 1}`);
    }
    console.log(`${map}: ${n} offender sample(s)`);
  }
  const worst = new Map();
  for (const f of found) { const k = `${f.where.split(" ")[0]}:${f.kind}:${f.part}`; if (!worst.has(k) || worst.get(k).depth < f.depth) worst.set(k, f); }
  for (const f of [...worst.values()].sort((a, b) => b.depth - a.depth).slice(0, 25)) console.log(`  ${f.where.padEnd(14)} ${f.kind.padEnd(10)} ${f.part.padEnd(12)} ${f.depth.toFixed(2)}m inside at (${f.x.toFixed(1)}, ${f.z.toFixed(1)}) ${f.name}`);
  if (found.length) process.exitCode = 1;
  else console.log("OK probe:terrain -- no unit inside the terrain");
} finally {
  await close();
}
