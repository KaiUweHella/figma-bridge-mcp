// Plan-bound, patch-exact and rollback-owned `annotate edit` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  annotationEditArgvFromRequest,
  annotationEditPlanningArgvFromRequest,
  MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS,
  parseAnnotationEditRequest,
} from './annotation-edit-request.js';
import {
  ANNOTATION_PROPERTY_TYPES,
  MAX_ANNOTATION_LABEL_CODE_UNITS,
  MAX_ANNOTATION_READ_ITEMS,
  MAX_ANNOTATION_READ_PROPERTIES,
} from './annotation-facts.js';

export {
  annotationEditArgvFromRequest,
  annotationEditPlanningArgvFromRequest,
} from './annotation-edit-request.js';

const APPLICATION_ID = 'annotate.edit';
export const MAX_ANNOTATION_EDIT_CATEGORIES = 1_024;
export const MAX_ANNOTATION_EDIT_RESULT_CODE_UNITS = 196_608;
export const MAX_ANNOTATION_EDIT_SNAPSHOT_CODE_UNITS = 1_750_000;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const MAX_NODE_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const normalized = (request) => parseAnnotationEditRequest(annotationEditArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function annotationEditCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const propertyTypes = ${JSON.stringify(ANNOTATION_PROPERTY_TYPES)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_ANNOTATION_EDIT_RESULT_CODE_UNITS}) {
        throw new Error('Annotation Edit result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const identity = (node) => ({
      id: clean(node.id, ${MAX_NODE_REFERENCE_CODE_UNITS}),
      name: clean(String(node.name || ''), ${MAX_NODE_NAME_CODE_UNITS}),
      type: clean(String(node.type || ''), ${MAX_NODE_TYPE_CODE_UNITS}),
    });
    const copyAnnotation = (annotation, fixed = false) => {
      if (!annotation || typeof annotation !== 'object') {
        throw new Error('Annotation Edit found invalid annotation facts.');
      }
      const copy = fixed ? {
        label: null, labelMarkdown: null, categoryId: null, properties: null,
      } : {};
      if (annotation.label !== undefined) {
        if (typeof annotation.label !== 'string'
          || annotation.label.length > ${MAX_ANNOTATION_LABEL_CODE_UNITS}) {
          throw new Error('Annotation Edit found an invalid label.');
        }
        copy.label = annotation.label;
      }
      if (annotation.labelMarkdown !== undefined) {
        if (typeof annotation.labelMarkdown !== 'string'
          || annotation.labelMarkdown.length > ${MAX_ANNOTATION_LABEL_CODE_UNITS}) {
          throw new Error('Annotation Edit found an invalid markdown label.');
        }
        copy.labelMarkdown = annotation.labelMarkdown;
      }
      if (annotation.categoryId !== undefined) {
        if (typeof annotation.categoryId !== 'string'
          || annotation.categoryId.length > ${MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS}) {
          throw new Error('Annotation Edit found an invalid category id.');
        }
        copy.categoryId = annotation.categoryId;
      }
      if (annotation.properties !== undefined) {
        if (!Array.isArray(annotation.properties)
          || annotation.properties.length > ${MAX_ANNOTATION_READ_PROPERTIES}) {
          throw new Error('Annotation Edit found invalid property facts.');
        }
        copy.properties = annotation.properties.map((property) => {
          if (!property || typeof property.type !== 'string'
            || !propertyTypes.includes(property.type)) {
            throw new Error('Annotation Edit found invalid property facts.');
          }
          return { type: property.type };
        });
      }
      return copy;
    };
    const facts = (node) => {
      if (!node || typeof node.id !== 'string' || node.id !== request.nodeId
        || typeof node.name !== 'string' || node.name.length > ${MAX_NODE_NAME_CODE_UNITS}
        || typeof node.type !== 'string' || node.type.length === 0
        || node.type.length > ${MAX_NODE_TYPE_CODE_UNITS}
        || !('annotations' in node) || !Array.isArray(node.annotations)
        || node.annotations.length > ${MAX_ANNOTATION_READ_ITEMS}) {
        throw new Error('Annotation Edit requires an exact annotation-capable node.');
      }
      const values = node.annotations.map((annotation) => copyAnnotation(annotation));
      if (JSON.stringify(values).length > ${MAX_ANNOTATION_EDIT_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Annotation Edit snapshot exceeded its bounded limit.');
      }
      return { node, values };
    };
    const resolveCategory = async (query) => {
      if (query === undefined) return undefined;
      if (query === '') return null;
      if (!figma.annotations
        || typeof figma.annotations.getAnnotationCategoryByIdAsync !== 'function'
        || typeof figma.annotations.getAnnotationCategoriesAsync !== 'function') {
        throw new Error('Annotation Edit category resolution requires the native Annotations API.');
      }
      const categoryFact = (category) => {
        if (!category || typeof category.id !== 'string' || category.id.length === 0
          || category.id.length > ${MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS}
          || typeof category.label !== 'string'
          || category.label.length > ${MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS}) {
          throw new Error('Annotation Edit found invalid category facts.');
        }
        return { id: category.id, label: category.label };
      };
      const direct = await figma.annotations.getAnnotationCategoryByIdAsync(query);
      if (direct) return categoryFact(direct).id;
      const native = await figma.annotations.getAnnotationCategoriesAsync();
      if (!Array.isArray(native) || native.length > ${MAX_ANNOTATION_EDIT_CATEGORIES}) {
        throw new Error('Annotation Edit category inventory exceeded its bounded limit.');
      }
      const categories = native.map(categoryFact);
      if (new Set(categories.map((category) => category.id)).size !== categories.length) {
        throw new Error('Annotation Edit category ids must be unique.');
      }
      const exact = categories.filter((category) => category.label === query);
      const matches = exact.length > 0 ? exact : categories.filter(
        (category) => category.label.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) throw new Error('Ambiguous annotation category: ' + query);
      if (matches.length === 0) throw new Error('Annotation category not found: ' + query);
      return matches[0].id;
    };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Annotation Edit preflight failed'),
    });
    const failed = (outcome, restored, failure, residue) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored,
      residue, failure: failureText(failure, 'fresh mutation postcondition failed'),
    });

    let before;
    let resolvedCategoryId;
    try {
      before = facts(await figma.getNodeByIdAsync(request.nodeId));
      if (request.index >= before.values.length) {
        throw new Error('Annotation index out of range: ' + request.index);
      }
      resolvedCategoryId = await resolveCategory(request.category);
    } catch (error) {
      return refusal(error);
    }

    const expected = before.values.map((annotation) => copyAnnotation(annotation));
    const edited = expected[request.index];
    if (request.text !== undefined) {
      delete edited.label;
      delete edited.labelMarkdown;
      edited[request.markdown ? 'labelMarkdown' : 'label'] = request.text;
    }
    if (resolvedCategoryId !== undefined) {
      if (resolvedCategoryId === null) delete edited.categoryId;
      else edited.categoryId = resolvedCategoryId;
    }
    if (request.properties !== undefined) {
      edited.properties = request.properties.map((type) => ({ type }));
    }
    expected[request.index] = copyAnnotation(edited);
    const categoryResolution = request.category === undefined ? null : {
      requested: request.category,
      resolvedId: resolvedCategoryId,
    };
    const success = (state, attempted, mutationError) => bounded({
      schemaVersion: 1, status: 'edited',
      outcome: mutationError ? 'verified-after-error' : 'verified',
      node: identity(state.node), index: request.index,
      annotation: copyAnnotation(state.values[request.index], true),
      categoryResolution, count: state.values.length, attempted, residue: [],
      warnings: mutationError ? [failureText(
        mutationError, 'native acknowledgement failed after mutation')] : [],
    });
    if (same(expected, before.values)) return success(before, 0, null);

    let mutationError = null;
    try {
      before.node.annotations = expected;
    } catch (error) {
      mutationError = error;
    }

    const fresh = async () => facts(await figma.getNodeByIdAsync(request.nodeId));
    let after = null;
    try {
      after = await fresh();
      if (same(after.values, expected)) {
        delete globalThis.__invCache;
        return success(after, 1, mutationError);
      }
    } catch (error) {
      mutationError ||= error;
    }

    if (after && same(after.values, before.values)) {
      return failed('unchanged', 0, mutationError, ['annotations']);
    }

    let rollbackError = null;
    try {
      const rollback = facts(await figma.getNodeByIdAsync(request.nodeId));
      rollback.node.annotations = before.values;
    } catch (error) {
      rollbackError = error;
    }
    try {
      const restored = await fresh();
      if (same(restored.values, before.values)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, mutationError || rollbackError, []);
      }
      return failed('partial-residue', 0, mutationError || rollbackError, ['annotations']);
    } catch (error) {
      return failed('verification-unavailable', 0,
        mutationError || rollbackError || error, []);
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
  return exact(value, ['id', 'name', 'type'])
    && value.id === input.nodeId
    && text(value.id, MAX_NODE_REFERENCE_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, MAX_NODE_NAME_CODE_UNITS)
    && text(value.type, MAX_NODE_TYPE_CODE_UNITS, false);
}

