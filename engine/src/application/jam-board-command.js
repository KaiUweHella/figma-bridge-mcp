// Plan-bound bounded FigJam board inventory.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  jamBoardArgvFromRequest,
  parseJamBoardRequest,
} from './jam-board-request.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';

export { jamBoardArgvFromRequest } from './jam-board-request.js';

const APPLICATION_ID = 'jam.board';
export const MAX_JAM_BOARD_NODES = 20_000;
export const MAX_JAM_BOARD_CONNECTORS = 20_000;
export const MAX_JAM_BOARD_TABLE_ROWS = 1_000;
export const MAX_JAM_BOARD_TABLE_COLUMNS = 1_000;
export const MAX_JAM_BOARD_TABLE_CELLS = 50_000;
export const MAX_JAM_BOARD_TEXT_CODE_UNITS = 4_000_000;
export const MAX_JAM_BOARD_RESULT_CODE_UNITS = 8_000_000;
const MAX_NAME_CODE_UNITS = 4_096;
const MAX_NODE_TEXT_CODE_UNITS = 200;
const MAX_CONNECTOR_TEXT_CODE_UNITS = 100;
const MAX_CELL_TEXT_CODE_UNITS = 4_096;
const MAX_TYPE_CODE_UNITS = 64;
const MAX_COORDINATE = 1_000_000_000;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamBoardRequest(jamBoardArgvFromRequest(request));

