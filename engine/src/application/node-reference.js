// Closed Node Reference primitive shared by migrated Figma Commands.
//
// Command request Modules retain their own arity, options and error prose.
// This Module owns only the common accepted identity forms and the separation
// between canonical Plugin argv and a URL-bearing planning value.

import { normalizeNodeId } from '../lib/node-id.js';

export const MAX_NODE_REFERENCE_CODE_UNITS = 512;
export const NODE_REFERENCE_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

export class NodeReferenceError extends Error {
  constructor(code) {
    super(`Invalid Node Reference (${code}).`);
    this.name = 'NodeReferenceError';
    this.code = code;
  }
}
/**
 * Parse one required Node Reference without consulting argv or target state.
 *
 * `nodeId` is always canonical and safe for Plugin dispatch. `planningValue`
 * retains a Figma URL only when it carries semantic file-target identity.
 */
export function parseNodeReference(value) {
  if (typeof value !== 'string') throw new NodeReferenceError('type');
  const source = value.trim();
  if (!source) throw new NodeReferenceError('empty');

  const normalized = normalizeNodeId(source);
  if (normalized.id.length > MAX_NODE_REFERENCE_CODE_UNITS) {
    throw new NodeReferenceError('too-long');
  }
  if (!NODE_REFERENCE_PATTERN.test(normalized.id)) {
    throw new NodeReferenceError('invalid');
  }

  return Object.freeze({
    nodeId: normalized.id,
    fileKey: normalized.fileKey || null,
    warning: normalized.warning || '',
    planningValue: normalized.fileKey ? source : normalized.id,
  });
}
