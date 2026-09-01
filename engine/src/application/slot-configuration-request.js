// Closed request Interface for `slot create|edit` configuration writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const SLOT_CONFIGURATION_ACTIONS = Object.freeze(['create', 'edit']);
export const MAX_SLOT_NAME_CODE_UNITS = 1_024;
export const MAX_SLOT_DESCRIPTION_CODE_UNITS = 16_384;
export const MAX_SLOT_PREFERRED_VALUES = 256;
export const MAX_SLOT_PREFERRED_KEY_CODE_UNITS = 1_024;
const SETTING_FIELDS = Object.freeze([
  'stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren',
  'allowPreferredValuesOnly',
]);
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Slot Configuration command: ${message}.`);
}

function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('componentId must be a bounded Figma node id or URL containing node-id');
  }
}

function boundedText(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== 'string') throw requestError(`${label} must be a string`);
  const text = value;
  if (!empty && !text.trim().length) throw requestError(`${label} is required`);
  if (text.length > maximum) throw requestError(`${label} exceeds its bounded length`);
  if (UNSAFE.test(text)) throw requestError(`${label} contains unsafe control characters`);
  return text;
}

function settingsValue(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw requestError('settings must be a JSON object');
  }
  const unknown = Object.keys(value).filter((key) => !SETTING_FIELDS.includes(key));
  if (unknown.length) throw requestError('settings contains an unknown field');
  const settings = {};
  for (const key of SETTING_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const setting = value[key];
    if (['stretchChildOnInsert', 'displayEmptyByDefault', 'allowPreferredValuesOnly'].includes(key)) {
      if (typeof setting !== 'boolean') throw requestError(`${key} must be boolean`);
    } else if (setting !== null && (!Number.isSafeInteger(setting) || setting < 0)) {
      throw requestError(`${key} must be a non-negative safe integer or null`);
    }
    settings[key] = setting;
  }
  if (settings.minChildren !== undefined && settings.minChildren !== null
    && settings.maxChildren !== undefined && settings.maxChildren !== null
    && settings.minChildren > settings.maxChildren) {
    throw requestError('minChildren must be less than or equal to maxChildren');
  }
  return settings;
}

function preferredValue(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_SLOT_PREFERRED_VALUES) {
    throw requestError('preferredValues must be a bounded JSON array');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'key,type'
      || !['COMPONENT', 'COMPONENT_SET'].includes(entry.type)) {
      throw requestError('preferredValues entries must contain only type and key');
    }
    return {
      type: entry.type,
      key: boundedText(entry.key, 'preferredValues key', MAX_SLOT_PREFERRED_KEY_CODE_UNITS),
    };
  });
}

function parseJson(raw, label, normalize) {
  if (typeof raw !== 'string') throw requestError(`${label} requires JSON text`);
  try { return normalize(JSON.parse(raw)); }
  catch (error) {
    if (String(error?.message).startsWith('Invalid Slot Configuration command:')) throw error;
    throw requestError(`${label} contains invalid JSON`);
  }
}

function optionValue(args, index, name, inline) {
  if (inline !== null) {
    if (!inline.length && name !== '--description') throw requestError(`${name} requires a value`);
    return { value: inline, index };
  }
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${name} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slot Configuration arguments must be strings.');
  }
  if (args[0] !== 'slot' || !SLOT_CONFIGURATION_ACTIONS.includes(args[1])) {
    throw new Error('Expected a Slot Configuration command.');
  }
  const action = args[1];
  const accepted = action === 'create'
    ? ['--settings', '--preferred', '--description']
    : ['--name', '--settings', '--preferred', '--description'];
  const positionals = []; const options = new Map(); let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = accepted.find((candidate) => token === candidate
        || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline);
      index = parsed.index; options.set(name, parsed.value); continue;
    }
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('componentId and name are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const component = nodeValue(positionals[0]);
  const name = boundedText(positionals[1], action === 'create' ? 'name' : 'propertyName', MAX_SLOT_NAME_CODE_UNITS);
  const settings = options.has('--settings')
    ? parseJson(options.get('--settings'), '--settings', settingsValue) : null;
  const preferredValues = options.has('--preferred')
    ? parseJson(options.get('--preferred'), '--preferred', preferredValue) : null;
  const description = options.has('--description')
    ? boundedText(options.get('--description'), 'description', MAX_SLOT_DESCRIPTION_CODE_UNITS, { empty: true })
    : null;
  const nextName = options.has('--name')
    ? boundedText(options.get('--name'), 'name', MAX_SLOT_NAME_CODE_UNITS) : null;
  if (action === 'edit' && [nextName, settings, preferredValues, description]
    .every((value) => value === null)) {
    throw requestError('edit requires --name, --settings, --preferred, or --description');
  }
  return {
    action, component, propertyName: action === 'edit' ? name : null,
    name: action === 'create' ? name : nextName,
    settings, preferredValues, description,
  };
}

function projected(input) {
  return Object.freeze({
    action: input.action,
    componentId: input.component.nodeId,
    propertyName: input.propertyName,
    name: input.name,
    settings: input.settings,
    preferredValues: input.preferredValues,
    description: input.description,
  });
}

export function parseSlotConfigurationRequest(args) { return projected(parsedRequest(args)); }
export function acceptsSlotConfigurationArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}
export function slotConfigurationFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).component.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slot Configuration request must be an object.');
  }
  if (!SLOT_CONFIGURATION_ACTIONS.includes(request.action)) {
    throw requestError('action must be create or edit');
  }
  const action = request.action;
  const component = nodeValue(request.componentId);
  const propertyName = action === 'edit'
    ? boundedText(request.propertyName, 'propertyName', MAX_SLOT_NAME_CODE_UNITS) : null;
  const name = action === 'create'
    ? boundedText(request.name, 'name', MAX_SLOT_NAME_CODE_UNITS)
    : request.name === null || request.name === undefined ? null
      : boundedText(request.name, 'name', MAX_SLOT_NAME_CODE_UNITS);
  const settings = settingsValue(request.settings);
  const preferredValues = preferredValue(request.preferredValues);
  const description = request.description === null || request.description === undefined ? null
    : boundedText(request.description, 'description', MAX_SLOT_DESCRIPTION_CODE_UNITS, { empty: true });
  if (action === 'edit' && [name, settings, preferredValues, description]
    .every((value) => value === null)) {
    throw requestError('edit requires --name, --settings, --preferred, or --description');
  }
  return { action, component, propertyName, name, settings, preferredValues, description };
}

function argvFrom(input, planning) {
  const argv = ['slot', input.action];
  if (input.name !== null && input.action === 'edit') argv.push(`--name=${input.name}`);
  if (input.settings !== null) argv.push('--settings', JSON.stringify(input.settings));
  if (input.preferredValues !== null) argv.push('--preferred', JSON.stringify(input.preferredValues));
  if (input.description !== null) argv.push(`--description=${input.description}`);
  argv.push('--', planning ? input.component.planningValue : input.component.nodeId,
    input.action === 'create' ? input.name : input.propertyName);
  return argv;
}

export function slotConfigurationArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false); parseSlotConfigurationRequest(args); return args;
}
export function slotConfigurationPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true); parseSlotConfigurationRequest(args); return args;
}
