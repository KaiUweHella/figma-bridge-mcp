// Runtime contracts for the authenticated execution and plugin-message seams.
//
// Cryptographic verification remains in daemon-auth/plugin-handshake. This
// module owns message shape, size and required-field validation before the
// daemon interprets any caller-controlled value.

import { assertSemanticRenderPlan } from './semantic-render-plan.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateExecPayload(value) {
  if (!isRecord(value)) return 'request body must be an object';
  if (!['eval', 'render-plan', 'render-plan-batch'].includes(value.action)) return 'action must be "eval", "render-plan", or "render-plan-batch"';
  if (value.action === 'eval') {
    if (typeof value.code !== 'string' || !value.code.length) return 'eval code must be a non-empty string';
    if (value.code.length > 5_000_000) return 'eval code exceeds the 5 MB protocol limit';
  }
  if (value.action === 'render-plan') {
    try { assertSemanticRenderPlan(value.plan, { executable: true }); }
    catch (error) { return `render plan is invalid: ${error.message}`; }
    let bytes;
    try { bytes = JSON.stringify(value.plan).length; }
    catch (error) { return `render plan is not serializable: ${error.message}`; }
    if (bytes > 5_000_000) return 'render plan exceeds the 5 MB protocol limit';
  }
  if (value.action === 'render-plan-batch') {
    if (!Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 100) {
      return 'render plan batch must contain 1-100 plans';
    }
    for (let index = 0; index < value.plans.length; index++) {
      try { assertSemanticRenderPlan(value.plans[index], { executable: true }); }
      catch (error) { return `render plan batch item ${index + 1} is invalid: ${error.message}`; }
    }
    if (value.options != null && !isRecord(value.options)) return 'render plan batch options must be an object';
    if (value.options?.gap != null && (!Number.isFinite(Number(value.options.gap)) || Number(value.options.gap) < 0 || Number(value.options.gap) > 10000)) {
      return 'render plan batch gap must be between 0 and 10000';
    }
    if (value.options?.vertical != null && typeof value.options.vertical !== 'boolean') return 'render plan batch vertical must be boolean';
    let bytes;
    try { bytes = JSON.stringify({ plans: value.plans, options: value.options || {} }).length; }
    catch (error) { return `render plan batch is not serializable: ${error.message}`; }
    if (bytes > 5_000_000) return 'render plan batch exceeds the 5 MB protocol limit';
  }
  if (value.fileKey != null && (typeof value.fileKey !== 'string' || value.fileKey.length > 64)) {
    return 'fileKey must be a string of at most 64 characters';
  }
  if (value.timeoutMs != null && (!Number.isFinite(Number(value.timeoutMs)) || Number(value.timeoutMs) <= 0)) {
    return 'timeoutMs must be a positive finite number';
  }
  return null;
}

export function validatePluginMessage(value, { authenticated = false } = {}) {
  if (!isRecord(value)) return 'plugin message must be an object';
  if (typeof value.type !== 'string') return 'plugin message type must be a string';
  if (!authenticated) {
    if (value.type !== 'hello') return 'expected hello before authentication';
    if (!Number.isInteger(value.proto)) return 'hello proto must be an integer';
    for (const field of ['nonce', 'version', 'proof']) {
      if (typeof value[field] !== 'string' || !value[field]) return `hello ${field} must be a non-empty string`;
    }
    return null;
  }
  switch (value.type) {
    case 'result':
      return Number.isInteger(value.id) ? null : 'result id must be an integer';
    case 'batch-result':
      if (!Number.isInteger(value.id)) return 'batch-result id must be an integer';
      return Array.isArray(value.results) ? null : 'batch-result results must be an array';
    case 'ping':
      return null;
    case 'rest-token':
      return typeof value.value === 'string' ? null : 'rest-token value must be a string';
    case 'selection':
      return isRecord(value.selection) ? null : 'selection payload must be an object';
    default:
      return `unknown authenticated plugin message type: ${value.type}`;
  }
}
