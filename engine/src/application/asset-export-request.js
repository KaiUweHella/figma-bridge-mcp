// Closed request Interface for `export assets`.
//
// Commander and MCP share this parser so positional arity, option names,
// defaults and numeric limits are decided before planning, audit or dispatch.

import { normalizeNodeId } from '../lib/node-id.js';

export const DEFAULT_ASSET_EXPORT_MAX = 100;
export const DEFAULT_ASSET_RASTER_SCALE = 2;

const VALUE_OPTIONS = Object.freeze({
  '-o': 'outputDir',
  '--output': 'outputDir',
  '--max': 'max',
  '--raster-scale': 'rasterScale',
});

function commandError(message) {
  return new Error(`Invalid export assets command: ${message}.`);
}

function optionValue(args, index, flag, combinedValue) {
  const value = combinedValue === undefined ? args[index + 1] : combinedValue;
  if (typeof value !== 'string' || value.length === 0
    || ((flag === '-o' || flag === '--output') && value.startsWith('-'))) {
    throw commandError(`${flag} requires a value`);
  }
  return value;
}

function positiveSafeInteger(value, flag) {
  if (!/^\d+$/.test(String(value))) {
    throw commandError(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw commandError(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function rasterScaleValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 4) {
    throw commandError('--raster-scale must be a number between 0 and 4');
  }
  return parsed;
}

/** Parse one already-tokenized Asset Export argv without global state. */
export function parseAssetExportRequest(args, { requireOutput = true } = {}) {
  if (!Array.isArray(args) || args[0] !== 'export' || args[1] !== 'assets') {
    throw new Error('Expected an export assets command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new Error('Asset Export arguments must be strings.');
  }

  const positionals = [];
  const values = {};
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const property = VALUE_OPTIONS[flag];
    if (!property) throw commandError(`unknown option ${flag}`);
    if (seen.has(property)) throw commandError(`duplicate option ${flag}`);
    seen.add(property);
    values[property] = optionValue(
      args,
      index,
      flag,
      equals === -1 ? undefined : token.slice(equals + 1),
    );
    if (equals === -1) index++;
  }

  if (positionals.length === 0) throw commandError('missing required argument nodeId');
  if (positionals.length > 1) throw commandError(`unexpected argument ${positionals[1]}`);
  if (!positionals[0]) throw commandError('nodeId must not be empty');
  if (requireOutput && !values.outputDir) throw new Error('Asset Export output directory is required.');

  return {
    // Job identity follows the semantic node, not the spelling an Adapter
    // happened to receive (12:34, 12-34 or a Figma node URL).
    nodeId: normalizeNodeId(positionals[0]).id,
    outputDir: values.outputDir,
    max: values.max === undefined
      ? DEFAULT_ASSET_EXPORT_MAX
      : positiveSafeInteger(values.max, '--max'),
    rasterScale: values.rasterScale === undefined
      ? DEFAULT_ASSET_RASTER_SCALE
      : rasterScaleValue(values.rasterScale),
  };
}

export function acceptsAssetExportArgv(args) {
  try {
    parseAssetExportRequest(args, { requireOutput: false });
    return true;
  } catch {
    return false;
  }
}

/** Convert one typed Adapter request into canonical Command Plan argv. */
export function assetExportArgvFromRequest(request) {
  const args = ['export', 'assets'];
  if (request?.nodeId !== undefined) args.push(normalizeNodeId(request.nodeId).id);
  if (request?.outputDir !== undefined && request.outputDir !== null && String(request.outputDir) !== '') {
    args.push('-o', String(request.outputDir));
  }
  if (request?.max !== undefined && Number(request.max) !== DEFAULT_ASSET_EXPORT_MAX) {
    args.push('--max', String(request.max));
  }
  if (request?.rasterScale !== undefined
    && Number(request.rasterScale) !== DEFAULT_ASSET_RASTER_SCALE) {
    args.push('--raster-scale', String(request.rasterScale));
  }
  parseAssetExportRequest(args, { requireOutput: request?.outputDir !== undefined });
  return args;
}

/**
 * Planning input keeps a Figma URL long enough for Figma Target Context
 * resolution. The Capability Catalog canonicalizes the resulting plan.argv.
 */
export function assetExportPlanningArgvFromRequest(request) {
  const args = assetExportArgvFromRequest(request);
  const normalized = normalizeNodeId(request?.nodeId);
  if (normalized.fileKey && args.length > 2) args[2] = String(request.nodeId);
  return args;
}
