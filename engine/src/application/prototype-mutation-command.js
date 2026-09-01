// Rollback-owned native Prototype reaction mutations.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES,
  MAX_PROTOTYPE_MUTATION_DEPTH,
  MAX_PROTOTYPE_MUTATION_JSON_CODE_UNITS,
  MAX_PROTOTYPE_MUTATION_STRING_CODE_UNITS,
  MAX_PROTOTYPE_MUTATION_VALUES,
  PROTOTYPE_MUTATION_ACTIONS,
  parsePrototypeMutationRequest,
  prototypeMutationArgvFromRequest,
  prototypeMutationPlanningArgvFromRequest,
} from './prototype-mutation-request.js';

export { prototypeMutationArgvFromRequest, prototypeMutationPlanningArgvFromRequest } from './prototype-mutation-request.js';
export const MAX_PROTOTYPE_MUTATION_RESULT_CODE_UNITS = 500_000;
const IDS = new Set(PROTOTYPE_MUTATION_ACTIONS.map((action) => `prototype.${action}`));
const normalized = (request) => parsePrototypeMutationRequest(prototypeMutationArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function prototypeMutationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_PROTOTYPE_MUTATION_RESULT_CODE_UNITS}) throw new Error('Prototype Mutation result exceeded its bounded response limit.'); return serialized; };
    const verifyJson = (value) => {
      let values = 0; const seen = new Set();
      const visit = (item, depth = 0) => {
        values++; if (values > ${MAX_PROTOTYPE_MUTATION_VALUES}) throw new Error('Prototype reaction value limit exceeded.');
        if (depth > ${MAX_PROTOTYPE_MUTATION_DEPTH}) throw new Error('Prototype reaction depth limit exceeded.');
        if (item === null || typeof item === 'boolean') return;
        if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('Prototype reactions contain a non-finite number.'); return; }
        if (typeof item === 'string') { if (item.length > ${MAX_PROTOTYPE_MUTATION_STRING_CODE_UNITS}) throw new Error('Prototype reaction string limit exceeded.'); return; }
        if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('Prototype reactions must contain acyclic JSON values.');
        seen.add(item);
        if (Array.isArray(item)) { if (item.length > ${MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES}) throw new Error('Prototype reaction array limit exceeded.'); for (const child of item) visit(child, depth + 1); }
        else { const keys = Object.keys(item); if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null || Object.getOwnPropertySymbols(item).length || keys.length > ${MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES}) throw new Error('Prototype reactions must contain bounded plain objects.'); for (const key of keys) { if (!key.length || key.length > 128) throw new Error('Prototype reaction key limit exceeded.'); visit(item[key], depth + 1); } }
        seen.delete(item);
      };
      visit(value); const serialized = JSON.stringify(value); if (serialized.length > ${MAX_PROTOTYPE_MUTATION_JSON_CODE_UNITS}) throw new Error('Prototype reaction serialized-size limit exceeded.'); return JSON.parse(serialized);
    };
    const snapshot = (value) => { const reactions = verifyJson(value || []); if (!Array.isArray(reactions)) throw new Error('Prototype reactions must be an array.'); for (const reaction of reactions) { if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction) || !Object.prototype.hasOwnProperty.call(reaction, 'trigger') || reaction.actions !== undefined && !Array.isArray(reaction.actions)) throw new Error('Prototype reaction shape is invalid.'); } return reactions; };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const nodeInfo = (node) => ({ id: clean(node.id, 512), name: clean(String(node.name || ''), 1024), type: clean(String(node.type || ''), 64) });
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    let node, before, desired;
    try {
      node = await figma.getNodeByIdAsync(request.nodeId);
      if (!node || typeof node.id !== 'string' || typeof node.setReactionsAsync !== 'function') throw new Error('Target node does not support prototype reactions.');
      before = snapshot(node.reactions);
      desired = request.action === 'add' ? snapshot([...before, { trigger: request.trigger, actions: request.actions }])
        : request.action === 'set' ? snapshot(request.reactions) : [];
    } catch (error) { return refusal(error); }
    let mutationError = null;
    try { await node.setReactionsAsync(desired); } catch (error) { mutationError = error; }
    const failure = () => clean(mutationError?.message || 'fresh prototype reaction postcondition failed', 1024);
    try {
      const fresh = await figma.getNodeByIdAsync(request.nodeId);
      if (!fresh || typeof fresh.setReactionsAsync !== 'function') throw new Error('Target node became unavailable after mutation.');
      const after = snapshot(fresh.reactions);
      if (same(after, desired)) return bounded({ schemaVersion: 1, status: 'applied', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1, previousCount: before.length, node: nodeInfo(fresh), reactions: after, residue: [], warnings: mutationError ? ['The native mutation reported an error, but fresh readback proved the exact requested state.'] : [] });
    } catch (error) { mutationError ||= error; }
    try { await node.setReactionsAsync(before); } catch {}
    try {
      const restoredNode = await figma.getNodeByIdAsync(request.nodeId); const restoredReactions = restoredNode ? snapshot(restoredNode.reactions) : null; const restored = restoredNode && same(restoredReactions, before);
      return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, node: nodeInfo(restoredNode || node), residue: restored ? [] : ['reactions'], failure: failure() });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'verification-unavailable', attempted: 1, restored: 0, node: nodeInfo(node), residue: [], failure: failure() });
    }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.length > 0);
