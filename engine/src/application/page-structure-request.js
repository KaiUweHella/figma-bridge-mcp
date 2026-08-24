// Closed request Interface for `canvas page-create` and `canvas page-divider`.

const MAX_PAGE_NAME_CODE_UNITS = 4096;
const MAX_PAGE_INDEX = 4096;
const FIGMA_PAGE_DIVIDER_NAME = /^(?:\*+|–+|—+| +)$/;

function requestError(message) {
  return new Error(`Invalid Page Structure command: ${message}.`);
}

function nameValue(value, { optional = false } = {}) {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || (!optional && value.length === 0)) {
    throw requestError('page name is required');
  }
  if (value.length > MAX_PAGE_NAME_CODE_UNITS) {
    throw requestError(`page name exceeds ${MAX_PAGE_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function dividerNameValue(value) {
  const name = nameValue(value, { optional: true });
  if (!FIGMA_PAGE_DIVIDER_NAME.test(name)) {
    throw requestError('divider name must be only asterisks, en dashes, em dashes, or spaces');
  }
  return name;
}

function indexValue(value) {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_PAGE_INDEX) return value;
    throw requestError(`index must be an integer from 0 to ${MAX_PAGE_INDEX}`);
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw requestError('--index requires a value');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_PAGE_INDEX) {
    throw requestError(`index must be an integer from 0 to ${MAX_PAGE_INDEX}`);
  }
  return parsed;
}

function pageCreateRequest(args) {
  let switchPage = true;
  let sawNoSwitch = false;
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--no-switch') {
      if (sawNoSwitch) throw requestError('--no-switch may be provided only once');
      sawNoSwitch = true;
      switchPage = false;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('page name is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { action: 'page-create', name: nameValue(positionals[0]), switchPage };
}

function pageDividerRequest(args) {
  let json = false;
  let sawIndex = false;
  let index = null;
  const positionals = [];
  let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && (token === '--index' || token.startsWith('--index='))) {
      if (sawIndex) throw requestError('--index may be provided only once');
      sawIndex = true;
      const inline = token.startsWith('--index=');
      const raw = inline ? token.slice('--index='.length) : args[++cursor];
      index = indexValue(raw);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return {
    action: 'page-divider',
    name: positionals.length === 0 ? null : dividerNameValue(positionals[0]),
    index,
    json,
  };
}

export function parsePageStructureRequest(args) {
  if (!Array.isArray(args)
    || args[0] !== 'canvas'
    || !['page-create', 'page-divider'].includes(args[1])) {
    throw new Error('Expected a canvas page-create or canvas page-divider command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Page Structure arguments must be strings.');
  }
  return args[1] === 'page-create' ? pageCreateRequest(args) : pageDividerRequest(args);
}

export function acceptsPageStructureArgv(args) {
  try {
    parsePageStructureRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Page Structure request must be an object.');
  }
  if (request.action === 'page-create') {
    if (request.switchPage != null && typeof request.switchPage !== 'boolean') {
      throw requestError('switchPage must be a boolean');
    }
    return {
      action: 'page-create',
      name: nameValue(request.name),
      switchPage: request.switchPage !== false,
    };
  }
  if (request.action !== 'page-divider') {
    throw requestError('action must be page-create or page-divider');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    action: 'page-divider',
    name: request.name == null ? null : dividerNameValue(request.name),
    index: request.index == null ? null : indexValue(request.index),
    json: request.json === true,
  };
}

export function pageStructureArgvFromRequest(request) {
  const input = typedRequest(request);
  if (input.action === 'page-create') {
    const options = input.switchPage ? [] : ['--no-switch'];
    return input.name.startsWith('-')
      ? ['canvas', 'page-create', ...options, '--', input.name]
      : ['canvas', 'page-create', ...options, input.name];
  }
  const options = [
    ...(input.index === null ? [] : ['--index', String(input.index)]),
    ...(input.json ? ['--json'] : []),
  ];
  if (input.name === null) return ['canvas', 'page-divider', ...options];
  return input.name.startsWith('-')
    ? ['canvas', 'page-divider', ...options, '--', input.name]
    : ['canvas', 'page-divider', ...options, input.name];
}

export const pageStructurePlanningArgvFromRequest = pageStructureArgvFromRequest;
