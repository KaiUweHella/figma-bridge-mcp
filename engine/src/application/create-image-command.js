import { createHash } from 'node:crypto';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { IMAGE_HARD_LIMIT } from '../lib/image-file.js';
import { materializeRemoteRenderImage } from '../lib/remote-render-assets.js';
import { rasterDimensions, rasterKind } from '../lib/raster-dimensions.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_CREATE_IMAGE_COORDINATE,
  MAX_CREATE_IMAGE_DIMENSION,
  MAX_CREATE_IMAGE_NAME_CODE_UNITS,
  createImageArgvFromRequest,
  parseCreateImageRequest,
} from './create-image-request.js';

export { createImageArgvFromRequest } from './create-image-request.js';

const APPLICATION_ID = 'create.image';
export const MAX_CREATE_IMAGE_CHILDREN = 50_000;
export const MAX_CREATE_IMAGE_RESULT_CODE_UNITS = 32_768;
const MAX_ID_CODE_UNITS = 1_024;
const MAX_SOURCE_CODE_UNITS = 2_048;
const MAX_ASSET_NAME_CODE_UNITS = 128;
const MAX_BASE64_CODE_UNITS = Math.ceil(IMAGE_HARD_LIMIT / 3) * 4 + 4;
const VERIFY_EPSILON = 0.01;
const PREPARED_IMAGE_PLANS = new WeakMap();

const js = (value) => JSON.stringify(value)
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function safeText(value, maximum, empty = true) {
  return text(value, maximum, empty)
    && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(value);
}

function safeRemoteSource(value) {
  if (!exact(value, ['kind', 'label']) || value.kind !== 'remote-http'
    || !safeText(value.label, MAX_SOURCE_CODE_UNITS, false)) return false;
  try {
    const url = new URL(value.label);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function validatedAsset(value) {
  if (!exact(value, ['kind', 'name', 'base64', 'width', 'height', 'sha256', 'source'])
    || value.kind !== 'embedded-raster'
    || !safeText(value.name, MAX_ASSET_NAME_CODE_UNITS, false)
    || !text(value.base64, MAX_BASE64_CODE_UNITS, false)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)
    || !Number.isInteger(value.width) || value.width < 1
    || !Number.isInteger(value.height) || value.height < 1
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !safeRemoteSource(value.source)) {
    throw new Error('Create Image materializer returned an invalid bounded raster asset.');
  }
  const bytes = Buffer.from(value.base64, 'base64');
  if (!bytes.length || bytes.length > IMAGE_HARD_LIMIT
    || bytes.toString('base64') !== value.base64) {
    throw new Error('Create Image materializer returned invalid bounded raster bytes.');
  }
  const kind = rasterKind(bytes);
  if (!kind) throw new Error('Create Image materializer returned unsupported raster bytes.');
  const dimensions = rasterDimensions(bytes, kind);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (dimensions.width !== value.width || dimensions.height !== value.height
    || digest !== value.sha256) {
    throw new Error('Create Image materializer returned inconsistent raster metadata.');
  }
  return Object.freeze({
    kind: value.kind,
    name: value.name,
    base64: value.base64,
    width: value.width,
    height: value.height,
    sha256: value.sha256,
    source: Object.freeze({ kind: value.source.kind, label: value.source.label }),
  });
}

function finalDimensions(request, asset) {
  let width = request.width;
  let height = request.height;
  if (width !== null && height === null) height = Math.round(asset.height * (width / asset.width));
  if (height !== null && width === null) width = Math.round(asset.width * (height / asset.height));
  if (width === null && height === null) ({ width, height } = asset);
  if (!Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0
    || width > MAX_CREATE_IMAGE_DIMENSION || height > MAX_CREATE_IMAGE_DIMENSION) {
    throw new Error('Create Image derived dimensions are outside the supported range.');
  }
  return Object.freeze({ width, height });
}

export function createImagePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Create Image routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-create-image';
}

