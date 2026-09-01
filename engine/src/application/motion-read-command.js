// Bounded native Motion reads behind one authoritative Command Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MOTION_READ_ACTIONS,
  motionReadArgvFromRequest,
  motionReadPlanningArgvFromRequest,
  parseMotionReadRequest,
} from './motion-read-request.js';

export { motionReadArgvFromRequest, motionReadPlanningArgvFromRequest } from './motion-read-request.js';

export const MAX_MOTION_STYLES = 512;
export const MAX_MOTION_TARGET_CHILDREN = 256;
export const MAX_MOTION_JSON_DEPTH = 24;
export const MAX_MOTION_JSON_ENTRIES = 1_024;
export const MAX_MOTION_JSON_VALUES = 16_384;
export const MAX_MOTION_TEXT_CODE_UNITS = 65_536;
export const MAX_MOTION_RESULT_CODE_UNITS = 500_000;
const MAX_ID_CODE_UNITS = 512;
const MAX_NAME_CODE_UNITS = 4_096;
const APPLICATION_IDS = new Set(MOTION_READ_ACTIONS.map((action) => `motion.${action}`));
const normalized = (request) => parseMotionReadRequest(motionReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu;

export function motionReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_MOTION_RESULT_CODE_UNITS}) throw new Error('Motion Read result exceeded its bounded response limit.');
      return serialized;
    };
    const text = (value, label, maximum, empty = true) => {
      if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) throw new Error(label + ' is invalid.');
      return value;
    };
    const json = (value, label) => {
      let values = 0; const seen = new Set();
      const visit = (item, depth = 0, inArray = false) => {
        values += 1;
        if (values > ${MAX_MOTION_JSON_VALUES}) throw new Error(label + ' value limit exceeded.');
        if (depth > ${MAX_MOTION_JSON_DEPTH}) throw new Error(label + ' depth limit exceeded.');
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error(label + ' contains a non-finite number.'); return item; }
        if (typeof item === 'string') return text(item, label + ' string', ${MAX_MOTION_TEXT_CODE_UNITS});
        if (item === undefined && !inArray) return undefined;
        if (!item || typeof item !== 'object' || seen.has(item)) throw new Error(label + ' must contain acyclic JSON values.');
        seen.add(item); let copy;
        if (Array.isArray(item)) {
          if (item.length > ${MAX_MOTION_JSON_ENTRIES}) throw new Error(label + ' array limit exceeded.');
          copy = item.map((child) => visit(child, depth + 1, true));
        } else {
          const keys = Object.keys(item);
          if (keys.length > ${MAX_MOTION_JSON_ENTRIES}) throw new Error(label + ' object limit exceeded.');
          copy = {};
          for (const key of keys) {
            text(key, label + ' key', 256, false);
            const child = visit(item[key], depth + 1, false);
            if (child !== undefined) copy[key] = child;
          }
        }
        seen.delete(item); return copy;
      };
      return visit(value);
    };
    const error = (code, nodeName = null, children = []) => bounded({ schemaVersion: 1, status: 'error', action: request.action, code, nodeName, children });
    try {
      if (figma.editorType !== 'figma') return error('WRONG_EDITOR');
      if (!figma.motion || typeof figma.motion !== 'object') return error('MOTION_DISABLED');
      if (request.action === 'styles') {
        if (typeof figma.motion.figmaAnimationStyles !== 'function') return error('MOTION_DISABLED');
        const native = figma.motion.figmaAnimationStyles();
        if (!Array.isArray(native) || native.length > ${MAX_MOTION_STYLES}) return error('INVALID_RUNTIME');
        const styles = native.map((style) => {
          if (!style || typeof style !== 'object') throw new Error('Motion style is invalid.');
          const fact = {
            styleId: text(style.styleId, 'Motion style id', ${MAX_ID_CODE_UNITS}, false),
            name: text(style.name, 'Motion style name', ${MAX_NAME_CODE_UNITS}, false),
          };
          if (style.description !== undefined) fact.description = text(style.description, 'Motion style description', ${MAX_MOTION_TEXT_CODE_UNITS});
          return fact;
        });
        return bounded({ schemaVersion: 1, status: 'ok', action: request.action, data: { styles } });
      }
      if (typeof figma.getNodeByIdAsync !== 'function') return error('INVALID_RUNTIME');
      const requested = await figma.getNodeByIdAsync(request.nodeId);
      if (!requested) return error('NOT_FOUND');
      let node = requested; let descended = false; let fromName = null;
      const topLevel = requested.parent && requested.parent.type === 'PAGE';
      const container = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(requested.type);
      if (topLevel && container) {
        if (!Array.isArray(requested.children)) return error('INVALID_RUNTIME');
        if (requested.children.length === 0) return error('TOPLEVEL_EMPTY', text(requested.name, 'Motion target name', ${MAX_NAME_CODE_UNITS}));
        if (requested.children.length > 1) {
          if (requested.children.length > ${MAX_MOTION_TARGET_CHILDREN}) return error('TOO_MANY_CHILDREN', text(requested.name, 'Motion target name', ${MAX_NAME_CODE_UNITS}));
          const children = requested.children.map((child) => ({
            id: text(child.id, 'Motion child id', ${MAX_ID_CODE_UNITS}, false),
            name: text(child.name, 'Motion child name', ${MAX_NAME_CODE_UNITS}),
          }));
          return error('TOPLEVEL_MULTI', text(requested.name, 'Motion target name', ${MAX_NAME_CODE_UNITS}), children);
        }
        node = requested.children[0]; descended = true;
        fromName = text(requested.name, 'Motion source name', ${MAX_NAME_CODE_UNITS});
      }
      const motion = {};
      for (const field of ['timelines', 'manualKeyframeTracks', 'animationStyles']) {
        if (node[field] !== undefined) motion[field] = json(node[field], 'Motion ' + field);
      }
      const data = {
        requestedNodeId: request.nodeId,
        nodeId: text(node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false),
        nodeName: text(node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS}),
        descended,
        fromName,
        motion,
      };
      return bounded({ schemaVersion: 1, status: 'ok', action: request.action, data });
    } catch {
      return JSON.stringify({ schemaVersion: 1, status: 'error', action: request.action, code: 'INVALID_RUNTIME', nodeName: null, children: [] });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function validJson(value, depth = 0, state = { values: 0 }) {
  state.values += 1;
  if (state.values > MAX_MOTION_JSON_VALUES || depth > MAX_MOTION_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return text(value, MAX_MOTION_TEXT_CODE_UNITS);
  if (!record(value) && !Array.isArray(value)) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_MOTION_JSON_ENTRIES
      && value.every((item) => validJson(item, depth + 1, state));
  }
  const keys = Object.keys(value);
  return Object.getPrototypeOf(value) === Object.prototype
    && keys.length <= MAX_MOTION_JSON_ENTRIES
    && keys.every((key) => text(key, 256, false) && validJson(value[key], depth + 1, state));
}
function validStyle(value) {
  return record(value) && (exact(value, ['styleId', 'name']) || exact(value, ['styleId', 'name', 'description']))
    && text(value.styleId, MAX_ID_CODE_UNITS, false) && text(value.name, MAX_NAME_CODE_UNITS, false)
    && (value.description === undefined || text(value.description, MAX_MOTION_TEXT_CODE_UNITS));
}
function validMotion(value) {
  if (!record(value) || Object.keys(value).some((key) => !['timelines', 'manualKeyframeTracks', 'animationStyles'].includes(key))) return false;
  return Object.values(value).every((item) => validJson(item));
}
function validData(value, input) {
  if (input.action === 'styles') {
    return exact(value, ['styles']) && Array.isArray(value.styles)
      && value.styles.length <= MAX_MOTION_STYLES && value.styles.every(validStyle);
  }
  return exact(value, ['requestedNodeId', 'nodeId', 'nodeName', 'descended', 'fromName', 'motion'])
    && value.requestedNodeId === input.nodeId && text(value.nodeId, MAX_ID_CODE_UNITS, false)
    && text(value.nodeName, MAX_NAME_CODE_UNITS) && typeof value.descended === 'boolean'
    && (value.fromName === null || text(value.fromName, MAX_NAME_CODE_UNITS))
    && (value.descended ? value.fromName !== null : value.fromName === null)
    && validMotion(value.motion);
}
function validError(value, input) {
  if (!exact(value, ['schemaVersion', 'status', 'action', 'code', 'nodeName', 'children'])
    || value.schemaVersion !== 1 || value.status !== 'error' || value.action !== input.action
    || !['WRONG_EDITOR', 'MOTION_DISABLED', 'INVALID_RUNTIME', 'NOT_FOUND', 'TOPLEVEL_EMPTY', 'TOPLEVEL_MULTI', 'TOO_MANY_CHILDREN'].includes(value.code)
    || (value.nodeName !== null && !text(value.nodeName, MAX_NAME_CODE_UNITS))
    || !Array.isArray(value.children) || value.children.length > MAX_MOTION_TARGET_CHILDREN) return false;
  return value.children.every((child) => exact(child, ['id', 'name'])
    && text(child.id, MAX_ID_CODE_UNITS, false) && text(child.name, MAX_NAME_CODE_UNITS));
}
function validPayload(value, input) {
  if (validError(value, input)) return true;
  return exact(value, ['schemaVersion', 'status', 'action', 'data'])
    && value.schemaVersion === 1 && value.status === 'ok' && value.action === input.action
    && validData(value.data, input);
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT, ' '); }
function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function errorMessage(payload, input) {
  if (payload.code === 'WRONG_EDITOR') return 'Motion Read requires Figma Design.';
  if (payload.code === 'MOTION_DISABLED') return 'Motion API is not enabled for this Figma account.';
  if (payload.code === 'INVALID_RUNTIME') return 'Motion Read returned invalid or excessive native facts.';
  if (payload.code === 'NOT_FOUND') return `Motion node "${safeText(input.nodeId)}" was not found.`;
  if (payload.code === 'TOPLEVEL_EMPTY') return `"${safeText(payload.nodeName)}" is a top-level frame with no children.`;
  if (payload.code === 'TOO_MANY_CHILDREN') return `"${safeText(payload.nodeName)}" has too many children for bounded Motion resolution.`;
  return `"${safeText(payload.nodeName)}" is a top-level frame; choose one child by id:\n`
    + payload.children.map((child) => `  ${safeText(child.id)}  ${safeText(child.name)}`).join('\n');
}

