// Plan-bound Annotation Category add/edit/remove mutations with explicit irreversible residue.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  ANNOTATION_CATEGORY_COLORS,
  MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS,
  MAX_ANNOTATION_CATEGORY_ITEMS,
  MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS,
} from './annotation-category-facts.js';
import {
  annotationCategoryMutationArgvFromRequest,
  annotationCategoryMutationPlanningArgvFromRequest,
  parseAnnotationCategoryMutationRequest,
} from './annotation-category-mutation-request.js';

export {
  annotationCategoryMutationArgvFromRequest,
  annotationCategoryMutationPlanningArgvFromRequest,
} from './annotation-category-mutation-request.js';

const APPLICATION_IDS = new Set([
  'annotate.category-add', 'annotate.category-edit', 'annotate.category-remove',
]);
export const MAX_ANNOTATION_CATEGORY_MUTATION_RESULT_CODE_UNITS = 65_536;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_JSON_CONTROLS = /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;
const normalized = (request) => parseAnnotationCategoryMutationRequest(
  annotationCategoryMutationArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function annotationCategoryMutationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const colors = ${JSON.stringify(ANNOTATION_CATEGORY_COLORS)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_ANNOTATION_CATEGORY_MUTATION_RESULT_CODE_UNITS}) {
        throw new Error('Annotation Category Mutation result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const categoryFact = (category) => {
      if (!category || typeof category.id !== 'string' || category.id.length === 0
        || category.id.length > ${MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS}
        || typeof category.label !== 'string'
        || category.label.length > ${MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS}
        || !colors.includes(category.color) || typeof category.isPreset !== 'boolean') {
        throw new Error('Annotation Category Mutation found invalid category facts.');
      }
      return {
        id: category.id, label: category.label, color: category.color, isPreset: category.isPreset,
      };
    };
    const inventory = async () => {
      if (!figma.annotations
        || typeof figma.annotations.getAnnotationCategoriesAsync !== 'function'
        || typeof figma.annotations.getAnnotationCategoryByIdAsync !== 'function') {
        throw new Error('Annotation Category Mutation requires the native Annotations API.');
      }
      const native = await figma.annotations.getAnnotationCategoriesAsync();
      if (!Array.isArray(native) || native.length > ${MAX_ANNOTATION_CATEGORY_ITEMS}) {
        throw new Error('Annotation Category inventory exceeded its bounded item limit.');
      }
      const values = native.map(categoryFact);
      if (new Set(values.map((category) => category.id)).size !== values.length) {
        throw new Error('Annotation Category ids must be unique.');
      }
      return values;
    };
    const sameFact = (left, right) => left.id === right.id && left.label === right.label
      && left.color === right.color && left.isPreset === right.isPreset;
    const sameCollection = (left, right) => left.length === right.length
      && right.every((expected) => left.some((candidate) => sameFact(candidate, expected)));
    const resolve = (values, query) => {
      const direct = values.filter((category) => category.id === query);
      if (direct.length === 1) return direct[0];
      const exact = values.filter((category) => category.label === query);
      const matches = exact.length > 0 ? exact : values.filter(
        (category) => category.label.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) throw new Error('Ambiguous annotation category: ' + query);
      if (matches.length === 0) throw new Error('Annotation category not found: ' + query);
      return matches[0];
    };
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', action: request.action,
      outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Annotation Category preflight failed'),
    });
    const failed = (outcome, restored, failure, residue) => bounded({
      schemaVersion: 1, status: 'failed', action: request.action,
      outcome, attempted: 1, restored, residue,
      failure: failureText(failure, 'fresh mutation postcondition failed'),
    });

    let before;
    let target = null;
    try {
      before = await inventory();
      if (request.action === 'add'
        && typeof figma.annotations.addAnnotationCategoryAsync !== 'function') {
        throw new Error('Annotation Category Add requires the native creation API.');
      }
      if (request.action !== 'add') {
        target = resolve(before, request.category);
        if (target.isPreset) {
          throw new Error('Preset annotation categories cannot be '
            + (request.action === 'edit' ? 'edited' : 'removed') + '.');
        }
      }
    } catch (error) {
      return refusal(error);
    }
    const resolution = target ? { requested: request.category, id: target.id } : null;
    const expectedEdit = target ? {
      ...target,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.color === undefined ? {} : { color: request.color }),
    } : null;
    const expected = request.action === 'edit'
      ? before.map((category) => category.id === target.id ? expectedEdit : category)
      : request.action === 'remove'
        ? before.filter((category) => category.id !== target.id)
        : null;
    const success = (category, count, attempted, mutationError) => bounded({
      schemaVersion: 1,
      status: ({ add: 'created', edit: 'edited', remove: 'removed' })[request.action],
      action: request.action,
      outcome: mutationError ? 'verified-after-error' : 'verified',
      category, resolution, count, attempted, residue: [],
      warnings: mutationError ? [failureText(
        mutationError, 'native acknowledgement failed after mutation')] : [],
    });
    if (request.action === 'edit' && sameFact(target, expectedEdit)) {
      return success(target, before.length, 0, null);
    }

    let mutationError = null;
    let acknowledgedId = null;
    try {
      if (request.action === 'add') {
        const created = categoryFact(await figma.annotations.addAnnotationCategoryAsync({
          label: request.label, color: request.color,
        }));
        acknowledgedId = created.id;
      } else {
        const native = await figma.annotations.getAnnotationCategoryByIdAsync(target.id);
        if (!native || categoryFact(native).id !== target.id) {
          throw new Error('Fresh Annotation Category mutation target is unavailable.');
        }
        if (request.action === 'edit') {
          if (request.label !== undefined) native.setLabel(request.label);
          if (request.color !== undefined) native.setColor(request.color);
        } else {
          native.remove();
        }
      }
    } catch (error) {
      mutationError = error;
    }

    let after = null;
    let ownedAdd = null;
    try {
      after = await inventory();
      if (request.action === 'add') {
        const additions = after.filter(
          (category) => !before.some((prior) => prior.id === category.id));
        const matching = additions.filter((category) => category.label === request.label
          && category.color === request.color && category.isPreset === false);
        const siblings = before.every((prior) => after.some(
          (category) => sameFact(category, prior)));
        if (additions.length === 1 && matching.length === 1 && siblings
          && after.length === before.length + 1
          && (!acknowledgedId || matching[0].id === acknowledgedId)) {
          ownedAdd = matching[0];
          delete globalThis.__invCache;
          return success(ownedAdd, after.length, 1, mutationError);
        }
        ownedAdd = acknowledgedId
          ? additions.find((category) => category.id === acknowledgedId) || null
          : additions.length === 1 && matching.length === 1 ? matching[0] : null;
      } else if (sameCollection(after, expected)) {
        const category = request.action === 'edit'
          ? after.find((item) => item.id === target.id) : target;
        delete globalThis.__invCache;
        return success(category, after.length, 1, mutationError);
      }
    } catch (error) {
      mutationError ||= error;
    }

    if (after && sameCollection(after, before)) {
      return failed('unchanged', 0, mutationError, ['annotation-categories']);
    }
    if (request.action === 'remove') {
      return after
        ? failed('partial-residue', 0, mutationError, ['annotation-categories'])
        : failed('verification-unavailable', 0, mutationError, []);
    }

    let rollbackError = null;
    try {
      if (request.action === 'add') {
        const rollbackId = ownedAdd?.id || acknowledgedId;
        if (!rollbackId) throw new Error('Created Annotation Category identity is unavailable.');
        const native = await figma.annotations.getAnnotationCategoryByIdAsync(rollbackId);
        if (!native || categoryFact(native).id !== rollbackId) {
          throw new Error('Created Annotation Category rollback target is unavailable.');
        }
        native.remove();
      } else {
        const native = await figma.annotations.getAnnotationCategoryByIdAsync(target.id);
        if (!native || categoryFact(native).id !== target.id) {
          throw new Error('Annotation Category rollback target is unavailable.');
        }
        native.setLabel(target.label);
        native.setColor(target.color);
      }
    } catch (error) {
      rollbackError = error;
    }
    try {
      const restored = await inventory();
      if (sameCollection(restored, before)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, mutationError || rollbackError, []);
      }
      return failed('partial-residue', 0, mutationError || rollbackError,
        ['annotation-categories']);
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

