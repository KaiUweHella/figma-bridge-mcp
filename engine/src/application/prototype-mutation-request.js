// Closed request Interface for `prototype add|set|clear`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const PROTOTYPE_MUTATION_ACTIONS = Object.freeze(['add', 'set', 'clear']);
export const MAX_PROTOTYPE_MUTATION_JSON_CODE_UNITS = 400_000;
export const MAX_PROTOTYPE_MUTATION_DEPTH = 32;
export const MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES = 1_024;
export const MAX_PROTOTYPE_MUTATION_VALUES = 50_000;
export const MAX_PROTOTYPE_MUTATION_STRING_CODE_UNITS = 65_536;
const MAX_KEY_CODE_UNITS = 128;
const TRIGGERS = Object.freeze({
  click: { type: 'ON_CLICK' }, hover: { type: 'ON_HOVER' }, press: { type: 'ON_PRESS' },
  drag: { type: 'ON_DRAG' }, media_end: { type: 'ON_MEDIA_END' },
});
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) { return new Error(`Invalid prototype mutation command: ${message}.`); }
function actionValue(value) { if (!PROTOTYPE_MUTATION_ACTIONS.includes(value)) throw requestError('action must be add, set, or clear'); return value; }
function nodeValue(value, label = 'nodeId') {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError(`${label} must be a bounded Figma node id or URL containing node-id`);
  }
}
function validateJson(value, label) {
  let values = 0;
  const seen = new Set();
  const visit = (item, depth) => {
    values += 1;
    if (values > MAX_PROTOTYPE_MUTATION_VALUES) throw requestError(`${label} value limit exceeded`);
    if (depth > MAX_PROTOTYPE_MUTATION_DEPTH) throw requestError(`${label} depth limit exceeded`);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw requestError(`${label} contains a non-finite number`); return; }
    if (typeof item === 'string') { if (item.length > MAX_PROTOTYPE_MUTATION_STRING_CODE_UNITS) throw requestError(`${label} string limit exceeded`); return; }
    if (!item || typeof item !== 'object' || seen.has(item)) throw requestError(`${label} must contain acyclic JSON values`);
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES) throw requestError(`${label} array limit exceeded`);
      for (const child of item) visit(child, depth + 1);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw requestError(`${label} must contain plain JSON objects`);
      const keys = Object.keys(item);
      if (Object.getOwnPropertySymbols(item).length || keys.length > MAX_PROTOTYPE_MUTATION_CONTAINER_ENTRIES) throw requestError(`${label} object limit exceeded`);
      for (const key of keys) {
        if (!key.length || key.length > MAX_KEY_CODE_UNITS || UNSAFE.test(key)) throw requestError(`${label} contains an unsafe object key`);
        visit(item[key], depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw requestError(`${label} must be JSON serializable`); }
  if (typeof serialized !== 'string' || serialized.length > MAX_PROTOTYPE_MUTATION_JSON_CODE_UNITS) throw requestError(`${label} serialized-size limit exceeded`);
  return JSON.parse(serialized);
}
function parsedJson(raw, label) {
  if (typeof raw !== 'string') throw requestError(`${label} requires JSON text`);
  try { return validateJson(JSON.parse(raw), label); }
  catch (error) { if (String(error?.message).startsWith('Invalid prototype mutation command:')) throw error; throw requestError(`${label} contains invalid JSON`); }
}
function reactionsValue(value) {
  const reactions = validateJson(value, 'reactions');
  if (!Array.isArray(reactions)) throw requestError('reactions must be an array');
  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction) || !Object.hasOwn(reaction, 'trigger')) throw requestError('every reaction must contain trigger');
    if (reaction.actions !== undefined && !Array.isArray(reaction.actions)) throw requestError('reaction actions must be an array');
  }
  return reactions;
}
function actionsValue(value) {
  const actions = validateJson(value, 'actions');
  if (!Array.isArray(actions) || actions.some((action) => !action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !action.type.length || action.type.length > MAX_KEY_CODE_UNITS || UNSAFE.test(action.type))) {
    throw requestError('actions must be an array of action objects with a bounded type');
  }
  return actions;
}
function triggerValue(value = 'click') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const trigger = validateJson(value, 'trigger');
    if (Object.keys(trigger).length === 1) {
      const entry = Object.entries(TRIGGERS).find(([, candidate]) => candidate.type === trigger.type);
      if (entry) return entry[1];
    }
    if (Object.keys(trigger).sort().join(',') === 'timeout,type' && trigger.type === 'AFTER_TIMEOUT'
      && Number.isFinite(trigger.timeout) && trigger.timeout >= 0) return trigger;
    throw requestError('trigger must be a supported trigger');
  }
  const key = String(value || 'click').trim().toLowerCase().replaceAll('-', '_');
  if (TRIGGERS[key]) return TRIGGERS[key];
  const timeout = key.match(/^after:(\d+(?:\.\d+)?)$/);
  if (timeout && Number.isFinite(Number(timeout[1]))) return { type: 'AFTER_TIMEOUT', timeout: Number(timeout[1]) };
  throw requestError('trigger must be click, hover, press, drag, media_end, or after:<seconds>');
}
function triggerToken(value) {
  if (value.type === 'AFTER_TIMEOUT') return `after:${value.timeout}`;
  return Object.entries(TRIGGERS).find(([, trigger]) => trigger.type === value.type)?.[0] || null;
}
function optionValue(args, index, token, inline, { empty = false } = {}) {
  if (inline !== null) { if (!empty && !inline.length) throw requestError(`${token.split('=')[0]} requires a value`); return { value: inline, index }; }
  const value = args[index + 1];
  if (value === undefined || value === '--' || (!empty && value.startsWith('-'))) throw requestError(`${token} requires a value`);
  return { value, index: index + 1 };
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'prototype' || typeof args[1] !== 'string') throw new Error('Expected a prototype mutation command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Prototype Mutation arguments must be strings.');
  const action = actionValue(args[1]); const positionals = []; const options = new Map(); let literal = false;
  const accepted = action === 'add' ? ['--trigger','--navigate-to','--actions','--transition'] : action === 'set' ? ['--json'] : [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = accepted.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, token, inline); index = parsed.index; options.set(name, parsed.value); continue;
    }
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  const node = nodeValue(positionals[0]);
  if (action === 'clear') return { action, node, destination: null, trigger: null, actions: null, reactions: null };
  if (action === 'set') {
    if (!options.has('--json')) throw requestError('set requires --json');
    return { action, node, destination: null, trigger: null, actions: null, reactions: reactionsValue(parsedJson(options.get('--json'), 'reactions')) };
  }
  const trigger = triggerValue(options.get('--trigger'));
  if (options.has('--actions')) {
    return { action, node, destination: null, trigger, actions: actionsValue(parsedJson(options.get('--actions'), 'actions')), reactions: null };
  }
  if (!options.has('--navigate-to')) throw requestError('add requires --navigate-to or --actions');
  const destination = nodeValue(options.get('--navigate-to'), 'navigate-to');
  const transition = options.has('--transition') ? parsedJson(options.get('--transition'), 'transition') : null;
  return { action, node, destination, trigger, actions: [{ type: 'NODE', destinationId: destination.nodeId, navigation: 'NAVIGATE', transition }], reactions: null };
}
function projected(input) { return { action: input.action, nodeId: input.node.nodeId, trigger: input.trigger, actions: input.actions, reactions: input.reactions }; }
export function parsePrototypeMutationRequest(args) { return projected(parsedRequest(args)); }
export function acceptsPrototypeMutationArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function prototypeMutationFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args); const keys = [input.node.fileKey, input.destination?.fileKey].filter(Boolean);
  if (new Set(keys).size > 1) throw requestError('source and destination target different Figma files');
  return keys[0] || null;
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Prototype Mutation request must be an object.');
  const action = actionValue(request.action); const node = nodeValue(request.nodeId);
  if (action === 'clear') return { action, node, destination: null, trigger: null, actions: null, reactions: null };
  if (action === 'set') return { action, node, destination: null, trigger: null, actions: null, reactions: reactionsValue(request.reactions) };
  const trigger = triggerValue(request.trigger);
  if (request.actions !== null && request.actions !== undefined) return { action, node, destination: null, trigger, actions: actionsValue(request.actions), reactions: null };
  const destination = nodeValue(request.navigateTo, 'navigateTo');
  const transition = request.transition === null || request.transition === undefined ? null : validateJson(request.transition, 'transition');
  return { action, node, destination, trigger, actions: [{ type: 'NODE', destinationId: destination.nodeId, navigation: 'NAVIGATE', transition }], reactions: null };
}
function argvFrom(input, planning) {
  const node = planning ? input.node.planningValue : input.node.nodeId;
  if (input.action === 'clear') return ['prototype', 'clear', '--', node];
  if (input.action === 'set') return ['prototype', 'set', '--json', JSON.stringify(input.reactions), '--', node];
  if (planning && input.destination) {
    const transition = input.actions[0].transition;
    return ['prototype', 'add', '--trigger', triggerToken(input.trigger),
      '--navigate-to', input.destination.planningValue,
      ...(transition === null ? [] : ['--transition', JSON.stringify(transition)]), '--', node];
  }
  return ['prototype', 'add', '--trigger', triggerToken(input.trigger), '--actions', JSON.stringify(input.actions), '--', node];
}
export function prototypeMutationArgvFromRequest(request) { const input = typedRequest(request); const args = argvFrom(input, false); parsePrototypeMutationRequest(args); return args; }
export function prototypeMutationPlanningArgvFromRequest(request) { const input = typedRequest(request); const args = argvFrom(input, true); parsePrototypeMutationRequest(args); return args; }
