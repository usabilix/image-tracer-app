// Cut-out tracing with shared boundaries.
//
// Every boundary between two regions is traced ONCE as a "chain" running between junctions
// (lattice points where 3+ regions meet, or a region touches itself diagonally). Each chain is
// smoothed and fitted once, and both regions on its sides reuse that exact geometry, one of
// them reversed. Neighbouring shapes therefore fit together exactly: no overlaps, no gaps,
// and every hole is a real cut-out.
import { smoothLoop } from "./trace.js";
import { simplifyLoop } from "./fit.js";

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/**
 * @param comp    Int32Array region id per pixel (w*h)
 * @param regions array indexed by region id: { fill, size, draw } (draw=false: not output)
 * @param fit     { tol, alphamax, smooth, nodes: [] }
 * @returns       [{ fill, d }] one path per drawn region, largest first
 */
export function cutoutPaths(comp, w, h, regions, fit) {
  const W1 = w + 1;
  const nH = w * (h + 1);                    // horizontal unit edges (x,y)-(x+1,y)
  const nE = nH + W1 * h;                    // + vertical unit edges (x,y)-(x,y+1)
  const hId = (x, y) => y * w + x;
  const vId = (x, y) => nH + y * W1 + x;
  const pix = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : comp[y * w + x];

  // 1. boundary edges: unit edges separating two different regions (outside counts as -1)
  const isB = new Uint8Array(nE);
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) if (pix(x, y - 1) !== pix(x, y)) isB[hId(x, y)] = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) if (pix(x - 1, y) !== pix(x, y)) isB[vId(x, y)] = 1;
  const edgeAt = (x, y, d) =>
    d === 0 ? (x < w ? hId(x, y) : -1) :
    d === 1 ? (y < h ? vId(x, y) : -1) :
    d === 2 ? (x > 0 ? hId(x - 1, y) : -1) :
              (y > 0 ? vId(x, y - 1) : -1);
  const degree = (x, y) => {
    let k = 0;
    for (let d = 0; d < 4; d++) { const e = edgeAt(x, y, d); if (e >= 0 && isB[e]) k++; }
    return k;
  };
  // pixel on the right / left of a unit edge leaving (x,y) in direction d
  const rightPix = (x, y, d) => d === 0 ? pix(x, y) : d === 1 ? pix(x - 1, y) : d === 2 ? pix(x - 1, y - 1) : pix(x, y - 1);
  const leftPix = (x, y, d) => d === 0 ? pix(x, y - 1) : d === 1 ? pix(x, y) : d === 2 ? pix(x - 1, y) : pix(x - 1, y - 1);

  // 2. chains: walk boundary edges from junction to junction
  const chainOf = new Int32Array(nE).fill(-1);
  const chains = [];
  const walk = (x0, y0, d0, fromJunction) => {
    const id = chains.length;
    const xs = [x0], ys = [y0];
    let x = x0, y = y0, d = d0;
    for (;;) {
      chainOf[edgeAt(x, y, d)] = id;
      x += DX[d]; y += DY[d];
      xs.push(x); ys.push(y);
      if (x === x0 && y === y0) break;
      if (degree(x, y) !== 2) break;
      let nd = -1;
      for (let k = 0; k < 4; k++) {
        if (k === ((d + 2) & 3)) continue;
        const e = edgeAt(x, y, k);
        if (e >= 0 && isB[e]) { nd = k; break; }
      }
      d = nd;
    }
    chains.push({ xs, ys, closed: !fromJunction, right: rightPix(x0, y0, d0), left: leftPix(x0, y0, d0) });
  };
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      if (degree(x, y) < 3) continue;
      for (let d = 0; d < 4; d++) {
        const e = edgeAt(x, y, d);
        if (e >= 0 && isB[e] && chainOf[e] < 0) walk(x, y, d, true);
      }
    }
  }
  // boundaries with no junction at all are closed loops (e.g. a shape inside one other shape)
  for (let e = 0; e < nE; e++) {
    if (!isB[e] || chainOf[e] >= 0) continue;
    if (e < nH) walk(e % w, (e / w) | 0, 0, false);
    else { const k = e - nH; walk(k % W1, (k / W1) | 0, 1, false); }
  }

  // 3. fit every chain once (only chains bordering a drawn region)
  const drawn = (r) => r >= 0 && regions[r] && regions[r].draw;
  const geom = new Array(chains.length);
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i];
    if (!drawn(c.left) && !drawn(c.right)) continue;
    geom[i] = c.closed ? fitClosed(c.xs, c.ys, fit) : fitOpen(c.xs, c.ys, fit);
  }

  // 4. assemble each region's loops from its chains (region kept on the right = outer boundary
  //    clockwise, holes counter-clockwise; even-odd fill cuts every hole)
  const perRegion = new Map();
  const add = (r, i, rev) => { if (!drawn(r)) return; let a = perRegion.get(r); if (!a) perRegion.set(r, a = []); a.push({ i, rev }); };
  for (let i = 0; i < chains.length; i++) {
    if (!geom[i]) continue;
    add(chains[i].right, i, false);
    add(chains[i].left, i, true);
  }
  const key = (x, y) => y * W1 + x;
  const paths = [];
  for (const [r, list] of perRegion) {
    const loops = [];
    const byStart = new Map();
    for (const o of list) {
      const c = chains[o.i];
      if (c.closed) { loops.push(o.rev ? reverseGeom(geom[o.i]) : geom[o.i]); o.used = true; continue; }
      const last = c.xs.length - 1;
      o.sx = o.rev ? c.xs[last] : c.xs[0]; o.sy = o.rev ? c.ys[last] : c.ys[0];
      o.ex = o.rev ? c.xs[0] : c.xs[last]; o.ey = o.rev ? c.ys[0] : c.ys[last];
      const k = key(o.sx, o.sy);
      let a = byStart.get(k); if (!a) byStart.set(k, a = []); a.push(o);
    }
    for (const o0 of list) {
      if (o0.used) continue;
      o0.used = true;
      const parts = [o0];
      let ex = o0.ex, ey = o0.ey;
      while (!(ex === o0.sx && ey === o0.sy)) {
        const next = (byStart.get(key(ex, ey)) || []).find((o) => !o.used);
        if (!next) break; // cannot happen for a consistent boundary
        next.used = true;
        parts.push(next);
        ex = next.ex; ey = next.ey;
      }
      loops.push(joinGeoms(parts.map((o) => (o.rev ? reverseGeom(geom[o.i]) : geom[o.i]))));
    }
    paths.push({ fill: regions[r].fill, d: loops.map(geomToD).join(""), area: regions[r].size });
  }
  paths.sort((a, b) => b.area - a.area);
  return paths.map(({ fill, d }) => ({ fill, d }));
}

