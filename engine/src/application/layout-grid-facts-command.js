// Exact bounded node-side Layout Grid Facts Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { isFigmaPositiveInfinity } from './figma-scalar.js';
import { isExactLayoutGridList } from './layout-grid-contract.js';
import {
  layoutGridFactsArgvFromRequest,
  layoutGridFactsPlanningArgvFromRequest,
  parseLayoutGridFactsRequest,
} from './layout-grid-facts-request.js';

export {
  layoutGridFactsArgvFromRequest,
  layoutGridFactsPlanningArgvFromRequest,
} from './layout-grid-facts-request.js';

const LAYOUT_GRID_FACTS_APPLICATION_ID = 'grid.list';
export const MAX_LAYOUT_GRID_FACTS_SERIALIZED_CODE_UNITS = 200_000;
export const MAX_LAYOUT_GRID_FACTS_GRIDS = 1024;
export const MAX_LAYOUT_GRID_FACTS_VALUES = 20_000;
export const MAX_LAYOUT_GRID_FACTS_DEPTH = 16;
export const MAX_LAYOUT_GRID_FACTS_CONTAINER_ENTRIES = 1024;
export const MAX_LAYOUT_GRID_FACTS_STRING_CODE_UNITS = 65_536;
const MAX_LAYOUT_GRID_FACTS_KEY_CODE_UNITS = 128;
const MAX_LAYOUT_GRID_FACTS_LABEL_CODE_UNITS = 1024;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const GRID_NODE_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLOT', 'SLIDE']);
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

function normalizedRequest(request) {
  return parseLayoutGridFactsRequest(layoutGridFactsArgvFromRequest(request));
}

