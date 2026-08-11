import { createHash } from 'node:crypto';

/** Stable visual form for Figma SVG exports.
 * Generated ids and coordinate noise below one thousandth do not change the
 * rendered asset, but previously defeated raw-byte deduplication. */
export function canonicalSvg(svg) {
  let text = Buffer.isBuffer(svg) ? svg.toString('utf8') : String(svg);
  const ids = new Map();
  let nextId = 0;
  text = text.replace(/\bid=(['"])([^'"]+)\1/g, (_match, quote, raw) => {
    const canonical = `svg-id-${nextId++}`;
    ids.set(raw, canonical);
    return `id=${quote}${canonical}${quote}`;
  });
  for (const [raw, canonical] of ids) {
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${canonical})`)
      .replace(new RegExp(`(["'])#${escaped}\\1`, 'g'), `$1#${canonical}$1`);
  }
  // SVG path commands conventionally touch their first number (`M9.99`), so
  // token-boundary lookarounds would miss exactly the coordinates we need.
  text = text.replace(/[-+]?(?:\d+\.\d+|\.\d+)/g, (raw) => {
    const rounded = Math.round(Number(raw) * 1000) / 1000;
    return Object.is(rounded, -0) ? '0' : String(rounded);
  });
  return text.replace(/>\s+</g, '><').trim();
}

export function svgVisualFingerprint(svg) {
  return createHash('sha1').update(canonicalSvg(svg)).digest('hex');
}
