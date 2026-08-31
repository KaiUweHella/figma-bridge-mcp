// Plan-bound irreversible Slot Reset Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  parseSlotResetRequest,
  slotResetArgvFromRequest,
  slotResetPlanningArgvFromRequest,
} from './slot-reset-request.js';

export { slotResetArgvFromRequest, slotResetPlanningArgvFromRequest } from './slot-reset-request.js';
export const MAX_SLOT_RESET_RESULT_CODE_UNITS = 500_000;
export const MAX_SLOT_RESET_CHILDREN = 10_000;
const APPLICATION_ID = 'slot.reset';
const VIOLATIONS = Object.freeze(['BELOW_MIN', 'ABOVE_MAX', 'HAS_NON_PREFERRED']);
const normalized = (request) => parseSlotResetRequest(slotResetArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function slotResetCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_SLOT_RESET_RESULT_CODE_UNITS}) throw new Error('Slot Reset result exceeded its bounded response limit.'); return serialized; };
    const snapshot = (node) => {
      if (!node || node.type !== 'SLOT' || typeof node.id !== 'string' || !node.id.length
        || !Array.isArray(node.children) || node.children.length > ${MAX_SLOT_RESET_CHILDREN}
        || !Array.isArray(node.limitViolations) || node.limitViolations.length > 3
        || node.limitViolations.some((value) => !${js(VIOLATIONS)}.includes(value))) throw new Error('Slot Reset facts are invalid.');
      const children = node.children.map((child) => {
        if (!child || typeof child.id !== 'string' || !child.id.length || child.id.length > 512
          || typeof child.type !== 'string' || !child.type.length || child.type.length > 64) throw new Error('Slot child identity is invalid.');
        return [child.id, child.type];
      });
      return { facts: { childCount: children.length, limitViolations: [...node.limitViolations] }, signature: JSON.stringify(children) + '|' + JSON.stringify(node.limitViolations) };
    };
    const slotFacts = (node) => ({ id: clean(node.id, 512), name: clean(String(node.name || ''), 1024), type: 'SLOT' });
    const residue = (count) => ({ count, kinds: count === 0 ? [] : ['irreversible-reset-state'] });
    let slot, before;
    try {
      slot = await figma.getNodeByIdAsync(request.nodeId);
      if (!slot || slot.type !== 'SLOT' || typeof slot.resetSlot !== 'function') throw new Error('Slot Reset requires one native Slot node.');
      before = snapshot(slot);
    } catch (error) {
      return bounded({ schemaVersion: 1, status: 'refused', action: 'reset', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    }
    let dispatchError = null;
    try { slot.resetSlot(); } catch (error) { dispatchError = error; }
    let fresh = null; let after = null; let changed = null; let verificationError = null;
    try {
      fresh = await figma.getNodeByIdAsync(request.nodeId);
      if (!fresh || fresh.type !== 'SLOT') throw new Error('Fresh Slot Reset target is unavailable.');
      after = snapshot(fresh); changed = after.signature !== before.signature;
    } catch (error) { verificationError = error; }
    if (!dispatchError && !verificationError) {
      return bounded({ schemaVersion: 1, status: 'reset', action: 'reset', outcome: 'native-confirmed', slot: slotFacts(fresh), before: before.facts, after: after.facts, changed, attempted: 1, residue: residue(0), warnings: ['Figma exposes no readable default Slot subtree; success confirms the native reset call and fresh resulting facts, not an independently derived target state.'] });
    }
    const error = dispatchError || verificationError;
    return bounded({ schemaVersion: 1, status: 'failed', action: 'reset', outcome: 'verification-unavailable', slot: slotFacts(slot), before: before.facts, after: after ? after.facts : null, changed, attempted: 1, restored: 0, residue: residue(1), failure: clean(error && error.message ? error.message : String(error), 1024) || 'Slot Reset verification is unavailable.' });
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function validSlot(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.nodeId
    && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, 1_024) && value.type === 'SLOT';
}
function validFacts(value) {
  return exact(value, ['childCount', 'limitViolations'])
    && Number.isSafeInteger(value.childCount) && value.childCount >= 0
    && value.childCount <= MAX_SLOT_RESET_CHILDREN
    && Array.isArray(value.limitViolations) && value.limitViolations.length <= 3
    && value.limitViolations.every((item) => VIOLATIONS.includes(item));
}
function validResidue(value, count) {
  return exact(value, ['count', 'kinds']) && value.count === count
    && Array.isArray(value.kinds) && value.kinds.length === count
    && (count === 0 || value.kinds[0] === 'irreversible-reset-state');
}
function validSuccess(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','slot','before','after','changed','attempted','residue','warnings'])
    && value.schemaVersion === 1 && value.status === 'reset' && value.action === 'reset'
    && value.outcome === 'native-confirmed' && validSlot(value.slot, input)
    && validFacts(value.before) && validFacts(value.after) && typeof value.changed === 'boolean'
    && value.attempted === 1 && validResidue(value.residue, 0)
    && Array.isArray(value.warnings) && value.warnings.length === 1
    && text(value.warnings[0], 1_024, false);
}
function validFailure(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','slot','before','after','changed','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.action === 'reset'
    && value.outcome === 'verification-unavailable' && validSlot(value.slot, input)
    && validFacts(value.before) && (value.after === null || validFacts(value.after))
    && (value.changed === null || typeof value.changed === 'boolean')
    && value.attempted === 1 && value.restored === 0 && validResidue(value.residue, 1)
    && text(value.failure, 1_024, false);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.action === 'reset'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, 1_024, false);
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report });
  return error;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeSlotReset(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slot Reset requires a Figma evaluate adapter.');
  }
  const input = normalized(request); const serialized = await adapters.evaluate(slotResetCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SLOT_RESET_RESULT_CODE_UNITS) {
    throw invalid('Slot Reset returned an invalid bounded result.');
  }
  let payload; try { payload = JSON.parse(serialized); }
  catch { throw invalid('Slot Reset returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Slot Reset returned an invalid bounded result.');
    throw mutationError(`Slot Reset made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw invalid('Slot Reset returned an invalid bounded result.');
    throw mutationError(`Slot Reset was dispatched once, but its resulting state is not independently verifiable: ${payload.failure}`,
      'verification-unavailable', { version: 1, outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residueCount: 1, changed: payload.changed });
  }
  if (!validSuccess(payload, input)) throw invalid('Slot Reset returned an invalid bounded result.');
  return { stdout: safe({ id: payload.slot.id, name: payload.slot.name,
    before: payload.before, after: payload.after, changed: payload.changed }), stderr: '', result: payload };
}

export function slotResetPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Slot Reset routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-slot-reset';
}
export function executeSlotResetPlan(plan, adapters = {}) {
  if (slotResetPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slot Reset.');
  }
  return executeSlotReset(parseSlotResetRequest(plan.argv), adapters);
}
