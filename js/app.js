// UI controller: loads images, drives the tracer (worker, with main-thread fallback), renders previews.
import { thresholdMask, histogram, otsuThreshold, toGray, gaussianBlur } from "./bitmap.js";
import { t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const els = {
  file: $("file"), btnSvg: $("btnSvg"), btnCopy: $("btnCopy"), btnClear: $("btnClear"), reset: $("reset"),
  view: $("view"), showPath: $("showPath"), showPoints: $("showPoints"), fade: $("fade"),
  invert: $("invert"), blur: $("blur"), threshold: $("threshold"), thrOut: $("thrOut"),
  histCanvas: $("histCanvas"), colours: $("colours"), colourOutput: $("colourOutput"), removeBg: $("removeBg"), palette: $("palette"),
  turd: $("turd"), alpha: $("alpha"), opt: $("opt"), maxSide: $("maxSide"),
  status: $("status"), viewport: $("viewport"), imgOriginal: $("imgOriginal"),
  canvasProcessed: $("canvasProcessed"), svgHost: $("svgHost"), dropHint: $("dropHint"), meta: $("meta"),
};

// Default value of every setting control. Threshold has no fixed default: it is automatic
// (Otsu) per image until the user moves the slider.
const DEFAULTS = {
  view: "traced", showPath: true, showPoints: true, fade: false,
  invert: false, blur: 0, turd: 2, alpha: 1, opt: 0.2, colours: 8, maxSide: "2048",
  colourOutput: "shapes", removeBg: false,
};
const CHECKS = ["showPath", "showPoints", "fade", "invert", "removeBg"];
const NUMBERS = ["blur", "turd", "alpha", "opt", "colours"];

const state = {
  mode: "bw",
  src: null,          // { rgba, w, h, url }
  gray: null,         // blurred grayscale (Float32Array)
  grayVersion: 0,
  otsu: 128,
  hist: null,
  result: null,       // last traced { svg, nodes }
  seq: 0,             // request sequence for stale-result protection
  timer: null,
  busy: false,
};

// ---------- worker plumbing (falls back to main thread if workers are unavailable) ----------
let worker = null;
let pending = new Map();
let nextId = 1;
let localApi = null;

function initWorker() {
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const entry = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (entry) entry.resolve(e.data);
    };
    worker.onerror = () => {
      // worker died (e.g. blocked script): re-run everything in flight on the main thread
      worker = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        runLocal(entry.type, entry.payload).then(entry.resolve, (err) => entry.resolve({ ok: false, error: String(err) }));
      }
    };
  } catch (_) { worker = null; }
}

async function loadLocal() {
  if (!localApi) {
    const [trace, colour] = await Promise.all([import("./trace.js"), import("./colour.js")]);
    localApi = { trace, colour };
  }
  return localApi;
}

function call(type, payload, transfer = []) {
  if (worker) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve, type, payload });
      worker.postMessage({ id, type, ...payload }, transfer);
    });
  }
  return runLocal(type, payload).catch((err) => ({ ok: false, error: String(err) }));
}

async function runLocal(type, p) {
  const { trace, colour } = await loadLocal();
  const { svgDocument } = trace;
  if (type === "prepare") {
    const g = trace.prepareGray(p.rgba, p.w, p.h, p.opts.blur || 0);
    const hist = histogram(g);
    return { ok: true, gray: g, otsu: otsuThreshold(hist, g.length), hist };
  }
  if (type === "trace-bw") {
    const r = trace.traceBlackWhite(p.gray, p.w, p.h, p.opts);
    return { ok: true, svg: svgDocument(p.w, p.h, r.paths), nodes: r.nodes, threshold: r.threshold, shapes: r.shapes, timings: r.timings };
  }
  if (type === "trace-colour") {
    const r = colour.traceColour(p.rgba, p.w, p.h, p.opts.colours || 8, p.opts);
    return { ok: true, svg: svgDocument(p.w, p.h, r.paths), palette: r.palette, nodes: r.nodes, shapes: r.shapes, timings: r.timings };
  }
  return { ok: false, error: "unknown " + type };
}

