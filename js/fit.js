// Path fitting: pixel-corner loop -> simplified polygon -> smooth cubic bezier path.
// Parameters (mirroring the UI):
//   tol      : curve optimisation tolerance (max deviation in px of a polygon edge
//              from the traced boundary). Larger = fewer nodes.
//   alphamax : smoothness, 0 (all corners, polygonal) .. 1.34 (very smooth).

const TWO_PI = Math.PI * 2;

// Greedy furthest-reach simplification of a closed loop of lattice corners.
// Returns the indices of retained vertices (into the loop).
export function simplifyLoop(xs, ys, tol, maxSpan = 96) {
  const n = xs.length;
  if (n <= 4) return Array.from({ length: n }, (_, i) => i);

  // Start at the corner with the strongest turn so corners are never cut.
  let start = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n, q = (i + 1) % n;
    const ax = xs[i] - xs[p], ay = ys[i] - ys[p];
    const bx = xs[q] - xs[i], by = ys[q] - ys[i];
    const turn = Math.abs(ax * by - ay * bx) / Math.max(1e-9, Math.hypot(ax, ay) * Math.hypot(bx, by));
    if (turn > best) { best = turn; start = i; }
  }

  const keep = [start];
  let a = start;
  for (let g = 0; g < n; g++) {
    // steps available before the walk would pass the start corner again
    const room = g === 0 ? n - 1 : (start - a + n) % n;
    let b = a;
    for (let step = 1; step <= Math.min(maxSpan, room); step++) {
      const c = (a + step) % n;
      if (!chordOk(xs, ys, a, c, n, tol)) break;
      b = c;
    }
    if (b === a) b = (a + 1) % n;
    if (b === start) break;
    keep.push(b);
    a = b;
  }
  return keep;
}

function chordOk(xs, ys, a, b, n, tol) {
  const ax = xs[a], ay = ys[a];
  const dx = xs[b] - ax, dy = ys[b] - ay;
  const len = Math.hypot(dx, dy) || 1e-9;
  for (let k = (a + 1) % n; k !== b; k = (k + 1) % n) {
    const d = Math.abs((xs[k] - ax) * dy - (ys[k] - ay) * dx) / len;
    if (d > tol) return false;
  }
  return true;
}

// Builds an SVG path "d" string for a closed loop of polygon vertices.
// Edges are rendered as cubic beziers between edge midpoints, with the polygon
// vertex as the control point; sharp turns (above the alphamax threshold) stay corners.
export function loopToPath(px, py, alphamax) {
  const n = px.length;
  if (n < 3) return "";
  // turn angle at each vertex
  const corner = new Uint8Array(n);
  const thresh = (alphamax / 1.34) * (Math.PI / 2);
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n, q = (i + 1) % n;
    const ax = px[i] - px[p], ay = py[i] - py[p];
    const bx = px[q] - px[i], by = py[q] - py[i];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) { corner[i] = 1; continue; }
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    corner[i] = ang > thresh ? 1 : 0;
  }

  // Coordinates are kept in integer hundredths of a pixel and written as RELATIVE
  // commands, which keeps the SVG compact without losing precision beyond 0.01 px.
  const H = (v) => Math.round(v * 100);
  const mx = (i) => (px[i] + px[(i + 1) % n]) / 2;
  const my = (i) => (py[i] + py[(i + 1) % n]) / 2;
  const fmt = (h) => (h / 100).toString(); // e.g. 50 -> "0.5", -250 -> "-2.5"

  let cx = H(mx(n - 1)), cy = H(my(n - 1));
  const start = `M${fmt(cx)} ${fmt(cy)}`;
  let body = "";
  let last = "";
  // A space is needed only between two positive numbers (a minus sign already separates).
  let endsWithNumber = false; // tracked instead of re-reading the growing string (that was O(n^2))
  const put = (tok) => {
    if (tok[0] !== "-" && endsWithNumber) body += " ";
    body += tok;
    endsWithNumber = true;
  };
  // emit one command; repeat the letter only when the command changes
  const emit = (letter, nums) => {
    if (letter !== last) { body += letter; last = letter; endsWithNumber = false; }
    for (const v of nums) put(fmt(v));
  };
  // SVG relative commands measure EVERY coordinate pair from the segment's start point.
  const seg = (letter, ...abs) => { // abs = absolute hundredths, pairs (x, y)
    const nums = [];
    for (let k = 0; k < abs.length; k += 2) nums.push(abs[k] - cx, abs[k + 1] - cy);
    emit(letter, nums);
    cx = abs[abs.length - 2]; cy = abs[abs.length - 1];
  };

  for (let i = 0; i < n; i++) {
    if (corner[i]) {
      // straight to the corner, then straight to the next midpoint
      seg("l", H(px[i]), H(py[i]));
      seg("l", H(mx(i)), H(my(i)));
    } else {
      // quadratic with the polygon vertex as control point
      seg("q", H(px[i]), H(py[i]), H(mx(i)), H(my(i)));
    }
  }
  return start + body + "z";
}

export { TWO_PI };
