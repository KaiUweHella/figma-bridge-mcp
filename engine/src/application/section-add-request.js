// Closed request Interface for `section add`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_SECTION_ADD_NODES = 256;

function requestError(message) {
  return new Error(`Invalid Section Add command: ${message}.`);
}

function nodeReference(value, field) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError(`${field} must contain bounded Figma node ids or URLs with node-id`);
  }
}

function nodeList(value) {
  if (typeof value !== 'string') throw requestError('nodeIds must be a comma-separated string');
  const raw = value.split(',').map((item) => item.trim());
  if (raw.length === 0 || raw.some((item) => item.length === 0)) {
    throw requestError('nodeIds must not contain empty entries');
  }
  if (raw.length > MAX_SECTION_ADD_NODES) {
    throw requestError(`nodeIds may contain at most ${MAX_SECTION_ADD_NODES} entries`);
  }
  const references = raw.map((item) => nodeReference(item, 'nodeIds'));
  if (new Set(references.map((reference) => reference.nodeId)).size !== references.length) {
    throw requestError('nodeIds must be unique');
  }
  return references;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'section' || args[1] !== 'add') {
    throw new Error('Expected a section add command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Section Add arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('sectionId and nodeIds are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const section = nodeReference(positionals[0], 'sectionId');
  const nodes = nodeList(positionals[1]);
  if (nodes.some((node) => node.nodeId === section.nodeId)) {
    throw requestError('sectionId cannot also appear in nodeIds');
  }
  const fileKeys = new Set([section.fileKey, ...nodes.map((node) => node.fileKey)].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('section and nodes target multiple Figma files');
  return { section, nodes };
}

export function parseSectionAddRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    sectionId: input.section.nodeId,
    nodeIds: Object.freeze(input.nodes.map((node) => node.nodeId)),
    warning: [input.section, ...input.nodes].map((item) => item.warning).filter(Boolean).join('\n'),
  });
}

export function acceptsSectionAddArgv(args) {
  try { parseSectionAddRequest(args); return true; }
  catch { return false; }
}

export function sectionAddFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args);
  return input.section.fileKey || input.nodes.find((node) => node.fileKey)?.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Section Add request must be an object.');
  }
  const section = nodeReference(request.sectionId, 'sectionId');
  const values = Array.isArray(request.nodeIds) ? request.nodeIds : null;
  if (!values || values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw requestError('nodeIds must be a non-empty array of strings');
  }
  const nodes = nodeList(values.join(','));
  if (nodes.some((node) => node.nodeId === section.nodeId)) {
    throw requestError('sectionId cannot also appear in nodeIds');
  }
  const fileKeys = new Set([section.fileKey, ...nodes.map((node) => node.fileKey)].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('section and nodes target multiple Figma files');
  return { section, nodes };
}

function argvFromInput(input, planning) {
  return [
    'section', 'add',
    planning ? input.section.planningValue : input.section.nodeId,
    input.nodes.map((node) => planning ? node.planningValue : node.nodeId).join(','),
  ];
}

export function sectionAddArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSectionAddRequest(args);
  return args;
}

export function sectionAddPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSectionAddRequest(args);
  return args;
}
