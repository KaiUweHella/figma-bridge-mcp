// Closed request Interface for `dev link|unlink|edit`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEV_RESOURCE_MUTATION_ACTIONS = Object.freeze(['link', 'unlink', 'edit']);
export const MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS = 1_024;
export const MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS = 8_192;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

function requestError(message) {
  return new Error(`Invalid Dev Resource Mutation command: ${message}.`);
}

function actionValue(value) {
  if (!DEV_RESOURCE_MUTATION_ACTIONS.includes(value)) {
    throw requestError('action must be link, unlink, or edit');
  }
  return value;
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function urlValue(value, label) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS
    || UNSAFE_CONTROLS.test(value)) {
    throw requestError(
      `${label} must be a non-empty control-safe string of at most ${MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS} code units`,
    );
  }
  return value;
}

function nameValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS
    || UNSAFE_CONTROLS.test(value)) {
    throw requestError(
      `name must be a control-safe string of at most ${MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS} code units`,
    );
  }
  return value;
}

function inlineValue(token, option) {
  return token.startsWith(`${option}=`) ? token.slice(option.length + 1) : null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'dev' || typeof args[1] !== 'string') {
    throw new Error('Expected a Dev Resource Mutation command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Dev Resource Mutation arguments must be strings.');
  }
  const action = actionValue(args[1]);
  const positionals = [];
  let name = null;
  let literal = false;
  let seenName = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) {
      const longInline = inlineValue(token, '--name');
      const shortInline = inlineValue(token, '-n');
      if (token !== '--name' && token !== '-n' && longInline === null && shortInline === null) {
        throw requestError(`unknown option ${token}`);
      }
      if (seenName) throw requestError('--name may be provided only once');
      seenName = true;
      const inline = longInline ?? shortInline;
      let value = inline;
      if (value === null) {
        value = args[cursor + 1];
        if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
        cursor += 1;
      }
      name = nameValue(value);
      continue;
    }
    positionals.push(token);
  }
  if (action === 'unlink' && seenName) throw requestError('unlink does not accept --name');
  const required = action === 'edit' ? 3 : 2;
  if (positionals.length < required) throw requestError('missing required arguments');
  if (positionals.length > required) throw requestError('unexpected excess argument');
  const reference = nodeValue(positionals[0]);
  if (action === 'link') {
    return {
      action, reference, url: urlValue(positionals[1], 'url'),
      currentUrl: null, newUrl: null, name,
    };
  }
  if (action === 'unlink') {
    return {
      action, reference, url: urlValue(positionals[1], 'url'),
      currentUrl: null, newUrl: null, name: null,
    };
  }
  return {
    action,
    reference,
    url: null,
    currentUrl: urlValue(positionals[1], 'currentUrl'),
    newUrl: urlValue(positionals[2], 'newUrl'),
    name,
  };
}

function projected(input) {
  return Object.freeze({
    action: input.action,
    nodeId: input.reference.nodeId,
    url: input.url,
    currentUrl: input.currentUrl,
    newUrl: input.newUrl,
    name: input.name,
  });
}

export function parseDevResourceMutationRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsDevResourceMutationArgv(args) {
  try {
    parseDevResourceMutationRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function devResourceMutationFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Dev Resource Mutation request must be an object.');
  }
  const action = actionValue(request.action);
  const reference = nodeValue(request.nodeId);
  const name = nameValue(request.name);
  if (action === 'link') {
    return {
      action, reference, url: urlValue(request.url, 'url'),
      currentUrl: null, newUrl: null, name,
    };
  }
  if (action === 'unlink') {
    if (request.name !== null && request.name !== undefined && request.name !== '') {
      throw requestError('unlink does not accept name');
    }
    return {
      action, reference, url: urlValue(request.url, 'url'),
      currentUrl: null, newUrl: null, name: null,
    };
  }
  return {
    action,
    reference,
    url: null,
    currentUrl: urlValue(request.currentUrl, 'currentUrl'),
    newUrl: urlValue(request.newUrl, 'newUrl'),
    name,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  const args = ['dev', input.action];
  if (input.name !== null) args.push(`--name=${input.name}`);
  args.push('--', planning ? input.reference.planningValue : input.reference.nodeId);
  if (input.action === 'edit') args.push(input.currentUrl, input.newUrl);
  else args.push(input.url);
  return args;
}

export function devResourceMutationArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseDevResourceMutationRequest(args);
  return args;
}

export function devResourceMutationPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseDevResourceMutationRequest(args);
  return args;
}
