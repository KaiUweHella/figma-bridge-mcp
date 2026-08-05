// Component inventory eval-builder — shared by `component list` and
// `map storybook`. Pure: returns the JS source the plugin evaluates.

/**
 * Eval code for a component inventory — shared by `component list` and
 * `map storybook`. Returns { componentSets, standaloneComponents } where
 * `key` is the stable publish key (survives library publishing — the identity
 * a Storybook/code mapping hangs on; node ids are file-local) and
 * `defaultVariantId` marks the set's instancing handle.
 */
export function componentInventoryCode(allPages) {
  return `(async () => {
    ${allPages ? 'await figma.loadAllPagesAsync();' : ''}
    const pages = ${allPages ? 'figma.root.children' : '[figma.currentPage]'};
    const sets = [];
    const singles = [];
    const safeKey = (n) => { try { return n.key || null; } catch (e) { return null; } };
    function walk(node, pageName) {
      if (node.type === 'COMPONENT_SET') {
        let axes = null;
        try { axes = node.variantGroupProperties; } catch (e) {}
        let dvId = null;
        try { dvId = (node.defaultVariant || node.children[0] || {}).id || null; } catch (e) {}
        sets.push({
          id: node.id, name: node.name, page: pageName,
          key: safeKey(node),
          defaultVariantId: dvId,
          variantAxes: axes,
          variants: node.children.map(c => ({ id: c.id, name: c.name, key: safeKey(c) })),
        });
        return; // variants are already reported; don't double-count as singles
      }
      if (node.type === 'COMPONENT') {
        singles.push({ id: node.id, name: node.name, page: pageName, key: safeKey(node) });
      }
      if ('children' in node) node.children.forEach(c => walk(c, pageName));
    }
    for (const page of pages) page.children.forEach(c => walk(c, page.name));
    return { fileName: figma.root.name, componentSets: sets, standaloneComponents: singles };
  })()`;
}

/**
 * Same inventory, memoized in the plugin sandbox (globals persist across
 * evals — the pattern __spaceCache already relies on). The render reuse-lint
 * runs after every render; a full loadAllPagesAsync walk each time would be
 * felt on big files, and a lint tolerates ttlMs of staleness. Mutating
 * commands (add-variant, combine) delete globalThis.__invCache.
 */
export function cachedInventoryCode(allPages, ttlMs = 60000) {
  return `(async () => {
    const now = Date.now();
    const c = globalThis.__invCache;
    if (c && c.allPages === ${!!allPages} && (now - c.at) < ${Number(ttlMs)}) return c.data;
    const data = await ${componentInventoryCode(allPages)};
    globalThis.__invCache = { at: now, allPages: ${!!allPages}, data };
    return data;
  })()`;
}