// ---------------------------------------------------------------------------------------
// geometry: { x0, y0, segs: [[type, cx, cy, x, y]] } with type "L" (cx/cy unused) or "Q"

function reverseGeom(g) {
  const ends = [[g.x0, g.y0]];
  for (const s of g.segs) ends.push([s[3], s[4]]);
  const segs = [];
  for (let j = g.segs.length - 1; j >= 0; j--) {
    const s = g.segs[j];
    segs.push([s[0], s[1], s[2], ends[j][0], ends[j][1]]);
  }
  const last = ends[ends.length - 1];
  return { x0: last[0], y0: last[1], segs };
}

function joinGeoms(list) {
  const segs = [];
  for (const g of list) for (const s of g.segs) segs.push(s);
  return { x0: list[0].x0, y0: list[0].y0, segs };
}

// Compact path data: absolute coordinates rounded to 0.01 px FIRST, then written as relative
// commands, so two shapes sharing a chain produce bit-identical coordinates.
function geomToD(g) {
  const H = (v) => Math.round(v * 100);
  const fmt = (v) => (v / 100).toString();
  let cx = H(g.x0), cy = H(g.y0);
  let body = "", last = "";
  let endsWithNumber = false; // tracked instead of re-reading the growing string
  const put = (t) => { if (t[0] !== "-" && endsWithNumber) body += " "; body += t; endsWithNumber = true; };
  for (const s of g.segs) {
    const letter = s[0] === "Q" ? "q" : "l";
    if (letter !== last) { body += letter; last = letter; endsWithNumber = false; }
    if (letter === "q") { put(fmt(H(s[1]) - cx)); put(fmt(H(s[2]) - cy)); }
    const x = H(s[3]), y = H(s[4]);
    put(fmt(x - cx)); put(fmt(y - cy));
    cx = x; cy = y;
  }
  return `M${fmt(H(g.x0))} ${fmt(H(g.y0))}${body}z`;
}

