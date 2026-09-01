// Closed request Interface for `export node-json`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_JSON_OUTPUT_PATH_CODE_UNITS = 4096;

function requestError(message) {
  return new Error(`Invalid export node-json command: ${message}.`);
}

function nodeValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw requestError('nodeId is required');
  }
  try {
    const reference = parseNodeReference(value);
    return {
      nodeId: reference.nodeId,
      fileKey: reference.fileKey,
      warning: reference.warning,
    };
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function outputOption(args, index, token) {
  for (const name of ['-o', '--output']) {
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
    if (name === '-o' && token.startsWith('-o') && token.length > 2) {
      const value = token.slice(2).replace(/^=/, '');
      if (!value) throw requestError('-o requires a value');
      return { value, consumed: 0 };
    }
  }
  return null;
}

function outputArgv(value) {
  if (!value) return [];
  return value.startsWith('-') ? [`--output=${value}`] : ['-o', value];
}

function parsedNodeJsonExportRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'export' || args[1] !== 'node-json') {
    throw new Error('Expected an export node-json command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node JSON Export arguments must be strings.');
  }
  let outputPath = null;
  let outputSeen = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) {
      const output = outputOption(args, index, token);
      if (!output) throw requestError(`unknown option ${token}`);
      if (outputSeen) throw requestError('--output may appear only once');
      outputSeen = true;
      outputPath = output.value;
      index += output.consumed;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  if (outputPath !== null
    && (outputPath.length < 1 || outputPath.length > MAX_NODE_JSON_OUTPUT_PATH_CODE_UNITS)) {
    throw requestError(`output path must contain 1 to ${MAX_NODE_JSON_OUTPUT_PATH_CODE_UNITS} code units`);
  }
  return { ...nodeValue(positionals[0]), outputPath };
}

export function parseNodeJsonExportRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedNodeJsonExportRequest(args);
  return request;
}

export function nodeJsonExportFigmaUrlFileKeyFromArgv(args) {
  return parsedNodeJsonExportRequest(args).fileKey;
}

export function acceptsNodeJsonExportArgv(args) {
  try {
    parseNodeJsonExportRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Node JSON Export request must be an object.');
  }
  if (typeof request.nodeId !== 'string') {
    throw requestError('nodeId must be a string');
  }
  if (request.outputPath != null
    && (typeof request.outputPath !== 'string' || !request.outputPath)) {
    throw requestError('outputPath must be a non-empty string');
  }
  return parsedNodeJsonExportRequest([
    'export', 'node-json', request.nodeId.trim(),
    ...outputArgv(request.outputPath),
  ]);
}

export function nodeJsonExportArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'export', 'node-json', input.nodeId,
    ...outputArgv(input.outputPath),
  ];
}

export function nodeJsonExportPlanningArgvFromRequest(request) {
  const canonical = nodeJsonExportArgvFromRequest(request);
  const reference = parseNodeReference(request.nodeId);
  if (reference.fileKey) canonical[2] = reference.planningValue;
  return canonical;
}
