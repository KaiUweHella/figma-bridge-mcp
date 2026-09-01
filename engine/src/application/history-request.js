// Closed request Interface for structural history and named Figma versions.
import { normalizeNodeId } from '../lib/node-id.js';

const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const MAX_NODE_ID_CODE_UNITS = 512;
const MAX_LABEL_CODE_UNITS = 4096;
const MAX_REF_CODE_UNITS = 128;
export const MAX_VERSION_TITLE_CODE_UNITS = 1_024;
export const MAX_VERSION_DESCRIPTION_CODE_UNITS = 4_096;

function requestError(message) {
  return new Error(`Invalid history command: ${message}.`);
}

function boundedInteger(value, label, { min = 0, max }) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw requestError(`${label} must be an integer between ${min} and ${max}`);
  }
  const number = Number(value);
  if (number < min || number > max) {
    throw requestError(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function nodeValue(value) {
  if (!value) return { nodeId: '', fileKey: null };
  const normalized = normalizeNodeId(value);
  if (!normalized.id || normalized.id.length > MAX_NODE_ID_CODE_UNITS
    || !NODE_ID_PATTERN.test(normalized.id)) {
    throw requestError('node must be a bounded Figma node id or URL containing node-id');
  }
  return { nodeId: normalized.id, fileKey: normalized.fileKey || null };
}

function refValue(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_REF_CODE_UNITS) {
    throw requestError(`${label} must contain 1 to ${MAX_REF_CODE_UNITS} code units`);
  }
  return value;
}

function versionText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw requestError(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string') throw requestError(`${label} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw requestError(`${label} must not be empty`);
  if (normalized.length > maximum) {
    throw requestError(`${label} must contain at most ${maximum} code units`);
  }
  return normalized || null;
}

/** @param {any} request */
export function normalizeVersionSaveRequest(request = {}) {
  const { title, description = null } = request;
  return Object.freeze({
    title: versionText(title, 'version title', MAX_VERSION_TITLE_CODE_UNITS, { required: true }),
    description: versionText(description, 'version description', MAX_VERSION_DESCRIPTION_CODE_UNITS),
  });
}

function parseSaveOptions(args) {
  const positionals = [];
  let description = null;
  let descriptionSeen = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-d' || token === '--description')) {
      if (descriptionSeen) throw requestError('version description may be provided only once');
      const value = args[index + 1];
      if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
      description = value;
      descriptionSeen = true;
      index++;
      continue;
    }
    if (!literal) {
      const combined = token.match(/^(?:-d=?|--description=)(.+)$/);
      if (combined) {
        if (descriptionSeen) throw requestError('version description may be provided only once');
        description = combined[1];
        descriptionSeen = true;
        continue;
      }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'version title is required');
  }
  return { action: 'save', fileKey: null, ...normalizeVersionSaveRequest({ title: positionals[0], description }) };
}

function parseOptions(args, start, { action }) {
  const positionals = [];
  let node = { nodeId: '', fileKey: null };
  let depth = null;
  let label = null;
  let json = false;
  let changelog = false;
  let changelogPath = null;
  let maxItems = 40;
  let literal = false;
  const valueFlags = new Map([
    ['-n', 'node'], ['--node', 'node'],
    ['-d', 'depth'], ['--depth', 'depth'],
    ['-l', 'label'], ['--label', 'label'],
    ['--max-items', 'maxItems'],
  ]);
  const assign = (kind, value) => {
    if (kind === 'node') node = nodeValue(value);
    else if (kind === 'depth') depth = boundedInteger(value, 'depth', { max: 1000 });
    else if (kind === 'maxItems') maxItems = boundedInteger(value, 'max-items', { min: 1, max: 1000 });
    else {
      if (!value || value.length > MAX_LABEL_CODE_UNITS) {
        throw requestError(`label must contain 1 to ${MAX_LABEL_CODE_UNITS} code units`);
      }
      label = value;
    }
  };

  for (let index = start; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && valueFlags.has(token)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(`${token} requires a value`);
      }
      assign(valueFlags.get(token), value);
      index++;
      continue;
    }
    if (!literal) {
      const combined = token.match(/^(-n|-d|-l|--node|--depth|--label|--max-items)=(.*)$/);
      if (combined) {
        if (!combined[2]) throw requestError(`${combined[1]} requires a value`);
        assign(valueFlags.get(combined[1]), combined[2]);
        continue;
      }
      if (token === '--json') { json = true; continue; }
      if (token === '--changelog') {
        changelog = true;
        const next = args[index + 1];
        if (typeof next === 'string' && next && !next.startsWith('-')) {
          changelogPath = next;
          index++;
        }
        continue;
      }
      const changelogMatch = token.match(/^--changelog=(.*)$/);
      if (changelogMatch) {
        if (!changelogMatch[1]) throw requestError('--changelog path must not be empty');
        changelog = true;
        changelogPath = changelogMatch[1];
        continue;
      }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }

  if (action === 'snapshot') {
    if (positionals.length) throw requestError(`unexpected argument ${positionals[0]}`);
    if (changelog || maxItems !== 40) throw requestError('snapshot does not accept diff options');
    return { action, ...node, depth, label, format: json ? 'json' : 'save' };
  }
  if (action === 'diff') {
    if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
    if (label !== null) throw requestError('diff does not accept --label');
    if (json && changelog) throw requestError('--json and --changelog are mutually exclusive');
    return {
      action,
      from: refValue(positionals[0] || 'previous', 'from ref'),
      to: refValue(positionals[1] || 'latest', 'to ref'),
      ...node,
      depth,
      format: json ? 'json' : changelog ? 'changelog' : 'text',
      changelogPath,
      maxItems,
    };
  }
  throw requestError(`unsupported action ${action}`);
}

