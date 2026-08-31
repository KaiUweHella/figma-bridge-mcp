// Plan-bound, exact and rollback-owned `grid set|clear` Layout Guide mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { isExactLayoutGridList } from './layout-grid-contract.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  layoutGuideMutationArgvFromRequest,
  layoutGuideMutationPlanningArgvFromRequest,
  parseLayoutGuideMutationRequest,
} from './layout-guide-mutation-request.js';

export {
  layoutGuideMutationArgvFromRequest,
  layoutGuideMutationPlanningArgvFromRequest,
} from './layout-guide-mutation-request.js';

const APPLICATION_IDS = new Set(['grid.set', 'grid.clear']);
export const MAX_LAYOUT_GUIDE_MUTATION_GRIDS = 1_024;
export const MAX_LAYOUT_GUIDE_MUTATION_RESULT_CODE_UNITS = 500_000;
export const MAX_LAYOUT_GUIDE_MUTATION_SNAPSHOT_CODE_UNITS = 200_000;
const MAX_NAME_CODE_UNITS = 1_024;
const MAX_STYLE_ID_CODE_UNITS = 1_024;
const MAX_FAILURE_CODE_UNITS = 1_024;
const MAX_CONTAINER_ENTRIES = 1_024;
const VERIFY_EPSILON = 0.000001;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseLayoutGuideMutationRequest(
  layoutGuideMutationArgvFromRequest(request));

function rgb(hex) {
  return [0, 2, 4].map((index) => parseInt(hex.slice(index + 1, index + 3), 16) / 255);
}

function newGrids(input) {
  if (input.action === 'clear') return [];
  const [r, g, b] = rgb(input.color);
  const common = {
    alignment: input.alignment,
    gutterSize: input.gutter,
    offset: input.margin,
    color: { r, g, b, a: input.opacity },
    visible: true,
  };
  return [
    ...(input.columns === null ? [] : [{ pattern: 'COLUMNS', count: input.columns, ...common }]),
    ...(input.rows === null ? [] : [{ pattern: 'ROWS', count: input.rows, ...common }]),
  ];
}

function expectedState(before, input) {
  const added = newGrids(input);
  return {
    gridStyleId: '',
    layoutGrids: input.action === 'set' && input.append
      ? [...before.layoutGrids, ...added] : added,
  };
}