function validCategory(value) {
  return exact(value, ['id', 'label', 'color', 'isPreset'])
    && text(value.id, MAX_ANNOTATION_CATEGORY_ID_CODE_UNITS, false)
    && text(value.label, MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS)
    && ANNOTATION_CATEGORY_COLORS.includes(value.color)
    && typeof value.isPreset === 'boolean';
}

function validResolution(value, input, category) {
  if (input.action === 'add') return value === null;
  return exact(value, ['requested', 'id'])
    && value.requested === input.category && value.id === category.id;
}

function validSuccess(value, input) {
  const status = ({ add: 'created', edit: 'edited', remove: 'removed' })[input.action];
  return exact(value, [
    'schemaVersion', 'status', 'action', 'outcome', 'category', 'resolution',
    'count', 'attempted', 'residue', 'warnings',
  ])
    && value.schemaVersion === 1 && value.status === status && value.action === input.action
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validCategory(value.category) && validResolution(value.resolution, input, value.category)
    && (input.action !== 'add' || value.category.label === input.label
      && value.category.color === input.color && value.category.isPreset === false)
    && (input.action !== 'edit'
      || (input.label === undefined || value.category.label === input.label)
      && (input.color === undefined || value.category.color === input.color))
    && (input.action !== 'remove' || value.category.isPreset === false)
    && Number.isInteger(value.count) && value.count >= 0
    && value.count <= MAX_ANNOTATION_CATEGORY_ITEMS
    && [0, 1].includes(value.attempted)
    && (value.attempted !== 0 || input.action === 'edit' && value.outcome === 'verified')
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
}

