// RESOLVE-CAMERA PROBE.
//
// This is an INTEGRATION check, and its limits are worth stating plainly.
//
// The director's priority scoring, hold, player-yield and hitstop timing are covered by unit tests
// in resolveDirector.test.ts, where they can be driven directly. What this adds is proof that the
// wiring is live end to end: real sim events reach the director, the camera reaches the action, and
// -- the regression this exists for -- HITSTOP DOES NOT STALL THE TURN. Freezing the sim by
// skipping its update is safe only while the freeze reliably counts back down; if it ever failed to,
// the resolve phase would hang forever and no other gate would notice.
//
// It deliberately does NOT claim to distinguish the director from the projectile-centroid fallback
// it supersedes. Two attempts to build that discriminator both passed with the director torn out,
// because the fallback happens to converge on the same place in any scenario simple enough to stage
// headlessly. Rather than keep a test whose failure message would be a lie, the discrimination is
// left to the unit tests and this asserts only what it actually measures.
// Out: shots/director/*.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLit, launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "shot-director" });

const PORT = 5201;
const OUT = join("shots", "director");
mkdirSync(OUT, { recursive: true });

const fail = (msg) => { throw new Error(msg); };

// The two fights, mirrored about the centre so neither is nearer to the starting camera.
const KILL = { x: 19, z: 10 };
const NOISE = { x: -19, z: -10 };
const away = (cam, p) => Math.hypot(cam.x - p.x, cam.z - p.z);

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

  const ok = await page.evaluate(({ KILL, NOISE }) => {
    const sim = window.__rht.sim;
    sim.entities.splice(0, sim.entities.length);

    // Fight A: a killing blow. One shot into a target left on a single hit point.
    const killer = sim.debugSpawn("heavy", "player", { x: KILL.x - 2, z: KILL.z });
    const victim = sim.debugSpawn("soldier", "enemy", KILL);
    for (const part of victim.parts) part.hp = 1;

    // Fight B: sustained gunfire that kills nobody. A tank soaks it, so this fight produces plenty
    // of shots and impacts but never the one event that should win the camera.
    const noisy = sim.debugSpawn("heavy", "player", { x: NOISE.x - 2, z: NOISE.z });
    const tank = sim.debugSpawn("tank", "enemy", NOISE);

    sim.select(killer.id);
    const a = sim.queueShoot(victim.id);
    sim.select(noisy.id);
    const b = sim.queueShoot(tank.id);

    // Nothing selected and the camera dead centre: neither fight is favoured by position, and the
    // separate assist that keeps a SELECTED unit on screen cannot be what moves the camera.
    window.__rht.deselect();
    window.__rht.setView({ x: 0, z: 0 });
    return a && b;
  }, { KILL, NOISE });
  if (!ok) fail("could not queue both fights");

  await page.screenshot({ path: join(OUT, "0-before.png") });
  await page.evaluate(() => window.__rht.endTurn());

  let bestKill = Infinity;
  let bestNoise = Infinity;
  let sawResolve = false;
  // Long enough to outlast a slow exchange (a heavy grinding a tank) plus the sim's own 20s
  // resolve ceiling, so a timeout here means a genuine stall rather than an impatient probe.
  for (let i = 0; i < 230; i += 1) {
    const frame = await page.evaluate(() => ({ phase: window.__rht.sim.phase, cam: window.__rht.camera() }));
    if (frame.phase === "resolve") sawResolve = true;
    if (frame.cam && frame.phase === "resolve") {
      bestKill = Math.min(bestKill, away(frame.cam, KILL));
      bestNoise = Math.min(bestNoise, away(frame.cam, NOISE));
    }
    if (frame.phase !== "resolve" && sawResolve && i > 4) break;
    await page.waitForTimeout(110);
  }
  await assertLit(page, "directed resolve");
  await page.screenshot({ path: join(OUT, "1-after.png") });

  if (!sawResolve) fail("the turn never entered the resolve phase");

  // The camera has to actually reach the action rather than sit where the player left it.
  if (bestKill > 14) fail(`camera never reached the action: closest ${bestKill.toFixed(1)} units`);
  // And the turn has to END. This is the hitstop regression guard: a freeze that stops counting
  // down leaves the sim permanently un-stepped, which looks like the game simply locking up.
  const settled = await page.evaluate(() => window.__rht.sim.phase);
  if (settled === "resolve") fail("resolve never finished — hitstop is stalling the sim");

  console.log(`  camera reached ${bestKill.toFixed(1)} from the action (other fight ${bestNoise.toFixed(1)}); turn settled to ${settled}`);
  if (errors.length) fail(`console errors:\n${errors.slice(0, 6).join("\n")}`);
  console.log("Director smoke passed: camera reaches the action and hitstop never stalls the turn.");
} finally {
  await close();
}
