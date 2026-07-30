/**
 * Pure image comparison for `verify-build --compare` — the build-side sister
 * of `verify` (which screenshots the FIGMA side). The agent screenshots its
 * build; this module diffs it against the design render and reports WHERE
 * they differ, in design-pixel coordinates, so a finding is actionable
 * ("region y:1800-2100 differs" → the section built wrong), not a bare
 * percentage.
 *
 * No imports, no I/O: images are plain { width, height, data } objects with
 * RGBA bytes (the shape gradient-extractor's loadImage() returns), so every
 * rule is unit-testable with hand-built arrays — repo convention.
 *
 * Algorithm choices (v1, documented limits):
 * - Euclidean RGB distance with a threshold, not perceptual YIQ: consistent
 *   with the existing rgbDist convention; the region clustering absorbs
 *   antialiasing/font-rendering noise that per-pixel metrics amplify.
 * - Only DOWNSCALE to a common width, never upscale: upscaling invents
 *   pixels and inflates the diff.
 * - A height mismatch is its own FINDING (build too tall/short), not diff
 *   noise: the diff runs over the overlapping rows only. Known limit: one
 *   inserted block shifts everything below it and reddens the rest — the
 *   height finding plus the caller's guidance line carry that case.
 */

/** Composite RGBA onto white (alpha → 255). Figma exports carry alpha;
 * browser screenshots do not — without flattening, transparent design
 * pixels diff against the build's white background. */
export function flattenAlpha(img) {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}

/** Bilinear RGBA resample to targetW × targetH. */
export function scaleImage(img, targetW, targetH) {
  const { width, height, data } = img;
  targetW = Math.max(1, Math.round(targetW));
  targetH = Math.max(1, Math.round(targetH));
  if (targetW === width && targetH === height) return img;
  const out = new Uint8Array(targetW * targetH * 4);
  const xr = width / targetW;
  const yr = height / targetH;
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(height - 1, (y + 0.5) * yr - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(width - 1, (x + 0.5) * xr - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const o = (y * targetW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = data[(y0 * width + x0) * 4 + c];
        const p10 = data[(y0 * width + x1) * 4 + c];
        const p01 = data[(y1 * width + x0) * 4 + c];
        const p11 = data[(y1 * width + x1) * 4 + c];
        out[o + c] = Math.round(
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy)
          + p01 * (1 - fx) * fy + p11 * fx * fy,
        );
      }
    }
  }
  return { width: targetW, height: targetH, data: out };
}

/**
 * Diff a design render against a build screenshot.
 *
 * @param {{width,height,data}} design - RGBA, design-side render
 * @param {{width,height,data}} build - RGBA, build-side screenshot
 * @param {object} [opts]
 * @param {number} [opts.threshold=25] - euclidean RGB distance above which a pixel counts as different (0–441)
 * @param {number} [opts.cellSize=32] - region-clustering grid cell edge, in compare-space px
 * @param {number} [opts.maxWidth=2000] - cap on the comparison width (downscale only)
 * @param {number} [opts.minRegionPct=15] - a grid cell is "hot" above this differing-pixel share
 * @param {number} [opts.maxRegions=5] - report at most this many regions, worst first
 * @returns {{
 *   diffPct: number,                    // % differing pixels over the compared area
 *   compare: {width: number, height: number}, // comparison-space dimensions
 *   designScale: number,                // compare px → design px: divide by this
 *   heightMismatch: null | {designH: number, buildH: number, deltaPct: number, direction: 'taller'|'shorter'},
 *   regions: Array<{x0,y0,x1,y1,diffPct}>, // DESIGN-pixel coords, worst first
 *   diffImage: {width,height,data},     // dimmed grayscale design + red differing px
 * }}
 */
