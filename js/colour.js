// Colour mode: k-means colour quantisation, then stacked layer tracing.
// Layers are ordered dark -> light. Layer k covers every pixel whose colour index is
// >= k and is filled with palette colour k, so later (lighter) layers paint over the
// earlier ones and no gaps appear between regions.
import { traceLoops, loopArea } from "./decompose.js";
import { simplifyLoop, loopToPath } from "./fit.js";
import { smoothLoop } from "./trace.js";
import { cutoutPaths } from "./chains.js";

// k-means on RGB with deterministic init (evenly spaced over the luminance-sorted sample).
export function quantize(rgba, w, h, k, opts = {}) {
  const n = w * h;
  const maxSample = 20000;
  const step = Math.max(1, Math.floor(n / maxSample));
  const samples = [];
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    if (rgba[p + 3] < 16) continue; // skip transparent
    samples.push([rgba[p], rgba[p + 1], rgba[p + 2]]);
  }
  if (samples.length === 0) return { palette: [[255, 255, 255]], labels: new Uint8Array(n).fill(0) };
  samples.sort((a, b) => (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) - (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2]));
  let K = Math.min(k, samples.length);
  // farthest-first seeding: each new seed is the sample most unlike the seeds so far,
  // so small but distinct colour regions (not just the dominant ones) get a centroid
  const d2 = new Float64Array(samples.length).fill(Infinity);
  let cent = [samples[0].slice()];
  const addSeed = (s) => {
    for (let i = 0; i < samples.length; i++) {
      const q = samples[i];
      const d = (q[0] - s[0]) ** 2 + (q[1] - s[1]) ** 2 + (q[2] - s[2]) ** 2;
      if (d < d2[i]) d2[i] = d;
    }
  };
  addSeed(cent[0]);
  while (cent.length < K) {
    let bi = 0, bd = -1;
    for (let i = 0; i < samples.length; i++) if (d2[i] > bd) { bd = d2[i]; bi = i; }
    if (bd <= 0) break; // no distinct colours left
    cent.push(samples[bi].slice());
    addSeed(cent[cent.length - 1]);
  }
  K = cent.length;

  for (let iter = 0; iter < (opts.iterations || 12); iter++) {
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const d = (s[0] - cent[c][0]) ** 2 + (s[1] - cent[c][1]) ** 2 + (s[2] - cent[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      const acc = sum[best];
      acc[0] += s[0]; acc[1] += s[1]; acc[2] += s[2]; acc[3]++;
    }
    let moved = 0;
    cent = cent.map((c, i) => {
      const a = sum[i];
      if (a[3] === 0) return c;
      const nc = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      moved += Math.abs(nc[0] - c[0]) + Math.abs(nc[1] - c[1]) + Math.abs(nc[2] - c[2]);
      return nc;
    });
    if (moved < 0.5) break;
  }

  // assign every pixel, then sort palette dark -> light
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    let best = 0, bd = Infinity;
    for (let c = 0; c < K; c++) {
      const d = (rgba[p] - cent[c][0]) ** 2 + (rgba[p + 1] - cent[c][1]) ** 2 + (rgba[p + 2] - cent[c][2]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    labels[i] = best;
  }
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  // sort dark -> light, then merge clusters whose colours are practically identical
  const order = cent.map((c, i) => i).sort((a, b) => lum(cent[a]) - lum(cent[b]));
  const groups = []; // each: { centroid, members: [old indices] }
  for (const old of order) {
    const c = cent[old];
    const g = groups.find((gr) => Math.hypot(gr.c[0] - c[0], gr.c[1] - c[1], gr.c[2] - c[2]) < 24);
    if (g) g.members.push(old); else groups.push({ c, members: [old] });
  }
  const remap = new Uint8Array(K);
  groups.forEach((g, rank) => g.members.forEach((old) => { remap[old] = rank; }));
  for (let i = 0; i < n; i++) labels[i] = (rgba[i * 4 + 3] < 16) ? 255 : remap[labels[i]];
  const palette = groups.map((g) => g.c.map((v) => Math.round(v)));
  return { palette, labels };
}

const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const TRANSPARENT = 255;

// Fits one boundary loop (lattice corners, offset by ox/oy) to SVG path data.
function fitLoop(loop, ox, oy, fit) {
  const n = loop.length / 2;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = loop[2 * i] + ox; ys[i] = loop[2 * i + 1] + oy; }
  if (fit.onLoop) fit.onLoop(xs, ys); // optional debug hook: raw lattice loop before smoothing
  const [sx, sy] = smoothLoop(xs, ys, fit.smooth);
  const idx = simplifyLoop(sx, sy, fit.tol);
  const px = idx.map((i) => sx[i]), py = idx.map((i) => sy[i]);
  for (let i = 0; i < px.length; i++) fit.nodes.push(px[i], py[i]);
  return loopToPath(px, py, fit.alphamax);
}

