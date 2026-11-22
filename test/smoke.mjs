import { traceLoops, loopArea } from "../js/decompose.js";
import { traceBlackWhite } from "../js/trace.js";
const w = 200, h = 160;
const mask = new Uint8Array(w * h);
let fgCount = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const inCircle = (x - 80) ** 2 + (y - 80) ** 2 <= 50 * 50;
  const inHole = (x - 80) ** 2 + (y - 80) ** 2 <= 20 * 20;
  const inBox = x >= 120 && x < 190 && y >= 20 && y < 140;
  const v = (inCircle && !inHole) || inBox ? 1 : 0;
  mask[y * w + x] = v; fgCount += v;
}
const loops = traceLoops(mask, w, h);
const area = loops.reduce((s, l) => s + loopArea(l), 0);
console.log("loops", loops.length, "signed area sum", area, "fg pixels", fgCount);
const gray = new Float32Array(w * h);
for (let i = 0; i < gray.length; i++) gray[i] = mask[i] ? 0 : 255;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) { rgba[4*i]=rgba[4*i+1]=rgba[4*i+2]=gray[i]; rgba[4*i+3]=255; }
const r = traceBlackWhite(gray, w, h, { threshold: 128 });
console.log("paths", r.loops, "d length", r.d.length, "nodes", r.nodes.length/2, r.timings);
console.log(r.d.slice(0, 200));
