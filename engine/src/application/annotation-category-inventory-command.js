// Bounded file-wide Annotation Category inventory behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  annotationCategoryInventoryArgvFromRequest,
  parseAnnotationCategoryInventoryRequest,
} from './annotation-category-inventory-request.js';
import {
  ANNOTATION_CATEGORY_COLORS,
  MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS,
  MAX_ANNOTATION_CATEGORY_ITEMS,
  MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS,
} from './annotation-category-facts.js';

export { annotationCategoryInventoryArgvFromRequest } from './annotation-category-inventory-request.js';

const APPLICATION_ID = 'annotate.categories';
export const MAX_ANNOTATION_CATEGORY_INVENTORY_ITEMS = MAX_ANNOTATION_CATEGORY_ITEMS;
export const MAX_ANNOTATION_CATEGORY_INVENTORY_RESULT_CODE_UNITS = 1_000_000;
const MAX_ID_CODE_UNITS = MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS;
const MAX_LABEL_CODE_UNITS = MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS;
const COLORS = new Set(ANNOTATION_CATEGORY_COLORS);

export function annotationCategoryInventoryCode() {
  return `(async () => {
    if (!figma.annotations
      || typeof figma.annotations.getAnnotationCategoriesAsync !== 'function') {
      throw new Error('Annotation Category Inventory requires the native Annotations API.');
    }
    const values = await figma.annotations.getAnnotationCategoriesAsync();
    if (!Array.isArray(values) || values.length > ${MAX_ANNOTATION_CATEGORY_INVENTORY_ITEMS}) {
      throw new Error('Annotation Category Inventory exceeded its bounded item limit.');
    }
    const categories = values.map((category) => {
      if (!category || typeof category.id !== 'string' || category.id.length === 0
        || category.id.length > ${MAX_ID_CODE_UNITS}
        || typeof category.label !== 'string' || category.label.length > ${MAX_LABEL_CODE_UNITS}
        || !${JSON.stringify([...COLORS])}.includes(category.color)
        || typeof category.isPreset !== 'boolean') {
        throw new Error('Annotation Category Inventory returned invalid category facts.');
      }
      return {
        id: category.id,
        label: category.label,
        color: category.color,
        isPreset: category.isPreset,
      };
    });
    if (new Set(categories.map((category) => category.id)).size !== categories.length) {
      throw new Error('Annotation Category ids must be unique.');
    }
    const serialized = JSON.stringify({ schemaVersion: 1, categories });
    if (serialized.length > ${MAX_ANNOTATION_CATEGORY_INVENTORY_RESULT_CODE_UNITS}) {
      throw new Error('Annotation Category Inventory result exceeded its bounded response limit.');
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

function validPayload(value) {
  return exact(value, ['schemaVersion', 'categories'])
    && value.schemaVersion === 1
    && Array.isArray(value.categories)
    && value.categories.length <= MAX_ANNOTATION_CATEGORY_INVENTORY_ITEMS
    && value.categories.every((category) => exact(
      category, ['id', 'label', 'color', 'isPreset'],
    )
      && text(category.id, MAX_ID_CODE_UNITS, false)
      && text(category.label, MAX_LABEL_CODE_UNITS)
      && COLORS.has(category.color)
      && typeof category.isPreset === 'boolean')
    && new Set(value.categories.map((category) => category.id)).size === value.categories.length;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch',
  });
  return error;
}

export async function executeAnnotationCategoryInventory(request = {}, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Annotation Category Inventory requires a Figma evaluate adapter.');
  }
  parseAnnotationCategoryInventoryRequest(annotationCategoryInventoryArgvFromRequest(request));
  const serialized = await adapters.evaluate(annotationCategoryInventoryCode());
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANNOTATION_CATEGORY_INVENTORY_RESULT_CODE_UNITS) {
    throw invalid('Annotation Category Inventory returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw invalid('Annotation Category Inventory returned invalid JSON.');
  }
  if (!validPayload(payload)) {
    throw invalid('Annotation Category Inventory returned an invalid bounded result.');
  }
  return { stdout: safeJson(payload.categories), stderr: '', result: payload };
}

export function annotationCategoryInventoryPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Annotation Category Inventory routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-annotation-category-inventory';
}

export function executeAnnotationCategoryInventoryPlan(plan, adapters = {}) {
  if (annotationCategoryInventoryPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Annotation Category Inventory.');
  }
  return executeAnnotationCategoryInventory(
    parseAnnotationCategoryInventoryRequest(plan.argv), adapters,
  );
}
