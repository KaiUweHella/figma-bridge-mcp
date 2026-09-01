// Closed request Interface for repository-backed build verification.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_VERIFY_BUILD_PATH_CODE_UNITS = 16_384;
export const MAX_VERIFY_BUILD_DIFF_PERCENT = 100;

const VALUE_OPTIONS = Object.freeze([
  '--assets', '--compare', '--design', '--node', '--diff-out', '--max-diff',
  '--fidelity-ledger', '--browser-capture',
]);
const FLAG_OPTIONS = Object.freeze(['--json']);

function requestError(message) {
  return new Error(`Invalid verify-build command: ${message}.`);
}

function boundedPath(value, label) {
  if (typeof value !== 'string' || !value.length
    || value.length > MAX_VERIFY_BUILD_PATH_CODE_UNITS) {
    throw requestError(`${label} must be a bounded non-empty path`);
  }
  return value;
}

function nodeReference(value) {
  if (value === undefined || value === null) return null;
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('--node must be a bounded Figma node id or URL containing node-id');
  }
}

function diffPercent(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string'
    && !/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(value)) {
    throw requestError(`--max-diff must be between 0 and ${MAX_VERIFY_BUILD_DIFF_PERCENT}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_VERIFY_BUILD_DIFF_PERCENT) {
    throw requestError(`--max-diff must be between 0 and ${MAX_VERIFY_BUILD_DIFF_PERCENT}`);
  }
  return number;
}

function optionToken(token) {
  for (const name of VALUE_OPTIONS) {
    if (token === name) return { name, inline: null, flag: false };
    if (token.startsWith(`${name}=`)) {
      return { name, inline: token.slice(name.length + 1), flag: false };
    }
  }
  if (FLAG_OPTIONS.includes(token)) return { name: token, inline: true, flag: true };
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('verify-build arguments must be strings.');
  }
  if (args[0] !== 'verify-build') throw new Error('Expected a verify-build command.');
  const positionals = [];
  const options = new Map();
  let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const option = optionToken(token);
      if (!option) throw requestError(`unknown option ${token}`);
      if (options.has(option.name)) throw requestError(`${option.name} may be provided only once`);
      if (option.flag) {
        options.set(option.name, true);
        continue;
      }
      let value = option.inline;
      if (value === null) {
        value = args[index + 1];
        if (value === undefined || value === '--' || optionToken(value)) {
          throw requestError(`${option.name} requires a value`);
        }
        index++;
      }
      if (!value.length) throw requestError(`${option.name} requires a value`);
      options.set(option.name, value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'projectDir is required');
  }
  const reference = nodeReference(options.get('--node'));
  const comparePath = options.has('--compare')
    ? boundedPath(options.get('--compare'), '--compare') : null;
  const designPath = options.has('--design')
    ? boundedPath(options.get('--design'), '--design') : null;
  const fidelityLedgerPath = options.has('--fidelity-ledger')
    ? boundedPath(options.get('--fidelity-ledger'), '--fidelity-ledger') : null;
  const browserCapturePath = options.has('--browser-capture')
    ? boundedPath(options.get('--browser-capture'), '--browser-capture') : null;
  if (Boolean(fidelityLedgerPath) !== Boolean(browserCapturePath)) {
    throw requestError('--fidelity-ledger and --browser-capture must be passed together');
  }
  return {
    projectDir: boundedPath(positionals[0], 'projectDir'),
    assetsPath: options.has('--assets')
      ? boundedPath(options.get('--assets'), '--assets') : null,
    comparePath,
    designPath,
    node: reference,
    diffOutPath: options.has('--diff-out')
      ? boundedPath(options.get('--diff-out'), '--diff-out') : null,
    maxDiff: diffPercent(options.get('--max-diff')),
    fidelityLedgerPath,
    browserCapturePath,
    json: options.get('--json') === true,
  };
}

function projected(input) {
  return Object.freeze({
    projectDir: input.projectDir,
    assetsPath: input.assetsPath,
    comparePath: input.comparePath,
    designPath: input.designPath,
    nodeId: input.node?.nodeId || null,
    warning: input.designPath && input.node
      ? 'both --design and --node given — using the --design file, no Figma fetch.' : '',
    diffOutPath: input.diffOutPath,
    maxDiff: input.maxDiff,
    fidelityLedgerPath: input.fidelityLedgerPath,
    browserCapturePath: input.browserCapturePath,
    json: input.json,
    needsFigma: Boolean(input.comparePath && !input.designPath),
  });
}

export function parseVerifyBuildRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsVerifyBuildArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}

export function verifyBuildFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('verify-build request must be an object.');
  }
  const path = (key, label) => request[key] === undefined || request[key] === null
    ? null : boundedPath(request[key], label);
  const input = {
    projectDir: boundedPath(request.projectDir, 'projectDir'),
    assetsPath: path('assetsPath', 'assetsPath'),
    comparePath: path('comparePath', 'comparePath'),
    designPath: path('designPath', 'designPath'),
    node: nodeReference(request.nodeId),
    diffOutPath: path('diffOutPath', 'diffOutPath'),
    maxDiff: diffPercent(request.maxDiff),
    fidelityLedgerPath: path('fidelityLedgerPath', 'fidelityLedgerPath'),
    browserCapturePath: path('browserCapturePath', 'browserCapturePath'),
    json: request.json === true,
  };
  if (Boolean(input.fidelityLedgerPath) !== Boolean(input.browserCapturePath)) {
    throw requestError('fidelityLedgerPath and browserCapturePath must be passed together');
  }
  return input;
}

function argvFrom(input, planning) {
  const args = ['verify-build', input.projectDir];
  if (input.assetsPath) args.push('--assets', input.assetsPath);
  if (input.comparePath) args.push('--compare', input.comparePath);
  if (input.designPath) args.push('--design', input.designPath);
  if (input.node) args.push('--node', planning ? input.node.planningValue : input.node.nodeId);
  if (input.diffOutPath) args.push('--diff-out', input.diffOutPath);
  if (input.maxDiff !== null) args.push('--max-diff', String(input.maxDiff));
  if (input.fidelityLedgerPath) args.push('--fidelity-ledger', input.fidelityLedgerPath);
  if (input.browserCapturePath) args.push('--browser-capture', input.browserCapturePath);
  if (input.json) args.push('--json');
  return args;
}

export function verifyBuildArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false);
  parseVerifyBuildRequest(args);
  return args;
}

export function verifyBuildPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true);
  parseVerifyBuildRequest(args);
  return args;
}