function nodeValue(value, input) { return exact(value, ['id','name','type']) && value.id === input.nodeId && text(value.name, 1024) && text(value.type, 64, false); }
function boundedJson(value, depth, state) {
  state.values++; if (state.values > MAX_PROTOTYPE_MUTATION_VALUES || depth > MAX_PROTOTYPE_MUTATION_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_PROTOTYPE_MUTATION_STRING_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES && value.every((item) => boundedJson(item, depth + 1, state));
  const keys = Object.keys(value); return Object.getPrototypeOf(value) === Object.prototype && keys.length <= MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES && keys.every((key) => key.length > 0 && key.length <= 128 && boundedJson(value[key], depth + 1, state));
}
function reactionsValue(value) {
  if (!Array.isArray(value) || !boundedJson(value, 0, { values: 0 }) || JSON.stringify(value).length > MAX_PROTOTYPE_MUTATION_JSON_CODE_UNITS) return false;
  return value.every((reaction) => reaction && typeof reaction === 'object' && !Array.isArray(reaction) && Object.hasOwn(reaction, 'trigger') && (reaction.actions === undefined || Array.isArray(reaction.actions)));
}
function validRefusal(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validSuccess(value, input) {
  let requestMatches = false;
  if (Array.isArray(value?.reactions)) {
    if (input.action === 'clear') requestMatches = value.reactions.length === 0;
    else if (input.action === 'set') requestMatches = JSON.stringify(value.reactions) === JSON.stringify(input.reactions);
    else requestMatches = Number.isSafeInteger(value.previousCount)
      && value.reactions.length === value.previousCount + 1
      && JSON.stringify(value.reactions.at(-1)) === JSON.stringify({ trigger: input.trigger, actions: input.actions });
  }
  return exact(value, ['schemaVersion','status','action','outcome','attempted','previousCount','node','reactions','residue','warnings']) && value.schemaVersion === 1 && value.status === 'applied' && value.action === input.action && ['verified','verified-after-error'].includes(value.outcome) && value.attempted === 1 && Number.isSafeInteger(value.previousCount) && value.previousCount >= 0 && value.previousCount <= MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES && nodeValue(value.node, input) && reactionsValue(value.reactions) && requestMatches && Array.isArray(value.residue) && !value.residue.length && Array.isArray(value.warnings) && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0) && value.warnings.every((warning) => text(warning, 1024, false));
}
function validFailure(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','node','residue','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && nodeValue(value.node, input) && Array.isArray(value.residue) && value.residue.every((item) => item === 'reactions') && text(value.failure, 1024, false) && (value.outcome === 'rolled-back' ? value.restored === 1 && !value.residue.length : value.restored === 0) && (value.outcome !== 'partial-residue' || value.residue.length === 1) && (value.outcome !== 'verification-unavailable' || !value.residue.length); }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function safe(value) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function legacyResult(payload) {
  if (payload.action === 'add') return { id: payload.node.id, name: payload.node.name, added: payload.reactions.at(-1), reactions: payload.reactions };
  if (payload.action === 'set') return { id: payload.node.id, name: payload.node.name, type: payload.node.type, reactions: payload.reactions };
  return { id: payload.node.id, name: payload.node.name, removed: payload.previousCount, reactions: payload.reactions };
}

export async function executePrototypeMutation(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Prototype Mutation requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(prototypeMutationCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_PROTOTYPE_MUTATION_RESULT_CODE_UNITS) throw invalid('Prototype Mutation returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Prototype Mutation returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload, input)) throw invalid('Prototype Mutation returned an invalid bounded result.'); throw mutationError(`Prototype Mutation made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); }
  if (payload?.status === 'failed') { if (!validFailure(payload, input)) throw invalid('Prototype Mutation returned an invalid bounded result.'); throw mutationError(`Prototype Mutation failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length }); }
  if (!validSuccess(payload, input)) throw invalid('Prototype Mutation returned an invalid bounded result.');
  return { stdout: safe(legacyResult(payload)), stderr: '', result: payload };
}
export function prototypeMutationPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Prototype Mutation routing requires a Command Plan.'); return plan.allowed && IDS.has(plan.id) ? 'command-application' : 'not-prototype-mutation'; }
export function executePrototypeMutationPlan(plan, adapters = {}) { if (prototypeMutationPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Prototype Mutation.'); return executePrototypeMutation(parsePrototypeMutationRequest(plan.argv), adapters); }
