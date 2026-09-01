// Plan-bound export of Figma's live JSON_REST_V1 node projection.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../lib/protocol-contract.js';
import {
  nodeJsonExportArgvFromRequest,
  nodeJsonExportPlanningArgvFromRequest,
  parseNodeJsonExportRequest,
} from './node-json-export-request.js';

export { nodeJsonExportArgvFromRequest, nodeJsonExportPlanningArgvFromRequest } from './node-json-export-request.js';

export const NODE_JSON_OUTPUT_ROLE = 'node-json-output';
export const MAX_NODE_JSON_PLUGIN_BYTES = MAX_PROTOCOL_VALUE_BYTES - (256 * 1024);
export const MAX_NODE_JSON_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_NODE_JSON_DEPTH = 64;
export const MAX_NODE_JSON_ENTRIES = 100_000;
const MAX_NODE_JSON_KEY_CODE_UNITS = 1024;
const MAX_NODE_JSON_NAME_CODE_UNITS = 1024;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const NODE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const BIDI_OR_SEPARATOR = /[\u2028-\u202e\u2066-\u2069]/g;
const APPLICATION_ID = 'export.node-json';

function exact(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string')
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && descriptors[key].enumerable
      && Object.hasOwn(descriptors[key], 'value'));
}

function normalizedRequest(request) {
  return parseNodeJsonExportRequest(nodeJsonExportArgvFromRequest(request));
}

function utf8ByteLengthCode() {
  return `(text, max) => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
      const unit = text.charCodeAt(index);
      if (unit < 0x80) bytes += 1;
      else if (unit < 0x800) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
      if (bytes > max) return bytes;
    }
    return bytes;
  }`;
}

export function nodeJsonExportCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)});
    if (!node) return { error: 'Node not found: ' + ${JSON.stringify(input.nodeId)} };
    if (typeof node.exportAsync !== 'function') {
      return { error: 'Node type ' + String(node.type || 'UNKNOWN').slice(0, 64) + ' cannot be exported.' };
    }
    if (node.type === 'PAGE' && typeof node.loadAsync === 'function') await node.loadAsync();
    const value = await node.exportAsync({ format: 'JSON_REST_V1' });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'Figma returned invalid JSON_REST_V1 node data.' };
    }
    let serialized;
    try { serialized = JSON.stringify({ nodeId: node.id, value }); }
    catch { return { error: 'Figma returned non-serializable JSON_REST_V1 node data.' }; }
    const utf8Bytes = ${utf8ByteLengthCode()};
    if (utf8Bytes(serialized, ${MAX_NODE_JSON_PLUGIN_BYTES}) > ${MAX_NODE_JSON_PLUGIN_BYTES}) {
      return { error: 'Figma JSON_REST_V1 node data exceeds the bounded Plugin result.' };
    }
    return { nodeId: node.id, value };
  })()`;
}

function validJsonGraph(root) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let entries = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || depth > MAX_NODE_JSON_DEPTH || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const keys = Object.keys(value);
      if (keys.length !== value.length
        || keys.some((key, index) => key !== String(index))) return false;
      entries += value.length;
      if (entries > MAX_NODE_JSON_ENTRIES) return false;
      for (let index = value.length - 1; index >= 0; index--) {
        stack.push({ value: value[index], depth: depth + 1 });
      }
      continue;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      if (typeof key !== 'string') return false;
      const descriptor = descriptors[key];
      if (key.length > MAX_NODE_JSON_KEY_CODE_UNITS
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) return false;
    }
    entries += keys.length;
    if (entries > MAX_NODE_JSON_ENTRIES) return false;
    for (const key of keys) {
      if (typeof key === 'string') {
        stack.push({ value: descriptors[key].value, depth: depth + 1 });
      }
    }
  }
  return true;
}

function validatedEnvelope(result, request) {
  if (exact(result, ['error'])) {
    if (typeof result.error !== 'string' || !result.error || result.error.length > 4096
      || UNSAFE_TEXT.test(result.error)) {
      throw new Error('Node JSON Export returned an invalid bounded Figma error.');
    }
    throw new Error(result.error);
  }
  if (!exact(result, ['nodeId', 'value'])
    || result.nodeId !== request.nodeId
    || !NODE_ID_PATTERN.test(result.nodeId)
    || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)
    || result.value.id !== request.nodeId
    || typeof result.value.type !== 'string' || !NODE_TYPE_PATTERN.test(result.value.type)
    || (result.value.name != null
      && (typeof result.value.name !== 'string'
        || result.value.name.length > MAX_NODE_JSON_NAME_CODE_UNITS))
    || !validJsonGraph(result.value)) {
    throw new Error('Node JSON Export returned invalid bounded node facts.');
  }
  let compact;
  try { compact = JSON.stringify(result); }
  catch { throw new Error('Node JSON Export returned non-serializable node facts.'); }
  if (Buffer.byteLength(compact, 'utf8') > MAX_NODE_JSON_PLUGIN_BYTES) {
    throw new Error('Node JSON Export returned node facts above its Plugin result budget.');
  }
  return result.value;
}

function serializedOutput(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`.replace(BIDI_OR_SEPARATOR, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (Buffer.byteLength(text, 'utf8') > MAX_NODE_JSON_OUTPUT_BYTES) {
    throw new Error('Node JSON Export formatted output exceeds its bounded output budget.');
  }
  return text;
}

export function nodeJsonExportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node JSON Export routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application'
    : 'not-node-json-export';
}

export async function executeNodeJsonExportPlan(plan, adapters = {}) {
  if (nodeJsonExportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Node JSON Export Command Application.`);
  }
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeNodeJsonExportPlan requires evaluate(code).');
  }
  const request = parseNodeJsonExportRequest(plan.argv);
  const outputs = plan.outputs.filter((output) => output.role === NODE_JSON_OUTPUT_ROLE);
  if (request.outputPath) {
    if (plan.outputs.length !== 1 || outputs.length !== 1 || outputs[0].path !== request.outputPath) {
      throw new Error('Node JSON Export output path is not owned by the Command Plan.');
    }
    if (!adapters.workspaceIO || typeof adapters.workspaceIO.write !== 'function') {
      throw new TypeError('executeNodeJsonExportPlan requires WorkspaceIO for persisted output.');
    }
  } else if (plan.outputs.length !== 0 || outputs.length !== 0) {
    throw new Error('Inline Node JSON Export must not declare Workspace outputs.');
  }
  const value = validatedEnvelope(await adapters.evaluate(nodeJsonExportCode(request)), request);
  const text = serializedOutput(value);
  const metadata = Object.freeze({
    nodeId: value.id,
    type: value.type,
    byteLength: Buffer.byteLength(text, 'utf8'),
    ...(request.outputPath ? { saved: request.outputPath } : {}),
  });
  if (request.outputPath) {
    await adapters.workspaceIO.write(request.outputPath, text, {
      role: NODE_JSON_OUTPUT_ROLE,
      createParents: true,
    });
    return {
      stdout: `✓ Native node JSON written to ${request.outputPath}`,
      stderr: request.warning ? `⚠ ${request.warning}` : '',
      result: metadata,
    };
  }
  return {
    stdout: text,
    stderr: request.warning ? `⚠ ${request.warning}` : '',
    result: metadata,
  };
}
