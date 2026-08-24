// Closed request Interface for `prototype inspect`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid prototype inspect command: ${message}.`);
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

function parsedPrototypeInspectionRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'prototype' || args[1] !== 'inspect') {
    throw new Error('Expected a prototype inspect command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Prototype Inspection arguments must be strings.');
  }

  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError('only one nodeId is accepted');
  return nodeValue(positionals[0]);
}

export function parsePrototypeInspectionRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedPrototypeInspectionRequest(args);
  return request;
}

export function prototypeInspectionFigmaUrlFileKeyFromArgv(args) {
  return parsedPrototypeInspectionRequest(args).fileKey;
}

export function acceptsPrototypeInspectionArgv(args) {
  try {
    parsePrototypeInspectionRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Prototype Inspection request must be an object.');
  }
  return nodeValue(request.nodeId);
}

export function prototypeInspectionArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['prototype', 'inspect', input.nodeId];
}

export function prototypeInspectionPlanningArgvFromRequest(request) {
  const canonical = prototypeInspectionArgvFromRequest(request);
  const reference = parseNodeReference(request.nodeId);
  if (reference.fileKey) canonical[2] = reference.planningValue;
  return canonical;
}
