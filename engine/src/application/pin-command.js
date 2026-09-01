// Plan-bound, preflighted, rollback-owned edge pinning Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_PIN_TARGETS,
  parsePinRequest,
  pinArgvFromRequest,
  pinPlanningArgvFromRequest,
} from './pin-request.js';

export { pinArgvFromRequest, pinPlanningArgvFromRequest } from './pin-request.js';

const APPLICATION_ID = 'pin';
export const MAX_PIN_RESULT_CODE_UNITS = 2_000_000;
const EPSILON = 0.01;

function normalized(request) { return parsePinRequest(pinArgvFromRequest(request)); }
export function pinCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${JSON.stringify(input)};
    const maxTargets = ${MAX_PIN_TARGETS};
    const maxCoordinate = ${MAX_ABSOLUTE_NODE_COORDINATE};
    const epsilon = ${EPSILON};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (value) => { const serialized = JSON.stringify(value); if (serialized.length > ${MAX_PIN_RESULT_CODE_UNITS}) throw new Error('Pin result exceeded its bounded response limit.'); return serialized; };
    const refusal = (failure) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(failure && failure.message ? failure.message : String(failure), 1024) });
    const close = (left, right) => Math.abs(left - right) <= epsilon;
    const constraints = (value) => value && ['MIN','CENTER','MAX','STRETCH','SCALE'].includes(value.horizontal) && ['MIN','CENTER','MAX','STRETCH','SCALE'].includes(value.vertical) ? { horizontal: value.horizontal, vertical: value.vertical } : null;
    const geometry = (node) => ({ x: node.x, y: node.y, width: node.width, height: node.height, constraints: constraints(node.constraints) });
    const finiteGeometry = (value) => value && value.constraints && [value.x,value.y,value.width,value.height].every(Number.isFinite) && value.width >= 0 && value.height >= 0 && [value.x,value.y,value.width,value.height].every((item) => Math.abs(item) <= maxCoordinate);
    const metric = (raw, parentSize, scale) => { if (raw == null) return 0; const number = parseFloat(raw); return scale && raw.endsWith('%') ? number / 100 : scale ? number / parentSize : number; };
    const desired = (before, parent) => {
      const next = { ...before, constraints: { ...before.constraints } }; const edge = request.edge;
      const sx = metric(request.start, parent.width, edge === 'scale-x'); const ex = metric(request.end, parent.width, edge === 'scale-x');
      const sy = metric(request.start, parent.height, edge === 'scale-y'); const ey = metric(request.end, parent.height, edge === 'scale-y');
      if (edge === 'left') { next.x = request.offsetX; next.constraints.horizontal = 'MIN'; }
      else if (edge === 'right') { next.x = parent.width - before.width - request.offsetX; next.constraints.horizontal = 'MAX'; }
      else if (edge === 'top') { next.y = request.offsetY; next.constraints.vertical = 'MIN'; }
      else if (edge === 'bottom') { next.y = parent.height - before.height - request.offsetY; next.constraints.vertical = 'MAX'; }
      else if (edge === 'top-left') { next.x = request.offsetX; next.y = request.offsetY; next.constraints.horizontal = 'MIN'; next.constraints.vertical = 'MIN'; }
      else if (edge === 'top-right') { next.x = parent.width - before.width - request.offsetX; next.y = request.offsetY; next.constraints.horizontal = 'MAX'; next.constraints.vertical = 'MIN'; }
      else if (edge === 'bottom-left') { next.x = request.offsetX; next.y = parent.height - before.height - request.offsetY; next.constraints.horizontal = 'MIN'; next.constraints.vertical = 'MAX'; }
      else if (edge === 'bottom-right') { next.x = parent.width - before.width - request.offsetX; next.y = parent.height - before.height - request.offsetY; next.constraints.horizontal = 'MAX'; next.constraints.vertical = 'MAX'; }
      else if (edge === 'center-x') { next.x = (parent.width - before.width) / 2 + request.offsetX; next.constraints.horizontal = 'CENTER'; }
      else if (edge === 'center-y') { next.y = (parent.height - before.height) / 2 + request.offsetY; next.constraints.vertical = 'CENTER'; }
      else if (edge === 'stretch-x') { next.x = sx; next.width = Math.max(1, parent.width - sx - ex); next.constraints.horizontal = 'STRETCH'; }
      else if (edge === 'stretch-y') { next.y = sy; next.height = Math.max(1, parent.height - sy - ey); next.constraints.vertical = 'STRETCH'; }
      else if (edge === 'scale-x') { next.x = parent.width * sx; next.width = Math.max(1, parent.width - next.x - parent.width * ex); next.constraints.horizontal = 'SCALE'; }
      else if (edge === 'scale-y') { next.y = parent.height * sy; next.height = Math.max(1, parent.height - next.y - parent.height * ey); next.constraints.vertical = 'SCALE'; }
      return next;
    };
    const matches = (actual, expected) => finiteGeometry(actual) && close(actual.x, expected.x) && close(actual.y, expected.y) && close(actual.width, expected.width) && close(actual.height, expected.height) && actual.constraints.horizontal === expected.constraints.horizontal && actual.constraints.vertical === expected.constraints.vertical;
    let nodes;
    try {
      if (request.selector.kind === 'nodes') {
        const resolved = await Promise.all(request.selector.nodeIds.map((id) => figma.getNodeByIdAsync(id)));
        if (resolved.some((node) => !node)) throw new Error('Pin could not resolve every exact node id.');
        nodes = resolved;
      } else if (request.selector.kind === 'query') {
        const needle = request.selector.query.toLowerCase(); let matchesSeen = 0;
        nodes = figma.currentPage.findAll((node) => { const hit = typeof node.name === 'string' && node.name.toLowerCase().includes(needle); if (hit && ++matchesSeen > maxTargets) throw new Error('Pin query matched too many nodes. Use exact --node ids.'); return hit; });
      } else nodes = Array.from(figma.currentPage.selection || []);
      const unique = new Map(nodes.map((node) => [node && node.id, node])); nodes = [...unique.values()];
      if (nodes.length > maxTargets) throw new Error('Pin target count exceeds the bounded mutation limit.');
      if (!nodes.length) return bounded({ schemaVersion: 1, status: 'unchanged', outcome: 'no-mutation', attempted: 0, edge: request.edge, nodes: [], residue: [], warnings: [] });
    } catch (error) { return refusal(error); }
    const snapshots = [];
    try {
      for (const node of nodes) {
        if (!node || typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.type !== 'string' || !node.parent || typeof node.parent.id !== 'string') throw new Error('Pin requires exact canvas-node identities with parents.');
        const before = geometry(node); const parent = { id: node.parent.id, width: node.parent.width, height: node.parent.height };
        if (!finiteGeometry(before) || !Number.isFinite(parent.width) || !Number.isFinite(parent.height) || parent.width < 0 || parent.height < 0 || Math.abs(parent.width) > maxCoordinate || Math.abs(parent.height) > maxCoordinate) throw new Error('Pin encountered invalid bounded geometry.');
        if ((request.edge === 'scale-x' && parent.width <= 0) || (request.edge === 'scale-y' && parent.height <= 0)) throw new Error('Scale pinning requires a positive parent dimension.');
        const expected = desired(before, parent);
        if (!finiteGeometry(expected)) throw new Error('Pin request produces geometry outside the bounded coordinate range.');
        if ((expected.width !== before.width || expected.height !== before.height) && typeof node.resize !== 'function') throw new Error('Stretch and scale pinning require resizable nodes.');
        snapshots.push({ node, id: node.id, name: clean(node.name, 1024), type: clean(node.type, 64), parent, before, expected });
      }
    } catch (error) { return refusal(error); }
    let attempted = 0; let failure = 'Pin could not freshly verify the complete requested state.'; let mutationError = false;
    try {
      for (const snapshot of snapshots) {
        attempted++;
        const { node, before, expected } = snapshot;
        if (!close(node.width, expected.width) || !close(node.height, expected.height)) node.resize(expected.width, expected.height);
        if (!close(node.x, expected.x)) node.x = expected.x;
        if (!close(node.y, expected.y)) node.y = expected.y;
        if (before.constraints.horizontal !== expected.constraints.horizontal || before.constraints.vertical !== expected.constraints.vertical) node.constraints = { ...expected.constraints };
      }
    } catch (error) { mutationError = true; failure = clean(error && error.message ? error.message : String(error), 1024); }
    try {
      const reports = [];
      for (const snapshot of snapshots) {
        const fresh = await figma.getNodeByIdAsync(snapshot.id); if (!fresh) throw new Error('Pin verification target is unavailable.');
        const actual = geometry(fresh); if (!matches(actual, snapshot.expected)) throw new Error('Pin fresh readback does not match the requested state.');
        reports.push({ id: snapshot.id, name: snapshot.name, type: snapshot.type, parent: snapshot.parent, before: snapshot.before, actual });
      }
      delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'pinned', outcome: mutationError ? 'verified-after-error' : 'verified', attempted: snapshots.length, edge: request.edge, nodes: reports, residue: [], warnings: mutationError ? ['A native pin operation reported an error, but fresh readback proved the requested state.'] : [] });
    } catch (error) { if (!mutationError) failure = clean(error && error.message ? error.message : String(error), 1024); }
    try {
      for (const snapshot of snapshots.slice(0, attempted).reverse()) {
        const node = await figma.getNodeByIdAsync(snapshot.id); if (!node) continue;
        try { if (!close(node.width, snapshot.before.width) || !close(node.height, snapshot.before.height)) node.resize(snapshot.before.width, snapshot.before.height); } catch {}
        try { node.x = snapshot.before.x; } catch {} try { node.y = snapshot.before.y; } catch {} try { node.constraints = { ...snapshot.before.constraints }; } catch {}
      }
      const residue = [];
      for (const snapshot of snapshots.slice(0, attempted)) { const node = await figma.getNodeByIdAsync(snapshot.id); if (!node || !matches(geometry(node), snapshot.before)) residue.push(snapshot.id); }
      if (!residue.length) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: residue.length ? 'partial-residue' : 'rolled-back', attempted, restored: attempted - residue.length, failure, residue });
    } catch { return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted, restored: 0, failure, residue: [] }); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE;
