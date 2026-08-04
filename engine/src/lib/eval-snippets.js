// Reusable plugin-eval snippets and small colour/variable helpers.
//
// These build JS SOURCE that runs inside the Figma plugin sandbox; keeping
// them in one place is what lets every command share the same node-selector
// and component-context semantics (and the same quoting discipline).
// (Extracted from cli-core.js.)
import chalk from 'chalk';

const GENERIC_NAME_PATTERNS = new Set([
  'frame', 'component', 'instance', 'group', 'rectangle', 'rect',
  'ellipse', 'line', 'text', 'vector', 'star', 'polygon', 'section',
]);

/**
 * Build the JS snippet that resolves a target `nodes` list inside an eval.
 * One source-of-truth for all `set <subcommand>` selectors. Supports:
 *  - --query "pattern"     fuzzy name match (rejects generic defaults)
 *  - --node "id"           single node
 *  - --node "id1,id2,id3"  multiple comma-separated nodes
 *  - (none)                figma.currentPage.selection
 *
 * `filterExpr` is optional and lets a caller scope --query to nodes that
 * actually support the property (e.g. `'fills' in n`).
 */
function buildNodeSelector(options, { filterExpr = '' } = {}) {
  if (options.query) {
    const q = String(options.query).trim();
    if (GENERIC_NAME_PATTERNS.has(q.toLowerCase())) {
      console.error(chalk.red('✗'),
        `--query "${q}" matches Figma's default node name and would select every unnamed ${q.toLowerCase()} in the file.`);
      console.error(chalk.yellow('  Use --node <id> with specific IDs, or rename your targets first.'));
      process.exit(1);
    }
    const filter = filterExpr ? `(${filterExpr}) && ` : '';
    return `const __pat = ${JSON.stringify(q.toLowerCase())};
       const nodes = figma.currentPage.findAll(n => ${filter}typeof n.name === 'string' && n.name.toLowerCase().includes(__pat));`;
  }
  if (options.node) {
    const ids = String(options.node).split(/[\s,]+/).filter(Boolean);
    if (ids.length === 1) {
      return `const __n = await figma.getNodeByIdAsync(${JSON.stringify(ids[0])}); const nodes = __n ? [__n] : [];`;
    }
    return `const __ids = ${JSON.stringify(ids)};
       const __res = await Promise.all(__ids.map(id => figma.getNodeByIdAsync(id)));
       const nodes = __res.filter(Boolean);`;
  }
  return `const nodes = figma.currentPage.selection;`;
}

// Shared eval-snippet fragment: resolve a node's component context — instance →
// main component, parent variant set, and the variant/property facts — into ONE
// canonical object. Used by `inspect`, `component main`, and any command that
// reports component structure so the resolution (and its dynamic-page quirks,
// e.g. componentPropertyDefinitions throwing on variant children) lives in one
// place. `nodeVar` names an in-scope node variable in the generated async code;
// the returned expression evaluates to the context object (or null for a
// non-component node). Must be used inside an async function (uses await).
//
// Shape: { role, mainComponent:{id,name,key,remote}|null,
//          set:{id,name,variants:[{id,name}]}|null, variantProperties,
//          componentProperties, componentPropertyDefinitions,
//          variantGroupProperties }
function componentContextExpr(nodeVar) {
  return `await (async (__n) => {
    if (!__n) return null;
    const t = __n.type;
    const ctx = { role: null, mainComponent: null, set: null,
      variantProperties: null, componentProperties: null,
      componentPropertyDefinitions: null, variantGroupProperties: null };
    if (t !== 'INSTANCE' && t !== 'COMPONENT' && t !== 'COMPONENT_SET') return ctx;
    ctx.role = t;
    let main = null, setNode = null;
    const safeKey = (n) => { try { return n.key || null; } catch (e) { return null; } };
    if (t === 'INSTANCE') {
      main = await __n.getMainComponentAsync();
      if (main) ctx.mainComponent = { id: main.id, name: main.name, key: safeKey(main), remote: !!main.remote };
      try { ctx.componentProperties = __n.componentProperties || null; } catch (e) {}
      try { ctx.variantProperties = __n.variantProperties || null; } catch (e) {}
    } else if (t === 'COMPONENT') {
      main = __n;
      // Inspecting a COMPONENT directly also reports its own stable key —
      // previously only instances surfaced one.
      ctx.mainComponent = { id: __n.id, name: __n.name, key: safeKey(__n), remote: !!__n.remote };
      try { ctx.variantProperties = __n.variantProperties || null; } catch (e) {}
    } else {
      setNode = __n;
      try { ctx.variantGroupProperties = __n.variantGroupProperties; } catch (e) {}
    }
    if (!setNode && main && main.parent && main.parent.type === 'COMPONENT_SET') setNode = main.parent;
    if (setNode) {
      ctx.set = { id: setNode.id, name: setNode.name, key: safeKey(setNode), variants: setNode.children.map(c => ({ id: c.id, name: c.name })) };
    }
    // Property definitions live on the set (variant children throw when asked);
    // for a standalone component/instance they live on the main component.
    const defSource = setNode || main;
    if (defSource) { try { ctx.componentPropertyDefinitions = defSource.componentPropertyDefinitions; } catch (e) {} }
    return ctx;
  })(${nodeVar})`;
}

// Daemon configuration. The port is resolved fresh per call (env > port file
// published by the daemon > 3456) — see lib/daemon-port.js. The daemon may