// Distance from colour c to the segment a-b in RGB space (how well c is "a mix of a and b").
function segDist(c, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  let t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(c[0] - a[0] - t * ab[0], c[1] - a[1] - t * ab[1], c[2] - a[2] - t * ab[2]);
}
const BLEND_DIST = 28;

// Reassigns every pixel flagged in `bad` to the 4-neighbour label (not bad, not transparent)
// whose colour is closest to the pixel's own colour, working inwards from the edges of each
// bad region. Pixels with no usable neighbour fall back to the nearest colour in `fallback`.
function reassign(rgba, w, h, palette, labels, bad, fallback) {
  const out = labels.slice();
  const dist2 = (i, l) => {
    const p = i * 4, c = palette[l];
    return (rgba[p] - c[0]) ** 2 + (rgba[p + 1] - c[1]) ** 2 + (rgba[p + 2] - c[2]) ** 2;
  };
  const isBad = bad.slice();
  let pending = [];
  for (let i = 0; i < out.length; i++) if (isBad[i]) pending.push(i);
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    const next = [], updates = [];
    for (const i of pending) {
      const x = i % w, y = (i / w) | 0;
      let best = -1, bd = Infinity;
      const tryN = (j) => {
        if (isBad[j] || out[j] === TRANSPARENT) return;
        const d = dist2(i, out[j]);
        if (d < bd) { bd = d; best = out[j]; }
      };
      if (x > 0) tryN(i - 1);
      if (x < w - 1) tryN(i + 1);
      if (y > 0) tryN(i - w);
      if (y < h - 1) tryN(i + w);
      if (best >= 0) updates.push(i, best); else next.push(i);
    }
    for (let u = 0; u < updates.length; u += 2) { out[updates[u]] = updates[u + 1]; isBad[updates[u]] = 0; }
    pending = next;
  }
  for (const i of pending) {
    let best = fallback[0], bd = Infinity;
    for (const l of fallback) { const d = dist2(i, l); if (d < bd) { bd = d; best = l; } }
    out[i] = best;
  }
  return out;
}

