// Closed request Interface for `jam board`.

function requestError(message) {
  return new Error(`Invalid Jam Board command: ${message}.`);
}

export function parseJamBoardRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'board') {
    throw new Error('Expected a jam board command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Board arguments must be strings.');
  }
  let json = false;
  let literal = false;
  const positionals = [];
  for (const token of args.slice(2)) {
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true; continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 0) throw requestError(`unexpected argument ${positionals[0]}`);
  return Object.freeze({ json });
}

export function acceptsJamBoardArgv(args) {
  try { parseJamBoardRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Board request must be an object.');
  }
  if (Object.keys(request).some((key) => key !== 'json')) {
    throw requestError('request contains an unknown field');
  }
  if (request.json !== undefined && typeof request.json !== 'boolean') {
    throw requestError('json must be boolean');
  }
  return { json: request.json === true };
}

export function jamBoardArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['jam', 'board', ...(input.json ? ['--json'] : [])];
  parseJamBoardRequest(args);
  return args;
}