function hexToRgb(hex) {
  // Remove # if present
  hex = hex.replace(/^#/, '');

  // Expand 3-char hex to 6-char
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    throw new Error(`Invalid hex color: #${hex}`);
  }
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  };
}

// Helper: Check if value is a variable reference (var:name)
function isVarRef(value) {
  return typeof value === 'string' && value.startsWith('var:');
}

// Helper: Extract variable name from var:name syntax
function getVarName(value) {
  return value.slice(4);
}

// Helper: Generate fill code (hex or variable binding)
function generateFillCode(color, nodeVar = 'node', property = 'fills') {
  if (isVarRef(color)) {
    const varName = getVarName(color);
    return {
      code: `${nodeVar}.${property} = [boundFill(vars[${JSON.stringify(varName)}])];`,
      usesVars: true
    };
  }
  const { r, g, b } = hexToRgb(color);
  return {
    code: `${nodeVar}.${property} = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }];`,
    usesVars: false
  };
}

// Helper: Generate stroke code (hex or variable binding)
function generateStrokeCode(color, nodeVar = 'node', weight = 1) {
  if (isVarRef(color)) {
    const varName = getVarName(color);
    return {
      code: `${nodeVar}.strokes = [boundFill(vars[${JSON.stringify(varName)}])]; ${nodeVar}.strokeWeight = ${weight};`,
      usesVars: true
    };
  }
  const { r, g, b } = hexToRgb(color);
  return {
    code: `${nodeVar}.strokes = [{ type: 'SOLID', color: { r: ${r}, g: ${g}, b: ${b} } }]; ${nodeVar}.strokeWeight = ${weight};`,
    usesVars: false
  };
}

// Helper: Variable loading code — loads ALL local collections. No collection
// name is privileged: the user's own token set is the only token set.
function varLoadingCode() {
  return `
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const vars = {};
const allVars = await figma.variables.getLocalVariablesAsync();
// First-come-wins on name collisions, in Figma's natural collection order.
for (const v of allVars) {
  if (!vars[v.name]) vars[v.name] = v;
}
const boundFill = (variable) => figma.variables.setBoundVariableForPaint(
  { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable
);
`;
}

// Helper: Smart positioning code (returns JS to get next free X position)
function smartPosCode(gap = 100) {
  return `
const children = figma.currentPage.children;
let smartX = 0;
if (children.length > 0) {
  children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
  smartX += ${gap};
}
`;
}


/**
 * Build the snippet that resolves a page from a user query into `target`
 * (id match → exact name → unique substring → ambiguity/not-found error).
 * Shared by `canvas page`, `canvas page-create` and `node move --page` so
 * the matching semantics and error wording cannot drift.
 */
function pageLookupCode(query) {
  return `
      const q = ${JSON.stringify(String(query))};
      const pages = figma.root.children;
      let target = pages.find(p => p.id === q) || pages.find(p => p.name === q);
      if (!target) {
        const matches = pages.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          throw new Error('Ambiguous page name "' + q + '": ' + matches.map(p => p.name).join(', '));
        }
      }
      if (!target) throw new Error('Page not found: ' + q);
`;
}

/**
 * Emit a `__resolveVar(name, collectionHint)` helper plus the `__allVars` /
 * `__collections` arrays it needs.
 *
 * Returns `{ variable, matches }` — never a bare variable. The deleted `bind`
 * commands did `vars.find(v => v.name === name || v.name.endsWith('/'+name))`
 * and used whatever came back first. A file with three collections defining
 * `primary` therefore got a silent coin toss. Here an ambiguous name is
 * reported, and `collectionHint` is how the caller settles it.
 *
 * Matching order: exact name, then trailing segment ("brand" ← "color/brand").
 * Only the strongest tier that produced a hit is returned, so an exact match
 * is never diluted by looser ones.
 */
function varResolverCode() {
  return `
const __collections = await figma.variables.getLocalVariableCollectionsAsync();
const __allVars = await figma.variables.getLocalVariablesAsync();
const __colName = (v) => {
  const c = __collections.find(c => c.id === v.variableCollectionId);
  return c ? c.name : '(unknown)';
};
const __resolveVar = (name, collectionHint) => {
  let pool = __allVars;
  if (collectionHint) {
    const q = String(collectionHint).toLowerCase();
    const col = __collections.find(c => c.name.toLowerCase() === q)
             || __collections.find(c => c.name.toLowerCase().includes(q));
    if (!col) {
      return { variable: null, matches: [], badCollection: collectionHint,
               collections: __collections.map(c => c.name) };
    }
    pool = __allVars.filter(v => v.variableCollectionId === col.id);
  }
  const exact = pool.filter(v => v.name === name);
  const tail = pool.filter(v => v.name.endsWith('/' + name));
  const matches = exact.length ? exact : tail;
  const described = matches.map(v => ({ id: v.id, name: v.name, type: v.resolvedType, collection: __colName(v) }));
  return { variable: matches.length === 1 ? matches[0] : null, matches: described };
};
`;
}

// Shared error handler for commands that hit Figma's API via daemonExec.
export {
  GENERIC_NAME_PATTERNS,
  buildNodeSelector,
  componentContextExpr,
  varResolverCode,
  hexToRgb,
  isVarRef,
  getVarName,
  generateFillCode,
  generateStrokeCode,
  varLoadingCode,
  smartPosCode,
  pageLookupCode,
};
