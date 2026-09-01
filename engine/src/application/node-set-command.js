import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_SET_TEXT_CODE_UNITS,
  NODE_SET_PROPERTIES,
  nodeSetArgvFromRequest,
  nodeSetPlanningArgvFromRequest,
  parseNodeSetRequest,
} from './node-set-request.js';

export { nodeSetArgvFromRequest, nodeSetPlanningArgvFromRequest } from './node-set-request.js';

const APPLICATION_ID = 'node.set';
export const MAX_NODE_SET_CANDIDATES = 100_000;
export const MAX_NODE_SET_LIST_ENTRIES = 10_000;
export const MAX_NODE_SET_SNAPSHOT_CODE_UNITS = 524_288;
export const MAX_NODE_SET_RESULT_CODE_UNITS = 65_536;
const MAX_ID_CODE_UNITS = 1_024;

const SCALARS = Object.freeze([
  ['strokeWidth', 'strokeWeight'], ['strokeTopWidth', 'strokeTopWeight'],
  ['strokeRightWidth', 'strokeRightWeight'], ['strokeBottomWidth', 'strokeBottomWeight'],
  ['strokeLeftWidth', 'strokeLeftWeight'], ['strokeMiterLimit', 'strokeMiterLimit'],
  ['strokeAlign', 'strokeAlign'], ['strokeCap', 'strokeCap'], ['strokeJoin', 'strokeJoin'],
  ['radius', 'cornerRadius'], ['cornerSmoothing', 'cornerSmoothing'],
  ['opacity', 'opacity'], ['blendMode', 'blendMode'], ['visible', 'visible'], ['locked', 'locked'],
  ['isMask', 'isMask'], ['maskType', 'maskType'], ['clip', 'clipsContent'],
  ['constrainProportions', 'constrainProportions'],
  ['x', 'x'], ['y', 'y'], ['rotation', 'rotation'], ['name', 'name'],
  ['minWidth', 'minWidth'], ['maxWidth', 'maxWidth'], ['minHeight', 'minHeight'], ['maxHeight', 'maxHeight'],
  ['layoutMode', 'layoutMode'], ['layoutWrap', 'layoutWrap'],
  ['primaryAxisAlign', 'primaryAxisAlignItems'], ['counterAxisAlign', 'counterAxisAlignItems'],
  ['layoutSizingHorizontal', 'layoutSizingHorizontal'], ['layoutSizingVertical', 'layoutSizingVertical'],
  ['layoutAlign', 'layoutAlign'], ['layoutPositioning', 'layoutPositioning'], ['layoutGrow', 'layoutGrow'],
  ['itemSpacing', 'itemSpacing'], ['counterAxisSpacing', 'counterAxisSpacing'],
  ['paddingTop', 'paddingTop'], ['paddingRight', 'paddingRight'],
  ['paddingBottom', 'paddingBottom'], ['paddingLeft', 'paddingLeft'],
  ['pointCount', 'pointCount'], ['innerRadius', 'innerRadius'],
  ['sectionContentsHidden', 'sectionContentsHidden'],
]);

function normalized(request) {
  return parseNodeSetRequest(nodeSetArgvFromRequest(request));
}

