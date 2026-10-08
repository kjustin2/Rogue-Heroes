// THE MIX, MEASURED (owner 2026-10-07: "proper sound design and balancing"). Every voice the game plays (guns, ability
// verbs, deaths, explosions, moments, UI) is rendered OFFLINE in a hidden, muted browser (Sfx.measure: an
// OfflineAudioContext, never the speakers) and gated on its peak and its loudness (the loudest 400ms window's RMS) in dBFS:
//   - nothing clips (peak <= +0.5 dBFS at master gain 1; the live master sits at 0.6, ~4.4 dB of headroom),
//   - nothing is silent (peak > -40 dBFS: a dropped part or a missing sample shows up here),
//   - the UI sits at least 5 dB under the combat median, a map event (Sfx.hazard) within 9 dB of it, and an ability verb
//     within 9 dB of the gun median (the target is
//     6 / 8: a run's random sample + pitch picks move a median ~2 dB, so the gates carry a dB of slack).
// Run: npm run probe:mix   (prints the table; exits non-zero on a broken gate)
import { launchGame } from "../improve/lib/harness.mjs";
import { guard } from "./lib/guard.cjs";

guard({ name: "probe-mix" });

const { page, errors, close } = await launchGame({ port: Number(process.env.SMOKE_PORT ?? 5193), viewport: { width: 1200, height: 800 }, query: "lowfx=1" });
let failed = 0;
try {
  await page.waitForSelector(".main-menu");
  await page.mouse.click(600, 400); // a gesture: the AudioContext and the sample decode start on the first one
  const rows = await page.evaluate(() => window.__rht.measureMix());
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const combat = median(rows.filter((r) => ["gun", "boom", "death"].includes(r.group)).map((r) => r.rms));
  const guns = median(rows.filter((r) => r.group === "gun").map((r) => r.rms));
  console.log(`combat median ${combat.toFixed(1)} dB RMS, gun median ${guns.toFixed(1)} dB RMS`);
  for (const r of rows) {
    const why = [];
    if (r.peak > 0.5) why.push("clips");
    if (r.peak < -40) why.push("silent");
    if (r.group === "ui" && r.rms > combat - 5) why.push(`UI not 5 dB under combat (${(r.rms - combat).toFixed(1)})`);
    if (r.group === "verb" && Math.abs(r.rms - guns) > 9) why.push(`verb ${(r.rms - guns).toFixed(1)} dB off the guns`);
    if (r.group === "event" && Math.abs(r.rms - combat) > 9) why.push(`map event ${(r.rms - combat).toFixed(1)} dB off the combat median`);
    if (why.length) failed += 1;
    console.log(`${r.group.padEnd(7)} ${r.name.padEnd(12)} peak ${r.peak.toFixed(1).padStart(6)}  rms ${r.rms.toFixed(1).padStart(6)}  ${why.join("; ") || "ok"}`);
  }
  if (errors.length) { console.error(errors.join("\n")); failed += 1; }
} finally {
  await close();
}
if (failed) { console.error(`probe:mix: ${failed} voice(s) out of bounds`); process.exit(1); }
console.log("probe:mix: every voice in bounds");