function validRefusal(value, input) {
  return exact(value, ['schemaVersion', 'status', 'action', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}

function validFailure(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'action', 'outcome', 'attempted', 'restored',
    'residue', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action
    && ['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    && (input.action !== 'remove' || value.outcome !== 'rolled-back')
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && value.residue.every((entry) => entry === 'annotation-categories')
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

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(
    UNSAFE_JSON_CONTROLS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatAnnotationCategoryMutationResult(result) {
  const category = result.action === 'remove'
    ? { id: result.category.id, label: result.category.label, color: result.category.color }
    : result.category;
  return safeJson(category);
}

export async function executeAnnotationCategoryMutation(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Annotation Category Mutation requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(annotationCategoryMutationCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_ANNOTATION_CATEGORY_MUTATION_RESULT_CODE_UNITS) {
    throw pluginResultError('Annotation Category Mutation returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginResultError('Annotation Category Mutation returned invalid JSON.');
  }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) {
      throw pluginResultError('Annotation Category Mutation returned an invalid bounded result.');
    }
    throw mutationError(
      `Annotation Category ${input.action} made no mutation: ${payload.failure}`,
      'no-mutation', {
        version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
      });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Annotation Category Mutation returned an invalid bounded result.');
    }
    throw mutationError(
      `Annotation Category ${input.action} failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored,
        residueCount: payload.outcome === 'verification-unavailable'
          ? 1 : payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Annotation Category Mutation returned an invalid bounded result.');
  }
  return {
    stdout: formatAnnotationCategoryMutationResult(payload),
    stderr: payload.warnings.length > 0 ? `⚠ ${payload.warnings.join('; ')}` : '',
    result: payload,
  };
}

export function annotationCategoryMutationPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Annotation Category Mutation routing requires a Command Plan.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-annotation-category-mutation';
}

export function executeAnnotationCategoryMutationPlan(plan, adapters = {}) {
  if (annotationCategoryMutationPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Annotation Category Mutation.');
  }
  return executeAnnotationCategoryMutation(
    parseAnnotationCategoryMutationRequest(plan.argv), adapters);
}
