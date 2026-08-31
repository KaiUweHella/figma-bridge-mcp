// Closed request Interface for `section create`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_SECTION_CREATE_NAME_CODE_UNITS = 1_024;
export const MAX_SECTION_CREATE_NODES = 256;

function requestError(message) {
  return new Error(`Invalid Section Create command: ${message}.`);
}

function nameValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError('name is required');
  }
  if (value.length > MAX_SECTION_CREATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_SECTION_CREATE_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeIds must contain bounded Figma node ids or URLs with node-id');
  }
}

function nodeList(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') throw requestError('nodeIds must be a comma-separated string');
  const raw = value.split(',').map((item) => item.trim());
  if (raw.some((item) => item.length === 0)) {
    throw requestError('nodeIds must not contain empty entries');
  }
  if (raw.length > MAX_SECTION_CREATE_NODES) {
    throw requestError(`nodeIds may contain at most ${MAX_SECTION_CREATE_NODES} entries`);
  }
  const references = raw.map(nodeReference);
  if (new Set(references.map((reference) => reference.nodeId)).size !== references.length) {
    throw requestError('nodeIds must be unique');
  }
  return references;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'section' || args[1] !== 'create') {
    throw new Error('Expected a section create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Section Create arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('name is required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const name = nameValue(positionals[0]);
  const nodes = nodeList(positionals[1]);
  const fileKeys = new Set(nodes.map((node) => node.fileKey).filter(Boolean));
  if (fileKeys.size > 1) throw requestError('nodes target multiple Figma files');
  return { name, nodes };
}

export function parseSectionCreateRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    name: input.name,
    nodeIds: Object.freeze(input.nodes.map((node) => node.nodeId)),
    warning: input.nodes.map((node) => node.warning).filter(Boolean).join('\n'),
  });
}

export function acceptsSectionCreateArgv(args) {
  try { parseSectionCreateRequest(args); return true; }
  catch { return false; }
}

export function sectionCreateFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).nodes.find((node) => node.fileKey)?.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Section Create request must be an object.');
  }
  const name = nameValue(request.name);
  const values = request.nodeIds === undefined || request.nodeIds === null ? [] : request.nodeIds;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw requestError('nodeIds must be an array of strings');
  }
  const nodes = values.length === 0 ? [] : nodeList(values.join(','));
  const fileKeys = new Set(nodes.map((node) => node.fileKey).filter(Boolean));
  if (fileKeys.size > 1) throw requestError('nodes target multiple Figma files');
  return { name, nodes };
}

function argvFromInput(input, planning) {
  const args = ['section', 'create'];
  if (input.name.startsWith('-')) args.push('--');
  args.push(input.name);
  if (input.nodes.length > 0) {
    args.push(input.nodes.map((node) => planning
      ? node.planningValue : node.nodeId).join(','));
  }
  return args;
}

export function sectionCreateArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSectionCreateRequest(args);
  return args;
}

export function sectionCreatePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSectionCreateRequest(args);
  return args;
}
