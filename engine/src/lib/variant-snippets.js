// Pure Component Variant naming helpers.
//
// Clone-nearest semantics: the new variant starts as a clone of the existing
// variant closest to the requested combination, so consistency with the set
// is a construction property, not agent discipline. The scoring functions
// below are exported for tests and serialized (via toString) into the Component
// Add Variant Command Application, so tests and Plugin execution share them.
// No backticks anywhere in these bodies — they get embedded in a template
// literal, and a backtick inside would end it (node --check does not see it).

/**
 * Parse a variant NAME in Figma's convention ("State=Hover, Size=XL") into
 * pairs. Lenient: segments without "=" are skipped (Figma tolerates odd names;
 * the caller decides whether that matters).
 */
export function variantNamePairs(name) {
  const pairs = {};
  String(name || '').split(',').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) Object.defineProperty(pairs, k, {
      value: v, enumerable: true, configurable: true, writable: true,
    });
  });
  return pairs;
}

/**
 * Parse the CLI argument ("Prop=Value[, Prop2=Value2]"). Strict: every
 * segment must be a non-empty key=value pair — a typo here would otherwise
 * silently create a variant with a wrong name.
 */
export function parseVariantPairs(str) {
  const raw = String(str || '').trim();
  if (!raw) throw new Error('Empty variant spec. Expected "Prop=Value" (comma-separate several pairs).');
  const pairs = {};
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    const k = idx === -1 ? '' : part.slice(0, idx).trim();
    const v = idx === -1 ? '' : part.slice(idx + 1).trim();
    if (!k || !v) {
      throw new Error('Invalid variant pair "' + part.trim() + '". Expected "Prop=Value" (comma-separate several pairs).');
    }
    if (Object.prototype.hasOwnProperty.call(pairs, k)) {
      throw new Error('Axis "' + k + '" is specified twice.');
    }
    Object.defineProperty(pairs, k, {
      value: v, enumerable: true, configurable: true, writable: true,
    });
  }
  return pairs;
}

/**
 * Pick the variant to clone. variants: [{ id, name, pairs }].
 * Rank: matches on the SPECIFIED axes first (relevant for multi-pair targets
 * where part of the combination already exists), then closeness to the
 * default variant on the remaining axes, then the default variant itself,
 * then child order. Returns null on an empty list.
 */
export function nearestVariant(variants, targetPairs, defaultId) {
  const keys = Object.keys(targetPairs);
  let def = null;
  for (const v of variants) if (v.id === defaultId) { def = v; break; }
  let best = null;
  let bestRank = null;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    let score = 0;
    for (const k of keys) if (v.pairs[k] === targetPairs[k]) score++;
    let defNear = 0;
    if (def) {
      for (const k of Object.keys(v.pairs)) {
        if (keys.indexOf(k) === -1 && v.pairs[k] === def.pairs[k]) defNear++;
      }
    }
    const isDef = def && v.id === defaultId ? 1 : 0;
    const rank = [score, defNear, isDef, -i];
    let better = bestRank === null;
    if (!better) {
      for (let r = 0; r < rank.length; r++) {
        if (rank[r] !== bestRank[r]) { better = rank[r] > bestRank[r]; break; }
      }
    }
    if (better) { best = v; bestRank = rank; }
  }
  return best;
}