// Anti-aliased edges create "blend" colours (e.g. grey between black and white) that would
// trace as thin slivers along every edge. A cluster is treated as a blend only when BOTH:
//   - almost none of its pixels are interior (all 4 neighbours the same colour), and
//   - its colour lies close to the line between two other palette colours.
// Blend pixels are reassigned to the neighbouring real colour closest to their own colour.
function absorbBlends(rgba, w, h, palette, labels) {
  const K = palette.length;
  if (K <= 2) return { palette, labels };
  const count = new Float64Array(K), interior = new Float64Array(K);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l === TRANSPARENT) continue;
      count[l]++;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1 &&
          labels[i - 1] === l && labels[i + 1] === l && labels[i - w] === l && labels[i + w] === l) interior[l]++;
    }
  }
  const edgeOnly = [];
  for (let l = 0; l < K; l++) edgeOnly[l] = count[l] > 0 && interior[l] / count[l] < 0.3;
  const real = [];
  for (let l = 0; l < K; l++) if (count[l] > 0 && !edgeOnly[l]) real.push(l);
  if (real.length < 2) return { palette, labels };
  const blend = new Uint8Array(K);
  for (let l = 0; l < K; l++) {
    if (!edgeOnly[l]) continue;
    for (let a = 0; a < real.length && !blend[l]; a++)
      for (let b = a + 1; b < real.length; b++)
        if (segDist(palette[l], palette[real[a]], palette[real[b]]) < BLEND_DIST) { blend[l] = 1; break; }
  }
  if (!blend.some((v) => v)) return { palette, labels };
  const bad = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] !== TRANSPARENT && blend[labels[i]]) bad[i] = 1;
  const out = reassign(rgba, w, h, palette, labels, bad, real);
  // compact the palette (keeps dark -> light order)
  const remap = new Int16Array(K).fill(-1);
  const newPalette = [];
  for (let l = 0; l < K; l++) if (!blend[l] && count[l] > 0) { remap[l] = newPalette.length; newPalette.push(palette[l]); }
  for (let i = 0; i < out.length; i++) if (out[i] !== TRANSPARENT) out[i] = remap[out[i]];
  return { palette: newPalette, labels: out };
}

// Shape-level cleanup: a region of a REAL colour can still be an anti-aliasing fringe, e.g.
// the grey pixels on a black/white edge when the artwork also contains grey. A region is a
// fringe when it is small, has almost no interior pixels, and its colour lies between two of
// the colours it borders. Real small details (dots, specks with an interior) are kept.
function mergeFringes(rgba, w, h, palette, labels) {
  const n = w * h;
  const c = components(labels, w, h);
  const ncomp = c.label.length;
  const maxSize = Math.max(64, Math.round(n * 0.0005));
  const interior = new Uint32Array(ncomp);
  const neighbours = Array.from({ length: ncomp }, () => null);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, id = c.comp[i];
      if (c.size[id] > maxSize || labels[i] === TRANSPARENT) continue;
      let same = 0;
      const look = (j) => {
        if (c.comp[j] === id) { same++; return; }
        const l = labels[j];
        if (l === TRANSPARENT) return;
        (neighbours[id] ||= new Set()).add(l);
      };
      if (x > 0) look(i - 1);
      if (x < w - 1) look(i + 1);
      if (y > 0) look(i - w);
      if (y < h - 1) look(i + w);
      if (same === 4) interior[id]++;
    }
  }
  const fringe = new Uint8Array(ncomp);
  let any = false;
  for (let id = 0; id < ncomp; id++) {
    const nb = neighbours[id];
    if (!nb) continue;
    // tiny flecks with no interior pixel at all are compression noise, whatever their colour
    if (c.size[id] <= 12 && interior[id] === 0) { fringe[id] = 1; any = true; continue; }
    if (nb.size < 2 || c.size[id] > maxSize || interior[id] / c.size[id] >= 0.3) continue;
    const col = palette[c.label[id]], list = [...nb];
    outer: for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++)
        if (segDist(col, palette[list[a]], palette[list[b]]) < BLEND_DIST) { fringe[id] = 1; any = true; break outer; }
  }
  if (!any) return labels;
  const bad = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (fringe[c.comp[i]]) bad[i] = 1;
  const all = palette.map((_, l) => l);
  return reassign(rgba, w, h, palette, labels, bad, all);
}

// Final fill colours: the mean of each colour's INTERIOR pixels (all 4 neighbours the same
// colour). Edge pixels are anti-aliased and would bias the fill toward its neighbours.
function refinePalette(rgba, w, h, palette, labels) {
  const K = palette.length;
  const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
  const all = Array.from({ length: K }, () => [0, 0, 0, 0]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = labels[i];
      if (l === TRANSPARENT) continue;
      const p = i * 4, a = all[l];
      a[0] += rgba[p]; a[1] += rgba[p + 1]; a[2] += rgba[p + 2]; a[3]++;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1 &&
          labels[i - 1] === l && labels[i + 1] === l && labels[i - w] === l && labels[i + w] === l) {
        const s = sum[l];
        s[0] += rgba[p]; s[1] += rgba[p + 1]; s[2] += rgba[p + 2]; s[3]++;
      }
    }
  }
  return palette.map((c, l) => {
    const s = sum[l][3] ? sum[l] : all[l];
    return s[3] ? [0, 1, 2].map((j) => Math.round(s[j] / s[3])) : c;
  });
}