/** Resolve and verify the remote raster before Plugin readiness or mutation. */
export async function prepareCreateImagePlan(plan, adapters = {}) {
  if (createImagePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Create Image.`);
  }
  const request = parseCreateImageRequest(plan.argv);
  const materialize = adapters.materializeRemoteImage
    || ((url) => materializeRemoteRenderImage(url, { remainingMs: adapters.remainingMs }));
  if (typeof materialize !== 'function') {
    throw new TypeError('Create Image requires a remote image materializer.');
  }
  const asset = validatedAsset(await materialize(request.url));
  const dimensions = finalDimensions(request, asset);
  const prepared = Object.freeze({
    request: Object.freeze({
      name: request.name,
      x: request.x,
      y: request.y,
      spacing: request.spacing,
    }),
    asset,
    width: dimensions.width,
    height: dimensions.height,
  });
  PREPARED_IMAGE_PLANS.set(prepared, plan);
  return prepared;
}

function authenticatedPrepared(prepared) {
  if (!prepared || !PREPARED_IMAGE_PLANS.has(prepared)) {
    throw new TypeError('Create Image requires an authenticated prepared request.');
  }
  return prepared;
}

export function createImageCode(prepared) {
  const input = authenticatedPrepared(prepared);
  return `(async () => {
    const input = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_CREATE_IMAGE_RESULT_CODE_UNITS}) {
        throw new Error('Create Image result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const ids = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.');
      if (parent.children.length > ${MAX_CREATE_IMAGE_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.');
      const values = parent.children.map((child) => child && child.id);
      if (values.some((id) => typeof id !== 'string') || new Set(values).size !== values.length) {
        throw new Error(label + ' returned invalid child membership.');
      }
      return values;
    };
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left)
      && Math.abs(left - right) <= ${VERIFY_EPSILON};
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let page;
    let beforePageIds;
    let beforeSelection;
    let beforeSelectionIds;
    let expectedX;
    try {
      page = figma.currentPage;
      if (!page || page.type !== 'PAGE' || typeof page.id !== 'string') {
        throw new Error('Create Image requires one current Figma Page.');
      }
      beforePageIds = ids(page, 'Current Page');
      beforeSelection = Array.isArray(page.selection) ? [...page.selection] : null;
      if (!beforeSelection || beforeSelection.length > ${MAX_CREATE_IMAGE_CHILDREN}
        || beforeSelection.some((node) => !node || typeof node.id !== 'string')) {
        throw new Error('Create Image requires a bounded current selection.');
      }
      beforeSelectionIds = beforeSelection.map((node) => node.id);
      expectedX = input.request.x;
      if (expectedX === null) {
        expectedX = 0;
        for (const child of page.children) {
          if (!Number.isFinite(child.x) || !Number.isFinite(child.width)) {
            throw new Error('Current Page contains a child without finite horizontal geometry.');
          }
          expectedX = Math.max(expectedX, child.x + child.width);
        }
        expectedX += input.request.spacing;
      }
      if (!Number.isFinite(expectedX) || Math.abs(expectedX) > ${MAX_CREATE_IMAGE_COORDINATE}) {
        throw new Error('Requested image position is outside the supported range.');
      }
    } catch (error) { return refusal(error); }

    let rect = null;
    let imageHash = null;
    let imageAttempted = false;
    let failure = 'Create Image fresh postcondition did not match the requested state.';
    try {
      try {
        rect = figma.createRectangle();
        if (!rect || typeof rect.id !== 'string' || typeof rect.remove !== 'function'
          || typeof rect.resize !== 'function') {
          throw new Error('Figma did not return a removable Rectangle.');
        }
        rect.name = input.request.name;
        rect.x = expectedX;
        rect.y = input.request.y;
        rect.resize(input.width, input.height);
        const bytes = figma.base64Decode(input.asset.base64);
        imageAttempted = true;
        const image = figma.createImage(bytes);
        if (!image || typeof image.hash !== 'string' || !image.hash.length) {
          throw new Error('Figma did not return a valid Image resource.');
        }
        imageHash = image.hash;
        rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash }];
      } catch (error) {
        failure = clean(error && error.message ? error.message : String(error), 1024);
      }

      if (rect && imageHash) {
        const fresh = await figma.getNodeByIdAsync(rect.id);
        const freshPage = await figma.getNodeByIdAsync(page.id);
        const afterPageIds = ids(freshPage, 'Fresh Current Page');
        const expectedPageIds = [...beforePageIds, rect.id];
        const fill = Array.isArray(fresh && fresh.fills) && fresh.fills.length === 1
          ? fresh.fills[0] : null;
        if (fresh && fresh.type === 'RECTANGLE' && fresh.name === input.request.name
          && fresh.parent && fresh.parent.id === page.id
          && same(afterPageIds, expectedPageIds)
          && close(fresh.x, expectedX) && close(fresh.y, input.request.y)
          && close(fresh.width, input.width) && close(fresh.height, input.height)
          && fill && fill.type === 'IMAGE' && fill.scaleMode === 'FILL'
          && fill.imageHash === imageHash) {
          const warnings = [];
          try {
            page.selection = [rect];
            figma.viewport.scrollAndZoomIntoView([rect]);
            const editorPage = await figma.getNodeByIdAsync(page.id);
            const selectedIds = Array.isArray(editorPage && editorPage.selection)
              ? editorPage.selection.map((node) => node && node.id) : [];
            if (!same(selectedIds, [rect.id])) warnings.push('Selection did not match the created image node.');
          } catch (error) {
            warnings.push(clean(error && error.message ? error.message : String(error), 1024));
          }
          delete globalThis.__invCache;
          return bounded({
            schemaVersion: 1, status: 'created',
            node: {
              id: clean(fresh.id, ${MAX_ID_CODE_UNITS}),
              name: clean(fresh.name, ${MAX_CREATE_IMAGE_NAME_CODE_UNITS}), type: 'RECTANGLE',
              parentId: clean(page.id, ${MAX_ID_CODE_UNITS}), index: beforePageIds.length,
              x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height,
            },
            source: input.asset.source,
            sha256: input.asset.sha256,
            attempted: 1, residue: [], warnings: warnings.slice(0, 1),
          });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }

    try {
      try { if (rect && typeof rect.remove === 'function') rect.remove(); } catch {}
      try { page.selection = beforeSelection; } catch {}
      const freshRect = rect && typeof rect.id === 'string'
        ? await figma.getNodeByIdAsync(rect.id) : null;
      const restoredPage = await figma.getNodeByIdAsync(page.id);
      const restoredPageIds = ids(restoredPage, 'Restored Current Page');
      const restoredSelectionIds = Array.isArray(restoredPage.selection)
        ? restoredPage.selection.map((node) => node && node.id) : [];
      const residue = [];
      if (imageHash) residue.push('image-resource');
      else if (imageAttempted) residue.push('unattributed-image-resource');
      const createdPresent = Boolean(freshRect)
        || Boolean(rect && typeof rect.id === 'string' && restoredPageIds.includes(rect.id));
      if (createdPresent) residue.push('created-node');
      if (!createdPresent && !same(restoredPageIds, beforePageIds)) residue.push('parent-membership');
      if (!same(restoredSelectionIds, beforeSelectionIds)) residue.push('selection');
      const restored = residue.length === 0;
      if (restored) delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1, status: 'failed',
        outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1,
        restored: restored ? 1 : 0, residue, failure,
      });
    } catch {
      const residue = [];
      if (imageHash) residue.push('image-resource');
      else if (imageAttempted) residue.push('unattributed-image-resource');
      if (rect && typeof rect.id === 'string') residue.push('unattributed-created-node');
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residue, failure,
      });
    }
  })()`;
}

function id(value) {
  return text(value, MAX_ID_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}

function coordinate(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_CREATE_IMAGE_COORDINATE;
}

function validNode(value, input) {
  return exact(value, ['id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'width', 'height'])
    && id(value.id) && value.name === input.request.name && value.type === 'RECTANGLE'
    && id(value.parentId) && Number.isSafeInteger(value.index) && value.index >= 0
    && coordinate(value.x) && coordinate(value.y)
    && coordinate(value.width) && value.width > 0
    && coordinate(value.height) && value.height > 0
    && (input.request.x === null || Math.abs(value.x - input.request.x) <= VERIFY_EPSILON)
    && Math.abs(value.y - input.request.y) <= VERIFY_EPSILON
    && Math.abs(value.width - input.width) <= VERIFY_EPSILON
    && Math.abs(value.height - input.height) <= VERIFY_EPSILON;
}

function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && safeText(value.failure, 1024, false);
}

function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'node', 'source', 'sha256', 'attempted', 'residue', 'warnings',
  ])
    && value.schemaVersion === 1 && value.status === 'created'
    && validNode(value.node, input)
    && exact(value.source, ['kind', 'label'])
    && value.source.kind === input.asset.source.kind
    && value.source.label === input.asset.source.label
    && value.sha256 === input.asset.sha256
    && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings) && value.warnings.length <= 1
    && value.warnings.every((warning) => safeText(warning, 1024, false));
}

function validFailure(value) {
  const allowedResidue = new Set([
    'image-resource', 'unattributed-image-resource', 'created-node', 'unattributed-created-node',
    'parent-membership', 'selection',
  ]);
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 4
    && value.residue.every((entry) => allowedResidue.has(entry))
    && new Set(value.residue).size === value.residue.length
    && safeText(value.failure, 1024, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0)
    && (value.outcome !== 'verification-unavailable' || value.restored === 0);
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
  return error;
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report,
  });
  return error;
}

export function formatCreateImageResult(result) {
  return `${JSON.stringify(result.node.name)} created (${result.node.id}) from `
    + `${result.source.label} at (${result.node.x}, ${result.node.y})`;
}

export async function executeCreateImage(prepared, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Create Image requires a Figma evaluate adapter.');
  }
  const input = authenticatedPrepared(prepared);
  const serialized = await adapters.evaluate(createImageCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_CREATE_IMAGE_RESULT_CODE_UNITS) {
    throw invalid('Create Image returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw invalid('Create Image returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Create Image returned an invalid bounded result.');
    throw mutationError(`Create Image made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Create Image returned an invalid bounded result.');
    throw mutationError(`Create Image failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw invalid('Create Image returned an invalid bounded result.');
  }
  return {
    stdout: formatCreateImageResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export async function executeCreateImagePlan(plan, prepared, adapters = {}) {
  if (createImagePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Create Image.`);
  }
  if (PREPARED_IMAGE_PLANS.get(prepared) !== plan) {
    throw new TypeError('Create Image prepared request does not belong to this Command Plan.');
  }
  return executeCreateImage(prepared, adapters);
}