// Corner flags from the turn angle at each vertex (same rule as fit.loopToPath).
function cornerFlags(px, py, alphamax, closed) {
  const n = px.length;
  const flags = new Uint8Array(n);
  const thresh = (alphamax / 1.34) * (Math.PI / 2);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { flags[i] = 1; continue; }
    const p = (i - 1 + n) % n, q = (i + 1) % n;
    const ax = px[i] - px[p], ay = py[i] - py[p], bx = px[q] - px[i], by = py[q] - py[i];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) { flags[i] = 1; continue; }
    flags[i] = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) > thresh ? 1 : 0;
  }
  return flags;
}

function fitClosed(xs, ys, fit) {
  const n = xs.length - 1; // last point repeats the first
  const [sx, sy] = smoothLoop(Float64Array.from(xs.slice(0, n)), Float64Array.from(ys.slice(0, n)), fit.smooth);
  const idx = simplifyLoop(sx, sy, fit.tol);
  const px = idx.map((i) => sx[i]), py = idx.map((i) => sy[i]);
  for (let i = 0; i < px.length; i++) fit.nodes.push(px[i], py[i]);
  const m = px.length;
  const mx = (i) => (px[i] + px[(i + 1) % m]) / 2, my = (i) => (py[i] + py[(i + 1) % m]) / 2;
  if (m < 3) return { x0: px[0], y0: py[0], segs: px.slice(1).map((x, k) => ["L", 0, 0, x, py[k + 1]]) };
  const corner = cornerFlags(px, py, fit.alphamax, true);
  const segs = [];
  for (let i = 0; i < m; i++) {
    if (corner[i]) { segs.push(["L", 0, 0, px[i], py[i]]); segs.push(["L", 0, 0, mx(i), my(i)]); }
    else segs.push(["Q", px[i], py[i], mx(i), my(i)]);
  }
  return { x0: mx(m - 1), y0: my(m - 1), segs };
}

function fitOpen(xs, ys, fit) {
  let a = Float64Array.from(xs), b = Float64Array.from(ys);
  if (fit.smooth > 0) {
    [a, b] = removeJogsOpen(a, b, 4);
    [a, b] = snapCornersOpen(a, b, 3, 3);
    [a, b] = smoothOpen(a, b, fit.smooth, 3);
  }
  const idx = simplifyOpen(a, b, fit.tol);
  const px = idx.map((i) => a[i]), py = idx.map((i) => b[i]);
  for (let i = 0; i < px.length; i++) fit.nodes.push(px[i], py[i]);
  const m = px.length - 1;
  if (m === 1) return { x0: px[0], y0: py[0], segs: [["L", 0, 0, px[1], py[1]]] };
  const corner = cornerFlags(px, py, fit.alphamax, false);
  const segs = [];
  for (let i = 1; i < m; i++) {
    const ex = i === m - 1 ? px[m] : (px[i] + px[i + 1]) / 2;
    const ey = i === m - 1 ? py[m] : (py[i] + py[i + 1]) / 2;
    if (corner[i]) { segs.push(["L", 0, 0, px[i], py[i]]); segs.push(["L", 0, 0, ex, ey]); }
    else segs.push(["Q", px[i], py[i], ex, ey]);
  }
  return { x0: px[0], y0: py[0], segs };
}

// ---------------------------------------------------------------------------------------
// open-polyline versions of the lattice clean-up steps (endpoints never move)

function openRuns(xs, ys) {
  const n = xs.length, runs = [];
  for (let i = 0; i < n - 1; ) {
    const d = dirOf(xs, ys, i);
    let len = 1;
    while (i + len < n - 1 && dirOf(xs, ys, i + len) === d) len++;
    runs.push({ dir: d, start: i, len });
    i += len;
  }
  return runs;
}

function dirOf(xs, ys, i) {
  const dx = Math.sign(xs[i + 1] - xs[i]), dy = Math.sign(ys[i + 1] - ys[i]);
  return dx === 1 ? 0 : dy === 1 ? 1 : dx === -1 ? 2 : 3;
}

function dedupe(xs, ys, keep) {
  const ox = [], oy = [];
  for (let i = 0; i < xs.length; i++) {
    if (keep && !keep(i)) continue;
    const m = ox.length;
    if (m && ox[m - 1] === xs[i] && oy[m - 1] === ys[i]) continue;
    ox.push(xs[i]); oy.push(ys[i]);
  }
  return [Float64Array.from(ox), Float64Array.from(oy)];
}