function js(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function nodeSetCode(request) {
  const input = normalized(request);
  return `(async () => {
    const nodeId = ${js(input.nodeId)}; const props = ${js(input.props)}; const collectionHint = ${js(input.collection)};
    const scalarFields = ${js(SCALARS)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (typeof value !== 'string' || value.length > ${MAX_NODE_SET_RESULT_CODE_UNITS}) throw new Error('Node Set result exceeded its bounded response limit.'); return value; };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const close = (left, right) => typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) <= 1e-6;
    const rotationMatches = (left, right) => close((((left - right) % 360) + 360) % 360, 0) || close((((right - left) % 360) + 360) % 360, 0);
    const json = (value) => { try { return JSON.stringify(value); } catch { return undefined; } };
    const copy = (value, label) => { const valueJson = json(value); if (typeof valueJson !== 'string' || valueJson.length > ${MAX_NODE_SET_SNAPSHOT_CODE_UNITS}) throw new Error(label + ' rollback snapshot exceeds its bounded limit.'); return JSON.parse(valueJson); };
    const aliasId = (paint) => { const alias = paint && paint.boundVariables && paint.boundVariables.color; return alias === undefined || alias === null ? null : alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' && alias.id.length <= ${MAX_ID_CODE_UNITS} ? alias.id : false; };
    const defaultPresentation = (paint) => (paint.opacity === undefined || close(paint.opacity, 1)) && (paint.visible === undefined || paint.visible === true) && (paint.blendMode === undefined || paint.blendMode === 'NORMAL');
    const nodeInfo = (value) => ({ id: value.id, name: clean(value.name, ${MAX_NODE_SET_TEXT_CODE_UNITS}), type: clean(value.type, 64) });
    const skip = (key, reason) => clean(key + ' (' + reason + ')', 1024);
    const hexToRgb = (input) => { const match = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(String(input)); return match ? { r: parseInt(match[1], 16) / 255, g: parseInt(match[2], 16) / 255, b: parseInt(match[3], 16) / 255 } : null; };

    let node; const operations = []; const skipped = []; let snapshotSize = 0;
    let variables = null; let collections = null;
    const remember = (operation) => { const serialized = json(operation.before); if (typeof serialized !== 'string') throw new Error(operation.key + ' rollback snapshot is unavailable.'); snapshotSize += serialized.length; if (snapshotSize > ${MAX_NODE_SET_SNAPSHOT_CODE_UNITS}) throw new Error('Node Set rollback journal exceeds its bounded limit.'); operations.push(operation); };
    const resolvePaint = async (input) => {
      if (typeof input === 'string' && input.startsWith('var:')) {
        const reference = input.slice(4);
        if (!variables) {
          variables = await figma.variables.getLocalVariablesAsync(); collections = await figma.variables.getLocalVariableCollectionsAsync();
          if (!Array.isArray(variables) || variables.length > ${MAX_NODE_SET_CANDIDATES} || !Array.isArray(collections) || collections.length > ${MAX_NODE_SET_CANDIDATES}) throw new Error('Node Set Variable candidate limit exceeded.');
          if (variables.some((item) => !item || typeof item.id !== 'string' || item.id.length > ${MAX_ID_CODE_UNITS} || typeof item.name !== 'string' || item.name.length > ${MAX_NODE_SET_TEXT_CODE_UNITS} || typeof item.variableCollectionId !== 'string' || item.variableCollectionId.length > ${MAX_ID_CODE_UNITS})
            || collections.some((item) => !item || typeof item.id !== 'string' || item.id.length > ${MAX_ID_CODE_UNITS} || typeof item.name !== 'string' || item.name.length > ${MAX_NODE_SET_TEXT_CODE_UNITS})) throw new Error('Node Set Variable metadata is invalid or too long.');
        }
        let pool = variables;
        if (collectionHint) {
          const query = collectionHint.toLowerCase();
          const exactCollections = collections.filter((item) => item && typeof item.name === 'string' && item.name.toLowerCase() === query);
          const matchingCollections = exactCollections.length ? exactCollections : collections.filter((item) => item && typeof item.name === 'string' && item.name.toLowerCase().includes(query));
          if (matchingCollections.length !== 1) throw new Error(matchingCollections.length ? 'collection reference is ambiguous; use its exact name' : 'no collection matching "' + collectionHint + '"');
          pool = variables.filter((item) => item && item.variableCollectionId === matchingCollections[0].id);
        }
        const exact = pool.filter((item) => item && item.name === reference);
        const tail = pool.filter((item) => item && typeof item.name === 'string' && item.name.endsWith('/' + reference));
        const matches = exact.length ? exact : tail;
        if (matches.length !== 1) throw new Error(matches.length ? matches.length + ' variables match "' + reference + '" — narrow with --collection' : 'no variable named "' + reference + '"');
        const variable = matches[0];
        if (typeof variable.id !== 'string' || !variable.id.length || variable.id.length > ${MAX_ID_CODE_UNITS}) throw new Error('Variable identity is invalid or too long.');
        if (variable.resolvedType !== 'COLOR') throw new Error("Variable " + reference + " resolvedType !== 'COLOR'");
        return { paint: figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable), expected: { kind: 'variable', id: variable.id } };
      }
      const rgb = hexToRgb(input);
      if (!rgb) throw new Error('not a six-digit hex colour or var: reference: ' + input);
      return { paint: { type: 'SOLID', color: rgb }, expected: { kind: 'literal', rgb } };
    };

    try {
      node = await figma.getNodeByIdAsync(nodeId);
      if (!node || node.id !== nodeId || node.type === 'DOCUMENT' || node.type === 'PAGE' || typeof node.name !== 'string' || typeof node.type !== 'string') throw new Error('Node Set requires one exact mutable canvas Node.');
      for (const key of ['fill', 'stroke']) {
        if (!(key in props)) continue;
        const field = key === 'fill' ? 'fills' : 'strokes';
        if (!(field in node)) { skipped.push(skip(key, node.type + ' has no ' + field)); continue; }
        const before = node[field];
        if (!Array.isArray(before) || before.length > ${MAX_NODE_SET_LIST_ENTRIES}) throw new Error(key + ' requires one bounded non-mixed Paint list.');
        const desired = await resolvePaint(props[key]);
        remember({ key, kind: 'paint', field, before: copy(before, key), desired: desired.paint, expected: desired.expected });
      }
      for (const [key, field] of scalarFields) {
        if (!(key in props)) continue;
        if (!(field in node)) { skipped.push(skip(key, node.type + ' has no ' + field)); continue; }
        if (key === 'radius' && node[field] === figma.mixed) {
          const corners = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
          if (corners.some((corner) => !(corner in node))) { skipped.push(skip(key, node.type + ' has no restorable individual corners')); continue; }
          remember({ key, kind: 'mixed-radius', field, before: corners.map((corner) => node[corner]), fields: corners, desired: props[key] });
        } else {
          remember({ key, kind: key === 'rotation' ? 'rotation' : 'scalar', field, before: copy(node[field], key), desired: props[key] });
        }
      }
      if ('padding' in props) {
        const fields = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
        if (fields.some((field) => !(field in node))) skipped.push(skip('padding', node.type + ' has no Auto Layout padding'));
        else remember({ key: 'padding', kind: 'fields', fields, before: fields.map((field) => copy(node[field], 'padding')), desired: fields.map(() => props.padding) });
      }
      if ('radii' in props) {
        const fields = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
        if (fields.some((field) => !(field in node))) skipped.push(skip('radii', node.type + ' has no individual corners'));
        else remember({ key: 'radii', kind: 'fields', fields, before: fields.map((field) => copy(node[field], 'radii')), desired: props.radii });
      }
      if ('dashPattern' in props) {
        if (!('dashPattern' in node)) skipped.push(skip('dashPattern', node.type + ' has no strokes'));
        else if (!Array.isArray(node.dashPattern) || node.dashPattern.length > ${MAX_NODE_SET_LIST_ENTRIES}) throw new Error('dashPattern rollback snapshot is not a bounded list.');
        else remember({ key: 'dashPattern', kind: 'array', field: 'dashPattern', before: copy(node.dashPattern, 'dashPattern'), desired: props.dashPattern });
      }
      if ('effects' in props) {
        if (!('effects' in node)) skipped.push(skip('effects', node.type + ' has no effects'));
        else if (!Array.isArray(node.effects) || node.effects.length > ${MAX_NODE_SET_LIST_ENTRIES}) throw new Error('effects rollback snapshot is not a bounded list.');
        else remember({ key: 'effects', kind: 'array', field: 'effects', before: copy(node.effects, 'effects'), desired: props.effects });
      }
      if ('constraintsHorizontal' in props || 'constraintsVertical' in props) {
        if (!('constraints' in node)) skipped.push(skip('constraints', node.type + ' has no constraints'));
        else {
          const before = copy(node.constraints, 'constraints');
          if (!before || typeof before.horizontal !== 'string' || typeof before.vertical !== 'string') throw new Error('constraints rollback snapshot is invalid.');
          remember({ key: 'constraints', kind: 'constraints', field: 'constraints', before, desired: { horizontal: props.constraintsHorizontal ?? before.horizontal, vertical: props.constraintsVertical ?? before.vertical } });
        }
      }
      if ('width' in props && 'height' in props) {
        if (typeof node.resize !== 'function') skipped.push(skip('size', node.type + ' cannot resize'));
        else remember({ key: 'size', kind: 'size', before: [copy(node.width, 'width'), copy(node.height, 'height')], desired: [props.width, props.height] });
      }
      if (!operations.length) throw new Error('nothing applied — ' + skipped.join(', '));
    } catch (error) { return refusal(error); }

    const paintMatches = (paint, expected) => {
      if (!paint || paint.type !== 'SOLID' || !defaultPresentation(paint)) return false;
      if (expected.kind === 'variable') return aliasId(paint) === expected.id;
      return aliasId(paint) === null && paint.color && close(paint.color.r, expected.rgb.r) && close(paint.color.g, expected.rgb.g) && close(paint.color.b, expected.rgb.b);
    };
    const matches = (target, operation, desired) => {
      if (!target) return false;
      if (operation.kind === 'paint') return Array.isArray(target[operation.field]) && target[operation.field].length === 1 && paintMatches(target[operation.field][0], operation.expected);
      if (operation.kind === 'mixed-radius') return close(target[operation.field], desired);
      if (operation.kind === 'scalar') return typeof desired === 'number' ? close(target[operation.field], desired) : target[operation.field] === desired;
      if (operation.kind === 'rotation') return rotationMatches(target[operation.field], desired);
      if (operation.kind === 'fields') return operation.fields.every((field, index) => close(target[field], desired[index]));
      if (operation.kind === 'array') return json(target[operation.field]) === json(desired);
      if (operation.kind === 'constraints') return target.constraints && target.constraints.horizontal === desired.horizontal && target.constraints.vertical === desired.vertical;
      if (operation.kind === 'size') return close(target.width, desired[0]) && close(target.height, desired[1]);
      return false;
    };
    const beforeMatches = (target, operation) => {
      if (!target) return false;
      if (operation.kind === 'paint' || operation.kind === 'array') return json(target[operation.field]) === json(operation.before);
      if (operation.kind === 'mixed-radius') return operation.fields.every((field, index) => close(target[field], operation.before[index]));
      if (operation.kind === 'scalar') return typeof operation.before === 'number' ? close(target[operation.field], operation.before) : target[operation.field] === operation.before;
      if (operation.kind === 'rotation') return rotationMatches(target[operation.field], operation.before);
      if (operation.kind === 'fields') return operation.fields.every((field, index) => close(target[field], operation.before[index]));
      if (operation.kind === 'constraints') return target.constraints && target.constraints.horizontal === operation.before.horizontal && target.constraints.vertical === operation.before.vertical;
      if (operation.kind === 'size') return close(target.width, operation.before[0]) && close(target.height, operation.before[1]);
      return false;
    };
    const applyOne = (operation) => {
      if (operation.kind === 'paint') node[operation.field] = [operation.desired];
      else if (operation.kind === 'mixed-radius' || operation.kind === 'scalar' || operation.kind === 'rotation' || operation.kind === 'array' || operation.kind === 'constraints') node[operation.field] = operation.desired;
      else if (operation.kind === 'fields') operation.fields.forEach((field, index) => { node[field] = operation.desired[index]; });
      else if (operation.kind === 'size') node.resize(operation.desired[0], operation.desired[1]);
    };
    const restoreOne = (operation) => {
      if (operation.kind === 'mixed-radius') operation.fields.forEach((field, index) => { node[field] = operation.before[index]; });
      else if (operation.kind === 'fields') operation.fields.forEach((field, index) => { node[field] = operation.before[index]; });
      else if (operation.kind === 'size') node.resize(operation.before[0], operation.before[1]);
      else node[operation.field] = operation.before;
    };
    const apply = async () => {
      for (const operation of operations) applyOne(operation);
    };
    const restore = async () => {
      for (let index = operations.length - 1; index >= 0; index--) { try { restoreOne(operations[index]); } catch {} }
    };
    const applied = operations.map((operation) => operation.key);
    let failure = 'Node Set fresh postcondition did not match every requested property.';
    try {
      const current = await figma.getNodeByIdAsync(nodeId);
      if (operations.every((operation) => matches(current, operation, operation.desired))) return bounded({ schemaVersion: 1, status: 'applied', node: nodeInfo(current), applied, skipped, attempted: 0, residue: [] });
      try { await apply(); } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      const fresh = await figma.getNodeByIdAsync(nodeId);
      if (operations.every((operation) => matches(fresh, operation, operation.desired))) { delete globalThis.__invCache; return bounded({ schemaVersion: 1, status: 'applied', node: nodeInfo(fresh), applied, skipped, attempted: 1, residue: [] }); }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
    try {
      await restore();
      const restoredNode = await figma.getNodeByIdAsync(nodeId);
      const residue = operations.filter((operation) => !beforeMatches(restoredNode, operation)).map((operation) => operation.key);
      const restored = residue.length === 0;
      if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, failure, node: nodeInfo(restoredNode), residue });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure, node: nodeInfo(node), residue: [] });
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validNode(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.nodeId
    && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name, MAX_NODE_SET_TEXT_CODE_UNITS)
    && text(value.type, 64, false);
}

function logicalKeys(input) {
  const keys = [];
  for (const key of ['fill', 'stroke']) if (Object.hasOwn(input.props, key)) keys.push(key);
  for (const [key] of SCALARS) if (Object.hasOwn(input.props, key)) keys.push(key);
  for (const key of ['padding', 'radii', 'dashPattern', 'effects']) if (Object.hasOwn(input.props, key)) keys.push(key);
  if (Object.hasOwn(input.props, 'constraintsHorizontal') || Object.hasOwn(input.props, 'constraintsVertical')) keys.push('constraints');
  if (Object.hasOwn(input.props, 'width') && Object.hasOwn(input.props, 'height')) keys.push('size');
  return keys;
}

function validResultPartition(value, input) {
  const requested = logicalKeys(input);
  if (!Array.isArray(value.applied) || !Array.isArray(value.skipped)
    || value.applied.some((key) => !text(key, 64, false))
    || value.skipped.some((entry) => !text(entry, 1_024, false))) return false;
  const applied = new Set(value.applied);
  if (applied.size !== value.applied.length
    || requested.filter((key) => applied.has(key)).join(',') !== value.applied.join(',')) return false;
  const skippedKeys = value.skipped.map((entry) => requested.find((key) => entry.startsWith(`${key} (`)));
  return skippedKeys.every(Boolean) && new Set(skippedKeys).size === skippedKeys.length
    && requested.every((key) => applied.has(key) || skippedKeys.includes(key));
}

function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && text(value.failure, 1_024, false);
}

function validSuccess(value, input) {
  return exact(value, ['schemaVersion', 'status', 'node', 'applied', 'skipped', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'applied' && validNode(value.node, input)
    && validResultPartition(value, input) && value.applied.length > 0 && [0, 1].includes(value.attempted)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  const allowed = new Set(logicalKeys(input));
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'node', 'residue'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored) && text(value.failure, 1_024, false)
    && validNode(value.node, input) && Array.isArray(value.residue)
    && value.residue.every((key) => text(key, 64, false) && allowed.has(key))
    && new Set(value.residue).size === value.residue.length
    && (value.outcome === 'rolled-back' ? value.restored === 1 && value.residue.length === 0 : value.restored === 0)
    && (value.outcome !== 'partial-residue' || value.residue.length > 0);
}

function mutationError(message, outcome, attempted, restored, residueCount) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome,
    mutationReport: { version: 1, outcome, attempted, restored, residueCount },
  });
  return error;
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
  return error;
}

export function formatNodeSetResult(result) {
  const lines = [`${result.node.name} (${result.node.id}): ${result.applied.join(', ')}`];
  for (const entry of result.skipped) lines.push(`    skipped ${entry}`);
  return lines.join('\n');
}

export async function executeNodeSet(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Set requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(nodeSetCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_SET_RESULT_CODE_UNITS) throw invalid('Node Set returned an invalid bounded result.');
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Node Set returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Node Set returned an invalid bounded result.');
    throw mutationError(`Node Set made no mutation: ${payload.failure}`, 'no-mutation', 0, 0, 0);
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw invalid('Node Set returned an invalid bounded result.');
    throw mutationError(`Node Set failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, 1, payload.restored, payload.residue.length);
  }
  if (!validSuccess(payload, input)) throw invalid('Node Set returned an invalid bounded result.');
  return { stdout: formatNodeSetResult(payload), stderr: '', result: payload };
}

export function nodeSetPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Set routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-set';
}

export async function executeNodeSetPlan(plan, adapters = {}) {
  if (nodeSetPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Set.`);
  return executeNodeSet(parseNodeSetRequest(plan.argv), adapters);
}
