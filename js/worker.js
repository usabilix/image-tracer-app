// Web Worker: runs the tracer off the main thread so the UI stays responsive.
import { prepareGray, traceBlackWhite, svgDocument } from "./trace.js";
import { traceColour } from "./colour.js";
import { thresholdMask, histogram, otsuThreshold } from "./bitmap.js";

self.onmessage = (e) => {
  const { id, type, w, h, rgba, gray, opts } = e.data;
  try {
    if (type === "prepare") {
      // blur + grayscale; returns the gray buffer used by later traces
      const g = prepareGray(rgba, w, h, opts.blur || 0);
      const hist = histogram(g);
      const otsu = otsuThreshold(hist, g.length);
      self.postMessage({ id, ok: true, gray: g, otsu, hist }, [g.buffer]);
      return;
    }
    if (type === "trace-bw") {
      const r = traceBlackWhite(gray, w, h, opts);
      const svg = svgDocument(w, h, r.paths, { fill: "#000" });
      self.postMessage({ id, ok: true, d: r.d, svg, nodes: r.nodes, threshold: r.threshold, loops: r.loops, shapes: r.shapes, timings: r.timings }, [r.nodes.buffer]);
      return;
    }
    if (type === "mask") {
      const mask = thresholdMask(gray, opts.threshold, opts.invert);
      self.postMessage({ id, ok: true, mask }, [mask.buffer]);
      return;
    }
    if (type === "trace-colour") {
      const r = traceColour(rgba, w, h, opts.colours || 8, opts);
      const svg = svgDocument(w, h, r.paths);
      self.postMessage({ id, ok: true, svg, palette: r.palette, nodes: r.nodes, shapes: r.shapes, timings: r.timings }, [r.nodes.buffer]);
      return;
    }
    throw new Error("unknown message type " + type);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};
