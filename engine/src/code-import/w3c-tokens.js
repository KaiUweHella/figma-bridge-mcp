import { parseBoundedJson, workspaceIO } from '../lib/workspace-io.js';

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
  try { doc = parseBoundedJson(jsonText, { role: 'token-file', limits: workspaceIO().limits }); }
  catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }

  // 1) flatten: path → raw token
  const flat = new Map();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if ('$value' in node || 'value' in node) {
      flat.set(path.join('.'), {
        value: node.$value ?? node.value,
        type: node.$type ?? node.type,
        description: node.$description ?? node.description,
        extensions: node.$extensions,
      });
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

  const variableName = (ref) => {
    const parts = ref.split('.');
    if (/^colors?$/iu.test(parts[0]) && parts.length > 1) parts.shift();
    if (/radius|radii|rounded/iu.test(ref)) return `radius-${parts.at(-1)}`;
    if (/spacing|space|gap/iu.test(ref)) return `spacing-${parts.at(-1)}`;
    return parts.join('-');
  };

  const resolveComposite = (value, seen) => {
    if (typeof value === 'string') {
      const match = value.match(/^\{([^}]+)\}$/u);
      if (!match) return value;
      const ref = match[1];
      if (seen.has(ref)) throw new Error(`Circular alias reference: {${ref}}`);
      const target = flat.get(ref);
      if (!target) throw new Error(`Unresolved alias {${ref}}`);
      return { value: resolve(target.value, new Set([...seen, ref])), alias: variableName(ref) };
    }
    if (Array.isArray(value)) return value.map((item) => resolveComposite(item, seen));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .map(([key, child]) => [key, resolveComposite(child, seen)]));
    }
    return value;
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
      const composite = resolveComposite(tok.value, new Set([path]));
      const number = (entry, fallback = null) => {
        if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')) {
          const converted = toPx(entry.value);
          return converted == null ? entry : { ...entry, value: converted };
        }
        return toPx(entry) ?? fallback;
      };
      const t = { ...composite };
      t.fontSize = number(composite.fontSize);
      t.fontWeight = number(composite.fontWeight, 400);
      for (const field of ['lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent']) {
        if (composite[field] !== undefined) t[field] = number(composite[field]);
      }
      const identity = tok.extensions?.['figma-bridge']?.style ?? tok.extensions?.figma?.style;
      tokens.typography[name] = tok.description || identity
        ? { value: t, ...(tok.description ? { description: tok.description } : {}),
          ...(identity ? { sourceIdentity: identity } : {}), type: 'typography' }
        : t;
      const font = t.fontFamily?.value ?? t.fontFamily;
      if (font) fonts.add(font);
      continue;
    }
    if (['shadow', 'boxShadow'].includes(tok.type)
      || (value && typeof value === 'object'
        && ('offsetX' in value || 'x' in value || 'blur' in value || 'radius' in value))) {
      const composite = resolveComposite(tok.value, new Set([path]));
      const identity = tok.extensions?.['figma-bridge']?.style ?? tok.extensions?.figma?.style;
      tokens.shadow[name] = tok.description || identity
        ? { value: composite, ...(tok.description ? { description: tok.description } : {}),
          ...(identity ? { sourceIdentity: identity } : {}), type: 'shadow' }
        : composite;
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
