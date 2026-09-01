// Plan-bound, freshly verified and rollback-owned `jam table` creation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS,
  MAX_JAM_TABLE_CELLS,
  MAX_JAM_TABLE_COLUMNS,
  MAX_JAM_TABLE_DATA_CODE_UNITS,
  MAX_JAM_TABLE_ROWS,
  jamTableArgvFromRequest,
  parseJamTableRequest,
} from './jam-table-request.js';

export { jamTableArgvFromRequest } from './jam-table-request.js';

const APPLICATION_ID = 'jam.table';
export const JAM_TABLE_VERIFY_EPSILON = 0.01;
export const MAX_JAM_TABLE_PAGE_CHILDREN = 20_000;
export const MAX_JAM_TABLE_SELECTION = 4_096;
export const MAX_JAM_TABLE_SNAPSHOT_CODE_UNITS = 700_000;
export const MAX_JAM_TABLE_READBACK_CODE_UNITS = 600_000;
export const MAX_JAM_TABLE_RESULT_CODE_UNITS = 2_000_000;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamTableRequest(jamTableArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function jamTableCode(request) {
  const input = normalized(request);
  return `(async () => {
    const schemaVersion = 1;
    const request = ${js(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const finite = (value) => typeof value === 'number' && Number.isFinite(value)
      && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE};
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left)
      && Math.abs(left - right) <= ${JAM_TABLE_VERIFY_EPSILON};
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const sameData = (actual) => {
      if (actual.length !== request.rows) return false;
      for (let row = 0; row < request.rows; row++) {
        if (!Array.isArray(actual[row]) || actual[row].length !== request.columns) return false;
        for (let column = 0; column < request.columns; column++) {
          if (actual[row][column] !== (request.data[row]?.[column] ?? '')) return false;
        }
      }
      return true;
    };
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_TABLE_RESULT_CODE_UNITS}) {
        throw new Error('Jam Table result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (error) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Jam Table preflight failed.'),
    });
    if (figma.editorType !== 'figjam') return refused('Jam Table requires a FigJam board.');
    if (!figma.currentPage || typeof figma.createTable !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function' || typeof figma.loadFontAsync !== 'function') {
      return refused('Jam Table requires the native FigJam API.');
    }
    const context = (page, placement = false) => {
      if (!page || !validId(page.id) || !Array.isArray(page.children)
        || page.children.length > ${MAX_JAM_TABLE_PAGE_CHILDREN}
        || !Array.isArray(page.selection) || page.selection.length > ${MAX_JAM_TABLE_SELECTION}) {
        throw new Error('Jam Table requires one bounded current page and selection.');
      }
      const childIds = page.children.map((node) => {
        if (!node || !validId(node.id)
          || (placement && (!finite(node.x) || !finite(node.y)
            || typeof node.width !== 'number' || !Number.isFinite(node.width) || node.width < 0))) {
          throw new Error('Jam Table found invalid bounded page geometry.');
        }
        return node.id;
      });
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Table found an invalid selection.');
        return node.id;
      });
      if (new Set(childIds).size !== childIds.length
        || new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Jam Table requires unique page and selection identities.');
      }
      return { pageId: page.id, childIds, selectionIds };
    };
    const explicit = request.x !== null;
    let page;
    let before;
    let origin;
    try {
      page = figma.currentPage;
      before = context(page, !explicit);
      origin = explicit ? { x: request.x, y: request.y } : page.children.length
        ? {
          x: Math.max(...page.children.map((node) => node.x + node.width)) + 80,
          y: Math.min(...page.children.map((node) => node.y)),
        }
        : { x: 0, y: 0 };
      if (!finite(origin.x) || !finite(origin.y)) {
        throw new Error('Jam Table placement exceeded the bounded coordinate limit.');
      }
      if (JSON.stringify({ request, before, origin }).length > ${MAX_JAM_TABLE_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Jam Table preflight snapshot exceeded its bounded limit.');
      }
    } catch (error) { return refused(error); }
    const tableData = (node) => {
      if (!Number.isSafeInteger(node.numRows) || node.numRows < 1
        || node.numRows > ${MAX_JAM_TABLE_ROWS}
        || !Number.isSafeInteger(node.numColumns) || node.numColumns < 1
        || node.numColumns > ${MAX_JAM_TABLE_COLUMNS}
        || node.numRows * node.numColumns > ${MAX_JAM_TABLE_CELLS}
        || typeof node.cellAt !== 'function') {
        throw new Error('Jam Table found invalid bounded table dimensions.');
      }
      const data = [];
      for (let row = 0; row < node.numRows; row++) {
        const values = [];
        for (let column = 0; column < node.numColumns; column++) {
          const cell = node.cellAt(row, column);
          if (!cell || cell.type !== 'TABLE_CELL' || cell.rowIndex !== row
            || cell.columnIndex !== column || !cell.parent || cell.parent.id !== node.id
            || !cell.text || typeof cell.text.characters !== 'string'
            || cell.text.characters.length > ${MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS}) {
            throw new Error('Jam Table found invalid bounded cell facts.');
          }
          values.push(cell.text.characters);
        }
        data.push(values);
      }
      if (JSON.stringify(data).length > ${MAX_JAM_TABLE_READBACK_CODE_UNITS}) {
        throw new Error('Jam Table cell readback exceeded its bounded limit.');
      }
      return data;
    };
    const nodeFact = (node, pageId, index) => {
      if (!node || node.type !== 'TABLE' || !validId(node.id)
        || !node.parent || node.parent.id !== pageId
        || !finite(node.x) || !finite(node.y)
        || !Number.isSafeInteger(index) || index < 0) {
        throw new Error('Jam Table found invalid bounded Table facts.');
      }
      return {
        id: node.id, type: 'TABLE', parentId: pageId, index,
        rows: node.numRows, columns: node.numColumns,
        x: node.x, y: node.y, data: tableData(node),
      };
    };
    const exactSuccess = (actual, node) => {
      const expectedChildren = [...before.childIds, node.id];
      return figma.currentPage && figma.currentPage.id === before.pageId
        && same(actual.childIds, expectedChildren) && same(actual.selectionIds, [node.id])
        && node.index === before.childIds.length && node.rows === request.rows
        && node.columns === request.columns && close(node.x, origin.x) && close(node.y, origin.y)
        && sameData(node.data);
    };

    let table = null;
    let failure = '';
    try {
      table = figma.createTable(request.rows, request.columns);
      table.x = origin.x;
      table.y = origin.y;
      let loaded = false;
      for (let row = 0; row < request.data.length; row++) {
        for (let column = 0; column < request.data[row].length; column++) {
          const cell = table.cellAt(row, column);
          if (!loaded) {
            try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch {}
            try {
              const font = cell.text && cell.text.fontName;
              if (font && font !== figma.mixed) await figma.loadFontAsync(font);
            } catch {}
            loaded = true;
            if (!figma.currentPage || figma.currentPage.id !== before.pageId) {
              throw new Error('Jam Table current page changed during creation.');
            }
          }
          cell.text.characters = request.data[row][column];
        }
      }
      page.selection = [table];
    } catch (error) {
      failure = failureText(error, 'Jam Table mutation failed.');
    }
    if (table && validId(table.id)) {
      try {
        const freshPage = await figma.getNodeByIdAsync(before.pageId);
        const fresh = await figma.getNodeByIdAsync(table.id);
        const actual = context(freshPage);
        const node = nodeFact(fresh, before.pageId, actual.childIds.indexOf(table.id));
        if (exactSuccess(actual, node)) {
          delete globalThis.__invCache;
          return result({
            schemaVersion, status: 'created', outcome: failure ? 'verified-after-error' : 'verified',
            attempted: 1, restored: 0, residueCount: 0, request, origin, before,
            actual: { context: actual, node },
            warnings: failure
              ? ['Figma reported an error, but fresh FigJam readback verified the requested Table.']
              : [],
          });
        }
        if (!failure) failure = 'Jam Table postcondition was not satisfied.';
      } catch (error) {
        if (!failure) failure = failureText(error, 'Jam Table verification failed.');
      }
    } else if (!failure) failure = 'Jam Table factory returned no bounded identity.';

    if (!table || !validId(table.id)) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residueCount: 0, failure,
      });
    }
    try {
      try { table.remove(); } catch {}
      const restoredPage = await figma.getNodeByIdAsync(before.pageId);
      try {
        const selection = [];
        for (const id of before.selectionIds) {
          const node = await figma.getNodeByIdAsync(id);
          if (node) selection.push(node);
        }
        restoredPage.selection = selection;
      } catch {}
      const fresh = await figma.getNodeByIdAsync(table.id);
      const restoredContext = context(restoredPage);
      let residueCount = fresh || restoredContext.childIds.includes(table.id) ? 1 : 0;
      if (!same(restoredContext.childIds, before.childIds)) residueCount += 1;
      if (!same(restoredContext.selectionIds, before.selectionIds)) residueCount += 1;
      if (residueCount === 0) delete globalThis.__invCache;
      return result({
        schemaVersion, status: 'failed',
        outcome: residueCount === 0 ? 'rolled-back' : 'partial-residue', attempted: 1,
        restored: residueCount === 0 ? 1 : 0, residueCount, failure,
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residueCount: 0,
        failure: failureText(error, failure || 'Jam Table rollback verification failed.'),
      });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function id(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_NODE_REFERENCE_CODE_UNITS && NODE_REFERENCE_PATTERN.test(value);
}
function coordinate(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE;
}
function ids(value, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every(id)
    && new Set(value).size === value.length;
}
function validContext(value) {
  return exact(value, ['pageId', 'childIds', 'selectionIds']) && id(value.pageId)
    && ids(value.childIds, MAX_JAM_TABLE_PAGE_CHILDREN)
    && ids(value.selectionIds, MAX_JAM_TABLE_SELECTION);
}
function validRequestData(value, input) {
  return Array.isArray(value) && value.length <= input.rows
    && value.every((row) => Array.isArray(row) && row.length <= input.columns
      && row.every((cell) => typeof cell === 'string'
        && cell.length <= MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS))
    && JSON.stringify(value).length <= MAX_JAM_TABLE_DATA_CODE_UNITS;
}
function validRequest(value, input) {
  return exact(value, ['rows', 'columns', 'data', 'x', 'y'])
    && value.rows === input.rows && value.columns === input.columns
    && value.x === input.x && value.y === input.y
    && validRequestData(value.data, input) && JSON.stringify(value.data) === JSON.stringify(input.data);
}
function validMatrix(value, input) {
  return Array.isArray(value) && value.length === input.rows
    && value.every((row) => Array.isArray(row) && row.length === input.columns
      && row.every((cell) => typeof cell === 'string'
        && cell.length <= MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS))
    && JSON.stringify(value).length <= MAX_JAM_TABLE_READBACK_CODE_UNITS;
}
function sameData(actual, input) {
  for (let row = 0; row < input.rows; row++) {
    for (let column = 0; column < input.columns; column++) {
      if (actual[row][column] !== (input.data[row]?.[column] ?? '')) return false;
    }
  }
  return true;
}
function validNode(value, input, before) {
  return exact(value, [
    'id', 'type', 'parentId', 'index', 'rows', 'columns', 'x', 'y', 'data',
  ]) && id(value.id) && value.type === 'TABLE' && value.parentId === before.pageId
    && value.index === before.childIds.length && value.rows === input.rows
    && value.columns === input.columns && coordinate(value.x) && coordinate(value.y)
    && validMatrix(value.data, input) && sameData(value.data, input);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && typeof value.failure === 'string' && value.failure.length > 0
    && value.failure.length <= MAX_FAILURE_CODE_UNITS;
}
function validSuccess(value, input) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
    'request', 'origin', 'before', 'actual', 'warnings',
  ]) || value.schemaVersion !== 1 || value.status !== 'created'
    || !['verified', 'verified-after-error'].includes(value.outcome)
    || value.attempted !== 1 || value.restored !== 0 || value.residueCount !== 0
    || !validRequest(value.request, input)
    || !exact(value.origin, ['x', 'y']) || !coordinate(value.origin.x) || !coordinate(value.origin.y)
    || (input.x !== null && (value.origin.x !== input.x || value.origin.y !== input.y))
    || !validContext(value.before)
    || JSON.stringify({ request: value.request, before: value.before, origin: value.origin }).length
      > MAX_JAM_TABLE_SNAPSHOT_CODE_UNITS
    || !exact(value.actual, ['context', 'node']) || !validContext(value.actual.context)
    || !validNode(value.actual.node, input, value.before)
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || value.warnings.some((warning) => typeof warning !== 'string'
      || warning.length === 0 || warning.length > MAX_FAILURE_CODE_UNITS)) return false;
  const expectedChildren = [...value.before.childIds, value.actual.node.id];
  return value.actual.context.pageId === value.before.pageId
    && sameIds(value.actual.context.childIds, expectedChildren)
    && sameIds(value.actual.context.selectionIds, [value.actual.node.id])
    && Math.abs(value.actual.node.x - value.origin.x) <= JAM_TABLE_VERIFY_EPSILON
    && Math.abs(value.actual.node.y - value.origin.y) <= JAM_TABLE_VERIFY_EPSILON
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validFailure(value) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !Number.isSafeInteger(value.residueCount) || value.residueCount < 0 || value.residueCount > 3
    || typeof value.failure !== 'string' || value.failure.length === 0
    || value.failure.length > MAX_FAILURE_CODE_UNITS) return false;
  if (value.outcome === 'rolled-back') return value.restored === 1 && value.residueCount === 0;
  if (value.outcome === 'partial-residue') return value.restored === 0 && value.residueCount > 0;
  return value.restored === 0;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
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

export function formatJamTableResult(result) {
  return `✓ Table ${safeText(result.actual.node.id)} (${result.actual.node.rows}×${result.actual.node.columns})`;
}

export async function executeJamTable(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Jam Table requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamTableCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_TABLE_RESULT_CODE_UNITS) {
    throw invalid('Jam Table returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Jam Table returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Jam Table returned an invalid bounded result.');
    throw mutationError(`Jam Table made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Jam Table returned an invalid bounded result.');
    throw mutationError(`Jam Table failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) throw invalid('Jam Table returned an invalid bounded result.');
  return {
    stdout: formatJamTableResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function jamTablePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Jam Table routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-jam-table';
}

export function executeJamTablePlan(plan, adapters = {}) {
  if (jamTablePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Table.');
  }
  return executeJamTable(parseJamTableRequest(plan.argv), adapters);
}
