// Closed request Interface for repository-backed `spec` reads and checks.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_COMPONENT_SPEC_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_SPEC_PATH_CODE_UNITS = 16_384;
export const MAX_COMPONENT_SPEC_TOLERANCE = 1_000_000;
const OPTION_NAMES = Object.freeze(['--file', '--check', '--tolerance']);

function requestError(message) { return new Error(`Invalid Component Spec command: ${message}.`); }
function boundedText(value, label, maximum) {
  if (typeof value !== 'string') throw requestError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw requestError(`${label} must be a bounded non-empty string`);
  return normalized;
}
function toleranceValue(value) {
  if (value === undefined || value === null || value === '') return 2;
  if (typeof value === 'string' && !/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(value)) {
    throw requestError('--tolerance must be a finite non-negative number');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_COMPONENT_SPEC_TOLERANCE) {
    throw requestError('--tolerance must be a finite non-negative number');
  }
  return number;
}
function nodeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('--check must be a bounded Figma node id or URL containing node-id');
  }
}
function optionToken(token) {
  if (token === '-f') return { name: '--file', inline: null };
  if (token.startsWith('-f') && token.length > 2 && !token.startsWith('--')) {
    return { name: '--file', inline: token.slice(2) };
  }
  for (const name of OPTION_NAMES) {
    if (token === name) return { name, inline: null };
    if (token.startsWith(`${name}=`)) return { name, inline: token.slice(name.length + 1) };
  }
  return null;
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Spec arguments must be strings.');
  }
  if (args[0] !== 'spec') throw new Error('Expected a Component Spec command.');
  const positionals = []; const options = new Map(); let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const option = optionToken(token);
      if (!option) throw requestError(`unknown option ${token}`);
      if (options.has(option.name)) throw requestError(`${option.name} may be provided only once`);
      let value = option.inline;
      if (value === null) {
        value = args[index + 1];
        if (value === undefined || value === '--' || optionToken(value)) {
          throw requestError(`${option.name} requires a value`);
        }
        index++;
      }
      if (!value.length) throw requestError(`${option.name} requires a value`);
      options.set(option.name, value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'component is required');
  }
  return {
    component: boundedText(positionals[0], 'component', MAX_COMPONENT_SPEC_NAME_CODE_UNITS),
    file: options.has('--file')
      ? boundedText(options.get('--file'), '--file', MAX_COMPONENT_SPEC_PATH_CODE_UNITS) : null,
    check: nodeValue(options.get('--check')),
    tolerance: toleranceValue(options.get('--tolerance')),
  };
}
function projected(input) {
  return Object.freeze({
    component: input.component,
    file: input.file,
    checkNodeId: input.check?.nodeId || null,
    tolerance: input.tolerance,
    warning: input.check?.warning || '',
  });
}

export function parseComponentSpecRequest(args) { return projected(parsedRequest(args)); }
export function acceptsComponentSpecArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function componentSpecFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).check?.fileKey || null; }

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Spec request must be an object.');
  }
  return {
    component: boundedText(request.component, 'component', MAX_COMPONENT_SPEC_NAME_CODE_UNITS),
    file: request.file === undefined || request.file === null
      ? null : boundedText(request.file, 'file', MAX_COMPONENT_SPEC_PATH_CODE_UNITS),
    check: nodeValue(request.checkNodeId),
    tolerance: toleranceValue(request.tolerance),
  };
}
function argvFrom(input, planning) {
  const args = ['spec'];
  if (input.file) args.push('--file', input.file);
  if (input.check) args.push('--check', planning ? input.check.planningValue : input.check.nodeId);
  args.push('--tolerance', String(input.tolerance), '--', input.component);
  return args;
}

export function componentSpecArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false); parseComponentSpecRequest(args); return args;
}
export function componentSpecPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true); parseComponentSpecRequest(args); return args;
}
