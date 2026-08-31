// Closed request Interface for `analyze lint`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const ANALYSIS_LINT_KINDS = Object.freeze([
  'bindable', 'naming', 'typography', 'legibility',
]);
export const MAX_ANALYSIS_LINT_LIMIT = 4096;

const KIND_SET = new Set(ANALYSIS_LINT_KINDS);

function requestError(message) {
  return new Error(`Invalid Analyze lint command: ${message}.`);
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('node must be a bounded Figma node id or URL containing node-id');
  }
}

function kindsValue(value) {
  const kinds = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((item) => item.trim()).filter(Boolean)
      : null;
  if (!kinds || kinds.length === 0) {
    throw requestError('--kind must contain at least one known kind');
  }
  if (kinds.some((kind) => typeof kind !== 'string' || !KIND_SET.has(kind))) {
    const unknown = kinds.filter((kind) => typeof kind !== 'string' || !KIND_SET.has(kind));
    throw requestError(`unknown kind(s): ${unknown.join(', ')}; known kinds are ${ANALYSIS_LINT_KINDS.join(', ')}`);
  }
  if (new Set(kinds).size !== kinds.length) {
    throw requestError('--kind must not contain duplicates');
  }
  return Object.freeze([...kinds]);
}

function limitValue(value) {
  const source = String(value);
  if (!/^[1-9][0-9]*$/.test(source)) {
    throw requestError(`--limit must be an integer between 1 and ${MAX_ANALYSIS_LINT_LIMIT}`);
  }
  const limit = Number(source);
  if (!Number.isSafeInteger(limit) || limit > MAX_ANALYSIS_LINT_LIMIT) {
    throw requestError(`--limit must be an integer between 1 and ${MAX_ANALYSIS_LINT_LIMIT}`);
  }
  return limit;
}

function optionValue(args, index, token, inline) {
  if (inline !== null) {
    if (!inline) throw requestError(`${token} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (typeof value !== 'string' || !value || value === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value, index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'analyze' || args[1] !== 'lint') {
    throw new Error('Expected an Analyze lint command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Analyze lint arguments must be strings.');
  }

  const seen = new Set();
  const positionals = [];
  let node = null;
  let kinds = ANALYSIS_LINT_KINDS;
  let limit = 10;
  let json = false;
  let failOnIssues = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '--json' || token === '--fail-on-issues')) {
      const field = token === '--json' ? 'json' : 'failOnIssues';
      if (seen.has(field)) throw requestError(`${token} may be provided only once`);
      seen.add(field);
      if (field === 'json') json = true;
      else failOnIssues = true;
      continue;
    }
    if (!literal) {
      const options = [
        ['node', '-n', '--node'],
        ['kinds', null, '--kind'],
        ['limit', null, '--limit'],
      ];
      let matched = false;
      for (const [field, short, long] of options) {
        const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
        const shortInline = short && token.startsWith(short) && token !== short
          ? token.slice(short.length).replace(/^=/, '') : null;
        if (token !== long && token !== short && longInline === null && shortInline === null) continue;
        if (seen.has(field)) throw requestError(`${long} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, long, longInline ?? shortInline);
        index = item.index;
        if (field === 'node') node = nodeValue(item.value);
        if (field === 'kinds') kinds = kindsValue(item.value);
        if (field === 'limit') limit = limitValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 0) throw requestError(`unexpected argument ${positionals[0]}`);
  return { node, kinds, limit, json, failOnIssues };
}

export function parseAnalysisLintRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.node?.nodeId || null,
    kinds: Object.freeze([...input.kinds]),
    limit: input.limit,
    json: input.json,
    failOnIssues: input.failOnIssues,
    warning: input.node?.warning || '',
  });
}

export function analysisLintFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}

export function acceptsAnalysisLintArgv(args) {
  try { parseAnalysisLintRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Analyze lint request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  if (request.failOnIssues != null && typeof request.failOnIssues !== 'boolean') {
    throw requestError('failOnIssues must be a boolean');
  }
  return {
    node: request.nodeId == null ? null : nodeValue(request.nodeId),
    kinds: request.kinds == null ? ANALYSIS_LINT_KINDS : kindsValue(request.kinds),
    limit: request.limit == null ? 10 : limitValue(request.limit),
    json: request.json === true,
    failOnIssues: request.failOnIssues === true,
  };
}

function argvFromInput(input, planning) {
  const allKinds = input.kinds.length === ANALYSIS_LINT_KINDS.length
    && input.kinds.every((kind, index) => kind === ANALYSIS_LINT_KINDS[index]);
  return [
    'analyze', 'lint',
    ...(input.node ? [`--node=${planning ? input.node.planningValue : input.node.nodeId}`] : []),
    ...(allKinds ? [] : [`--kind=${input.kinds.join(',')}`]),
    ...(input.limit === 10 ? [] : [`--limit=${input.limit}`]),
    ...(input.json ? ['--json'] : []),
    ...(input.failOnIssues ? ['--fail-on-issues'] : []),
  ];
}

export function analysisLintArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseAnalysisLintRequest(args);
  return args;
}

export function analysisLintPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseAnalysisLintRequest(args);
  return args;
}
