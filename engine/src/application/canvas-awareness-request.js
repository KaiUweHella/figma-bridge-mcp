// Closed request Interface for read-only Canvas Awareness (`canvas info|next`).

const DEFAULT_GAP = 100;
const DEFAULT_DIRECTION = 'right';
const DIRECTIONS = new Set(['right', 'below']);

function requestError(message) {
  return new Error(`Invalid Canvas Awareness command: ${message}.`);
}

function gapValue(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw requestError('gap must be a finite number');
  }
  const gap = Number(value);
  if (!Number.isFinite(gap) || !Number.isSafeInteger(Math.trunc(gap))) {
    throw requestError('gap must be a finite safe number');
  }
  return Object.is(gap, -0) ? 0 : gap;
}

function directionValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw requestError('direction must be right or below');
  }
  const direction = value.toLowerCase();
  if (!DIRECTIONS.has(direction)) throw requestError('direction must be right or below');
  return direction;
}

function nextOption(token) {
  if (token === '-g' || token === '--gap') return { name: 'gap', inline: null };
  if (token === '-d' || token === '--direction') return { name: 'direction', inline: null };
  if (token.startsWith('--gap=')) return { name: 'gap', inline: token.slice(6) };
  if (token.startsWith('--direction=')) return { name: 'direction', inline: token.slice(12) };
  if (token.startsWith('-g') && token.length > 2) return { name: 'gap', inline: token.slice(2) };
  if (token.startsWith('-d') && token.length > 2) return { name: 'direction', inline: token.slice(2) };
  return null;
}

export function parseCanvasAwarenessRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'canvas' || !['info', 'next'].includes(args[1])) {
    throw new Error('Expected a canvas info or canvas next command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Canvas Awareness arguments must be strings.');
  }
  if (args[1] === 'info') {
    if (args.length !== 2) throw requestError(`unexpected argument ${args[2]}`);
    return { action: 'info' };
  }

  const values = { gap: DEFAULT_GAP, direction: DEFAULT_DIRECTION };
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    const option = nextOption(token);
    if (!option) throw requestError(`unknown option or unexpected argument ${token}`);
    if (seen.has(option.name)) throw requestError(`${option.name} may be provided only once`);
    seen.add(option.name);
    let value = option.inline;
    if (value === null) {
      value = args[++index];
      if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
    }
    values[option.name] = option.name === 'gap' ? gapValue(value) : directionValue(value);
  }
  return { action: 'next', ...values };
}

export function acceptsCanvasAwarenessArgv(args) {
  try {
    parseCanvasAwarenessRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Canvas Awareness request must be an object.');
  }
  if (request.action === 'info') return { action: 'info' };
  if (request.action !== 'next') throw requestError('action must be info or next');
  return {
    action: 'next',
    gap: request.gap == null ? DEFAULT_GAP : gapValue(request.gap),
    direction: request.direction == null ? DEFAULT_DIRECTION : directionValue(request.direction),
  };
}

export function canvasAwarenessArgvFromRequest(request) {
  const input = typedRequest(request);
  if (input.action === 'info') return ['canvas', 'info'];
  const args = ['canvas', 'next'];
  if (input.gap !== DEFAULT_GAP) args.push('--gap', String(input.gap));
  if (input.direction !== DEFAULT_DIRECTION) args.push('--direction', input.direction);
  return args;
}

export const canvasAwarenessPlanningArgvFromRequest = canvasAwarenessArgvFromRequest;
