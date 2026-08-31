// Rollback-verified Command Application for the mutating `a11y vision` simulation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  A11Y_VISION_TYPES,
  a11yVisionArgvFromRequest,
  a11yVisionPlanningArgvFromRequest,
  parseA11yVisionRequest,
} from './a11y-vision-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  a11yVisionArgvFromRequest,
  a11yVisionPlanningArgvFromRequest,
} from './a11y-vision-request.js';

const APPLICATION_ID = 'a11y.vision';
export const MAX_A11Y_VISION_NODES = 50_000;
export const MAX_A11Y_VISION_PAINTS = 200_000;
export const MAX_A11Y_VISION_COLORS = 512;
export const MAX_A11Y_VISION_PARENT_CHILDREN = 50_000;
export const MAX_A11Y_VISION_RESULT_CODE_UNITS = 1_000_000;
const MAX_LABEL_CODE_UNITS = 1024;
const VERIFY_EPSILON = 0.01;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

const normalized = (request) => parseA11yVisionRequest(a11yVisionArgvFromRequest(request));

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function a11yVisionCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${jsValue(input)};
    const types = request.type === 'all'
      ? ${jsValue(A11Y_VISION_TYPES)} : [request.type];
    const matrices = {
      protanopia: [
        0.152286, 1.052583, -0.204868,
        0.114503, 0.786281, 0.099216,
        -0.003882, -0.048116, 1.051998,
      ],
      deuteranopia: [
        0.367322, 0.860646, -0.227968,
        0.280085, 0.672501, 0.047413,
        -0.011820, 0.042940, 0.968881,
      ],
      tritanopia: [
        1.255528, -0.076749, -0.178779,
        -0.078411, 0.930809, 0.147602,
        0.004733, 0.691367, 0.303900,
      ],
      achromatopsia: [
        0.2126, 0.7152, 0.0722,
        0.2126, 0.7152, 0.0722,
        0.2126, 0.7152, 0.0722,
      ],
    };
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    const finiteCoordinate = (value) => finite(value)
      && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE * 2};
    const unit = (value) => finite(value) && value >= 0 && value <= 1;
    const close = (left, right) => finite(left) && finite(right)
      && Math.abs(left - right) <= ${VERIFY_EPSILON};
    const cleanFailure = (error) => String(error && error.message || error || 'A11y Vision failed')
      .slice(0, 1024)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_A11Y_VISION_RESULT_CODE_UNITS}) {
        throw new Error('A11y Vision result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const validId = (value) => typeof value === 'string'
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const validName = (value) => typeof value === 'string'
      && value.length <= ${MAX_LABEL_CODE_UNITS};
    const childIds = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)
        || parent.children.length > ${MAX_A11Y_VISION_PARENT_CHILDREN}) {
        throw new Error(label + ' returned invalid bounded child membership.');
      }
      const ids = parent.children.map((child) => child && child.id);
      if (ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
        throw new Error(label + ' returned invalid child identity.');
      }
      return ids;
    };
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const applyMatrix = (color, matrix) => ({
      r: Math.max(0, Math.min(1,
        matrix[0] * color.r + matrix[1] * color.g + matrix[2] * color.b)),
      g: Math.max(0, Math.min(1,
        matrix[3] * color.r + matrix[4] * color.g + matrix[5] * color.b)),
      b: Math.max(0, Math.min(1,
        matrix[6] * color.r + matrix[7] * color.g + matrix[8] * color.b)),
    });
    const toHex = (color) => '#' + [color.r, color.g, color.b]
      .map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
    const paintFacts = (root, label) => {
      const stack = [root];
      const paints = [];
      const colors = new Map();
      let nodes = 0;
      while (stack.length > 0) {
        const node = stack.pop();
        nodes += 1;
        if (nodes > ${MAX_A11Y_VISION_NODES} || !node || !validId(node.id)
          || typeof node.type !== 'string' || node.type.length === 0 || node.type.length > 64
          || !validName(node.name)) {
          throw new Error(label + ' exceeded the bounded node contract.');
        }
        for (const field of ['fills', 'strokes']) {
          const values = node[field];
          if (!Array.isArray(values)) continue;
          if (values.length > ${MAX_A11Y_VISION_PAINTS}) {
            throw new Error(label + ' exceeded the bounded paint contract.');
          }
          for (let index = 0; index < values.length; index++) {
            const paint = values[index];
            if (!paint || paint.type !== 'SOLID' || paint.visible === false) continue;
            if (!paint.color || !unit(paint.color.r) || !unit(paint.color.g)
              || !unit(paint.color.b)) {
              throw new Error(label + ' returned an invalid solid colour.');
            }
            paints.push({
              field, index,
              color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
            });
            if (paints.length > ${MAX_A11Y_VISION_PAINTS}) {
              throw new Error(label + ' exceeded the bounded paint contract.');
            }
            const hex = toHex(paint.color);
            if (!colors.has(hex)) colors.set(hex, {
              r: paint.color.r, g: paint.color.g, b: paint.color.b,
            });
            if (colors.size > ${MAX_A11Y_VISION_COLORS}) {
              throw new Error(label + ' exceeded the bounded unique-colour contract.');
            }
          }
        }
        const children = 'children' in node ? node.children : null;
        if (children !== null && (!Array.isArray(children)
          || children.length > ${MAX_A11Y_VISION_NODES})) {
          throw new Error(label + ' returned invalid child facts.');
        }
        if (children) {
          for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
      }
      return { nodes, paints, colors };
    };
    const samePaints = (left, right) => left.length === right.length
      && left.every((paint, index) => {
        const other = right[index];
        return paint.field === other.field && paint.index === other.index
          && close(paint.color.r, other.color.r)
          && close(paint.color.g, other.color.g)
          && close(paint.color.b, other.color.b);
      });
    const transformedPaints = (paints, type) => paints.map((paint) => ({
      field: paint.field,
      index: paint.index,
      color: applyMatrix(paint.color, matrices[type]),
    }));
    const transform = (root, type) => {
      const matrix = matrices[type];
      const stack = [root];
      let nodes = 0;
      let paints = 0;
      while (stack.length > 0) {
        const node = stack.pop();
        nodes += 1;
        if (nodes > ${MAX_A11Y_VISION_NODES}) {
          throw new Error('A11y Vision clone node limit exceeded.');
        }
        for (const field of ['fills', 'strokes']) {
          const values = node[field];
          if (!Array.isArray(values)) continue;
          if (values.length > ${MAX_A11Y_VISION_PAINTS}) {
            throw new Error('A11y Vision clone paint limit exceeded.');
          }
          node[field] = values.map((paint) => {
            if (!paint || paint.type !== 'SOLID' || paint.visible === false) return paint;
            paints += 1;
            if (paints > ${MAX_A11Y_VISION_PAINTS}) {
              throw new Error('A11y Vision clone paint limit exceeded.');
            }
            const color = applyMatrix(paint.color, matrix);
            return { ...paint, color };
          });
        }
        const children = 'children' in node ? node.children : null;
        if (children) {
          for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
      }
    };
    const simulationsFor = (colors) => {
      const entries = Array.from(colors.entries());
      const simulations = {};
      for (const type of types) {
        const matrix = matrices[type];
        const colorsOut = entries.map(([original, color]) => ({
          original, simulated: toHex(applyMatrix(color, matrix)),
        }));
        const confusable = [];
        for (let left = 0; left < entries.length; left++) {
          for (let right = left + 1; right < entries.length; right++) {
            const [hex1, color1] = entries[left];
            const [hex2, color2] = entries[right];
            const sim1 = applyMatrix(color1, matrix);
            const sim2 = applyMatrix(color2, matrix);
            const simulatedDiff = Math.sqrt(
              Math.pow(sim1.r - sim2.r, 2)
              + Math.pow(sim1.g - sim2.g, 2)
              + Math.pow(sim1.b - sim2.b, 2));
            const originalDiff = Math.sqrt(
              Math.pow(color1.r - color2.r, 2)
              + Math.pow(color1.g - color2.g, 2)
              + Math.pow(color1.b - color2.b, 2));
            if (simulatedDiff < 0.05 && originalDiff > 0.1) {
              confusable.push({
                color1: hex1, color2: hex2,
                simulated1: toHex(sim1), simulated2: toHex(sim2),
              });
            }
          }
        }
        simulations[type] = { colors: colorsOut, confusable };
      }
      return simulations;
    };
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation',
      attempted: 0, failure: cleanFailure(error),
    });

    let source;
    let parent;
    let beforeIds;
    let beforeFacts;
    let sourceFact;
    let simulations;
    try {
      source = request.nodeId
        ? await figma.getNodeByIdAsync(request.nodeId)
        : figma.currentPage && Array.isArray(figma.currentPage.selection)
          ? figma.currentPage.selection[0] : null;
      if (!source || !validId(source.id) || source.type === 'DOCUMENT' || source.type === 'PAGE'
        || typeof source.clone !== 'function' || !validName(source.name)
        || typeof source.type !== 'string' || source.type.length === 0 || source.type.length > 64
        || !finiteCoordinate(source.x) || !finiteCoordinate(source.y)
        || !finite(source.width) || source.width < 0
        || !finite(source.height) || source.height < 0) {
        throw new Error(request.nodeId
          ? 'A11y Vision requires an exact cloneable canvas node.'
          : 'Select a cloneable frame or provide a node ID.');
      }
      parent = source.parent;
      if (!parent || !validId(parent.id) || !Array.isArray(parent.children)) {
        throw new Error('A11y Vision source parent cannot retain simulation copies.');
      }
      beforeIds = childIds(parent, 'A11y Vision source parent');
      if (beforeIds.filter((id) => id === source.id).length !== 1) {
        throw new Error('A11y Vision source parent does not contain the source exactly once.');
      }
      beforeFacts = paintFacts(source, 'A11y Vision source');
      sourceFact = {
        id: source.id, name: source.name, type: source.type, parentId: parent.id,
        x: source.x, y: source.y, width: source.width, height: source.height,
      };
      for (let index = 0; index < types.length; index++) {
        const name = source.name + ' (' + types[index].charAt(0).toUpperCase()
          + types[index].slice(1) + ')';
        const x = source.x + source.width + 100 + index * (source.width + 60);
        if (!validName(name) || !finiteCoordinate(x)) {
          throw new Error('A11y Vision requested clone geometry or name is out of bounds.');
        }
      }
      simulations = simulationsFor(beforeFacts.colors);
    } catch (error) { return refusal(error); }

    try {
      const freshSource = await figma.getNodeByIdAsync(source.id);
      const freshParent = await figma.getNodeByIdAsync(parent.id);
      const freshFacts = freshSource ? paintFacts(freshSource, 'Fresh A11y Vision source') : null;
      if (!freshSource || !freshParent || freshSource.parent?.id !== parent.id
        || !sameIds(childIds(freshParent, 'Fresh A11y Vision source parent'), beforeIds)
        || freshSource.name !== sourceFact.name || freshSource.type !== sourceFact.type
        || !close(freshSource.x, sourceFact.x) || !close(freshSource.y, sourceFact.y)
        || !close(freshSource.width, sourceFact.width) || !close(freshSource.height, sourceFact.height)
        || freshFacts.nodes !== beforeFacts.nodes
        || !samePaints(freshFacts.paints, beforeFacts.paints)) {
        throw new Error('A11y Vision source changed before mutation.');
      }
      source = freshSource;
      parent = freshParent;
    } catch (error) { return refusal(error); }

    const created = [];
    let attempted = 0;
    let unattributed = false;
    let failure = null;
    try {
      for (let index = 0; index < types.length; index++) {
        const type = types[index];
        attempted += 1;
        let clone;
        try { clone = source.clone(); }
        catch (error) { unattributed = true; throw error; }
        if (!clone || !validId(clone.id) || clone.id === source.id) {
          unattributed = true;
          throw new Error('A11y Vision clone identity is unavailable.');
        }
        created.push({ id: clone.id, node: clone, simulationType: type, index });
        if (typeof clone.remove !== 'function' || clone.parent?.id !== parent.id
          || clone.type !== source.type) {
          throw new Error('A11y Vision did not create a removable sibling copy.');
        }
        clone.name = source.name + ' (' + type.charAt(0).toUpperCase() + type.slice(1) + ')';
        clone.x = source.x + source.width + 100 + index * (source.width + 60);
        clone.y = source.y;
        transform(clone, type);
      }

      const freshParent = await figma.getNodeByIdAsync(parent.id);
      const afterIds = childIds(freshParent, 'Fresh A11y Vision source parent');
      const createdIds = new Set(created.map((item) => item.id));
      if (afterIds.length !== beforeIds.length + created.length
        || !sameIds(afterIds.filter((id) => !createdIds.has(id)), beforeIds)
        || created.some((item) => afterIds.filter((id) => id === item.id).length !== 1)) {
        throw new Error('A11y Vision could not verify exact parent membership.');
      }
      const clones = [];
      for (const item of created) {
        const clone = await figma.getNodeByIdAsync(item.id);
        const expectedName = source.name + ' (' + item.simulationType.charAt(0).toUpperCase()
          + item.simulationType.slice(1) + ')';
        const expectedX = source.x + source.width + 100 + item.index * (source.width + 60);
        const facts = clone ? paintFacts(clone, 'Fresh A11y Vision clone') : null;
        if (!clone || clone.parent?.id !== parent.id || clone.type !== source.type
          || clone.name !== expectedName || !close(clone.x, expectedX) || !close(clone.y, source.y)
          || facts.nodes !== beforeFacts.nodes
          || !samePaints(facts.paints, transformedPaints(beforeFacts.paints, item.simulationType))) {
          throw new Error('A11y Vision could not freshly verify a complete simulation copy.');
        }
        clones.push({
          id: clone.id, name: clone.name, nodeType: clone.type,
          simulationType: item.simulationType, parentId: parent.id,
          x: clone.x, y: clone.y,
        });
      }
      delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1, status: 'simulated', outcome: 'applied',
        attempted, restored: 0, residueCount: 0,
        source: sourceFact, totalColors: beforeFacts.colors.size,
        types, simulations, clones,
      });
    } catch (error) { failure = error; }

    for (let index = created.length - 1; index >= 0; index--) {
      try { created[index].node.remove(); } catch {}
    }
    try {
      const freshSource = await figma.getNodeByIdAsync(source.id);
      const freshParent = await figma.getNodeByIdAsync(parent.id);
      const restoredIds = childIds(freshParent, 'Restored A11y Vision source parent');
      const presentCloneIds = [];
      for (const item of created) {
        if (await figma.getNodeByIdAsync(item.id) || restoredIds.includes(item.id)) {
          presentCloneIds.push(item.id);
        }
      }
      const sourceMissing = !freshSource || freshSource.parent?.id !== parent.id;
      const parentChanged = !sameIds(restoredIds, beforeIds);
      const restored = !unattributed && !sourceMissing && !parentChanged
        && presentCloneIds.length === 0;
      if (restored) delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1, status: 'failed',
        outcome: restored ? 'rolled-back'
          : unattributed ? 'verification-unavailable' : 'partial-residue',
        attempted,
        restored: restored ? created.length : 0,
        residue: { presentCloneIds, sourceMissing, parentChanged, unattributed },
        failure: cleanFailure(failure),
      });
    } catch {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        attempted, restored: 0,
        residue: { presentCloneIds: [], sourceMissing: false, parentChanged: false, unattributed },
        failure: cleanFailure(failure),
      });
    }
  })()`;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE_TEXT_CONTROLS.test(value);
}
function id(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function coordinate(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE * 2;
}
function hex(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value); }
function validSimulation(value, totalColors) {
  return exact(value, ['colors', 'confusable'])
    && Array.isArray(value.colors) && value.colors.length === totalColors
    && value.colors.every((item) => exact(item, ['original', 'simulated'])
      && hex(item.original) && hex(item.simulated))
    && Array.isArray(value.confusable)
    && value.confusable.length <= totalColors * Math.max(0, totalColors - 1) / 2
    && value.confusable.every((item) => exact(
      item, ['color1', 'color2', 'simulated1', 'simulated2'])
      && hex(item.color1) && hex(item.color2)
      && hex(item.simulated1) && hex(item.simulated2));
}
function validSource(value, input) {
  return exact(value, ['id', 'name', 'type', 'parentId', 'x', 'y', 'width', 'height'])
    && id(value.id) && (!input.nodeId || value.id === input.nodeId)
    && text(value.name, MAX_LABEL_CODE_UNITS)
    && text(value.type, 64, false) && id(value.parentId)
    && coordinate(value.x) && coordinate(value.y)
    && Number.isFinite(value.width) && value.width >= 0
    && Number.isFinite(value.height) && value.height >= 0;
}
function validSuccess(value, input) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
    'source', 'totalColors', 'types', 'simulations', 'clones',
  ]) || value.schemaVersion !== 1 || value.status !== 'simulated' || value.outcome !== 'applied'
    || value.restored !== 0 || value.residueCount !== 0
    || !validSource(value.source, input)
    || !Number.isSafeInteger(value.totalColors) || value.totalColors < 0
    || value.totalColors > MAX_A11Y_VISION_COLORS
    || !Array.isArray(value.types)
    || value.types.length !== (input.type === 'all' ? A11Y_VISION_TYPES.length : 1)
    || value.types.some((type, index) => type !== (input.type === 'all'
      ? A11Y_VISION_TYPES[index] : input.type))
    || value.attempted !== value.types.length
    || !exact(value.simulations, value.types)
    || !value.types.every((type) => validSimulation(value.simulations[type], value.totalColors))
    || !Array.isArray(value.clones) || value.clones.length !== value.types.length) return false;
  return value.clones.every((clone, index) => exact(clone, [
    'id', 'name', 'nodeType', 'simulationType', 'parentId', 'x', 'y',
  ]) && id(clone.id) && clone.id !== value.source.id
    && value.clones.findIndex((item) => item.id === clone.id) === index
    && text(clone.name, MAX_LABEL_CODE_UNITS)
    && text(clone.nodeType, 64, false) && clone.nodeType === value.source.type
    && clone.simulationType === value.types[index]
    && clone.parentId === value.source.parentId
    && coordinate(clone.x) && coordinate(clone.y)
    && Math.abs(clone.x - (value.source.x + value.source.width + 100
      + index * (value.source.width + 60))) <= VERIFY_EPSILON
    && Math.abs(clone.y - value.source.y) <= VERIFY_EPSILON);
}
function validFailure(value) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ]) && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && Number.isSafeInteger(value.attempted) && value.attempted >= 1
    && value.attempted <= A11Y_VISION_TYPES.length
    && Number.isSafeInteger(value.restored) && value.restored >= 0
    && value.restored <= value.attempted
    && exact(value.residue, [
      'presentCloneIds', 'sourceMissing', 'parentChanged', 'unattributed',
    ])
    && Array.isArray(value.residue.presentCloneIds)
    && value.residue.presentCloneIds.length <= A11Y_VISION_TYPES.length
    && value.residue.presentCloneIds.every(id)
    && new Set(value.residue.presentCloneIds).size === value.residue.presentCloneIds.length
    && typeof value.residue.sourceMissing === 'boolean'
    && typeof value.residue.parentChanged === 'boolean'
    && typeof value.residue.unattributed === 'boolean'
    && text(value.failure, 1024, false)
    && (value.outcome !== 'rolled-back' || (value.restored > 0
      && value.residue.presentCloneIds.length === 0
      && !value.residue.sourceMissing && !value.residue.parentChanged
      && !value.residue.unattributed))
    && (value.outcome !== 'partial-residue' || (value.restored === 0
      && (value.residue.presentCloneIds.length > 0
        || value.residue.sourceMissing || value.residue.parentChanged)))
    && (value.outcome !== 'verification-unavailable' || value.restored === 0);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, 1024, false);
}
function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function legacyProjection(result) {
  return {
    original: result.source.name,
    totalColors: result.totalColors,
    types: result.types,
    simulations: result.simulations,
    clones: result.clones.map((clone) => ({
      id: clone.id, name: clone.name, type: clone.simulationType,
    })),
  };
}

export function formatA11yVisionResult(result, { json = false } = {}) {
  const projected = legacyProjection(result);
  if (json) return safeJson(projected, true);
  const lines = [
    'Color Blindness Simulation',
    `Source: ${result.source.name} (${result.totalColors} unique colors)`,
    '',
    'Created simulation copies:',
  ];
  for (const clone of result.clones) {
    const simulation = result.simulations[clone.simulationType];
    lines.push('', `${simulation.confusable.length > 0 ? '⚠' : '✓'} ${clone.name}`);
    if (simulation.confusable.length > 0) {
      lines.push(`  ${simulation.confusable.length} confusable color pair(s):`);
      for (const pair of simulation.confusable) {
        lines.push(`  ${pair.color1} ↔ ${pair.color2} → both appear as ~${pair.simulated1}`);
      }
    } else lines.push('  No confusable colors');
    lines.push(`  ID: ${clone.id}`);
  }
  return lines.join('\n');
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}
function resultError(message) {
  const error = new Error(message);
  error.kind = 'plugin-result';
  error.phase = 'plugin-response';
  error.outcome = 'unknown-after-dispatch';
  return error;
}

export async function executeA11yVision(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('A11y Vision requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(a11yVisionCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_A11Y_VISION_RESULT_CODE_UNITS) {
    throw resultError('A11y Vision returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw resultError('A11y Vision returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw resultError('A11y Vision returned an invalid bounded result.');
    throw mutationError(`A11y Vision made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw resultError('A11y Vision returned an invalid bounded result.');
    const residueCount = payload.residue.presentCloneIds.length
      + Number(payload.residue.sourceMissing) + Number(payload.residue.parentChanged)
      + Number(payload.residue.unattributed);
    const message = payload.outcome === 'rolled-back'
      ? `A11y Vision failed and removed its simulation copies: ${payload.failure}`
      : `A11y Vision failed with unresolved mutation state: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: payload.attempted,
      restored: payload.restored, residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    throw resultError('A11y Vision returned an invalid bounded result.');
  }
  return {
    stdout: formatA11yVisionResult(payload, { json: input.json }),
    stderr: input.warning || '',
    result: payload,
  };
}

export function a11yVisionPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('A11y Vision routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-a11y-vision';
}

export function executeA11yVisionPlan(plan, adapters = {}) {
  if (a11yVisionPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by A11y Vision.');
  }
  return executeA11yVision(parseA11yVisionRequest(plan.argv), adapters);
}