/** @returns {any} */
function parsedHistoryRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'history') throw new Error('Expected a history command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('History arguments must be strings.');
  const action = args[1];
  if (action === 'save') return parseSaveOptions(args);
  if (action === 'list') {
    if (args.length !== 2) throw requestError(`unexpected argument ${args[2]}`);
    return { action: 'list', fileKey: null };
  }
  if (action !== 'snapshot' && action !== 'diff') {
    throw requestError('supported actions are save, snapshot, list, and diff');
  }
  return parseOptions(args, 2, { action });
}

/** @returns {any} */
export function parseHistoryRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedHistoryRequest(args);
  return request;
}

export function historyFigmaUrlFileKeyFromArgv(args) {
  return parsedHistoryRequest(args).fileKey;
}

export function acceptsHistoryArgv(args) {
  try { parseHistoryRequest(args); return true; } catch { return false; }
}

export function historyArgvFromRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('History request must be an object.');
  const action = request.action;
  if (!['save', 'snapshot', 'list', 'diff'].includes(action)) {
    throw requestError('supported actions are save, snapshot, list, and diff');
  }
  if (action === 'save') {
    const input = normalizeVersionSaveRequest(request);
    const args = ['history', 'save'];
    if (input.description) args.push('--description', input.description);
    args.push('--', input.title);
    parseHistoryRequest(args);
    return args;
  }
  if (request.nodeId != null && typeof request.nodeId !== 'string') throw requestError('nodeId must be a string');
  if (request.label != null && typeof request.label !== 'string') throw requestError('label must be a string');
  if (request.changelogPath != null && typeof request.changelogPath !== 'string') {
    throw requestError('changelogPath must be a string');
  }
  const allowedFormats = action === 'snapshot' ? ['save', 'json']
    : action === 'diff' ? ['text', 'json', 'changelog'] : [];
  if (request.format != null && !allowedFormats.includes(request.format)) {
    throw requestError(`${action} format must be one of ${allowedFormats.join(', ') || 'none'}`);
  }
  if (action === 'list') return ['history', 'list'];
  const args = ['history', String(action || '')];
  if (action === 'diff') {
    args.push(String(request.from ?? 'previous'), String(request.to ?? 'latest'));
  }
  if (request.nodeId) args.push('--node', String(request.nodeId).trim());
  if (request.depth != null) args.push('--depth', String(request.depth));
  if (action === 'snapshot' && request.label != null) args.push('--label', String(request.label));
  if (request.format === 'json') args.push('--json');
  if (action === 'diff' && request.format === 'changelog') {
    args.push('--changelog');
    if (request.changelogPath) args.push(String(request.changelogPath));
  }
  if (action === 'diff' && request.maxItems != null && Number(request.maxItems) !== 40) {
    args.push('--max-items', String(request.maxItems));
  }
  const parsed = parsedHistoryRequest(args);
  const canonical = ['history', parsed.action];
  if (parsed.action === 'diff') canonical.push(parsed.from, parsed.to);
  if (parsed.nodeId) canonical.push('--node', parsed.nodeId);
  if (parsed.depth !== null) canonical.push('--depth', String(parsed.depth));
  if (parsed.action === 'snapshot' && parsed.label) canonical.push('--label', parsed.label);
  if (parsed.format === 'json') canonical.push('--json');
  if (parsed.action === 'diff' && parsed.format === 'changelog') {
    canonical.push('--changelog');
    if (parsed.changelogPath) canonical.push(parsed.changelogPath);
  }
  if (parsed.action === 'diff' && parsed.maxItems !== 40) canonical.push('--max-items', String(parsed.maxItems));
  return canonical;
}

export function historyPlanningArgvFromRequest(request) {
  const canonical = historyArgvFromRequest(request);
  if (request?.action === 'save') return canonical;
  if (!request?.nodeId) return canonical;
  const parsed = parsedHistoryRequest(['history', String(request.action),
    ...(request.action === 'diff' ? [String(request.from ?? 'previous'), String(request.to ?? 'latest')] : []),
    '--node', String(request.nodeId).trim()]);
  if (!parsed.fileKey) return canonical;
  const nodeIndex = canonical.indexOf('--node') + 1;
  canonical[nodeIndex] = String(request.nodeId).trim();
  return canonical;
}