export function diffImages(design, build, opts = {}) {
  const {
    threshold = 25, cellSize = 32, maxWidth = 2000,
    minRegionPct = 15, maxRegions = 5,
  } = opts;
  const d0 = flattenAlpha(design);
  const b0 = flattenAlpha(build);

  // Common width: never upscale, cap the work for huge frames.
  const W = Math.min(d0.width, b0.width, maxWidth);
  const d = scaleImage(d0, W, Math.round(d0.height * (W / d0.width)));
  const b = scaleImage(b0, W, Math.round(b0.height * (W / b0.width)));

  // Height mismatch in NORMALIZED space (same width ⇒ heights are
  // comparable): >1% is a structural finding of its own.
  let heightMismatch = null;
  const deltaPct = ((b.height - d.height) / d.height) * 100;
  if (Math.abs(deltaPct) > 1) {
    heightMismatch = {
      designH: d.height, buildH: b.height,
      deltaPct: Math.round(Math.abs(deltaPct) * 10) / 10,
      direction: deltaPct > 0 ? 'taller' : 'shorter',
    };
  }
  const H = Math.min(d.height, b.height);

  // Per-pixel pass + grid accumulation in one sweep.
  const cols = Math.ceil(W / cellSize);
  const rows = Math.ceil(H / cellSize);
  const cellDiff = new Uint32Array(cols * rows);
  const cellTotal = new Uint32Array(cols * rows);
  const diffData = new Uint8Array(W * H * 4);
  const thresholdSq = threshold * threshold;
  let differing = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dr = d.data[i], dg = d.data[i + 1], db_ = d.data[i + 2];
      const rr = dr - b.data[i], rg = dg - b.data[i + 1], rb = db_ - b.data[i + 2];
      const distSq = rr * rr + rg * rg + rb * rb;
      const cell = Math.floor(y / cellSize) * cols + Math.floor(x / cellSize);
      cellTotal[cell]++;
      // Diff image base: dimmed grayscale design (context without competing
      // with the highlight).
      const gray = Math.round((dr * 0.299 + dg * 0.587 + db_ * 0.114) * 0.3);
      if (distSq > thresholdSq) {
        differing++;
        cellDiff[cell]++;
        diffData[i] = 255; diffData[i + 1] = 40; diffData[i + 2] = 40;
      } else {
        diffData[i] = gray; diffData[i + 1] = gray; diffData[i + 2] = gray;
      }
      diffData[i + 3] = 255;
    }
  }
  const diffPct = H > 0 ? Math.round((differing / (W * H)) * 1000) / 10 : 0;

  // Hot cells → 4-connected merge → bounding boxes, worst first.
  const hot = new Uint8Array(cols * rows);
  for (let c = 0; c < hot.length; c++) {
    if (cellTotal[c] && (cellDiff[c] / cellTotal[c]) * 100 >= minRegionPct) hot[c] = 1;
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    // BFS over the 4-neighborhood of hot cells.
    const queue = [start];
    seen[start] = 1;
    let minC = cols, maxC = -1, minR = rows, maxR = -1, diffPx = 0, totPx = 0;
    while (queue.length) {
      const cell = queue.pop();
      const r = Math.floor(cell / cols), c = cell % cols;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      diffPx += cellDiff[cell]; totPx += cellTotal[cell];
      for (const n of [cell - cols, cell + cols, c > 0 ? cell - 1 : -1, c < cols - 1 ? cell + 1 : -1]) {
        if (n >= 0 && n < hot.length && hot[n] && !seen[n]) { seen[n] = 1; queue.push(n); }
      }
    }
    boxes.push({
      x0: minC * cellSize, y0: minR * cellSize,
      x1: Math.min(W, (maxC + 1) * cellSize), y1: Math.min(H, (maxR + 1) * cellSize),
      diffPct: totPx ? Math.round((diffPx / totPx) * 1000) / 10 : 0,
      pixels: diffPx,
    });
  }
  boxes.sort((a, b2) => b2.pixels - a.pixels);

  // Map compare-space boxes back to DESIGN pixels — the coordinate system the
  // spec and assets.json speak.
  const designScale = W / d0.width; // design px * designScale = compare px
  const toDesign = (v) => Math.round(v / designScale);
  const regions = boxes.slice(0, maxRegions).map((r) => ({
    x0: toDesign(r.x0), y0: toDesign(r.y0), x1: toDesign(r.x1), y1: toDesign(r.y1),
    diffPct: r.diffPct,
  }));

  return {
    diffPct,
    compare: { width: W, height: H },
    designScale,
    heightMismatch,
    regions,
    diffImage: { width: W, height: H, data: diffData },
  };
}

/** Human-readable region lines (design-pixel coordinates). */
export function describeRegions(result) {
  return result.regions.map((r) =>
    `x:${r.x0}-${r.x1} y:${r.y0}-${r.y1} — ${r.diffPct}% of the area differs`);
}