export function layoutGuideMutationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${JSON.stringify(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_LAYOUT_GUIDE_MUTATION_RESULT_CODE_UNITS}) {
        throw new Error('Layout Guide mutation result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    const rgba = (value) => value && typeof value === 'object' && !Array.isArray(value)
      && ['r', 'g', 'b', 'a'].every((field) => finite(value[field]));
    const aliases = (value, fields) => {
      if (value === undefined) return undefined;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Layout Guide mutation found invalid Variable bindings.');
      }
      const entries = Object.entries(value);
      if (entries.length > ${MAX_CONTAINER_ENTRIES}
        || entries.some(([field, alias]) => !fields.includes(field)
          || !alias || alias.type !== 'VARIABLE_ALIAS'
          || typeof alias.id !== 'string' || alias.id.length === 0
          || alias.id.length > ${MAX_STYLE_ID_CODE_UNITS})) {
        throw new Error('Layout Guide mutation found invalid Variable bindings.');
      }
      return Object.fromEntries(entries.map(([field, alias]) => [field, {
        type: 'VARIABLE_ALIAS', id: alias.id,
      }]));
    };
    const projectGrid = (grid) => {
      if (!grid || typeof grid !== 'object' || Array.isArray(grid)
        || !['GRID', 'ROWS', 'COLUMNS'].includes(grid.pattern)) {
        throw new Error('Layout Guide mutation found an invalid grid.');
      }
      if (grid.pattern === 'GRID') {
        if (!finite(grid.sectionSize)
          || (grid.visible !== undefined && typeof grid.visible !== 'boolean')
          || (grid.color !== undefined && !rgba(grid.color))) {
          throw new Error('Layout Guide mutation found invalid square-grid facts.');
        }
        return {
          pattern: 'GRID', sectionSize: grid.sectionSize,
          ...(grid.visible === undefined ? {} : { visible: grid.visible }),
          ...(grid.color === undefined ? {} : { color: { ...grid.color } }),
          ...(grid.boundVariables === undefined ? {} : {
            boundVariables: aliases(grid.boundVariables, ['sectionSize']),
          }),
        };
      }
      if (!['MIN', 'MAX', 'STRETCH', 'CENTER'].includes(grid.alignment)
        || !finite(grid.gutterSize)
        || !(finite(grid.count) || grid.count === Infinity)
        || (grid.sectionSize !== undefined && !finite(grid.sectionSize))
        || (grid.offset !== undefined && !finite(grid.offset))
        || (grid.visible !== undefined && typeof grid.visible !== 'boolean')
        || (grid.color !== undefined && !rgba(grid.color))) {
        throw new Error('Layout Guide mutation found invalid row or column facts.');
      }
      return {
        pattern: grid.pattern, alignment: grid.alignment,
        gutterSize: grid.gutterSize,
        count: grid.count === Infinity ? { $figmaScalar: 'Infinity' } : grid.count,
        ...(grid.sectionSize === undefined ? {} : { sectionSize: grid.sectionSize }),
        ...(grid.offset === undefined ? {} : { offset: grid.offset }),
        ...(grid.visible === undefined ? {} : { visible: grid.visible }),
        ...(grid.color === undefined ? {} : { color: { ...grid.color } }),
        ...(grid.boundVariables === undefined ? {} : {
          boundVariables: aliases(
            grid.boundVariables, ['sectionSize', 'count', 'offset', 'gutterSize']),
        }),
      };
    };
    const snapshot = async () => {
      const node = await figma.getNodeByIdAsync(request.nodeId);
      if (!node || node.id !== request.nodeId
        || typeof node.id !== 'string' || !nodeIdPattern.test(node.id)
        || node.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || typeof node.name !== 'string' || node.name.length > ${MAX_NAME_CODE_UNITS}
        || typeof node.type !== 'string' || node.type.length === 0 || node.type.length > 64
        || !('layoutGrids' in node) || !('gridStyleId' in node)
        || typeof node.setGridStyleIdAsync !== 'function'
        || !Array.isArray(node.layoutGrids)
        || node.layoutGrids.length > ${MAX_LAYOUT_GUIDE_MUTATION_GRIDS}
        || typeof node.gridStyleId !== 'string'
        || node.gridStyleId.length > ${MAX_STYLE_ID_CODE_UNITS}) {
        throw new Error('Layout Guide mutation requires one exact bounded grid-capable node.');
      }
      const value = {
        gridStyleId: node.gridStyleId,
        layoutGrids: node.layoutGrids.map(projectGrid),
      };
      if (JSON.stringify(value).length > ${MAX_LAYOUT_GUIDE_MUTATION_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Layout Guide mutation snapshot exceeded its bounded limit.');
      }
      return { node, nativeGrids: [...node.layoutGrids], value };
    };
    const close = (left, right) => Math.abs(left - right) <= ${VERIFY_EPSILON};
    const same = (left, right) => {
      const compare = (a, b) => {
        if (typeof a === 'number' || typeof b === 'number') {
          return typeof a === 'number' && typeof b === 'number' && close(a, b);
        }
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
        if (Array.isArray(a) || Array.isArray(b)) {
          return Array.isArray(a) && Array.isArray(b) && a.length === b.length
            && a.every((item, index) => compare(item, b[index]));
        }
        const keysA = Object.keys(a), keysB = Object.keys(b);
        return keysA.length === keysB.length && keysA.every(
          (key) => Object.hasOwn(b, key) && compare(a[key], b[key]));
      };
      return left.gridStyleId === right.gridStyleId
        && compare(left.layoutGrids, right.layoutGrids);
    };
    const newGrids = () => {
      if (request.action === 'clear') return [];
      const hex = request.color.slice(1);
      const color = {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: request.opacity,
      };
      const common = {
        alignment: request.alignment, gutterSize: request.gutter,
        offset: request.margin, color, visible: true,
      };
      return [
        ...(request.columns === null ? [] : [{ pattern: 'COLUMNS', count: request.columns, ...common }]),
        ...(request.rows === null ? [] : [{ pattern: 'ROWS', count: request.rows, ...common }]),
      ];
    };
    const expected = (before) => ({
      gridStyleId: '',
      layoutGrids: request.action === 'set' && request.append
        ? [...before.layoutGrids, ...newGrids()] : newGrids(),
    });
    const identity = (node) => ({
      id: clean(node.id, ${MAX_NODE_REFERENCE_CODE_UNITS}),
      name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
      type: clean(node.type, 64),
    });
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Layout Guide mutation preflight failed'),
    });
    const success = (status, outcome, attempted, node, before, actual, warnings) => bounded({
      schemaVersion: 1, status, outcome, attempted, restored: 0, residueCount: 0,
      node: identity(node), request, before, actual, warnings,
    });
    const failed = (outcome, restored, residueCount, node, before, actual, failure) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored,
      residueCount, node: identity(node), request, before, actual,
      failure: failureText(failure, 'fresh Layout Guide postcondition failed'),
    });

    let node;
    let nativeBefore;
    let before;
    let desired;
    try {
      const captured = await snapshot();
      node = captured.node;
      nativeBefore = captured.nativeGrids;
      before = captured.value;
      desired = expected(before);
      if (desired.layoutGrids.length > ${MAX_LAYOUT_GUIDE_MUTATION_GRIDS}) {
        throw new Error('Layout Guide mutation exceeds the bounded grid count.');
      }
    } catch (error) { return refusal(error); }
    if (same(before, desired)) {
      return success('unchanged', 'no-mutation', 0, node, before, before, []);
    }
    try {
      const current = await snapshot();
      if (!same(current.value, before)) {
        return refusal(new Error('Layout Guide mutation precondition changed before mutation.'));
      }
      node = current.node;
      nativeBefore = current.nativeGrids;
    } catch (error) { return refusal(error); }

    let mutationError = null;
    try {
      const additions = newGrids();
      node.layoutGrids = request.action === 'set' && request.append
        ? [...node.layoutGrids, ...additions] : additions;
    } catch (error) { mutationError = error; }
    let failure = mutationError;
    try {
      const after = await snapshot();
      if (same(after.value, desired)) {
        delete globalThis.__invCache;
        return success(request.action === 'clear' ? 'cleared' : 'set',
          mutationError ? 'verified-after-error' : 'verified', 1,
          after.node, before, after.value,
          mutationError ? [failureText(mutationError, 'native acknowledgement failed')] : []);
      }
      if (same(after.value, before)) {
        return failed('unchanged', 0, 1, after.node, before, after.value,
          mutationError || new Error('Fresh Layout Guide postcondition was unchanged.'));
      }
      failure ||= new Error('Fresh Layout Guide postcondition failed.');
    } catch (error) { failure ||= error; }

    try {
      const rollback = await figma.getNodeByIdAsync(request.nodeId);
      if (!rollback || rollback.id !== request.nodeId) {
        throw new Error('Layout Guide rollback identity is unavailable.');
      }
      if (before.gridStyleId) await rollback.setGridStyleIdAsync(before.gridStyleId);
      else rollback.layoutGrids = nativeBefore;
    } catch (error) { failure ||= error; }
    try {
      const restored = await snapshot();
      if (same(restored.value, before)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, 0, restored.node, before, restored.value, failure);
      }
      let residueCount = restored.value.gridStyleId === before.gridStyleId ? 0 : 1;
      if (!same({ gridStyleId: '', layoutGrids: restored.value.layoutGrids },
        { gridStyleId: '', layoutGrids: before.layoutGrids })) {
        residueCount += Math.max(1, Math.abs(
          restored.value.layoutGrids.length - before.layoutGrids.length));
      }
      return failed('partial-residue', 0, residueCount,
        restored.node, before, restored.value, failure);
    } catch (error) {
      return failed('verification-unavailable', 0, 1, node, before, null, failure || error);
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
function validState(value) {
  return exact(value, ['gridStyleId', 'layoutGrids'])
    && text(value.gridStyleId, MAX_STYLE_ID_CODE_UNITS)
    && isExactLayoutGridList(value.layoutGrids, {
      maxEntries: MAX_LAYOUT_GUIDE_MUTATION_GRIDS,
      maxLabelCodeUnits: MAX_STYLE_ID_CODE_UNITS,
    })
    && JSON.stringify(value).length <= MAX_LAYOUT_GUIDE_MUTATION_SNAPSHOT_CODE_UNITS;
}
function close(left, right) { return Math.abs(left - right) <= VERIFY_EPSILON; }
function sameValue(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    return typeof left === 'number' && typeof right === 'number' && close(left, right);
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
function sameState(left, right) {
  return left.gridStyleId === right.gridStyleId
    && sameValue(left.layoutGrids, right.layoutGrids);
}
function validNode(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.nodeId
    && text(value.id, MAX_NODE_REFERENCE_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, MAX_NAME_CODE_UNITS) && text(value.type, 64, false);
}
function validRequest(value, input) {
  return exact(value, [
    'action', 'nodeId', 'columns', 'rows', 'gutter', 'margin',
    'alignment', 'color', 'opacity', 'append', 'warning',
  ]) && Object.keys(input).every((key) => sameValue(value[key], input[key]));
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
const SUCCESS_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'node', 'request', 'before', 'actual', 'warnings',
];
function validSuccess(value, input) {
  if (!exact(value, SUCCESS_KEYS) || value.schemaVersion !== 1
    || !['unchanged', 'set', 'cleared'].includes(value.status)
    || !['no-mutation', 'verified', 'verified-after-error'].includes(value.outcome)
    || !validNode(value.node, input) || !validRequest(value.request, input)
    || !validState(value.before) || !validState(value.actual)
    || value.restored !== 0 || value.residueCount !== 0
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || !value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false))) return false;
  const desired = expectedState(value.before, input);
  if (!validState(desired) || !sameState(value.actual, desired)) return false;
  if (value.outcome === 'no-mutation') {
    return value.status === 'unchanged' && value.attempted === 0
      && value.warnings.length === 0 && sameState(value.before, value.actual);
  }
  return value.status === (input.action === 'clear' ? 'cleared' : 'set')
    && value.attempted === 1
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
const FAILURE_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'node', 'request', 'before', 'actual', 'failure',
];
function validFailure(value, input) {
  if (!exact(value, FAILURE_KEYS) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !Number.isSafeInteger(value.residueCount) || value.residueCount < 0
    || value.residueCount > MAX_LAYOUT_GUIDE_MUTATION_GRIDS + 1
    || !validNode(value.node, input) || !validRequest(value.request, input)
    || !validState(value.before) || !text(value.failure, MAX_FAILURE_CODE_UNITS, false)) return false;
  if (value.outcome === 'verification-unavailable') {
    return value.restored === 0 && value.residueCount === 1 && value.actual === null;
  }
  if (!validState(value.actual)) return false;
  const restored = sameState(value.before, value.actual);
  const desired = sameState(expectedState(value.before, input), value.actual);
  if (value.outcome === 'unchanged') {
    return value.restored === 0 && value.residueCount === 1 && restored && !desired;
  }
  if (value.outcome === 'rolled-back') {
    return value.restored === 1 && value.residueCount === 0 && restored;
  }
  return value.restored === 0 && value.residueCount > 0 && !restored && !desired;
}
function pluginResultError(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch',
  });
  return error;
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report,
  });
  return error;
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS, ' '); }

