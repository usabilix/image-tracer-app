// Tracing pipeline for black & white mode.
// Input: RGBA pixels. Output: SVG path data plus node positions for the preview overlay.
import { toGray, gaussianBlur, histogram, otsuThreshold, thresholdMask } from "./bitmap.js";
import { traceLoops, loopArea, labelComponents, loopPixel } from "./decompose.js";
import { simplifyLoop, loopToPath } from "./fit.js";

export const DEFAULTS = {
  threshold: null,   // null = Otsu auto
  invert: false,
  blur: 0,           // gaussian radius in px
  turdsize: 2,       // "Ignore less than": drop speckles with area below this (px)
  alphamax: 1,       // "Smoothness": 0 = polygonal .. 1.34 = very smooth
  opttolerance: 0.2, // "Curve optimisation": higher = fewer nodes
  smoothPasses: 1,   // internal: staircase removal before fitting
  removeJogs: false, // internal: flatten 1 px zigzags (on in colour mode, where anti-aliased pixels flip colours)
  snapCorners: true, // internal: rebuild sharp corners blurred by anti-aliasing
  keepCorners: true, // internal: do not smooth corners between long straight runs
};

export function prepareGray(rgba, w, h, blur) {
  return gaussianBlur(toGray(rgba, w, h), w, h, blur);
}

// Full B&W trace.
// `gray` may be precomputed (prepareGray) so the UI can re-trace fast when only
// tracing parameters change.
export function traceBlackWhite(gray, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = performance.now();
  const threshold = o.threshold == null ? otsuThreshold(histogram(gray), gray.length) : o.threshold;
  const mask = thresholdMask(gray, threshold, o.invert);
  const t1 = performance.now();

  const loops = traceLoops(mask, w, h);
  // Group loops by the foreground component they bound: each visually separate shape
  // (its outline plus its own holes) becomes its own path.
  const { labels } = labelComponents(mask, w, h);
  const tol = 0.1 + o.opttolerance * 1.0;
  const shapes = new Map(); // label -> { d, area }
  const nodes = [];
  let kept = 0;
  for (const loop of loops) {
    const n = loop.length / 2;
    if (n < 2) continue;
    const area = loopArea(loop);
    if (Math.abs(area) < o.turdsize) continue;
    const label = labels[loopPixel(loop, w)];
    let shape = shapes.get(label);
    if (!shape) { shape = { d: "", area: 0 }; shapes.set(label, shape); }
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = loop[2 * i]; ys[i] = loop[2 * i + 1]; }
    const [sx, sy] = smoothLoop(xs, ys, o.smoothPasses, { jogs: o.removeJogs, snap: o.snapCorners, corners: o.keepCorners });
    const idx = simplifyLoop(sx, sy, tol);
    const px = idx.map((i) => sx[i]);
    const py = idx.map((i) => sy[i]);
    shape.d += loopToPath(px, py, o.alphamax);
    if (area > 0) shape.area = area; // outer boundary
    for (let i = 0; i < px.length; i++) nodes.push(px[i], py[i]);
    kept++;
  }
  // A shape whose outline was dropped as a speckle has nothing left worth drawing.
  const paths = [...shapes.values()].filter((s) => s.area > 0).sort((a, b) => b.area - a.area).map((s) => ({ d: s.d }));
  const d = paths.map((p) => p.d).join("");
  const t2 = performance.now();
  return {
    d,
    paths,
    shapes: paths.length,
    nodes: new Float32Array(nodes),
    threshold,
    loops: kept,
    timings: { threshold: t1 - t0, trace: t2 - t1 },
  };
}

