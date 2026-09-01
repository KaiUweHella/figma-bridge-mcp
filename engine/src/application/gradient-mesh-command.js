// One owning, staged and freshly verified `gradient mesh` Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { buildMeshFromColors } from '../gradient-extractor.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gradientMeshArgvFromRequest,
  gradientMeshPlanningArgvFromRequest,
  parseGradientMeshRequest,
} from './gradient-mesh-request.js';

export { gradientMeshArgvFromRequest, gradientMeshPlanningArgvFromRequest } from './gradient-mesh-request.js';

const APPLICATION_ID = 'gradient.mesh';
const PREPARED = new WeakSet();
const MAX_RESULT = 65_536;
const MAX_SNAPSHOT = 262_144;
const MAX_PAINTS = 10_000;
const MAX_EFFECTS = 10_000;
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
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Gradient Mesh produced an invalid ${label}.`);
  return Object.is(value, -0) ? 0 : value;
}
function recipeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.mode !== 'mesh'
    || typeof value.style !== 'string' || !value.style.length || value.style.length > 64
    || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffff_ffff
    || typeof value.base !== 'string' || !HEX.test(value.base)
    || !Array.isArray(value.blobs) || !value.blobs.length || value.blobs.length > MAX_BLOBS) {
    throw new Error('Gradient Mesh produced an invalid bounded recipe.');
  }
  const blobs = value.blobs.map((blob) => {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)
      || typeof blob.color !== 'string' || !HEX.test(blob.color)) throw new Error('Gradient Mesh produced an invalid blob.');
    return {
      fx: finite(blob.fx, -10, 10, 'blob x'), fy: finite(blob.fy, -10, 10, 'blob y'),
      r: finite(blob.r, 0.001, 10, 'blob radius'), color: blob.color,
      ...(blob.blurMul === undefined ? {} : { blurMul: finite(blob.blurMul, 0, 10, 'blob blur multiplier') }),
    };
  });
  return freezeGraph({
    mode: 'mesh', style: value.style, seed: value.seed, base: value.base, blobs,
    blurFraction: finite(value.blurFraction, 0.05, 0.8, 'blur fraction'),
  });
}
function effectValue(request) {
  if (request.grain === null && !request.texture) return null;
  return freezeGraph([
    ...(request.grain === null ? [] : [{
      type: 'NOISE', noiseType: 'MONOTONE', density: request.grain, noiseSize: 1.2,
      color: { r: 0, g: 0, b: 0, a: 1 }, visible: true,
    }]),
    ...(request.texture ? [{ type: 'TEXTURE', noiseSize: 12, radius: 24, clipToShape: true, visible: true }] : []),
  ]);
}

export function gradientMeshPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Gradient Mesh routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-gradient-mesh';
}

export function prepareGradientMeshPlan(plan, { buildRecipe = buildMeshFromColors } = {}) {
  if (gradientMeshPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Gradient Mesh.`);
  }
  const request = parseGradientMeshRequest(plan.argv);
  const recipe = recipeValue(buildRecipe([...request.colors], {
    ...(request.base === null ? {} : { base: request.base }), blur: request.blur,
    style: request.style, ...(request.seed === null ? {} : { seed: request.seed }),
  }));
  const value = Object.freeze({ request, recipe, effects: effectValue(request) });
  PREPARED.add(value);
  return value;
}

