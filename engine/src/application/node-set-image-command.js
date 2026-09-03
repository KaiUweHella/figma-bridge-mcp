import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { IMAGE_HARD_LIMIT, IMAGE_WARN_LIMIT, inboundImageCeilingGuidance } from '../lib/image-file.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_SET_IMAGE_PATH_CODE_UNITS,
  nodeSetImageArgvFromRequest,
  nodeSetImagePlanningArgvFromRequest,
  parseNodeSetImageRequest,
} from './node-set-image-request.js';

export { nodeSetImageArgvFromRequest, nodeSetImagePlanningArgvFromRequest } from './node-set-image-request.js';

const APPLICATION_ID = 'node.set-image';
export const MAX_NODE_SET_IMAGE_PAINTS = 10_000;
export const MAX_NODE_SET_IMAGE_ANNOTATIONS = 10_000;
export const MAX_NODE_SET_IMAGE_SNAPSHOT_CODE_UNITS = 262_144;
export const MAX_NODE_SET_IMAGE_RESULT_CODE_UNITS = 65_536;
const MAX_ID = 1_024;
const PREPARED = new WeakSet();

function js(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function nodeSetImagePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Set Image routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-set-image';
}

export function prepareNodeSetImagePlan(plan, adapters = {}) {
  if (nodeSetImagePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Set Image.`);
  }
  if (!adapters.workspaceIO) {
    throw new TypeError('Node Set Image requires an authorized WorkspaceIO capability.');
  }
  const request = parseNodeSetImageRequest(plan.argv);
  const accepted = adapters.workspaceIO.authorizePath(request.file, {
    access: 'read', role: 'node-image', kind: 'file',
  });
  if (accepted.metadata.size > IMAGE_HARD_LIMIT) {
    throw new Error(
      `Workspace node-image rejected: file is ${accepted.metadata.size} bytes, over the `
      + `${IMAGE_HARD_LIMIT} byte ceiling. ${inboundImageCeilingGuidance()}`,
    );
  }
  const bytes = adapters.workspaceIO.read(accepted.canonical, {
    role: 'node-image', maxBytes: IMAGE_HARD_LIMIT,
  });
  const prepared = Object.freeze({
    request,
    sourceBytes: bytes.length,
    sourceBase64: bytes.toString('base64'),
  });
  PREPARED.add(prepared);
  return prepared;
}

export function nodeSetImageCode(prepared) {
  if (!PREPARED.has(prepared)) throw new TypeError('Node Set Image requires authentic prepared input.');
  const { request, sourceBase64 } = prepared;
  return `(async () => {
    const nodeId = ${js(request.nodeId)}; const scaleMode = ${js(request.scale)}; const source = ${js(sourceBase64)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_NODE_SET_IMAGE_RESULT_CODE_UNITS}) throw new Error('Node Set Image result exceeded its bounded response limit.'); return value; };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const close = (left, right) => typeof left === 'number' && Math.abs(left - right) <= 1e-6;
    const defaultPresentation = (paint) => (paint.opacity === undefined || close(paint.opacity, 1)) && (paint.visible === undefined || paint.visible === true) && (paint.blendMode === undefined || paint.blendMode === 'NORMAL');
    let node, beforeFills, beforeFillsJson, beforeAnnotations = null, beforeAnnotationsJson = null, annotationsPresent = false;
    try {
      node = await figma.getNodeByIdAsync(nodeId);
      if (!node || node.id !== nodeId || node.type === 'DOCUMENT' || node.type === 'PAGE' || typeof node.name !== 'string' || !('fills' in node)) throw new Error('Node Set Image requires one exact fill-capable canvas Node.');
      beforeFills = node.fills;
      if (!Array.isArray(beforeFills) || beforeFills.length > ${MAX_NODE_SET_IMAGE_PAINTS}) throw new Error('Node Set Image requires one bounded non-mixed Paint list.');
      beforeFillsJson = JSON.stringify(beforeFills);
      if (typeof beforeFillsJson !== 'string' || beforeFillsJson.length > ${MAX_NODE_SET_IMAGE_SNAPSHOT_CODE_UNITS}) throw new Error('Node Set Image fill rollback snapshot exceeds its bounded limit.');
      if ('annotations' in node && Array.isArray(node.annotations)) {
        annotationsPresent = node.annotations.length > 0;
        if (node.annotations.length <= ${MAX_NODE_SET_IMAGE_ANNOTATIONS}) {
          const candidateJson = JSON.stringify(node.annotations);
          if (typeof candidateJson === 'string' && candidateJson.length <= ${MAX_NODE_SET_IMAGE_SNAPSHOT_CODE_UNITS}) { beforeAnnotations = node.annotations; beforeAnnotationsJson = candidateJson; }
        }
      }
    } catch (error) { return refusal(error); }
    let bytes;
    try { bytes = figma.base64Decode(source); }
    catch (error) { return refusal(error); }
    let image = null; let failure = 'Node Set Image fresh postcondition did not match the requested Image Paint.';
    try {
      image = figma.createImage(bytes);
      if (!image || typeof image.hash !== 'string' || !image.hash.length || image.hash.length > ${MAX_ID}) throw new Error('Figma returned an invalid bounded Image identity.');
      try { node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode }]; }
      catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      if (beforeAnnotations && beforeAnnotations.length) {
        try { node.annotations = []; } catch {}
      }
      const fresh = await figma.getNodeByIdAsync(nodeId);
      const paint = fresh && Array.isArray(fresh.fills) && fresh.fills.length === 1 ? fresh.fills[0] : null;
      const fillMatches = fresh && fresh.id === nodeId && typeof fresh.name === 'string' && typeof fresh.type === 'string'
        && paint && paint.type === 'IMAGE' && paint.imageHash === image.hash && paint.scaleMode === scaleMode && defaultPresentation(paint);
      const annotations = annotationsPresent
        ? fresh && Array.isArray(fresh.annotations) && fresh.annotations.length === 0 ? 'cleared' : 'retained'
        : 'unchanged';
      if (fillMatches) {
        delete globalThis.__invCache;
        return bounded({ schemaVersion: 1, status: 'applied', node: { id: fresh.id, name: clean(fresh.name, 512), type: fresh.type }, image: { hash: image.hash, scaleMode }, annotations, attempted: 1, residue: [] });
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
    if (!image || typeof image.hash !== 'string' || !image.hash.length || image.hash.length > ${MAX_ID}) {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure,
        node: { id: node.id, name: clean(node.name, 512), type: node.type }, imageHash: null, scaleMode, residue: ['image-resource'] });
    }
    try {
      try { node.fills = beforeFills; } catch {}
      if (beforeAnnotations) { try { node.annotations = beforeAnnotations; } catch {} }
      const fresh = await figma.getNodeByIdAsync(nodeId);
      const fillsRestored = Boolean(fresh && JSON.stringify(fresh.fills) === beforeFillsJson);
      const annotationsRestored = beforeAnnotationsJson === null || Boolean(fresh && JSON.stringify(fresh.annotations) === beforeAnnotationsJson);
      const residue = ['image-resource', ...(!fillsRestored ? ['fills'] : []), ...(!annotationsRestored ? ['annotations'] : [])];
      if (fillsRestored && annotationsRestored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'partial-residue', attempted: 1, restored: Number(fillsRestored) + Number(annotationsRestored), failure,
        node: { id: node.id, name: clean(node.name, 512), type: node.type }, imageHash: image.hash, scaleMode, residue });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure,
        node: { id: node.id, name: clean(node.name, 512), type: node.type }, imageHash: image.hash, scaleMode, residue: ['image-resource'] });
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function text(value, max, empty = true) {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0);
}
function validNode(value, request) {
  return exact(value, ['id', 'name', 'type']) && value.id === request.nodeId
    && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name, 512) && text(value.type, 64, false);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && text(value.failure, 1024, false);
}
function validSuccess(value, request) {
  return exact(value, ['schemaVersion', 'status', 'node', 'image', 'annotations', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'applied' && validNode(value.node, request)
    && exact(value.image, ['hash', 'scaleMode']) && text(value.image.hash, MAX_ID, false)
    && value.image.scaleMode === request.scale && ['cleared', 'retained', 'unchanged'].includes(value.annotations)
    && value.attempted === 1 && Array.isArray(value.residue) && value.residue.length === 0;
}
function validFailure(value, request) {
  const allowedResidue = new Set(['image-resource', 'fills', 'annotations']);
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'node', 'imageHash', 'scaleMode', 'residue'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && Number.isInteger(value.restored) && value.restored >= 0 && value.restored <= 2
    && text(value.failure, 1024, false) && validNode(value.node, request)
    && (value.imageHash === null || text(value.imageHash, MAX_ID, false)) && value.scaleMode === request.scale
    && Array.isArray(value.residue) && value.residue.length >= 1 && value.residue.length <= 3
    && value.residue[0] === 'image-resource' && new Set(value.residue).size === value.residue.length
    && value.residue.every((entry) => allowedResidue.has(entry));
}
function mutationError(message, outcome, residueCount, restored = 0) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome,
    mutationReport: { version: 1, outcome, attempted: outcome === 'no-mutation' ? 0 : 1, restored, residueCount },
  });
  return error;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
  return error;
}

