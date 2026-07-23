/**
 * W3C design-tokens (Style Dictionary / Tokens Studio) parser.
 * A token is any object carrying `$value` (or legacy `value`). Names are the
 * group path joined with '-'; a leading group named color/colors is dropped
 * (so color.brand.primary → brand-primary). Dimension buckets are inferred
 * from the path (radius/spacing) — everything else dimensional is ignored.
 */
const toPx = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v).match(/^([\d.]+)(px|rem)?$/);
  if (!m) return null;
  return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
};

const isColor = (v) => typeof v === 'string' && /^(#|rgb|hsl)/.test(v.trim());

export function parseW3cTokens(jsonText) {
  let doc;
  try { doc = JSON.parse(jsonText); }
  catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }

  // 1) flatten: path → raw token
  const flat = new Map();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if ('$value' in node || 'value' in node) {
      flat.set(path.join('.'), { value: node.$value ?? node.value, type: node.$type ?? node.type });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walk(v, [...path, k]);
    }
  };
  walk(doc, []);

  // 2) resolve {alias} references (with cycle detection)
  const resolve = (value, seen) => {
    if (typeof value !== 'string') return value;
    const m = value.match(/^\{([^}]+)\}$/);
    if (!m) return value;
    const ref = m[1];
    if (seen.has(ref)) throw new Error(`Circular alias reference: {${ref}}`);
    const target = flat.get(ref);
    if (!target) throw new Error(`Unresolved alias {${ref}}`);
    seen.add(ref);
    return resolve(target.value, seen);
  };

  const tokens = { color: {}, typography: {}, radius: {}, spacing: {}, shadow: {}, fonts: [] };
  const fonts = new Set();
  for (const [path, tok] of flat) {
    const value = resolve(tok.value, new Set([path]));
    const parts = path.split('.');
    if (/^colors?$/i.test(parts[0]) && parts.length > 1) parts.shift();
    const name = parts.join('-');
    if (tok.type === 'color' || isColor(value)) {
      if (isColor(value)) tokens.color[name] = value;
      continue;
    }
    if (tok.type === 'typography' || (value && typeof value === 'object' && 'fontFamily' in value)) {
      const t = { fontFamily: value.fontFamily, fontSize: toPx(value.fontSize), fontWeight: typeof value.fontWeight === 'number' ? value.fontWeight : 400 };
      const lh = toPx(value.lineHeight); if (lh != null) t.lineHeight = lh;
      const ls = toPx(value.letterSpacing); if (ls != null) t.letterSpacing = ls;
      tokens.typography[name] = t;
      if (t.fontFamily) fonts.add(t.fontFamily);
      continue;
    }
    const px = toPx(value);
    if (px == null) continue;
    if (/radius|radii|rounded/i.test(path)) tokens.radius[`radius-${parts[parts.length - 1]}`] = px;
    else if (/spacing|space|gap/i.test(path)) tokens.spacing[`spacing-${parts[parts.length - 1]}`] = px;
  }
  tokens.fonts = [...fonts];
  return { tokens, meta: { source: 'design tokens' } };
}
