// Bounded, journaled Style Create Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseStyleCreateRequest,
  styleCreateArgvFromRequest,
  styleCreatePlanningArgvFromRequest,
} from './style-create-request.js';

export { styleCreateArgvFromRequest, styleCreatePlanningArgvFromRequest } from './style-create-request.js';

const STYLE_CREATE_APPLICATION_ID = 'style.create';
export const MAX_STYLE_CREATE_SERIALIZED_CODE_UNITS = 32_768;
const MAX_STYLE_CREATE_LABEL_CODE_UNITS = 1_024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const FACTORIES = Object.freeze({
  PAINT: 'createPaintStyle',
  TEXT: 'createTextStyle',
  EFFECT: 'createEffectStyle',
  GRID: 'createGridStyle',
});

function normalizedRequest(request) {
  return parseStyleCreateRequest(styleCreateArgvFromRequest(request));
}

export function styleCreateCommandCode(request) {
  const input = normalizedRequest(request);
  const factory = FACTORIES[input.type];
  return `(async () => {
    const type = ${JSON.stringify(input.type)};
    const name = ${JSON.stringify(input.name)};
    const description = ${JSON.stringify(input.description)};
    const props = ${JSON.stringify(input.properties)};
    if (type === 'GRID' && Array.isArray(props.layoutGrids)) {
      props.layoutGrids = props.layoutGrids.map((grid) => {
        if (grid.pattern === 'GRID' || !grid.count || typeof grid.count !== 'object') return grid;
        return grid.count.$figmaScalar === 'Infinity' ? { ...grid, count: Infinity } : grid;
      });
    }
    if (type === 'TEXT' && props.fontName) await figma.loadFontAsync(props.fontName);
    const style = figma.${factory}();
    const identity = () => ({
      id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote,
    });
    try {
      style.name = name;
      style.description = description;
      for (const [key, value] of Object.entries(props)) style[key] = value;
      const payload = {
        schemaVersion: 1, status: 'created', style: identity(), residue: [],
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_STYLE_CREATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Style Create result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      let cleanup = 'removed';
      try { style.remove(); } catch { cleanup = 'partial-residue'; }
      const payload = {
        schemaVersion: 1, status: 'mutation-failed', cleanup,
        residue: cleanup === 'removed' ? [] : [identity()],
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_STYLE_CREATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Style Create failure evidence exceeded the result limit.');
      }
      return serialized;
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_STYLE_CREATE_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}

function validStyleIdentity(value, input, { created = false } = {}) {
  return exactKeys(value, ['id', 'key', 'name', 'type', 'remote'])
    && boundedString(value.id, { empty: false })
    && boundedString(value.key)
    && boundedString(value.name)
    && STYLE_TYPES.has(value.type)
    && value.type === input.type
    && value.remote === false
    && (!created || value.name === input.name);
}

function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'style', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created'
    && validStyleIdentity(value.style, input, { created: true })
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'cleanup', 'residue'])
    && value.schemaVersion === 1 && value.status === 'mutation-failed'
    && ['removed', 'partial-residue'].includes(value.cleanup)
    && Array.isArray(value.residue)
    && (value.cleanup === 'removed'
      ? value.residue.length === 0
      : value.residue.length === 1 && validStyleIdentity(value.residue[0], input));
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function mutationFailure(payload, input) {
  const removed = payload.cleanup === 'removed';
  const error = new Error(removed
    ? `Style Create failed after creation; the created ${input.type} Style was removed.`
    : `Style Create failed after creation; one created ${input.type} Style may remain.`);
  const residue = removed ? [] : [{
    kind: `${input.type.toLowerCase()}-style`,
    handle: payload.residue[0].id,
    reason: 'remove-failed',
  }];
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = removed ? 'rolled-back' : 'partial-residue';
  error.mutationReport = {
    version: 1,
    outcome: error.mutationOutcome,
    created: 1,
    removed: removed ? 1 : 0,
    residueCount: residue.length,
    residue,
    residueTruncated: false,
  };
  throw error;
}

export async function executeStyleCreate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeStyleCreate requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(styleCreateCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_STYLE_CREATE_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Create returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Style Create returned invalid JSON.'); }
  if (payload?.status === 'mutation-failed') {
    if (!validFailure(payload, input)) throw new Error('Style Create returned an invalid bounded result.');
    mutationFailure(payload, input);
  }
  if (!validSuccess(payload, input)) throw new Error('Style Create returned an invalid bounded result.');
  const result = { style: payload.style, residue: [] };
  return { stdout: safePrettyJson(result), stderr: '', result: { schemaVersion: 1, status: 'created', ...result } };
}

export function styleCreatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Style Create routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === STYLE_CREATE_APPLICATION_ID
    ? 'command-application' : 'not-style-create';
}

export async function executeStyleCreatePlan(plan, adapters = {}) {
  if (styleCreatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Create Command Application.`);
  }
  return executeStyleCreate(parseStyleCreateRequest(plan.argv), adapters);
}
