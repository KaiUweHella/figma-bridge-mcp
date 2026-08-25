// Closed request Interface for `tokens rebind`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_TOKEN_REBIND_QUERY_CODE_UNITS = 512;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid tokens rebind command: ${message}.`);
}

function collectionValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('Collection query is required');
  if (value.length > MAX_TOKEN_REBIND_QUERY_CODE_UNITS) {
    throw requestError(`Collection query must be at most ${MAX_TOKEN_REBIND_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) throw requestError('Collection query contains unsupported controls');
  return value;
}

function nodeValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('--node requires a node id');
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('--node must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'tokens' || args[1] !== 'rebind') {
    throw new Error('Expected a tokens rebind command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Rebind arguments must be strings.');
  }
  let node = null;
  let page = false;
  let apply = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const shortNode = !literal ? token.match(/^-n(?:=)?(.+)$/s) : null;
    if (!literal && (token === '--node' || token === '-n' || shortNode)) {
      if (node) throw requestError('--node may be provided only once');
      const value = shortNode?.[1] ?? args[++index];
      if (value === undefined) throw requestError('--node requires a value');
      node = nodeValue(value);
      continue;
    }
    if (!literal && token === '--page') {
      if (page) throw requestError('--page may be provided only once');
      page = true; continue;
    }
    if (!literal && token === '--apply') {
      if (apply) throw requestError('--apply may be provided only once');
      apply = true; continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError('exactly one Collection query is required');
  if (!!node === page) throw requestError('exactly one of --node or --page is required');
  if (page && apply) throw requestError('page-wide --apply is disabled; use a node-scoped apply');
  return {
    collection: collectionValue(positionals[0]), nodeId: node?.nodeId || null,
    page, apply, fileKey: node?.fileKey || null, warning: node?.warning || '',
  };
}

export function parseTokenRebindRequest(args) {
  const { fileKey: _fileKey, warning: _warning, ...request } = parsedRequest(args);
  return request;
}

export function tokenRebindFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}

export function acceptsTokenRebindArgv(args) {
  try { parseTokenRebindRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['collection', 'nodeId', 'page', 'apply'].includes(key))) {
    throw new TypeError('Token Rebind request must be a closed object.');
  }
  const page = request.page === true;
  const apply = request.apply === true;
  if (request.page != null && typeof request.page !== 'boolean') throw requestError('page must be a boolean');
  if (request.apply != null && typeof request.apply !== 'boolean') throw requestError('apply must be a boolean');
  if ((request.nodeId != null) === page) throw requestError('exactly one of nodeId or page is required');
  if (page && apply) throw requestError('page-wide --apply is disabled; use a node-scoped apply');
  const node = page ? null : nodeValue(request.nodeId);
  return { collection: collectionValue(request.collection), node, page, apply };
}

export function tokenRebindArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['tokens', 'rebind', input.page ? '--page' : '--node',
    ...(input.page ? [] : [input.node.nodeId]), ...(input.apply ? ['--apply'] : []),
    '--', input.collection];
}

export function tokenRebindPlanningArgvFromRequest(request) {
  const canonical = tokenRebindArgvFromRequest(request);
  if (request?.nodeId) {
    const reference = parseNodeReference(request.nodeId);
    if (reference.fileKey) canonical[3] = reference.planningValue;
  }
  return canonical;
}
