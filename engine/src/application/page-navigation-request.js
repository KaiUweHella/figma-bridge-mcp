// Closed request Interface for `canvas pages` and `canvas page`.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';

const MAX_PAGE_QUERY_CODE_UNITS = 4096;

function requestError(message) {
  return new Error(`Invalid Page Navigation command: ${message}.`);
}

function pageReference(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError('page reference is required');
  }
  if (value.length > MAX_PAGE_QUERY_CODE_UNITS) {
    throw requestError(`page query exceeds ${MAX_PAGE_QUERY_CODE_UNITS} code units`);
  }
  try {
    return parseUnionReference(value, { allowedKinds: ['node', 'name', 'query'] });
  } catch (error) {
    throw requestError(error.message);
  }
}

export function parsePageNavigationRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'canvas' || !['pages', 'page'].includes(args[1])) {
    throw new Error('Expected a canvas pages or canvas page command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Page Navigation arguments must be strings.');
  }

  if (args[1] === 'pages') {
    let json = false;
    let literal = false;
    for (let index = 2; index < args.length; index++) {
      const token = args[index];
      if (!literal && token === '--') {
        literal = true;
        continue;
      }
      if (!literal && token === '--json') {
        if (json) throw requestError('--json may be provided only once');
        json = true;
        continue;
      }
      throw requestError(`unknown option or unexpected argument ${token}`);
    }
    return { action: 'pages', json };
  }

  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('page query is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { action: 'page', reference: pageReference(positionals[0]) };
}

export function acceptsPageNavigationArgv(args) {
  try {
    parsePageNavigationRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Page Navigation request must be an object.');
  }
  if (request.action === 'pages') {
    if (Object.keys(request).some((key) => !['action', 'json'].includes(key))) {
      throw requestError('pages request contains an unknown field');
    }
    if (request.json != null && typeof request.json !== 'boolean') {
      throw requestError('json must be a boolean');
    }
    return { action: 'pages', json: request.json === true };
  }
  if (request.action !== 'page') throw requestError('action must be pages or page');
  if (Object.keys(request).some((key) => !['action', 'query', 'reference'].includes(key))) {
    throw requestError('page request contains an unknown field');
  }
  if (request.query != null && request.reference != null) {
    throw requestError('provide query or reference, not both');
  }
  if (typeof request.reference === 'object' && request.reference) {
    return {
      action: 'page',
      reference: pageReference(unionReferenceArgvValue(request.reference, {
        allowedKinds: ['node', 'name', 'query'],
      })),
    };
  }
  return { action: 'page', reference: pageReference(request.query) };
}

export function pageNavigationArgvFromRequest(request) {
  const input = typedRequest(request);
  if (input.action === 'pages') {
    return ['canvas', 'pages', ...(input.json ? ['--json'] : [])];
  }
  const value = unionReferenceArgvValue(input.reference, {
    allowedKinds: ['node', 'name', 'query'],
  });
  return value.startsWith('-')
    ? ['canvas', 'page', '--', value]
    : ['canvas', 'page', value];
}

export function pageNavigationPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  if (input.action === 'pages') return pageNavigationArgvFromRequest(input);
  const value = input.reference.kind === 'node'
    ? `node:${input.reference.planningValue}`
    : unionReferenceArgvValue(input.reference, { allowedKinds: ['node', 'name', 'query'] });
  return ['canvas', 'page', value];
}

export function pageNavigationFigmaUrlFileKeyFromArgv(args) {
  const input = parsePageNavigationRequest(args);
  return input.action === 'page' ? input.reference.fileKey : null;
}
