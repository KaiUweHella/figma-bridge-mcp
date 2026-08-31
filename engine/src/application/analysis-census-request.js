// Closed request Interface for the page-wide Analyze census reads.

export const ANALYSIS_CENSUS_ACTIONS = Object.freeze([
  'colors', 'typography', 'spacing', 'clusters',
]);

const ACTIONS = new Set(ANALYSIS_CENSUS_ACTIONS);

function requestError(message) {
  return new Error(`Invalid Analyze census command: ${message}.`);
}

export function parseAnalysisCensusRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'analyze') {
    throw new Error('Expected an analyze census command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Analyze census arguments must be strings.');
  }
  const action = args[1] === 'type' ? 'typography' : args[1];
  if (!ACTIONS.has(action)) throw new Error('Expected an analyze census command.');
  let json = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 0) throw requestError(`unexpected argument ${positionals[0]}`);
  return Object.freeze({ action, json });
}

export function acceptsAnalysisCensusArgv(args) {
  try { parseAnalysisCensusRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Analyze census request must be an object.');
  }
  const action = request.action === 'type' ? 'typography' : request.action;
  if (!ACTIONS.has(action)) throw requestError('action must name a census read');
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return { action, json: request.json === true };
}

export function analysisCensusArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['analyze', input.action, ...(input.json ? ['--json'] : [])];
}
