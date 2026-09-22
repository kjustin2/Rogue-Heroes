// Zoom-crop helper for the glitch sweep: node scripts/glitch-crop.cjs <png> <x> <y> <w> <h> <zoom> <out>
const sharp = require("sharp");
const path = require("path");
const [src, x, y, w, h, z, out] = process.argv.slice(2);
const Z = Number(z || 4);
sharp(src).extract({ left: +x, top: +y, width: +w, height: +h })
  .resize(+w * Z, +h * Z, { kernel: "nearest" }).png()
  .toFile(path.resolve(out)).then((i) => console.log("wrote " + out + " " + i.width + "x" + i.height));