// Light closed-loop smoothing of lattice corners: removes pixel staircases so
// diagonal and curved edges can be simplified, while keeping corners within ~1px.
export function smoothLoop(xs, ys, passes = 2, opts = {}) {
  const minRun = opts.minRun ?? 3;
  if (passes > 0) {
    if (opts.jogs !== false) [xs, ys] = removeJogs(xs, ys, 4, 1);
    if (opts.snap !== false) [xs, ys] = snapCorners(xs, ys, minRun, 3);
  }
  const n = xs.length;
  // Real corners (a turn between two straight runs of at least `minRun` px, e.g. the steps
  // of pixel art or the corner of a rectangle) stay exactly where they are. Only short
  // staircases (the pixel approximation of curves and diagonals) are smoothed.
  const fixed = opts.corners === false ? new Uint8Array(xs.length) : cornerMask(xs, ys, minRun);
  let x = xs, y = ys;
  for (let p = 0; p < passes; p++) {
    const nx = new Float64Array(n), ny = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { nx[i] = x[i]; ny[i] = y[i]; continue; }
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      nx[i] = 0.25 * x[a] + 0.5 * x[i] + 0.25 * x[b];
      ny[i] = 0.25 * y[a] + 0.5 * y[i] + 0.25 * y[b];
    }
    x = nx; y = ny;
  }
  return [x, y];
}

// Edge direction codes along a loop: 0 = +x, 1 = +y, 2 = -x, 3 = -y.
function edgeDirs(xs, ys) {
  const n = xs.length, dir = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = Math.sign(xs[j] - xs[i]), dy = Math.sign(ys[j] - ys[i]);
    dir[i] = dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
  }
  return dir;
}

// Maximal runs of equal direction: [{ dir, start (edge index = start point index), len }],
// in loop order, beginning at a direction change. Returns null for single-direction loops.
function edgeRuns(dir) {
  const n = dir.length;
  let s = 0;
  while (s < n && dir[s] === dir[(s - 1 + n) % n]) s++;
  if (s === n) return null;
  const runs = [];
  for (let k = 0; k < n; ) {
    const i0 = (s + k) % n;
    let len = 1;
    while (len < n && dir[(i0 + len) % n] === dir[i0]) len++;
    runs.push({ dir: dir[i0], start: i0, len });
    k += len;
  }
  return runs;
}

// Jog removal. Edge pixels that are ~50% covered flip either way, so a straight edge comes
// out as a 1 px zigzag. A step out, a short run (<= maxLen) and a step straight back, sitting
// between two runs of >= minFlank along the same line, is flattened onto that line.
// Staircases (curves, diagonals) never step back, so they are left alone.
function removeJogs(xs, ys, maxLen, minFlank) {
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  for (let iter = 0; iter < 12; iter++) {
    const n = xs.length;
    if (n < 8) break;
    const runs = edgeRuns(edgeDirs(xs, ys));
    if (!runs || runs.length < 5) break;
    const R = runs.length;
    const shiftX = new Float64Array(n), shiftY = new Float64Array(n);
    const used = new Uint8Array(R);
    let changed = false;
    for (let r = 0; r < R; r++) {
      const before = runs[(r - 1 + R) % R], P = runs[r], mid = runs[(r + 1) % R],
            back = runs[(r + 2) % R], after = runs[(r + 3) % R];
      if (P.len !== 1 || back.len !== 1 || ((P.dir + 2) & 3) !== back.dir) continue; // out and straight back
      if (mid.len > maxLen || mid.dir !== before.dir || after.dir !== before.dir) continue; // on one straight line
      if (before.len < minFlank || after.len < minFlank) continue;
      const ids = [(r - 1 + R) % R, r, (r + 1) % R, (r + 2) % R, (r + 3) % R];
      if (ids.some((id) => used[id])) continue; // one fix per neighbourhood per pass
      ids.forEach((id) => { used[id] = 1; });
      // points on the displaced line: from the start of `mid` to the start of `back`
      for (let t = mid.start; ; t = (t + 1) % n) {
        shiftX[t] = -DX[P.dir]; shiftY[t] = -DY[P.dir];
        if (t === back.start) break;
      }
      changed = true;
    }
    if (!changed) break;
    const ox = [], oy = [];
    for (let i = 0; i < n; i++) {
      const x = xs[i] + shiftX[i], y = ys[i] + shiftY[i];
      const m = ox.length;
      if (m && ox[m - 1] === x && oy[m - 1] === y) continue;
      ox.push(x); oy.push(y);
    }
    while (ox.length > 1 && ox[0] === ox[ox.length - 1] && oy[0] === oy[oy.length - 1]) { ox.pop(); oy.pop(); }
    // collapse straight-line backtracks (a -> b -> a) left by flattening
    if (ox.length < 4) break;
    xs = Float64Array.from(ox); ys = Float64Array.from(oy);
  }
  return [xs, ys];
}

