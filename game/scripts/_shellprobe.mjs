import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5209, query: "lowfx=1" });
try {
  await page.waitForSelector(".main-menu");
  const out = await page.evaluate(async () => {
    window.__rht.startBattle("dustbowl", "destroy", "normal");
    const sim = window.__rht.sim;
    const a = sim.debugSpawn("tank", "player", { x: -4, z: 3.4 });
    const t = sim.debugSpawn("heavy", "enemy", { x: 6, z: 3.4 });
    for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
    t.status.canShoot = false; t.status.canMove = false;
    sim.select(a.id); sim.setIntent("shoot"); const q = sim.queueShoot(t.id);
    window.__rht.endTurn();
    const log = [];
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 50));
      for (const p of sim.projectiles) log.push(`${i} ${p.kind} age=${p.age.toFixed(2)} x=${p.position.x.toFixed(2)} h=${p.height.toFixed(2)} state=${p.state ?? ""}`);
    }
    return { q, log: log.slice(0, 40) };
  });
  console.log(JSON.stringify(out.q)); console.log(out.log.join("\n"));
} finally { await close(); }
