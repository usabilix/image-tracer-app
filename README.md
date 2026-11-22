<p align="center">
  <img src="assets/logo.min.svg" alt="Image Tracer" height="32">
</p>

<p align="center">
  <b>Free, offline image to SVG tracer that runs entirely in your browser.</b><br>
  PNG, JPG, WebP, GIF or BMP in. A clean, editable SVG out.
</p>

<p align="center">
  <a href="https://image-tracer.app/app/">Open the app</a> ·
  <a href="https://image-tracer.app/">Website</a> ·
  <a href="https://image-tracer.app/docs/">Documentation</a>
</p>

---

Image Tracer turns raster images (pixels) into vector graphics (shapes). It finds the edges of every area of colour in a picture and redraws them as lines and curves, so the result stays sharp at any size and every shape can be edited, recoloured or cut.

This repository contains **only the app**: plain HTML, CSS and JavaScript modules, with no framework, no build step and no dependencies. Images are processed on your device and are never uploaded.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Using the app](#using-the-app)
- [Settings reference](#settings-reference)
- [What the SVG contains](#what-the-svg-contains)
- [How the tracer works](#how-the-tracer-works)
- [Project structure](#project-structure)
- [Tests](#tests)
- [Deploying](#deploying)
- [Browser support](#browser-support)
- [License](#license)

## Features

- **Two modes.** Black & white for one-colour artwork (logos, text, signatures, line art), and Colour for illustrations with 2 to 32 flat colours.
- **Every shape is its own path.** Visually separate shapes become separate `<path>` elements with real holes, so any part can be recoloured, moved or deleted.
- **Shapes that fit together.** In Colour mode, neighbouring shapes share the exact same boundary: no gaps, no overlaps.
- **Sharp corners, smooth curves.** Corners between straight edges are kept exact, anti-aliased corners are rebuilt, and curves are fitted with as few points as possible.
- **Live preview.** Every change re-traces automatically. Show the paths and anchor points, or fade the original image underneath.
- **Transparency kept.** Transparent areas stay empty in the SVG, and a solid backdrop can be removed in Colour mode.
- **Private and offline.** Tracing runs in a Web Worker in your browser tab. Nothing is sent anywhere, and the app keeps working offline once loaded.

## Quick start

The app is a static site. Because it uses ES modules and a Web Worker, it has to be served over HTTP (opening `index.html` from the file system will not work).

```bash
git clone https://github.com/usabilix/image-tracer-app.git
cd image-tracer-app
python3 serve.py 8000
```

Then open <http://localhost:8000>. `serve.py` is the standard Python file server with caching turned off, so your edits show up on a normal reload. Any static server works too, for example `npx serve` or `python3 -m http.server`.

## Using the app

1. **Open an image.** Click *Open image*, drop a file anywhere on the page, click the drop zone, or paste an image with <kbd>Ctrl</kbd>+<kbd>V</kbd> (<kbd>Cmd</kbd>+<kbd>V</kbd> on a Mac). Supported formats: PNG, JPEG, WebP, GIF and BMP. SVG files are not accepted, because they are already vectors.
2. **Pick a mode.** *Black & white* for one-colour artwork, *Colour* for anything with several flat colours.
3. **Adjust the settings.** The trace updates automatically after a short pause. The status line shows the image size, the time taken, the SVG size in KB and the number of shapes and nodes.
4. **Export.** *Download SVG* saves the file; *Copy SVG* puts the markup on the clipboard.

*Restore default settings* resets every control. <kbd>Esc</kbd> removes the current image.

## Settings reference

### Preview

| Setting | What it does |
| --- | --- |
| Mode | Show the *Original image*, the *Processed image* (the black and white mask that is traced) or the *Traced vector*. |
| Show path | Draw the outline of every traced shape. |
| Show points | Draw every anchor point. Useful to judge how heavy the file is. |
| Fade image | Show the original faintly under the vector, to compare edges. |

### Black & white mode

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| Invert image | Off | On / off | Trace the light parts instead of the dark ones (light artwork on a dark background). |
| Blur | 0 | 0 and up (px radius) | Gaussian blur before thresholding. Smooths paper texture, noise and JPEG artefacts. |
| Threshold | Automatic | 0 to 255 | Brightness that separates ink from background. Picked automatically per image (Otsu's method) until you move the slider; the histogram shows where it sits. Transparent pixels count as white. |

### Colour mode

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| Output | Separate shapes | Separate shapes / Stacked layers | *Separate shapes*: every region is its own path, shapes share exact boundaries and holes are real cut-outs. *Stacked layers*: one path per colour, stacked dark to light, each layer covering everything lighter than it. |
| Number of colours | 8 | 2 to 32 | How many flat colours the image is reduced to. Similar tones merge. |
| Remove background | Off | On / off | Leave out regions that touch the image border, giving a transparent background. |

### Tracing (both modes)

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| Ignore less than | 2 | 0 and up (px²) | Drop specks and islands smaller than this area. Raise it to clean up dust and noise. |
| Smoothness | 1 | 0 to 1.34 | How readily corners become curves. 0 keeps every corner (polygonal), 1.34 rounds almost everything. |
| Curve optimisation | 0.2 | 0 and up | How far a curve may deviate from the traced edge to save points. Higher values give fewer nodes and lighter files. |
| Max size (px) | 2048 | 1024 / 2048 / 4096 / Full resolution | Images larger than this are scaled down before tracing, which keeps tracing fast. |

## What the SVG contains

The output is a plain, standard SVG:

- one `<path>` per shape, with `fill` and `fill-rule="evenodd"`, so holes are real holes;
- path data made of straight lines and quadratic Bézier curves;
- `width`, `height` and `viewBox` equal to the traced pixel size;
- no background rectangle, no gradients, no strokes, no scripts and no editor-specific metadata.

It opens in browsers and in Figma, Adobe Illustrator, Inkscape, Affinity, Canva, Cricut Design Space, Silhouette Studio and laser software such as LightBurn.

What it does **not** do: there is no AI and no upscaling, the output is filled outlines (not centerlines or strokes), and the only export format is SVG.

## How the tracer works

The engine is a classic, deterministic tracer inspired by Potrace's approach. It is a separate implementation, not Potrace itself. The same image and settings always give the same result.

### Black & white mode (`js/trace.js`)

1. **Grayscale.** RGBA pixels are converted to luminance; transparent pixels are treated as white (`js/bitmap.js`).
2. **Pre-processing.** Optional invert and a separable Gaussian blur.
3. **Threshold.** Otsu's method picks the cut-off from the histogram, unless a manual threshold is set. The result is a binary mask.
4. **Boundary loops.** Every edge between foreground and background pixels is walked on the pixel-corner lattice, producing closed loops with the foreground always on the same side (`js/decompose.js`). Loops enclosing less than *Ignore less than* are dropped.
5. **Clean-up.** Staircase steps are smoothed, one-pixel jogs flattened, and corners that anti-aliasing blurred are snapped back to sharp corners.
6. **Simplification.** Each loop is reduced to a polygon whose edges stay within the *Curve optimisation* tolerance of the traced boundary (`js/fit.js`).
7. **Curve fitting.** Polygon vertices become either corners (kept as straight lines) or smooth quadratic Bézier curves, depending on the angle and the *Smoothness* setting.
8. **Shapes.** Outer loops and the holes inside them are grouped so every visually separate shape becomes its own path.

### Colour mode (`js/colour.js`, `js/chains.js`)

1. **Quantisation.** Colours are reduced with k-means in RGB, with a deterministic start (centres spread evenly over the brightness-sorted sample).
2. **Palette clean-up.** Anti-aliased blends between two colours are absorbed, thin fringes merged, the palette refined and reduced to the requested number of colours, and specks below *Ignore less than* merged into their neighbours.
3. **Separate shapes.** Every boundary between two regions is traced **once**, as a chain between junctions (points where three or more regions meet). Each chain is smoothed and fitted once, and both neighbouring shapes reuse that exact geometry, one of them reversed. Shapes therefore fit together with no gaps and no overlaps.
4. **Stacked layers.** Alternatively, layer *k* covers every pixel whose colour is at least as light as colour *k*; layers are drawn dark to light.
5. **Remove background.** Regions touching the image border are left out.

### Threading

`js/app.js` sends the work to `js/worker.js`, a module Web Worker, so the interface stays responsive. If workers are unavailable, it falls back to tracing on the main thread.

## Project structure

```
index.html               The app.
css/style.css            All styles.
js/
  app.js                 Interface: loading images, settings, preview, export, paste and drag & drop.
  worker.js              Web Worker that runs the tracer off the main thread.
  bitmap.js              Grayscale, Gaussian blur, histogram, Otsu threshold, binary mask.
  decompose.js           Binary mask to closed boundary loops on the pixel-corner lattice.
  fit.js                 Loop simplification and curve fitting.
  trace.js               Black & white pipeline and SVG document output.
  colour.js              Colour quantisation and the colour pipeline.
  chains.js              Shared-boundary tracing for Colour mode's Separate shapes.
  i18n.js                Fills in placeholders in interface messages.
assets/                  Logo and icons.
test/                    Quick checks of the tracing engine (Node).
serve.py                 Local development server without caching.
```

## Tests

The tests use Node 18 or later and need no dependencies:

```bash
npm test
```

They trace synthetic images (a ring and a box in Black & white mode; two coloured shapes in Colour mode) and print the shapes, nodes and timings, so you can check the engine still produces the expected geometry after a change.

## Deploying

Copy the folder to any static host: GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket or your own server. No server-side code is needed. Serve `.js` files as `text/javascript`.

The arrow next to the logo links to the Image Tracer website; change its `href` in `index.html` if you host your own copy.

## Browser support

Any current version of Chrome, Edge, Firefox or Safari. The app needs JavaScript modules, module Web Workers and `createImageBitmap`. Pasting from the clipboard works through the browser's paste event; where a browser does not deliver it, the app reads the clipboard directly, which may show a permission prompt the first time.

## License

[MIT](LICENSE) © 2026 Usabilix. You are free to use, copy, modify and distribute the code, including commercially, as long as the copyright and licence notice are kept.
