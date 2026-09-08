// Which objects cast the striped shadow? Turn casting off one class at a time. Diagnostic.
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5196, viewport: { width: 1400, height: 800 } });
const SCENARIO = process.argv[2] ?? "siege";
const VIEW = { x: 6, z: 2, zoom: 0.9, pitch: 0.62, yaw: 0.2 };
try {
  await page.evaluate((s) => { window.__rht.scenario(s); window.__rht.deselect(); }, SCENARIO);
  await delay(1400);
  await page.evaluate((v) => window.__rht.setView(v), VIEW);
  await delay(600);
  await page.screenshot({ path: "shots/probe-s0-all.png" });

  // Two levels: the scene's own children, and — because a "Group" at the top is usually a whole
  // subsystem — the children of any group that has casters. One level was enough to say "the
  // scenery", not enough to say "the terrain caps".
  const groups = await page.evaluate(() => {
    const root = window.__rht.sceneRoot();
    const out = [];
    const count = (o) => { let n = 0; o.traverse((m) => { if (m.isMesh && m.castShadow) n += 1; }); return n; };
    for (const child of root.children) {
      const n = count(child);
      if (!n) continue;
      out.push({ name: `${child.name || child.type}`, uuid: child.uuid, casters: n });
      for (const [i, grand] of child.children.entries()) {
        const g = count(grand);
        if (g) out.push({ name: `${child.name || child.type}/${i}:${grand.name || grand.type}`, uuid: grand.uuid, casters: g });
      }
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
