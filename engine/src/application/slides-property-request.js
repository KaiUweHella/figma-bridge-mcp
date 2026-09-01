// Closed request Interfaces for `slides transition` and `slides skip`.

import {
  TRANSITION_CURVES,
  TRANSITION_STYLES,
  TRANSITION_TIMINGS,
} from '../lib/slides-snippets.js';
import { parseUnionReference, unionReferenceArgvValue } from './union-reference.js';

export const MAX_SLIDES_TRANSITION_SECONDS = 86_400;

function requestError(message) {
  return new Error(`Invalid Slides Property command: ${message}.`);
}

function referenceValue(value) {
  try {
    if (typeof value === 'string') return parseUnionReference(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return parseUnionReference(`${value.kind || ''}:${value.value ?? value.nodeId ?? ''}`);
    }
  } catch (error) { throw requestError(error.message); }
  throw requestError('slide reference is required');
}

function enumValue(value, values, name) {
  if (typeof value !== 'string' || !values.includes(value.toUpperCase())) {
    throw requestError(`${name} must be one of ${values.join(', ')}`);
  }
  return value.toUpperCase();
}

function secondsValue(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_SLIDES_TRANSITION_SECONDS) {
    throw requestError(`${name} must be between 0 and ${MAX_SLIDES_TRANSITION_SECONDS} seconds`);
  }
  return Math.round(parsed * 10_000) / 10_000;
}

function transitionRequest(args) {
  const seen = new Set();
  const positionals = [];
  let duration = 0.3;
  let curve = 'EASE_IN_AND_OUT';
  let timing = 'ON_CLICK';
  let delay = 0;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && ['--duration', '--curve', '--timing', '--delay'].some(
      (name) => token === name || token.startsWith(`${name}=`),
    )) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (seen.has(name)) throw requestError(`${name} may be provided only once`);
      seen.add(name);
      const value = equals === -1 ? args[++index] : token.slice(equals + 1);
      if (typeof value !== 'string' || value === '' || value === '--') {
        throw requestError(`${name} requires a value`);
      }
      if (name === '--duration') duration = secondsValue(value, 'duration');
      if (name === '--curve') curve = enumValue(value, TRANSITION_CURVES, 'curve');
      if (name === '--timing') timing = enumValue(value, TRANSITION_TIMINGS, 'timing');
      if (name === '--delay') delay = secondsValue(value, 'delay');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('slide reference and style are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return Object.freeze({
    action: 'transition', reference: referenceValue(positionals[0]),
    transition: Object.freeze({
      style: enumValue(positionals[1], TRANSITION_STYLES, 'style'), duration, curve,
      timing: Object.freeze(timing === 'AFTER_DELAY' ? { type: timing, delay } : { type: timing }),
    }),
  });
}

function skipRequest(args) {
  let literal = false;
  const positionals = [];
  for (const token of args.slice(2)) {
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('slide reference is required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const state = (positionals[1] || 'on').toLowerCase();
  if (!['on', 'off', 'true', 'false'].includes(state)) {
    throw requestError('state must be on, off, true or false');
  }
  return Object.freeze({
    action: 'skip', reference: referenceValue(positionals[0]),
    skipped: state === 'on' || state === 'true',
  });
}

export function parseSlidesPropertyRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides'
    || !['transition', 'skip'].includes(args[1])) {
    throw new Error('Expected a slides transition or skip command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides Property arguments must be strings.');
  }
  return args[1] === 'transition' ? transitionRequest(args) : skipRequest(args);
}

export function acceptsSlidesPropertyArgv(args) {
  try { parseSlidesPropertyRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slides Property request must be an object.');
  }
  const action = request.action;
  if (action === 'transition') {
    const nested = request.transition;
    const allowed = nested ? ['action', 'reference', 'transition']
      : ['action', 'reference', 'style', 'duration', 'curve', 'timing', 'delay'];
    if (Object.keys(request).some((key) => !allowed.includes(key))) {
      throw requestError('transition request contains an unknown field');
    }
    if (nested && (!nested || typeof nested !== 'object' || Array.isArray(nested)
      || Object.keys(nested).some((key) => !['style', 'duration', 'curve', 'timing'].includes(key))
      || !nested.timing || typeof nested.timing !== 'object' || Array.isArray(nested.timing)
      || Object.keys(nested.timing).some((key) => !['type', 'delay'].includes(key)))) {
      throw requestError('transition must be a closed object');
    }
    const timingValue = nested ? nested.timing.type : request.timing ?? 'ON_CLICK';
    const timing = enumValue(timingValue, TRANSITION_TIMINGS, 'timing');
    if (nested) {
      const timingKeys = timing === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
      if (Object.keys(nested.timing).some((key) => !timingKeys.includes(key))
        || timingKeys.some((key) => !Object.hasOwn(nested.timing, key))) {
        throw requestError('transition timing does not match its type');
      }
    }
    return {
      action, reference: referenceValue(request.reference),
      transition: {
        style: enumValue(nested ? nested.style : request.style, TRANSITION_STYLES, 'style'),
        duration: secondsValue(nested ? nested.duration : request.duration ?? 0.3, 'duration'),
        curve: enumValue(nested ? nested.curve : request.curve ?? 'EASE_IN_AND_OUT',
          TRANSITION_CURVES, 'curve'),
        timing: timing === 'AFTER_DELAY'
          ? { type: timing, delay: secondsValue(
            nested ? nested.timing.delay : request.delay ?? 0, 'delay') }
          : { type: timing },
      },
    };
  }
  if (action === 'skip') {
    if (Object.keys(request).some((key) => !['action', 'reference', 'skipped'].includes(key))) {
      throw requestError('skip request contains an unknown field');
    }
    if (typeof request.skipped !== 'boolean') throw requestError('skipped must be boolean');
    return { action, reference: referenceValue(request.reference), skipped: request.skipped };
  }
  throw requestError('action must be transition or skip');
}

function argvFromInput(input, planning) {
  const reference = input.reference.kind === 'node' && planning
    ? `node:${input.reference.planningValue}` : unionReferenceArgvValue(input.reference);
  if (input.action === 'skip') {
    return ['slides', 'skip', reference, input.skipped ? 'on' : 'off'];
  }
  const transition = input.transition;
  return [
    'slides', 'transition', reference, transition.style,
    ...(transition.duration === 0.3 ? [] : [`--duration=${transition.duration}`]),
    ...(transition.curve === 'EASE_IN_AND_OUT' ? [] : [`--curve=${transition.curve}`]),
    ...(transition.timing.type === 'ON_CLICK' ? [] : [
      `--timing=${transition.timing.type}`, `--delay=${transition.timing.delay}`,
    ]),
  ];
}

export function slidesPropertyArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSlidesPropertyRequest(args);
  return args;
}

export function slidesPropertyPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSlidesPropertyRequest(args);
  return args;
}

export function slidesPropertyFigmaUrlFileKeyFromArgv(args) {
  return parseSlidesPropertyRequest(args).reference.fileKey;
}