export function formatMotionReadResult(data, input) {
  if (input.action === 'styles') {
    const lines = [`${data.styles.length} animation styles`];
    for (const style of data.styles) {
      const short = style.name.replace(/^motion\.preset_name\./, '');
      lines.push(`  ${safeText(short).padEnd(12)} ${safeText(style.name)}`);
    }
    return lines.join('\n');
  }
  const via = data.descended ? ` (via "${safeText(data.fromName)}")` : '';
  return `Motion on ${safeText(data.nodeName)}${via}\n${safeJson(data.motion)}`;
}

export async function executeMotionRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Motion Read requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(motionReadCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_MOTION_RESULT_CODE_UNITS) {
    throw new Error('Motion Read returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Motion Read returned invalid JSON.'); }
  if (!validPayload(payload, input)) throw new Error('Motion Read returned an invalid bounded result.');
  if (payload.status === 'error') throw new Error(errorMessage(payload, input));
  return { stdout: formatMotionReadResult(payload.data, input), stderr: '', code: 0, result: payload.data };
}

export function motionReadPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Read routing requires a Command Plan.');
  return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-motion-read';
}

export function executeMotionReadPlan(plan, adapters = {}) {
  if (motionReadPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Read.');
  return executeMotionRead(parseMotionReadRequest(plan.argv), adapters);
}
