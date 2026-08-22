// Closed request Interface for Design Contract commands.
//
// Commander and MCP share this action-specific parser so unknown options,
// missing values and positional arity are rejected before planning effects.

const ACTIONS = Object.freeze({
  capture: Object.freeze({
    valueOptions: Object.freeze({
      '--file': 'contractPath',
      '--manifest': 'manifestPath',
      '--depth': 'depth',
      '--geometry-tolerance': 'geometryTolerance',
    }),
  }),
  check: Object.freeze({
    valueOptions: Object.freeze({
      '--file': 'contractPath',
      '--manifest': 'manifestPath',
      '--depth': 'depth',
      '--max-diffs': 'maxDiffs',
    }),
  }),
});

function commandError(action, message) {
  return new Error(`Invalid contract ${action || '(missing)'} command: ${message}.`);
}

/** Parse one Design Contract argv without consulting global argv. */
export function parseDesignContractRequest(args, { requirePaths = true } = {}) {
  if (!Array.isArray(args) || args[0] !== 'contract') throw new Error('Expected a contract command.');
  if (args.some((value) => typeof value !== 'string')) throw new Error('Design Contract arguments must be strings.');
  const action = args[1];
  const contract = ACTIONS[action];
  if (!contract) throw new Error(`Unknown Design Contract action: ${action || '(missing)'}`);

  const positionals = [];
  const values = {};
  let includeHidden = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (token === '--include-hidden') {
      includeHidden = true;
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const property = contract.valueOptions[flag];
    if (!property) throw commandError(action, `unknown option ${flag}`);
    const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (typeof value !== 'string' || !value || value.startsWith('-')) {
      throw commandError(action, `${flag} requires a value`);
    }
    values[property] = value;
    if (equals === -1) index++;
  }

  if (positionals.length === 0) throw commandError(action, 'missing required argument entityId');
  if (positionals.length > 1) throw commandError(action, `unexpected argument ${positionals[1]}`);
  if (requirePaths && !values.manifestPath) throw new Error('Design Link Registry path is required.');
  if (requirePaths && !values.contractPath) throw new Error('Design Contract file path is required.');

  return {
    action,
    entityId: positionals[0],
    manifestPath: values.manifestPath,
    contractPath: values.contractPath,
    depth: values.depth,
    includeHidden,
    ...(action === 'capture' ? { geometryTolerance: values.geometryTolerance } : { maxDiffs: values.maxDiffs }),
  };
}

export function acceptsDesignContractArgv(args) {
  try {
    parseDesignContractRequest(args, { requirePaths: false });
    return true;
  } catch {
    return false;
  }
}

function appendValue(args, flag, value) {
  if (value !== undefined && value !== null && String(value) !== '') args.push(flag, String(value));
}

function appendNonDefaultNumber(args, flag, value, defaultValue) {
  if (value !== undefined && value !== null && Number(value) !== defaultValue) {
    appendValue(args, flag, value);
  }
}

/** Convert one typed Adapter request into canonical Command Plan argv. */
export function designContractArgvFromRequest(request) {
  if (!request || !ACTIONS[request.action]) {
    throw new Error(`Unknown Design Contract action: ${request?.action || '(missing)'}`);
  }
  const args = ['contract', request.action];
  if (request.entityId !== undefined) args.push(String(request.entityId));
  appendValue(args, '--manifest', request.manifestPath);
  appendValue(args, '--file', request.contractPath);
  appendNonDefaultNumber(args, '--depth', request.depth, 12);
  if (request.includeHidden === true) args.push('--include-hidden');
  if (request.action === 'capture') {
    appendNonDefaultNumber(args, '--geometry-tolerance', request.geometryTolerance, 0.5);
  } else {
    appendNonDefaultNumber(args, '--max-diffs', request.maxDiffs, 200);
  }
  parseDesignContractRequest(args);
  return args;
}
