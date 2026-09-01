// Workspace-prepared, conditionally mutating `gradient extract` Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  buildCssString,
  buildFigmaPaint,
  extractGradient,
  extractMesh,
} from '../gradient-extractor.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gradientExtractArgvFromRequest,
  gradientExtractPlanningArgvFromRequest,
  parseGradientExtractRequest,
} from './gradient-extract-request.js';

export { gradientExtractArgvFromRequest, gradientExtractPlanningArgvFromRequest } from './gradient-extract-request.js';

const APPLICATION_ID = 'gradient.extract';
const PREPARED = new WeakSet();
const MAX_RESULT = 65_536;
const MAX_SNAPSHOT = 262_144;
const MAX_PAINTS = 10_000;
const MAX_CHILDREN = 10_000;
const MAX_BLOBS = 64;
const MAX_NAME = 4_096;
const MAX_METRIC = 10_000_000;
const HEX = /^#[0-9A-F]{6}$/;
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function freezeGraph(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeGraph(child);
  return Object.freeze(value);
}
function finite(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Gradient Extract produced an invalid bounded ${label}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}
function box(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'bottom,left,right,top') {
    throw new Error(`Gradient Extract produced an invalid ${label}.`);
  }
  const projected = Object.fromEntries(['left','top','right','bottom']
    .map((key) => [key, finite(value[key], 0, MAX_METRIC, `${label} ${key}`)]));
  if (projected.right < projected.left || projected.bottom < projected.top) {
    throw new Error(`Gradient Extract produced an invalid ${label}.`);
  }
  return projected;
}
function imageSize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'height,width') {
    throw new Error('Gradient Extract produced an invalid image size.');
  }
  return {
    width: finite(value.width, 1, MAX_METRIC, 'image width'),
    height: finite(value.height, 1, MAX_METRIC, 'image height'),
  };
}
function linearResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['vertical','horizontal'].includes(value.direction)
    || !Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 5) {
    throw new Error('Gradient Extract produced an invalid bounded linear recipe.');
  }
  const stops = value.stops.map((stop) => {
    if (!stop || typeof stop !== 'object' || Array.isArray(stop)
      || !Array.isArray(stop.rgb) || stop.rgb.length !== 3) {
      throw new Error('Gradient Extract produced an invalid color stop.');
    }
    return {
      position: finite(stop.position, 0, 1, 'stop position'),
      rgb: stop.rgb.map((channel) => finite(channel, 0, 255, 'RGB channel')),
    };
  });
  return freezeGraph({
    direction: value.direction,
    angle: finite(value.angle, -360_000, 360_000, 'gradient angle'),
    box: box(value.box, 'inner box'), imageSize: imageSize(value.imageSize), stops,
  });
}
function meshResult(value, blur) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.base !== 'string' || !HEX.test(value.base)
    || !Array.isArray(value.blobs) || !value.blobs.length || value.blobs.length > MAX_BLOBS) {
    throw new Error('Gradient Extract produced an invalid bounded mesh recipe.');
  }
  const blobs = value.blobs.map((blob) => {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)
      || typeof blob.color !== 'string' || !HEX.test(blob.color)) {
      throw new Error('Gradient Extract produced an invalid mesh blob.');
    }
    return {
      fx: finite(blob.fx, -10, 10, 'blob x'), fy: finite(blob.fy, -10, 10, 'blob y'),
      r: finite(blob.r, 0.001, 10, 'blob radius'), color: blob.color,
      ...(blob.blurMul === undefined ? {} : { blurMul: finite(blob.blurMul, 0, 10, 'blob blur multiplier') }),
    };
  });
  return freezeGraph({
    mode: 'mesh', base: value.base, blobs,
    blurFraction: blur ?? finite(value.blurFraction, 0.05, 0.8, 'blur fraction'),
    imageSize: imageSize(value.imageSize), box: box(value.box, 'inner box'),
  });
}
function prepared(value) { PREPARED.add(value); return Object.freeze(value); }

export function gradientExtractPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Gradient Extract routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-gradient-extract';
}