// ---------- image loading ----------
// Reads a decimal that may use a comma ("0,2") or a dot ("0.2"); invalid input falls back to 0.
function num(el) { const v = parseFloat(String(el.value).replace(",", ".")); return Number.isFinite(v) ? v : 0; }

function maxSideValue() { return parseInt(els.maxSide.value, 10) || 0; }

// Hard cap on working pixels so "Full resolution" cannot exhaust memory (~36 MP = ~144 MB RGBA).
const MAX_WORK_PIXELS = 36e6;
let loadToken = 0; // newest load wins; older loads that finish late are discarded

async function loadFile(file) {
  const token = ++loadToken;
  if (!file) return;
  const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml";
  if (!isImage) { setStatus(t("Unsupported file. Use PNG, JPEG, WebP, GIF or BMP.")); return; }
  setStatus(t("Loading {name} …", { name: file.name }));
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (err) {
    if (token === loadToken) setStatus(t("Could not decode {name} (file may be corrupt).", { name: file.name }));
    return;
  }
  if (token !== loadToken) { bmp.close?.(); return; }
  const sw = bmp.width, sh = bmp.height; // read before close(), which zeroes ImageBitmap sizes
  const limit = maxSideValue();
  let scale = limit && Math.max(sw, sh) > limit ? limit / Math.max(sw, sh) : 1;
  if (sw * sh * scale * scale > MAX_WORK_PIXELS) scale = Math.sqrt(MAX_WORK_PIXELS / (sw * sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) { bmp.close?.(); setStatus(t("This browser cannot read pixels for {name}.", { name: file.name })); return; }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  if (state.src && state.src.url) URL.revokeObjectURL(state.src.url);
  state.src = { rgba, w, h, url: URL.createObjectURL(file), name: file.name, srcW: sw, srcH: sh };
  state.userThreshold = false; // a new image gets an automatic (Otsu) threshold
  updateResetState();
  els.imgOriginal.src = state.src.url;
  els.dropHint.hidden = true;
  els.btnClear.hidden = false;
  await refreshGray();
  if (token !== loadToken) return;
  scheduleTrace(0);
}

async function refreshGray() {
  const src = state.src;
  if (!src) return;
  const r = await call("prepare", { rgba: src.rgba, w: src.w, h: src.h, opts: { blur: num(els.blur) } });
  if (state.src !== src) return; // image was removed or replaced while this ran
  state.gray = r.gray;
  state.otsu = r.otsu;
  state.hist = r.hist;
  if (!state.userThreshold) { els.threshold.value = r.otsu; }
  els.thrOut.textContent = els.threshold.value;
  drawHistogram();
}

// ---------- tracing ----------
function traceOptions() {
  return {
    threshold: parseInt(els.threshold.value, 10),
    invert: els.invert.checked,
    turdsize: num(els.turd),
    alphamax: num(els.alpha),
    opttolerance: num(els.opt),
    colours: Math.min(32, Math.max(2, parseInt(els.colours.value, 10) || 8)),
    output: els.colourOutput.value,
    removeBackground: els.removeBg.checked,
  };
}

function scheduleTrace(delay = 120) {
  clearTimeout(state.timer);
  state.timer = setTimeout(runTrace, delay);
}

async function runTrace() {
  if (!state.src) return;
  const seq = ++state.seq;
  const o = traceOptions();
  const { w, h, rgba } = state.src;
  setStatus(t("Tracing…"));
  let r;
  const t0 = performance.now();
  if (state.mode === "bw") {
    if (!state.gray) await refreshGray();
    r = await call("trace-bw", { w, h, gray: state.gray, opts: o });
  } else {
    r = await call("trace-colour", { w, h, rgba, opts: o });
  }
  if (seq !== state.seq) return; // a newer request superseded this one
  if (!r.ok) { setStatus(t("Error: {error}", { error: r.error })); return; }
  state.result = r;
  renderTraced();
  renderProcessed();
  renderPalette(r.palette);
  const ms = (performance.now() - t0).toFixed(0);
  els.btnSvg.disabled = false;
  els.btnCopy.disabled = false;
  const kb = (r.svg.length / 1024).toFixed(1);
  els.meta.textContent = `${w}×${h} px (${t("source")} ${state.src.srcW}×${state.src.srcH}) · ${ms} ms · ${kb} ${t("KB SVG")} · ${r.shapes != null ? `${r.shapes} ${state.mode === "colour" && els.colourOutput.value === "stacked" ? t("layers") : t("shapes")} · ` : ""}${nodeCount(r)} ${t("nodes")}`;
  setStatus(t("Ready"));
}

// ---------- rendering ----------
function nodeCount(r) { return typeof r.nodes === "number" ? r.nodes : (r.nodes ? r.nodes.length / 2 : 0); }

function renderTraced() {
  const r = state.result;
  if (!r) return;
  const { w, h } = state.src;
  const svgNS = "http://www.w3.org/2000/svg";
  const host = els.svgHost;
  host.innerHTML = r.svg.replace("<svg ", `<svg class="traced" preserveAspectRatio="xMidYMid meet" `);
  const svg = host.querySelector("svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  if (els.showPath.checked) {
    svg.querySelectorAll("path").forEach((p) => {
      p.setAttribute("stroke", "#e11d48");
      p.setAttribute("stroke-width", String(Math.max(0.5, w / 800)));
    });
  }
  if (els.showPoints.checked && r.nodes && r.nodes.length) {
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("fill", "#0ea5e9");
    const n = r.nodes.length / 2;
    const step = Math.max(1, Math.ceil(n / 6000));
    const rad = Math.max(0.6, w / 500);
    for (let i = 0; i < n; i += step) {
      const c = document.createElementNS(svgNS, "circle");
      c.setAttribute("cx", r.nodes[2 * i]);
      c.setAttribute("cy", r.nodes[2 * i + 1]);
      c.setAttribute("r", rad);
      g.appendChild(c);
    }
    svg.appendChild(g);
  }
  host.hidden = false;
  applyView();
}

function renderProcessed() {
  const s = state.src;
  if (!s || state.mode !== "bw" || !state.gray) return;
  const cv = els.canvasProcessed;
  cv.width = s.w; cv.height = s.h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(s.w, s.h);
  const t = parseInt(els.threshold.value, 10);
  const mask = thresholdMask(state.gray, t, els.invert.checked);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const v = mask[i] ? 0 : 255;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function applyView() {
  const v = els.view.value;
  els.imgOriginal.hidden = v !== "original";
  els.canvasProcessed.hidden = v !== "processed";
  els.svgHost.hidden = v !== "traced";
  const fading = els.fade.checked && v === "traced";
  if (fading) els.imgOriginal.hidden = false;
  els.imgOriginal.classList.toggle("faded", fading);
  if (state.src && state.mode === "colour" && v === "processed") els.canvasProcessed.hidden = true;
  if (v === "processed" && state.mode === "colour") { els.imgOriginal.hidden = false; }
}

function renderPalette(palette) {
  els.palette.innerHTML = "";
  if (!palette) return;
  palette.forEach((c) => {
    const s = document.createElement("span");
    s.className = "swatch"; s.style.background = c; s.title = c;
    els.palette.appendChild(s);
  });
}

function drawHistogram() {
  const cv = els.histCanvas, ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!state.hist) return;
  let max = 1;
  for (let i = 0; i < 256; i++) max = Math.max(max, state.hist[i]);
  ctx.fillStyle = "#c9c5bc";
  for (let i = 0; i < 256; i++) {
    const hgt = Math.sqrt(state.hist[i] / max) * cv.height;
    ctx.fillRect(i * 2, cv.height - hgt, 2, hgt);
  }
  const x = parseInt(els.threshold.value, 10) * 2;
  ctx.fillStyle = "#171717";
  ctx.fillRect(x, 0, 2, cv.height);
}

function setStatus(t) { els.status.textContent = t; }

// ---------- events ----------
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll(".bw-only").forEach((e) => (e.hidden = mode !== "bw"));
  document.querySelectorAll(".colour-only").forEach((e) => (e.hidden = mode !== "colour"));
  if (mode === "colour" && els.view.value === "processed") els.view.value = "traced";
  scheduleTrace(0);
}

