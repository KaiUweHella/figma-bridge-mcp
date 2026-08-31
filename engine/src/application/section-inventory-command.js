// Bounded current-page Section inventory behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  parseSectionInventoryRequest,
  sectionInventoryArgvFromRequest,
} from './section-inventory-request.js';

export { sectionInventoryArgvFromRequest } from './section-inventory-request.js';

const APPLICATION_ID = 'section.list';
export const MAX_SECTION_INVENTORY_ITEMS = 10_000;
export const MAX_SECTION_INVENTORY_RESULT_CODE_UNITS = 2_000_000;
const MAX_NAME_CODE_UNITS = 1_024;
const MAX_CHILDREN = 1_000_000;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

export function sectionInventoryCode() {
  return `(async () => {
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const page = figma.currentPage;
    if (!page || page.type !== 'PAGE' || typeof page.findAll !== 'function') {
      throw new Error('Section Inventory requires a compatible current Page.');
    }
    const values = page.findAll((node) => node.type === 'SECTION');
    if (!Array.isArray(values) || values.length > ${MAX_SECTION_INVENTORY_ITEMS}) {
      throw new Error('Section Inventory exceeded its bounded item limit.');
    }
    const sections = values.map((section) => {
      if (!section || section.type !== 'SECTION' || typeof section.id !== 'string'
        || typeof section.name !== 'string' || section.name.length > ${MAX_NAME_CODE_UNITS}
        || !section.children || !Number.isInteger(section.children.length)
        || section.children.length < 0 || section.children.length > ${MAX_CHILDREN}) {
        throw new Error('Section Inventory returned invalid section facts.');
      }
      return {
        id: clean(section.id, 512),
        name: clean(section.name, ${MAX_NAME_CODE_UNITS}),
        count: section.children.length,
      };
    });
    const result = {
      schemaVersion: 1,
      page: {
        id: clean(page.id, 512),
        name: clean(String(page.name || ''), ${MAX_NAME_CODE_UNITS}),
      },
      sections,
    };
    const serialized = JSON.stringify(result);
    if (serialized.length > ${MAX_SECTION_INVENTORY_RESULT_CODE_UNITS}) {
      throw new Error('Section Inventory result exceeded its bounded response limit.');
    }
    return serialized;
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

function validNodeId(value) {
  return text(value, 512, false) && NODE_REFERENCE_PATTERN.test(value);
}

function validPayload(value) {
  return exact(value, ['schemaVersion', 'page', 'sections'])
    && value.schemaVersion === 1
    && exact(value.page, ['id', 'name'])
    && validNodeId(value.page.id)
    && text(value.page.name, MAX_NAME_CODE_UNITS)
    && Array.isArray(value.sections)
    && value.sections.length <= MAX_SECTION_INVENTORY_ITEMS
    && value.sections.every((section) => exact(section, ['id', 'name', 'count'])
      && validNodeId(section.id)
      && text(section.name, MAX_NAME_CODE_UNITS)
      && Number.isInteger(section.count) && section.count >= 0 && section.count <= MAX_CHILDREN)
    && new Set(value.sections.map((section) => section.id)).size === value.sections.length;
}

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

export function formatSectionInventoryResult(payload) {
  if (payload.sections.length === 0) return '(no sections on this page)';
  return payload.sections.map((section) => (
    `  ${safeText(section.name)}  (${section.id})  ${section.count} children`
  )).join('\n');
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch',
  });
  return error;
}

export async function executeSectionInventory(request = {}, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Section Inventory requires a Figma evaluate adapter.');
  }
  parseSectionInventoryRequest(sectionInventoryArgvFromRequest(request));
  const serialized = await adapters.evaluate(sectionInventoryCode());
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SECTION_INVENTORY_RESULT_CODE_UNITS) {
    throw invalid('Section Inventory returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw invalid('Section Inventory returned invalid JSON.');
  }
  if (!validPayload(payload)) {
    throw invalid('Section Inventory returned an invalid bounded result.');
  }
  return { stdout: formatSectionInventoryResult(payload), stderr: '', result: payload };
}

export function sectionInventoryPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Section Inventory routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-section-inventory';
}

export function executeSectionInventoryPlan(plan, adapters = {}) {
  if (sectionInventoryPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Section Inventory.');
  }
  return executeSectionInventory(parseSectionInventoryRequest(plan.argv), adapters);
}
