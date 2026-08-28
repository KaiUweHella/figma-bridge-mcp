// Closed compatibility Interface for the documented `export node` and
// `export screenshot` command names. PNG requests adapt to the Screenshot
// Command Application; the other historical formats remain explicit legacy
// exports until they receive a format-appropriate Application.
import { normalizeNodeId } from '../lib/node-id.js';

const ACTIONS = new Set(['node', 'screenshot']);
const FORMATS = new Set(['PNG', 'JPG', 'SVG', 'PDF']);
const MAX_PATH_CODE_UNITS = 4096;
const MAX_NODE_ID_CODE_UNITS = 512;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function requestError(message) {
  return new Error(`Invalid export compatibility command: ${message}.`);
}

function optionValue(args, index, token, names) {
  for (const name of names) {
    if (token === name) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value === '--' || value.startsWith('-')) {
        throw requestError(`${name} requires a value`);
      }
      return { value, consumed: 1 };
    }
    if (token.startsWith(`${name}=`)) {
      const value = token.slice(name.length + 1);
      if (!value) throw requestError(`${name} requires a value`);
      return { value, consumed: 0 };
    }
    if (name.length === 2 && token.startsWith(name) && token.length > 2) {
      const value = token.slice(2).replace(/^=/, '');
      if (!value) throw requestError(`${name} requires a value`);
      return { value, consumed: 0 };
    }
  }
  return null;
}

function parseLegacyRasterExport(args) {
  if (!Array.isArray(args) || args[0] !== 'export' || !ACTIONS.has(args[1])) {
    throw new Error('Expected an export node or export screenshot command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Export compatibility arguments must be strings.');
  }
  const action = args[1];
  let outputPath = null;
  let scale = 2;
  let format = 'PNG';
  let literal = false;
  const positionals = [];
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const candidates = [
        { key: 'output', names: ['-o', '--output'] },
        { key: 'scale', names: ['-s', '--scale'] },
        { key: 'format', names: ['-f', '--format'] },
      ];
      let matched = false;
      for (const candidate of candidates) {
        const parsed = optionValue(args, index, token, candidate.names);
        if (!parsed) continue;
        if (seen.has(candidate.key)) throw requestError(`${candidate.names.at(-1)} may appear only once`);
        seen.add(candidate.key);
        if (candidate.key === 'output') outputPath = parsed.value;
        if (candidate.key === 'scale') scale = Number(parsed.value);
        if (candidate.key === 'format') format = parsed.value.toUpperCase();
        index += parsed.consumed;
        matched = true;
        break;
      }
      if (!matched) throw requestError(`unknown option ${token}`);
      continue;
    }
    positionals.push(token);
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
    throw requestError('scale must be greater than 0 and at most 4');
  }
  if (!FORMATS.has(format)) throw requestError('format must be png, jpg, svg, or pdf');
  if (outputPath !== null && (outputPath.length < 1 || outputPath.length > MAX_PATH_CODE_UNITS)) {
    throw requestError(`output path must contain 1 to ${MAX_PATH_CODE_UNITS} code units`);
  }
  if (action === 'node' && positionals.length !== 1) {
    throw requestError(action === 'node' && positionals.length === 0
      ? 'export node requires one nodeId'
      : 'export node accepts exactly one nodeId');
  }
  if (action === 'screenshot' && positionals.length !== 0) {
    throw requestError('export screenshot does not accept a nodeId');
  }
  let nodeId = '';
  let fileKey = null;
  if (action === 'node') {
    const normalized = normalizeNodeId(positionals[0]);
    nodeId = normalized.id;
    fileKey = normalized.fileKey || null;
    if (!nodeId || nodeId.length > MAX_NODE_ID_CODE_UNITS || !NODE_ID_PATTERN.test(nodeId)) {
      throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
    }
  }
  const stem = action === 'node' ? 'node-export' : 'screenshot';
  return Object.freeze({
    action,
    nodeId,
    fileKey,
    scale,
    format,
    outputPath: outputPath || `${stem}.${format.toLowerCase()}`,
  });
}

export function parseLegacyRasterExportRequest(args) {
  const { fileKey: _fileKey, ...request } = parseLegacyRasterExport(args);
  return request;
}

export function legacyRasterExportFigmaUrlFileKeyFromArgv(args) {
  return parseLegacyRasterExport(args).fileKey;
}

export function acceptsLegacyRasterExportArgv(args) {
  try { parseLegacyRasterExportRequest(args); return true; } catch { return false; }
}

export function legacyRasterExportArgvFromRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Export compatibility request must be an object.');
  const action = String(request.action || '');
  if (!ACTIONS.has(action)) throw requestError('action must be node or screenshot');
  const args = ['export', action];
  if (action === 'node') args.push(String(request.nodeId || '').trim());
  if (request.outputPath) args.push('-o', String(request.outputPath));
  if (request.scale != null) args.push('-s', String(request.scale));
  if (request.format != null) args.push('-f', String(request.format));
  const parsed = parseLegacyRasterExport(args);
  const canonical = ['export', parsed.action];
  if (parsed.nodeId) canonical.push(parsed.nodeId);
  canonical.push('-o', parsed.outputPath);
  if (parsed.scale !== 2) canonical.push('-s', String(parsed.scale));
  if (parsed.format !== 'PNG') canonical.push('-f', parsed.format.toLowerCase());
  return canonical;
}

export function legacyRasterExportPlanningArgvFromRequest(request) {
  const args = legacyRasterExportArgvFromRequest(request);
  if (request?.action !== 'node') return args;
  const parsed = parseLegacyRasterExport([
    'export', 'node', String(request.nodeId || '').trim(),
    ...(request.outputPath ? ['-o', String(request.outputPath)] : []),
    ...(request.scale != null ? ['-s', String(request.scale)] : []),
    ...(request.format != null ? ['-f', String(request.format)] : []),
  ]);
  if (parsed.fileKey) args[2] = String(request.nodeId).trim();
  return args;
}

export function screenshotRequestFromLegacyRasterExport(request) {
  if (!request || request.format !== 'PNG') {
    throw requestError('only PNG delegates to the Screenshot Command Application');
  }
  return Object.freeze({
    nodeId: request.nodeId,
    scale: request.scale,
    maxDimension: 8000,
    measure: false,
    includeBase64: false,
    persistence: 'workspace',
    savePath: request.outputPath,
  });
}
