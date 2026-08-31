// Plan-bound, freshly verified and rollback-owned `annotate clear` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  annotationClearArgvFromRequest,
  annotationClearPlanningArgvFromRequest,
  parseAnnotationClearRequest,
} from './annotation-clear-request.js';
import {
  ANNOTATION_PROPERTY_TYPES,
  MAX_ANNOTATION_LABEL_CODE_UNITS,
  MAX_ANNOTATION_READ_ITEMS,
  MAX_ANNOTATION_READ_PROPERTIES,
} from './annotation-facts.js';

export {
  annotationClearArgvFromRequest,
  annotationClearPlanningArgvFromRequest,
} from './annotation-clear-request.js';

const APPLICATION_ID = 'annotate.clear';
export const MAX_ANNOTATION_CLEAR_RESULT_CODE_UNITS = 32_768;
export const MAX_ANNOTATION_CLEAR_SNAPSHOT_CODE_UNITS = 1_750_000;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const MAX_NODE_TYPE_CODE_UNITS = 64;
const MAX_CATEGORY_ID_CODE_UNITS = 1_024;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;
const normalized = (request) => parseAnnotationClearRequest(annotationClearArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function annotationClearCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const propertyTypes = ${JSON.stringify(ANNOTATION_PROPERTY_TYPES)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_ANNOTATION_CLEAR_RESULT_CODE_UNITS}) {
        throw new Error('Annotation Clear result exceeded its bounded response limit.');
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
    const copyAnnotation = (annotation) => {
      if (!annotation || typeof annotation !== 'object') {
        throw new Error('Annotation Clear found invalid annotation facts.');
      }
      const copy = {};
      if (annotation.label !== undefined) {
        if (typeof annotation.label !== 'string'
          || annotation.label.length > ${MAX_ANNOTATION_LABEL_CODE_UNITS}) {
          throw new Error('Annotation Clear found an invalid label.');
        }
        copy.label = annotation.label;
      }
      if (annotation.labelMarkdown !== undefined) {
        if (typeof annotation.labelMarkdown !== 'string'
          || annotation.labelMarkdown.length > ${MAX_ANNOTATION_LABEL_CODE_UNITS}) {
          throw new Error('Annotation Clear found an invalid markdown label.');
        }
        copy.labelMarkdown = annotation.labelMarkdown;
      }
      if (annotation.categoryId !== undefined) {
        if (typeof annotation.categoryId !== 'string'
          || annotation.categoryId.length > ${MAX_CATEGORY_ID_CODE_UNITS}) {
          throw new Error('Annotation Clear found an invalid category id.');
        }
        copy.categoryId = annotation.categoryId;
      }
      if (annotation.properties !== undefined) {
        if (!Array.isArray(annotation.properties)
          || annotation.properties.length > ${MAX_ANNOTATION_READ_PROPERTIES}) {
          throw new Error('Annotation Clear found invalid property facts.');
        }
        copy.properties = annotation.properties.map((property) => {
          if (!property || typeof property.type !== 'string'
            || !propertyTypes.includes(property.type)) {
            throw new Error('Annotation Clear found invalid property facts.');
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
        throw new Error('Annotation Clear requires an exact annotation-capable node.');
      }
      const values = node.annotations.map(copyAnnotation);
      if (JSON.stringify(values).length > ${MAX_ANNOTATION_CLEAR_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Annotation Clear snapshot exceeded its bounded limit.');
      }
      return { node, values };
    };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Annotation Clear preflight failed'),
    });
    const failed = (outcome, restored, failure, residue) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored,
      residue, failure: failureText(failure, 'fresh mutation postcondition failed'),
    });

    let before;
    try {
      before = facts(await figma.getNodeByIdAsync(request.nodeId));
    } catch (error) {
      return refusal(error);
    }
    if (before.values.length === 0) {
      return bounded({
        schemaVersion: 1, status: 'cleared', outcome: 'verified',
        node: identity(before.node), cleared: 0, attempted: 0, residue: [], warnings: [],
      });
    }

    let mutationError = null;
    try {
      before.node.annotations = [];
    } catch (error) {
      mutationError = error;
    }

    const fresh = async () => facts(await figma.getNodeByIdAsync(request.nodeId));
    let after = null;
    try {
      after = await fresh();
      if (after.values.length === 0) {
        delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1, status: 'cleared',
          outcome: mutationError ? 'verified-after-error' : 'verified',
          node: identity(after.node), cleared: before.values.length, attempted: 1,
          residue: [], warnings: mutationError ? [failureText(
            mutationError, 'native acknowledgement failed after mutation')] : [],
        });
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

function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'node', 'cleared', 'attempted', 'residue', 'warnings',
  ])
    && value.schemaVersion === 1 && value.status === 'cleared'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validNode(value.node, input)
    && Number.isInteger(value.cleared) && value.cleared >= 0
    && value.cleared <= MAX_ANNOTATION_READ_ITEMS
    && [0, 1].includes(value.attempted)
    && (value.attempted !== 0 || value.cleared === 0 && value.outcome === 'verified')
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

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

export function formatAnnotationClearResult(result) {
  return `✓ Cleared annotations on ${safeText(result.node.name)} (${result.node.id})`;
}

export async function executeAnnotationClear(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Annotation Clear requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(annotationClearCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANNOTATION_CLEAR_RESULT_CODE_UNITS) {
    throw pluginResultError('Annotation Clear returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginResultError('Annotation Clear returned invalid JSON.');
  }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) {
      throw pluginResultError('Annotation Clear returned an invalid bounded result.');
    }
    throw mutationError(`Annotation Clear made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) {
      throw pluginResultError('Annotation Clear returned an invalid bounded result.');
    }
    throw mutationError(`Annotation Clear failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored,
        residueCount: payload.outcome === 'verification-unavailable'
          ? 1 : payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Annotation Clear returned an invalid bounded result.');
  }
  return {
    stdout: formatAnnotationClearResult(payload),
    stderr: payload.warnings.length > 0 ? `⚠ ${payload.warnings.join('; ')}` : '',
    result: payload,
  };
}

export function annotationClearPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Annotation Clear routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-annotation-clear';
}

export function executeAnnotationClearPlan(plan, adapters = {}) {
  if (annotationClearPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Annotation Clear.');
  }
  return executeAnnotationClear(parseAnnotationClearRequest(plan.argv), adapters);
}
