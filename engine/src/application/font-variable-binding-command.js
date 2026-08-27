// Preflighted and readback-verified node typography-variable binding.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  FONT_VARIABLE_FIELDS, fontVariableBindingArgvFromRequest,
  fontVariableBindingPlanningArgvFromRequest, parseFontVariableBindingRequest,
} from './font-variable-binding-request.js';

export { fontVariableBindingArgvFromRequest, fontVariableBindingPlanningArgvFromRequest } from './font-variable-binding-request.js';

const IDS = new Set(['font.bind', 'font.unbind']);
export const MAX_FONT_BINDING_CANDIDATES = 20_000;
export const MAX_FONT_BINDING_SERIALIZED_CODE_UNITS = 32_768;
const normalized = (request) => parseFontVariableBindingRequest(fontVariableBindingArgvFromRequest(request));

export function fontVariableBindingApplicationCode(request) {
  const input = normalized(request);
  const ranged = input.start !== null || input.end !== null;
  return `(async () => {
    const action = ${JSON.stringify(input.action)};
    const field = ${JSON.stringify(input.field)};
    const expectedType = ${JSON.stringify(FONT_VARIABLE_FIELDS[input.field])};
    const variableQuery = ${JSON.stringify(input.variable)};
    const collectionQuery = ${JSON.stringify(input.collection)};
    const node = await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)});
    if (!node || node.type !== 'TEXT' || typeof node.setBoundVariable !== 'function'
      || typeof node.setRangeBoundVariable !== 'function' || typeof node.getRangeBoundVariable !== 'function'
      || typeof node.getStyledTextSegments !== 'function') {
      throw new Error('Target must be one mutable TEXT node with typography-variable binding support.');
    }
    const nodeIdentity = { id: node.id, type: 'TEXT' };
    const start = ${JSON.stringify(input.start)} === null ? 0 : ${JSON.stringify(input.start)};
    const end = ${JSON.stringify(input.end)} === null ? node.characters.length : ${JSON.stringify(input.end)};
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > node.characters.length) {
      throw new Error('Binding range is outside the TEXT node.');
    }
    const range = ${ranged ? '{ start, end }' : 'null'};
    const fontNames = start < end ? node.getRangeAllFontNames(start, end)
      : (node.fontName && node.fontName !== figma.mixed ? [node.fontName] : []);
    if (!Array.isArray(fontNames) || fontNames.length > ${MAX_FONT_BINDING_CANDIDATES}) throw new Error('Font candidate limit exceeded.');
    const loaded = new Set();
    const loadFont = async (fontName) => {
      if (!fontName || typeof fontName.family !== 'string' || typeof fontName.style !== 'string') throw new Error('TEXT node reports invalid font metadata.');
      const key = fontName.family + '\\u0000' + fontName.style;
      if (!loaded.has(key)) { await figma.loadFontAsync(fontName); loaded.add(key); }
    };
    for (const fontName of fontNames) await loadFont(fontName);
    let localVariables = null;
    const readLocalVariables = async () => {
      if (localVariables !== null) return localVariables;
      const candidates = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(candidates) || candidates.length > ${MAX_FONT_BINDING_CANDIDATES}) throw new Error('Variable candidate limit exceeded.');
      localVariables = candidates.filter((candidate) => candidate && candidate.remote === false);
      return localVariables;
    };
    const resolveVariableById = async (id) => {
      let direct = null;
      try { direct = await figma.variables.getVariableByIdAsync(id); } catch {}
      if (direct) return direct;
      return (await readLocalVariables()).find((candidate) => candidate.id === id) || null;
    };
    let variable = null; let variableResolution = null;
    if (variableQuery !== null) {
      variable = await resolveVariableById(variableQuery);
      variableResolution = 'id';
      if (!variable) {
        const variables = await readLocalVariables();
        const collections = collectionQuery === null ? [] : await figma.variables.getLocalVariableCollectionsAsync();
        if (!Array.isArray(collections) || collections.length > ${MAX_FONT_BINDING_CANDIDATES}) throw new Error('Collection candidate limit exceeded.');
        let pool = variables;
        if (collectionQuery !== null) {
          const lower = collectionQuery.toLowerCase();
          const exactCollections = collections.filter((candidate) => candidate.name.toLowerCase() === lower);
          const collectionMatches = exactCollections.length ? exactCollections
            : collections.filter((candidate) => candidate.name.toLowerCase().includes(lower));
          if (collectionMatches.length !== 1) throw new Error(collectionMatches.length ? 'Collection reference is ambiguous.' : 'Collection not found.');
          pool = pool.filter((candidate) => candidate.variableCollectionId === collectionMatches[0].id);
        }
        const exact = pool.filter((candidate) => candidate.name === variableQuery);
        const tail = pool.filter((candidate) => candidate.name.endsWith('/' + variableQuery));
        const matches = exact.length ? exact : tail;
        if (matches.length !== 1) throw new Error(matches.length ? 'Variable reference is ambiguous.' : 'Variable not found.');
        variable = matches[0]; variableResolution = exact.length ? 'exact-name' : 'tail-name';
      }
      if (typeof variable.id !== 'string' || typeof variable.name !== 'string' || typeof variable.remote !== 'boolean'
        || variable.resolvedType !== expectedType) throw new Error('Variable is incompatible with typography field.');
      if (${JSON.stringify(['fontFamily', 'fontStyle', 'fontWeight'].includes(input.field))}
        && typeof figma.listAvailableFontsAsync === 'function') {
        const families = new Set(fontNames.map((fontName) => fontName.family));
        if (field === 'fontFamily') {
          for (let value of Object.values(variable.valuesByMode || {})) {
            let guard = 20;
            while (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS' && guard-- > 0) {
              const target = await figma.variables.getVariableByIdAsync(value.id);
              value = target ? Object.values(target.valuesByMode || {})[0] : null;
            }
            if (typeof value === 'string' && value) families.add(value);
          }
        }
        const available = await figma.listAvailableFontsAsync();
        if (!Array.isArray(available) || available.length > ${MAX_FONT_BINDING_CANDIDATES}) throw new Error('Available font candidate limit exceeded.');
        for (const entry of available) {
          const fontName = entry && entry.fontName ? entry.fontName : entry;
          if (fontName && families.has(fontName.family)) await loadFont(fontName);
        }
      }
    }
    const aliasId = (alias) => alias === null || alias === undefined ? null
      : alias && alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' ? alias.id : false;
    const readAlias = () => ${ranged
      ? 'node.getRangeBoundVariable(start, end, field)'
      : `start < end ? node.getRangeBoundVariable(start, end, field) : (() => {
          const raw = node.boundVariables && node.boundVariables[field];
          if (!Array.isArray(raw)) return raw || null;
          if (raw.length === 0) return null;
          return raw.length === 1 ? raw[0] : false;
        })()`};
    const priorAlias = readAlias(); const priorId = aliasId(priorAlias);
    let priorTopology = null;
    const priorVariables = new Map();
    if (priorId === false) {
      if (start === end) throw new Error('Existing typography binding is incompatible.');
      const segments = node.getStyledTextSegments(['boundVariables'], start, end);
      if (!Array.isArray(segments) || segments.length < 1 || segments.length > ${MAX_FONT_BINDING_CANDIDATES}) {
        throw new Error('Existing typography binding topology exceeds the rollback limit.');
      }
      priorTopology = [];
      let cursor = start;
      for (const segment of segments) {
        if (!segment || segment.start !== cursor || !Number.isSafeInteger(segment.end)
          || segment.end <= segment.start || segment.end > end) {
          throw new Error('Existing typography binding topology is invalid.');
        }
        const raw = segment.boundVariables && segment.boundVariables[field];
        const id = aliasId(raw || null);
        if (id === false) throw new Error('Existing typography binding topology is incompatible.');
        priorTopology.push({ start: segment.start, end: segment.end, id });
        cursor = segment.end;
      }
      if (cursor !== end) throw new Error('Existing typography binding topology is incomplete.');
      for (const id of new Set(priorTopology.map((segment) => segment.id).filter(Boolean))) {
        const prior = await resolveVariableById(id);
        if (!prior || prior.resolvedType !== expectedType) throw new Error('Existing typography binding could not be resolved for rollback.');
        priorVariables.set(id, prior);
      }
    }
    const priorVariable = priorId === null || priorId === false ? null : await resolveVariableById(priorId);
    if (priorId !== null && priorId !== false && (!priorVariable || priorVariable.resolvedType !== expectedType)) {
      throw new Error('Existing typography binding could not be resolved for rollback.');
    }
    const setBinding = (value) => {
      if (${ranged ? 'true' : 'false'} || priorTopology !== null) node.setRangeBoundVariable(start, end, field, value);
      else node.setBoundVariable(field, value);
    };
    const requestedId = variable === null ? null : variable.id;
    let setterFailed = false;
    try { setBinding(variable); } catch { setterFailed = true; }
    const observedId = aliasId(readAlias());
    if (!setterFailed && observedId === requestedId) {
      return JSON.stringify({ schemaVersion: 1, status: 'applied', action, nodeResolution: 'id',
        variableResolution, node: nodeIdentity, field, range,
        variable: variable ? { id: variable.id, name: variable.name, resolvedType: variable.resolvedType, remote: variable.remote } : null,
        observedVariableId: observedId, residue: [] });
    }
    let restored = false; let restoredObservedId = observedId;
    try {
      if (priorTopology !== null) {
        for (const segment of priorTopology) {
          node.setRangeBoundVariable(segment.start, segment.end, field,
            segment.id === null ? null : priorVariables.get(segment.id));
        }
        restored = priorTopology.every((segment) =>
          aliasId(node.getRangeBoundVariable(segment.start, segment.end, field)) === segment.id);
        restoredObservedId = aliasId(readAlias());
      } else {
        setBinding(priorVariable); restoredObservedId = aliasId(readAlias()); restored = restoredObservedId === priorId;
      }
    } catch {}
    const residue = restored ? [] : [{ node: nodeIdentity, field, range,
      observedVariableId: typeof restoredObservedId === 'string' ? restoredObservedId : null }];
    return JSON.stringify({ schemaVersion: 1, status: 'failed', action, nodeResolution: 'id',
      variableResolution, node: nodeIdentity, field, range,
      variable: variable ? { id: variable.id, name: variable.name, resolvedType: variable.resolvedType, remote: variable.remote } : null,
      observedVariableId: typeof observedId === 'string' ? observedId : null, restored, residue });
  })()`;
}

