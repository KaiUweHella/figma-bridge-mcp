// Plan-bound, irreversible and freshly verified Node-to-Component Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_TO_COMPONENT_NODE_ID_CODE_UNITS,
  MAX_NODE_TO_COMPONENT_TARGETS,
  nodeToComponentArgvFromRequest,
  nodeToComponentPlanningArgvFromRequest,
  parseNodeToComponentRequest,
} from './node-to-component-request.js';

export {
  nodeToComponentArgvFromRequest,
  nodeToComponentPlanningArgvFromRequest,
} from './node-to-component-request.js';

const APPLICATION_ID = 'node.to-component';
export const MAX_NODE_TO_COMPONENT_CHILDREN = 50_000;
export const MAX_NODE_TO_COMPONENT_ANCESTOR_DEPTH = 512;
export const MAX_NODE_TO_COMPONENT_NAME_CODE_UNITS = 1_024;
export const MAX_NODE_TO_COMPONENT_RESULT_CODE_UNITS = 2_000_000;

function normalizedRequest(request) {
  return parseNodeToComponentRequest(nodeToComponentArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function nodeToComponentCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const ids = ${jsValue(input.nodeIds)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_TO_COMPONENT_RESULT_CODE_UNITS}) {
        const attempted = Math.max(1, Math.min(ids.length, Number(payload && payload.attempted) || 1));
        const residue = ids.slice(0, 50);
        return JSON.stringify({
          schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
          attempted, converted: [], failedIndex: attempted - 1,
          possibleResidueCount: ids.length,
          possibleResidue: residue,
          residueTruncated: ids.length > residue.length,
          failure: 'Node to-component result exceeded the bounded response limit.',
        });
      }
      return serialized;
    };
    const childrenOf = (node) => {
      if (!node || !Array.isArray(node.children)) throw new Error('Parent returned invalid child membership.');
      if (node.children.length > ${MAX_NODE_TO_COMPONENT_CHILDREN}) {
        throw new Error('Parent exceeds the bounded child count.');
      }
      const childIds = node.children.map((child) => child && child.id);
      if (childIds.some((id) => typeof id !== 'string') || new Set(childIds).size !== childIds.length) {
        throw new Error('Parent returned invalid child membership.');
      }
      return childIds;
    };
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    const records = [];
    try {
      if (typeof figma.createComponentFromNode !== 'function') {
        throw new Error('Figma does not expose native component conversion in this editor.');
      }
      for (let targetIndex = 0; targetIndex < ids.length; targetIndex++) {
        const id = ids[targetIndex];
        const node = await figma.getNodeByIdAsync(id);
        if (!node || !['FRAME', 'GROUP'].includes(node.type)) {
          throw new Error('Target must be an exact Frame or Group: ' + clean(id, ${MAX_NODE_TO_COMPONENT_NODE_ID_CODE_UNITS}));
        }
        const parent = node.parent;
        if (!parent || typeof parent.id !== 'string') throw new Error('Target parent is unavailable.');
        const parentIds = childrenOf(parent);
        const index = parentIds.indexOf(node.id);
        if (index < 0) throw new Error('Target is absent from its parent membership.');
        const childIds = childrenOf(node);
        const name = String(node.name || '');
        if (name.length > ${MAX_NODE_TO_COMPONENT_NAME_CODE_UNITS}) {
          throw new Error('Target name exceeds the bounded verification length.');
        }
        const ancestorIds = [];
        let current = parent;
        const seen = new Set([node.id]);
        for (let depth = 0; depth <= ${MAX_NODE_TO_COMPONENT_ANCESTOR_DEPTH}; depth++) {
          if (!current || typeof current.id !== 'string' || seen.has(current.id)) {
            throw new Error('Target ancestry is unavailable or cyclic.');
          }
          seen.add(current.id);
          ancestorIds.push(current.id);
          if (['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(current.type)) {
            throw new Error('Target is nested inside a Component, Component Set, or Instance.');
          }
          if (current.type === 'DOCUMENT') break;
          const next = current.parent;
          const nextIds = childrenOf(next);
          if (!nextIds.includes(current.id)) throw new Error('Target ancestry is detached.');
          current = next;
          if (depth === ${MAX_NODE_TO_COMPONENT_ANCESTOR_DEPTH}) {
            throw new Error('Target ancestry exceeds the bounded depth.');
          }
        }
        records.push({
          id: node.id, type: node.type,
          name, parentId: parent.id, index, childIds, ancestorIds,
        });
      }
      const requested = new Set(ids);
      for (const record of records) {
        if (record.ancestorIds.some((id) => requested.has(id))) {
          throw new Error('Targets must not contain one another.');
        }
      }
    } catch (error) {
      return refusal(error);
    }

    const converted = [];
    const warnings = [];
    for (let targetIndex = 0; targetIndex < records.length; targetIndex++) {
      const record = records[targetIndex];
      let returned = null;
      let mutationError = null;
      let beforeAttemptIds = [];
      let nativeAttempted = false;
      try {
        const source = await figma.getNodeByIdAsync(record.id);
        if (!source || source.type !== record.type
          || !source.parent || source.parent.id !== record.parentId
          || source.name !== record.name
          || !sameIds(childrenOf(source), record.childIds)) {
          throw new Error('Target changed after preflight.');
        }
        const freshParentBefore = await figma.getNodeByIdAsync(record.parentId);
        beforeAttemptIds = childrenOf(freshParentBefore);
        if (beforeAttemptIds[record.index] !== record.id) {
          throw new Error('Target parent membership changed after preflight.');
        }
        nativeAttempted = true;
        returned = figma.createComponentFromNode(source);
        if (!returned || returned.type !== 'COMPONENT' || typeof returned.id !== 'string') {
          throw new Error('Figma did not return a Component.');
        }
      } catch (error) {
        mutationError = error;
      }
      delete globalThis.__invCache;

      if (!nativeAttempted) {
        const possibleResidue = converted.map((item) => item.id);
        return bounded({
          schemaVersion: 1, status: 'failed',
          outcome: possibleResidue.length ? 'partial-residue' : 'unchanged',
          attempted: targetIndex + 1, converted, failedIndex: targetIndex,
          possibleResidueCount: possibleResidue.length,
          possibleResidue: possibleResidue.slice(0, 50),
          residueTruncated: possibleResidue.length > 50,
          failure: clean(mutationError?.message || 'target changed after preflight', 1024),
        });
      }

      try {
        const freshParent = await figma.getNodeByIdAsync(record.parentId);
        const afterIds = childrenOf(freshParent);
        const candidateId = returned && typeof returned.id === 'string'
          ? returned.id
          : afterIds[record.index];
        const actual = typeof candidateId === 'string'
          ? await figma.getNodeByIdAsync(candidateId) : null;
        const expectedIds = [...beforeAttemptIds];
        if (actual && actual.type === 'COMPONENT') expectedIds[record.index] = actual.id;
        const actualChildIds = actual && actual.type === 'COMPONENT' ? childrenOf(actual) : [];
        const verified = Boolean(actual && actual.type === 'COMPONENT'
          && actual.parent && actual.parent.id === record.parentId
          && afterIds[record.index] === actual.id
          && sameIds(afterIds, expectedIds)
          && actual.name === record.name
          && sameIds(actualChildIds, record.childIds));
        if (verified) {
          converted.push({
            sourceId: record.id, id: actual.id,
            name: clean(String(actual.name || ''), ${MAX_NODE_TO_COMPONENT_NAME_CODE_UNITS}),
            parentId: record.parentId, index: record.index,
            childCount: actualChildIds.length,
          });
          if (mutationError) {
            warnings.push('Target ' + clean(record.id, ${MAX_NODE_TO_COMPONENT_NODE_ID_CODE_UNITS})
              + ' reported an error, but fresh readback proved the requested Component.');
          }
          continue;
        }

        const original = await figma.getNodeByIdAsync(record.id);
        const unchanged = Boolean(original && original.type === record.type
          && sameIds(afterIds, beforeAttemptIds));
        const possibleResidue = converted.map((item) => item.id);
        if (!unchanged && typeof candidateId === 'string') possibleResidue.push(candidateId);
        const uniqueResidue = [...new Set(possibleResidue)];
        return bounded({
          schemaVersion: 1, status: 'failed',
          outcome: uniqueResidue.length ? 'partial-residue' : 'unchanged',
          attempted: targetIndex + 1, converted, failedIndex: targetIndex,
          possibleResidueCount: uniqueResidue.length,
          possibleResidue: uniqueResidue.slice(0, 50),
          residueTruncated: uniqueResidue.length > 50,
          failure: clean(mutationError?.message || 'fresh component postcondition failed', 1024),
        });
      } catch (error) {
        const currentHandle = returned && typeof returned.id === 'string'
          ? returned.id : record.id;
        const uniqueResidue = [...new Set([
          ...converted.map((item) => item.id), currentHandle,
        ])];
        return bounded({
          schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
          attempted: targetIndex + 1, converted, failedIndex: targetIndex,
          possibleResidueCount: uniqueResidue.length,
          possibleResidue: uniqueResidue.slice(0, 50),
          residueTruncated: uniqueResidue.length > 50,
          failure: clean(error?.message || mutationError?.message || 'component verification unavailable', 1024),
        });
      }
    }
    return bounded({
      schemaVersion: 1, status: 'converted',
      outcome: warnings.length ? 'verified-after-error' : 'verified',
      attempted: records.length, converted, warnings,
    });
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validString(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validId(value) {
  return validString(value, MAX_NODE_TO_COMPONENT_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validConverted(value, input, index) {
  return exactKeys(value, ['sourceId', 'id', 'name', 'parentId', 'index', 'childCount'])
    && value.sourceId === input.nodeIds[index] && validId(value.sourceId)
    && validId(value.id) && validId(value.parentId)
    && validString(value.name, MAX_NODE_TO_COMPONENT_NAME_CODE_UNITS)
    && Number.isSafeInteger(value.index) && value.index >= 0
    && Number.isSafeInteger(value.childCount) && value.childCount >= 0
    && value.childCount <= MAX_NODE_TO_COMPONENT_CHILDREN;
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && validString(value.failure, 1_024, false);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'converted', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'converted'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.attempted === input.nodeIds.length
    && Array.isArray(value.converted) && value.converted.length === input.nodeIds.length
    && value.converted.every((entry, index) => validConverted(entry, input, index))
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified' ? 0 : value.warnings.length)
    && (value.outcome !== 'verified-after-error' || value.warnings.length > 0)
    && value.warnings.length <= input.nodeIds.length
    && value.warnings.every((warning) => validString(warning, 1_024, false));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'converted',
    'failedIndex', 'possibleResidueCount', 'possibleResidue', 'residueTruncated', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !Number.isSafeInteger(value.attempted) || value.attempted < 1
    || value.attempted > input.nodeIds.length
    || !Number.isSafeInteger(value.failedIndex) || value.failedIndex !== value.attempted - 1
    || !Array.isArray(value.converted) || value.converted.length > value.failedIndex
    || !value.converted.every((entry, index) => validConverted(entry, input, index))
    || !Number.isSafeInteger(value.possibleResidueCount) || value.possibleResidueCount < 0
    || value.possibleResidueCount > input.nodeIds.length
    || !Array.isArray(value.possibleResidue) || value.possibleResidue.length > 50
    || value.possibleResidue.length !== Math.min(value.possibleResidueCount, 50)
    || value.possibleResidue.some((id) => !validId(id))
    || new Set(value.possibleResidue).size !== value.possibleResidue.length
    || typeof value.residueTruncated !== 'boolean'
    || value.residueTruncated !== (value.possibleResidueCount > 50)
    || !validString(value.failure, 1_024, false)) return false;
  if (value.outcome === 'unchanged') {
    return value.converted.length === 0 && value.possibleResidueCount === 0;
  }
  if (value.outcome === 'partial-residue') return value.possibleResidueCount > 0;
  return value.possibleResidueCount > 0;
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatNodeToComponentResult(result) {
  return [
    ...result.converted.map((component) => `Converted: ${component.id} (${safeJson(component.name)})`),
    ...result.warnings.map((warning) => `  ⚠ ${warning}`),
  ].join('\n');
}

function structuredMutationReport(payload) {
  if (payload.outcome === 'unchanged') {
    return {
      version: 1, outcome: 'no-mutation', created: 0, removed: 0,
      residueCount: 0, residue: [], residueTruncated: false,
    };
  }
  const handles = payload.possibleResidue;
  return {
    version: 1, outcome: 'partial-residue',
    created: payload.possibleResidueCount, removed: 0,
    residueCount: payload.possibleResidueCount,
    residue: handles.map((handle) => ({ kind: 'scene-node', handle, reason: 'no-removal-api' })),
    residueTruncated: payload.residueTruncated,
  };
}

function mutationError(message, outcome, report) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */
  const error = new Error(message);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}

export async function executeNodeToComponent(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Node to-component requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeToComponentCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_TO_COMPONENT_RESULT_CODE_UNITS) {
    /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
    const error = new Error('Node to-component returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch {
    /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
    const error = new Error('Node to-component returned invalid JSON.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Node to-component returned an invalid bounded result.');
    throw mutationError(`Node to-component made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', created: 0, removed: 0,
      residueCount: 0, residue: [], residueTruncated: false,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Node to-component returned an invalid bounded result.');
    const report = structuredMutationReport(payload);
    throw mutationError(
      `Node to-component failed at target ${payload.failedIndex + 1}/${input.nodeIds.length}: ${payload.failure}`,
      report.outcome,
      report,
    );
  }
  if (!validSuccess(payload, input)) {
    /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
    const error = new Error('Node to-component returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatNodeToComponentResult(payload),
    stderr: '',
    result: payload,
  };
}

export function nodeToComponentPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node to-component routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-node-to-component';
}

export async function executeNodeToComponentPlan(plan, adapters = {}) {
  if (nodeToComponentPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node to-component.`);
  }
  return executeNodeToComponent(parseNodeToComponentRequest(plan.argv), adapters);
}
