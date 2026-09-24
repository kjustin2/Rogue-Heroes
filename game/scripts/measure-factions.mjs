// ============================================================================
//  FACTION DISTINCTNESS — measured, not eyeballed (owner 2026-09-24: "infantry all look the same
//  across factions and bases don't look different enough").
// ----------------------------------------------------------------------------
//  Stages each SUBJECT (the Home Base and the four shared line kinds) alone on an empty field, once
//  per faction, framed identically, and captures it twice: as a black silhouette (shape) and in
//  colour (hue). Then, per subject, across every pair of factions:
//    - silhouette IoU = |A∩B| / |A∪B| of the two outlines. 1.0 = the same shape.
//    - hue distance   = circular distance between the saturation-weighted mean hues, in degrees.
//  THE GOAL (docs/next-steps.md): infantry IoU ≤ 0.80, base IoU ≤ 0.70, hue distance ≥ 40° —
//  for EVERY pair. MEASURE_GATE=1 exits non-zero when it is not met.
//
//  Run: npm run measure:factions  (captures on the real GPU, then measures) -> shots/factions-measure/
// ============================================================================
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join("shots", "factions-measure");
mkdirSync(OUT, { recursive: true });
const FACTIONS = ["vanguard", "syndicate", "bastion"];
const SUBJECTS = [
  { id: "base", kind: "base", zoom: 0.6, pitch: 0.34 },
  { id: "rifleman", kind: "soldier", zoom: 0.26, pitch: 0.22 },
  { id: "heavy", kind: "heavy", zoom: 0.26, pitch: 0.22 },
  { id: "marksman", kind: "sniper", zoom: 0.26, pitch: 0.22 },
  { id: "medic", kind: "medic", zoom: 0.26, pitch: 0.22 },
  // Shared machines: only the factions that actually field one are compared.
  { id: "tank", kind: "tank", only: ["vanguard", "bastion"] },
  { id: "flak", kind: "flak" },
  { id: "turret", kind: "turret" },
];
const ROSTERS = {
  vanguard: ["soldier", "scout", "sniper", "jumper", "heavy", "medic", "tank", "flak", "gunship", "interceptor", "transport"],
  syndicate: ["soldier", "sniper", "heavy", "striker", "grenadier", "flamer", "sapper", "droneop", "medic", "apc", "flak"],
  bastion: ["soldier", "sniper", "heavy", "mortar", "medic", "engineer", "tank", "artillery", "flak", "bomber"],
};
const GOAL = { infantryIoU: 0.8, baseIoU: 0.7, hueDeg: 40, memberMargin: 15 };

// Capture happens on the REAL GPU (shots-gpu.cjs factionmeasure): under SwiftShader the ground
// drops out at low pitch and the sky shows through the units, which poisons both measures.
// Mask (dark pixels of the silhouette shot) + saturation-weighted circular mean hue of those pixels.
async function readSubject(colFile, silFile) {
  const meta = await sharp(silFile).metadata();
  const w = meta.width, h = meta.height;
  const sil = await sharp(silFile).greyscale().raw().toBuffer();
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i += 1) mask[i] = sil[i] < 90 ? 1 : 0;
  const col = await sharp(colFile).removeAlpha().resize(w, h).raw().toBuffer();
  let sx = 0, sy = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const r = col[i * 3] / 255, g = col[i * 3 + 1] / 255, b = col[i * 3 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.04) continue;
    let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60;
    const sat = mx === 0 ? 0 : d / mx;
    sx += Math.cos((hh * Math.PI) / 180) * sat;
    sy += Math.sin((hh * Math.PI) / 180) * sat;
  }
  return { mask, hue: ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360 };
}
const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const masks = {}; // subject -> faction -> Uint8Array (1 = subject pixel)
const hues = {};  // subject -> faction -> degrees
try {
  for (const faction of FACTIONS) {
    for (const s of SUBJECTS) {
      if (s.only && !s.only.includes(faction)) continue;
      const got = await readSubject(join(OUT, `${s.id}-${faction}.png`), join(OUT, `${s.id}-${faction}-sil.png`));
      (masks[s.id] ??= {})[faction] = got.mask;
      (hues[s.id] ??= {})[faction] = got.hue;
    }
  }
  let failed = 0;
  console.log("subject      pair                    IoU    hueΔ");
  for (const s of SUBJECTS) {
    for (let a = 0; a < FACTIONS.length; a += 1) {
      for (let b = a + 1; b < FACTIONS.length; b += 1) {
        const A = masks[s.id][FACTIONS[a]], B = masks[s.id][FACTIONS[b]];
        if (!A || !B) continue; // a machine only some factions field
        let inter = 0, uni = 0;
        for (let i = 0; i < A.length; i += 1) { if (A[i] && B[i]) inter += 1; if (A[i] || B[i]) uni += 1; }
        const iou = uni ? inter / uni : 1;
        const dh = Math.abs(((hues[s.id][FACTIONS[a]] - hues[s.id][FACTIONS[b]] + 540) % 360) - 180);
        const iouGoal = s.kind === "base" || s.kind === "turret" ? GOAL.baseIoU : GOAL.infantryIoU;
        const ok = iou <= iouGoal && dh >= GOAL.hueDeg;
        if (!ok) failed += 1;
        console.log(`${s.id.padEnd(12)} ${`${FACTIONS[a]}~${FACTIONS[b]}`.padEnd(22)} ${iou.toFixed(2)}   ${dh.toFixed(0).padStart(3)}°  ${ok ? "ok" : `MISS (need IoU ≤ ${iouGoal}, hue ≥ ${GOAL.hueDeg}°)`}`);
      }
    }
  }
  // MEMBERSHIP: every unit a faction fields must be nearest in hue to its OWN faction's signature
  // (the mean of its HQ and rifleman), by a margin -- a signature unit reads as its faction too.
  const signature = {};
  for (const f of FACTIONS) {
    const hs = [hues.base[f], hues.rifleman[f]];
    const x = hs.reduce((n, h) => n + Math.cos((h * Math.PI) / 180), 0), y = hs.reduce((n, h) => n + Math.sin((h * Math.PI) / 180), 0);
    signature[f] = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  console.log(`faction signature hues: ${FACTIONS.map((f) => `${f} ${signature[f].toFixed(0)}°`).join(" · ")}`);
  let strays = 0;
  for (const f of FACTIONS) {
    const rows = [];
    for (const kind of ROSTERS[f]) {
      let got;
      try { got = await readSubject(join(OUT, `roster-${kind}-${f}.png`), join(OUT, `roster-${kind}-${f}-sil.png`)); } catch { continue; }
      const own = hueGap(got.hue, signature[f]);
      const other = Math.min(...FACTIONS.filter((g) => g !== f).map((g) => hueGap(got.hue, signature[g])));
      const ok = own + GOAL.memberMargin <= other;
      if (!ok) strays += 1;
      rows.push(`${kind}${ok ? "" : ` ✗(own ${own.toFixed(0)}° vs other ${other.toFixed(0)}°)`}`);
    }
    console.log(`  ${f.padEnd(10)} ${rows.join(" · ")}`);
  }
  failed += strays;
  console.log(strays ? `${strays} unit(s) read as another faction` : "every roster unit reads as its own faction");
  console.log(failed ? `${failed} pair(s)/unit(s) short of the goal` : "GOAL MET: every faction pair differs in shape and hue, and every unit reads as its faction");
  if (failed && process.env.MEASURE_GATE) process.exitCode = 1;
} catch (e) {
  console.error(`measure-factions: run \`npx electron scripts/shots-gpu.cjs factionmeasure\` first (${e.message})`);
  process.exitCode = 1;
}