export function jamBoardCode(request = {}) {
  normalized(request);
  return `(async () => {
    const schemaVersion = 1;
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
    const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const rounded = (value, dimension = false) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid geometry');
      const result = Math.round(value);
      if (!Number.isSafeInteger(result) || Math.abs(result) > ${MAX_COORDINATE}
        || (dimension && result < 0)) throw new Error('invalid geometry');
      return result;
    };
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_BOARD_RESULT_CODE_UNITS}) {
        throw new Error('Jam Board result exceeded its bounded response limit.');
      }
      return serialized;
    };
    try {
      if (figma.editorType !== 'figjam') {
        return bounded({ schemaVersion, status: 'wrong-editor' });
      }
      const page = figma.currentPage;
      if (!page || !validId(page.id) || !text(page.name, ${MAX_NAME_CODE_UNITS})
        || !Array.isArray(page.children) || page.children.length > ${MAX_JAM_BOARD_NODES}) {
        return bounded({ schemaVersion, status: 'invalid-runtime' });
      }
      let totalText = page.name.length;
      let tableCells = 0;
      const retain = (value, maximum, truncate = false) => {
        if (typeof value !== 'string' || (!truncate && value.length > maximum)) {
          throw new Error('invalid text fact');
        }
        const result = truncate ? value.slice(0, maximum) : value;
        totalText += result.length;
        if (totalText > ${MAX_JAM_BOARD_TEXT_CODE_UNITS}) {
          throw new Error('Jam Board text fact limit exceeded.');
        }
        return result;
      };
      const rawText = (node) => {
        if (node && node.text && typeof node.text.characters === 'string') return node.text.characters;
        if (node && typeof node.characters === 'string') return node.characters;
        if (node && typeof node.code === 'string') return node.code;
        return '';
      };
      const tableOf = (node) => {
        if (node.type !== 'TABLE') return null;
        if (!count(node.numRows, ${MAX_JAM_BOARD_TABLE_ROWS})
          || !count(node.numColumns, ${MAX_JAM_BOARD_TABLE_COLUMNS})
          || typeof node.cellAt !== 'function'
          || node.numRows * node.numColumns > ${MAX_JAM_BOARD_TABLE_CELLS}
          || tableCells + node.numRows * node.numColumns > ${MAX_JAM_BOARD_TABLE_CELLS}) {
          throw new Error('invalid bounded table');
        }
        tableCells += node.numRows * node.numColumns;
        const data = [];
        for (let row = 0; row < node.numRows; row++) {
          const values = [];
          for (let col = 0; col < node.numColumns; col++) {
            values.push(retain(rawText(node.cellAt(row, col)), ${MAX_CELL_TEXT_CODE_UNITS}));
          }
          data.push(values);
        }
        return { rows: node.numRows, cols: node.numColumns, data };
      };
      const nodes = page.children.map((node) => {
        if (!node || !validId(node.id) || !text(node.type, ${MAX_TYPE_CODE_UNITS})
          || !text(node.name, ${MAX_NAME_CODE_UNITS})) throw new Error('invalid node identity');
        return {
          id: node.id, type: node.type, name: retain(node.name, ${MAX_NAME_CODE_UNITS}),
          x: rounded(node.x), y: rounded(node.y),
          w: rounded(node.width, true), h: rounded(node.height, true),
          text: retain(rawText(node), ${MAX_NODE_TEXT_CODE_UNITS}, true),
          table: tableOf(node),
        };
      });
      if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
        return bounded({ schemaVersion, status: 'invalid-runtime' });
      }
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const endpointId = (endpoint) => {
        if (!endpoint || !Object.prototype.hasOwnProperty.call(endpoint, 'endpointNodeId')) return null;
        if (!validId(endpoint.endpointNodeId)) throw new Error('invalid connector endpoint');
        return endpoint.endpointNodeId;
      };
      const connectors = page.children.filter((node) => node.type === 'CONNECTOR').map((node) => {
        const fact = byId.get(node.id);
        return {
          id: node.id,
          from: endpointId(node.connectorStart),
          to: endpointId(node.connectorEnd),
          text: fact.text.slice(0, ${MAX_CONNECTOR_TEXT_CODE_UNITS}),
        };
      });
      if (connectors.length > ${MAX_JAM_BOARD_CONNECTORS}) {
        return bounded({ schemaVersion, status: 'invalid-runtime' });
      }
      return bounded({
        schemaVersion, status: 'ok',
        data: { pageId: page.id, page: page.name, count: nodes.length, nodes, connectors },
      });
    } catch {
      return JSON.stringify({ schemaVersion, status: 'invalid-runtime' });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function id(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function count(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function coordinate(value, dimension = false) {
  return Number.isSafeInteger(value) && Math.abs(value) <= MAX_COORDINATE
    && (!dimension || value >= 0);
}
function table(value, budget) {
  if (value === null) return { valid: true, cells: 0, text: 0 };
  if (!exact(value, ['rows', 'cols', 'data'])
    || !count(value.rows, MAX_JAM_BOARD_TABLE_ROWS)
    || !count(value.cols, MAX_JAM_BOARD_TABLE_COLUMNS)
    || value.rows * value.cols > MAX_JAM_BOARD_TABLE_CELLS
    || !Array.isArray(value.data) || value.data.length !== value.rows) {
    return { valid: false, cells: 0, text: 0 };
  }
  let cells = 0; let totalText = 0;
  for (const row of value.data) {
    if (!Array.isArray(row) || row.length !== value.cols) return { valid: false, cells: 0, text: 0 };
    for (const cell of row) {
      if (!text(cell, MAX_CELL_TEXT_CODE_UNITS)) return { valid: false, cells: 0, text: 0 };
      cells += 1; totalText += cell.length;
      if (cells + budget.cells > MAX_JAM_BOARD_TABLE_CELLS
        || totalText + budget.text > MAX_JAM_BOARD_TEXT_CODE_UNITS) {
        return { valid: false, cells: 0, text: 0 };
      }
    }
  }
  return { valid: true, cells, text: totalText };
}
function nodeFact(value, budget) {
  if (!exact(value, ['id', 'type', 'name', 'x', 'y', 'w', 'h', 'text', 'table'])
    || !id(value.id) || !text(value.type, MAX_TYPE_CODE_UNITS, false)
    || !text(value.name, MAX_NAME_CODE_UNITS) || !coordinate(value.x) || !coordinate(value.y)
    || !coordinate(value.w, true) || !coordinate(value.h, true)
    || !text(value.text, MAX_NODE_TEXT_CODE_UNITS)) return false;
  budget.text += value.name.length + value.text.length;
  if (budget.text > MAX_JAM_BOARD_TEXT_CODE_UNITS) return false;
  const checkedTable = table(value.table, budget);
  if (!checkedTable.valid) return false;
  budget.cells += checkedTable.cells; budget.text += checkedTable.text;
  return true;
}
function connectorFact(value, nodes) {
  return exact(value, ['id', 'from', 'to', 'text']) && id(value.id)
    && nodes.get(value.id)?.type === 'CONNECTOR'
    && (value.from === null || id(value.from)) && (value.to === null || id(value.to))
    && text(value.text, MAX_CONNECTOR_TEXT_CODE_UNITS)
    && value.text === nodes.get(value.id).text.slice(0, MAX_CONNECTOR_TEXT_CODE_UNITS);
}
function validData(value) {
  if (!exact(value, ['pageId', 'page', 'count', 'nodes', 'connectors'])
    || !id(value.pageId) || !text(value.page, MAX_NAME_CODE_UNITS)
    || !count(value.count, MAX_JAM_BOARD_NODES)
    || !Array.isArray(value.nodes) || value.nodes.length !== value.count
    || !Array.isArray(value.connectors) || value.connectors.length > MAX_JAM_BOARD_CONNECTORS) return false;
  const budget = { cells: 0, text: value.page.length };
  if (value.nodes.some((node) => !nodeFact(node, budget))) return false;
  const nodes = new Map(value.nodes.map((node) => [node.id, node]));
  if (nodes.size !== value.nodes.length || value.connectors.some((item) => !connectorFact(item, nodes))) return false;
  const connectorIds = value.nodes.filter((node) => node.type === 'CONNECTOR').map((node) => node.id);
  return connectorIds.length === value.connectors.length
    && connectorIds.every((nodeId, index) => value.connectors[index].id === nodeId);
}
function validPayload(value) {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.status !== 'string') return false;
  if (value.status === 'ok') return exact(value, ['schemaVersion', 'status', 'data']) && validData(value.data);
  return ['wrong-editor', 'invalid-runtime'].includes(value.status)
    && exact(value, ['schemaVersion', 'status']);
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS, ' '); }
function publicData(data) {
  return { page: data.page, count: data.count, nodes: data.nodes, connectors: data.connectors };
}
export function formatJamBoardResult(data, { json = false } = {}) {
  const legacy = publicData(data);
  if (json) return JSON.stringify(legacy, null, 2);
  const lines = [`${safeText(data.page)} — ${data.count} node(s)`, ''];
  for (const node of data.nodes) {
    const readable = node.text || (node.table ? JSON.stringify(node.table.data) : '');
    const label = readable ? ` "${safeText(readable).replace(/\s+/g, ' ')}"` : '';
    lines.push(`  ${safeText(node.id).padEnd(12)} ${safeText(node.type).padEnd(16)} `
      + `${String(node.x).padStart(6)},${String(node.y).padStart(6)}${label}`);
  }
  if (data.connectors.length) {
    lines.push('', `${data.connectors.length} connector(s)`);
    for (const connector of data.connectors) {
      const label = connector.text ? ` "${safeText(connector.text)}"` : '';
      lines.push(`  ${safeText(connector.id).padEnd(12)} ${safeText(connector.from)} → `
        + `${safeText(connector.to)}${label}`);
    }
  }
  return lines.join('\n');
}
export async function executeJamBoard(request = {}, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Jam Board requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamBoardCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_BOARD_RESULT_CODE_UNITS) {
    throw new Error('Jam Board returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Jam Board returned invalid JSON.'); }
  if (!validPayload(payload)) throw new Error('Jam Board returned an invalid bounded result.');
  if (payload.status === 'wrong-editor') throw new Error('Jam Board requires a FigJam board.');
  if (payload.status !== 'ok') throw new Error('Jam Board could not read a bounded current page.');
  return {
    stdout: formatJamBoardResult(payload.data, input), stderr: '', code: 0, result: payload.data,
  };
}
export function jamBoardPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Jam Board routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-jam-board';
}
export function executeJamBoardPlan(plan, adapters = {}) {
  if (jamBoardPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Board.');
  }
  return executeJamBoard(parseJamBoardRequest(plan.argv), adapters);
}
