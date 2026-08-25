// Closed request Interface for `style create`.

import {
  MAX_STYLE_MUTATION_DESCRIPTION_CODE_UNITS,
  MAX_STYLE_MUTATION_NAME_CODE_UNITS,
  MAX_STYLE_MUTATION_PROPERTIES_CODE_UNITS,
  stableStyleMutationValue,
  styleMutationDescriptionValue,
  styleMutationNameValue,
  styleMutationPropertiesValue,
  styleMutationTypeValue,
} from './style-mutation-values.js';

export const MAX_STYLE_CREATE_NAME_CODE_UNITS = MAX_STYLE_MUTATION_NAME_CODE_UNITS;
export const MAX_STYLE_CREATE_DESCRIPTION_CODE_UNITS = MAX_STYLE_MUTATION_DESCRIPTION_CODE_UNITS;
export const MAX_STYLE_CREATE_PROPERTIES_CODE_UNITS = MAX_STYLE_MUTATION_PROPERTIES_CODE_UNITS;

function requestError(message) {
  return new Error(`Invalid style create command: ${message}.`);
}

const nameValue = (value) => styleMutationNameValue(value, requestError);
const descriptionValue = (value) => styleMutationDescriptionValue(value, requestError);
const propertiesValue = (value, type) => styleMutationPropertiesValue(value, type, requestError);

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'create') {
    throw new Error('Expected a style create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Create arguments must be strings.');
  }
  let description = '';
  let properties = null;
  let sawDescription = false;
  let sawProperties = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const longDescription = !literal ? token.match(/^--description=(.*)$/s) : null;
    const shortDescription = !literal ? token.match(/^-d(.+)$/s) : null;
    if (!literal && (token === '--description' || token === '-d' || longDescription || shortDescription)) {
      if (sawDescription) throw requestError('--description may be provided only once');
      sawDescription = true;
      const inline = longDescription?.[1] ?? shortDescription?.[1];
      const raw = inline === undefined ? args[++index] : inline;
      if (raw === undefined) throw requestError('--description requires a value');
      description = descriptionValue(raw);
      continue;
    }
    const longProperties = !literal ? token.match(/^--properties=(.*)$/s) : null;
    const shortProperties = !literal ? token.match(/^-p(.+)$/s) : null;
    if (!literal && (token === '--properties' || token === '-p' || longProperties || shortProperties)) {
      if (sawProperties) throw requestError('--properties may be provided only once');
      sawProperties = true;
      const inline = longProperties?.[1] ?? shortProperties?.[1];
      properties = inline === undefined ? args[++index] : inline;
      if (properties === undefined) throw requestError('--properties requires a value');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('type and name are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const type = styleMutationTypeValue(positionals[0], requestError);
  return {
    type,
    name: nameValue(positionals[1]),
    description,
    properties: propertiesValue(properties, type),
  };
}

export function parseStyleCreateRequest(args) {
  return parsedRequest(args);
}

export function acceptsStyleCreateArgv(args) {
  try { parseStyleCreateRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Create request must be an object.');
  }
  const type = styleMutationTypeValue(request.type, requestError);
  return {
    type,
    name: nameValue(request.name),
    description: descriptionValue(request.description),
    properties: propertiesValue(request.properties, type),
  };
}

export function styleCreateArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'style', 'create', '--description', input.description,
    '--properties', JSON.stringify(stableStyleMutationValue(input.properties)),
    '--', input.type, input.name,
  ];
}

export const styleCreatePlanningArgvFromRequest = styleCreateArgvFromRequest;