document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
els.file.addEventListener("change", (e) => loadFile(e.target.files[0]));
els.view.addEventListener("change", applyView);
[els.showPath, els.showPoints].forEach((el) => el.addEventListener("change", () => state.result && renderTraced()));
els.fade.addEventListener("change", applyView);
els.invert.addEventListener("change", () => { renderProcessed(); scheduleTrace(0); });
els.blur.addEventListener("change", async () => { await refreshGray(); scheduleTrace(0); });
els.threshold.addEventListener("input", () => {
  state.userThreshold = true;
  els.thrOut.textContent = els.threshold.value;
  drawHistogram();
  renderProcessed();
  scheduleTrace(150);
});
[els.turd, els.alpha, els.opt, els.colours].forEach((el) => el.addEventListener("input", () => scheduleTrace(150)));
[els.colourOutput, els.removeBg].forEach((el) => el.addEventListener("change", () => scheduleTrace(0)));
els.maxSide.addEventListener("change", async () => {
  if (!state.src) return;
  const f = state.srcFile; // reload at new working size if we still have the original bitmap
  if (f) loadFile(f);
});

// True when every setting matches its default (numbers compared by value, so "0,2" == 0.2).
function settingsAreDefault() {
  if (state.userThreshold) return false;
  if (els.view.value !== DEFAULTS.view || els.maxSide.value !== DEFAULTS.maxSide) return false;
  if (els.colourOutput.value !== DEFAULTS.colourOutput) return false;
  if (CHECKS.some((k) => els[k].checked !== DEFAULTS[k])) return false;
  return NUMBERS.every((k) => num(els[k]) === DEFAULTS[k]);
}

