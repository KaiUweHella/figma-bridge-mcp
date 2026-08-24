// Closed request Interface for `export code-spec`.
// Commander and MCP canonicalize here before targeting or capture.

import { normalizeNodeId } from '../lib/node-id.js';
import { DEFAULT_SPEC_FORMAT } from '../lib/spec-format.js';

export const CODE_SPEC_PHASES = Object.freeze(['structure', 'style', 'all']);
export const CODE_SPEC_FORMATS = Object.freeze(['tree', 'yaml', 'json']);
export const MAX_CODE_SPEC_NODE_ID_CODE_UNITS = 512;
export const MAX_CODE_SPEC_SECTION_CODE_UNITS = 4096;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function commandError(message) {
  return new Error(`Invalid export code-spec command: ${message}.`);
}

function enumValue(value, values, name) {
  const normalized = String(value || '').toLowerCase();
  if (!values.includes(normalized)) {
    throw commandError(`unknown ${name} ${JSON.stringify(value)} — use ${values.join(', ')}`);
  }
  return normalized;
}

function depthValue(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw commandError('depth must be an integer between 0 and 30');
  }
  const depth = Number(value);
  if (depth > 30) throw commandError('depth must be an integer between 0 and 30');
  return depth;
}

function parsedCodeSpecRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'export' || args[1] !== 'code-spec') {
    throw new Error('Expected an export code-spec command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Code Spec arguments must be strings.');
  }

  const positionals = [];
  let phase = 'all';
  let depth = 12;
  let section = null;
  let format = DEFAULT_SPEC_FORMAT;
  let includeHidden = false;
  let dedup = true;
  let literal = false;
  const valueOptions = new Map([
    ['-p', 'phase'], ['--phase', 'phase'],
    ['-d', 'depth'], ['--depth', 'depth'],
    ['-s', 'section'], ['--section', 'section'],
    ['-f', 'format'], ['--format', 'format'],
  ]);
  const assign = (kind, value) => {
    if (kind === 'phase') phase = enumValue(value, CODE_SPEC_PHASES, 'phase');
    else if (kind === 'depth') depth = depthValue(value);
    else if (kind === 'format') format = enumValue(value, CODE_SPEC_FORMATS, 'format');
    else {
      if (!value || value.length > MAX_CODE_SPEC_SECTION_CODE_UNITS) {
        throw commandError(`section must be non-empty and at most ${MAX_CODE_SPEC_SECTION_CODE_UNITS} code units`);
      }
      section = value;
    }
  };

  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && valueOptions.has(token)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
        throw commandError(`${token} requires a value`);
      }
      assign(valueOptions.get(token), value);
      index++;
      continue;
    }
    if (!literal) {
      const combined = token.match(/^(-[pdsf]|--(?:phase|depth|section|format))=(.*)$/);
      if (combined) { assign(valueOptions.get(combined[1]), combined[2]); continue; }
      if (token === '--include-hidden') { includeHidden = true; continue; }
      if (token === '--no-dedup') { dedup = false; continue; }
      if (token.startsWith('-')) throw commandError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length > 1) throw commandError(`unexpected argument ${positionals[1]}`);

  let nodeId = '';
  let fileKey = null;
  if (positionals.length) {
    const normalized = normalizeNodeId(positionals[0]);
    nodeId = normalized.id;
    fileKey = normalized.fileKey || null;
    if (!nodeId || nodeId.length > MAX_CODE_SPEC_NODE_ID_CODE_UNITS || !NODE_ID_PATTERN.test(nodeId)) {
      throw commandError('nodeId must be a bounded Figma node id or URL containing node-id');
    }
  }
  return { nodeId, fileKey, phase, depth, section, format, includeHidden, dedup };
}

export function parseCodeSpecRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedCodeSpecRequest(args);
  return request;
}

export function codeSpecFigmaUrlFileKeyFromArgv(args) {
  return parsedCodeSpecRequest(args).fileKey;
}

export function acceptsCodeSpecArgv(args) {
  try { parseCodeSpecRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Code Spec request must be an object.');
  if (request.nodeId != null && typeof request.nodeId !== 'string') {
    throw commandError('nodeId must be a string');
  }
  if (request.phase != null && typeof request.phase !== 'string') {
    throw commandError('phase must be a string');
  }
  if (request.section != null && typeof request.section !== 'string') {
    throw commandError('section must be a string');
  }
  if (request.format != null && typeof request.format !== 'string') {
    throw commandError('format must be a string');
  }
  if (request.includeHidden != null && typeof request.includeHidden !== 'boolean') {
    throw commandError('includeHidden must be a boolean');
  }
  if (request.dedup != null && typeof request.dedup !== 'boolean') {
    throw commandError('dedup must be a boolean');
  }
  const args = ['export', 'code-spec'];
  if (request.nodeId != null && request.nodeId !== '') args.push(String(request.nodeId).trim());
  args.push('--phase', String(request.phase ?? 'all'), '--depth', String(request.depth ?? 12));
  if (request.section != null) args.push('--section', String(request.section));
  args.push('--format', String(request.format ?? DEFAULT_SPEC_FORMAT));
  if (request.includeHidden === true) args.push('--include-hidden');
  if (request.dedup === false) args.push('--no-dedup');
  return parsedCodeSpecRequest(args);
}

export function codeSpecArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['export', 'code-spec'];
  if (input.nodeId) args.push(input.nodeId);
  if (input.phase !== 'all') args.push('--phase', input.phase);
  if (input.depth !== 12) args.push('--depth', String(input.depth));
  if (input.section) args.push('--section', input.section);
  if (input.format !== DEFAULT_SPEC_FORMAT) args.push('--format', input.format);
  if (input.includeHidden) args.push('--include-hidden');
  if (!input.dedup) args.push('--no-dedup');
  return args;
}

export function codeSpecPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = codeSpecArgvFromRequest(input);
  if (input.fileKey) args[2] = String(request.nodeId).trim();
  return args;
}
