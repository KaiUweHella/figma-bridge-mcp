// Canonical, reviewable contracts projected from one lossless Design Capture.
//
// A contract has two complementary layers:
//   - canonical: deterministic facts for exact drift detection;
//   - rules: semantic invariants that explain whether component construction
//     is still valid (variant axes, token bindings, geometry and reactions).
//
// Volatile Figma handles are deliberately excluded. Nested child order stays
// intact because it is authored layout; independent capture roots are sorted.

export const DESIGN_CONTRACT_VERSION = 1;

const VOLATILE_KEYS = new Set([
  'id', 'key', 'setId', 'setKey', 'nodeId', 'parentId', 'rootId',
  'variableId', 'variableCollectionId', 'collectionId', 'modeId',
]);

function round(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 1000) / 1000
    : value;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return round(value);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = stableObject(value[key]);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableObject(value));
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

function canonicalNode(node) {
  const out = {};
  for (const key of Object.keys(node || {}).sort()) {
    if (VOLATILE_KEYS.has(key) || key === 'kids' || key === 'rx') continue;
    out[key] = stableObject(node[key]);
  }
  if (Array.isArray(node?.rx)) {
    out.rx = node.rx.map(stableObject).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (Array.isArray(node?.kids)) out.kids = node.kids.map(canonicalNode);
  return out;
}

/** Deterministic Design Capture projection; source revision/provenance stays outside it. */
export function canonicalDesignCapture(capture) {
  const result = capture?.result || capture;
  if (!result || !Array.isArray(result.frames)) {
    throw new Error('Design Contract requires a Design Capture with frames.');
  }
  const frames = result.frames.map(canonicalNode)
    .sort((a, b) => `${a.n || ''}\0${a.t || ''}`.localeCompare(`${b.n || ''}\0${b.t || ''}`));
  return {
    name: result.name || null,
    frames,
  };
}

function* walk(nodes, parentPath = '') {
  const counts = new Map();
  for (const node of nodes || []) {
    const base = `${node.n || '(unnamed)'} [${node.t || 'NODE'}]`;
    const occurrence = counts.get(base) || 0;
    counts.set(base, occurrence + 1);
    const segment = occurrence ? `${base}#${occurrence + 1}` : base;
    const path = parentPath ? `${parentPath} / ${segment}` : segment;
    yield { node, path };
    yield* walk(node.kids, path);
  }
}

function axesOf(node) {
  const axes = {};
  for (const [name, definition] of Object.entries(node?.vp || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const values = Array.isArray(definition?.values) ? definition.values.map(String) : [];
    if (values.length) axes[name] = [...new Set(values)].sort();
  }
  if (Object.keys(axes).length) return axes;
  for (const child of node?.kids || []) {
    for (const pair of String(child.n || '').split(',')) {
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!name || !value) continue;
      if (!axes[name]) axes[name] = [];
      if (!axes[name].includes(value)) axes[name].push(value);
    }
  }
  for (const values of Object.values(axes)) values.sort();
  return Object.fromEntries(Object.entries(axes).sort(([a], [b]) => a.localeCompare(b)));
}

function countBindingLeaves(value) {
  if (typeof value === 'string') return value && value !== '__unresolved_variable__' ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countBindingLeaves(child), 0);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, child) => sum + countBindingLeaves(child), 0);
  }
  return 0;
}

function tokenBindings(root) {
  let count = 0;
  for (const { node } of walk([root])) count += countBindingLeaves(node.bv);
  return count;
}

