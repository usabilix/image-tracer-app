// Boundary decomposition: binary mask -> closed loops on the pixel-corner lattice.
// Vertices live on the (w+1) x (h+1) lattice. Every directed edge keeps the
// foreground on its right-hand side (screen coordinates, y grows downward).
// Direction ids: 0 = +x (east), 1 = +y (south), 2 = -x (west), 3 = -y (north).

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

export function traceLoops(mask, w, h) {
  const W1 = w + 1;
  const V = W1 * (h + 1);
  // bit d set in out[v] => directed edge leaving vertex v in direction d exists
  const out = new Uint8Array(V);
  const fg = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!fg(x, y)) continue;
      if (!fg(x, y - 1)) out[y * W1 + x] |= 1 << 0;               // top edge, east
      if (!fg(x + 1, y)) out[y * W1 + (x + 1)] |= 1 << 1;         // right edge, south
      if (!fg(x, y + 1)) out[(y + 1) * W1 + (x + 1)] |= 1 << 2;   // bottom edge, west
      if (!fg(x - 1, y)) out[(y + 1) * W1 + x] |= 1 << 3;         // left edge, north
    }
  }

  const loops = [];
  for (let start = 0; start < V; start++) {
    while (out[start]) {
      // pick an arbitrary outgoing edge to begin a loop
      let d = 0;
      while (!(out[start] & (1 << d))) d++;
      const pts = [];
      let v = start;
      let dir = d;
      for (;;) {
        pts.push(v % W1, (v / W1) | 0);
        out[v] &= ~(1 << dir);
        const x = v % W1 + DX[dir];
        const y = ((v / W1) | 0) + DY[dir];
        v = y * W1 + x;
        // choose next direction: prefer right turn, then straight, then left turn
        let next = -1;
        if (out[v] & (1 << ((dir + 1) & 3))) next = (dir + 1) & 3;
        else if (out[v] & (1 << dir)) next = dir;
        else if (out[v] & (1 << ((dir + 3) & 3))) next = (dir + 3) & 3;
        if (next < 0) break; // boundary closed
        dir = next;
      }
      loops.push(pts);
    }
  }
  return loops;
}

// Signed area (shoelace) of a loop given as flat [x0,y0,x1,y1,...]. Outer boundaries
// are clockwise on screen (positive here), holes are negative.
export function loopArea(pts) {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return a / 2;
}

// 4-connected component labels of the foreground (0 = background, 1..n = component id).
// traceLoops separates foreground pixels that only touch diagonally, so each label
// owns exactly one outer loop plus the loops of its own holes.
export function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (mask[s] !== 1 || labels[s]) continue;
    n++;
    let top = 0;
    stack[top++] = s; labels[s] = n;
    while (top) {
      const p = stack[--top];
      const x = p % w;
      if (x > 0 && mask[p - 1] === 1 && !labels[p - 1]) { labels[p - 1] = n; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] === 1 && !labels[p + 1]) { labels[p + 1] = n; stack[top++] = p + 1; }
      if (p >= w && mask[p - w] === 1 && !labels[p - w]) { labels[p - w] = n; stack[top++] = p - w; }
      if (p < w * (h - 1) && mask[p + w] === 1 && !labels[p + w]) { labels[p + w] = n; stack[top++] = p + w; }
    }
  }
  return { labels, count: n };
}

// Index of the foreground pixel on the right-hand side of a loop's first edge.
export function loopPixel(loop, w) {
  const x0 = loop[0], y0 = loop[1], x1 = loop[2], y1 = loop[3];
  if (x1 > x0) return y0 * w + x0;            // east: top edge of pixel (x, y)
  if (y1 > y0) return y0 * w + (x0 - 1);      // south: right edge of pixel (x-1, y)
  if (x1 < x0) return (y0 - 1) * w + (x0 - 1); // west: bottom edge of pixel (x-1, y-1)
  return (y0 - 1) * w + x0;                    // north: left edge of pixel (x, y-1)
}