export function formatLayoutGuideMutationResult(result) {
  const verb = result.request.action === 'clear' ? 'Cleared grids on' : 'Set grid on';
  return `✓ ${verb} ${safeText(result.node.name)} (${result.node.id})\n`
    + `  Total grids: ${result.actual.layoutGrids.length}`;
}

export async function executeLayoutGuideMutation(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Layout Guide mutation requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(layoutGuideMutationCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_LAYOUT_GUIDE_MUTATION_RESULT_CODE_UNITS) {
    throw pluginResultError('Layout Guide mutation returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Layout Guide mutation returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Layout Guide mutation returned an invalid bounded result.');
    throw mutationError(`Layout Guide mutation made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Layout Guide mutation returned an invalid bounded result.');
    }
    throw mutationError(`Layout Guide mutation failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Layout Guide mutation returned an invalid bounded result.');
  }
  const warnings = [input.warning, ...payload.warnings].filter(Boolean);
  return {
    stdout: formatLayoutGuideMutationResult(payload),
    stderr: warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function layoutGuideMutationPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Layout Guide mutation routing requires a Command Plan.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-layout-guide-mutation';
}
export function executeLayoutGuideMutationPlan(plan, adapters = {}) {
  if (layoutGuideMutationPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Layout Guide mutation.');
  }
  return executeLayoutGuideMutation(parseLayoutGuideMutationRequest(plan.argv), adapters);
}
