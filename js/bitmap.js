// Bitmap preprocessing: RGBA -> grayscale -> optional invert/blur -> binary mask.
// A mask is Uint8Array(w*h), 1 = foreground (traced), 0 = background.

export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    // composite over white so transparent areas become background
    const r = rgba[p] * a + 255 * (1 - a);
    const gg = rgba[p + 1] * a + 255 * (1 - a);
    const b = rgba[p + 2] * a + 255 * (1 - a);
    g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
  }
  return g;
}

// Separable gaussian blur, radius in px (sigma = radius/2 approx). Returns new array.
export function gaussianBlur(src, w, h, radius) {
  if (!(radius > 0)) return src;
  const sigma = radius / 2;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i; xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
        acc += src[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

export function histogram(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, Math.round(gray[i])))]++;
  return hist;
}

// Otsu's method: returns threshold t where pixels < t are foreground (dark ink).
export function otsuThreshold(hist, total) {
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t + 1; } // bins 0..t are dark: gray < t+1
  }
  return thr;
}

// Build binary mask. A pixel is foreground when gray < threshold (dark ink on light paper),
// unless invert is set, in which case foreground is gray >= threshold.
export function thresholdMask(gray, threshold, invert) {
  const n = gray.length;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dark = gray[i] < threshold;
    mask[i] = (dark !== invert) ? 1 : 0;
  }
  return mask;
}
