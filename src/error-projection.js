// Stable public error projection shared by MCP and child-process adapters.
// Internal executable paths and argv are deliberately never projected.

const firstUsefulLine = (value) => String(value || '')
  .split('\n')
  .map((line) => line.trim())
  .find(Boolean) || '';
const DISPATCH_STATES = new Set(['not-dispatched', 'completed', 'failed', 'unknown']);
const PUBLIC_ERROR_KIND_LAYERS = new Map([
  ['request', 'validation'],
  ['validation', 'validation'],
  ['execution', 'execution'],
  ['engine-exit', 'execution'],
  ['targeting', 'transport'],
  ['transport', 'transport'],
  ['authentication', 'transport'],
  ['engine-connect', 'transport'],
  ['engine-timeout', 'execution'],
  ['engine-spawn', 'transport'],
  ['plugin-unavailable', 'transport'],
  ['plugin-capability', 'transport'],
  ['plugin-protocol', 'transport'],
  ['plugin-timeout', 'execution'],
  ['asset-transfer', 'transport'],
  ['missing-token', 'transport'],
  ['unavailable', 'transport'],
  ['timeout', 'transport'],
  ['rest-request', 'transport'],
  ['rest-timeout', 'transport'],
]);

function dispatchState(value) {
  return DISPATCH_STATES.has(value) ? value : null;
}

export function projectPublicError(error, { fallback = 'The Figma operation failed.' } = {}) {
  const child = error && (
    typeof error.code === 'number' || error.killed === true || error.signal ||
    /^Command failed:/i.test(String(error.message || ''))
  );
  if (child) {
    const timedOut = error.killed === true || error.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(error.message || ''));
    const kind = timedOut ? 'engine-timeout' : typeof error.code === 'number' ? 'engine-exit' : 'engine-spawn';
    const detail = firstUsefulLine(error.stderr) || firstUsefulLine(error.stdout);
    const code = typeof error.code === 'number' ? ` with code ${error.code}` : '';
    const message = detail || (timedOut
      ? 'The Figma engine exceeded the operation deadline.'
      : `The Figma engine exited${code} without a readable error.`);
    return { kind, message };
  }
  const kind = typeof error?.kind === 'string' && error.kind ? error.kind : 'request';
  const state = dispatchState(error?.dispatchState)
    || (error?.outcome === 'not-dispatched' ? 'not-dispatched' : null);
  return {
    kind,
    message: firstUsefulLine(error?.message) || fallback,
    ...(state ? { dispatchState: state } : {}),
  };
}

export function publicError(error, options) {
  const projected = projectPublicError(error, options);
  const wrapped = new Error(projected.message, error ? { cause: error } : undefined);
  wrapped.name = 'PublicBridgeError';
  wrapped.kind = projected.kind;
  if (projected.dispatchState) wrapped.dispatchState = projected.dispatchState;
  if (typeof error?.code === 'number') wrapped.code = error.code;
  return wrapped;
}

export function formatPublicError(error, options) {
  const projected = projectPublicError(error, options);
  const dispatch = projected.dispatchState ? ` [dispatch:${projected.dispatchState}]` : '';
  return `[${projected.kind}]${dispatch} ${projected.message}`;
}

function publicKindFromText(text) {
  const bracketed = [...text.matchAll(/\[([a-z][a-z0-9-]{0,63})\]/gi)]
    .map((match) => match[1].toLowerCase());
  const bracketedKind = bracketed.find((kind) => PUBLIC_ERROR_KIND_LAYERS.has(kind));
  if (bracketedKind) return bracketedKind;
  if (/\bPlugin not connected\b/i.test(text)) return 'plugin-unavailable';
  if (/\bNo connected Figma window\b|\bFigma windows are connected\b/i.test(text)) return 'targeting';
  return 'request';
}

function acceptedFormSuggestion(text) {
  const match = text.match(/Accepted form: (\[[\x20-\x7e]{1,400}\])\./);
  return match ? `Use ${match[1]}.` : 'Use figma_run with ["--help"] to discover an accepted command.';
}

/**
 * Project every MCP failure dialect into one bounded, payload-free recovery
 * context. Human-readable content remains intact; agents can branch on these
 * closed fields without parsing prose or retaining user payloads.
 */
export function projectMcpErrorContext(value) {
  const text = typeof value === 'string'
    ? value
    : formatPublicError(value, { fallback: 'The Figma Bridge request failed.' });
  const whitelist = text.includes('Unknown or unsupported Figma Command');
  const kind = whitelist ? 'command-rejected' : publicKindFromText(text);
  const layer = whitelist ? 'whitelist' : PUBLIC_ERROR_KIND_LAYERS.get(kind) || 'validation';
  const stateMatch = text.match(/\[dispatch:(not-dispatched|completed|failed|unknown)\]/);
  const knownBeforeDispatch = (kind === 'plugin-unavailable' && /\bPlugin not connected\b/i.test(text))
    || (kind === 'targeting'
      && /\bNo connected Figma window\b|\bFigma windows are connected\b/i.test(text));
  const state = whitelist || knownBeforeDispatch
    ? 'not-dispatched'
    : dispatchState(stateMatch?.[1]);
  let suggestion;
  if (layer === 'whitelist') {
    suggestion = acceptedFormSuggestion(text);
  } else if (kind === 'plugin-unavailable' && state === 'not-dispatched') {
    suggestion = 'Run figma_connect once to wake or restore the configured Bridge, then retry the same not-dispatched request. Diagnose further only if figma_connect fails.';
  } else if (layer === 'transport' && state === 'not-dispatched') {
    suggestion = 'Run figma_status to confirm the intended file, then retry the same request.';
  } else if (layer === 'transport') {
    suggestion = 'Run figma_status to verify the intended file and plugin connection before retrying.';
  } else if (layer === 'execution') {
    suggestion = 'Inspect the target state before retrying a write; the prior dispatch may have changed it.';
  } else {
    suggestion = 'Correct the request using the validation message, then retry.';
  }
  return Object.freeze({
    schemaVersion: 1,
    layer,
    kind,
    ...(state ? { dispatchState: state } : {}),
    suggestion,
  });
}
