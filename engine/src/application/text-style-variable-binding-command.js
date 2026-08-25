// Preflighted, rollback-owned Text Style variable binding Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseTextStyleVariableBindingRequest, textStyleVariableBindingArgvFromRequest,
  textStyleVariableBindingPlanningArgvFromRequest,
} from './text-style-variable-binding-request.js';

export { textStyleVariableBindingArgvFromRequest, textStyleVariableBindingPlanningArgvFromRequest } from './text-style-variable-binding-request.js';

const IDS = new Set(['style.bind-font', 'style.unbind-font']);
export const MAX_TEXT_STYLE_BINDING_CANDIDATES = 20_000;
export const MAX_TEXT_STYLE_BINDING_SERIALIZED_CODE_UNITS = 24_576;
const EXPECTED_TYPES = Object.freeze({
  fontFamily: 'STRING', fontStyle: 'STRING', fontSize: 'FLOAT', fontWeight: 'FLOAT',
  letterSpacing: 'FLOAT', lineHeight: 'FLOAT', paragraphSpacing: 'FLOAT', paragraphIndent: 'FLOAT',
});
const normalized = (request) => parseTextStyleVariableBindingRequest(textStyleVariableBindingArgvFromRequest(request));

export function textStyleVariableBindingCode(request) {
  const input = normalized(request);
  return `(async () => {
    const styleQuery = ${JSON.stringify(input.style)};
    const variableQuery = ${JSON.stringify(input.variable)};
    const field = ${JSON.stringify(input.field)};
    const expectedType = ${JSON.stringify(EXPECTED_TYPES[input.field])};
    const directStyle = await figma.getStyleByIdAsync(styleQuery);
    let style = directStyle && directStyle.type === 'TEXT' ? directStyle : null;
    let styleResolution = 'id';
    if (!style) {
      const pool = await figma.getLocalTextStylesAsync();
      if (pool.length > ${MAX_TEXT_STYLE_BINDING_CANDIDATES}) throw new Error('Text Style candidate limit exceeded.');
      const exact = pool.filter((candidate) => candidate.name === styleQuery);
      const matches = exact.length ? exact : pool.filter((candidate) => candidate.name.toLowerCase().includes(styleQuery.toLowerCase()));
      if (matches.length !== 1) throw new Error(matches.length ? 'Text Style reference is ambiguous.' : 'Text Style not found.');
      style = matches[0]; styleResolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (typeof style.id !== 'string' || typeof style.key !== 'string' || typeof style.name !== 'string'
      || style.type !== 'TEXT' || style.remote !== false || typeof style.setBoundVariable !== 'function') {
      throw new Error('Target must be one mutable local Text Style.');
    }
    const styleIdentity = { id: style.id, key: style.key, name: style.name, type: style.type, remote: false };
    let variable = null;
    let variableResolution = null;
    if (variableQuery !== null) {
      const direct = await figma.variables.getVariableByIdAsync(variableQuery);
      variable = direct && direct.remote === false ? direct : null;
      variableResolution = 'id';
      if (!variable) {
        const pool = await figma.variables.getLocalVariablesAsync();
        if (pool.length > ${MAX_TEXT_STYLE_BINDING_CANDIDATES}) throw new Error('Variable candidate limit exceeded.');
        const exact = pool.filter((candidate) => candidate.name === variableQuery);
        const matches = exact.length ? exact : pool.filter((candidate) => candidate.name.toLowerCase().includes(variableQuery.toLowerCase()));
        if (matches.length !== 1) throw new Error(matches.length ? 'Variable reference is ambiguous.' : 'Variable not found.');
        variable = matches[0]; variableResolution = exact.length ? 'exact-name' : 'partial-name';
      }
      if (typeof variable.id !== 'string' || typeof variable.name !== 'string' || variable.remote !== false
        || variable.resolvedType !== expectedType) {
        throw new Error('Variable is incompatible with Text Style field.');
      }
    }
    const priorAlias = style.boundVariables && style.boundVariables[field];
    if (priorAlias !== undefined && (!priorAlias || priorAlias.type !== 'VARIABLE_ALIAS' || typeof priorAlias.id !== 'string')) {
      throw new Error('Existing Text Style binding is incompatible.');
    }
    const priorVariable = priorAlias ? await figma.variables.getVariableByIdAsync(priorAlias.id) : null;
    if (priorAlias && !priorVariable) throw new Error('Existing Text Style binding could not be resolved for rollback.');
    const variableIdentity = (value) => value ? ({
      id: value.id, name: value.name, resolvedType: value.resolvedType, remote: value.remote,
    }) : null;
    try {
      style.setBoundVariable(field, variable);
    } catch {
      let restored = true;
      try { style.setBoundVariable(field, priorVariable); } catch { restored = false; }
      return JSON.stringify({ schemaVersion: 1, status: 'failed', action: ${JSON.stringify(input.action)},
        styleResolution, variableResolution, style: styleIdentity, field, variable: variableIdentity(variable),
        restored, residue: restored ? [] : [styleIdentity] });
    }
    return JSON.stringify({ schemaVersion: 1, status: 'applied', action: ${JSON.stringify(input.action)},
      styleResolution, variableResolution, style: styleIdentity, field, variable: variableIdentity(variable), residue: [] });
  })()`;
}