// flatten 1 px out-and-back jogs (anti-aliasing zigzag) on straight edges
function removeJogsOpen(xs, ys, maxLen) {
  for (let iter = 0; iter < 12; iter++) {
    const runs = openRuns(xs, ys), R = runs.length;
    if (R < 5) break;
    const shx = new Float64Array(xs.length), shy = new Float64Array(xs.length);
    const used = new Uint8Array(R);
    let changed = false;
    for (let r = 1; r + 3 < R; r++) {
      const before = runs[r - 1], P = runs[r], mid = runs[r + 1], back = runs[r + 2], after = runs[r + 3];
      if (P.len !== 1 || back.len !== 1 || ((P.dir + 2) & 3) !== back.dir) continue;
      if (mid.len > maxLen || mid.dir !== before.dir || after.dir !== before.dir) continue;
      if (used[r - 1] || used[r] || used[r + 1] || used[r + 2] || used[r + 3]) continue;
      used[r - 1] = used[r] = used[r + 1] = used[r + 2] = used[r + 3] = 1;
      for (let t = mid.start; t <= back.start; t++) { shx[t] = -DX[P.dir]; shy[t] = -DY[P.dir]; }
      changed = true;
    }
    if (!changed) break;
    const nx = xs.map((v, i) => v + shx[i]), ny = ys.map((v, i) => v + shy[i]);
    [xs, ys] = dedupe(nx, ny);
  }
  return [xs, ys];
}

// rebuild corners blurred by anti-aliasing: long run, <= maxGap px of steps, perpendicular long run
function snapCornersOpen(xs, ys, minRun, maxGap) {
  const runs = openRuns(xs, ys), R = runs.length;
  if (R < 3) return [xs, ys];
  const n = xs.length;
  const drop = new Uint8Array(n);
  const nx = Float64Array.from(xs), ny = Float64Array.from(ys);
  let changed = false;
  for (let r = 0; r < R; r++) {
    const A = runs[r];
    if (A.len < minRun) continue;
    let gap = 0, k = 1;
    while (r + k < R && runs[r + k].len < minRun) { gap += runs[r + k].len; k++; }
    if (k === 1 || r + k >= R || gap > maxGap) continue;
    const B = runs[r + k];
    if (((A.dir - B.dir) & 1) === 0) continue;
    const eA = A.start + A.len, pB = B.start;
    const horizA = A.dir === 0 || A.dir === 2;
    const cx = horizA ? xs[pB] : xs[A.start], cy = horizA ? ys[A.start] : ys[pB];
    let ok = true;
    for (let t = eA; t <= pB; t++) if (Math.hypot(xs[t] - cx, ys[t] - cy) > maxGap + 0.5) { ok = false; break; }
    if (!ok) continue;
    nx[eA] = cx; ny[eA] = cy;
    for (let t = eA + 1; t <= pB; t++) drop[t] = 1;
    changed = true;
  }
  if (!changed) return [xs, ys];
  return dedupe(nx, ny, (i) => !drop[i]);
}

// staircase smoothing; endpoints and corners between long straight runs stay fixed
function smoothOpen(xs, ys, passes, minRun) {
  const n = xs.length;
  if (n < 3) return [xs, ys];
  const fixed = new Uint8Array(n);
  fixed[0] = fixed[n - 1] = 1;
  const runs = openRuns(xs, ys);
  for (let r = 0; r + 1 < runs.length; r++) {
    if (runs[r].len >= minRun && runs[r + 1].len >= minRun) fixed[runs[r + 1].start] = 1;
  }
  let x = xs, y = ys;
  for (let p = 0; p < passes; p++) {
    const ox = new Float64Array(n), oy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (fixed[i]) { ox[i] = x[i]; oy[i] = y[i]; continue; }
      ox[i] = 0.25 * x[i - 1] + 0.5 * x[i] + 0.25 * x[i + 1];
      oy[i] = 0.25 * y[i - 1] + 0.5 * y[i] + 0.25 * y[i + 1];
    }
    x = ox; y = oy;
  }
  return [x, y];
}

// greedy furthest-reach simplification keeping both endpoints
function simplifyOpen(xs, ys, tol, maxSpan = 96) {
  const n = xs.length;
  const keep = [0];
  let a = 0;
  while (a < n - 1) {
    let b = a + 1;
    for (let c = a + 2; c <= Math.min(n - 1, a + maxSpan); c++) {
      if (!chordOk(xs, ys, a, c, tol)) break;
      b = c;
    }
    keep.push(b);
    a = b;
  }
  return keep;
}

function chordOk(xs, ys, a, b, tol) {
  const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
  const len = Math.hypot(dx, dy) || 1e-9;
  for (let k = a + 1; k < b; k++) {
    if (Math.abs((xs[k] - xs[a]) * dy - (ys[k] - ys[a]) * dx) / len > tol) return false;
  }
  return true;
}
