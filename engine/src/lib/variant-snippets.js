// `component add-variant` eval-builder — pure, like eval-snippets.js.
//
// Clone-nearest semantics: the new variant starts as a clone of the existing
// variant closest to the requested combination, so consistency with the set
// is a construction property, not agent discipline. The scoring functions
// below are exported for tests AND serialized (via toString) into the plugin
// eval, so the tested logic and the shipped logic are the same source.
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
    if (k) pairs[k] = v;
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
    pairs[k] = v;
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

/**
 * Eval source for `component add-variant <set> <pairs> [--from <name>]`.
 * setRef: node id, exact set name, or normalized set name. pairs: parsed
 * target pairs. fromName: explicit clone source (variant name), or null.
 *
 * The eval refuses to mutate a set whose variantGroupProperties throws
 * (conflicting variant names), refuses duplicates, and — when a pair names a
 * NEW axis — backfills that axis onto every existing variant by rename, since
 * axes only exist through child names and a lone renamed clone would leave
 * the set in Figma's "missing property" error state.
 */
export function addVariantCode({ setRef, pairs, fromName }) {
  return `(async () => {
    const setRef = ${JSON.stringify(String(setRef))};
    const target = ${JSON.stringify(pairs)};
    const fromName = ${JSON.stringify(fromName || null)};
    const __pairsFromName = ${variantNamePairs.toString()};
    const __nearest = ${nearestVariant.toString()};
    const __norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    await figma.loadAllPagesAsync();
    const idShaped = /^\\d+:\\d+$/.test(setRef) || setRef.indexOf(';') !== -1;
    let set = null;
    if (idShaped) {
      const n = await figma.getNodeByIdAsync(setRef);
      if (n && n.type === 'COMPONENT_SET') set = n;
      else if (n) throw new Error('Node ' + setRef + ' is a ' + n.type + ', not a COMPONENT_SET.');
    }
    if (!set) {
      const all = [];
      const walk = (node) => {
        if (node.type === 'COMPONENT_SET') { all.push(node); return; }
        if ('children' in node) node.children.forEach(walk);
      };
      for (const page of figma.root.children) page.children.forEach(walk);
      let hits = all.filter(s => s.name === setRef);
      if (hits.length === 0) hits = all.filter(s => __norm(s.name) === __norm(setRef));
      if (hits.length === 0) {
        const names = all.slice(0, 20).map(s => s.name);
        throw new Error('No component set named "' + setRef + '". Sets in this file: ' +
          (names.length ? names.join(', ') : '(none)') + (all.length > 20 ? ', …' : '') + '.');
      }
      if (hits.length > 1) {
        throw new Error('Set name "' + setRef + '" is ambiguous: ' +
          hits.map(s => s.name + ' (' + s.id + ')').join(', ') + '. Use the id.');
      }
      set = hits[0];
    }

    let axes = null;
    try { axes = set.variantGroupProperties; } catch (e) {
      throw new Error('Set "' + set.name + '" has variant errors (conflicting or malformed variant names). Fix the set in Figma first.');
    }
    const axisNames = Object.keys(axes || {});
    const variants = set.children
      .filter(c => c.type === 'COMPONENT')
      .map(c => ({ id: c.id, name: c.name, pairs: __pairsFromName(c.name), node: c }));
    if (variants.length === 0) throw new Error('Set "' + set.name + '" has no variants to clone.');

    let source = null;
    if (fromName) {
      source = variants.find(v => v.name === fromName) ||
               variants.find(v => __norm(v.name) === __norm(fromName));
      if (!source) {
        throw new Error('--from "' + fromName + '" matches no variant. Variants: ' +
          variants.map(v => v.name).join(' | '));
      }
    } else {
      let dvId = null;
      try { dvId = (set.defaultVariant || {}).id || null; } catch (e) {}
      source = __nearest(variants, target, dvId);
    }

    const finalPairs = Object.assign({}, source.pairs);
    for (const k of Object.keys(target)) finalPairs[k] = target[k];
    const order = axisNames.slice();
    for (const k of Object.keys(target)) if (order.indexOf(k) === -1) order.push(k);
    for (const k of Object.keys(finalPairs)) if (order.indexOf(k) === -1) order.push(k);
    const newName = order
      .filter(k => finalPairs[k] !== undefined)
      .map(k => k + '=' + finalPairs[k]).join(', ');

    const canon = (p) => JSON.stringify(Object.keys(p).sort().map(k => [k, p[k]]));
    const wantCanon = canon(finalPairs);
    const dup = variants.find(v => canon(v.pairs) === wantCanon);
    if (dup) throw new Error('Variant "' + newName + '" already exists (' + dup.id + ').');

    const createdAxes = Object.keys(target).filter(k => axisNames.indexOf(k) === -1);
    const renamedSiblings = [];
    const warnings = [];
    for (const ax of createdAxes) {
      const tv = String(target[ax]);
      const fill = (tv === 'true' || tv === 'false') ? 'false' : 'Default';
      for (const v of variants) {
        v.node.name = v.node.name + ', ' + ax + '=' + fill;
        renamedSiblings.push(v.node.id);
      }
      warnings.push('Axis "' + ax + '" did not exist: every existing variant now carries ' +
        ax + '=' + fill + '. Rename those values if a different default fits.');
    }

    const clone = source.node.clone();
    clone.name = newName;
    set.appendChild(clone);
    try {
      if (!set.layoutMode || set.layoutMode === 'NONE') {
        let maxX = 0;
        for (const c of set.children) { if (c !== clone) maxX = Math.max(maxX, c.x + c.width); }
        clone.x = maxX + 20;
        clone.y = source.node.y;
      }
    } catch (e) {}

    delete globalThis.__invCache;
    return {
      setId: set.id, setName: set.name,
      newVariantId: clone.id, newVariantName: clone.name,
      sourceVariantName: source.name,
      createdAxes, renamedSiblings, warnings,
    };
  })()`;
}
