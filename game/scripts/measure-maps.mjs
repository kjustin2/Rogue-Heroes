// MAP LOOK MEASURE (2026-09-24, overhaul options 4-6). Reads the real-GPU gameplay frame of every
// battlefield (`shots:gpu maps`) and scores the board itself -- the central region, clear of the HUD
// rails -- with the same statistics as the harness image gate (improve/lib/harness.mjs imageStats):
// contrast (luma std-dev), range (p95 - p5) and hue concentration (share of coloured pixels in one
// 10-degree bucket). The goal is a board with light and shade and more than one ground colour, not a
// single-tone sheet. `SHOT_PREFIX=before-` measures a baseline; MEASURE_GATE=1 fails below the goal.
import sharp from "sharp";
import { join } from "node:path";

const MAPS = ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"];
const GOAL = { contrast: 0.1, range: 0.3, hueConcentration: 0.6 };
const prefix = process.env.SHOT_PREFIX ?? "gpu-";

let failed = 0;
for (const id of MAPS) {
  const file = join("shots", `${prefix}map-${id}.png`);
  const meta = await sharp(file).metadata();
  // Board only: skip the top HUD rail, the bottom order bar and both side panels.
  const left = Math.round(meta.width * 0.16), top = Math.round(meta.height * 0.14);
  const width = Math.round(meta.width * 0.68), height = Math.round(meta.height * 0.62);
  const { data } = await sharp(file).extract({ left, top, width, height }).resize(320, 180).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lums = [];
  const hues = new Array(36).fill(0);
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d > 0.04) {
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hues[Math.floor((((h * 60) + 360) % 360) / 10)] += 1;
    }
  }
  const n = lums.length;
  const mean = lums.reduce((a, b) => a + b, 0) / n;
  const contrast = Math.sqrt(lums.reduce((a, l) => a + (l - mean) ** 2, 0) / n);
  lums.sort((a, b) => a - b);
  const range = lums[Math.floor(0.95 * n)] - lums[Math.floor(0.05 * n)];
  const colored = hues.reduce((a, b) => a + b, 0);
  const hueConcentration = colored ? Math.max(...hues) / colored : 0;
  const ok = contrast >= GOAL.contrast && range >= GOAL.range && hueConcentration <= GOAL.hueConcentration;
  if (!ok) failed += 1;
  console.log(`${id.padEnd(10)} contrast ${contrast.toFixed(3)}  range ${range.toFixed(3)}  one-hue ${(hueConcentration * 100).toFixed(0)}%  ${ok ? "ok" : "MISS"}`);
}
console.log(failed ? `${failed} map(s) short of the goal (contrast >= ${GOAL.contrast}, range >= ${GOAL.range}, one-hue <= ${GOAL.hueConcentration * 100}%)` : "GOAL MET: every board has light, shade and more than one ground colour");
if (failed && process.env.MEASURE_GATE) process.exit(1);