// Merges the least-used colours into their nearest remaining colour until at most k remain.
function reducePalette(palette, labels, k) {
  if (palette.length <= k) return { palette, labels };
  const K = palette.length;
  const count = new Float64Array(K);
  for (let i = 0; i < labels.length; i++) if (labels[i] !== TRANSPARENT) count[labels[i]]++;
  const target = Array.from({ length: K }, (_, l) => l); // where each colour ends up
  const alive = new Set(target);
  while (alive.size > k) {
    let small = -1;
    for (const l of alive) if (small < 0 || count[l] < count[small]) small = l;
    alive.delete(small);
    let near = -1, nd = Infinity;
    for (const l of alive) {
      const d = Math.hypot(palette[l][0] - palette[small][0], palette[l][1] - palette[small][1], palette[l][2] - palette[small][2]);
      if (d < nd) { nd = d; near = l; }
    }
    for (let l = 0; l < K; l++) if (target[l] === small) target[l] = near;
    count[near] += count[small];
  }
  const order = [...alive].sort((a, b) => a - b); // keeps dark -> light order
  const rank = new Int16Array(K).fill(-1);
  order.forEach((l, r) => { rank[l] = r; });
  const out = labels.slice();
  for (let i = 0; i < out.length; i++) if (out[i] !== TRANSPARENT) out[i] = rank[target[out[i]]];
  return { palette: order.map((l) => palette[l]), labels: out };
}

// 4-connected components of equal labels. Returns per-pixel component ids plus per-component
// label, pixel count and bounding box.
function components(labels, w, h) {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const label = [], size = [], x0 = [], y0 = [], x1 = [], y1 = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const id = label.length, l = labels[s];
    let top = 0, cnt = 0, minx = w, miny = h, maxx = 0, maxy = 0;
    stack[top++] = s; comp[s] = id;
    while (top) {
      const i = stack[--top];
      const x = i % w, y = (i / w) | 0;
      cnt++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && comp[i - 1] === -1 && labels[i - 1] === l) { comp[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && comp[i + 1] === -1 && labels[i + 1] === l) { comp[i + 1] = id; stack[top++] = i + 1; }
      if (y > 0 && comp[i - w] === -1 && labels[i - w] === l) { comp[i - w] = id; stack[top++] = i - w; }
      if (y < h - 1 && comp[i + w] === -1 && labels[i + w] === l) { comp[i + w] = id; stack[top++] = i + w; }
    }
    label.push(l); size.push(cnt); x0.push(minx); y0.push(miny); x1.push(maxx); y1.push(maxy);
  }
  return { comp, label, size, x0, y0, x1, y1 };
}

// Merges speckles (components smaller than `minSize` px) into their most common neighbour colour.
function mergeSpeckles(labels, w, h, minSize) {
  if (minSize <= 1) return labels;
  const c = components(labels, w, h);
  const out = labels.slice();
  for (let i = 0; i < out.length; i++) {
    const id = c.comp[i];
    if (c.size[id] >= minSize || labels[i] === TRANSPARENT) continue;
    const x = i % w, y = (i / w) | 0;
    const votes = new Map();
    const vote = (j) => { const l = labels[j]; if (c.comp[j] !== id && l !== TRANSPARENT) votes.set(l, (votes.get(l) || 0) + 1); };
    if (x > 0) vote(i - 1);
    if (x < w - 1) vote(i + 1);
    if (y > 0) vote(i - w);
    if (y < h - 1) vote(i + w);
    let best = -1, bv = 0;
    for (const [l, v] of votes) if (v > bv) { bv = v; best = l; }
    if (best >= 0) out[i] = best;
  }
  return out;
}

