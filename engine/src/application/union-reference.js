// Closed discriminator for Command fields that historically accepted a node
// id, native name or durable Bridge label in one string.
//
// Bare values remain a compatibility query and never contribute Figma Target
// Context. Only the explicit `node:` variant delegates to Node Reference and
// may retain a URL-derived file key during Command planning.

import { parseNodeReference } from './node-reference.js';

export const MAX_UNION_REFERENCE_CODE_UNITS = 4096;
export const UNION_REFERENCE_KINDS = Object.freeze(['node', 'name', 'label', 'query']);

const KIND_SET = new Set(UNION_REFERENCE_KINDS);
const PREFIX = /^(node|name|label|query):(.*)$/s;

export class UnionReferenceError extends Error {
  constructor(code) {
    super(`Invalid Union Reference (${code}).`);
    this.name = 'UnionReferenceError';
    this.code = code;
  }
}

function allowedKinds(value) {
  const input = value == null ? UNION_REFERENCE_KINDS : value;
  if (!Array.isArray(input) || input.length === 0
    || input.some((kind) => typeof kind !== 'string' || !KIND_SET.has(kind))) {
    throw new TypeError('Union Reference allowedKinds must contain known reference kinds.');
  }
  return new Set(input);
}

function boundedValue(value) {
  if (typeof value !== 'string') throw new UnionReferenceError('type');
  if (value.length === 0) throw new UnionReferenceError('empty');
  if (value.length > MAX_UNION_REFERENCE_CODE_UNITS) {
    throw new UnionReferenceError('too-long');
  }
  return value;
}

/**
 * Parse an explicit `node:`, `name:`, `label:` or `query:` reference.
 * Unprefixed input becomes the configured compatibility kind (`query` by
 * default) and therefore cannot silently become file identity.
 */
export function parseUnionReference(value, options = {}) {
  const source = boundedValue(value);
  const allowed = allowedKinds(options.allowedKinds);
  const match = PREFIX.exec(source);
  const kind = match ? match[1] : (options.legacyKind || 'query');
  const rawValue = match ? match[2] : source;

  if (!KIND_SET.has(kind) || !allowed.has(kind)) {
    throw new UnionReferenceError(`kind-${kind}`);
  }
  boundedValue(rawValue);

  if (kind === 'node') {
    const node = parseNodeReference(rawValue);
    return Object.freeze({
      kind,
      value: node.nodeId,
      nodeId: node.nodeId,
      fileKey: node.fileKey,
      warning: node.warning,
      planningValue: node.planningValue,
    });
  }

  return Object.freeze({
    kind,
    value: rawValue,
    nodeId: null,
    fileKey: null,
    warning: '',
    planningValue: rawValue,
  });
}

export function unionReferenceArgvValue(reference, options = {}) {
  const input = typeof reference === 'string'
    ? parseUnionReference(reference, options)
    : parseUnionReference(
      `${reference?.kind || ''}:${reference?.value ?? reference?.nodeId ?? ''}`,
      options,
    );
  return `${input.kind}:${input.value}`;
}

export function unionReferenceFigmaUrlFileKey(value, options = {}) {
  return parseUnionReference(value, options).fileKey;
}

export function unionReferenceExecutionValue(value, options = {}) {
  const input = typeof value === 'string' ? parseUnionReference(value, options) : value;
  if (!input || typeof input.kind !== 'string' || typeof input.value !== 'string') {
    throw new UnionReferenceError('execution-shape');
  }
  return Object.freeze({ kind: input.kind, value: input.value });
}
