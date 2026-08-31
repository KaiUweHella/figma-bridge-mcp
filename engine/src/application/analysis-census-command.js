// Exact bounded current-page census for Analyze colors, typography, spacing, and clusters.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  ANALYSIS_CENSUS_ACTIONS,
  analysisCensusArgvFromRequest,
  parseAnalysisCensusRequest,
} from './analysis-census-request.js';

export { analysisCensusArgvFromRequest } from './analysis-census-request.js';

const APPLICATION_IDS = new Set(ANALYSIS_CENSUS_ACTIONS.map((action) => `analyze.${action}`));
export const MAX_ANALYSIS_CENSUS_NODES = 100_000;
export const MAX_ANALYSIS_CENSUS_FACTS = 400_000;
export const MAX_ANALYSIS_CENSUS_RESULT_CODE_UNITS = 200_000;
const MAX_NAME_CODE_UNITS = 1_024;
const MAX_PATTERN_CODE_UNITS = 16_384;
const MAX_COLORS = 20;
const MAX_TYPOGRAPHY = 15;
const MAX_SPACING_VALUES = 10;
const MAX_CLUSTERS = 10;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseAnalysisCensusRequest(
  analysisCensusArgvFromRequest(request));

export function analysisCensusCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${JSON.stringify(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    const clean = (value) => String(value)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_ANALYSIS_CENSUS_RESULT_CODE_UNITS}) {
        throw new Error('Analyze census result exceeded its bounded response limit.');
      }
      return serialized;
    };
    if (!figma.currentPage || !Array.isArray(figma.currentPage.children)) {
      throw new Error('Analyze census requires one available current page.');
    }
    const colors = new Map();
    const typography = new Map();
    const gaps = new Map();
    const paddings = new Map();
    const patterns = new Map();
    const rgbToHex = (color) => '#' + [color.r, color.g, color.b]
      .map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
    const stack = [...figma.currentPage.children].reverse();
    let visited = 0;
    let facts = 0;
    const addFact = () => {
      facts += 1;
      if (facts > ${MAX_ANALYSIS_CENSUS_FACTS}) {
        throw new Error('Analyze census fact limit exceeded.');
      }
    };
    while (stack.length > 0) {
      const node = stack.pop();
      visited += 1;
      if (visited > ${MAX_ANALYSIS_CENSUS_NODES}) {
        throw new Error('Analyze census node limit exceeded.');
      }
      if (!node || typeof node.id !== 'string' || !nodeIdPattern.test(node.id)
        || node.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || typeof node.name !== 'string' || node.name.length > ${MAX_NAME_CODE_UNITS}
        || typeof node.type !== 'string' || node.type.length === 0 || node.type.length > 64) {
        throw new Error('Analyze census found invalid bounded node facts.');
      }
      const children = 'children' in node ? node.children : null;
      if (children !== null && (!Array.isArray(children)
        || children.length > ${MAX_ANALYSIS_CENSUS_NODES})) {
        throw new Error('Analyze census found invalid child facts.');
      }
      if (request.action === 'colors' && Array.isArray(node.fills)) {
        for (const fill of node.fills) {
          if (fill && fill.type === 'SOLID' && fill.color) {
            addFact();
            if (!['r', 'g', 'b'].every((field) => finite(fill.color[field])
              && fill.color[field] >= 0 && fill.color[field] <= 1)) {
              throw new Error('Analyze census found an invalid solid color.');
            }
            const hex = rgbToHex(fill.color);
            colors.set(hex, (colors.get(hex) || 0) + 1);
          }
        }
      } else if (request.action === 'typography' && node.type === 'TEXT') {
        addFact();
        const fontName = node.fontName;
        const family = fontName && typeof fontName.family === 'string'
          ? fontName.family : '(mixed)';
        const style = fontName && typeof fontName.style === 'string'
          ? fontName.style : '(mixed)';
        const size = finite(node.fontSize) ? Math.trunc(node.fontSize) : null;
        if (size !== null && !Number.isSafeInteger(size)) {
          throw new Error('Analyze census found invalid font-size facts.');
        }
        if (family.length > ${MAX_NAME_CODE_UNITS} || style.length > ${MAX_NAME_CODE_UNITS}) {
          throw new Error('Analyze census typography label limit exceeded.');
        }
        const key = JSON.stringify([family, size, style]);
        const current = typography.get(key);
        typography.set(key, current
          ? { ...current, count: current.count + 1 }
          : { family: clean(family), size, style: clean(style), count: 1 });
      } else if (request.action === 'spacing' && node.layoutMode && node.layoutMode !== 'NONE') {
        if (node.itemSpacing !== undefined) {
          addFact();
          if (!finite(node.itemSpacing)) throw new Error('Analyze census found invalid gap facts.');
          gaps.set(node.itemSpacing, (gaps.get(node.itemSpacing) || 0) + 1);
        }
        for (const value of [
          node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft,
        ]) {
          if (value > 0) {
            addFact();
            if (!finite(value)) throw new Error('Analyze census found invalid padding facts.');
            paddings.set(value, (paddings.get(value) || 0) + 1);
          }
        }
      } else if (request.action === 'clusters'
        && (node.type === 'FRAME' || node.type === 'GROUP')) {
        addFact();
        if (children && children.some((child) => !child || typeof child.type !== 'string'
          || child.type.length === 0 || child.type.length > 64)) {
          throw new Error('Analyze census found invalid child type facts.');
        }
        const childTypes = children ? children.map((child) => child.type).sort().join(',') : '';
        const signature = node.type + ':' + childTypes;
        if (signature.length > ${MAX_PATTERN_CODE_UNITS}) {
          throw new Error('Analyze census pattern limit exceeded.');
        }
        if (!patterns.has(signature)) patterns.set(signature, []);
        patterns.get(signature).push({ id: node.id, name: clean(node.name) });
      }
      if (children) {
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
    }
    let data;
    if (request.action === 'colors') {
      data = Array.from(colors.entries())
        .sort((left, right) => right[1] - left[1]).slice(0, ${MAX_COLORS})
        .map(([hex, count]) => ({ hex, count }));
    } else if (request.action === 'typography') {
      data = Array.from(typography.values())
        .sort((left, right) => right.count - left.count).slice(0, ${MAX_TYPOGRAPHY});
    } else if (request.action === 'spacing') {
      const ranked = (values) => Array.from(values.entries())
        .sort((left, right) => right[1] - left[1]).slice(0, ${MAX_SPACING_VALUES})
        .map(([value, count]) => ({ value, count }));
      data = { gaps: ranked(gaps), paddings: ranked(paddings) };
    } else {
      data = Array.from(patterns.entries())
        .filter(([, nodes]) => nodes.length >= 2)
        .sort((left, right) => right[1].length - left[1].length).slice(0, ${MAX_CLUSTERS})
        .map(([pattern, nodes]) => ({
          pattern, count: nodes.length, examples: nodes.slice(0, 3),
        }));
    }
    return bounded({ schemaVersion: 1, action: request.action, visited, data });
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
function count(value, minimum = 1) {
  return Number.isSafeInteger(value) && value >= minimum && value <= MAX_ANALYSIS_CENSUS_FACTS;
}
function validRanked(value, maximum, item) {
  return Array.isArray(value) && value.length <= maximum && value.every(item);
}
function validData(action, data) {
  if (action === 'colors') {
    return validRanked(data, MAX_COLORS, (item) => exact(item, ['hex', 'count'])
      && /^#[0-9a-f]{6}$/.test(item.hex) && count(item.count));
  }
  if (action === 'typography') {
    return validRanked(data, MAX_TYPOGRAPHY, (item) => exact(
      item, ['family', 'size', 'style', 'count'])
      && text(item.family, MAX_NAME_CODE_UNITS)
      && (item.size === null || Number.isSafeInteger(item.size))
      && text(item.style, MAX_NAME_CODE_UNITS) && count(item.count));
  }
  const spacingItem = (item) => exact(item, ['value', 'count'])
    && typeof item.value === 'number' && Number.isFinite(item.value) && count(item.count);
  if (action === 'spacing') {
    return exact(data, ['gaps', 'paddings'])
      && validRanked(data.gaps, MAX_SPACING_VALUES, spacingItem)
      && validRanked(data.paddings, MAX_SPACING_VALUES, spacingItem);
  }
  return validRanked(data, MAX_CLUSTERS, (item) => exact(
    item, ['pattern', 'count', 'examples'])
    && text(item.pattern, MAX_PATTERN_CODE_UNITS, false) && count(item.count, 2)
    && Array.isArray(item.examples) && item.examples.length > 0 && item.examples.length <= 3
    && item.examples.length <= item.count
    && item.examples.every((example) => exact(example, ['id', 'name'])
      && text(example.id, MAX_NODE_REFERENCE_CODE_UNITS, false)
      && NODE_REFERENCE_PATTERN.test(example.id)
      && text(example.name, MAX_NAME_CODE_UNITS)));
}
function validPayload(value, input) {
  return exact(value, ['schemaVersion', 'action', 'visited', 'data'])
    && value.schemaVersion === 1 && value.action === input.action
    && Number.isSafeInteger(value.visited) && value.visited >= 0
    && value.visited <= MAX_ANALYSIS_CENSUS_NODES
    && validData(value.action, value.data);
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS, ' '); }

export function formatAnalysisCensusResult(payload, { json = false } = {}) {
  if (json) return JSON.stringify(payload.data, null, 2);
  if (payload.action === 'colors') {
    return ['Top colors used:', ...payload.data.map(
      (item) => `  ██ ${item.hex} (${item.count}x)`)].join('\n');
  }
  if (payload.action === 'typography') {
    return ['Typography usage:', ...payload.data.map((item) => {
      const size = item.size === null ? 'mixed' : `${item.size}px`;
      return `  ${safeText(item.family)} ${size} ${safeText(item.style)} (${item.count}x)`;
    })].join('\n');
  }
  if (payload.action === 'spacing') {
    return [
      'Gap values:', ...payload.data.gaps.map((item) => `  ${item.value}px (${item.count}x)`),
      '', 'Padding values:',
      ...payload.data.paddings.map((item) => `  ${item.value}px (${item.count}x)`),
    ].join('\n');
  }
  return ['Repeated patterns (potential components):', ...payload.data.map((item) =>
    `  ${item.count}x: ${item.examples.map((example) => safeText(example.name)).join(', ')}`)]
    .join('\n');
}

export async function executeAnalysisCensus(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Analyze census requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(analysisCensusCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANALYSIS_CENSUS_RESULT_CODE_UNITS) {
    throw new Error('Analyze census returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Analyze census returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Analyze census returned an invalid bounded result.');
  }
  return {
    stdout: formatAnalysisCensusResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function analysisCensusPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Analyze census routing requires a Command Plan.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-analysis-census';
}

export function executeAnalysisCensusPlan(plan, adapters = {}) {
  if (analysisCensusPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Analyze census.');
  }
  return executeAnalysisCensus(parseAnalysisCensusRequest(plan.argv), adapters);
}
