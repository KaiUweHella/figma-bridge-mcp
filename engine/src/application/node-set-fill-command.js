import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import { MAX_NODE_SET_FILL_QUERY_CODE_UNITS, nodeSetFillArgvFromRequest, nodeSetFillPlanningArgvFromRequest, parseNodeSetFillRequest } from './node-set-fill-request.js';

export { nodeSetFillArgvFromRequest, nodeSetFillPlanningArgvFromRequest } from './node-set-fill-request.js';
const APPLICATION_ID = 'node.set-fill';
export const MAX_NODE_SET_FILL_CANDIDATES = 100_000;
export const MAX_NODE_SET_FILL_PAINTS = 10_000;
export const MAX_NODE_SET_FILL_SNAPSHOT_CODE_UNITS = 262_144;
export const MAX_NODE_SET_FILL_RESULT_CODE_UNITS = 65_536;
const MAX_ID = 1024;
const normalized = (request) => parseNodeSetFillRequest(nodeSetFillArgvFromRequest(request));
function js(value) { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

export function nodeSetFillCode(request) {
  const input = normalized(request);
  const hex = input.kind === 'literal' ? input.color.slice(1) : null;
  const rgb = hex === null ? null : [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  return `(async () => {
    const nodeId = ${js(input.nodeId)}; const color = ${js(input.color)}; const kind = ${js(input.kind)};
    const variableQuery = ${js(input.variable)}; const expectedRgb = ${js(rgb)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_NODE_SET_FILL_RESULT_CODE_UNITS}) throw new Error('Node Set Fill result exceeded its bounded response limit.'); return value; };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const aliasId = (paint) => { const alias = paint && paint.boundVariables && paint.boundVariables.color; return alias === undefined || alias === null ? null : alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' && alias.id.length <= ${MAX_ID} ? alias.id : false; };
    const close = (left, right) => typeof left === 'number' && Math.abs(left - right) <= 1e-6;
    const defaultPresentation = (paint) => (paint.opacity === undefined || close(paint.opacity, 1)) && (paint.visible === undefined || paint.visible === true) && (paint.blendMode === undefined || paint.blendMode === 'NORMAL');
    let node, before, beforeJson, variable = null, collection = null;
    try {
      node = await figma.getNodeByIdAsync(nodeId);
      if (!node || node.id !== nodeId || node.type === 'DOCUMENT' || node.type === 'PAGE' || typeof node.name !== 'string' || !('fills' in node)) throw new Error('Node Set Fill requires one exact fill-capable canvas Node.');
      before = node.fills;
      if (!Array.isArray(before) || before.length > ${MAX_NODE_SET_FILL_PAINTS}) throw new Error('Node Set Fill requires one bounded non-mixed Paint list.');
      beforeJson = JSON.stringify(before);
      if (typeof beforeJson !== 'string' || beforeJson.length > ${MAX_NODE_SET_FILL_SNAPSHOT_CODE_UNITS}) throw new Error('Node Set Fill rollback snapshot exceeds its bounded limit.');
      if (kind === 'variable') {
        const variables = await figma.variables.getLocalVariablesAsync(); const collections = await figma.variables.getLocalVariableCollectionsAsync();
        if (!Array.isArray(variables) || variables.length > ${MAX_NODE_SET_FILL_CANDIDATES} || !Array.isArray(collections) || collections.length > ${MAX_NODE_SET_FILL_CANDIDATES}) throw new Error('Node Set Fill Variable candidate limit exceeded.');
        const matches = variables.filter((item) => item && item.remote === false && item.name === variableQuery);
        if (matches.length !== 1) throw new Error(matches.length ? 'Color Variable reference is ambiguous; use node bind --collection.' : 'Color Variable not found.');
        variable = matches[0]; collection = collections.find((item) => item && item.id === variable.variableCollectionId);
        if (typeof variable.id !== 'string' || variable.id.length > ${MAX_ID} || variable.resolvedType !== 'COLOR' || !collection || typeof collection.id !== 'string' || collection.id.length > ${MAX_ID} || typeof collection.name !== 'string' || collection.name.length > ${MAX_NODE_SET_FILL_QUERY_CODE_UNITS}) throw new Error('Color Variable metadata is incompatible.');
      }
      const current = before.length === 1 && before[0] && before[0].type === 'SOLID' ? before[0] : null;
      const currentMatches = kind === 'variable' ? current && defaultPresentation(current) && aliasId(current) === variable.id
        : current && defaultPresentation(current) && aliasId(current) === null && current.color && expectedRgb.every((value, index) => close(current.color[['r','g','b'][index]], value));
      if (currentMatches) return bounded({ schemaVersion: 1, status: 'applied', node: { id: node.id, name: clean(node.name, ${MAX_NODE_SET_FILL_QUERY_CODE_UNITS}), type: node.type }, color, kind,
        variable: variable ? { id: variable.id, name: variable.name, collection: { id: collection.id, name: collection.name } } : null, attempted: 0, residue: [] });
    } catch (error) { return refusal(error); }
    let failure = 'Node Set Fill fresh postcondition did not match the requested Paint.';
    try {
      try { node.fills = [kind === 'variable' ? figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable) : { type: 'SOLID', color: { r: expectedRgb[0], g: expectedRgb[1], b: expectedRgb[2] } }]; }
      catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      const fresh = await figma.getNodeByIdAsync(nodeId); const paint = fresh && Array.isArray(fresh.fills) && fresh.fills.length === 1 ? fresh.fills[0] : null;
      const matches = kind === 'variable' ? paint && paint.type === 'SOLID' && defaultPresentation(paint) && aliasId(paint) === variable.id
        : paint && paint.type === 'SOLID' && defaultPresentation(paint) && aliasId(paint) === null && paint.color && expectedRgb.every((value, index) => close(paint.color[['r','g','b'][index]], value));
      if (matches) { delete globalThis.__invCache; return bounded({ schemaVersion: 1, status: 'applied', node: { id: fresh.id, name: clean(fresh.name, ${MAX_NODE_SET_FILL_QUERY_CODE_UNITS}), type: fresh.type }, color, kind,
        variable: variable ? { id: variable.id, name: variable.name, collection: { id: collection.id, name: collection.name } } : null, attempted: 1, residue: [] }); }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
    try {
      node.fills = before; const fresh = await figma.getNodeByIdAsync(nodeId); const restored = Boolean(fresh && JSON.stringify(fresh.fills) === beforeJson);
      if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, failure,
        node: { id: node.id, name: clean(node.name, ${MAX_NODE_SET_FILL_QUERY_CODE_UNITS}), type: node.type }, color, kind, residue: restored ? [] : ['fills'] });
    } catch { return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure,
      node: { id: node.id, name: clean(node.name, ${MAX_NODE_SET_FILL_QUERY_CODE_UNITS}), type: node.type }, color, kind, residue: [] }); }
  })()`;
}
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function text(value, max, empty = true) { return typeof value === 'string' && value.length <= max && (empty || value.length > 0); }
function node(value, input) { return exact(value, ['id','name','type']) && value.id === input.nodeId && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name, MAX_NODE_SET_FILL_QUERY_CODE_UNITS) && text(value.type, 64, false); }
function variable(value, input) { return input.kind === 'literal' ? value === null : exact(value, ['id','name','collection']) && text(value.id, MAX_ID, false) && value.name === input.variable && exact(value.collection, ['id','name']) && text(value.collection.id, MAX_ID, false) && text(value.collection.name, MAX_NODE_SET_FILL_QUERY_CODE_UNITS); }
function validRefusal(value) { return exact(value, ['schemaVersion','status','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validSuccess(value, input) { return exact(value, ['schemaVersion','status','node','color','kind','variable','attempted','residue']) && value.schemaVersion === 1 && value.status === 'applied' && node(value.node, input) && value.color === input.color && value.kind === input.kind && variable(value.variable, input) && [0,1].includes(value.attempted) && Array.isArray(value.residue) && !value.residue.length; }
function validFailure(value, input) { return exact(value, ['schemaVersion','status','outcome','attempted','restored','failure','node','color','kind','residue']) && value.schemaVersion === 1 && value.status === 'failed' && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && text(value.failure, 1024, false) && node(value.node, input) && value.color === input.color && value.kind === input.kind && Array.isArray(value.residue) && (value.outcome === 'rolled-back' ? value.restored === 1 && !value.residue.length : value.restored === 0) && (value.outcome !== 'partial-residue' || value.residue.length === 1 && value.residue[0] === 'fills'); }
function mutationError(message, outcome, count, restored = 0) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: { version: 1, outcome, attempted: outcome === 'no-mutation' ? 0 : 1, restored, residueCount: count } }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
export function formatNodeSetFillResult(result) { return `Fill set on ${JSON.stringify(result.node.name)}: ${result.color}`; }
export async function executeNodeSetFill(request, adapters = {}) { if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Set Fill requires a Figma evaluate adapter.'); const input = normalized(request); const serialized = await adapters.evaluate(nodeSetFillCode(input)); if (typeof serialized !== 'string' || serialized.length > MAX_NODE_SET_FILL_RESULT_CODE_UNITS) throw invalid('Node Set Fill returned an invalid bounded result.'); let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Node Set Fill returned invalid JSON.'); } if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Node Set Fill returned an invalid bounded result.'); throw mutationError(`Node Set Fill made no mutation: ${payload.failure}`, 'no-mutation', 0); } if (payload?.status === 'failed') { if (!validFailure(payload, input)) throw invalid('Node Set Fill returned an invalid bounded result.'); throw mutationError(`Node Set Fill failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, payload.residue.length, payload.restored); } if (!validSuccess(payload, input)) throw invalid('Node Set Fill returned an invalid bounded result.'); return { stdout: formatNodeSetFillResult(payload), stderr: '', result: payload }; }
export function nodeSetFillPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Set Fill routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-set-fill'; }
export async function executeNodeSetFillPlan(plan, adapters = {}) { if (nodeSetFillPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Set Fill.`); return executeNodeSetFill(parseNodeSetFillRequest(plan.argv), adapters); }
