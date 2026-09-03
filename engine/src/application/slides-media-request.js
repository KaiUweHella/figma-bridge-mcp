// Closed request projection for inserting media into one Figma Slides slide.

import { parseUnionReference, unionReferenceArgvValue } from './union-reference.js';

export const MAX_SLIDES_MEDIA_PATH_CODE_UNITS = 4_096;
export const SLIDES_MEDIA_SCALE_MODES = Object.freeze(['FILL', 'FIT', 'CROP', 'TILE']);
export const SLIDES_MEDIA_IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
export const SLIDES_MEDIA_GIF_EXT = /\.gif$/i;
export const SLIDES_MEDIA_VIDEO_EXT = /\.(mp4|mov|webm)$/i;

// Inbound bytes ride inside the eval payload -- the asset stream is an export
// path only -- and base64 inflates a file by 4/3. The 5 MB protocol ceiling
// therefore caps a real file at about 3.7 MB; this leaves room for the code
// around it. `IMAGE_HARD_LIMIT` (8 MB) is the older, unreachable number.
export const SLIDES_MEDIA_HARD_LIMIT = 3_500_000;

const MODES = new Set(SLIDES_MEDIA_SCALE_MODES);
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Slides command: ${message}.`);
}

/** Which Plugin API primitive the file needs, decided by extension only. */
export function slidesMediaKind(file) {
  if (SLIDES_MEDIA_GIF_EXT.test(file)) return 'gif';
  if (SLIDES_MEDIA_VIDEO_EXT.test(file)) return 'video';
  if (SLIDES_MEDIA_IMAGE_EXT.test(file)) return 'image';
  return null;
}

function fileValue(value) {
  if (typeof value !== 'string' || !value.length) throw requestError('media requires a file');
  if (value.length > MAX_SLIDES_MEDIA_PATH_CODE_UNITS || UNSAFE.test(value)) {
    throw requestError('media file path is invalid or too long');
  }
  if (!slidesMediaKind(value)) {
    throw requestError('media file must be .png, .jpg, .webp, .gif, .mp4, .mov or .webm');
  }
  return value;
}

export function parseSlidesMediaRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || args[1] !== 'media') {
    throw new Error('Expected a Slides media command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides arguments must be strings.');
  }
  const positionals = [];
  const options = { name: undefined, fit: undefined };
  const seen = new Set();
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (!['--name', '--fit'].includes(name)) throw requestError(`unknown option ${name}`);
      if (seen.has(name)) throw requestError(`duplicate option ${name}`);
      seen.add(name);
      const raw = equals === -1 ? args[index + 1] : token.slice(equals + 1);
      if (equals === -1) index++;
      if (typeof raw !== 'string') throw requestError(`${name} requires a value`);
      options[name === '--name' ? 'name' : 'fit'] = raw;
      continue;
    }
    if (!literal && token.startsWith('-') && token !== '-') {
      throw requestError(`unknown option ${token}`);
    }
    positionals.push({ index, value: token });
  }
  if (positionals.length !== 2) {
    throw requestError('media requires a slide reference and a file');
  }

  let reference;
  try { reference = parseUnionReference(positionals[0].value); }
  catch (error) { throw requestError(error.message); }
  if (reference.fileKey) {
    throw requestError('media reference must not carry a file key');
  }

  const file = fileValue(positionals[1].value);
  const fit = options.fit === undefined ? 'FILL' : String(options.fit).trim().toUpperCase();
  if (!MODES.has(fit)) {
    throw requestError(`--fit must be one of ${SLIDES_MEDIA_SCALE_MODES.join(', ')}`);
  }
  const name = options.name === undefined ? null : String(options.name);
  if (name !== null && (!name || name.length > 4096 || UNSAFE.test(name))) {
    throw requestError('--name is invalid or too long');
  }

  return Object.freeze({
    action: 'media',
    argv: Object.freeze([...args]),
    reference,
    referenceIndex: positionals[0].index,
    file,
    fileIndex: positionals[1].index,
    kind: slidesMediaKind(file),
    fit,
    name,
  });
}

export function acceptsSlidesMediaArgv(args) {
  try {
    parseSlidesMediaRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function slidesMediaArgvFromRequest(request) {
  const input = Array.isArray(request?.argv) ? parseSlidesMediaRequest(request.argv) : request;
  if (!input || !input.file) {
    throw new TypeError('Slides media request must be parsed before canonicalization.');
  }
  const args = ['slides', 'media', unionReferenceArgvValue(input.reference), input.file];
  if (input.name) args.push(`--name=${input.name}`);
  if (input.fit !== 'FILL') args.push(`--fit=${input.fit}`);
  parseSlidesMediaRequest(args);
  return args;
}

export function slidesMediaPlanningArgvFromRequest(request) {
  const input = Array.isArray(request?.argv) ? parseSlidesMediaRequest(request.argv) : request;
  const args = slidesMediaArgvFromRequest(input);
  if (input.reference?.kind === 'node') {
    args[2] = `node:${input.reference.planningValue}`;
  }
  return args;
}

export function slidesMediaFigmaUrlFileKeyFromArgv(args) {
  parseSlidesMediaRequest(args);
  return null;
}