function updateResetState() {
  const clean = settingsAreDefault();
  els.reset.disabled = clean;
  els.reset.title = clean ? t("Settings are at their defaults") : t("Restore every setting to its default");
}

els.reset.addEventListener("click", async () => {
  const sizeChanged = els.maxSide.value !== DEFAULTS.maxSide;
  els.view.value = DEFAULTS.view;
  els.maxSide.value = DEFAULTS.maxSide;
  els.colourOutput.value = DEFAULTS.colourOutput;
  for (const k of CHECKS) els[k].checked = DEFAULTS[k];
  for (const k of NUMBERS) els[k].value = DEFAULTS[k];
  state.userThreshold = false;
  updateResetState();
  setStatus(t("Settings restored to defaults"));
  if (!state.src) return;
  if (sizeChanged && state.srcFile) { loadFile(state.srcFile); return; } // re-read at default working size
  renderTraced();                // overlays (path / points) may have changed
  applyView();
  await refreshGray();           // blur and automatic threshold
  renderProcessed();
  scheduleTrace(0);
});

// any edit to a setting re-evaluates whether the restore button is needed
document.querySelector(".panel").addEventListener("input", updateResetState);
document.querySelector(".panel").addEventListener("change", updateResetState);

els.btnSvg.addEventListener("click", () => {
  if (!state.result) return;
  const blob = new Blob([state.result.svg], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.src?.name || "traced").replace(/\.[^.]+$/, "") + ".svg";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
els.btnCopy.addEventListener("click", async () => {
  if (!state.result) return;
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(state.result.svg);
    setStatus(t("SVG copied to clipboard"));
  } catch (_) {
    // non-secure origins (e.g. http://LAN-IP) have no async clipboard API: offer a download instead
    setStatus(t("Clipboard blocked here. Use Download SVG instead."));
  }
});

// drag & drop and paste
// clicking (or Enter/Space on) the drop zone opens the file picker
els.dropHint.addEventListener("click", () => els.file.click());
els.dropHint.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); }
});
// clear the input after each pick so choosing the same file again still triggers a load
els.file.addEventListener("click", () => { els.file.value = ""; });

