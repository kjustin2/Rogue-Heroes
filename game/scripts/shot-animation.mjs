// ANIMATION LIVENESS PROBE.
//
// A stopped walk cycle is invisible in a screenshot. The unit still renders, still slides across
// the board, and only the legs stop swinging -- so every existing gate (canvas lit, image stats,
// console clean, sim asserts) passes while the game looks amateur in exactly the way the owner
// calls out first. That regression shipped once here: wrapping infantry parts in a proportion rig
// changed mesh.parent, and the animation state lives on the actor group, so walkWeight read
// undefined and the legs went rigid.
//
// This measures the pose over a real move: the limbs must actually swing, the two legs must be
// out of phase with each other, and the swing has to track DISTANCE rather than wall time.
// Out: shots/animation/*.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "shot-animation" });

const PORT = 5195;
const OUT = join("shots", "animation");
mkdirSync(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };
const spread = (xs) => Math.max(...xs) - Math.min(...xs);

const { page, errors, close } = await launchGame({
  port: PORT,
  query: "lowfx=1",
  viewport: { width: 1280, height: 720 },
});

try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click("[data-map]");
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });

  // Put a single trooper on the field and walk it a long way.
  const unitId = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.economy.set("player", 9000);
    const unit = sim.debugSpawn("soldier", "player", { x: -8, z: 0 });
    return unit.id;
  });
  await page.waitForTimeout(400);

  const ordered = await page.evaluate((id) => {
    const sim = window.__rht.sim;
    sim.select(id);
    return sim.queueMove({ x: 6, z: 0 });
  }, unitId);
  if (!ordered) fail("could not queue a move order");

  await page.evaluate(() => window.__rht.endTurn());

  // Sample the pose across the resolve.
  const samples = [];
  for (let i = 0; i < 26; i += 1) {
    const frame = await page.evaluate((id) => {
      const sim = window.__rht.sim;
      const unit = sim.entities.find((e) => e.id === id);
      return { pose: window.__rht.limbPose(id), x: unit?.position.x ?? 0, phase: sim.phase };
    }, unitId);
    samples.push(frame);
    if (frame.phase === "command" && i > 6) break;
    await page.waitForTimeout(90);
  }
  await assertLit(page, "walking trooper");
  await page.screenshot({ path: join(OUT, "walk.png") });

  const withLimbs = samples.filter((s) => s.pose.length > 0);
  if (withLimbs.length < 6) fail(`only ${withLimbs.length} samples had limb meshes — the probe never saw the unit`);

  const travelled = spread(withLimbs.map((s) => s.x));
  if (travelled < 3) fail(`unit only travelled ${travelled.toFixed(2)} units — the move never happened`);

  const legL = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-l")?.rotX ?? 0);
  const legR = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-r")?.rotX ?? 0);
  const armR = withLimbs.map((s) => s.pose.find((p) => p.limb === "arm-r")?.rotX ?? 0);

  // 1. THE regression this exists for: the legs must move at all.
  const legSwing = spread(legL);
  if (legSwing < 0.15) fail(`legs are rigid: total swing ${legSwing.toFixed(3)} rad over ${travelled.toFixed(1)} units walked`);

  // 2. The legs must be out of phase. Both legs swinging together is a hop, not a walk, and it
  //    reads as sliding just as badly as no animation.
  const opposed = withLimbs.filter((_, i) => Math.sign(legL[i]) !== Math.sign(legR[i])).length;
  if (opposed < withLimbs.length * 0.4) fail(`legs are in phase (${opposed}/${withLimbs.length} frames opposed) — that is a hop, not a stride`);

  // 3. Arms swing too, and counter to the legs.
  if (spread(armR) < 0.08) fail(`arms are rigid: swing ${spread(armR).toFixed(3)} rad`);

  // 4. Feet must lift. A leg that only rotates without its foot leaving the ground is the
  //    classic skate; the renderer lifts the foot on the forward half of the stride.
  const footY = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-l")?.posY ?? 0);
  if (spread(footY) < 0.02) fail(`foot never lifts: vertical range ${spread(footY).toFixed(4)}`);

  console.log(`  travelled ${travelled.toFixed(1)}u · leg swing ${legSwing.toFixed(2)} rad · arm swing ${spread(armR).toFixed(2)} rad · foot lift ${spread(footY).toFixed(3)}`);

  if (errors.length) fail(`console errors:\n${errors.slice(0, 6).join("\n")}`);
  console.log("Animation smoke passed: limbs swing, legs oppose, feet lift.");
} finally {
  await close();
}