// Corner reconstruction. Anti-aliasing leaves a 1-2 px notch at sharp corners, so a corner
// appears as "long run, tiny step(s), long run". When two perpendicular runs of at least
// `minRun` px are joined by at most `maxGap` px of short steps, the gap is replaced by the
// exact point where the two edges meet, giving a crisp corner.
function snapCorners(xs, ys, minRun, maxGap) {
  const n = xs.length;
  if (n < 8) return [xs, ys];
  const runs = edgeRuns(edgeDirs(xs, ys));
  if (!runs || runs.length < 3) return [xs, ys];
  const R = runs.length;
  const drop = new Uint8Array(n);
  const moveX = new Float64Array(n).fill(NaN), moveY = new Float64Array(n);
  let changed = false;
  for (let r = 0; r < R; r++) {
    const A = runs[r];
    if (A.len < minRun) continue;
    let gap = 0, k = 1;
    while (k < R && runs[(r + k) % R].len < minRun) { gap += runs[(r + k) % R].len; k++; }
    if (k === 1 || k >= R || gap > maxGap) continue;  // already sharp, no partner, or a real curve
    const B = runs[(r + k) % R];
    if (((A.dir - B.dir) & 1) === 0) continue;         // parallel or opposite: a jog, not a corner
    const eA = (A.start + A.len) % n;                   // last point of run A (gap begins)
    const pB = B.start;                                 // first point of run B (gap ends)
    const horizA = A.dir === 0 || A.dir === 2;
    const cx = horizA ? xs[pB] : xs[A.start];
    const cy = horizA ? ys[A.start] : ys[pB];
    let ok = true;
    for (let t = eA; ; t = (t + 1) % n) {
      if (Math.hypot(xs[t] - cx, ys[t] - cy) > maxGap + 0.5) { ok = false; break; }
      if (t === pB) break;
    }
    if (!ok) continue;
    moveX[eA] = cx; moveY[eA] = cy;
    for (let t = (eA + 1) % n; ; t = (t + 1) % n) { drop[t] = 1; if (t === pB) break; }
    changed = true;
  }
  if (!changed) return [xs, ys];
  const ox = [], oy = [];
  for (let i = 0; i < n; i++) {
    if (drop[i]) continue;
    const x = Number.isNaN(moveX[i]) ? xs[i] : moveX[i];
    const y = Number.isNaN(moveX[i]) ? ys[i] : moveY[i];
    const m = ox.length;
    if (m && ox[m - 1] === x && oy[m - 1] === y) continue; // drop duplicates
    ox.push(x); oy.push(y);
  }
  while (ox.length > 1 && ox[0] === ox[ox.length - 1] && oy[0] === oy[oy.length - 1]) { ox.pop(); oy.pop(); }
  if (ox.length < 4) return [xs, ys];
  return [Float64Array.from(ox), Float64Array.from(oy)];
}

// Marks loop vertices that are corners between two straight runs of >= minRun unit edges.
// Loop points are consecutive pixel-lattice corners, so every edge is one unit step.
function cornerMask(xs, ys, minRun) {
  const n = xs.length;
  const fixed = new Uint8Array(n);
  if (n < 4 || !(minRun > 0)) return fixed;
  const dir = edgeDirs(xs, ys);
  const runs = edgeRuns(dir);
  if (!runs) return fixed;
  const run = new Int32Array(n);
  for (const r of runs) for (let t = 0; t < r.len; t++) run[(r.start + t) % n] = r.len;
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n; // edge arriving at point i
    if (dir[prev] !== dir[i] && run[prev] >= minRun && run[i] >= minRun) fixed[i] = 1;
  }
  return fixed;
}

export function svgDocument(w, h, paths, opts = {}) {
  const fill = opts.fill || "#000";
  const body = paths.map((p) => `<path fill="${p.fill || fill}" fill-rule="evenodd" d="${p.d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}
