// Closed request Interface for `component list`.

function requestError(message) {
  return new Error(`Invalid component list command: ${message}.`);
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'list') {
    throw new Error('Expected a component list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Inventory arguments must be strings.');
  }
  let allPages = false;
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--all-pages') {
      if (allPages) throw requestError('--all-pages may be provided only once');
      allPages = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    throw requestError(`unexpected argument ${token}`);
  }
  return { allPages, json };
}

export function parseComponentInventoryRequest(args) {
  return Object.freeze(parsedRequest(args));
}

export function acceptsComponentInventoryArgv(args) {
  try { parseComponentInventoryRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Inventory request must be an object.');
  }
  return { allPages: request.allPages === true, json: request.json === true };
}

export function componentInventoryArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['component', 'list'];
  if (input.allPages) argv.push('--all-pages');
  if (input.json) argv.push('--json');
  parseComponentInventoryRequest(argv);
  return argv;
}

export const componentInventoryPlanningArgvFromRequest = componentInventoryArgvFromRequest;
