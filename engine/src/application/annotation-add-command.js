// Plan-bound, bounded and journaled single/query `annotate add` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  ANNOTATION_CATEGORY_COLORS,
  MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS,
  MAX_ANNOTATION_CATEGORY_ITEMS,
  MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS,
} from './annotation-category-facts.js';
import {
  ANNOTATION_PROPERTY_TYPES,
  MAX_ANNOTATION_LABEL_CODE_UNITS,
  MAX_ANNOTATION_READ_ITEMS,
  MAX_ANNOTATION_READ_PROPERTIES,
} from './annotation-facts.js';
import {
  annotationAddArgvFromRequest,
  annotationAddPlanningArgvFromRequest,
  parseAnnotationAddRequest,
} from './annotation-add-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  annotationAddArgvFromRequest,
  annotationAddPlanningArgvFromRequest,
} from './annotation-add-request.js';

const APPLICATION_ID = 'annotate.add';
export const MAX_ANNOTATION_ADD_TARGETS = 1_024;
export const MAX_ANNOTATION_ADD_RESULT_CODE_UNITS = 2_000_000;
export const MAX_ANNOTATION_ADD_SNAPSHOT_CODE_UNITS = 1_750_000;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const MAX_NODE_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const MAX_WARNING_FACTS = 32;
const MAX_RESIDUE_FACTS = 64;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;
const normalized = (request) => parseAnnotationAddRequest(annotationAddArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function annotationAddCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const propertyTypes = ${JSON.stringify(ANNOTATION_PROPERTY_TYPES)};
    const categoryColors = ${JSON.stringify(ANNOTATION_CATEGORY_COLORS)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_ANNOTATION_ADD_RESULT_CODE_UNITS}) {
        throw new Error('Annotation Add result exceeded its bounded response limit.');
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
        throw new Error('Annotation Add found invalid annotation facts.');
      }
      const copy = fixed ? {
        label: null, labelMarkdown: null, categoryId: null, properties: null,
      } : {};
      if (annotation.label !== undefined) {
        if (typeof annotation.label !== 'string'
          || annotation.label.length > ${MAX_ANNOTATION_LABEL_CODE_UNITS}) {
          throw new Error('Annotation Add found an invalid label.');
        }
        copy.label = annotation.label;
      }
      if (annotation.labelMarkdown !== undefined) {
        if (typeof annotation.labelMarkdown !== 'string'
          || annotation.labelMarkdown.length > ${MAX_ANNOTATION_LABEL_CODE_UNITS}) {
          throw new Error('Annotation Add found an invalid markdown label.');
        }
        copy.labelMarkdown = annotation.labelMarkdown;
      }
      if (annotation.categoryId !== undefined) {
        if (typeof annotation.categoryId !== 'string' || annotation.categoryId.length === 0
          || annotation.categoryId.length > ${MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS}) {
          throw new Error('Annotation Add found an invalid category id.');
        }
        copy.categoryId = annotation.categoryId;
      }
      if (annotation.properties !== undefined) {
        if (!Array.isArray(annotation.properties)
          || annotation.properties.length > ${MAX_ANNOTATION_READ_PROPERTIES}) {
          throw new Error('Annotation Add found invalid property facts.');
        }
        copy.properties = annotation.properties.map((property) => {
          if (!property || typeof property.type !== 'string'
            || !propertyTypes.includes(property.type)) {
            throw new Error('Annotation Add found invalid property facts.');
          }
          return { type: property.type };
        });
      }
      return copy;
    };
    const facts = (node) => {
      if (!node || typeof node.id !== 'string' || node.id.length === 0
        || node.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || !nodeIdPattern.test(node.id)
        || typeof node.name !== 'string' || node.name.length > ${MAX_NODE_NAME_CODE_UNITS}
        || typeof node.type !== 'string' || node.type.length === 0
        || node.type.length > ${MAX_NODE_TYPE_CODE_UNITS}
        || !('annotations' in node) || !Array.isArray(node.annotations)
        || node.annotations.length > ${MAX_ANNOTATION_READ_ITEMS}) {
        throw new Error('Annotation Add requires exact annotation-capable nodes.');
      }
      return { node, values: node.annotations.map((annotation) => copyAnnotation(annotation)) };
    };
    const categoryFact = (category) => {
      if (!category || typeof category.id !== 'string' || category.id.length === 0
        || category.id.length > ${MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS}
        || typeof category.label !== 'string'
        || category.label.length > ${MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS}
        || !categoryColors.includes(category.color) || typeof category.isPreset !== 'boolean') {
        throw new Error('Annotation Add found invalid category facts.');
      }
      return { id: category.id, label: category.label };
    };
    const resolveCategory = async () => {
      if (request.category === null) return null;
      if (!figma.annotations
        || typeof figma.annotations.getAnnotationCategoriesAsync !== 'function') {
        throw new Error('Annotation Add category resolution requires the native Annotations API.');
      }
      const native = await figma.annotations.getAnnotationCategoriesAsync();
      if (!Array.isArray(native) || native.length > ${MAX_ANNOTATION_CATEGORY_ITEMS}) {
        throw new Error('Annotation Add category inventory exceeded its bounded limit.');
      }
      const categories = native.map(categoryFact);
      if (new Set(categories.map((category) => category.id)).size !== categories.length) {
        throw new Error('Annotation Add category ids must be unique.');
      }
      const direct = categories.filter((category) => category.id === request.category);
      if (direct.length === 1) return direct[0].id;
      const exact = categories.filter((category) => category.label === request.category);
      const matches = exact.length > 0 ? exact : categories.filter(
        (category) => category.label.toLowerCase().includes(request.category.toLowerCase()));
      if (matches.length > 1) throw new Error('Ambiguous annotation category: ' + request.category);
      if (matches.length === 0) throw new Error('Annotation category not found: ' + request.category);
      return matches[0].id;
    };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Annotation Add preflight failed'),
    });
    const failed = (outcome, attempted, restored, residue, residueCount, failure) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted, restored,
      residue, residueCount, failure: failureText(failure, 'fresh mutation postcondition failed'),
    });

    let targetNodes;
    let resolvedCategoryId;
    let snapshots;
    try {
      if (request.selector === 'node') {
        const node = await figma.getNodeByIdAsync(request.nodeId);
        if (!node || node.id !== request.nodeId) {
          throw new Error('Annotation Add target was not found in the targeted Figma document.');
        }
        targetNodes = [node];
      } else {
        const page = figma.currentPage;
        if (!page || typeof page.findAll !== 'function') {
          throw new Error('Annotation Add query requires a compatible current Page.');
        }
        targetNodes = page.findAll((node) => 'annotations' in node
          && typeof node.name === 'string'
          && node.name.toLowerCase().includes(request.query.toLowerCase()));
      }
      if (!Array.isArray(targetNodes) || targetNodes.length === 0) {
        throw new Error(request.selector === 'query'
          ? 'No nodes matched query: ' + request.query : 'Annotation Add target was not found.');
      }
      if (targetNodes.length > ${MAX_ANNOTATION_ADD_TARGETS}) {
        throw new Error('Annotation Add target inventory exceeded its bounded limit.');
      }
      resolvedCategoryId = await resolveCategory();
      const annotation = {
        [request.markdown ? 'labelMarkdown' : 'label']: request.text,
        ...(resolvedCategoryId ? { categoryId: resolvedCategoryId } : {}),
        ...(request.properties === undefined
          ? {} : { properties: request.properties.map((type) => ({ type })) }),
      };
      snapshots = targetNodes.map((target) => {
        const before = facts(target);
        if (before.values.length >= ${MAX_ANNOTATION_READ_ITEMS}) {
          throw new Error('Annotation Add target already reached the bounded annotation limit.');
        }
        const expected = [...before.values, copyAnnotation(annotation)];
        return {
          ...identity(target), before: before.values, expected,
          index: expected.length - 1,
        };
      });
      if (new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) {
        throw new Error('Annotation Add target ids must be unique.');
      }
      if (JSON.stringify(snapshots).length > ${MAX_ANNOTATION_ADD_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Annotation Add snapshot exceeded its bounded limit.');
      }
    } catch (error) {
      return refusal(error);
    }

    const fresh = async (snapshot) => {
      const state = facts(await figma.getNodeByIdAsync(snapshot.id));
      if (state.node.id !== snapshot.id) {
        throw new Error('Fresh Annotation Add target identity changed.');
      }
      return state;
    };
    const journal = [];
    const warnings = [];
    let warningCount = 0;
    let attempted = 0;
    let applied = 0;
    let failure = null;
    for (const snapshot of snapshots) {
      let current;
      try {
        current = await fresh(snapshot);
        if (!same(current.values, snapshot.before)) {
          throw new Error('Annotation Add precondition changed before mutation.');
        }
      } catch (error) {
        failure = error;
        break;
      }
      attempted += 1;
      journal.push(snapshot);
      let nativeError = null;
      try {
        current.node.annotations = snapshot.expected;
      } catch (error) {
        nativeError = error;
      }
      try {
        const after = await fresh(snapshot);
        if (same(after.values, snapshot.expected)) {
          applied += 1;
          if (nativeError) {
            warningCount += 1;
            if (warnings.length < ${MAX_WARNING_FACTS}) {
              warnings.push(failureText(
                nativeError, 'native acknowledgement failed after mutation'));
            }
          }
          continue;
        }
        if (same(after.values, snapshot.before) && applied === 0) {
          return failed('unchanged', attempted, 0, [snapshot.id], 1,
            nativeError || new Error('fresh mutation postcondition failed'));
        }
        failure = nativeError || new Error('Fresh Annotation Add postcondition failed.');
      } catch (error) {
        failure = nativeError || error;
      }
      break;
    }

    if (!failure && applied === snapshots.length) {
      delete globalThis.__invCache;
      const annotation = copyAnnotation(snapshots[0].expected.at(-1), true);
      return bounded({
        schemaVersion: 1, status: 'annotated', selector: request.selector,
        outcome: warningCount > 0 ? 'verified-after-error' : 'verified',
        annotation,
        categoryResolution: request.category === null ? null : {
          requested: request.category, resolvedId: resolvedCategoryId,
        },
        targetCount: snapshots.length,
        targets: snapshots.map(({ id, name, type, index }) => ({ id, name, type, index })),
        attempted, applied, residue: [], residueCount: 0,
        warnings, warningCount,
      });
    }
    if (failure && attempted === 0) return refusal(failure);

    const residue = [];
    let residueCount = 0;
    let restored = 0;
    let unavailable = false;
    for (const snapshot of [...journal].reverse()) {
      let rollbackError = null;
      try {
        const current = await fresh(snapshot);
        if (!same(current.values, snapshot.before)) current.node.annotations = snapshot.before;
      } catch (error) {
        rollbackError = error;
      }
      try {
        const state = await fresh(snapshot);
        if (same(state.values, snapshot.before)) {
          restored += 1;
        } else {
          residueCount += 1;
          if (residue.length < ${MAX_RESIDUE_FACTS}) residue.push(snapshot.id);
        }
      } catch (error) {
        unavailable = true;
        residueCount += 1;
        if (residue.length < ${MAX_RESIDUE_FACTS}) residue.push(snapshot.id);
        failure ||= rollbackError || error;
      }
    }
    if (residueCount === 0) delete globalThis.__invCache;
    return failed(
      residueCount === 0 ? 'rolled-back'
        : unavailable ? 'verification-unavailable' : 'partial-residue',
      attempted, restored, residue, residueCount, failure);
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
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}

