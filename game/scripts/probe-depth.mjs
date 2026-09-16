// DEPTH-FIGHT PROBE. One frame of a scenario, then the same frame with (a) the plate layer hidden,
// (b) shadows off, (c) the plate layer lifted 0.6 above everything, (d) the camera near plane at the
// old 0.1. Dashed hatching that survives (b) is not a shadow; if it survives (c) it is plates fighting
// EACH OTHER; if it appears in (d) it is the near plane. Diagnostic — read shots/depth-*.png.
// Run: npm run probe:depth [scenario]
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5197, viewport: { width: 1400, height: 800 } });
const SCENARIO = process.argv[2] ?? "high-ground";
const VIEW = { x: 0, z: 0, zoom: 0.9, pitch: 0.62, yaw: 0.2 };
const ev = (fn, arg) => page.evaluate(fn, arg);
const shot = (n) => page.screenshot({ path: `shots/depth-${n}.png` });
const plates = (fn) => ev((src) => { const f = eval(src); window.__rht.sceneRoot().traverse((o) => { if (o.name === "plates") f(o); }); }, fn.toString());
const shadow = (on) => ev((on) => { window.__rht.sceneRoot().traverse((o) => { if (o.isDirectionalLight && o.intensity > 1) o.castShadow = on; }); }, on);
try {
  await ev((s) => { window.__rht.scenario(s); window.__rht.deselect(); }, SCENARIO);
  await delay(1400);
  await ev((v) => window.__rht.setView(v), VIEW);
  await delay(1500);
  await shot("0-base");
  await plates((o) => { o.visible = false; }); await delay(300); await shot("1-noplates"); await plates((o) => { o.visible = true; });
  await shadow(false); await delay(600); await shot("2-noshadow"); await shadow(true); await delay(600);
  await plates((o) => { o.position.y = 0.6; }); await delay(300); await shot("3-plates-lifted"); await plates((o) => { o.position.y = 0; });
  await ev(() => { const c = window.__rht.cameraObject(); c.near = 0.1; c.updateProjectionMatrix(); });
  await delay(300); await shot("4-near0.1");
  console.log("wrote shots/depth-{0-base,1-noplates,2-noshadow,3-plates-lifted,4-near0.1}.png");
} finally { await close(); }
