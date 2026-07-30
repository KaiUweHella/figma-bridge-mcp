// Paint ↔ CSS conversion — the ONE source of truth for gradient angles.
//
// Figma's gradientTransform maps NORMALIZED object space (x/width, y/height,
// y pointing DOWN) into gradient space, where gradient-x runs 0→1 and the
// identity matrix renders left→right. Two conversions live here:
//
//  - reading (Figma → CSS): the gradient axis in PIXEL space is the gradient
//    of the mapping's first row, aspect-corrected: (t00/w, t01/h). CSS angles
//    are measured clockwise from "to top", so deg = atan2(dx, -dy).
//  - writing (CSS → Figma): the inverse — gx axis (sin θ, -cos θ) in
//    normalized y-down space, gy perpendicular, translated so the gradient
//    is centered in the box.
//
// History (Run-7 report, Rectangle 28): spec and inspect each had their own
// copy. The spec read atan2(t[1][0], t[0][0]) + 90 — the wrong matrix row and
// no Y-flip, so vertical gradients came out mirrored (180° read as 0°, 135°
// as 45°) — and inspect dropped the angle entirely (CSS default = 180°).
// The writers (gradient-extractor, jsx-render) had the matching mirrored
// matrix, so their round-trip "worked" while both were wrong vs. Figma.
//
// makePaintSerializer() is deliberately SELF-CONTAINED (no outer references):
// its source is embedded verbatim into plugin-sandbox evals via
// paintsSnippetJs, and called directly by Node-side tests — one
// implementation, two runtimes.

/** Build the paint-serialization helpers. Self-contained by design. */
export function makePaintSerializer() {
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  // Figma gradientTransform → CSS angle in degrees, aspect-corrected via the
  // node's w/h. null when the transform is missing or degenerate.
  const cssAngle = (t, w, h) => {
    if (!Array.isArray(t) || !Array.isArray(t[0])) return null;
    const dx = t[0][0] / (w > 0 ? w : 1);
    const dy = t[0][1] / (h > 0 ? h : 1);
    if (!dx && !dy) return null;
    return Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360) % 360;
  };
  // Paint array → compact css-ready strings ("#02153b@50",
  // "linear-gradient(135deg, #02153b 0%, #0e1425 50%)"). The angle is ALWAYS
  // emitted for linear gradients (180 when unreadable) — an omitted angle
  // silently means "to bottom" in CSS, which is exactly how the inspect path
  // used to lose it.
  const paints = (arr, w, h) => {
    if (!Array.isArray(arr)) return undefined;
    const out = [];
    for (const p of arr) {
      if (p.visible === false) continue;
      const op = p.opacity != null && p.opacity < 1 ? '@' + Math.round(p.opacity * 100) : '';
      if (p.type === 'SOLID') {
        out.push(hex(p.color) + op);
      } else if (String(p.type).indexOf('GRADIENT_') === 0 && Array.isArray(p.gradientStops)) {
        const kind = p.type === 'GRADIENT_LINEAR' ? 'linear'
          : p.type === 'GRADIENT_RADIAL' ? 'radial'
          : p.type === 'GRADIENT_ANGULAR' ? 'conic' : 'diamond';
        const stops = p.gradientStops.map((s) =>
          hex(s.color) + (s.color.a != null && s.color.a < 1 ? '@' + Math.round(s.color.a * 100) : '')
          + ' ' + Math.round(s.position * 100) + '%').join(', ');
        let head = '';
        if (p.type === 'GRADIENT_LINEAR') {
          const deg = cssAngle(p.gradientTransform, w, h);
          head = (deg == null ? 180 : deg) + 'deg, ';
        }
        out.push(kind + '-gradient(' + head + stops + ')' + op);
      } else {
        out.push(p.type);
      }
    }
    return out.length ? out : undefined;
  };
  return { hex, cssAngle, paints };
}

/**
 * Plugin-eval fragment defining `hex`, `cssAngle` and `paints` — embed this
 * where a sandbox snippet needs paint serialization (walker, inspect).
 */
export const paintsSnippetJs = `const { hex, cssAngle, paints } = (${makePaintSerializer.toString()})();`;

// Node-side handles for direct (non-sandbox) use and tests.
const __serializer = makePaintSerializer();
export const cssAngleFromGradientTransform = __serializer.cssAngle;
export const serializePaints = __serializer.paints;

/**
 * CSS angle (deg, clockwise from "to top") → Figma gradientTransform.
 * Pure rotation in normalized space, centered in the box; e.g. 180° yields
 * [[0, 1, 0], [-1, 0, 1]] (gx = ny — first stop at the top edge).
 */
export function gradientTransformFromCssAngle(deg) {
  const rad = (deg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  return [
    [sin, -cos, 0.5 - 0.5 * (sin - cos)],
    [cos, sin, 0.5 - 0.5 * (cos + sin)],
  ];
}
