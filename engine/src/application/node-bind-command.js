// Plan-bound, readback-verified and rollback-owned `node bind` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_BIND_QUERY_CODE_UNITS,
  NODE_BIND_PROPERTIES,
  nodeBindArgvFromRequest,
  nodeBindPlanningArgvFromRequest,
  parseNodeBindRequest,
} from './node-bind-request.js';

export { nodeBindArgvFromRequest, nodeBindPlanningArgvFromRequest } from './node-bind-request.js';

const APPLICATION_ID = 'node.bind';
export const MAX_NODE_BIND_CANDIDATES = 100_000;
export const MAX_NODE_BIND_PAINTS = 10_000;
export const MAX_NODE_BIND_PAINT_SNAPSHOT_CODE_UNITS = 262_144;
export const MAX_NODE_BIND_RESULT_CODE_UNITS = 65_536;
const MAX_ID = 1_024;
const MAX_FAILURE = 1_024;
const RADIUS_FIELDS = Object.freeze([
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius',
]);

function normalizedRequest(request) {
  return parseNodeBindRequest(nodeBindArgvFromRequest(request));
}
function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function nodeBindCode(request) {
  const input = normalizedRequest(request);
  const spec = NODE_BIND_PROPERTIES[input.property];
  return `(async () => {
    const nodeId = ${jsValue(input.nodeId)};
    const property = ${jsValue(input.property)};
    const variableQuery = ${jsValue(input.variable)};
    const collectionQuery = ${jsValue(input.collection)};
    const spec = ${jsValue(spec)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_BIND_RESULT_CODE_UNITS}) throw new Error('Node Bind result exceeded its bounded response limit.');
      return serialized;
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation',
      attempted: 0, failure: clean(error && error.message ? error.message : String(error), ${MAX_FAILURE}) });
    const validText = (value, maximum = ${MAX_NODE_BIND_QUERY_CODE_UNITS}, empty = true) =>
      typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
    const aliasId = (value) => value === undefined || value === null ? null
      : value && !Array.isArray(value) && value.type === 'VARIABLE_ALIAS'
        && validText(value.id, ${MAX_ID}, false) ? value.id : false;
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const scalarTopology = (node, fields) => fields.map((field) => aliasId(node.boundVariables && node.boundVariables[field]));
    const requestedScalar = (node, variableId) => {
      if (property !== 'radius') {
        const fields = Array.isArray(spec.field) ? spec.field.filter((field) => field in node) : [spec.field];
        const ids = scalarTopology(node, fields);
        return ids.every((id) => id === variableId) ? { fields, ids } : null;
      }
      const direct = aliasId(node.boundVariables && node.boundVariables.cornerRadius);
      const corners = ${jsValue(RADIUS_FIELDS.slice(1))};
      const cornerIds = scalarTopology(node, corners);
      if (direct === variableId && cornerIds.every((id) => id === null)) {
        return { fields: ['cornerRadius'], ids: [variableId] };
      }
      if (direct === null && cornerIds.every((id) => id === variableId)) {
        return { fields: corners, ids: cornerIds };
      }
      return null;
    };

    let node, variable, collection, resolution, fields, priorIds, priorVariables, priorPaints, priorPaintsJson;
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(collections) || collections.length > ${MAX_NODE_BIND_CANDIDATES}
        || !Array.isArray(variables) || variables.length > ${MAX_NODE_BIND_CANDIDATES}) {
        throw new Error('Node Bind Variable candidate limit exceeded.');
      }
      if (collections.some((item) => !item || !validText(item.id, ${MAX_ID}, false)
        || !validText(item.name) || item.remote !== false)
        || new Set(collections.map((item) => item.id)).size !== collections.length) {
        throw new Error('Node Bind encountered invalid local Collection metadata.');
      }
      if (variables.some((item) => !item || !validText(item.id, ${MAX_ID}, false)
        || !validText(item.name) || !validText(item.variableCollectionId, ${MAX_ID}, false)
        || !validText(item.resolvedType, 64, false) || item.remote !== false)
        || new Set(variables.map((item) => item.id)).size !== variables.length) {
        throw new Error('Node Bind encountered invalid local Variable metadata.');
      }
      let pool = variables;
      if (collectionQuery !== null) {
        const folded = collectionQuery.toLocaleLowerCase('en-US');
        const exactCollections = collections.filter((item) => item.name.toLocaleLowerCase('en-US') === folded);
        const partialCollections = collections.filter((item) => item.name.toLocaleLowerCase('en-US').includes(folded));
        const matches = exactCollections.length ? exactCollections : partialCollections;
        if (matches.length !== 1) throw new Error(matches.length ? 'Collection reference is ambiguous.' : 'Collection not found.');
        collection = matches[0]; pool = variables.filter((item) => item.variableCollectionId === collection.id);
      }
      const exactVariables = pool.filter((item) => item.name === variableQuery);
      const tailVariables = pool.filter((item) => item.name.endsWith('/' + variableQuery));
      const variableMatches = exactVariables.length ? exactVariables : tailVariables;
      if (variableMatches.length !== 1) throw new Error(variableMatches.length ? 'Variable reference is ambiguous.' : 'Variable not found.');
      variable = variableMatches[0]; resolution = exactVariables.length ? 'exact-name' : 'tail-name';
      collection = collection || collections.find((item) => item.id === variable.variableCollectionId);
      if (!collection) throw new Error('Variable Collection not found.');
      if (variable.resolvedType !== spec.type) throw new Error(property + ' requires a ' + spec.type + ' Variable.');

      node = await figma.getNodeByIdAsync(nodeId);
      if (!node || node.id !== nodeId || node.type === 'DOCUMENT' || node.type === 'PAGE'
        || !validText(node.name) || !validText(node.type, 64, false)) {
        throw new Error('Node Bind requires one exact mutable canvas Node.');
      }
      if (spec.kind === 'paint') {
        if (!(spec.field in node)) throw new Error(node.type + ' has no ' + spec.field + '.');
        const paints = node[spec.field];
        if (!Array.isArray(paints) || paints.length > ${MAX_NODE_BIND_PAINTS}) {
          throw new Error('Node Bind requires one bounded non-mixed Paint list.');
        }
        const base = paints.length ? paints[0] : { type: 'SOLID', color: { r: 0, g: 0, b: 0 } };
        if (!base || base.type !== 'SOLID') throw new Error('Node Bind can bind only the first Solid Paint.');
        priorPaints = paints; priorPaintsJson = JSON.stringify(paints);
        if (typeof priorPaintsJson !== 'string' || priorPaintsJson.length > ${MAX_NODE_BIND_PAINT_SNAPSHOT_CODE_UNITS}) {
          throw new Error('Node Bind Paint rollback snapshot exceeds its bounded limit.');
        }
        const currentId = paints.length === 1 ? aliasId(paints[0].boundVariables && paints[0].boundVariables.color) : null;
        fields = [spec.field];
        if (currentId === variable.id) {
          return bounded({ schemaVersion: 1, status: 'applied', node: { id: node.id, name: clean(node.name, ${MAX_NODE_BIND_QUERY_CODE_UNITS}), type: node.type },
            property, fields, variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
              collection: { id: collection.id, name: collection.name } }, resolution, attempted: 0,
            observedVariableIds: [variable.id], residue: [] });
        }
      } else {
        if (typeof node.setBoundVariable !== 'function') throw new Error('Node does not support scalar Variable bindings.');
        const mutationFields = Array.isArray(spec.field) ? spec.field.filter((field) => field in node) : [spec.field].filter((field) => field in node);
        if (!mutationFields.length) throw new Error(node.type + ' has no bindable ' + property + ' field.');
        fields = property === 'radius' ? ${jsValue(RADIUS_FIELDS)} : mutationFields;
        priorIds = scalarTopology(node, fields);
        if (priorIds.some((id) => id === false)) throw new Error('Existing Variable binding topology is incompatible.');
        priorVariables = new Map();
        for (const id of new Set(priorIds.filter(Boolean))) {
          const prior = await figma.variables.getVariableByIdAsync(id);
          if (!prior || prior.id !== id) throw new Error('Existing Variable binding could not be resolved for rollback.');
          priorVariables.set(id, prior);
        }
        const current = requestedScalar(node, variable.id);
        if (current) {
          return bounded({ schemaVersion: 1, status: 'applied', node: { id: node.id, name: clean(node.name, ${MAX_NODE_BIND_QUERY_CODE_UNITS}), type: node.type },
            property, fields: current.fields, variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
              collection: { id: collection.id, name: collection.name } }, resolution, attempted: 0,
            observedVariableIds: current.ids, residue: [] });
        }
      }
    } catch (error) { return refusal(error); }

    let failure = 'Node Bind fresh postcondition did not match the requested Variable.';
    try {
      try {
        if (spec.kind === 'paint') {
          const base = priorPaints.length ? priorPaints[0] : { type: 'SOLID', color: { r: 0, g: 0, b: 0 } };
          node[spec.field] = [figma.variables.setBoundVariableForPaint(base, 'color', variable)];
        } else {
          const mutationFields = Array.isArray(spec.field) ? spec.field.filter((field) => field in node) : [spec.field];
          for (const field of mutationFields) node.setBoundVariable(field, variable);
        }
      } catch (error) { failure = clean(error && error.message ? error.message : String(error), ${MAX_FAILURE}); }
      const fresh = await figma.getNodeByIdAsync(nodeId);
      if (fresh && fresh.id === nodeId) {
        let observed = null;
        if (spec.kind === 'paint') {
          const paints = fresh[spec.field];
          const id = Array.isArray(paints) && paints.length === 1
            ? aliasId(paints[0].boundVariables && paints[0].boundVariables.color) : false;
          if (id === variable.id) observed = { fields: [spec.field], ids: [id] };
        } else observed = requestedScalar(fresh, variable.id);
        if (observed) {
          delete globalThis.__invCache;
          return bounded({ schemaVersion: 1, status: 'applied', node: { id: fresh.id, name: clean(fresh.name, ${MAX_NODE_BIND_QUERY_CODE_UNITS}), type: fresh.type },
            property, fields: observed.fields, variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
              collection: { id: collection.id, name: collection.name } }, resolution, attempted: 1,
            observedVariableIds: observed.ids, residue: [] });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), ${MAX_FAILURE}); }

    try {
      if (spec.kind === 'paint') node[spec.field] = priorPaints;
      else {
        if (property === 'radius') node.setBoundVariable('cornerRadius', null);
        else for (const field of fields) node.setBoundVariable(field, null);
        for (let index = 0; index < fields.length; index++) {
          const id = priorIds[index];
          if (id !== null) node.setBoundVariable(fields[index], priorVariables.get(id));
        }
      }
      const fresh = await figma.getNodeByIdAsync(nodeId);
      let restored = false;
      let residue = [];
      if (fresh && fresh.id === nodeId) {
        if (spec.kind === 'paint') {
          restored = JSON.stringify(fresh[spec.field]) === priorPaintsJson;
          if (!restored) residue = [spec.field];
        } else {
          const restoredIds = scalarTopology(fresh, fields);
          restored = same(restoredIds, priorIds);
          if (!restored) residue = fields.filter((field, index) => restoredIds[index] !== priorIds[index]);
        }
      } else residue = [...fields];
      if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: restored ? 1 : 0, failure,
        node: { id: node.id, name: clean(node.name, ${MAX_NODE_BIND_QUERY_CODE_UNITS}), type: node.type }, property,
        variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
          collection: { id: collection.id, name: collection.name } }, residue });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, failure, node: { id: node.id, name: clean(node.name, ${MAX_NODE_BIND_QUERY_CODE_UNITS}), type: node.type }, property,
        variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
          collection: { id: collection.id, name: collection.name } }, residue: [] });
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function boundedText(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function id(value) { return boundedText(value, MAX_ID, false); }
function nodeIdentity(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.nodeId
    && NODE_REFERENCE_PATTERN.test(value.id) && boundedText(value.name, MAX_NODE_BIND_QUERY_CODE_UNITS)
    && boundedText(value.type, 64, false);
}
function variableIdentity(value, input) {
  if (!exact(value, ['id', 'name', 'resolvedType', 'collection']) || !id(value.id)
    || !boundedText(value.name, MAX_NODE_BIND_QUERY_CODE_UNITS, false)
    || value.resolvedType !== NODE_BIND_PROPERTIES[input.property].type
    || !exact(value.collection, ['id', 'name']) || !id(value.collection.id)
    || !boundedText(value.collection.name, MAX_NODE_BIND_QUERY_CODE_UNITS)) return false;
  if (input.collection !== null
    && !value.collection.name.toLocaleLowerCase('en-US').includes(input.collection.toLocaleLowerCase('en-US'))) return false;
  return true;
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && boundedText(value.failure, MAX_FAILURE, false);
}
function validSuccess(value, input) {
  if (!exact(value, ['schemaVersion', 'status', 'node', 'property', 'fields', 'variable', 'resolution', 'attempted', 'observedVariableIds', 'residue'])
    || value.schemaVersion !== 1 || value.status !== 'applied' || !nodeIdentity(value.node, input)
    || value.property !== input.property || !variableIdentity(value.variable, input)
    || !['exact-name', 'tail-name'].includes(value.resolution) || ![0, 1].includes(value.attempted)
    || !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 5
    || value.fields.some((field) => !boundedText(field, 64, false))
    || !Array.isArray(value.observedVariableIds)
    || value.observedVariableIds.length !== value.fields.length
    || value.observedVariableIds.some((item) => item !== value.variable.id)
    || !Array.isArray(value.residue) || value.residue.length !== 0) return false;
  return value.resolution === 'exact-name' ? value.variable.name === input.variable
    : value.variable.name.endsWith('/' + input.variable);
}
function validFailure(value, input) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'node', 'property', 'variable', 'residue'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && boundedText(value.failure, MAX_FAILURE, false) && nodeIdentity(value.node, input)
    && value.property === input.property && variableIdentity(value.variable, input)
    && Array.isArray(value.residue) && value.residue.length <= 5
    && value.residue.every((field) => boundedText(field, 64, false))
    && (value.outcome === 'rolled-back' ? value.restored === 1 && value.residue.length === 0 : value.restored === 0)
    && (value.outcome !== 'partial-residue' || value.residue.length > 0);
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report });
  return error;
}
function pluginResultError(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
  return error;
}

export function formatNodeBindResult(result) {
  return `${result.node.name} (${result.node.id}) ${result.property} → ${result.variable.name}  [${result.variable.collection.name}]`;
}
export async function executeNodeBind(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Bind requires a Figma evaluate adapter.');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeBindCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_BIND_RESULT_CODE_UNITS) {
    throw pluginResultError('Node Bind returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Node Bind returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Node Bind returned an invalid bounded result.');
    throw mutationError(`Node Bind made no mutation: ${payload.failure}`, 'no-mutation',
      { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw pluginResultError('Node Bind returned an invalid bounded result.');
    throw mutationError(`Node Bind failed with ${payload.outcome}: ${payload.failure}`, payload.outcome,
      { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored,
        residueCount: payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw pluginResultError('Node Bind returned an invalid bounded result.');
  return { stdout: formatNodeBindResult(payload), stderr: '', result: payload };
}
export function nodeBindPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Bind routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-bind';
}
export async function executeNodeBindPlan(plan, adapters = {}) {
  if (nodeBindPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Bind.`);
  }
  return executeNodeBind(parseNodeBindRequest(plan.argv), adapters);
}