function validAnnotation(value) {
  return exact(value, ['label', 'labelMarkdown', 'categoryId', 'properties'])
    && (value.label === null || text(value.label, MAX_ANNOTATION_LABEL_CODE_UNITS))
    && (value.labelMarkdown === null
      || text(value.labelMarkdown, MAX_ANNOTATION_LABEL_CODE_UNITS))
    && (value.categoryId === null
      || text(value.categoryId, MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS, false))
    && (value.properties === null
      || (Array.isArray(value.properties)
        && value.properties.length <= MAX_ANNOTATION_READ_PROPERTIES
        && value.properties.every((property) => exact(property, ['type'])
          && ANNOTATION_PROPERTY_TYPES.includes(property.type))));
}

function sameProperties(annotation, input) {
  return input.properties === undefined
    || Array.isArray(annotation.properties)
      && annotation.properties.map((property) => property.type).join(',')
        === input.properties.join(',');
}

function validCategoryResolution(value, annotation, input) {
  if (input.category === undefined) return value === null;
  return exact(value, ['requested', 'resolvedId'])
    && value.requested === input.category
    && (input.category === ''
      ? value.resolvedId === null && annotation.categoryId === null
      : text(value.resolvedId, MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS, false)
        && annotation.categoryId === value.resolvedId);
}

