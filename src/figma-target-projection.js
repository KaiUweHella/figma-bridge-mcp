// Closed projection from one validated Figma Command into the semantic fields
// that are allowed to contribute a URL-derived Figma file target.
//
// This module deliberately does not scan argv. URLs in text, JSX, names,
// annotations, local paths, remote assets and unrelated option values remain
// payload. Only fields listed below are observed.

const FIGMA_NODE_URL_RE = /^(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)(?:[/?#]|$)/i;

const position = (index) => Object.freeze({ kind: 'position', index });
const range = (from) => Object.freeze({ kind: 'range', from });
const flag = (...names) => Object.freeze({ kind: 'flag', names: Object.freeze(names) });

// Every exposed top-level Command has an explicit closed projection contract.
// Most are intentionally empty. A newly exposed root must be classified here
// before Capability planning can start.
export const FIGMA_URL_TARGET_ROOTS = Object.freeze({
  render: 'none',
  'render-batch': 'none',
  create: 'semantic-fields',
  combos: 'semantic-fields',
  sizes: 'semantic-fields',
  node: 'semantic-fields',
  component: 'semantic-fields',
  tokens: 'semantic-fields',
  var: 'semantic-fields',
  col: 'none',
  style: 'semantic-fields',
  library: 'none',
  prototype: 'semantic-fields',
  measure: 'semantic-fields',
  shader: 'semantic-fields',
  layout: 'semantic-fields',
  slot: 'semantic-fields',
  draw: 'semantic-fields',
  section: 'semantic-fields',
  grid: 'semantic-fields',
  dev: 'semantic-fields',
  annotate: 'semantic-fields',
  a11y: 'semantic-fields',
  // `canvas page` owns a discriminated node/name/query request. Its closed
  // request projects only the explicit node variant during planning.
  canvas: 'semantic-fields',
  find: 'none',
  verify: 'semantic-fields',
  inspect: 'semantic-fields',
  export: 'semantic-fields',
  gradient: 'semantic-fields',
  pin: 'semantic-fields',
  api: 'none',
  import: 'none',
  motion: 'semantic-fields',
  extract: 'none',
  spec: 'semantic-fields',
  analyze: 'semantic-fields',
  font: 'semantic-fields',
  map: 'none',
  link: 'semantic-fields',
  contract: 'none',
  'verify-build': 'semantic-fields',
  history: 'semantic-fields',
  jam: 'semantic-fields',
  // Slides owns a discriminated node/name/label/query request. Its closed
  // request projects only the explicit node variant during planning.
  slides: 'semantic-fields',
  kit: 'semantic-fields',
});

const CREATE_WITH_PARENT = [
  'create.frame', 'create.rect', 'create.ellipse', 'create.polygon',
  'create.star', 'create.vector', 'create.slice', 'create.text',
  'create.line', 'create.autolayout',
];

/** @type {Record<string, readonly object[]>} */
const fields = {
  combos: [position(1)],

  'node.tree': [position(2)],
  'node.bindings': [position(2)],
  'node.css': [position(2)],
  'node.to-component': [range(2)],
  'node.group': [range(2), flag('--parent')],
  'node.ungroup': [position(2)],
  'node.boolean': [range(3), flag('--parent')],
  'node.flatten': [range(2), flag('--parent')],
  'node.duplicate': [position(2), flag('--parent')],
  'node.reparent': [position(2), position(3)],
  'node.move': [position(2)],
  'node.resize': [position(2)],
  'node.rename': [position(2)],
  'node.set-text': [position(2)],
  'node.set-fill': [position(2)],
  'node.set-image': [position(2)],
  'node.delete': [range(2)],
  'node.bind': [position(2)],
  'node.set': [position(2)],

  'component.create': [flag('--parent')],
  'component.instantiate': [position(2), flag('--parent')],
  'component.main': [position(2)],
  'component.swap': [position(2), position(3)],
  'component.detach': [position(2)],
  'component.overrides': [position(2)],
  'component.prop.add': [position(3)],
  'component.prop.list': [position(3)],
  'component.prop.set': [position(3)],
  'component.prop.delete': [position(3)],
  'component.combine': [position(2)],

  'tokens.rebind': [flag('-n', '--node')],
  'var.resolve': [position(3)],
  'style.apply': [position(3)],

  'prototype.inspect': [position(2)],
  'prototype.add': [position(2), flag('--navigate-to')],
  'prototype.set': [position(2)],
  'prototype.clear': [position(2)],

  'measure.list': [position(2)],
  'measure.add': [position(2), position(3)],
  'shader.apply': [position(2)],

  'layout.grid.inspect': [position(3)],
  'layout.grid.set': [position(3)],
  'layout.grid.place': [position(3), position(4)],
  'layout.grid.auto-flow': [position(3)],
  'layout.grid.reorder-rows': [position(3)],
  'layout.grid.reorder-columns': [position(3)],

  'slot.inspect': [position(2)],
  'slot.create': [position(2)],
  'slot.edit': [position(2)],
  'slot.validate': [position(2)],
  'slot.reset': [position(2)],

  'draw.inspect': [position(2)],
  'draw.text-path': [position(2)],
  'draw.transform-group': [position(2), flag('--parent')],
  'draw.brush': [position(2)],
  'draw.stroke-profile': [position(2)],
  'draw.pattern': [position(2), position(3)],

  'section.create': [position(3)],
  'section.fit': [position(2)],
  'section.arrange': [position(2)],
  'section.add': [position(2), position(3)],
  'grid.set': [position(2)],
  'grid.list': [position(2)],
  'grid.clear': [position(2)],

  'dev.link': [position(2)],
  'dev.list': [position(2)],
  'dev.unlink': [position(2)],
  'dev.edit': [position(2)],

  'annotate.add': [flag('-n', '--node')],
  'annotate.edit': [position(2)],
  'annotate.remove': [position(2)],
  'annotate.list': [position(2)],
  'annotate.clear': [position(2)],

  'a11y.contrast': [position(2)],
  'a11y.vision': [position(2)],
  'a11y.touch': [position(2)],
  'a11y.text': [position(2)],
  'a11y.focus': [position(2)],
  'a11y.audit': [position(2)],

  verify: [position(1)],
  inspect: [position(1)],
  'export.node': [position(2)],
  'export.video': [position(2)],
  'export.node-json': [position(2)],
  'export.css': [position(2)],
  'export.assets': [position(2)],
  'export.dtcg': [position(2), position(3)],
  'export.code-spec': [position(2)],

  'gradient.apply': [position(2)],
  'gradient.extract': [flag('--apply-to')],
  'gradient.mesh': [flag('--apply-to')],
  pin: [flag('-n', '--node')],

  'motion.add': [position(2)],
  'motion.preset': [position(2)],
  'motion.stagger': [position(2)],
  'motion.style': [position(2)],
  'motion.timeline': [position(2)],
  'motion.inspect': [position(2)],
  'motion.clear': [position(2)],
  spec: [flag('--check')],
  'analyze.lint': [flag('-n', '--node')],

  'font.bind': [position(2)],
  'font.unbind': [position(2)],
  'font.inspect': [position(2)],
  'font.axes': [position(2)],
  'font.remember-axes': [position(2)],
  'font.forget-axes': [position(2)],

  'link.set': [position(2)],
  'link.inspect': [position(2)],
  'verify-build': [flag('--node')],
  'history.snapshot': [flag('-n', '--node')],
  'history.diff': [flag('-n', '--node')],
  'jam.connector': [position(2), position(3)],
  'jam.arrange': [flag('--ids')],
  'kit.init': [flag('--node')],
};

for (const actionId of CREATE_WITH_PARENT) fields[actionId] = [flag('--parent')];

const TARGET_FIELDS_BY_ACTION = Object.freeze(Object.fromEntries(
  Object.entries(fields).map(([actionId, descriptors]) => [actionId, Object.freeze(descriptors)]),
));

function flagValues(args, names) {
  const accepted = new Set(names);
  const values = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break;
    if (typeof token !== 'string') continue;
    const equals = token.indexOf('=');
    if (equals !== -1 && accepted.has(token.slice(0, equals))) {
      values.push(token.slice(equals + 1));
      continue;
    }
    if (accepted.has(token) && typeof args[index + 1] === 'string') {
      values.push(args[index + 1]);
      index++;
    }
  }
  return values;
}

function rangeValues(args, from) {
  const values = [];
  let literal = false;
  for (let index = from; index < args.length; index++) {
    const value = args[index];
    if (!literal && value === '--') {
      literal = true;
      continue;
    }
    // Variadic node fields end when Commander options begin. Stopping instead
    // of skipping unknown option values keeps payload from entering targeting.
    if (!literal && typeof value === 'string' && value.startsWith('-')) break;
    values.push(value);
  }
  return values;
}

function descriptorValues(args, descriptor) {
  if (descriptor.kind === 'position') return [args[descriptor.index]];
  if (descriptor.kind === 'range') return rangeValues(args, descriptor.from);
  if (descriptor.kind === 'flag') return flagValues(args, descriptor.names);
  return [];
}

function fileKeysFromSemanticValue(value) {
  if (typeof value !== 'string') return [];
  const keys = [];
  for (const candidate of value.trim().split(/[\s,]+/)) {
    const match = FIGMA_NODE_URL_RE.exec(candidate);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * Resolve the sole file key named by target-bearing semantic fields.
 * Conflicting node URLs stop before confirmation or dispatch.
 */
export function projectFigmaUrlFileKey(args, actionId) {
  if (!Array.isArray(args) || typeof actionId !== 'string') return null;
  const root = String(args[0] || '');
  const contract = FIGMA_URL_TARGET_ROOTS[root];
  if (!contract) {
    throw new Error(`Figma URL target projection is not classified for command ${root || '(missing)'}.`);
  }
  if (contract === 'none' || actionId.endsWith('.help')) return null;
  const descriptors = TARGET_FIELDS_BY_ACTION[actionId] || [];
  const keys = new Set();
  for (const descriptor of descriptors) {
    for (const value of descriptorValues(args, descriptor)) {
      for (const key of fileKeysFromSemanticValue(value)) keys.add(key);
    }
  }
  if (keys.size > 1) {
    throw new Error('Figma Target Context conflict: target-bearing fields reference multiple Figma files.');
  }
  return keys.values().next().value || null;
}

/** Safe test/documentation projection; contains field kinds, never argv data. */
export function figmaUrlTargetProjectionContract(actionId) {
  return Object.freeze((TARGET_FIELDS_BY_ACTION[actionId] || []).map((descriptor) => Object.freeze({
    kind: descriptor.kind,
    index: descriptor.index ?? null,
    from: descriptor.from ?? null,
    flags: descriptor.names || Object.freeze([]),
  })));
}

export function listFigmaUrlTargetActions() {
  return Object.freeze(Object.keys(TARGET_FIELDS_BY_ACTION).sort());
}
