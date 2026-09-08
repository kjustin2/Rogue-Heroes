// Which objects cast the striped shadow? Turn casting off one class at a time. Diagnostic.
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5196, viewport: { width: 1400, height: 800 } });
const VIEW = { x: 6, z: 2, zoom: 0.72, pitch: 0.6, yaw: 0.2 };
try {
  await page.evaluate(() => { window.__rht.scenario("siege"); window.__rht.deselect(); });
  await delay(1400);
  await page.evaluate((v) => window.__rht.setView(v), VIEW);
  await delay(600);
  await page.screenshot({ path: "shots/probe-s0-all.png" });

  const groups = await page.evaluate(() => {
    const root = window.__rht.sceneRoot();
    const out = [];
    for (const child of root.children) {
      let casters = 0;
      child.traverse((o) => { if (o.isMesh && o.castShadow) casters += 1; });
      if (casters) out.push({ name: child.name || child.type, uuid: child.uuid, casters });
    }
    return out;
  });
  console.log("caster groups:", JSON.stringify(groups));

  for (const g of groups) {
    await page.evaluate((uuid) => {
      const root = window.__rht.sceneRoot();
      root.traverse((o) => { if (o.uuid === uuid) o.traverse((m) => { if (m.isMesh) m.castShadow = false; }); });
    }, g.uuid);
    await delay(500);
    await page.screenshot({ path: `shots/probe-s-off-${g.name}-${g.casters}.png` });
    console.log("  off:", g.name, g.casters);
  }
} finally { await close(); }