function validAnnotation(value, input) {
  return exact(value, ['label', 'labelMarkdown', 'categoryId', 'properties'])
    && (input.markdown
      ? value.label === null && value.labelMarkdown === input.text
      : value.label === input.text && value.labelMarkdown === null)
    && (value.categoryId === null
      || text(value.categoryId, MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS, false))
    && (input.category === null ? value.categoryId === null : value.categoryId !== null)
    && (input.properties === undefined
      ? value.properties === null
      : Array.isArray(value.properties)
        && value.properties.map((property) => property.type).join(',')
          === input.properties.join(',')
        && value.properties.every((property) => exact(property, ['type'])
          && ANNOTATION_PROPERTY_TYPES.includes(property.type)));
}

function validCategoryResolution(value, input, annotation) {
  if (input.category === null) return value === null;
  return exact(value, ['requested', 'resolvedId'])
    && value.requested === input.category && value.resolvedId === annotation.categoryId;
}

function validTarget(value) {
  return exact(value, ['id', 'name', 'type', 'index'])
    && validNodeId(value.id) && text(value.name, MAX_NODE_NAME_CODE_UNITS)
    && text(value.type, MAX_NODE_TYPE_CODE_UNITS, false)
    && Number.isInteger(value.index) && value.index >= 0
    && value.index <= MAX_ANNOTATION_READ_ITEMS;
}

