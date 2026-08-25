// Closed request Interface for `style update`.

import {
  stableStyleMutationValue,
  styleMutationDescriptionValue,
  styleMutationNameValue,
  styleMutationPropertiesValue,
  styleMutationTypeValue,
} from './style-mutation-values.js';

export const MAX_STYLE_UPDATE_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid style update command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestError('style is required');
  if (value.length > MAX_STYLE_UPDATE_QUERY_CODE_UNITS) {
    throw requestError(`style exceeds ${MAX_STYLE_UPDATE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) throw requestError('style contains unsafe control characters');
  return value;
}

function optionValue(args, index, inline, option) {
  const value = inline === undefined ? args[index + 1] : inline;
  if (value === undefined) throw requestError(`${option} requires a value`);
  return { value, consumed: inline === undefined ? 1 : 0 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'update') {
    throw new Error('Expected a style update command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Update arguments must be strings.');
  }
  const values = {};
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const options = [
      ['type', '--type', '-t'],
      ['name', '--name', '-n'],
      ['description', '--description', '-d'],
      ['properties', '--properties', '-p'],
    ];
    let matched = false;
    if (!literal) {
      for (const [field, long, short] of options) {
        const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
        const shortInline = token.startsWith(short) && token !== short ? token.slice(short.length) : null;
        if (token !== long && token !== short && longInline === null && shortInline === null) continue;
        if (seen.has(field)) throw requestError(`${long} may be provided only once`);
        seen.add(field);
        const inline = longInline ?? shortInline ?? undefined;
        const result = optionValue(args, index, inline, token === short || shortInline !== null ? short : long);
        values[field] = result.value;
        index += result.consumed;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('style is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  if (!seen.has('name') && !seen.has('description') && !seen.has('properties')) {
    throw requestError('provide --name, --description, or --properties');
  }
  if (seen.has('properties') && !seen.has('type')) {
    throw requestError('--type is required with --properties');
  }
  const type = seen.has('type') ? styleMutationTypeValue(values.type, requestError) : null;
  const properties = seen.has('properties')
    ? styleMutationPropertiesValue(values.properties, type, requestError, { defaultEmpty: false })
    : undefined;
  if (properties && Object.keys(properties).length === 0) {
    throw requestError('--properties must contain at least one property');
  }
  return {
    style: queryValue(positionals[0]),
    type,
    name: seen.has('name') ? styleMutationNameValue(values.name, requestError) : undefined,
    description: seen.has('description')
      ? styleMutationDescriptionValue(values.description, requestError) : undefined,
    properties,
    updates: {
      name: seen.has('name'),
      description: seen.has('description'),
      properties: seen.has('properties'),
    },
  };
}

export function parseStyleUpdateRequest(args) {
  return parsedRequest(args);
}

export function acceptsStyleUpdateArgv(args) {
  try { parseStyleUpdateRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Update request must be an object.');
  }
  const hasName = request.name !== undefined;
  const hasDescription = request.description !== undefined;
  const hasProperties = request.properties !== undefined;
  if (!hasName && !hasDescription && !hasProperties) {
    throw requestError('provide --name, --description, or --properties');
  }
  const type = request.type == null ? null : styleMutationTypeValue(request.type, requestError);
  if (hasProperties && !type) throw requestError('--type is required with --properties');
  if (hasDescription && typeof request.description !== 'string') {
    throw requestError('description must be a string');
  }
  const properties = hasProperties
    ? styleMutationPropertiesValue(request.properties, type, requestError, { defaultEmpty: false })
    : null;
  if (properties && Object.keys(properties).length === 0) {
    throw requestError('--properties must contain at least one property');
  }
  return {
    style: queryValue(request.style),
    type,
    name: hasName ? styleMutationNameValue(request.name, requestError) : undefined,
    description: hasDescription
      ? styleMutationDescriptionValue(request.description, requestError) : undefined,
    properties,
    updates: { name: hasName, description: hasDescription, properties: hasProperties },
  };
}

export function styleUpdateArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['style', 'update'];
  if (input.type) argv.push('--type', input.type);
  if (input.updates.name) argv.push('--name', input.name);
  if (input.updates.description) argv.push('--description', input.description);
  if (input.updates.properties) {
    argv.push('--properties', JSON.stringify(stableStyleMutationValue(input.properties)));
  }
  argv.push('--', input.style);
  return argv;
}

export const styleUpdatePlanningArgvFromRequest = styleUpdateArgvFromRequest;
