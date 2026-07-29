// Figma↔Storybook component matching — pure functions, no I/O.
//
// Input sides:
//   figmaComponents: [{ name, page, figmaKey, figmaVariantKey, nodeId, kind: 'set'|'component' }]
//   storyComponents: parser groups from code-import/storybook.js
//     [{ name, category, title, importPath, variants, stories: [{id, name, importPath}] }]
//
// Matching is by NAME (normalized), greedy from high to low confidence, and
// each side is matched at most once. Ambiguity loses: duplicate normalized
// names on either side go unmatched rather than guessing.

export function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lastSegment(s) {
  const parts = String(s || '').split('/');
  return parts[parts.length - 1].trim();
}

function stripPlural(s) {
  return s.endsWith('s') && s.length > 3 ? s.slice(0, -1) : s;
}

/**
 * @returns {{mappings: object[], unmatchedFigma: object[], unmatchedStories: object[]}}
 */
export function matchComponents(figmaComponents, storyComponents) {
  const mappings = [];
  const figmaLeft = [...figmaComponents];
  const storyLeft = [...storyComponents];

  // Duplicate normalized names on the Figma side are inherently ambiguous —
  // pull them out up front.
  const nameCounts = new Map();
  for (const f of figmaLeft) {
    const n = normalizeName(lastSegment(f.name));
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  const ambiguous = figmaLeft.filter((f) => nameCounts.get(normalizeName(lastSegment(f.name))) > 1);
  const unmatchedFigma = ambiguous.map((f) => ({ ...f, reason: 'ambiguous-name' }));
  let figmaPool = figmaLeft.filter((f) => !ambiguous.includes(f));

  const take = (figma, story, confidence) => {
    mappings.push(makeMapping(figma, story, confidence));
    figmaPool = figmaPool.filter((f) => f !== figma);
    storyLeft.splice(storyLeft.indexOf(story), 1);
  };

  // Pass 1 — high: normalized name equality (both sides reduced to their
  // last path segment: Figma "Components/Button" ↔ story title ".../Button").
  for (const f of [...figmaPool]) {
    const fn = normalizeName(lastSegment(f.name));
    const hit = storyLeft.filter((s) => normalizeName(s.name) === fn);
    if (hit.length === 1) take(f, hit[0], 'high');
  }

  // Pass 2 — medium: plural-insensitive, or full-title match.
  for (const f of [...figmaPool]) {
    const fn = stripPlural(normalizeName(lastSegment(f.name)));
    const fFull = normalizeName(`${f.page || ''}/${f.name}`);
    const hit = storyLeft.filter(
      (s) => stripPlural(normalizeName(s.name)) === fn || normalizeName(s.title) === fFull,
    );
    if (hit.length === 1) take(f, hit[0], 'medium');
  }

  // Pass 3 — low: unique substring containment, only when exactly one
  // candidate qualifies on each side.
  for (const f of [...figmaPool]) {
    const fn = normalizeName(lastSegment(f.name));
    if (fn.length < 4) continue; // too short to trust containment
    const hit = storyLeft.filter((s) => {
      const sn = normalizeName(s.name);
      return sn.length >= 4 && (sn.includes(fn) || fn.includes(sn));
    });
    if (hit.length === 1) {
      // …and the story must not also contain a different remaining Figma name.
      const sn = normalizeName(hit[0].name);
      const rivals = figmaPool.filter((g) => {
        if (g === f) return false;
        const gn = normalizeName(lastSegment(g.name));
        return gn.length >= 4 && (sn.includes(gn) || gn.includes(sn));
      });
      if (!rivals.length) take(f, hit[0], 'low');
    }
  }

  unmatchedFigma.push(...figmaPool.map((f) => ({ ...f, reason: 'no-match' })));
  return {
    mappings,
    unmatchedFigma,
    unmatchedStories: storyLeft.map((s) => ({
      storyTitle: s.title,
      importPath: s.importPath,
    })),
  };
}

function makeMapping(figma, story, confidence) {
  return {
    figmaName: figma.name,
    figmaPage: figma.page,
    figmaKey: figma.figmaKey ?? null,
    figmaVariantKey: figma.figmaVariantKey ?? null,
    figmaNodeId: figma.nodeId,
    storyTitle: story.title,
    storyId: story.stories?.[0]?.id ?? null,
    importPath: story.importPath ?? null,
    stories: (story.stories || []).map(({ id, name }) => ({ id, name })),
    confidence,
    matchedBy: 'name',
  };
}

/**
 * Re-run merge: entries the user pinned (`matchedBy: 'manual'`) survive
 * verbatim; the Figma keys and story titles they occupy are excluded from the
 * fresh result so a re-run cannot re-assign them.
 * @param {object|null} existing - previously written figma-map.json content
 * @param {{mappings, unmatchedFigma, unmatchedStories}} fresh
 */
export function mergeMaps(existing, fresh) {
  const manual = (existing?.mappings || []).filter((m) => m.matchedBy === 'manual');
  if (!manual.length) return fresh;

  const takenKeys = new Set(manual.map((m) => m.figmaKey).filter(Boolean));
  const takenIds = new Set(manual.map((m) => m.figmaNodeId).filter(Boolean));
  const takenTitles = new Set(manual.map((m) => m.storyTitle).filter(Boolean));

  const occupies = (m) =>
    (m.figmaKey && takenKeys.has(m.figmaKey)) ||
    (m.figmaNodeId && takenIds.has(m.figmaNodeId)) ||
    (m.storyTitle && takenTitles.has(m.storyTitle));

  return {
    mappings: [...manual, ...fresh.mappings.filter((m) => !occupies(m))],
    unmatchedFigma: fresh.unmatchedFigma.filter(
      (f) => !(f.figmaKey && takenKeys.has(f.figmaKey)) && !(f.nodeId && takenIds.has(f.nodeId)),
    ),
    unmatchedStories: fresh.unmatchedStories.filter((s) => !takenTitles.has(s.storyTitle)),
  };
}
