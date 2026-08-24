// Value-returning read-only Canvas Awareness Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  canvasAwarenessArgvFromRequest,
  canvasAwarenessPlanningArgvFromRequest,
  parseCanvasAwarenessRequest,
} from './canvas-awareness-request.js';

export {
  canvasAwarenessArgvFromRequest,
  canvasAwarenessPlanningArgvFromRequest,
} from './canvas-awareness-request.js';

const APPLICATION_IDS = new Set(['canvas.info', 'canvas.next']);

function invalidResult() {
  throw new Error('Figma returned an invalid Canvas Awareness result.');
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function finite(value, { minimum = -Number.MAX_SAFE_INTEGER } = {}) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isSafeInteger(Math.trunc(value))
    && value >= minimum;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canvasInfoResult(value) {
  if (!record(value)) invalidResult();
  if (value.empty === true) {
    if (value.message !== 'Canvas is empty' || value.nextX !== 0 || value.nextY !== 0) invalidResult();
    return { empty: true, message: 'Canvas is empty', nextX: 0, nextY: 0 };
  }
  if (!count(value.elements) || value.elements < 1
    || !record(value.bounds)
    || !finite(value.bounds.x) || !finite(value.bounds.y)
    || !finite(value.bounds.width, { minimum: 0 })
    || !finite(value.bounds.height, { minimum: 0 })
    || !finite(value.nextX) || !finite(value.nextY)
    || !count(value.frames) || !count(value.components)
    || value.frames > value.elements || value.components > value.elements) invalidResult();
  return {
    elements: value.elements,
    bounds: {
      x: value.bounds.x,
      y: value.bounds.y,
      width: value.bounds.width,
      height: value.bounds.height,
    },
    nextX: value.nextX,
    nextY: value.nextY,
    frames: value.frames,
    components: value.components,
  };
}

function canvasNextResult(value) {
  if (!record(value) || !finite(value.x) || !finite(value.y)) invalidResult();
  return { x: value.x, y: value.y };
}

function infoCode() {
  return `(async function() {
await figma.currentPage.loadAsync();
const children = figma.currentPage.children;
if (children.length === 0) {
  return { empty: true, message: 'Canvas is empty', nextX: 0, nextY: 0 };
}
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
children.forEach((node) => {
  minX = Math.min(minX, node.x);
  minY = Math.min(minY, node.y);
  maxX = Math.max(maxX, node.x + node.width);
  maxY = Math.max(maxY, node.y + node.height);
});
return {
  elements: children.length,
  bounds: {
    x: Math.round(minX), y: Math.round(minY),
    width: Math.round(maxX - minX), height: Math.round(maxY - minY),
  },
  nextX: Math.round(maxX + 100),
  nextY: 0,
  frames: children.filter((node) => node.type === 'FRAME').length,
  components: children.filter((node) => node.type === 'COMPONENT').length,
};
})()`;
}

function nextCode({ gap, direction }) {
  const axis = direction === 'below' ? 'y' : 'x';
  const extent = direction === 'below' ? 'height' : 'width';
  const placement = axis === 'y'
    ? '{ x: 0, y: Math.round(maximum + gap) }'
    : '{ x: Math.round(maximum + gap), y: 0 }';
  return `(async function() {
await figma.currentPage.loadAsync();
const children = figma.currentPage.children;
const gap = ${JSON.stringify(gap)};
if (children.length === 0) return { x: 0, y: 0 };
let maximum = -Infinity;
children.forEach((node) => { maximum = Math.max(maximum, node.${axis} + node.${extent}); });
return ${placement};
})()`;
}

function normalizedRequest(request) {
  return parseCanvasAwarenessRequest(canvasAwarenessArgvFromRequest(request));
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeCanvasAwareness(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCanvasAwareness requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const raw = await adapters.evaluate(input.action === 'info' ? infoCode() : nextCode(input));
  const result = input.action === 'info' ? canvasInfoResult(raw) : canvasNextResult(raw);
  return {
    stdout: input.action === 'info'
      ? JSON.stringify(result, null, result.empty ? 0 : 2)
      : JSON.stringify(result),
    stderr: '',
    result,
  };
}

export function canvasAwarenessPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Canvas Awareness routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application'
    : 'not-canvas-awareness';
}

export async function executeCanvasAwarenessPlan(plan, adapters = {}) {
  if (canvasAwarenessPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Canvas Awareness Command Application.`);
  }
  return executeCanvasAwareness(parseCanvasAwarenessRequest(plan.argv), adapters);
}