window.addEventListener("dragover", (e) => { e.preventDefault(); els.dropHint.hidden = false; });
window.addEventListener("dragleave", () => { if (state.src) els.dropHint.hidden = true; });
window.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
// Paste an image with Ctrl+V / Cmd+V. The paste event covers copied images and copied image files;
// browsers that skip it when nothing editable has focus (Safari) fall back to the async Clipboard API.
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const isEditable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
let pasteHandled = false;
function imageFromClipboard(data) {
  const files = [...(data?.files || [])];
  const items = [...(data?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
  return [...files, ...items].find((f) => f.type.startsWith("image/") ? f.type !== "image/svg+xml" : IMAGE_EXT.test(f.name || ""));
}
window.addEventListener("paste", (e) => {
  const f = imageFromClipboard(e.clipboardData);
  if (!f) return;
  pasteHandled = true;
  e.preventDefault();
  openFile(f);
});
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "v" || e.shiftKey || e.altKey || isEditable(e.target)) return;
  pasteHandled = false;
  setTimeout(async () => {
    if (pasteHandled || !navigator.clipboard?.read) return;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/") && t !== "image/svg+xml");
        if (!type) continue;
        const blob = await item.getType(type);
        openFile(new File([blob], "pasted-image." + (type.split("/")[1] || "png"), { type }));
        return;
      }
    } catch (_) { /* no permission or no image on the clipboard */ }
  }, 120);
});

// Removes the current image and everything derived from it; tracing settings are kept.
const START_STATUS = els.status.textContent;
function clearImage() {
  loadToken++;            // a load still decoding is discarded when it finishes
  state.seq++;            // a trace still running in the worker is ignored when it returns
  clearTimeout(state.timer);
  if (state.src && state.src.url) URL.revokeObjectURL(state.src.url);
  Object.assign(state, { src: null, srcFile: null, gray: null, hist: null, result: null, userThreshold: false });
  els.imgOriginal.removeAttribute("src");
  els.imgOriginal.hidden = true;
  els.canvasProcessed.hidden = true;
  els.canvasProcessed.width = els.canvasProcessed.height = 0;
  els.svgHost.innerHTML = "";
  els.svgHost.hidden = true;
  els.file.value = "";
  els.palette.innerHTML = "";
  els.meta.textContent = "";
  els.btnSvg.disabled = true;
  els.btnCopy.disabled = true;
  els.btnClear.hidden = true;
  els.dropHint.hidden = false;
  drawHistogram();
  updateResetState();
  setStatus(START_STATUS);
}
els.btnClear.addEventListener("click", clearImage);
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.src) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return; // Esc in a field shouldn't wipe the image
  clearImage();
});

function openFile(f) { state.srcFile = f; loadFile(f); }
els.file.addEventListener("change", (e) => { if (e.target.files[0]) state.srcFile = e.target.files[0]; });


initWorker();
setMode("bw");
openHandoff();

// An image dropped into a mini converter on a guide page arrives here (same tab, same origin)
// so it opens straight in the editor. Nothing leaves the browser.
function openHandoff() {
  let h = null;
  try {
    h = JSON.parse(sessionStorage.getItem("imageTracer.handoff") || "null");
    sessionStorage.removeItem("imageTracer.handoff");
  } catch (_) { return; }
  if (!h || typeof h.data !== "string" || !h.data.startsWith("data:image/")) return;
  if (h.mode === "colour") {
    if (h.colours) els.colours.value = Math.min(32, Math.max(2, parseInt(h.colours, 10) || 8));
    setMode("colour");
  }
  fetch(h.data).then((r) => r.blob()).then((b) => openFile(new File([b], h.name || "image.png", { type: b.type }))).catch(() => {});
}
