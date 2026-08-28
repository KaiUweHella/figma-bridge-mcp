// Plan-bound, one-shot and freshly verified Component Swap Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_SWAP_NODE_ID_CODE_UNITS,
  componentSwapArgvFromRequest,
  componentSwapPlanningArgvFromRequest,
  parseComponentSwapRequest,
} from './component-swap-request.js';

export {
  componentSwapArgvFromRequest,
  componentSwapPlanningArgvFromRequest,
} from './component-swap-request.js';

const APPLICATION_ID = 'component.swap';
export const MAX_COMPONENT_SWAP_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_SWAP_RESULT_CODE_UNITS = 32_768;

function normalizedRequest(request) {
  return parseComponentSwapRequest(componentSwapArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentSwapCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const instanceId = ${jsValue(input.instanceId)};
    const componentId = ${jsValue(input.componentId)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_SWAP_RESULT_CODE_UNITS}) {
        throw new Error('Component Swap result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const componentFacts = (node) => ({
      id: node.id,
      name: clean(String(node.name || ''), ${MAX_COMPONENT_SWAP_NAME_CODE_UNITS}),
      remote: node.remote === true,
    });
    const instanceFacts = (node) => ({
      id: node.id,
      name: clean(String(node.name || ''), ${MAX_COMPONENT_SWAP_NAME_CODE_UNITS}),
      type: node.type,
    });
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let instance;
    let component;
    let previous;
    try {
      instance = await figma.getNodeByIdAsync(instanceId);
      component = await figma.getNodeByIdAsync(componentId);
      if (!instance || instance.type !== 'INSTANCE'
        || typeof instance.swapComponent !== 'function'
        || typeof instance.getMainComponentAsync !== 'function') {
        throw new Error('Component Swap requires an exact Instance node.');
      }
      if (!component || component.type !== 'COMPONENT') {
        throw new Error('Component Swap requires an exact Component target.');
      }
      previous = await instance.getMainComponentAsync();
      if (!previous || previous.type !== 'COMPONENT' || typeof previous.id !== 'string') {
        throw new Error('Instance main Component could not be resolved before mutation.');
      }
    } catch (error) {
      return refusal(error);
    }

    const originalInstance = instanceFacts(instance);
    const originalComponent = componentFacts(previous);
    const requestedComponent = componentFacts(component);
    if (previous.id === component.id) {
      return bounded({
        schemaVersion: 1, status: 'unchanged', outcome: 'verified',
        instance: originalInstance, previous: originalComponent,
        component: requestedComponent, attempted: 0, residue: [], warnings: [],
      });
    }

    let swapError = null;
    try { instance.swapComponent(component); }
    catch (error) { swapError = error; }
    delete globalThis.__invCache;

    try {
      const verified = await figma.getNodeByIdAsync(instanceId);
      if (!verified || verified.type !== 'INSTANCE'
        || typeof verified.getMainComponentAsync !== 'function') {
        throw new Error('Fresh Instance verification is unavailable.');
      }
      const actual = await verified.getMainComponentAsync();
      if (!actual || actual.type !== 'COMPONENT' || typeof actual.id !== 'string') {
        throw new Error('Fresh main Component verification is unavailable.');
      }
      if (actual.id === component.id) {
        const recovered = swapError !== null;
        return bounded({
          schemaVersion: 1, status: 'swapped',
          outcome: recovered ? 'verified-after-error' : 'verified',
          instance: instanceFacts(verified), previous: originalComponent,
          component: componentFacts(actual), attempted: 1, residue: [],
          warnings: recovered
            ? ['The native swap call reported an error, but fresh readback proved the requested Component.'] : [],
        });
      }
      const unchanged = actual.id === previous.id;
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: unchanged ? 'unchanged' : 'partial-residue',
        instance: instanceFacts(verified), previous: originalComponent,
        requested: requestedComponent, actual: componentFacts(actual), attempted: 1,
        residue: { changedFromPrevious: !unchanged },
        failure: clean(swapError?.message || 'fresh Component Swap postcondition failed', 1024),
      });
    } catch (error) {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        instance: originalInstance, previous: originalComponent,
        requested: requestedComponent, actual: null, attempted: 1,
        residue: { changedFromPrevious: null },
        failure: clean(error?.message || swapError?.message || 'swap verification unavailable', 1024),
      });
    }
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
  return validString(value, MAX_COMPONENT_SWAP_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validInstance(value, input) {
  return exactKeys(value, ['id', 'name', 'type'])
    && value.id === input.instanceId && validId(value.id)
    && validString(value.name, MAX_COMPONENT_SWAP_NAME_CODE_UNITS)
    && value.type === 'INSTANCE';
}

function validComponent(value, expectedId = null) {
  return exactKeys(value, ['id', 'name', 'remote'])
    && (expectedId === null || value.id === expectedId) && validId(value.id)
    && validString(value.name, MAX_COMPONENT_SWAP_NAME_CODE_UNITS)
    && typeof value.remote === 'boolean';
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'instance', 'previous', 'component',
    'attempted', 'residue', 'warnings',
  ]) && value.schemaVersion === 1 && ['swapped', 'unchanged'].includes(value.status)
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validInstance(value.instance, input)
    && validComponent(value.previous)
    && validComponent(value.component, input.componentId)
    && value.attempted === (value.status === 'swapped' ? 1 : 0)
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => validString(warning, 1_024, false))
    && (value.status !== 'unchanged' || value.previous.id === input.componentId)
    && (value.status !== 'unchanged' || value.outcome === 'verified');
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'instance', 'previous', 'requested',
    'actual', 'attempted', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !validInstance(value.instance, input)
    || !validComponent(value.previous)
    || !validComponent(value.requested, input.componentId)
    || value.attempted !== 1
    || !exactKeys(value.residue, ['changedFromPrevious'])
    || ![true, false, null].includes(value.residue.changedFromPrevious)
    || !validString(value.failure, 1_024, false)) return false;
  if (value.outcome === 'verification-unavailable') {
    return value.actual === null && value.residue.changedFromPrevious === null;
  }
  if (!validComponent(value.actual)) return false;
  if (value.outcome === 'unchanged') {
    return value.actual.id === value.previous.id && value.residue.changedFromPrevious === false;
  }
  return value.actual.id !== value.previous.id
    && value.actual.id !== value.requested.id
    && value.residue.changedFromPrevious === true;
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && validString(value.failure, 1_024, false);
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentSwapResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const verb = result.status === 'unchanged' ? 'Already uses' : 'Swapped to';
  return [
    `${verb} ${safeJson(result.component.name)} (${result.component.id}) on `
      + `${safeJson(result.instance.name)} (${result.instance.id})`,
    ...result.warnings.map((warning) => `  ⚠ ${warning}`),
  ].join('\n');
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}

export async function executeComponentSwap(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Swap requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentSwapCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_SWAP_RESULT_CODE_UNITS) {
    const error = new Error('Component Swap returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Swap returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Swap returned an invalid bounded result.');
    throw mutationError(`Component Swap made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Swap returned an invalid bounded result.');
    const messages = {
      unchanged: 'Component Swap did not reach the requested Component and remained unchanged.',
      'partial-residue': 'Component Swap reached an unexpected main Component.',
      'verification-unavailable': 'Component Swap was dispatched, but fresh verification is unavailable.',
    };
    throw mutationError(`${messages[payload.outcome]} ${payload.failure}`, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1, restored: 0, residueCount: 1,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Swap returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentSwapResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentSwapPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Swap routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-swap';
}

export async function executeComponentSwapPlan(plan, adapters = {}) {
  if (componentSwapPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Swap.`);
  }
  return executeComponentSwap(parseComponentSwapRequest(plan.argv), adapters);
}