export function layoutGridFactsCode(request) {
  const input = normalizedRequest(request);
  const target = input.nodeId
    ? `await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)})`
    : 'figma.currentPage.selection[0]';
  return `(async () => {
    const n = ${target};
    if (!n) throw new Error(${input.nodeId
    ? "'Layout Grid Facts target was not found in the targeted Figma document.'"
    : "'Layout Grid Facts requires one selected node when nodeId is omitted.'"});
    if (!('layoutGrids' in n) || !('gridStyleId' in n)) {
      throw new Error('Target node does not support layout grids.');
    }
    if (n.layoutGrids.length > ${MAX_LAYOUT_GRID_FACTS_GRIDS}) {
      throw new Error('Layout Grid Facts grid limit exceeded.');
    }
    const layoutGrids = n.layoutGrids.map((grid) => {
      if ((grid.pattern === 'ROWS' || grid.pattern === 'COLUMNS')
        && grid.count === Infinity) {
        return { ...grid, count: { $figmaScalar: 'Infinity' } };
      }
      return grid;
    });
    const payload = {
      schemaVersion: 1,
      source: ${JSON.stringify(input.nodeId ? 'node' : 'selection')},
      node: { id: n.id, name: n.name, type: n.type },
      gridStyleId: n.gridStyleId,
      layoutGrids,
    };

    let values = 0;
    const seen = new Set();
    const encode = (value, depth = 0) => {
      values++;
      if (values > ${MAX_LAYOUT_GRID_FACTS_VALUES}) {
        throw new Error('Layout Grid Facts value limit exceeded.');
      }
      if (depth > ${MAX_LAYOUT_GRID_FACTS_DEPTH}) {
        throw new Error('Layout Grid Facts depth limit exceeded.');
      }
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        throw new Error('Layout Grid Facts contains an unsupported non-finite number.');
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_LAYOUT_GRID_FACTS_STRING_CODE_UNITS}) {
          throw new Error('Layout Grid Facts string limit exceeded.');
        }
        return value;
      }
      if (!value || typeof value !== 'object') {
        throw new Error('Layout Grid Facts contains a non-projectable value.');
      }
      if (seen.has(value)) throw new Error('Layout Grid Facts contains a cycle.');
      seen.add(value);
      let output;
      if (Array.isArray(value)) {
        if (value.length > ${MAX_LAYOUT_GRID_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Layout Grid Facts array limit exceeded.');
        }
        output = value.map((item) => encode(item, depth + 1));
      } else {
        const keys = Object.keys(value);
        if (keys.length > ${MAX_LAYOUT_GRID_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Layout Grid Facts object limit exceeded.');
        }
        output = Object.create(null);
        for (const key of keys) {
          if (key.length > ${MAX_LAYOUT_GRID_FACTS_KEY_CODE_UNITS}) {
            throw new Error('Layout Grid Facts key limit exceeded.');
          }
          const encoded = encode(value[key], depth + 1);
          if (encoded === undefined) {
            throw new Error('Layout Grid Facts contains an undefined value.');
          }
          output[key] = encoded;
        }
      }
      seen.delete(value);
      return output;
    };
    const serialized = JSON.stringify(encode(payload));
    if (serialized.length > ${MAX_LAYOUT_GRID_FACTS_SERIALIZED_CODE_UNITS}) {
      throw new Error('Layout Grid Facts serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function boundedString(value, maximum, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validPayload(value, input) {
  return exactKeys(value, ['schemaVersion', 'source', 'node', 'gridStyleId', 'layoutGrids'])
    && value.schemaVersion === 1
    && value.source === (input.nodeId ? 'node' : 'selection')
    && exactKeys(value.node, ['id', 'name', 'type'])
    && boundedString(value.node.id, MAX_LAYOUT_GRID_FACTS_LABEL_CODE_UNITS, { empty: false })
    && NODE_ID_PATTERN.test(value.node.id)
    && (!input.nodeId || value.node.id === input.nodeId)
    && boundedString(value.node.name, MAX_LAYOUT_GRID_FACTS_LABEL_CODE_UNITS)
    && GRID_NODE_TYPES.has(value.node.type)
    && boundedString(value.gridStyleId, MAX_LAYOUT_GRID_FACTS_LABEL_CODE_UNITS)
    && isExactLayoutGridList(value.layoutGrids, {
      maxEntries: MAX_LAYOUT_GRID_FACTS_GRIDS,
      maxLabelCodeUnits: MAX_LAYOUT_GRID_FACTS_LABEL_CODE_UNITS,
    });
}

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function formattedColor(color) {
  return color
    ? `rgba(${color.r},${color.g},${color.b},${color.a})`
    : null;
}

export function formatLayoutGridFactsResult(payload, { json = false } = {}) {
  const { schemaVersion: _schemaVersion, source: _source, ...facts } = payload;
  if (json) return safePrettyJson(facts);
  const lines = [`${safeText(facts.node.name)} (${facts.node.id}, ${facts.node.type})`];
  if (facts.gridStyleId) lines.push(`  grid style: ${safeText(facts.gridStyleId)}`);
  if (facts.layoutGrids.length === 0) {
    lines.push('  (no layout grids)');
    return lines.join('\n');
  }
  facts.layoutGrids.forEach((grid, index) => {
    const fields = grid.pattern === 'GRID'
      ? [`size=${grid.sectionSize}px`]
      : [
        `count=${isFigmaPositiveInfinity(grid.count) ? 'Auto' : grid.count}`,
        `gutter=${grid.gutterSize}px`,
        `align=${grid.alignment}`,
        ...(grid.sectionSize === undefined ? [] : [`section=${grid.sectionSize}px`]),
        ...(grid.offset === undefined ? [] : [`offset=${grid.offset}px`]),
      ];
    if (grid.visible !== undefined) fields.push(`visible=${grid.visible}`);
    const color = formattedColor(grid.color);
    if (color) fields.push(`color=${color}`);
    if (grid.boundVariables && Object.keys(grid.boundVariables).length > 0) {
      const bindings = Object.entries(grid.boundVariables)
        .map(([field, alias]) => `${safeText(field)}→${safeText(alias.id)}`)
        .join(',');
      fields.push(`bindings=${bindings}`);
    }
    lines.push(`  ${index + 1}. ${grid.pattern}  ${fields.join('  ')}`);
  });
  return lines.join('\n');
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeLayoutGridFacts(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeLayoutGridFacts requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(layoutGridFactsCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_LAYOUT_GRID_FACTS_SERIALIZED_CODE_UNITS) {
    throw new Error('Layout Grid Facts returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Layout Grid Facts returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Layout Grid Facts returned an invalid bounded result.');
  }
  return {
    stdout: formatLayoutGridFactsResult(payload, { json: input.json }),
    stderr: input.warning || '',
    result: payload,
  };
}

export function layoutGridFactsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Layout Grid Facts routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === LAYOUT_GRID_FACTS_APPLICATION_ID
    ? 'command-application' : 'not-layout-grid-facts';
}

export async function executeLayoutGridFactsPlan(plan, adapters = {}) {
  if (layoutGridFactsPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Layout Grid Facts Command Application.`);
  }
  return executeLayoutGridFacts(parseLayoutGridFactsRequest(plan.argv), adapters);
}