export function formatNodeSetImageResult(result, prepared) {
  const warning = prepared.sourceBytes > IMAGE_WARN_LIMIT
    ? `Large image: ${(prepared.sourceBytes / 1_048_576).toFixed(1)} MB.\n`
    : '';
  return `${warning}Image set on ${JSON.stringify(result.node.name)} (${result.node.id}) from ${prepared.request.file}`;
}

export async function executePreparedNodeSetImage(prepared, adapters = {}) {
  if (!PREPARED.has(prepared)) throw new TypeError('Node Set Image requires authentic prepared input.');
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Set Image requires a Figma evaluate adapter.');
  const serialized = await adapters.evaluate(nodeSetImageCode(prepared));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_SET_IMAGE_RESULT_CODE_UNITS) {
    throw invalid('Node Set Image returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Node Set Image returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Node Set Image returned an invalid bounded result.');
    throw mutationError(`Node Set Image made no mutation: ${payload.failure}`, 'no-mutation', 0);
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, prepared.request)) throw invalid('Node Set Image returned an invalid bounded result.');
    throw mutationError(`Node Set Image failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, payload.residue.length, payload.restored);
  }
  if (!validSuccess(payload, prepared.request)) {
    throw invalid('Node Set Image returned an invalid bounded result.');
  }
  return { stdout: formatNodeSetImageResult(payload, prepared), stderr: '', result: payload };
}
