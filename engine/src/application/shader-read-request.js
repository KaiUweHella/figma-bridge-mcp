// Closed request Interface for `shader list`.

function requestError(message) {
  return new Error(`Invalid Shader Read command: ${message}.`);
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'shader' || args[1] !== 'list') {
    throw new Error('Expected a Shader Read command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Shader Read arguments must be strings.');
  }
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length) throw requestError(`unexpected argument ${positionals[0]}`);
  return Object.freeze({ action: 'list' });
}

export function parseShaderReadRequest(args) {
  return parsedRequest(args);
}

export function acceptsShaderReadArgv(args) {
  try {
    parsedRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function shaderReadArgvFromRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Shader Read request must be an object.');
  }
  if (request.action !== undefined && request.action !== 'list') {
    throw requestError('action must be list');
  }
  return ['shader', 'list'];
}