function transitions(root) {
  const out = [];
  for (const { node, path } of walk([root])) {
    for (const reaction of node.rx || []) out.push({ from: path, reaction: stableObject(reaction) });
  }
  return out.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function variantGeometry(node) {
  return (node.kids || [])
    .filter((child) => child.t === 'COMPONENT')
    .map((child) => ({ name: child.n || '', w: round(child.w), h: round(child.h) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Generate semantic invariants from the reviewed current Design Capture. */
export function generateDesignRules(capture, { geometryTolerance = 0.5 } = {}) {
  const result = capture?.result || capture;
  const roots = (result.frames || []).map((node) => ({
    name: node.n || '', type: node.t || '', w: round(node.w), h: round(node.h),
  })).sort((a, b) => `${a.name}\0${a.type}`.localeCompare(`${b.name}\0${b.type}`));
  const componentSets = [];
  for (const { node, path } of walk(result.frames || [])) {
    if (node.t !== 'COMPONENT_SET') continue;
    const axes = axesOf(node);
    const variantCount = Number.isInteger(node.kidCount)
      ? node.kidCount
      : (node.kids || []).filter((child) => child.t === 'COMPONENT').length;
    const declaredCount = Object.keys(axes).length
      ? Object.values(axes).reduce((total, values) => total * values.length, 1)
      : 0;
    componentSets.push({
      path,
      name: node.n || '',
      axes,
      variants: variantCount,
      exhaustive: declaredCount > 0 && declaredCount === variantCount,
      minTokenBindings: tokenBindings(node),
      transitions: transitions(node),
      geometry: variantGeometry(node),
    });
  }
  return { geometryTolerance: Number(geometryTolerance), roots, componentSets };
}

function assertComplete(capture) {
  if (!capture?.completeness) return;
  if (capture.completeness.payloadComplete === false || capture.completeness.depthLimited) {
    throw new Error('Design Contract cannot be built from an incomplete or depth-limited Design Capture. Increase --depth.');
  }
}

export function buildDesignContract({ entity, capture, geometryTolerance = 0.5, createdAt = null }) {
  if (!entity?.id || !entity?.kind) throw new Error('Design Contract requires a Design Entity id and kind.');
  assertComplete(capture);
  return {
    version: DESIGN_CONTRACT_VERSION,
    entity: { id: entity.id, kind: entity.kind },
    provenance: {
      fileKey: entity.figma?.fileKey || capture?.source?.fileKey || null,
      nodeId: entity.figma?.nodeId || null,
      capturedAt: createdAt || new Date().toISOString(),
      captureSchemaVersion: capture?.schemaVersion || null,
    },
    canonical: canonicalDesignCapture(capture),
    rules: generateDesignRules(capture, { geometryTolerance }),
  };
}

function sameAxes(a, b) {
  return stableJson(a || {}) === stableJson(b || {});
}

function within(actual, expected, tolerance) {
  if (expected === undefined || expected === null) return true;
  return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

/** Arithmetic rule validation. No heuristics and no model are involved. */
export function validateDesignRules(rules, capture) {
  const result = capture?.result || capture;
  const violations = [];
  const tolerance = Number(rules?.geometryTolerance ?? 0.5);
  const currentRoots = new Map((result.frames || []).map((node) => [`${node.n || ''}\0${node.t || ''}`, node]));
  for (const expected of rules?.roots || []) {
    const current = currentRoots.get(`${expected.name}\0${expected.type}`);
    if (!current) {
      violations.push({ code: 'root-missing', path: expected.name, expected: expected.type });
      continue;
    }
    if (!within(current.w, expected.w, tolerance) || !within(current.h, expected.h, tolerance)) {
      violations.push({
        code: 'root-geometry', path: expected.name,
        expected: { w: expected.w, h: expected.h, tolerance }, actual: { w: current.w, h: current.h },
      });
    }
  }

  const currentSets = new Map([...walk(result.frames || [])]
    .filter(({ node }) => node.t === 'COMPONENT_SET')
    .map((item) => [item.path, item.node]));
  for (const expected of rules?.componentSets || []) {
    const current = currentSets.get(expected.path);
    if (!current) {
      violations.push({ code: 'component-set-missing', path: expected.path });
      continue;
    }
    const axes = axesOf(current);
    if (!sameAxes(axes, expected.axes)) {
      violations.push({ code: 'variant-axes', path: expected.path, expected: expected.axes, actual: axes });
    }
    const count = Number.isInteger(current.kidCount)
      ? current.kidCount
      : (current.kids || []).filter((child) => child.t === 'COMPONENT').length;
    if (count !== expected.variants) {
      violations.push({ code: 'variant-count', path: expected.path, expected: expected.variants, actual: count });
    }
    if (expected.exhaustive) {
      const declared = Object.keys(axes).length
        ? Object.values(axes).reduce((total, values) => total * values.length, 1)
        : 0;
      if (declared !== count) violations.push({ code: 'variant-matrix-incomplete', path: expected.path, expected: declared, actual: count });
    }
    const bindings = tokenBindings(current);
    if (bindings < expected.minTokenBindings) {
      violations.push({ code: 'token-bindings', path: expected.path, expected: `>= ${expected.minTokenBindings}`, actual: bindings });
    }
    const currentTransitions = new Set(transitions(current).map(stableJson));
    for (const transition of expected.transitions || []) {
      if (!currentTransitions.has(stableJson(transition))) {
        violations.push({ code: 'prototype-transition', path: expected.path, expected: transition });
      }
    }
    const geometry = new Map(variantGeometry(current).map((variant) => [variant.name, variant]));
    for (const variant of expected.geometry || []) {
      const actual = geometry.get(variant.name);
      if (!actual) continue; // variant-count/axes already explain its absence.
      if (!within(actual.w, variant.w, tolerance) || !within(actual.h, variant.h, tolerance)) {
        violations.push({
          code: 'variant-geometry', path: `${expected.path} / ${variant.name}`,
          expected: { w: variant.w, h: variant.h, tolerance }, actual: { w: actual.w, h: actual.h },
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function diffValue(before, after, path, out, limit) {
  if (out.length >= limit) return;
  if (stableJson(before) === stableJson(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index++) diffValue(before[index], after[index], `${path}[${index}]`, out, limit);
    return;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      diffValue(before[key], after[key], path ? `${path}.${key}` : key, out, limit);
    }
    return;
  }
  out.push({
    path: path || '(root)',
    kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
    before, after,
  });
}

export function checkDesignContract(contract, capture, { maxDiffs = 200 } = {}) {
  if (contract?.version !== DESIGN_CONTRACT_VERSION) {
    throw new Error(`Unsupported Design Contract version ${contract?.version}; expected ${DESIGN_CONTRACT_VERSION}.`);
  }
  assertComplete(capture);
  const current = canonicalDesignCapture(capture);
  const diffs = [];
  diffValue(contract.canonical, current, '', diffs, maxDiffs);
  const rules = validateDesignRules(contract.rules, capture);
  return {
    ok: diffs.length === 0 && rules.ok,
    canonicalEqual: diffs.length === 0,
    diffs,
    truncated: diffs.length >= maxDiffs,
    rules,
  };
}

export function serializeDesignContract(contract) {
  return JSON.stringify(ordered(contract), null, 2) + '\n';
}

export function formatDesignContractCheck(contract, check) {
  const lines = [
    `Design Contract — ${contract.entity.id} [${contract.entity.kind}]`,
    `canonical drift: ${check.canonicalEqual ? 'none' : `${check.diffs.length}${check.truncated ? '+' : ''} change(s)`}`,
    `semantic rules: ${check.rules.ok ? 'pass' : `${check.rules.violations.length} violation(s)`}`,
  ];
  if (check.diffs.length) {
    lines.push('', 'Canonical drift:');
    for (const diff of check.diffs.slice(0, 30)) lines.push(`  ${diff.kind === 'added' ? '+' : diff.kind === 'removed' ? '-' : '~'} ${diff.path}`);
  }
  if (check.rules.violations.length) {
    lines.push('', 'Rule violations:');
    for (const violation of check.rules.violations) lines.push(`  ! ${violation.code}: ${violation.path}`);
  }
  return lines.join('\n');
}
