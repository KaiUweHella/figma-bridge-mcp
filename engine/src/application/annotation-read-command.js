// Bounded Annotation inspection behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  annotationReadArgvFromRequest,
  annotationReadPlanningArgvFromRequest,
  parseAnnotationReadRequest,
} from './annotation-read-request.js';

export {
  annotationReadArgvFromRequest,
  annotationReadPlanningArgvFromRequest,
} from './annotation-read-request.js';

const APPLICATION_ID = 'annotate.list';
export const MAX_ANNOTATION_READ_ITEMS = 4_096;
export const MAX_ANNOTATION_READ_PROPERTIES = 64;
export const MAX_ANNOTATION_READ_RESULT_CODE_UNITS = 2_000_000;
export const MAX_ANNOTATION_LABEL_CODE_UNITS = 65_536;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const MAX_NODE_TYPE_CODE_UNITS = 64;
const MAX_CATEGORY_ID_CODE_UNITS = 1_024;
export const ANNOTATION_PROPERTY_TYPES = Object.freeze([
  'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight',
  'fills', 'strokes', 'effects', 'strokeWeight', 'cornerRadius', 'textStyleId',
  'textAlignHorizontal', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight',
  'lineHeight', 'letterSpacing', 'itemSpacing', 'padding', 'layoutMode', 'alignItems',
  'opacity', 'mainComponent', 'gridRowGap', 'gridColumnGap', 'gridRowCount',
  'gridColumnCount', 'gridRowAnchorIndex', 'gridColumnAnchorIndex', 'gridRowSpan',
  'gridColumnSpan',
]);
const PROPERTY_TYPES = new Set(ANNOTATION_PROPERTY_TYPES);
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;
const normalized = (request) => parseAnnotationReadRequest(annotationReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function annotationReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const propertyTypes = ${JSON.stringify([...PROPERTY_TYPES])};
    const target = request.nodeId
      ? await figma.getNodeByIdAsync(request.nodeId)
      : figma.currentPage.selection[0];
    if (!target) throw new Error(request.nodeId
      ? 'Annotation Read target was not found in the targeted Figma document.'
      : 'Annotation Read requires one selected node when nodeId is omitted.');
    if (!('annotations' in target)) {
      throw new Error('Target node does not support annotations.');
    }
    const values = target.annotations;
    if (!Array.isArray(values) || values.length > ${MAX_ANNOTATION_READ_ITEMS}) {
      throw new Error('Annotation Read inventory exceeded its bounded item limit.');
    }
    const optionalText = (value, maximum, label) => {
      if (value === undefined) return null;
      if (typeof value !== 'string' || value.length > maximum) {
        throw new Error('Annotation Read returned an invalid ' + label + '.');
      }
      return value;
    };
    const annotations = values.map((annotation) => {
      if (!annotation || typeof annotation !== 'object') {
        throw new Error('Annotation Read returned invalid annotation facts.');
      }
      let properties = null;
      if (annotation.properties !== undefined) {
        if (!Array.isArray(annotation.properties)
          || annotation.properties.length > ${MAX_ANNOTATION_READ_PROPERTIES}) {
          throw new Error('Annotation Read returned invalid property facts.');
        }
        properties = annotation.properties.map((property) => {
          if (!property || typeof property.type !== 'string'
            || !propertyTypes.includes(property.type)) {
            throw new Error('Annotation Read returned invalid property facts.');
          }
          return { type: property.type };
        });
      }
      return {
        label: optionalText(annotation.label, ${MAX_ANNOTATION_LABEL_CODE_UNITS}, 'label'),
        labelMarkdown: optionalText(
          annotation.labelMarkdown, ${MAX_ANNOTATION_LABEL_CODE_UNITS}, 'markdown label'),
        categoryId: optionalText(annotation.categoryId, ${MAX_CATEGORY_ID_CODE_UNITS}, 'category id'),
        properties,
      };
    });
    const result = {
      schemaVersion: 1,
      source: request.nodeId ? 'node' : 'selection',
      node: {
        id: target.id,
        name: String(target.name || ''),
        type: String(target.type || ''),
      },
      annotations,
    };
    if (typeof result.node.id !== 'string' || result.node.id.length === 0
      || result.node.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
      || result.node.name.length > ${MAX_NODE_NAME_CODE_UNITS}
      || result.node.type.length === 0 || result.node.type.length > ${MAX_NODE_TYPE_CODE_UNITS}) {
      throw new Error('Annotation Read returned invalid target facts.');
    }
    const serialized = JSON.stringify(result);
    if (serialized.length > ${MAX_ANNOTATION_READ_RESULT_CODE_UNITS}) {
      throw new Error('Annotation Read result exceeded its bounded response limit.');
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

function optionalText(value, maximum) {
  return value === null || text(value, maximum);
}

function validNodeId(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}

function validPayload(value, input) {
  return exact(value, ['schemaVersion', 'source', 'node', 'annotations'])
    && value.schemaVersion === 1
    && value.source === (input.nodeId ? 'node' : 'selection')
    && exact(value.node, ['id', 'name', 'type'])
    && validNodeId(value.node.id)
    && (!input.nodeId || value.node.id === input.nodeId)
    && text(value.node.name, MAX_NODE_NAME_CODE_UNITS)
    && text(value.node.type, MAX_NODE_TYPE_CODE_UNITS, false)
    && Array.isArray(value.annotations)
    && value.annotations.length <= MAX_ANNOTATION_READ_ITEMS
    && value.annotations.every((annotation) => exact(
      annotation, ['label', 'labelMarkdown', 'categoryId', 'properties'],
    )
      && optionalText(annotation.label, MAX_ANNOTATION_LABEL_CODE_UNITS)
      && optionalText(annotation.labelMarkdown, MAX_ANNOTATION_LABEL_CODE_UNITS)
      && optionalText(annotation.categoryId, MAX_CATEGORY_ID_CODE_UNITS)
      && (annotation.properties === null
        || (Array.isArray(annotation.properties)
          && annotation.properties.length <= MAX_ANNOTATION_READ_PROPERTIES
          && annotation.properties.every((property) => exact(property, ['type'])
            && PROPERTY_TYPES.has(property.type)))));
}

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

export function formatAnnotationReadResult(payload) {
  const lines = [`${safeText(payload.node.name)} (${payload.node.id})`];
  if (payload.annotations.length === 0) {
    lines.push('  (no annotations)');
    return lines.join('\n');
  }
  payload.annotations.forEach((annotation, index) => {
    const label = annotation.label || annotation.labelMarkdown || '(empty)';
    lines.push(`  ${index + 1}. ${safeText(label)}`);
  });
  return lines.join('\n');
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution',
    phase: 'plugin-response',
    outcome: 'unknown-after-dispatch',
    dispatchState: 'failed',
  });
  return error;
}

export async function executeAnnotationRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Annotation Read requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(annotationReadCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANNOTATION_READ_RESULT_CODE_UNITS) {
    throw invalid('Annotation Read returned an invalid bounded result.');
  }
  let result;
  try {
    result = JSON.parse(serialized);
  } catch {
    throw invalid('Annotation Read returned invalid JSON.');
  }
  if (!validPayload(result, input)) {
    throw invalid('Annotation Read returned an invalid bounded result.');
  }
  return {
    stdout: formatAnnotationReadResult(result),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result,
  };
}

export function annotationReadPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Annotation Read routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-annotation-read';
}

export function executeAnnotationReadPlan(plan, adapters = {}) {
  if (annotationReadPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Annotation Read.');
  }
  return executeAnnotationRead(parseAnnotationReadRequest(plan.argv), adapters);
}