// Colour of the image border (most common label along the edges): the background.
function borderLabel(labels, w, h) {
  const votes = new Map();
  const vote = (i) => { const l = labels[i]; if (l !== TRANSPARENT) votes.set(l, (votes.get(l) || 0) + 1); };
  for (let x = 0; x < w; x++) { vote(x); vote((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { vote(y * w); vote(y * w + w - 1); }
  let best = -1, bv = 0;
  for (const [l, v] of votes) if (v > bv) { bv = v; best = l; }
  return best;
}

// Colour tracing.
//   opts.output = "shapes"  (default): every connected region of each colour is its own <path>.
//                 Shapes are ordered largest first; a parent shape fills underneath the shapes
//                 inside it, so neighbouring shapes never show hairline gaps.
//   opts.output = "stacked": one path per colour, cumulative dark -> light layers.
//   opts.removeBackground: drop the border-touching background region(s) (shapes mode).
export function traceColour(rgba, w, h, k, opts = {}) {
  const t0 = performance.now();
  // Quantise with a few spare clusters: anti-aliasing outliers can claim seeds, and the
  // spares are absorbed as blends instead of crowding out a real colour.
  const q = quantize(rgba, w, h, Math.min(k + 4, 40));
  let { palette, labels } = absorbBlends(rgba, w, h, q.palette, q.labels);
  ({ palette, labels } = reducePalette(palette, labels, k));
  const turd = opts.turdsize ?? 2;
  labels = mergeFringes(rgba, w, h, palette, labels);
  labels = mergeSpeckles(labels, w, h, Math.max(1, Math.ceil(turd)));
  palette = refinePalette(rgba, w, h, palette, labels);
  const t1 = performance.now();
  const fit = {
    tol: 0.1 + (opts.opttolerance ?? 0.2),
    alphamax: opts.alphamax ?? 1,
    smooth: opts.smoothPasses ?? 1,
    nodes: [],
    onLoop: opts.onLoop,
  };
  const paths = opts.output === "stacked"
    ? stackedPaths(labels, w, h, palette, turd, fit)
    : shapePaths(labels, w, h, palette, turd, fit, !!opts.removeBackground);
  const t2 = performance.now();
  return {
    paths,
    palette: palette.map(hex),
    nodes: new Float32Array(fit.nodes),
    shapes: paths.length,
    timings: { quantize: t1 - t0, trace: t2 - t1 },
  };
}

function stackedPaths(labels, w, h, palette, turd, fit) {
  const paths = [];
  const mask = new Uint8Array(w * h);
  for (let layer = 0; layer < palette.length; layer++) {
    let any = false;
    for (let i = 0; i < mask.length; i++) {
      const on = labels[i] >= layer && labels[i] !== TRANSPARENT ? 1 : 0;
      mask[i] = on; any = any || on === 1;
    }
    if (!any) continue;
    let d = "";
    for (const loop of traceLoops(mask, w, h)) {
      if (Math.abs(loopArea(loop)) < turd) continue;
      d += fitLoop(loop, 0, 0, fit);
    }
    if (d) paths.push({ fill: hex(palette[layer]), d });
  }
  return paths;
}

// Every connected region of each colour becomes its own cut-out <path>: holes are real holes and
// neighbouring shapes share the exact same boundary curves (see chains.js), so the SVG can be
// edited shape by shape with no overlaps, gaps or masks.
function shapePaths(labels, w, h, palette, turd, fit, removeBackground) {
  const c = components(labels, w, h);
  const bg = borderLabel(labels, w, h);
  const regions = c.label.map((l, id) => {
    const isBackground = removeBackground && l === bg &&
      (c.x0[id] === 0 || c.y0[id] === 0 || c.x1[id] === w - 1 || c.y1[id] === h - 1);
    return { fill: l === TRANSPARENT ? null : hex(palette[l]), size: c.size[id], draw: l !== TRANSPARENT && !isBackground };
  });
  return cutoutPaths(c.comp, w, h, regions, fit);
}