function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'selector', 'outcome', 'annotation', 'categoryResolution',
    'targetCount', 'targets', 'attempted', 'applied', 'residue', 'residueCount',
    'warnings', 'warningCount',
  ])
    && value.schemaVersion === 1 && value.status === 'annotated'
    && value.selector === input.selector
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validAnnotation(value.annotation, input)
    && validCategoryResolution(value.categoryResolution, input, value.annotation)
    && Number.isInteger(value.targetCount) && value.targetCount > 0
    && value.targetCount <= MAX_ANNOTATION_ADD_TARGETS
    && Array.isArray(value.targets) && value.targets.length === value.targetCount
    && value.targets.every(validTarget)
    && new Set(value.targets.map((target) => target.id)).size === value.targets.length
    && (input.selector !== 'node'
      || value.targets.length === 1 && value.targets[0].id === input.nodeId)
    && value.attempted === value.targetCount && value.applied === value.targetCount
    && Array.isArray(value.residue) && value.residue.length === 0 && value.residueCount === 0
    && Array.isArray(value.warnings) && value.warnings.length <= MAX_WARNING_FACTS
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false))
    && Number.isInteger(value.warningCount) && value.warningCount >= value.warnings.length
    && value.warningCount <= value.targetCount
    && (value.outcome === 'verified' ? value.warningCount === 0 : value.warningCount > 0);
}

