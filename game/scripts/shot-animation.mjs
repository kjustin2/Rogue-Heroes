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
// out of phase with each other, and the swing has to track DISTANCE rather than wall time. It then
// does the same for a shot: the weapon has to move while firing, or the unit twitches instead of
// shooting and looks identical in every still.
// Out: shots/animation/*.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, deployBattle, launchGame } from "../improve/lib/harness.mjs";
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
  // Deploy through the seam, not the menu: the menu defers startBattle() behind a loading veil,
  // and the sim reads phase "command" the whole time, so a spawn can land before configure() and
  // get spliced away. Pinning the map also pins where the scenario puts everything the walk below
  // has to path around.
  await deployBattle(page, { map: "dustbowl", mode: "destroy" });

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
    // Report WHO ended up selected: a rejected order is almost always a selection that never
    // landed on the spawned trooper, and "could not queue a move" alone doesn't say that.
    return { ok: sim.queueMove({ x: 6, z: 0 }), selected: sim.selectedId, phase: sim.phase, log: sim.log.slice(-2) };
  }, unitId);
  if (!ordered.ok) fail(`could not queue a move order for ${unitId}: ${JSON.stringify(ordered)}`);

  // Record every rendered frame's boot positions (the skate gate below), and slow the resolve so
  // a headless frame is a slice of a stride rather than a third of one.
  await page.evaluate((id) => { window.__rht.trackFeet(id, true); window.__rht.setResolveScale(0.15); window.__rht.endTurn(); }, unitId);

  // Sample the pose across the resolve.
  const samples = [];
  for (let i = 0; i < 60; i += 1) {
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
  const track = await page.evaluate((id) => { const t = window.__rht.footTrack(id); window.__rht.trackFeet(id, false); window.__rht.setResolveScale(1); return t; }, unitId);
  // The walk ran on a slowed clock, so the resolve may still be in flight; the shot section below
  // needs a command phase to queue into.
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 });

  const withLimbs = samples.filter((s) => s.pose.length > 0);
  if (withLimbs.length < 6) fail(`only ${withLimbs.length} samples had limb meshes — the probe never saw the unit`);

  const travelled = spread(withLimbs.map((s) => s.x));
  if (travelled < 3) fail(`unit only travelled ${travelled.toFixed(2)} units — the move never happened`);

  const legL = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-l")?.rotX ?? 0);
  const legR = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-r")?.rotX ?? 0);
  const shinL = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-l:shin")?.rotX ?? 0);
  const armL = withLimbs.map((s) => s.pose.find((p) => p.limb === "arm-l")?.rotX ?? 0);
  const armR = withLimbs.map((s) => s.pose.find((p) => p.limb === "arm-r")?.rotX ?? 0);
  const head = withLimbs.map((s) => s.pose.find((p) => p.limb === "head")?.posY ?? 0);

  // 1. THE regression this exists for: the legs must move at all.
  const legSwing = spread(legL);
  if (legSwing < 0.15) fail(`legs are rigid: total swing ${legSwing.toFixed(3)} rad over ${travelled.toFixed(1)} units walked`);

  // 2. The legs must be out of phase. Both legs swinging together is a hop, not a walk, and it
  //    reads as sliding just as badly as no animation. In a run both thighs sit forward of the
  //    hip for much of the cycle (the swing thigh comes through early), so the test is that the
  //    LEAD changes hands: left-minus-right swings well past zero in both directions.
  const lead = withLimbs.map((_, i) => legL[i] - legR[i]);
  if (Math.min(...lead) > -0.3 || Math.max(...lead) < 0.3) fail(`legs are in phase (lead ${Math.min(...lead).toFixed(2)}..${Math.max(...lead).toFixed(2)} rad) — that is a hop, not a stride`);

  // 3. The FREE arm counter-swings; the weapon arm keeps its carry (a small swing, never rigid).
  if (spread(armL) < 0.25) fail(`free arm is rigid: swing ${spread(armL).toFixed(3)} rad`);
  if (spread(armR) < 0.03) fail(`weapon arm is rigid: swing ${spread(armR).toFixed(3)} rad`);

  // 4. THE KNEE. A one-piece leg pendulums from the hip; the shin must rotate relative to the
  //    thigh, or the leg is a stick with a boot on it.
  const kneeBend = Math.max(...withLimbs.map((_, i) => Math.abs(legL[i] - shinL[i])));
  if (kneeBend < 0.5) fail(`no knee break: thigh-shin angle never exceeds ${kneeBend.toFixed(3)} rad`);

  // 5. Feet must lift. A leg that only rotates without its foot leaving the ground is the
  //    classic skate; the swing foot arcs clear of the ground.
  const footY = withLimbs.map((s) => s.pose.find((p) => p.limb === "leg-l:foot")?.posY ?? 0);
  if (spread(footY) < 0.06) fail(`foot never lifts: vertical range ${spread(footY).toFixed(4)}`);

  // 6. The head stays level: its rig-space height moves AGAINST the pelvis bob (half of it), so
  //    from the tactical camera the helmet rides smoother than the torso. The group's own y is
  //    no use here (it carries terrain elevation), so this reads the counter directly: a few cm,
  //    never zero (no counter) and never the whole bob (bobblehead).
  if (spread(head) < 0.01 || spread(head) > 0.08) fail(`head bob counter out of range: ${spread(head).toFixed(3)} m over the walk (expect ~0.01-0.06)`);

  console.log(`  travelled ${travelled.toFixed(1)}u · leg swing ${legSwing.toFixed(2)} rad · knee ${kneeBend.toFixed(2)} rad · free arm ${spread(armL).toFixed(2)} rad · foot lift ${spread(footY).toFixed(3)}`);

  // 7. THE STRIDE LOCK. Per rendered frame: the boot that is lowest is the planted one; between
  //    two consecutive frames where the same boot stays planted, its world position must not
  //    move (the body moved -- that is what makes it a stride and not a slide). Reported as
  //    centimetres per frame and as slide per metre of body travel, gated on both.
  // Planted = a boot within 3cm of its own sole height above the rendered GROUND in both frames of
  // the pair. The per-frame ground comes from the renderer (the unit's own elevation), because the
  // lowest-of-two-boots heuristic calls both boots planted during a run's flight phase.
  const SOLE = 0.07; // boot centre above the ground when the sole is down
  const BAND = 0.03;
  const planted = [];
  for (let i = 1; i < track.length; i += 1) {
    const a = track[i - 1];
    const b = track[i];
    const moved = Math.hypot(b.x - a.x, b.z - a.z);
    if (moved < 0.002 || a.feet.length < 2 || b.feet.length < 2) continue;
    for (const fa of a.feet) {
      const fb = b.feet.find((f) => f.side === fa.side);
      if (!fb) continue;
      if (fa.y > a.ground + SOLE + BAND || fb.y > b.ground + SOLE + BAND) continue; // in flight in one of the two frames
      planted.push({ slide: Math.hypot(fb.x - fa.x, fb.z - fa.z), moved });
    }
  }
  if (planted.length < 8) fail(`stride lock: only ${planted.length} planted frame pairs recorded (track ${track.length} frames)`);
  const slides = planted.map((s) => s.slide).sort((p, q) => p - q);
  const p90 = slides[Math.floor(slides.length * 0.9)];
  const bodyTravel = planted.reduce((s, f) => s + f.moved, 0);
  const perMetre = planted.reduce((s, f) => s + f.slide, 0) / bodyTravel;
  console.log(`  stride lock: ${planted.length} planted frames · p90 skate ${(p90 * 100).toFixed(2)} cm/frame · ${perMetre.toFixed(3)} m slide per m travelled (body ${((bodyTravel / planted.length) * 100).toFixed(1)} cm/frame)`);
  // Thresholds are fault-injection measured, not guessed: with the stride lock the p90 is 0.07 cm
  // and the ratio 0.02; driving the phase off wall time instead (the classic bug) gives 2.0 cm and
  // 1.33 -- so 1 cm and 0.15 sit between the two states with an order of magnitude of margin each.
  if (p90 > 0.01) fail(`FOOT SKATE: planted boot moves ${(p90 * 100).toFixed(2)} cm/frame (p90) — the stride is not locked to distance`);
  if (perMetre > 0.15) fail(`FOOT SKATE: ${perMetre.toFixed(3)} m of slide per metre travelled (clean walk ~0.05, broken ~1)`);

  // ---- Attack choreography, same idea: a weapon that never moves while firing is a unit that
  // twitches rather than shoots, and it looks identical in every screenshot.
  const shooterId = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const shooter = sim.entities.find((e) => e.team === "player" && e.kind === "soldier");
    const foe = sim.debugSpawn("soldier", "enemy", { x: (shooter?.position.x ?? 0) + 8, z: shooter?.position.z ?? 0 });
    sim.select(shooter.id);
    sim.queueShoot(foe.id);
    return shooter.id;
  });

  // The weapon at rest, before the turn resolves. Everything below is measured against this.
  const rest = await page.evaluate((id) => window.__rht.limbPose(id).filter((p) => p.limb === "weapon")[0], shooterId);
  if (!rest) fail("no weapon mesh on the shooter");

  await page.evaluate(() => window.__rht.endTurn());

  const weapon = [];
  for (let i = 0; i < 40; i += 1) {
    const frame = await page.evaluate((id) => {
      const sim = window.__rht.sim;
      const order = sim.orders.find((o) => o.actorId === id && o.kind === "shoot");
      return {
        phase: sim.phase,
        // `fired` flips the instant the round leaves the barrel, which is what separates
        // anticipation from recoil.
        fired: order ? Boolean(order.fired) : true,
        pose: window.__rht.limbPose(id).filter((p) => p.limb === "weapon"),
      };
    }, shooterId);
    if (frame.pose.length) weapon.push({ fired: frame.fired, ...frame.pose[0] });
    if (frame.phase !== "resolve" && i > 6) break;
    await page.waitForTimeout(60);
  }
  await page.screenshot({ path: join(OUT, "fire.png") });

  if (weapon.length < 6) fail(`only ${weapon.length} samples saw a weapon mesh`);

  // THE discriminator. Recoil already moved the weapon before this feature existed, so "the weapon
  // moved" passes with the choreography torn out -- an earlier version of this check did exactly
  // that. What only ANTICIPATION can produce is movement BEFORE the round leaves the barrel.
  const preFire = weapon.filter((w) => !w.fired);
  if (preFire.length < 2) fail(`only ${preFire.length} samples landed before the shot fired — cannot judge anticipation`);
  const windUp = Math.max(...preFire.map((w) => Math.abs(w.rotX - rest.rotX) + Math.abs(w.posZ - rest.posZ)));
  // 0.07 sits deliberately between the two measured states: idle sway alone moves the weapon about
  // 0.03 from rest, real anticipation about 0.17. A threshold below that band passes with the
  // choreography torn out, which is exactly what the first version of this check did.
  if (windUp < 0.07) {
    fail(`no anticipation: weapon deviated ${windUp.toFixed(4)} from rest before firing — it twitches on contact instead of winding up`);
  }

  const swing = spread(weapon.map((w) => w.rotX));
  console.log(`  weapon wind-up ${windUp.toFixed(3)} before the shot · total pitch ${swing.toFixed(3)} rad`);

  // IDLE LIVENESS. A trooper standing through the command phase — where the player spends nearly
  // all their time — must visibly move: the head scans and the body shifts weight and turns. The
  // per-part breathing is too small to see from the tactical camera, so this measures the two
  // cues that are: head yaw and whole-body yaw. Thresholds sit well under the authored amplitudes
  // (head 0.42 rad, body 0.11) and well over rest (0). The head sweep is slow on purpose (a ~10s
  // cycle reads as looking around rather than as a metronome), so the window has to cover half of
  // THAT or the measured spread depends on where in the sweep the probe happened to land -- at 3s
  // it can legitimately read 0.13 of a 0.42-rad scan and fail. 6s covers at least half the cycle.
  const idleId = await page.evaluate(() => window.__rht.sim.debugSpawn("soldier", "player", { x: 0, z: 4 }).id);
  await page.waitForTimeout(300);
  const idle = { head: [], body: [] };
  for (let i = 0; i < 30; i += 1) {
    const pose = await page.evaluate((id) => window.__rht.limbPose(id), idleId);
    for (const key of ["head", "body"]) { const p = pose.find((e) => e.limb === key); if (p) idle[key].push(p.rotY); }
    await page.waitForTimeout(200);
  }
  if (idle.head.length < 10) fail("idle probe: head part not found on a standing soldier");
  const headScan = spread(idle.head);
  const bodyTurn = spread(idle.body);
  console.log(`  idle: head scan ${headScan.toFixed(3)} rad · body turn ${bodyTurn.toFixed(3)} rad over 3s`);
  if (headScan < 0.15) fail(`idle head scan ${headScan.toFixed(3)} rad — standing troopers are frozen`);
  if (bodyTurn < 0.04) fail(`idle body turn ${bodyTurn.toFixed(3)} rad — no weight shift on a standing trooper`);

  if (errors.length) fail(`console errors:\n${errors.slice(0, 6).join("\n")}`);
  console.log("Animation smoke passed: limbs swing, legs oppose, feet lift, weapons wind up and follow through, idles live.");
} finally {
  await close();
}
