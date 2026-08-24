// Closed request Interface for the `verify` Figma Command.
import { normalizeNodeId } from '../lib/node-id.js';

export const MAX_SCREENSHOT_NODE_ID_CODE_UNITS = 512;
export const MAX_SCREENSHOT_PATH_CODE_UNITS = 4096;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function requestError(message) {
  return new Error(`Invalid verify command: ${message}.`);
}

function finite(value, label, fallback, max) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0 || candidate > max) {
    throw requestError(`${label} must be greater than 0 and at most ${max}`);
  }
  return candidate;
}

function parsedScreenshotRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'verify') throw new Error('Expected a verify command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Verify arguments must be strings.');
  const positionals = [];
  let scale = 0.5;
  let maxDimension = 2000;
  let measure = false;
  let includeBase64 = false;
  let savePath = null;
  let saveSeen = false;
  let literal = false;

  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && ['-s', '--scale', '--max'].includes(token)) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(`${token} requires a value`);
      }
      if (token === '--max') maxDimension = Math.max(1, Math.round(finite(value, 'max', 2000, 8000)));
      else scale = finite(value, 'scale', 0.5, 4);
      index++;
      continue;
    }
    if (!literal) {
      const combined = token.match(/^(-s|--scale|--max)=(.*)$/);
      if (combined) {
        if (!combined[2]) throw requestError(`${combined[1]} requires a value`);
        if (combined[1] === '--max') maxDimension = Math.max(1, Math.round(finite(combined[2], 'max', 2000, 8000)));
        else scale = finite(combined[2], 'scale', 0.5, 4);
        continue;
      }
      const saved = token.match(/^--save=(.*)$/);
      if (saved) {
        if (saveSeen) throw requestError('--save may appear only once');
        if (!saved[1] || saved[1].length > MAX_SCREENSHOT_PATH_CODE_UNITS) {
          throw requestError(`--save path must contain 1 to ${MAX_SCREENSHOT_PATH_CODE_UNITS} code units`);
        }
        saveSeen = true;
        savePath = saved[1];
        continue;
      }
      if (token === '--save') {
        if (saveSeen) throw requestError('--save may appear only once');
        saveSeen = true;
        const next = args[index + 1];
        if (typeof next === 'string' && next && !next.startsWith('-')) {
          if (next.length > MAX_SCREENSHOT_PATH_CODE_UNITS) {
            throw requestError(`--save path must be at most ${MAX_SCREENSHOT_PATH_CODE_UNITS} code units`);
          }
          savePath = next;
          index++;
        }
        continue;
      }
      if (token === '--base64') { includeBase64 = true; continue; }
      if (token === '--measure') { measure = true; continue; }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  if (includeBase64 && saveSeen) throw requestError('--base64 and --save are mutually exclusive');

  let nodeId = '';
  let fileKey = null;
  if (positionals.length) {
    const normalized = normalizeNodeId(positionals[0]);
    nodeId = normalized.id;
    fileKey = normalized.fileKey || null;
    if (!nodeId || nodeId.length > MAX_SCREENSHOT_NODE_ID_CODE_UNITS || !NODE_ID_PATTERN.test(nodeId)) {
      throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
    }
  }
  return {
    nodeId,
    fileKey,
    scale,
    maxDimension,
    measure,
    includeBase64,
    persistence: includeBase64 ? 'inline' : savePath ? 'workspace' : 'temporary',
    savePath,
  };
}

export function parseScreenshotRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedScreenshotRequest(args);
  return request;
}

export function screenshotFigmaUrlFileKeyFromArgv(args) {
  return parsedScreenshotRequest(args).fileKey;
}

export function acceptsScreenshotArgv(args) {
  try { parseScreenshotRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('Screenshot request must be an object.');
  for (const key of ['nodeId', 'savePath']) {
    if (request[key] != null && typeof request[key] !== 'string') throw requestError(`${key} must be a string`);
  }
  for (const key of ['measure', 'includeBase64']) {
    if (request[key] != null && typeof request[key] !== 'boolean') throw requestError(`${key} must be a boolean`);
  }
  const args = ['verify'];
  if (request.nodeId) args.push(request.nodeId.trim());
  if (request.scale != null) args.push('--scale', String(request.scale));
  if (request.maxDimension != null) args.push('--max', String(request.maxDimension));
  if (request.measure === true) args.push('--measure');
  if (request.includeBase64 === true) args.push('--base64');
  else if (request.savePath) args.push('--save', request.savePath);
  return parsedScreenshotRequest(args);
}

export function screenshotArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['verify'];
  if (input.nodeId) args.push(input.nodeId);
  if (input.scale !== 0.5) args.push('--scale', String(input.scale));
  if (input.maxDimension !== 2000) args.push('--max', String(input.maxDimension));
  if (input.measure) args.push('--measure');
  if (input.persistence === 'inline') args.push('--base64');
  else if (input.persistence === 'workspace') args.push('--save', input.savePath);
  return args;
}

export function screenshotPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = screenshotArgvFromRequest(input);
  if (input.fileKey) args[1] = String(request.nodeId).trim();
  return args;
}