const validConstraints = (value) => exact(value, ['horizontal','vertical']) && ['MIN','CENTER','MAX','STRETCH','SCALE'].includes(value.horizontal) && ['MIN','CENTER','MAX','STRETCH','SCALE'].includes(value.vertical);
const validGeometry = (value) => exact(value, ['x','y','width','height','constraints']) && [value.x,value.y,value.width,value.height].every(finite) && value.width >= 0 && value.height >= 0 && validConstraints(value.constraints);
const close = (a,b) => Math.abs(a-b) <= EPSILON;
function metric(raw, parentSize, scale) { if (raw == null) return 0; const number = parseFloat(raw); return scale && raw.endsWith('%') ? number / 100 : scale ? number / parentSize : number; }
function expected(input, before, parent) {
  const next = { ...before, constraints: { ...before.constraints } }; const edge = input.edge;
  const sx = metric(input.start,parent.width,edge==='scale-x'); const ex = metric(input.end,parent.width,edge==='scale-x'); const sy = metric(input.start,parent.height,edge==='scale-y'); const ey = metric(input.end,parent.height,edge==='scale-y');
  if(edge==='left'){next.x=input.offsetX;next.constraints.horizontal='MIN';}else if(edge==='right'){next.x=parent.width-before.width-input.offsetX;next.constraints.horizontal='MAX';}else if(edge==='top'){next.y=input.offsetY;next.constraints.vertical='MIN';}else if(edge==='bottom'){next.y=parent.height-before.height-input.offsetY;next.constraints.vertical='MAX';}else if(edge==='top-left'){next.x=input.offsetX;next.y=input.offsetY;next.constraints.horizontal='MIN';next.constraints.vertical='MIN';}else if(edge==='top-right'){next.x=parent.width-before.width-input.offsetX;next.y=input.offsetY;next.constraints.horizontal='MAX';next.constraints.vertical='MIN';}else if(edge==='bottom-left'){next.x=input.offsetX;next.y=parent.height-before.height-input.offsetY;next.constraints.horizontal='MIN';next.constraints.vertical='MAX';}else if(edge==='bottom-right'){next.x=parent.width-before.width-input.offsetX;next.y=parent.height-before.height-input.offsetY;next.constraints.horizontal='MAX';next.constraints.vertical='MAX';}else if(edge==='center-x'){next.x=(parent.width-before.width)/2+input.offsetX;next.constraints.horizontal='CENTER';}else if(edge==='center-y'){next.y=(parent.height-before.height)/2+input.offsetY;next.constraints.vertical='CENTER';}else if(edge==='stretch-x'){next.x=sx;next.width=Math.max(1,parent.width-sx-ex);next.constraints.horizontal='STRETCH';}else if(edge==='stretch-y'){next.y=sy;next.height=Math.max(1,parent.height-sy-ey);next.constraints.vertical='STRETCH';}else if(edge==='scale-x'){next.x=parent.width*sx;next.width=Math.max(1,parent.width-next.x-parent.width*ex);next.constraints.horizontal='SCALE';}else if(edge==='scale-y'){next.y=parent.height*sy;next.height=Math.max(1,parent.height-next.y-parent.height*ey);next.constraints.vertical='SCALE';} return next;
}
function same(a,b){return validGeometry(a)&&close(a.x,b.x)&&close(a.y,b.y)&&close(a.width,b.width)&&close(a.height,b.height)&&a.constraints.horizontal===b.constraints.horizontal&&a.constraints.vertical===b.constraints.vertical;}
function validNode(value,input){if(!exact(value,['id','name','type','parent','before','actual'])||typeof value.id!=='string'||!NODE_REFERENCE_PATTERN.test(value.id)||typeof value.name!=='string'||value.name.length>1024||typeof value.type!=='string'||value.type.length>64||!exact(value.parent,['id','width','height'])||typeof value.parent.id!=='string'||!NODE_REFERENCE_PATTERN.test(value.parent.id)||!finite(value.parent.width)||!finite(value.parent.height)||value.parent.width<0||value.parent.height<0||!validGeometry(value.before)||!validGeometry(value.actual))return false;return same(value.actual,expected(input,value.before,value.parent));}
function validRefusal(value){return exact(value,['schemaVersion','status','outcome','attempted','failure'])&&value.schemaVersion===1&&value.status==='refused'&&value.outcome==='no-mutation'&&value.attempted===0&&typeof value.failure==='string'&&value.failure.length>0&&value.failure.length<=1024;}
function validSuccess(value,input){if(!exact(value,['schemaVersion','status','outcome','attempted','edge','nodes','residue','warnings'])||value.schemaVersion!==1||!['pinned','unchanged'].includes(value.status)||!['verified','verified-after-error','no-mutation'].includes(value.outcome)||value.edge!==input.edge||!Number.isSafeInteger(value.attempted)||value.attempted<0||value.attempted>MAX_PIN_TARGETS||!Array.isArray(value.nodes)||value.nodes.length>MAX_PIN_TARGETS||!Array.isArray(value.residue)||value.residue.length||!Array.isArray(value.warnings)||value.warnings.length>1)return false;if(value.status==='unchanged')return value.outcome==='no-mutation'&&value.attempted===0&&value.nodes.length===0&&value.warnings.length===0;if(value.attempted!==value.nodes.length||!value.nodes.every((node)=>validNode(node,input))||new Set(value.nodes.map((node)=>node.id)).size!==value.nodes.length)return false;if(input.selector.kind==='nodes'&&(input.selector.nodeIds.length!==value.nodes.length||input.selector.nodeIds.some((id)=>!value.nodes.some((node)=>node.id===id))))return false;return value.outcome==='verified-after-error'?value.warnings.length===1:value.outcome==='verified'&&value.warnings.length===0;}
function validFailure(value,input){if(!exact(value,['schemaVersion','status','outcome','attempted','restored','failure','residue'])||value.schemaVersion!==1||value.status!=='failed'||!['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)||!Number.isSafeInteger(value.attempted)||value.attempted<1||value.attempted>MAX_PIN_TARGETS||!Number.isSafeInteger(value.restored)||value.restored<0||value.restored>value.attempted||typeof value.failure!=='string'||value.failure.length<1||value.failure.length>1024||!Array.isArray(value.residue)||value.residue.length>value.attempted||value.residue.some((id)=>typeof id!=='string'||!NODE_REFERENCE_PATTERN.test(id))||new Set(value.residue).size!==value.residue.length)return false;if(input.selector.kind==='nodes'&&value.residue.some((id)=>!input.selector.nodeIds.includes(id)))return false;if(value.outcome==='rolled-back')return value.restored===value.attempted&&value.residue.length===0;if(value.outcome==='partial-residue')return value.residue.length>0&&value.restored===value.attempted-value.residue.length;return value.restored===0&&value.residue.length===0;}
function invalid(message){const error=new Error(message);Object.assign(error,{kind:'plugin-result',phase:'plugin-response',outcome:'unknown-after-dispatch',dispatchState:'failed'});return error;}
function mutationError(message,outcome,report){const error=new Error(message);Object.assign(error,{kind:'execution',phase:'plugin-execution',outcome:'unknown-after-dispatch',dispatchState:'failed',mutationOutcome:outcome,mutationReport:report});return error;}
export async function executePin(request,adapters={}){if(typeof adapters.evaluate!=='function')throw new TypeError('Pin requires a Figma evaluate adapter.');const input=normalized(request);const serialized=await adapters.evaluate(pinCode(input));if(typeof serialized!=='string'||serialized.length>MAX_PIN_RESULT_CODE_UNITS)throw invalid('Pin returned an invalid bounded result.');let payload;try{payload=JSON.parse(serialized);}catch{throw invalid('Pin returned invalid JSON.');}if(payload?.status==='refused'){if(!validRefusal(payload))throw invalid('Pin returned an invalid bounded result.');throw mutationError(`Pin made no mutation: ${payload.failure}`,'no-mutation',{version:1,outcome:'no-mutation',attempted:0,restored:0,residueCount:0});}if(payload?.status==='failed'){if(!validFailure(payload,input))throw invalid('Pin returned an invalid bounded result.');throw mutationError(`Pin failed with ${payload.outcome}: ${payload.failure}`,payload.outcome,{version:1,outcome:payload.outcome,attempted:payload.attempted,restored:payload.restored,residueCount:payload.residue.length});}if(!validSuccess(payload,input))throw invalid('Pin returned an invalid bounded result.');return{stdout:payload.status==='unchanged'?'No node found':`Pinned ${payload.nodes.length} element(s) to ${payload.edge}`,stderr:payload.warnings.join('\n'),result:payload};}
export function pinPlanRoute(plan){if(!isFigmaCommandPlan(plan))throw new TypeError('Pin routing requires a Command Plan created by the Capability Catalog.');return plan.allowed&&plan.id===APPLICATION_ID?'command-application':'not-pin';}
export function executePinPlan(plan,adapters={}){if(pinPlanRoute(plan)!=='command-application')throw new Error(`Command Plan ${plan?.id||'(unknown)'} is not owned by Pin.`);return executePin(parsePinRequest(plan.argv),adapters);}