export function gradientMeshCode(value) {
  if (!PREPARED.has(value)) throw new TypeError('Gradient Mesh requires authentic prepared input.');
  const { request, recipe, effects } = value;
  return `(async () => {
    const request = ${js({ selector: request.selector, size: request.size, name: request.name })};
    const recipe = ${js(recipe)}; const requestedEffects = ${js(effects)};
    const creating = request.selector === null;
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_RESULT}) throw new Error('Gradient Mesh result exceeded its bounded response limit.'); return value; };
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
    const resolve = async () => creating ? node
      : request.selector.kind === 'selection' ? figma.currentPage.selection[0] || null
        : await figma.getNodeByIdAsync(request.selector.nodeId);
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const applied = (fresh, outcome, blur, warning) => bounded({ schemaVersion: 1, status: 'applied', outcome, attempted: 1,
      node: nodeFact(fresh), details: { created: creating, blobs: created.length, blur, width: fresh.width, height: fresh.height }, residue: [],
      warnings: warning ? ['Gradient Mesh reached its complete document postcondition after a native or viewport acknowledgement error.'] : [] });
    const failed = (fresh, outcome, restored, failure, residue) => bounded({ schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored,
      failure: clean(failure, 1024), node: nodeFact(fresh), residue });
    const hex = (source) => ({ r: parseInt(source.slice(1,3), 16) / 255, g: parseInt(source.slice(3,5), 16) / 255, b: parseInt(source.slice(5,7), 16) / 255 });
    const solid = (source) => ({ type: 'SOLID', color: hex(source), opacity: 1, visible: true, blendMode: 'NORMAL' });
    let node = null, beforeChildren = [], beforeFills = null, beforeFillsJson = null,
      beforeEffects = null, beforeEffectsJson = null, beforeClips = false, created = [], removedOriginal = 0,
      createdFrame = null, expectedX = null, mutationError = null;
    try {
      if (creating) {
        if (!figma.currentPage || !Array.isArray(figma.currentPage.children)
          || figma.currentPage.children.length > ${MAX_CHILDREN}) throw new Error('Gradient Mesh requires one bounded current Page.');
        let maximum = 0;
        for (const child of figma.currentPage.children) {
          if (!child || !Number.isFinite(child.x) || !Number.isFinite(child.width)
            || Math.abs(child.x) > ${MAX_METRIC} || child.width < 0 || child.width > ${MAX_METRIC}) {
            throw new Error('Gradient Mesh cannot derive a bounded new-frame position.');
          }
          maximum = Math.max(maximum, child.x + child.width);
        }
        expectedX = Math.max(maximum, request.size.width) + 100;
      } else {
        node = await resolve();
        if (!node || (request.selector.kind === 'node' && node.id !== request.selector.nodeId)
          || node.type !== 'FRAME' || typeof node.id !== 'string' || typeof node.name !== 'string'
          || !Array.isArray(node.children) || node.children.length > ${MAX_CHILDREN}
          || !Array.isArray(node.fills) || node.fills.length > ${MAX_PAINTS}
          || !Array.isArray(node.effects) || node.effects.length > ${MAX_EFFECTS}
          || typeof node.clipsContent !== 'boolean' || !Number.isFinite(node.width) || !Number.isFinite(node.height)
          || node.width <= 0 || node.height <= 0 || node.width > ${MAX_METRIC} || node.height > ${MAX_METRIC}) {
          throw new Error('Gradient Mesh requires one bounded FRAME target.');
        }
        beforeChildren = [...node.children]; beforeClips = node.clipsContent;
        beforeFillsJson = JSON.stringify(node.fills); beforeEffectsJson = JSON.stringify(node.effects);
        if (typeof beforeFillsJson !== 'string' || beforeFillsJson.length > ${MAX_SNAPSHOT}
          || typeof beforeEffectsJson !== 'string' || beforeEffectsJson.length > ${MAX_SNAPSHOT}) {
          throw new Error('Gradient Mesh rollback snapshot exceeds its bounded limit.');
        }
        beforeFills = JSON.parse(beforeFillsJson); beforeEffects = JSON.parse(beforeEffectsJson);
      }
    } catch (error) { return refusal(error); }
    try {
      if (creating) {
        node = figma.createFrame(); createdFrame = node;
        if (!node || typeof node.id !== 'string' || typeof node.name !== 'string' || node.type !== 'FRAME') throw new Error('Figma did not create one valid Frame.');
        node.name = request.name; node.resize(request.size.width, request.size.height);
        node.x = expectedX; node.y = 0;
      }
      const diameter = Math.min(node.width, node.height), blur = Math.round(diameter * recipe.blurFraction);
      for (const blob of recipe.blobs) {
        const ellipse = figma.createEllipse(); created.push(ellipse);
        const radius = Math.round(diameter * blob.r);
        ellipse.resize(radius * 2, radius * 2);
        ellipse.x = blob.fx * node.width - radius; ellipse.y = blob.fy * node.height - radius;
        ellipse.fills = [solid(blob.color)];
        ellipse.effects = [{ type: 'LAYER_BLUR', radius: Math.round(blur * (blob.blurMul || 1)), visible: true }];
      }
      node.clipsContent = true; node.fills = [solid(recipe.base)];
      if (requestedEffects !== null) node.effects = requestedEffects;
      for (const ellipse of created) node.appendChild(ellipse);
      if (!creating) {
        for (const child of beforeChildren) {
          try { child.remove(); } catch (error) { mutationError ||= error; }
          try { if (!node.children.some((candidate) => candidate.id === child.id)) removedOriginal += 1; } catch (error) { mutationError ||= error; }
        }
      }
      const matches = (fresh) => {
        if (!fresh || fresh.id !== node.id || fresh.type !== 'FRAME' || fresh.clipsContent !== true
          || !close(fresh.width, creating ? request.size.width : node.width)
          || !close(fresh.height, creating ? request.size.height : node.height)
          || creating && (fresh.name !== request.name || !close(fresh.x, expectedX) || !close(fresh.y, 0))
          || !Array.isArray(fresh.fills) || fresh.fills.length !== 1 || !same(fresh.fills[0], solid(recipe.base))
          || requestedEffects !== null && (!Array.isArray(fresh.effects) || !same(fresh.effects, requestedEffects))
          || !Array.isArray(fresh.children) || fresh.children.length !== created.length) return false;
        return fresh.children.every((child, index) => {
          const blob = recipe.blobs[index], radius = Math.round(Math.min(fresh.width, fresh.height) * blob.r);
          return child && child.id === created[index].id && child.type === 'ELLIPSE'
            && close(child.width, radius * 2) && close(child.height, radius * 2)
            && close(child.x, blob.fx * fresh.width - radius) && close(child.y, blob.fy * fresh.height - radius)
            && Array.isArray(child.fills) && child.fills.length === 1 && same(child.fills[0], solid(blob.color))
            && Array.isArray(child.effects) && child.effects.length === 1 && child.effects[0].type === 'LAYER_BLUR'
            && close(child.effects[0].radius, Math.round(blur * (blob.blurMul || 1))) && child.effects[0].visible === true;
        });
      };
      const fresh = await resolve();
      if (matches(fresh)) {
        try { figma.viewport.scrollAndZoomIntoView([fresh]); } catch (error) { mutationError ||= error; }
        delete globalThis.__invCache;
        return applied(fresh, mutationError ? 'verified-after-error' : 'verified', blur, mutationError);
      }
      mutationError ||= new Error('Gradient Mesh postcondition failed.');
    } catch (error) { mutationError ||= error; }
    if (creating) {
      try {
        if (!createdFrame) {
          return failed({ id: '0:0', name: request.name, type: 'FRAME' }, 'verification-unavailable', 0,
            mutationError && mutationError.message ? mutationError.message : 'Gradient Mesh could not attribute the attempted Frame creation.', ['frame']);
        }
        for (const ellipse of created) { try { ellipse.remove(); } catch {} }
        try { createdFrame.remove(); } catch {}
        let residue = [];
        try { if (await figma.getNodeByIdAsync(createdFrame.id)) residue.push('frame'); } catch { residue.push('frame'); }
        for (const ellipse of created) {
          try { if (await figma.getNodeByIdAsync(ellipse.id)) { residue.push('children'); break; } }
          catch { residue.push('children'); break; }
        }
        const restored = residue.length === 0;
        if (restored) delete globalThis.__invCache;
        return failed(createdFrame, restored ? 'rolled-back' : 'partial-residue',
          restored ? created.length + 1 : 0, mutationError && mutationError.message ? mutationError.message : 'Gradient Mesh creation failed.', residue);
      } catch (error) {
        return failed(createdFrame || { id: '0:0', name: request.name, type: 'FRAME' }, 'verification-unavailable', 0,
          mutationError && mutationError.message ? mutationError.message : error.message, ['mesh-state']);
      }
    }
    if (removedOriginal === 0) {
      try {
        for (const ellipse of created) { try { ellipse.remove(); } catch {} }
        node.fills = beforeFills; node.clipsContent = beforeClips;
        if (requestedEffects !== null) node.effects = beforeEffects;
        const fresh = await resolve();
        let createdGone = true;
        for (const ellipse of created) {
          try { if (await figma.getNodeByIdAsync(ellipse.id)) createdGone = false; } catch { createdGone = false; }
        }
        const restored = fresh && fresh.id === node.id && JSON.stringify(fresh.fills) === beforeFillsJson
          && fresh.clipsContent === beforeClips
          && (requestedEffects === null || JSON.stringify(fresh.effects) === beforeEffectsJson)
          && Array.isArray(fresh.children) && fresh.children.length === beforeChildren.length
          && fresh.children.every((child, index) => child.id === beforeChildren[index].id) && createdGone;
        if (restored) delete globalThis.__invCache;
        return failed(fresh || node, restored ? 'rolled-back' : 'partial-residue', restored ? created.length + 2 + Number(requestedEffects !== null) : 0,
          mutationError && mutationError.message ? mutationError.message : 'Gradient Mesh postcondition failed.', restored ? [] : ['mesh-state']);
      } catch (error) {
        return failed(node, 'verification-unavailable', 0, mutationError && mutationError.message ? mutationError.message : error.message, ['mesh-state']);
      }
    }
    try {
      const fresh = await resolve();
      const residue = ['children', ...(!fresh || fresh.clipsContent !== true ? ['clipsContent'] : []),
        ...(!fresh || !Array.isArray(fresh.fills) || fresh.fills.length !== 1 || !same(fresh.fills[0], solid(recipe.base)) ? ['fills'] : []),
        ...(requestedEffects !== null && (!fresh || !Array.isArray(fresh.effects) || !same(fresh.effects, requestedEffects)) ? ['effects'] : [])];
      return failed(fresh || node, 'partial-residue', 0,
        mutationError && mutationError.message ? mutationError.message : 'Gradient Mesh left an incomplete replacement.', residue.slice(0, 4));
    } catch (error) {
      return failed(node, 'verification-unavailable', 0, mutationError && mutationError.message ? mutationError.message : error.message, ['mesh-state']);
    }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function text(value, maximum, empty = true) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function validNode(value, request) {
  return exact(value, ['id','name','type']) && NODE_REFERENCE_PATTERN.test(value.id)
    && (request.selector?.kind !== 'node' || value.id === request.selector.nodeId)
    && text(value.name, MAX_NAME) && value.type === 'FRAME';
}
function validRefusal(value) { return exact(value, ['schemaVersion','status','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validSuccess(value, request, recipe) {
  return exact(value, ['schemaVersion','status','outcome','attempted','node','details','residue','warnings'])
    && value.schemaVersion === 1 && value.status === 'applied' && ['verified','verified-after-error'].includes(value.outcome)
    && value.attempted === 1 && validNode(value.node, request)
    && exact(value.details, ['created','blobs','blur','width','height'])
    && value.details.created === (request.selector === null) && value.details.blobs === recipe.blobs.length
    && Number.isInteger(value.details.blur) && value.details.blur >= 0
    && Number.isFinite(value.details.width) && value.details.width > 0 && value.details.width <= MAX_METRIC
    && Number.isFinite(value.details.height) && value.details.height > 0 && value.details.height <= MAX_METRIC
    && (request.selector !== null || value.details.width === request.size.width && value.details.height === request.size.height)
    && Array.isArray(value.residue) && value.residue.length === 0 && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, 1024, false));
}
function validFailure(value, request) {
  const allowed = new Set(['frame','children','mesh-state','clipsContent','fills','effects']);
  return exact(value, ['schemaVersion','status','outcome','attempted','restored','failure','node','residue'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && Number.isInteger(value.restored) && value.restored >= 0 && value.restored <= MAX_BLOBS + 3
    && text(value.failure, 1024, false) && validNode(value.node, request)
    && Array.isArray(value.residue) && value.residue.length <= 4 && new Set(value.residue).size === value.residue.length
    && value.residue.every((item) => allowed.has(item))
    && (value.outcome === 'rolled-back' ? value.restored > 0 && value.residue.length === 0 : value.restored === 0)
    && (value.outcome === 'partial-residue' || value.outcome === 'verification-unavailable' ? value.residue.length > 0 : true);
}
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, residue, restored = 0) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: { version: 1, outcome, attempted: outcome === 'no-mutation' ? 0 : 1, restored, residueCount: residue } }); return error; }

function recipeText(recipe) {
  return ['', '  Mesh wallpaper recipe', '  ─────────────────────────────────────────',
    `  Style: ${recipe.style}  (seed ${recipe.seed})`, `  Base:  ${recipe.base}`,
    `  Blobs: ${recipe.blobs.length}, blur ${(recipe.blurFraction * 100).toFixed(0)}% of min side`,
    ...recipe.blobs.map((blob, index) => `    ${index + 1}.  (${blob.fx.toFixed(2)}, ${blob.fy.toFixed(2)})`.padEnd(26) + ` r=${blob.r.toFixed(2)}  ${blob.color}`),
  ].join('\n');
}
function output(value, payload) {
  const recipe = value.request.json ? JSON.stringify(value.recipe, null, 2) : recipeText(value.recipe);
  if (value.request.json) return recipe;
  return `${recipe}\n  ✓ ${payload.details.created ? 'Created' : 'Built on'} ${payload.node.name} (${payload.details.width}x${payload.details.height}, ${payload.details.blobs} blobs)`;
}

export async function executePreparedGradientMesh(value, adapters = {}) {
  if (!PREPARED.has(value)) throw new TypeError('Gradient Mesh requires authentic prepared input.');
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Gradient Mesh requires a Figma evaluate adapter.');
  const serialized = await adapters.evaluate(gradientMeshCode(value));
  if (typeof serialized !== 'string' || serialized.length > MAX_RESULT) throw invalid('Gradient Mesh returned an invalid bounded result.');
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Gradient Mesh returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Gradient Mesh returned an invalid bounded result.');
    throw mutationError(`Gradient Mesh made no mutation: ${payload.failure}`, 'no-mutation', 0);
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, value.request)) throw invalid('Gradient Mesh returned an invalid bounded result.');
    throw mutationError(`Gradient Mesh failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, payload.residue.length, payload.restored);
  }
  if (!validSuccess(payload, value.request, value.recipe)) throw invalid('Gradient Mesh returned an invalid bounded result.');
  return { stdout: output(value, payload), stderr: payload.warnings.join('\n'), code: 0, result: payload };
}

export function executeGradientMeshPlan(plan, value, adapters = {}) {
  if (gradientMeshPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Gradient Mesh.`);
  const request = parseGradientMeshRequest(plan.argv);
  if (!PREPARED.has(value) || !isDeepStrictEqual(value.request, request)) throw new TypeError('Gradient Mesh requires authentic prepared input matching its Command Plan.');
  return executePreparedGradientMesh(value, adapters);
}