function record(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function identity(value, type = null) {
  return record(value, type ? ['id', 'name', 'resolvedType', 'remote'] : ['id', 'key', 'name', 'type', 'remote'])
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 1024
    && typeof value.name === 'string' && value.name.length <= 1024
    && (type ? value.resolvedType === type && value.remote === false
      : typeof value.key === 'string' && value.key.length <= 1024 && value.type === 'TEXT' && value.remote === false);
}
function valid(value, input) {
  const common = value.schemaVersion === 1 && value.action === input.action && value.field === input.field
    && ['id', 'exact-name', 'partial-name'].includes(value.styleResolution) && identity(value.style)
    && (input.action === 'unbind' ? value.variableResolution === null && value.variable === null
      : ['id', 'exact-name', 'partial-name'].includes(value.variableResolution) && identity(value.variable, EXPECTED_TYPES[input.field]));
  if (!common) return false;
  if ((value.styleResolution === 'id' && value.style.id !== input.style)
    || (value.styleResolution === 'exact-name' && value.style.name !== input.style)
    || (value.styleResolution === 'partial-name' && !value.style.name.toLowerCase().includes(input.style.toLowerCase()))) return false;
  if (input.action === 'bind' && ((value.variableResolution === 'id' && value.variable.id !== input.variable)
    || (value.variableResolution === 'exact-name' && value.variable.name !== input.variable)
    || (value.variableResolution === 'partial-name' && !value.variable.name.toLowerCase().includes(input.variable.toLowerCase())))) return false;
  if (value.status === 'applied') return record(value, ['schemaVersion','status','action','styleResolution','variableResolution','style','field','variable','residue']) && Array.isArray(value.residue) && value.residue.length === 0;
  return value.status === 'failed' && record(value, ['schemaVersion','status','action','styleResolution','variableResolution','style','field','variable','restored','residue'])
    && typeof value.restored === 'boolean' && Array.isArray(value.residue)
    && (value.restored ? value.residue.length === 0 : value.residue.length === 1 && identity(value.residue[0]));
}

export async function executeTextStyleVariableBinding(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Text Style binding requires evaluate(code)');
  const input = normalized(request);
  const serialized = await adapters.evaluate(textStyleVariableBindingCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_TEXT_STYLE_BINDING_SERIALIZED_CODE_UNITS) throw new Error('Text Style binding returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw new Error('Text Style binding returned invalid JSON.'); }
  if (!valid(payload, input)) throw new Error('Text Style binding returned an invalid bounded result.');
  if (payload.status === 'failed') {
    const error = new Error(payload.restored ? 'Text Style binding failed; the previous binding was restored.' : 'Text Style binding failed; the Text Style may retain residue.');
    error.kind = 'execution'; error.phase = 'plugin-execution'; error.outcome = 'unknown-after-dispatch'; error.dispatchState = 'failed';
    error.mutationOutcome = payload.restored ? 'rolled-back' : 'partial-residue'; throw error;
  }
  const facts = { style: payload.style, field: payload.field, variable: payload.variable, residue: [] };
  return { stdout: JSON.stringify(facts, null, 2), stderr: '', result: { schemaVersion: 1, status: 'applied', action: input.action, ...facts } };
}
export function textStyleVariableBindingPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Text Style binding routing requires a Command Plan.');
  return plan.allowed && IDS.has(plan.id) ? 'command-application' : 'not-text-style-binding';
}
export function executeTextStyleVariableBindingPlan(plan, adapters = {}) {
  if (textStyleVariableBindingPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Text Style binding.');
  return executeTextStyleVariableBinding(parseTextStyleVariableBindingRequest(plan.argv), adapters);
}
