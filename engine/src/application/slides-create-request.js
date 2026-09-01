// Closed request Interface for `slides create`.

export const MAX_SLIDES_CREATE_LABEL_CODE_UNITS = 4_096;
export const MAX_SLIDES_CREATE_INDEX = 4_095;

function requestError(message) {
  return new Error(`Invalid Slides Create command: ${message}.`);
}

function labelValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw requestError('label must be a string');
  if (value.length > MAX_SLIDES_CREATE_LABEL_CODE_UNITS) {
    throw requestError(`label must not exceed ${MAX_SLIDES_CREATE_LABEL_CODE_UNITS} code units`);
  }
  return value;
}

function indexValue(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw requestError(`${name} must be a zero-based non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SLIDES_CREATE_INDEX) {
    throw requestError(`${name} must not exceed ${MAX_SLIDES_CREATE_INDEX}`);
  }
  return parsed;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || args[1] !== 'create') {
    throw new Error('Expected a slides create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides Create arguments must be strings.');
  }
  const seen = new Set();
  const positionals = [];
  let row = null;
  let col = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '--row' || token.startsWith('--row='))) {
      if (seen.has('row')) throw requestError('--row may be provided only once');
      seen.add('row');
      const inline = token.startsWith('--row=') ? token.slice('--row='.length) : null;
      const value = inline === null ? args[++index] : inline;
      if (typeof value !== 'string' || value === '' || value === '--') {
        throw requestError('--row requires a value');
      }
      row = indexValue(value, 'row');
      continue;
    }
    if (!literal && (token === '--col' || token.startsWith('--col='))) {
      if (seen.has('col')) throw requestError('--col may be provided only once');
      seen.add('col');
      const inline = token.startsWith('--col=') ? token.slice('--col='.length) : null;
      const value = inline === null ? args[++index] : inline;
      if (typeof value !== 'string' || value === '' || value === '--') {
        throw requestError('--col requires a value');
      }
      col = indexValue(value, 'col');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  if (col !== null && row === null) throw requestError('--col requires --row');
  return { label: labelValue(positionals[0]), row, col };
}

export function parseSlidesCreateRequest(args) {
  return Object.freeze(parsedRequest(args));
}

export function acceptsSlidesCreateArgv(args) {
  try { parseSlidesCreateRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slides Create request must be an object.');
  }
  if (Object.keys(request).some((key) => !['label', 'row', 'col'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const label = labelValue(request.label);
  const row = request.row == null ? null : indexValue(String(request.row), 'row');
  const col = request.col == null ? null : indexValue(String(request.col), 'col');
  if (col !== null && row === null) throw requestError('col requires row');
  return { label, row, col };
}

export function slidesCreateArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'slides', 'create',
    ...(input.row === null ? [] : [`--row=${input.row}`]),
    ...(input.col === null ? [] : [`--col=${input.col}`]),
  ];
  if (input.label !== null) {
    if (input.label.startsWith('-')) args.push('--');
    args.push(input.label);
  }
  parseSlidesCreateRequest(args);
  return args;
}

export const slidesCreatePlanningArgvFromRequest = slidesCreateArgvFromRequest;
