// Closed request Interface for `canvas pages` and `canvas page`.

const MAX_PAGE_QUERY_CODE_UNITS = 4096;

function requestError(message) {
  return new Error(`Invalid Page Navigation command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError('page query is required');
  }
  if (value.length > MAX_PAGE_QUERY_CODE_UNITS) {
    throw requestError(`page query exceeds ${MAX_PAGE_QUERY_CODE_UNITS} code units`);
  }
  return value;
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
  return { action: 'page', query: queryValue(positionals[0]) };
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
    if (request.json != null && typeof request.json !== 'boolean') {
      throw requestError('json must be a boolean');
    }
    return { action: 'pages', json: request.json === true };
  }
  if (request.action !== 'page') throw requestError('action must be pages or page');
  return { action: 'page', query: queryValue(request.query) };
}

export function pageNavigationArgvFromRequest(request) {
  const input = typedRequest(request);
  if (input.action === 'pages') {
    return ['canvas', 'pages', ...(input.json ? ['--json'] : [])];
  }
  return input.query.startsWith('-')
    ? ['canvas', 'page', '--', input.query]
    : ['canvas', 'page', input.query];
}

export const pageNavigationPlanningArgvFromRequest = pageNavigationArgvFromRequest;