function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}

function validFailure(value) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue',
    'residueCount', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    && Number.isInteger(value.attempted) && value.attempted > 0
    && value.attempted <= MAX_ANNOTATION_ADD_TARGETS
    && Number.isInteger(value.restored) && value.restored >= 0 && value.restored <= value.attempted
    && Array.isArray(value.residue) && value.residue.length <= MAX_RESIDUE_FACTS
    && value.residue.every(validNodeId) && new Set(value.residue).size === value.residue.length
    && Number.isInteger(value.residueCount) && value.residueCount >= value.residue.length
    && value.residueCount <= value.attempted
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back'
      || value.restored === value.attempted && value.residueCount === 0)
    && (value.outcome !== 'unchanged'
      || value.attempted === 1 && value.restored === 0 && value.residueCount === 1)
    && (!['partial-residue', 'verification-unavailable'].includes(value.outcome)
      || value.residueCount > 0);
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

export function formatAnnotationAddResult(result) {
  if (result.selector === 'node') {
    const target = result.targets[0];
    return `✓ Annotated ${safeText(target.name)} (${target.id}) at index ${target.index}`;
  }
  return [
    `✓ Annotated ${result.targetCount} node(s):`,
    ...result.targets.map((target) => `  ${safeText(target.name)} (${target.id})`),
  ].join('\n');
}

export async function executeAnnotationAdd(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Annotation Add requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(annotationAddCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANNOTATION_ADD_RESULT_CODE_UNITS) {
    throw pluginResultError('Annotation Add returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginResultError('Annotation Add returned invalid JSON.');
  }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) {
      throw pluginResultError('Annotation Add returned an invalid bounded result.');
    }
    throw mutationError(`Annotation Add made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) {
      throw pluginResultError('Annotation Add returned an invalid bounded result.');
    }
    throw mutationError(`Annotation Add failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: payload.attempted,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Annotation Add returned an invalid bounded result.');
  }
  const messages = [];
  if (input.warning) messages.push(`⚠ ${input.warning}`);
  if (payload.warningCount > 0) {
    messages.push(`⚠ ${payload.warningCount} native acknowledgement warning(s)`);
    messages.push(...payload.warnings.map((warning) => `⚠ ${warning}`));
  }
  return {
    stdout: formatAnnotationAddResult(payload),
    stderr: messages.join('\n'),
    result: payload,
  };
}

export function annotationAddPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Annotation Add routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-annotation-add';
}

export function executeAnnotationAddPlan(plan, adapters = {}) {
  if (annotationAddPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Annotation Add.');
  }
  return executeAnnotationAdd(parseAnnotationAddRequest(plan.argv), adapters);
}