function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'node', 'index', 'annotation',
    'categoryResolution', 'count', 'attempted', 'residue', 'warnings',
  ])
    && value.schemaVersion === 1 && value.status === 'edited'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validNode(value.node, input) && value.index === input.index
    && validAnnotation(value.annotation)
    && (input.text === undefined
      || (input.markdown
        ? value.annotation.label === null && value.annotation.labelMarkdown === input.text
        : value.annotation.label === input.text && value.annotation.labelMarkdown === null))
    && sameProperties(value.annotation, input)
    && validCategoryResolution(value.categoryResolution, value.annotation, input)
    && Number.isInteger(value.count) && value.count > input.index
    && value.count <= MAX_ANNOTATION_READ_ITEMS
    && [0, 1].includes(value.attempted)
    && (value.attempted !== 0 || value.outcome === 'verified')
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
}

function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}

function validFailure(value) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && value.residue.every((entry) => entry === 'annotations')
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (!['unchanged', 'partial-residue'].includes(value.outcome)
      || value.restored === 0 && value.residue.length === 1)
    && (value.outcome !== 'verification-unavailable'
      || value.restored === 0 && value.residue.length === 0);
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

function compactAnnotation(annotation) {
  return {
    ...(annotation.label === null ? {} : { label: annotation.label }),
    ...(annotation.labelMarkdown === null ? {} : { labelMarkdown: annotation.labelMarkdown }),
    ...(annotation.categoryId === null ? {} : { categoryId: annotation.categoryId }),
    ...(annotation.properties === null ? {} : { properties: annotation.properties }),
  };
}

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatAnnotationEditResult(result) {
  return safeJson({
    id: result.node.id,
    name: result.node.name,
    index: result.index,
    annotation: compactAnnotation(result.annotation),
  });
}

export async function executeAnnotationEdit(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Annotation Edit requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(annotationEditCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANNOTATION_EDIT_RESULT_CODE_UNITS) {
    throw pluginResultError('Annotation Edit returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginResultError('Annotation Edit returned invalid JSON.');
  }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) {
      throw pluginResultError('Annotation Edit returned an invalid bounded result.');
    }
    throw mutationError(`Annotation Edit made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) {
      throw pluginResultError('Annotation Edit returned an invalid bounded result.');
    }
    throw mutationError(`Annotation Edit failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored,
        residueCount: payload.outcome === 'verification-unavailable'
          ? 1 : payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Annotation Edit returned an invalid bounded result.');
  }
  return {
    stdout: formatAnnotationEditResult(payload),
    stderr: payload.warnings.length > 0 ? `⚠ ${payload.warnings.join('; ')}` : '',
    result: payload,
  };
}

export function annotationEditPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Annotation Edit routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-annotation-edit';
}

export function executeAnnotationEditPlan(plan, adapters = {}) {
  if (annotationEditPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Annotation Edit.');
  }
  return executeAnnotationEdit(parseAnnotationEditRequest(plan.argv), adapters);
}