function exactRecord(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function nodeIdentity(value) { return exactRecord(value, ['id','type']) && typeof value.id === 'string' && value.id.length <= 512 && value.type === 'TEXT'; }
function variableIdentity(value, type) { return exactRecord(value, ['id','name','resolvedType','remote']) && typeof value.id === 'string' && value.id.length <= 1024 && typeof value.name === 'string' && value.name.length <= 1024 && value.resolvedType === type && typeof value.remote === 'boolean'; }
function rangeValue(value, input) {
  const ranged = input.start !== null || input.end !== null;
  return ranged ? exactRecord(value, ['start','end']) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end)
    && value.start >= 0 && value.end >= value.start && value.start === (input.start ?? 0)
    && (input.end === null || value.end === input.end) : value === null;
}
function boundedId(value) { return value === null || typeof value === 'string' && value.length > 0 && value.length <= 1024; }
function sameRange(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function residueValue(value, payload) { return exactRecord(value, ['node','field','range','observedVariableId'])
  && nodeIdentity(value.node) && value.node.id === payload.node.id && value.field === payload.field
  && sameRange(value.range, payload.range) && boundedId(value.observedVariableId); }
function valid(payload, input) {
  const expectedType = FONT_VARIABLE_FIELDS[input.field];
  const common = payload?.schemaVersion === 1 && payload.action === input.action && payload.nodeResolution === 'id'
    && nodeIdentity(payload.node) && payload.node.id === input.nodeId && payload.field === input.field
    && rangeValue(payload.range, input) && boundedId(payload.observedVariableId)
    && (input.action === 'unbind' ? payload.variableResolution === null && payload.variable === null
      : ['id','exact-name','tail-name'].includes(payload.variableResolution) && variableIdentity(payload.variable, expectedType)
        && (payload.variableResolution === 'id' ? payload.variable.id === input.variable
          : payload.variableResolution === 'exact-name' ? payload.variable.name === input.variable
            : payload.variable.name.endsWith('/' + input.variable)));
  if (!common || !Array.isArray(payload.residue)) return false;
  if (payload.status === 'applied') return exactRecord(payload, ['schemaVersion','status','action','nodeResolution','variableResolution','node','field','range','variable','observedVariableId','residue'])
    && payload.observedVariableId === (payload.variable?.id || null) && payload.residue.length === 0;
  return payload.status === 'failed' && exactRecord(payload, ['schemaVersion','status','action','nodeResolution','variableResolution','node','field','range','variable','observedVariableId','restored','residue'])
    && typeof payload.restored === 'boolean' && (payload.restored ? payload.residue.length === 0 : payload.residue.length === 1 && residueValue(payload.residue[0], payload));
}

export async function executeFontVariableBinding(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Font binding requires evaluate(code)');
  const input = normalized(request);
  const serialized = await adapters.evaluate(fontVariableBindingApplicationCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_FONT_BINDING_SERIALIZED_CODE_UNITS) throw new Error('Font binding returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw new Error('Font binding returned invalid JSON.'); }
  if (!valid(payload, input)) throw new Error('Font binding returned an invalid bounded result.');
  if (payload.status === 'failed') {
    const error = new Error(payload.restored ? 'Font binding failed; the previous binding was restored.' : 'Font binding failed; the TEXT node may retain binding residue.');
    error.kind = 'execution'; error.phase = 'plugin-execution'; error.outcome = 'unknown-after-dispatch';
    error.dispatchState = 'failed'; error.mutationOutcome = payload.restored ? 'rolled-back' : 'partial-residue'; throw error;
  }
  const projectedVariable = payload.variable ? { ...payload.variable, type: payload.variable.resolvedType } : null;
  const facts = { id: payload.node.id, node: payload.node, field: payload.field, range: payload.range,
    variable: projectedVariable,
    alias: payload.observedVariableId === null ? null : { type: 'VARIABLE_ALIAS', id: payload.observedVariableId },
    observedVariableId: payload.observedVariableId, unbound: projectedVariable === null,
    note: input.field === 'fontWeight'
      ? 'Figma maps numeric fontWeight values to a valid weight for the active font; this is not a general variable-axis setter.'
      : null,
    residue: [] };
  return { stdout: JSON.stringify(facts, null, 2), stderr: '', result: { schemaVersion: 1, status: 'applied', action: input.action, ...facts } };
}
export function fontVariableBindingPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Font binding routing requires a Command Plan.');
  return plan.allowed && IDS.has(plan.id) ? 'command-application' : 'not-font-binding';
}
export function executeFontVariableBindingPlan(plan, adapters = {}) {
  if (fontVariableBindingPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Font binding.');
  return executeFontVariableBinding(parseFontVariableBindingRequest(plan.argv), adapters);
}
