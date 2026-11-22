import { traceColour } from "../js/colour.js";
const w = 120, h = 80;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const p = (y * w + x) * 4;
  let c = [255, 255, 255];
  if ((x - 40) ** 2 + (y - 40) ** 2 <= 25 * 25) c = [200, 30, 30];
  if (x >= 80 && x < 110 && y >= 10 && y < 70) c = [20, 60, 200];
  rgba.set([...c, 255], p);
}
const r = traceColour(rgba, w, h, 4, {});
console.log("palette", r.palette, "paths", r.paths.length, "nodes", r.nodes, r.timings);
