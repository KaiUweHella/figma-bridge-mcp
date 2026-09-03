// Bounded Slot inspection and validation behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_SLOT_DESCRIPTION_CODE_UNITS,
  MAX_SLOT_NAME_CODE_UNITS,
  MAX_SLOT_PREFERRED_KEY_CODE_UNITS,
  MAX_SLOT_PREFERRED_VALUES,
} from './slot-configuration-request.js';
import {
  SLOT_READ_ACTIONS,
  parseSlotReadRequest,
  slotReadArgvFromRequest,
  slotReadPlanningArgvFromRequest,
} from './slot-read-request.js';

export { slotReadArgvFromRequest, slotReadPlanningArgvFromRequest } from './slot-read-request.js';
export const MAX_SLOT_READ_ITEMS = 10_000;
export const MAX_SLOT_READ_CHILDREN = 50_000;
export const MAX_SLOT_READ_RESULT_CODE_UNITS = 2_000_000;
const MAX_VARIANT_OPTIONS = 256;
const MAX_VARIABLE_ALIAS_ID_CODE_UNITS = 1_024;
const SETTING_FIELDS = Object.freeze([
  'stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren',
  'allowPreferredValuesOnly',
]);
const VIOLATIONS = Object.freeze(['BELOW_MIN', 'ABOVE_MAX', 'HAS_NON_PREFERRED']);
const APPLICATION_IDS = new Set(SLOT_READ_ACTIONS.map((action) => `slot.${action}`));
const normalized = (request) => parseSlotReadRequest(slotReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function slotReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (value) => { const serialized = JSON.stringify(value); if (serialized.length > ${MAX_SLOT_READ_RESULT_CODE_UNITS}) throw new Error('Slot Read result exceeded its bounded response limit.'); return serialized; };
    const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
    const preferred = (value) => {
      if (value === undefined || value === null) return undefined;
      if (!Array.isArray(value) || value.length > ${MAX_SLOT_PREFERRED_VALUES}) throw new Error('Slot preferred values are invalid.');
      return value.map((entry) => { if (!entry || typeof entry !== 'object' || !['COMPONENT','COMPONENT_SET'].includes(entry.type) || typeof entry.key !== 'string' || !entry.key.length || entry.key.length > ${MAX_SLOT_PREFERRED_KEY_CODE_UNITS}) throw new Error('Slot preferred value is invalid.'); return { type: entry.type, key: clean(entry.key, ${MAX_SLOT_PREFERRED_KEY_CODE_UNITS}) }; });
    };
    const settings = (value) => {
      if (value === undefined || value === null) return undefined;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Slot settings are invalid.');
      const keys = Object.keys(value); if (keys.some((key) => !${js(SETTING_FIELDS)}.includes(key))) throw new Error('Slot settings contain an unsupported field.'); const result = {};
      for (const key of ${js(SETTING_FIELDS)}) { if (!own(value, key)) continue; const setting = value[key]; if (['stretchChildOnInsert','displayEmptyByDefault','allowPreferredValuesOnly'].includes(key)) { if (typeof setting !== 'boolean') throw new Error('Slot boolean setting is invalid.'); } else if (setting !== null && (!Number.isSafeInteger(setting) || setting < 0)) throw new Error('Slot child limit is invalid.'); result[key] = setting; }
      if (result.minChildren !== undefined && result.minChildren !== null && result.maxChildren !== undefined && result.maxChildren !== null && result.minChildren > result.maxChildren) throw new Error('Slot child limits are inconsistent.'); return result;
    };
    const definition = (value) => {
      if (!value || typeof value !== 'object' || value.type !== 'SLOT'
        || value.defaultValue !== undefined
          && (typeof value.defaultValue !== 'string' || value.defaultValue.length > ${MAX_SLOT_NAME_CODE_UNITS})) throw new Error('Slot definition is invalid.');
      const result = { type: 'SLOT', defaultValue: value.defaultValue === undefined ? null : clean(value.defaultValue, ${MAX_SLOT_NAME_CODE_UNITS}) };
      const preferredValues = preferred(value.preferredValues); if (preferredValues !== undefined) result.preferredValues = preferredValues;
      if (value.variantOptions !== undefined) { if (!Array.isArray(value.variantOptions) || value.variantOptions.length > ${MAX_VARIANT_OPTIONS} || value.variantOptions.some((option) => typeof option !== 'string' || option.length > ${MAX_SLOT_NAME_CODE_UNITS})) throw new Error('Slot variant options are invalid.'); result.variantOptions = value.variantOptions.map((option) => clean(option, ${MAX_SLOT_NAME_CODE_UNITS})); }
      if (value.description !== undefined && value.description !== null) { if (typeof value.description !== 'string' || value.description.length > ${MAX_SLOT_DESCRIPTION_CODE_UNITS}) throw new Error('Slot description is invalid.'); result.description = clean(value.description, ${MAX_SLOT_DESCRIPTION_CODE_UNITS}); }
      const slotSettings = settings(value.slotSettings); if (slotSettings !== undefined) result.slotSettings = slotSettings;
      if (value.boundVariables !== undefined) { const binding = value.boundVariables; if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).some((key) => key !== 'defaultValue') || binding.defaultValue !== undefined && (binding.defaultValue.type !== 'VARIABLE_ALIAS' || typeof binding.defaultValue.id !== 'string' || !binding.defaultValue.id.length || binding.defaultValue.id.length > ${MAX_VARIABLE_ALIAS_ID_CODE_UNITS})) throw new Error('Slot Variable binding is invalid.'); result.boundVariables = binding.defaultValue === undefined ? {} : { defaultValue: { type: 'VARIABLE_ALIAS', id: clean(binding.defaultValue.id, ${MAX_VARIABLE_ALIAS_ID_CODE_UNITS}) } }; }
      return result;
    };
    const violations = (value) => { if (!Array.isArray(value) || value.length > 3 || value.some((item) => !${js(VIOLATIONS)}.includes(item)) || new Set(value).size !== value.length || value.includes('BELOW_MIN') && value.includes('ABOVE_MAX')) throw new Error('Slot limit violations are invalid.'); return [...value]; };
    const slot = (node, withType) => { if (!node || node.type !== 'SLOT' || typeof node.id !== 'string' || !node.id.length || node.id.length > 512 || typeof node.name !== 'string' || node.name.length > ${MAX_SLOT_NAME_CODE_UNITS} || !Array.isArray(node.children) || node.children.length > ${MAX_SLOT_READ_CHILDREN}) throw new Error('Slot node facts are invalid.'); return { id: clean(node.id, 512), name: clean(node.name, ${MAX_SLOT_NAME_CODE_UNITS}), ...(withType ? { type: 'SLOT' } : {}), childCount: node.children.length, limitViolations: violations(node.limitViolations || []) }; };
    if (request.action === 'inspect') {
      const node = await figma.getNodeByIdAsync(request.nodeId); if (!node) throw new Error('Node was not found in the targeted Figma document.');
      if (node.type === 'SLOT') return bounded(slot(node, true));
      if (!('componentPropertyDefinitions' in node) || !node.componentPropertyDefinitions || typeof node.componentPropertyDefinitions !== 'object' || Array.isArray(node.componentPropertyDefinitions)) throw new Error('Target is neither a Slot nor a Component.');
      const entries = Object.entries(node.componentPropertyDefinitions); if (entries.length > ${MAX_SLOT_READ_ITEMS}) throw new Error('Component exceeds the bounded property-definition count.');
      const slots = entries.filter(([, value]) => value && value.type === 'SLOT').map(([name, value]) => { if (!name.length || name.length > ${MAX_SLOT_NAME_CODE_UNITS}) throw new Error('Slot property name is invalid.'); return { name: clean(name, ${MAX_SLOT_NAME_CODE_UNITS}), definition: definition(value) }; });
      return bounded({ id: clean(node.id, 512), name: clean(String(node.name || ''), ${MAX_SLOT_NAME_CODE_UNITS}), type: clean(String(node.type || ''), 64), slots });
    }
    const root = request.nodeId ? await figma.getNodeByIdAsync(request.nodeId) : figma.currentPage; if (!root) throw new Error('Node was not found in the targeted Figma document.');
    const nodes = root.type === 'SLOT' ? [root] : typeof root.findAll === 'function' ? root.findAll((node) => node.type === 'SLOT') : [];
    if (!Array.isArray(nodes) || nodes.length > ${MAX_SLOT_READ_ITEMS}) throw new Error('Slot validation inventory exceeded its bounded item limit.');
    const slots = nodes.map((node) => slot(node, false)); if (new Set(slots.map((value) => value.id)).size !== slots.length) throw new Error('Slot ids must be unique.');
    return bounded({ valid: slots.every((value) => value.limitViolations.length === 0), slots });
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
function validPreferred(value) { return Array.isArray(value) && value.length <= MAX_SLOT_PREFERRED_VALUES && value.every((entry) => exact(entry, ['type','key']) && ['COMPONENT','COMPONENT_SET'].includes(entry.type) && text(entry.key, MAX_SLOT_PREFERRED_KEY_CODE_UNITS, false)); }
function validSettings(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !SETTING_FIELDS.includes(key))) return false; const fields = Object.entries(value).every(([key, setting]) => ['stretchChildOnInsert','displayEmptyByDefault','allowPreferredValuesOnly'].includes(key) ? typeof setting === 'boolean' : setting === null || Number.isSafeInteger(setting) && setting >= 0); return fields && !(value.minChildren !== undefined && value.minChildren !== null && value.maxChildren !== undefined && value.maxChildren !== null && value.minChildren > value.maxChildren); }
function validDefinition(value) { if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'SLOT' || value.defaultValue !== null && !text(value.defaultValue, MAX_SLOT_NAME_CODE_UNITS) || Object.keys(value).some((key) => !['type','defaultValue','preferredValues','variantOptions','description','slotSettings','boundVariables'].includes(key))) return false; return (!Object.hasOwn(value, 'preferredValues') || validPreferred(value.preferredValues)) && (!Object.hasOwn(value, 'variantOptions') || Array.isArray(value.variantOptions) && value.variantOptions.length <= MAX_VARIANT_OPTIONS && value.variantOptions.every((item) => text(item, MAX_SLOT_NAME_CODE_UNITS))) && (!Object.hasOwn(value, 'description') || text(value.description, MAX_SLOT_DESCRIPTION_CODE_UNITS)) && (!Object.hasOwn(value, 'slotSettings') || validSettings(value.slotSettings)) && (!Object.hasOwn(value, 'boundVariables') || exact(value.boundVariables, []) || exact(value.boundVariables, ['defaultValue']) && exact(value.boundVariables.defaultValue, ['type','id']) && value.boundVariables.defaultValue.type === 'VARIABLE_ALIAS' && text(value.boundVariables.defaultValue.id, MAX_VARIABLE_ALIAS_ID_CODE_UNITS, false)); }
function validViolations(value) { return Array.isArray(value) && value.length <= 3 && value.every((item) => VIOLATIONS.includes(item)) && new Set(value).size === value.length && !(value.includes('BELOW_MIN') && value.includes('ABOVE_MAX')); }
function validSlot(value, withType) { return exact(value, withType ? ['id','name','type','childCount','limitViolations'] : ['id','name','childCount','limitViolations']) && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name, MAX_SLOT_NAME_CODE_UNITS) && (!withType || value.type === 'SLOT') && Number.isSafeInteger(value.childCount) && value.childCount >= 0 && value.childCount <= MAX_SLOT_READ_CHILDREN && validViolations(value.limitViolations); }
function validResult(value, input) {
  if (input.action === 'inspect') {
    if (value?.type === 'SLOT') return value.id === input.nodeId && validSlot(value, true);
    return exact(value, ['id','name','type','slots']) && value.id === input.nodeId && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name, MAX_SLOT_NAME_CODE_UNITS) && ['COMPONENT','COMPONENT_SET'].includes(value.type) && Array.isArray(value.slots) && value.slots.length <= MAX_SLOT_READ_ITEMS && value.slots.every((entry) => exact(entry, ['name','definition']) && text(entry.name, MAX_SLOT_NAME_CODE_UNITS, false) && validDefinition(entry.definition)) && new Set(value.slots.map((entry) => entry.name)).size === value.slots.length;
  }
  return exact(value, ['valid','slots']) && typeof value.valid === 'boolean' && Array.isArray(value.slots) && value.slots.length <= MAX_SLOT_READ_ITEMS && value.slots.every((entry) => validSlot(entry, false)) && new Set(value.slots.map((entry) => entry.id)).size === value.slots.length && value.valid === value.slots.every((entry) => entry.limitViolations.length === 0);
}
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function safe(value) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }

export async function executeSlotRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Slot Read requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(slotReadCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SLOT_READ_RESULT_CODE_UNITS) throw invalid('Slot Read returned an invalid bounded result.');
  let result; try { result = JSON.parse(serialized); } catch { throw invalid('Slot Read returned invalid JSON.'); }
  if (!validResult(result, input)) throw invalid('Slot Read returned an invalid bounded result.');
  return { stdout: safe(result), stderr: input.warning ? `⚠ ${input.warning}` : '', result };
}
export function slotReadPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Slot Read routing requires a Command Plan.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-slot-read'; }
export function executeSlotReadPlan(plan, adapters = {}) { if (slotReadPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Slot Read.'); return executeSlotRead(parseSlotReadRequest(plan.argv), adapters); }
