// Native Figma Draw inspection and rollback-aware mutations behind one Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  DRAW_ACTIONS,
  DRAW_WRITE_ACTIONS,
  MAX_DRAW_JSON_DEPTH,
  MAX_DRAW_JSON_ENTRIES,
  MAX_DRAW_JSON_VALUES,
  MAX_DRAW_TEXT_CODE_UNITS,
  drawArgvFromRequest,
  drawPlanningArgvFromRequest,
  parseDrawRequest,
} from './draw-request.js';

export { drawArgvFromRequest, drawPlanningArgvFromRequest } from './draw-request.js';
export const MAX_DRAW_RESULT_CODE_UNITS = 500_000;
const APPLICATION_IDS = new Set(DRAW_ACTIONS.map((action) => `draw.${action}`));
const normalized = (request) => parseDrawRequest(drawArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function drawCommandCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_DRAW_RESULT_CODE_UNITS}) throw new Error('Draw result exceeded its bounded response limit.'); return serialized; };
    const json = (value, label) => {
      let values = 0; const seen = new Set();
      const visit = (item, depth = 0) => {
        values++; if (values > ${MAX_DRAW_JSON_VALUES}) throw new Error(label + ' value limit exceeded.');
        if (depth > ${MAX_DRAW_JSON_DEPTH}) throw new Error(label + ' depth limit exceeded.');
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error(label + ' contains a non-finite number.'); return item; }
        if (typeof item === 'string') return clean(item, ${MAX_DRAW_TEXT_CODE_UNITS});
        if (!item || typeof item !== 'object' || seen.has(item)) throw new Error(label + ' must contain acyclic JSON values.');
        seen.add(item); let copy;
        if (Array.isArray(item)) { if (item.length > ${MAX_DRAW_JSON_ENTRIES}) throw new Error(label + ' array limit exceeded.'); copy = item.map((child) => visit(child, depth + 1)); }
        else { const keys = Object.keys(item); if (keys.length > ${MAX_DRAW_JSON_ENTRIES}) throw new Error(label + ' object limit exceeded.'); copy = {}; for (const key of keys) copy[clean(key, 256)] = visit(item[key], depth + 1); }
        seen.delete(item); return copy;
      };
      return visit(value);
    };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const nodeFacts = (node) => ({ id: clean(String(node.id || ''), 512), name: clean(String(node.name || ''), 1024), type: clean(String(node.type || ''), 64) });
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const failed = (outcome, error, residue = []) => bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome, attempted: 1, restored: outcome === 'rolled-back' ? 1 : 0, residue, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Draw mutation verification failed.' });
    const success = (status, result, attempted, outcome = attempted ? 'verified' : 'no-op', warnings = []) => bounded({ schemaVersion: 1, status, action: request.action, outcome, attempted, result, residue: [], warnings });
    if (figma.editorType !== 'figma') return refusal(new Error('Figma Draw APIs are only available in Figma Design.'));
    if (typeof figma.getNodeByIdAsync !== 'function') return refusal(new Error('Figma Draw node lookup is unavailable.'));
    if (request.action === 'inspect') {
      try {
        const node = await figma.getNodeByIdAsync(request.nodeId); if (!node) throw new Error('Draw node was not found.');
        const result = { ...nodeFacts(node), ...(node.type === 'TEXT_PATH' ? { textPathStartData: json(node.textPathStartData, 'Text Path start data'), characters: String(node.characters || '').slice(0, ${MAX_DRAW_TEXT_CODE_UNITS}) } : {}), ...('transformModifiers' in node ? { transformModifiers: json(node.transformModifiers, 'Transform modifiers') } : {}), ...('complexStrokeProperties' in node ? { complexStrokeProperties: json(node.complexStrokeProperties, 'Complex stroke properties'), variableWidthStrokeProperties: json(node.variableWidthStrokeProperties, 'Variable-width stroke properties') } : {}), ...('fills' in node && node.fills !== figma.mixed ? { patternFills: json(node.fills.filter((paint) => paint && paint.type === 'PATTERN'), 'Pattern fills') } : {}), ...('strokes' in node && node.strokes !== figma.mixed ? { patternStrokes: json(node.strokes.filter((paint) => paint && paint.type === 'PATTERN'), 'Pattern strokes') } : {}) };
        return success('inspected', result, 0, 'verified');
      } catch (error) { return refusal(error); }
    }
    if (request.action === 'text-path') {
      let base; let beforeType;
      try {
        base = await figma.getNodeByIdAsync(request.nodeId); if (!base || !['VECTOR','RECTANGLE','ELLIPSE','POLYGON','STAR','LINE'].includes(base.type)) throw new Error('Target node cannot become text on a path.'); beforeType = base.type;
        if (typeof figma.createTextPath !== 'function' || typeof figma.loadFontAsync !== 'function') throw new Error('Text Path APIs are unavailable.');
        await figma.loadFontAsync({ family: request.fontFamily, style: request.fontStyle });
      } catch (error) { return refusal(error); }
      let converted = null; let mutationError = null;
      try { converted = figma.createTextPath(base, request.segment, request.position); converted.fontName = { family: request.fontFamily, style: request.fontStyle }; converted.characters = request.text; } catch (error) { mutationError = error; }
      try {
        const fresh = await figma.getNodeByIdAsync(request.nodeId); if (!fresh) throw new Error('Fresh Text Path is unavailable.');
        const start = json(fresh.textPathStartData, 'Fresh Text Path start data');
        if (fresh.id !== request.nodeId || fresh.type !== 'TEXT_PATH' || fresh.characters !== request.text || start.segment !== request.segment || start.position !== request.position) throw new Error('Fresh Text Path does not match the requested state.');
        const result = { ...nodeFacts(fresh), characters: fresh.characters, textPathStartData: start };
        return success('converted', result, 1, mutationError ? 'verified-after-error' : 'verified', mutationError ? ['The native Text Path operation reported an error, but fresh readback proved the requested state.'] : []);
      } catch (error) { mutationError ||= error; }
      try { const fresh = await figma.getNodeByIdAsync(request.nodeId); if (!fresh) return failed('verification-unavailable', mutationError); return failed(fresh.type === beforeType ? 'unchanged' : 'partial-residue', mutationError, fresh.type === beforeType ? [] : [request.nodeId]); }
      catch (error) { return failed('verification-unavailable', mutationError || error); }
    }
    if (request.action === 'transform-group') {
      let nodes; let parent; let snapshots;
      try {
        if (typeof figma.transformGroup !== 'function') throw new Error('Transform Group API is unavailable.');
        nodes = []; snapshots = [];
        for (const id of request.nodeIds) {
          const node = await figma.getNodeByIdAsync(id); if (!node || !('x' in node) || !node.parent || !Array.isArray(node.parent.children) || typeof node.parent.insertChild !== 'function') throw new Error('A Transform Group source is not a reparentable Scene node.');
          const index = node.parent.children.indexOf(node); if (index < 0) throw new Error('A Transform Group source is absent from its parent.');
          nodes.push(node); snapshots.push({ node, parent: node.parent, index, x: node.x, y: node.y });
        }
        parent = request.parentId ? await figma.getNodeByIdAsync(request.parentId) : figma.currentPage;
        if (!parent || !Array.isArray(parent.children)) throw new Error('Transform Group parent cannot contain children.');
        const insertionIndex = request.index === null ? parent.children.length : request.index;
        if (insertionIndex > parent.children.length) throw new Error('Transform Group index is outside the parent.');
      } catch (error) { return refusal(error); }
      const insertionIndex = request.index === null ? parent.children.length : request.index;
      let group = null; let mutationError = null;
      try { group = figma.transformGroup(nodes, parent, insertionIndex, request.modifiers); } catch (error) { mutationError = error; }
      try {
        if (!group || typeof group.id !== 'string') throw mutationError || new Error('Transform Group returned no identity.');
        const fresh = await figma.getNodeByIdAsync(group.id); if (!fresh || fresh.type !== 'TRANSFORM_GROUP' || !Array.isArray(fresh.children)) throw new Error('Fresh Transform Group is unavailable.');
        const childIds = fresh.children.map((child) => child.id);
        if (!same(childIds, request.nodeIds) || !same(json(fresh.transformModifiers, 'Fresh Transform modifiers'), request.modifiers)) throw new Error('Fresh Transform Group does not match the requested state.');
        return success('created', { ...nodeFacts(fresh), childIds, transformModifiers: json(fresh.transformModifiers, 'Transform modifiers') }, 1, mutationError ? 'verified-after-error' : 'verified', mutationError ? ['The native Transform Group operation reported an error, but fresh readback proved the requested state.'] : []);
      } catch (error) { mutationError ||= error; }
      if (!group) return failed('verification-unavailable', mutationError);
      try {
        const ordered = [...snapshots].sort((left, right) => left.parent === right.parent ? left.index - right.index : 0);
        for (const snapshot of ordered) { const groupIndex = snapshot.parent.children.indexOf(group); const offset = groupIndex >= 0 && groupIndex <= snapshot.index ? 1 : 0; snapshot.parent.insertChild(Math.min(snapshot.index + offset, snapshot.parent.children.length), snapshot.node); snapshot.node.x = snapshot.x; snapshot.node.y = snapshot.y; }
        if (typeof group.remove !== 'function') throw new Error('Transform Group cannot be removed during rollback.');
        group.remove();
        const groupAbsent = !(await figma.getNodeByIdAsync(group.id));
        const restored = groupAbsent && snapshots.every((snapshot) => snapshot.node.parent === snapshot.parent && snapshot.parent.children.indexOf(snapshot.node) === snapshot.index && snapshot.node.x === snapshot.x && snapshot.node.y === snapshot.y);
        return failed(restored ? 'rolled-back' : 'partial-residue', mutationError, restored ? [] : [clean(group.id, 512)]);
      } catch (error) { return failed('partial-residue', mutationError || error, [clean(group.id, 512)]); }
    }
    let node; let before; let desired; let fieldName; let write; let resultFrom; let restorable = true;
    try {
      node = await figma.getNodeByIdAsync(request.nodeId); if (!node) throw new Error('Draw target node was not found.');
      if (request.action === 'brush') {
        if (!('complexStrokeProperties' in node)) throw new Error('Target does not support complex strokes.');
        before = json(node.complexStrokeProperties, 'Complex stroke snapshot'); desired = request.properties; fieldName = 'complexStrokeProperties';
        if (desired.type === 'BRUSH') { if (typeof figma.loadBrushesAsync !== 'function') throw new Error('Brush loading is unavailable.'); await figma.loadBrushesAsync(desired.brushType); }
        write = async (value) => { node.complexStrokeProperties = value; };
        resultFrom = (fresh, after) => ({ id: clean(fresh.id, 512), name: clean(String(fresh.name || ''), 1024), before, after });
      } else if (request.action === 'stroke-profile') {
        if (!('variableWidthStrokeProperties' in node)) throw new Error('Target does not support variable-width strokes.');
        before = json(node.variableWidthStrokeProperties, 'Variable-width stroke snapshot'); desired = request.value; fieldName = 'variableWidthStrokeProperties';
        write = async (value) => { node.variableWidthStrokeProperties = value; };
        resultFrom = (fresh, after) => ({ id: clean(fresh.id, 512), name: clean(String(fresh.name || ''), 1024), before, after });
      } else {
        const source = await figma.getNodeByIdAsync(request.sourceNodeId); if (!source || !('x' in source)) throw new Error('Pattern source Scene node was not found.');
        fieldName = request.field === 'fill' ? 'fills' : 'strokes'; const method = request.field === 'fill' ? 'setFillsAsync' : 'setStrokesAsync';
        if (typeof node[method] !== 'function') throw new Error('Target does not support asynchronous Pattern paints.');
        restorable = node[fieldName] !== figma.mixed; before = restorable ? json(node[fieldName], 'Pattern paint snapshot') : [];
        const paint = { type: 'PATTERN', sourceNodeId: request.sourceNodeId, tileType: request.tileType, scalingFactor: request.scalingFactor, spacing: { x: request.spacingX, y: request.spacingY }, horizontalAlignment: request.alignment };
        desired = request.replace ? [paint] : [...(before || []), paint];
        write = async (value) => node[method](value);
        resultFrom = (fresh, after) => ({ id: clean(fresh.id, 512), name: clean(String(fresh.name || ''), 1024), field: request.field, pattern: paint, count: after.length });
      }
    } catch (error) { return refusal(error); }
    if (restorable && same(before, desired)) return success('applied', resultFrom(node, before), 0);
    let mutationError = null;
    try { await write(desired); } catch (error) { mutationError = error; }
    try {
      const fresh = await figma.getNodeByIdAsync(request.nodeId); if (!fresh || !(fieldName in fresh) || fresh[fieldName] === figma.mixed) throw new Error('Fresh Draw target is unavailable.');
      const after = json(fresh[fieldName], 'Fresh Draw field');
      if (!same(after, desired)) throw new Error('Fresh Draw field does not match the requested state.');
      return success('applied', resultFrom(fresh, after), 1, mutationError ? 'verified-after-error' : 'verified', mutationError ? ['The native Draw write reported an error, but fresh readback proved the requested state.'] : []);
    } catch (error) { mutationError ||= error; }
    if (!restorable) return failed('partial-residue', mutationError, [fieldName]);
    try {
      await write(before); const restoredNode = await figma.getNodeByIdAsync(request.nodeId); const restored = restoredNode && fieldName in restoredNode && restoredNode[fieldName] !== figma.mixed && same(json(restoredNode[fieldName], 'Restored Draw field'), before);
      return failed(restored ? 'rolled-back' : 'partial-residue', mutationError, restored ? [] : [fieldName]);
    } catch (error) { return failed('partial-residue', mutationError || error, [fieldName]); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
function jsonValue(value, depth, state) {
  state.values += 1; if (state.values > MAX_DRAW_JSON_VALUES || depth > MAX_DRAW_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_DRAW_TEXT_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= MAX_DRAW_JSON_ENTRIES && value.every((item) => jsonValue(item, depth + 1, state));
  const keys = Object.keys(value); return Object.getPrototypeOf(value) === Object.prototype && keys.length <= MAX_DRAW_JSON_ENTRIES && keys.every((key) => text(key, 256, false) && jsonValue(value[key], depth + 1, state));
}
const validJson = (value) => jsonValue(value, 0, { values: 0 });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function validResult(value, input) {
  if (!value || !validJson(value) || value.id === undefined || !text(value.id, 512, false) || !text(value.name, 1024) || !text(value.type ?? '', 64)) return false;
  if (input.action === 'inspect') return value.id === input.nodeId;
  if (input.action === 'text-path') return value.id === input.nodeId && value.type === 'TEXT_PATH' && value.characters === input.text && value.textPathStartData?.segment === input.segment && value.textPathStartData?.position === input.position;
  if (input.action === 'transform-group') return value.type === 'TRANSFORM_GROUP' && same(value.childIds, input.nodeIds) && same(value.transformModifiers, input.modifiers);
  if (value.id !== input.nodeId) return false;
  if (input.action === 'brush') return same(value.after, input.properties) && Object.hasOwn(value, 'before');
  if (input.action === 'stroke-profile') return same(value.after, input.value) && Object.hasOwn(value, 'before');
  const paint = value.pattern;
  return value.field === input.field && Number.isSafeInteger(value.count) && value.count >= 1 && paint?.type === 'PATTERN' && paint.sourceNodeId === input.sourceNodeId && paint.tileType === input.tileType && paint.scalingFactor === input.scalingFactor && paint.spacing?.x === input.spacingX && paint.spacing?.y === input.spacingY && paint.horizontalAlignment === input.alignment;
}
function validRefusal(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validFailure(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','residue','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action && ['unchanged','rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && Array.isArray(value.residue) && value.residue.length <= 256 && value.residue.every((item) => text(item, 512, false)) && text(value.failure, 1024, false) && (value.outcome === 'rolled-back' ? value.restored === 1 && !value.residue.length : value.restored === 0) && (value.outcome === 'unchanged' ? !value.residue.length : true); }
function validSuccess(value, input) { const expectedStatus = input.action === 'inspect' ? 'inspected' : input.action === 'text-path' ? 'converted' : input.action === 'transform-group' ? 'created' : 'applied'; return exact(value, ['schemaVersion','status','action','outcome','attempted','result','residue','warnings']) && value.schemaVersion === 1 && ['inspected','converted','created','applied'].includes(value.status) && value.action === input.action && ['verified','verified-after-error','no-op'].includes(value.outcome) && [0,1].includes(value.attempted) && validResult(value.result, input) && Array.isArray(value.residue) && !value.residue.length && Array.isArray(value.warnings) && value.warnings.every((warning) => text(warning, 1024, false)) && value.status === expectedStatus && (input.action === 'inspect' ? value.outcome === 'verified' && value.attempted === 0 : value.outcome === 'no-op' ? value.attempted === 0 : value.attempted === 1); }
function commandError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function readError(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function safe(value) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }

export async function executeDrawCommand(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Draw Command requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(drawCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_DRAW_RESULT_CODE_UNITS) throw invalid('Draw Command returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Draw Command returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) throw invalid('Draw Command returned an invalid bounded result.');
    if (input.action === 'inspect') throw readError(`Draw inspection failed: ${payload.failure}`);
    throw commandError(`Draw Command made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw invalid('Draw Command returned an invalid bounded result.');
    throw commandError(`Draw Command failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw invalid('Draw Command returned an invalid bounded result.');
  return { stdout: safe(payload.result), stderr: '', result: payload };
}
export function drawCommandPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Draw Command routing requires a Command Plan.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-draw-command'; }
export function executeDrawCommandPlan(plan, adapters = {}) { if (drawCommandPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Draw Command.'); return executeDrawCommand(parseDrawRequest(plan.argv), adapters); }
export function isDrawWriteAction(action) { return DRAW_WRITE_ACTIONS.includes(action); }
