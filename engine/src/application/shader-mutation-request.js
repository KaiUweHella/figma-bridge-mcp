// Closed request Interface for `shader import|apply` writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const SHADER_MUTATION_ACTIONS = Object.freeze(['import', 'apply']);
export const MAX_SHADER_ID_CODE_UNITS = 1_024;
export const MAX_SHADER_PROPERTIES_CODE_UNITS = 64_000;
export const MAX_SHADER_PROPERTY_ENTRIES = 256;
export const MAX_SHADER_PROPERTY_DEPTH = 16;
export const MAX_SHADER_PROPERTY_VALUES = 4_096;
export const MAX_SHADER_PROPERTY_STRING_CODE_UNITS = 4_096;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) { return new Error(`Invalid Shader Mutation command: ${message}.`); }
function actionValue(value) { if (!SHADER_MUTATION_ACTIONS.includes(value)) throw requestError('action must be import or apply'); return value; }
function idValue(value) {
  if (typeof value !== 'string') throw requestError('shaderId must be a string');
  const id = value.trim();
  if (!id.length) throw requestError('shaderId is required');
  if (id.length > MAX_SHADER_ID_CODE_UNITS) throw requestError('shaderId exceeds its bounded length');
  if (UNSAFE.test(id)) throw requestError('shaderId contains unsafe control characters');
  return id;
}
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) { if (!(error instanceof NodeReferenceError)) throw error; throw requestError('nodeId must be a bounded Figma node id or URL containing node-id'); }
}
function fieldValue(value) {
  const field = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!['fill', 'stroke', 'effect'].includes(field)) throw requestError('field must be fill, stroke, or effect');
  return field;
}
function boundedJson(value, label) {
  let values = 0; const seen = new Set();
  const visit = (item, depth) => {
    values += 1;
    if (values > MAX_SHADER_PROPERTY_VALUES) throw requestError(`${label} value limit exceeded`);
    if (depth > MAX_SHADER_PROPERTY_DEPTH) throw requestError(`${label} depth limit exceeded`);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw requestError(`${label} contains a non-finite number`); return; }
    if (typeof item === 'string') { if (item.length > MAX_SHADER_PROPERTY_STRING_CODE_UNITS || UNSAFE.test(item)) throw requestError(`${label} contains an unsafe or oversized string`); return; }
    if (!item || typeof item !== 'object' || seen.has(item)) throw requestError(`${label} must contain acyclic JSON values`);
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > MAX_SHADER_PROPERTY_ENTRIES) throw requestError(`${label} array limit exceeded`);
      for (const child of item) visit(child, depth + 1);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw requestError(`${label} must contain plain JSON objects`);
      const keys = Object.keys(item);
      if (Object.getOwnPropertySymbols(item).length || keys.length > MAX_SHADER_PROPERTY_ENTRIES) throw requestError(`${label} object limit exceeded`);
      for (const key of keys) {
        if (!key.length || key.length > 256 || UNSAFE.test(key)) throw requestError(`${label} contains an unsafe object key`);
        visit(item[key], depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw requestError(`${label} must be JSON serializable`); }
  if (typeof serialized !== 'string' || serialized.length > MAX_SHADER_PROPERTIES_CODE_UNITS) throw requestError(`${label} serialized-size limit exceeded`);
  return JSON.parse(serialized);
}
function propertiesValue(value) {
  if (value === null || value === undefined) return null;
  const properties = boundedJson(value, 'properties');
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw requestError('properties must be a JSON object');
  return properties;
}
function parseProperties(raw) {
  if (typeof raw !== 'string') throw requestError('--properties requires JSON text');
  try { return propertiesValue(JSON.parse(raw)); }
  catch (error) { if (String(error?.message).startsWith('Invalid Shader Mutation command:')) throw error; throw requestError('--properties contains invalid JSON'); }
}
function optionValue(args, index, name, inline) {
  if (inline !== null) { if (!inline.length) throw requestError(`${name} requires a value`); return { value: inline, index }; }
  const value = args[index + 1];
  if (value === undefined || value === '--' || value.startsWith('-')) throw requestError(`${name} requires a value`);
  return { value, index: index + 1 };
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new TypeError('Shader Mutation arguments must be strings.');
  if (args[0] !== 'shader' || !SHADER_MUTATION_ACTIONS.includes(args[1])) throw new Error('Expected a Shader Mutation command.');
  const action = actionValue(args[1]); const positionals = []; const options = new Map(); let literal = false;
  const accepted = action === 'apply' ? ['--field','--properties','--replace'] : [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = accepted.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      if (name === '--replace') { if (token !== name) throw requestError('--replace does not accept a value'); options.set(name, true); continue; }
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline); index = parsed.index; options.set(name, parsed.value); continue;
    }
    positionals.push(token);
  }
  if (action === 'import') {
    if (positionals.length !== 1) throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'shaderId is required');
    return { action, node: null, shaderId: idValue(positionals[0]), field: null, properties: null, replace: false };
  }
  if (positionals.length < 2) throw requestError(positionals.length ? 'shaderId is required' : 'nodeId is required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  if (!options.has('--field')) throw requestError('apply requires --field');
  return {
    action, node: nodeValue(positionals[0]), shaderId: idValue(positionals[1]),
    field: fieldValue(options.get('--field')),
    properties: options.has('--properties') ? parseProperties(options.get('--properties')) : null,
    replace: options.has('--replace'),
  };
}
function projected(input) { return { action: input.action, nodeId: input.node?.nodeId || null, shaderId: input.shaderId, field: input.field, properties: input.properties, replace: input.replace }; }
export function parseShaderMutationRequest(args) { return projected(parsedRequest(args)); }
export function acceptsShaderMutationArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function shaderMutationFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).node?.fileKey || null; }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Shader Mutation request must be an object.');
  const action = actionValue(request.action); const shaderId = idValue(request.shaderId);
  if (action === 'import') return { action, node: null, shaderId, field: null, properties: null, replace: false };
  return { action, node: nodeValue(request.nodeId), shaderId, field: fieldValue(request.field), properties: propertiesValue(request.properties), replace: request.replace === true };
}
function argvFrom(input, planning) {
  if (input.action === 'import') return ['shader', 'import', '--', input.shaderId];
  return ['shader', 'apply', '--field', input.field,
    ...(input.properties === null ? [] : ['--properties', JSON.stringify(input.properties)]),
    ...(input.replace ? ['--replace'] : []), '--', planning ? input.node.planningValue : input.node.nodeId, input.shaderId];
}
export function shaderMutationArgvFromRequest(request) { const args = argvFrom(typedRequest(request), false); parseShaderMutationRequest(args); return args; }
export function shaderMutationPlanningArgvFromRequest(request) { const args = argvFrom(typedRequest(request), true); parseShaderMutationRequest(args); return args; }
