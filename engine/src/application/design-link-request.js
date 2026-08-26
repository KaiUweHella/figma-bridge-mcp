// Closed request Interface for Design Link commands.
//
// Commander validates its own input before calling an action. MCP argv does
// not pass through Commander, so both Adapters use this parser to keep option
// names, required values and positional arity identical.

const ACTIONS = Object.freeze({
  set: Object.freeze({
    positionals: Object.freeze(['nodeId', 'entityId']),
    required: 2,
    options: Object.freeze({
      '--manifest': 'manifestPath',
      '--kind': 'kind',
      '--source': 'source',
      '--export': 'exportName',
      '--story': 'storyId',
    }),
  }),
  inspect: Object.freeze({
    positionals: Object.freeze(['nodeId']),
    required: 0,
    options: Object.freeze({ '--manifest': 'manifestPath' }),
  }),
  list: Object.freeze({
    positionals: Object.freeze([]),
    required: 0,
    options: Object.freeze({ '--manifest': 'manifestPath' }),
  }),
  configure: Object.freeze({
    positionals: Object.freeze([]),
    required: 0,
    options: Object.freeze({
      '--manifest': 'manifestPath',
      '--design-doc': 'designDoc',
      '--tokens': 'tokens',
    }),
  }),
  status: Object.freeze({
    positionals: Object.freeze(['entityId']),
    required: 0,
    options: Object.freeze({ '--manifest': 'manifestPath' }),
  }),
  accept: Object.freeze({
    positionals: Object.freeze(['entityId']),
    required: 0,
    options: Object.freeze({
      '--manifest': 'manifestPath',
      '--compare': 'comparePath',
      '--max-diff': 'maxDiff',
      '--require-render-adapter': 'requiredRenderAdapter',
    }),
  }),
  context: Object.freeze({
    positionals: Object.freeze(['entityId']),
    required: 0,
    options: Object.freeze({ '--manifest': 'manifestPath' }),
  }),
});

function commandError(action, message) {
  return new Error(`Invalid link ${action || '(missing)'} command: ${message}.`);
}

function optionValue(args, index, action, flag) {
  const value = args[index + 1];
  if (typeof value !== 'string' || !value || value.startsWith('-')) {
    throw commandError(action, `${flag} requires a value`);
  }
  return value;
}

/** Parse one already-tokenized Design Link argv without consulting global argv. */
export function parseDesignLinkRequest(args, { requireManifest = true } = {}) {
  if (!Array.isArray(args) || args[0] !== 'link') throw new Error('Expected a link command.');
  if (args.some((value) => typeof value !== 'string')) throw new Error('Design Link arguments must be strings.');
  const action = args[1];
  const contract = ACTIONS[action];
  if (!contract) throw new Error(`Unknown Design Link action: ${action || '(missing)'}`);

  const positionals = [];
  const values = {};
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const property = contract.options[flag];
    if (!property) throw commandError(action, `unknown option ${flag}`);
    const value = equals === -1
      ? optionValue(args, index, action, flag)
      : token.slice(equals + 1);
    if (!value) throw commandError(action, `${flag} requires a value`);
    values[property] = value;
    if (equals === -1) index++;
  }

  if (positionals.length < contract.required) {
    const missing = contract.positionals.slice(positionals.length, contract.required).join(', ');
    throw commandError(action, `missing required argument ${missing}`);
  }
  if (positionals.length > contract.positionals.length) {
    throw commandError(action, `unexpected argument ${positionals[contract.positionals.length]}`);
  }
  if (requireManifest && !values.manifestPath) {
    throw new Error('Design Link Registry path is required.');
  }

  const request = { action };
  contract.positionals.forEach((property, index) => {
    if (positionals[index] !== undefined) request[property] = positionals[index];
  });
  for (const property of Object.values(contract.options)) request[property] = values[property];
  if (request.requiredRenderAdapter !== undefined && request.requiredRenderAdapter !== 'dom-capture') {
    throw commandError(action, '--require-render-adapter currently supports dom-capture');
  }
  return request;
}

/** Capability planning asks only whether the Adapter input is closed and valid. */
export function acceptsDesignLinkArgv(args) {
  try {
    parseDesignLinkRequest(args, { requireManifest: false });
    return true;
  } catch {
    return false;
  }
}

function appendOption(args, flag, value) {
  if (value !== undefined && value !== null && String(value) !== '') args.push(flag, String(value));
}

/** Convert a typed tracer request into the canonical argv consumed by its Command Plan. */
export function designLinkArgvFromRequest(request) {
  if (!request || !['set', 'inspect'].includes(request.action)) {
    throw new Error('Only link set and link inspect use the migrated Command Application Interface.');
  }
  const args = ['link', request.action];
  if (request.nodeId !== undefined) args.push(String(request.nodeId));
  if (request.action === 'set' && request.entityId !== undefined) args.push(String(request.entityId));
  if (request.action === 'set') {
    appendOption(args, '--kind', request.kind);
    appendOption(args, '--source', request.source);
    appendOption(args, '--export', request.exportName);
    appendOption(args, '--story', request.storyId);
  }
  appendOption(args, '--manifest', request.manifestPath);
  parseDesignLinkRequest(args);
  return args;
}