export function prepareGradientExtractPlan(plan, {
  workspaceIO,
  extractLinear = extractGradient,
  extractMeshRecipe = extractMesh,
} = {}) {
  if (gradientExtractPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Gradient Extract.`);
  }
  if (!workspaceIO || typeof workspaceIO.read !== 'function') {
    throw new TypeError('Gradient Extract requires an authorized WorkspaceIO capability.');
  }
  const request = parseGradientExtractRequest(plan.argv);
  const result = request.mode === 'linear'
    ? linearResult(extractLinear(request.image, {
      direction: request.direction, stops: request.stops, trim: request.trim,
    }, { workspaceIO }))
    : meshResult(extractMeshRecipe(request.image, { trim: request.trim }, { workspaceIO }), request.blur);
  return prepared({ request, result });
}

export function gradientExtractRequiresFigma(value) {
  if (!PREPARED.has(value)) throw new TypeError('Gradient Extract requires authentic prepared input.');
  return value.request.selector !== null;
}

export function gradientExtractMutationCode(value) {
  if (!PREPARED.has(value) || !gradientExtractRequiresFigma(value)) {
    throw new TypeError('Gradient Extract mutation requires authentic prepared target input.');
  }
  const { request, result } = value;
  const expectedPaint = request.mode === 'linear' ? buildFigmaPaint(result) : null;
  return `(async () => {
    const request = ${js({ selector: request.selector, mode: request.mode })};
    const recipe = ${js(request.mode === 'linear' ? { paint: expectedPaint } : result)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_RESULT}) throw new Error('Gradient Extract result exceeded its bounded response limit.'); return value; };
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const close = (left, right) => typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) <= 1e-5;
    const same = (left, right) => {
      if (typeof left === 'number' || typeof right === 'number') return close(left, right);
      if (left === right) return true;
      if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
      if (!record(left) || !record(right)) return false;
      const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
      return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]));
    };
    const nodeFact = (node) => ({ id: node.id, name: clean(node.name, ${MAX_NAME}), type: node.type });
    const resolve = async () => request.selector.kind === 'selection'
      ? figma.currentPage.selection[0] || null : await figma.getNodeByIdAsync(request.selector.nodeId);
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', mode: request.mode, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const applied = (node, outcome, details, warning) => bounded({ schemaVersion: 1, status: 'applied', mode: request.mode, outcome, attempted: outcome === 'no-op' ? 0 : 1,
      node: nodeFact(node), details, residue: [], warnings: warning ? ['A native Gradient Extract mutation reported an error, but fresh readback proved the complete requested state.'] : [] });
    const failed = (node, outcome, restored, failure, residue) => bounded({ schemaVersion: 1, status: 'failed', mode: request.mode, outcome, attempted: 1, restored,
      failure: clean(failure, 1024), node: nodeFact(node), residue });
    let node;
    try {
      node = await resolve();
      if (!node || typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.type !== 'string'
        || node.type.length > 64) throw new Error('Gradient Extract could not resolve one exact canvas target.');
      if (request.selector.kind === 'node' && node.id !== request.selector.nodeId) throw new Error('Gradient Extract target identity changed.');
    } catch (error) { return refusal(error); }

    if (request.mode === 'linear') {
      let before, beforeJson;
      const gradientMatches = (paint) => record(paint)
        && Object.keys(paint).every((key) => ['type','gradientStops','gradientTransform','opacity','visible','blendMode'].includes(key))
        && paint.type === recipe.paint.type && same(paint.gradientStops, recipe.paint.gradientStops)
        && same(paint.gradientTransform, recipe.paint.gradientTransform)
        && (paint.opacity === undefined || close(paint.opacity, 1))
        && (paint.visible === undefined || paint.visible === true)
        && (paint.blendMode === undefined || paint.blendMode === 'NORMAL');
      const matches = (target) => Array.isArray(target.fills) && target.fills.length === 1 && gradientMatches(target.fills[0]);
      try {
        if (!('fills' in node) || !Array.isArray(node.fills) || node.fills.length > ${MAX_PAINTS}) throw new Error('Linear Gradient Extract requires a bounded non-mixed Paint list.');
        beforeJson = JSON.stringify(node.fills);
        if (typeof beforeJson !== 'string' || beforeJson.length > ${MAX_SNAPSHOT}) throw new Error('Linear Gradient Extract rollback snapshot exceeds its bounded limit.');
        before = JSON.parse(beforeJson);
        if (matches(node)) return applied(node, 'no-op', { field: 'fill' }, false);
      } catch (error) { return refusal(error); }
      let mutationError = null;
      try { node.fills = [recipe.paint]; } catch (error) { mutationError = error; }
      try {
        const fresh = await resolve();
        if (fresh && fresh.id === node.id && matches(fresh)) {
          delete globalThis.__invCache;
          return applied(fresh, mutationError ? 'verified-after-error' : 'verified', { field: 'fill' }, mutationError);
        }
        if (fresh && fresh.id === node.id && same(fresh.fills, before)) return failed(fresh, 'unchanged', 0, mutationError && mutationError.message ? mutationError.message : 'Linear Gradient Extract had no effect.', ['gradient-state']);
      } catch (error) { mutationError ||= error; }
      try {
        node.fills = before;
        const fresh = await resolve();
        if (!fresh) throw new Error('Linear Gradient Extract rollback target is unavailable.');
        const restored = fresh.id === node.id && JSON.stringify(fresh.fills) === beforeJson;
        if (restored) delete globalThis.__invCache;
        return failed(fresh, restored ? 'rolled-back' : 'partial-residue', restored ? 1 : 0,
          mutationError && mutationError.message ? mutationError.message : 'Linear Gradient Extract postcondition failed.', restored ? [] : ['fills']);
      } catch (error) {
        return failed(node, 'verification-unavailable', 0, mutationError && mutationError.message ? mutationError.message : error.message, ['gradient-state']);
      }
    }

    let beforeFills, beforeFillsJson, beforeClips, beforeChildren, created = [], removedOriginal = 0, mutationError = null;
    const hex = (source) => ({ r: parseInt(source.slice(1,3), 16) / 255, g: parseInt(source.slice(3,5), 16) / 255, b: parseInt(source.slice(5,7), 16) / 255 });
    const solid = (source) => ({ type: 'SOLID', color: hex(source), opacity: 1, visible: true, blendMode: 'NORMAL' });
    const matchesMesh = (target, blur) => {
      if (!target || target.id !== node.id || target.type !== 'FRAME' || target.clipsContent !== true
        || !Array.isArray(target.fills) || target.fills.length !== 1 || !same(target.fills[0], solid(recipe.base))
        || !Array.isArray(target.children) || target.children.length !== created.length) return false;
      return target.children.every((child, index) => {
        const blob = recipe.blobs[index], radius = Math.round(Math.min(target.width, target.height) * blob.r);
        return child && child.id === created[index].id && child.type === 'ELLIPSE'
          && close(child.width, radius * 2) && close(child.height, radius * 2)
          && close(child.x, blob.fx * target.width - radius) && close(child.y, blob.fy * target.height - radius)
          && Array.isArray(child.fills) && child.fills.length === 1 && same(child.fills[0], solid(blob.color))
          && Array.isArray(child.effects) && child.effects.length === 1 && child.effects[0].type === 'LAYER_BLUR'
          && close(child.effects[0].radius, Math.round(blur * (blob.blurMul || 1))) && child.effects[0].visible === true;
      });
    };
    try {
      if (node.type !== 'FRAME' || !Array.isArray(node.children) || node.children.length > ${MAX_CHILDREN}
        || !Array.isArray(node.fills) || node.fills.length > ${MAX_PAINTS}
        || typeof node.clipsContent !== 'boolean' || !Number.isFinite(node.width) || !Number.isFinite(node.height)
        || node.width <= 0 || node.height <= 0 || node.width > ${MAX_METRIC} || node.height > ${MAX_METRIC}) {
        throw new Error('Mesh Gradient Extract requires one bounded FRAME target.');
      }
      beforeChildren = [...node.children]; beforeClips = node.clipsContent;
      beforeFillsJson = JSON.stringify(node.fills);
      if (typeof beforeFillsJson !== 'string' || beforeFillsJson.length > ${MAX_SNAPSHOT}) throw new Error('Mesh Gradient Extract rollback snapshot exceeds its bounded limit.');
      beforeFills = JSON.parse(beforeFillsJson);
    } catch (error) { return refusal(error); }
    const diameter = Math.min(node.width, node.height);
    const blur = Math.round(diameter * recipe.blurFraction);
    try {
      for (const blob of recipe.blobs) {
        const ellipse = figma.createEllipse(); created.push(ellipse);
        const radius = Math.round(diameter * blob.r);
        ellipse.resize(radius * 2, radius * 2);
        ellipse.x = blob.fx * node.width - radius; ellipse.y = blob.fy * node.height - radius;
        ellipse.fills = [solid(blob.color)];
        ellipse.effects = [{ type: 'LAYER_BLUR', radius: Math.round(blur * (blob.blurMul || 1)), visible: true }];
      }
      node.clipsContent = true; node.fills = [solid(recipe.base)];
      for (const ellipse of created) node.appendChild(ellipse);
      for (const child of beforeChildren) {
        try { child.remove(); } catch (error) { mutationError ||= error; }
        try { if (!node.children.some((candidate) => candidate.id === child.id)) removedOriginal += 1; } catch (error) { mutationError ||= error; }
      }
    } catch (error) { mutationError ||= error; }
    try {
      const fresh = await resolve();
      if (fresh && matchesMesh(fresh, blur)) {
        delete globalThis.__invCache;
        return applied(fresh, mutationError ? 'verified-after-error' : 'verified', { blobs: created.length, blur }, mutationError);
      }
    } catch (error) { mutationError ||= error; }
    if (removedOriginal === 0) {
      try {
        for (const ellipse of created) { try { ellipse.remove(); } catch {} }
        node.fills = beforeFills; node.clipsContent = beforeClips;
        const fresh = await resolve();
        let createdGone = true;
        for (const ellipse of created) {
          try { if (await figma.getNodeByIdAsync(ellipse.id)) createdGone = false; }
          catch { createdGone = false; }
        }
        const restored = fresh && fresh.id === node.id && JSON.stringify(fresh.fills) === beforeFillsJson
          && fresh.clipsContent === beforeClips && Array.isArray(fresh.children)
          && fresh.children.length === beforeChildren.length
          && fresh.children.every((child, index) => child.id === beforeChildren[index].id)
          && createdGone;
        if (restored) delete globalThis.__invCache;
        return failed(fresh || node, restored ? 'rolled-back' : 'partial-residue', restored ? created.length + 2 : 0,
          mutationError && mutationError.message ? mutationError.message : 'Mesh Gradient Extract postcondition failed.', restored ? [] : ['mesh-state']);
      } catch (error) {
        return failed(node, 'verification-unavailable', 0, mutationError && mutationError.message ? mutationError.message : error.message, ['mesh-state']);
      }
    }
    try {
      const fresh = await resolve();
      const residue = ['children', ...(!fresh || fresh.clipsContent !== true ? ['clipsContent'] : []),
        ...(!fresh || !Array.isArray(fresh.fills) || fresh.fills.length !== 1 || !same(fresh.fills[0], solid(recipe.base)) ? ['fills'] : [])];
      return failed(fresh || node, 'partial-residue', 0,
        mutationError && mutationError.message ? mutationError.message : 'Mesh Gradient Extract left an incomplete replacement.', residue);
    } catch (error) {
      return failed(node, 'verification-unavailable', 0, mutationError && mutationError.message ? mutationError.message : error.message, ['mesh-state']);
    }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function text(value, maximum, empty = true) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function validNode(value, request) {
  return exact(value, ['id','name','type']) && NODE_REFERENCE_PATTERN.test(value.id)
    && (request.selector.kind !== 'node' || value.id === request.selector.nodeId)
    && text(value.name, MAX_NAME) && text(value.type, 64, false);
}
function validRefusal(value, request) { return exact(value, ['schemaVersion','status','mode','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.mode === request.mode && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validSuccess(value, request) {
  if (!exact(value, ['schemaVersion','status','mode','outcome','attempted','node','details','residue','warnings'])
    || value.schemaVersion !== 1 || value.status !== 'applied' || value.mode !== request.mode
    || !['verified','verified-after-error','no-op'].includes(value.outcome)
    || value.attempted !== (value.outcome === 'no-op' ? 0 : 1) || !validNode(value.node, request)
    || !Array.isArray(value.residue) || value.residue.length !== 0 || !Array.isArray(value.warnings)
    || value.warnings.length !== (value.outcome === 'verified-after-error' ? 1 : 0)
    || !value.warnings.every((warning) => text(warning, 1024, false))) return false;
  return request.mode === 'linear'
    ? exact(value.details, ['field']) && value.details.field === 'fill'
    : exact(value.details, ['blobs','blur']) && Number.isInteger(value.details.blobs)
      && value.details.blobs > 0 && value.details.blobs <= MAX_BLOBS
      && Number.isInteger(value.details.blur) && value.details.blur >= 0 && value.outcome !== 'no-op';
}
function validFailure(value, request) {
  const residues = new Set(['gradient-state','fills','mesh-state','children','clipsContent']);
  const structurallyValid = exact(value, ['schemaVersion','status','mode','outcome','attempted','restored','failure','node','residue'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.mode === request.mode
    && ['unchanged','rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && Number.isInteger(value.restored) && value.restored >= 0 && value.restored <= MAX_BLOBS + 2
    && text(value.failure, 1024, false) && validNode(value.node, request)
    && Array.isArray(value.residue) && value.residue.length <= 3 && new Set(value.residue).size === value.residue.length
    && value.residue.every((item) => residues.has(item))
    && (value.outcome === 'rolled-back' ? value.restored > 0 && value.residue.length === 0 : value.restored === 0)
    && (value.outcome === 'unchanged' ? request.mode === 'linear' && value.residue.join(',') === 'gradient-state' : true)
    && (value.outcome === 'partial-residue' || value.outcome === 'verification-unavailable' ? value.residue.length > 0 : true);
  if (!structurallyValid) return false;
  if (request.mode === 'linear') {
    return value.outcome !== 'partial-residue' || value.residue.join(',') === 'fills';
  }
  return value.outcome !== 'unchanged'
    && (value.outcome === 'partial-residue'
      ? value.residue[0] === 'mesh-state' || value.residue[0] === 'children'
      : value.outcome !== 'verification-unavailable' || value.residue.join(',') === 'mesh-state');
}
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, residue, restored = 0) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: { version: 1, outcome, attempted: outcome === 'no-mutation' ? 0 : 1, restored, residueCount: residue } }); return error; }

function hex(stop) { return `#${stop.rgb.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`; }
function extractionJson(value) {
  if (value.request.mode === 'mesh') return JSON.stringify(value.result, null, 2);
  return JSON.stringify({
    mode: 'linear', direction: value.result.direction, angle: value.result.angle,
    stops: value.result.stops.map((stop) => ({ position: stop.position, hex: hex(stop), rgb: stop.rgb })),
    css: buildCssString(value.result), innerBox: value.result.box,
  }, null, 2);
}
function extractionText(value) {
  if (value.request.mode === 'mesh') {
    return ['', '  Mesh gradient extracted (blur-stack recipe)', '  ─────────────────────────────────────────',
      `  Base:  ${value.result.base}`,
      `  Blobs: ${value.result.blobs.length} ellipses, blur ${(value.result.blurFraction * 100).toFixed(0)}% of min side`,
      ...value.result.blobs.map((blob, index) => `    ${index + 1}.  (${blob.fx.toFixed(2)}, ${blob.fy.toFixed(2)})`.padEnd(26) + ` r=${blob.r.toFixed(2)}  ${blob.color}`),
    ].join('\n');
  }
  return ['', '  Gradient extracted (linear)', '  ─────────────────────────────────────────',
    `  Direction: ${value.result.direction} (${value.result.angle}deg)`, '  Stops:',
    ...value.result.stops.map((stop) => `    ${String(Math.round(stop.position * 100)).padStart(3)}%  ${hex(stop)}  rgb(${stop.rgb.join(', ')})`),
    '  CSS:', `    ${buildCssString(value.result)}`,
  ].join('\n');
}
function output(value, payload = null) {
  const extraction = value.request.json ? extractionJson(value) : extractionText(value);
  if (!payload || value.request.json) return extraction;
  return `${extraction}\n  ✓ ${value.request.mode === 'linear'
    ? `Applied to ${payload.node.name} (${payload.node.type})`
    : `Mesh built on ${payload.node.name} (${payload.details.blobs} blobs, blur ${payload.details.blur}px)`}`;
}

export async function executePreparedGradientExtract(value, adapters = {}) {
  if (!PREPARED.has(value)) throw new TypeError('Gradient Extract requires authentic prepared input.');
  if (!gradientExtractRequiresFigma(value)) return { stdout: output(value), stderr: '', code: 0, result: value.result };
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Gradient Extract mutation requires a Figma evaluate adapter.');
  const serialized = await adapters.evaluate(gradientExtractMutationCode(value));
  if (typeof serialized !== 'string' || serialized.length > MAX_RESULT) throw invalid('Gradient Extract returned an invalid bounded result.');
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Gradient Extract returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, value.request)) throw invalid('Gradient Extract returned an invalid bounded result.');
    throw mutationError(`Gradient Extract made no mutation: ${payload.failure}`, 'no-mutation', 0);
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, value.request)) throw invalid('Gradient Extract returned an invalid bounded result.');
    throw mutationError(`Gradient Extract failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, payload.residue.length, payload.restored);
  }
  if (!validSuccess(payload, value.request)) throw invalid('Gradient Extract returned an invalid bounded result.');
  return { stdout: output(value, payload), stderr: payload.warnings.join('\n'), code: 0, result: payload };
}

export function executeGradientExtractPlan(plan, value, adapters = {}) {
  if (gradientExtractPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Gradient Extract.`);
  const request = parseGradientExtractRequest(plan.argv);
  if (!PREPARED.has(value) || !isDeepStrictEqual(value.request, request)) throw new TypeError('Gradient Extract requires authentic prepared input matching its Command Plan.');
  return executePreparedGradientExtract(value, adapters);
}
