// A/B two screenshots: prints mean abs diff and writes a side-by-side crop of the region that
// changed most, magnified, so a subtle shading change can be judged by eye instead of guessed.
// Usage: node scripts/shot-diff.mjs a.png b.png out.png [x y w h]
import sharp from "sharp";
const [a, b, out, ...rect] = process.argv.slice(2);
const A = sharp(a), B = sharp(b);
const { width, height } = await A.metadata();
const ra = await A.raw().toBuffer(), rb = await B.raw().toBuffer();
let sum = 0, hot = { x: 0, y: 0, v: -1 };
const cell = 64;
for (let cy = 0; cy + cell <= height; cy += cell) for (let cx = 0; cx + cell <= width; cx += cell) {
  let s = 0;
  for (let y = cy; y < cy + cell; y += 1) for (let x = cx; x < cx + cell; x += 1) {
    const i = (y * width + x) * 3;
    s += Math.abs(ra[i] - rb[i]) + Math.abs(ra[i + 1] - rb[i + 1]) + Math.abs(ra[i + 2] - rb[i + 2]);
  }
  sum += s;
  if (s > hot.v) hot = { x: cx, y: cy, v: s };
}
console.log(`mean abs diff/px ${(sum / (width * height * 3)).toFixed(3)}; hottest cell at ${hot.x},${hot.y}`);
let [x, y, w, h] = rect.length === 4 ? rect.map(Number) : [Math.max(0, hot.x - 160), Math.max(0, hot.y - 120), 384, 288];
w = Math.min(w, width - x); h = Math.min(h, height - y);
const crop = (src) => sharp(src).extract({ left: x, top: y, width: w, height: h }).resize(w * 3, h * 3, { kernel: "nearest" }).png().toBuffer();
const [ca, cb] = await Promise.all([crop(a), crop(b)]);
await sharp({ create: { width: w * 6 + 8, height: h * 3, channels: 3, background: "#fff" } })
  .composite([{ input: ca, left: 0, top: 0 }, { input: cb, left: w * 3 + 8, top: 0 }]).png().toFile(out);
console.log(`wrote ${out} (crop ${x},${y} ${w}x${h}; left = ${a}, right = ${b})`);
