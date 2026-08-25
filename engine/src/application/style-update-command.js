// Bounded, preflighted and rollback-owned Style Update Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseStyleUpdateRequest,
  styleUpdateArgvFromRequest,
  styleUpdatePlanningArgvFromRequest,
} from './style-update-request.js';

export { styleUpdateArgvFromRequest, styleUpdatePlanningArgvFromRequest } from './style-update-request.js';

const STYLE_UPDATE_APPLICATION_ID = 'style.update';
export const MAX_STYLE_UPDATE_STYLE_CANDIDATES = 10_000;
export const MAX_STYLE_UPDATE_SERIALIZED_CODE_UNITS = 32_768;
const MAX_STYLE_UPDATE_LABEL_CODE_UNITS = 1_024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);

function normalizedRequest(request) {
  return parseStyleUpdateRequest(styleUpdateArgvFromRequest(request));
}

function requestedFields(input) {
  return [
    ...(input.updates.name ? ['name'] : []),
    ...(input.updates.description ? ['description'] : []),
    ...(input.updates.properties ? Object.keys(input.properties) : []),
  ];
}

export function styleUpdateCommandCode(request) {
  const input = normalizedRequest(request);
  const fields = requestedFields(input);
  return `(async () => {
    const query = ${JSON.stringify(input.style)};
    const requestedType = ${JSON.stringify(input.type)};
    const loaders = {
      PAINT: () => figma.getLocalPaintStylesAsync(),
      TEXT: () => figma.getLocalTextStylesAsync(),
      EFFECT: () => figma.getLocalEffectStylesAsync(),
      GRID: () => figma.getLocalGridStylesAsync(),
    };
    const direct = await figma.getStyleByIdAsync(query);
    let style = direct && (!requestedType || direct.type === requestedType) ? direct : null;
    let resolution = 'id';
    if (!style) {
      const families = requestedType ? [requestedType] : ['PAINT', 'TEXT', 'EFFECT', 'GRID'];
      const lists = await Promise.all(families.map((type) => loaders[type]()));
      const pool = lists.flat();
      if (pool.length > ${MAX_STYLE_UPDATE_STYLE_CANDIDATES}) {
        throw new Error('Style Update candidate limit exceeded. Use an exact style id.');
      }
      const exact = pool.filter((candidate) => candidate.name === query);
      const matches = exact.length
        ? exact
        : pool.filter((candidate) => candidate.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) {
        throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id or name.');
      }
      if (matches.length === 0) throw new Error('Style not found.');
      style = matches[0];
      resolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (typeof style.id !== 'string' || typeof style.key !== 'string'
      || typeof style.name !== 'string'
      || (style.description !== undefined && typeof style.description !== 'string')
      || typeof style.type !== 'string' || typeof style.remote !== 'boolean') {
      throw new Error('Style Update encountered incompatible local Style metadata.');
    }
    if (style.remote) throw new Error('Remote styles cannot be updated.');
    const matchedName = style.name;

    const props = ${JSON.stringify(input.properties)};
    if (style.type === 'GRID' && props && Array.isArray(props.layoutGrids)) {
      props.layoutGrids = props.layoutGrids.map((grid) => {
        if (grid.pattern === 'GRID' || !grid.count || typeof grid.count !== 'object') return grid;
        return grid.count.$figmaScalar === 'Infinity' ? { ...grid, count: Infinity } : grid;
      });
    }
    if (style.type === 'TEXT' && props && props.fontName) await figma.loadFontAsync(props.fontName);

    const updates = [];
    ${input.updates.name ? `updates.push({ key: 'name', value: ${JSON.stringify(input.name)} });` : ''}
    ${input.updates.description ? `updates.push({ key: 'description', value: ${JSON.stringify(input.description)} });` : ''}
    if (props) for (const [key, value] of Object.entries(props)) updates.push({ key, value });

    // Snapshot every requested field only after resolution and fallible resource preflight,
    // but before the first mutation.
    for (const update of updates) update.previous = style[update.key];
    const identity = () => ({
      id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote,
    });
    for (let index = 0; index < updates.length; index++) {
      try {
        style[updates[index].key] = updates[index].value;
      } catch {
        const failedRestoreFields = [];
        let restored = 0;
        for (let rollback = index; rollback >= 0; rollback--) {
          try { style[updates[rollback].key] = updates[rollback].previous; restored++; }
          catch { failedRestoreFields.push(updates[rollback].key); }
        }
        const outcome = failedRestoreFields.length ? 'partial-residue' : 'rolled-back';
        const failed = {
          schemaVersion: 1, status: 'failed', outcome, resolution, query, matchedName,
          requestedType, style: identity(), fields: ${JSON.stringify(fields)},
          attempted: index + 1, confirmed: index, restored, failedRestoreFields,
          residue: failedRestoreFields.length ? [identity()] : [],
        };
        const serializedFailure = JSON.stringify(failed);
        if (serializedFailure.length > ${MAX_STYLE_UPDATE_SERIALIZED_CODE_UNITS}) {
          throw new Error('Style Update failure evidence exceeded the result limit.');
        }
        return serializedFailure;
      }
    }
    const complete = {
      schemaVersion: 1, status: 'updated', resolution, query, matchedName, requestedType,
      style: identity(), fields: ${JSON.stringify(fields)}, residue: [],
    };
    const serialized = JSON.stringify(complete);
    if (serialized.length > ${MAX_STYLE_UPDATE_SERIALIZED_CODE_UNITS}) {
      throw new Error('Style Update result exceeded the bounded result limit.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_STYLE_UPDATE_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}

function validIdentity(value, input) {
  return exactKeys(value, ['id', 'key', 'name', 'type', 'remote'])
    && boundedString(value.id, { empty: false }) && boundedString(value.key)
    && boundedString(value.name) && STYLE_TYPES.has(value.type) && value.remote === false
    && (!input.type || value.type === input.type);
}

function validCommon(value, input) {
  return value.schemaVersion === 1
    && ['id', 'exact-name', 'partial-name'].includes(value.resolution)
    && value.query === input.style && value.requestedType === input.type
    && boundedString(value.matchedName)
    && validIdentity(value.style, input)
    && (value.resolution !== 'id' || value.style.id === input.style)
    && (value.resolution !== 'exact-name' || value.matchedName === input.style)
    && (value.resolution !== 'partial-name' || (
      value.matchedName !== input.style
        && value.matchedName.toLowerCase().includes(input.style.toLowerCase())
    ))
    && (input.updates.name || value.style.name === value.matchedName)
    && Array.isArray(value.fields)
    && value.fields.length === requestedFields(input).length
    && value.fields.every((field, index) => field === requestedFields(input)[index]);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'matchedName', 'requestedType',
    'style', 'fields', 'residue',
  ]) && value.status === 'updated' && validCommon(value, input)
    && (!input.updates.name || value.style.name === input.name)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'resolution', 'query', 'matchedName',
    'requestedType', 'style', 'fields', 'attempted', 'confirmed', 'restored',
    'failedRestoreFields', 'residue',
  ]) && value.status === 'failed' && validCommon(value, input)
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && Number.isInteger(value.attempted) && value.attempted >= 1
    && value.attempted <= value.fields.length
    && value.confirmed === value.attempted - 1
    && Number.isInteger(value.restored) && value.restored >= 0
    && Array.isArray(value.failedRestoreFields)
    && value.failedRestoreFields.length + value.restored === value.attempted
    && value.failedRestoreFields.every((field) => value.fields.includes(field))
    && new Set(value.failedRestoreFields).size === value.failedRestoreFields.length
    && Array.isArray(value.residue)
    && (value.outcome === 'rolled-back'
      ? value.failedRestoreFields.length === 0 && value.residue.length === 0
      : value.failedRestoreFields.length > 0 && value.residue.length === 1
        && validIdentity(value.residue[0], input));
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeStyleUpdate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeStyleUpdate requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(styleUpdateCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_STYLE_UPDATE_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Update returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Style Update returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Style Update returned an invalid bounded result.');
    const residue = payload.residue.length;
    const error = new Error(payload.outcome === 'rolled-back'
      ? `Style Update failed after ${payload.attempted}/${payload.fields.length} field attempts; the previous Style state was restored.`
      : `Style Update failed after ${payload.attempted}/${payload.fields.length} field attempts; ${residue} Style may retain residue.`);
    error.kind = 'execution';
    error.phase = 'plugin-execution';
    error.outcome = 'unknown-after-dispatch';
    error.dispatchState = 'failed';
    error.mutationOutcome = payload.outcome;
    error.styleMutationReport = {
      version: 1, outcome: payload.outcome, attempted: payload.attempted,
      confirmed: payload.confirmed, restored: payload.restored,
      failedRestoreFields: payload.failedRestoreFields,
      residueCount: residue,
    };
    throw error;
  }
  if (!validSuccess(payload, input)) throw new Error('Style Update returned an invalid bounded result.');
  const facts = {
    resolution: payload.resolution, style: payload.style, fields: payload.fields, residue: [],
  };
  return { stdout: safePrettyJson(facts), stderr: '', result: { schemaVersion: 1, status: 'updated', ...facts } };
}

export function styleUpdatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Style Update routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === STYLE_UPDATE_APPLICATION_ID
    ? 'command-application' : 'not-style-update';
}

export async function executeStyleUpdatePlan(plan, adapters = {}) {
  if (styleUpdatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Update Command Application.`);
  }
  return executeStyleUpdate(parseStyleUpdateRequest(plan.argv), adapters);
}
