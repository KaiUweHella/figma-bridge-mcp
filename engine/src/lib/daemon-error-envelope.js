// Versioned failure facts for the authenticated Bridge Daemon execution seam.
//
// `error` remains a string in HTTP responses so a newer daemon can still be
// understood by an older CLI. New clients consume `bridgeError` and never
// infer retry or recovery policy from the user-facing message.

export const BRIDGE_DAEMON_ERROR_SCHEMA = 1;
export const MAX_BRIDGE_DAEMON_ERROR_BYTES = 16 * 1024;

const KINDS = new Set([
  'authentication',
  'validation',
  'targeting',
  'plugin-unavailable',
  'plugin-capability',
  'plugin-protocol',
  'plugin-timeout',
  'execution',
]);

const PHASES = new Set([
  'request-authentication',
  'request-validation',
  'target-resolution',
  'plugin-dispatch',
  'plugin-execution',
  'plugin-response',
  'daemon-response',
]);

const OUTCOMES = new Set([
  'not-dispatched',
  'unknown-after-dispatch',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @typedef {'authentication'|'validation'|'targeting'|'plugin-unavailable'|'plugin-capability'|'plugin-protocol'|'plugin-timeout'|'execution'} BridgeDaemonErrorKind */
/** @typedef {'request-authentication'|'request-validation'|'target-resolution'|'plugin-dispatch'|'plugin-execution'|'plugin-response'|'daemon-response'} BridgeDaemonErrorPhase */
/** @typedef {'not-dispatched'|'unknown-after-dispatch'} BridgeDaemonErrorOutcome */

function boundedMessage(value, fallback = 'Execution failed') {
  const message = typeof value === 'string' && value ? value : fallback;
  if (Buffer.byteLength(message, 'utf8') <= MAX_BRIDGE_DAEMON_ERROR_BYTES) return message;
  const suffix = '…';
  const bytes = Buffer.from(message, 'utf8').subarray(
    0,
    MAX_BRIDGE_DAEMON_ERROR_BYTES - Buffer.byteLength(suffix, 'utf8'),
  );
  return bytes.toString('utf8').replace(/\uFFFD$/u, '') + suffix;
}

/** @param {{kind?:unknown,phase?:unknown,outcome?:unknown}} facts */
function validFacts({ kind, phase, outcome }) {
  return typeof kind === 'string' && typeof phase === 'string' && typeof outcome === 'string'
    && KINDS.has(kind) && PHASES.has(phase) && OUTCOMES.has(outcome);
}

export class BridgeDaemonError extends Error {
  /**
   * @param {string} message
   * @param {{kind?:BridgeDaemonErrorKind,phase?:BridgeDaemonErrorPhase,outcome?:BridgeDaemonErrorOutcome,cause?:unknown}} [options]
   */
  constructor(message, { kind, phase, outcome, cause = null } = {}) {
    if (!validFacts({ kind, phase, outcome })) {
      throw new TypeError('BridgeDaemonError requires a known kind, phase, and outcome');
    }
    super(boundedMessage(message), cause ? { cause } : undefined);
    this.name = 'BridgeDaemonError';
    this.kind = kind;
    this.phase = phase;
    this.outcome = outcome;
  }
}

/**
 * Convert one daemon-owned failure into the dual modern/legacy HTTP body.
 * @param {any} error
 * @param {{kind?:BridgeDaemonErrorKind,phase?:BridgeDaemonErrorPhase,outcome?:BridgeDaemonErrorOutcome,message?:string}} [options]
 */
export function bridgeDaemonErrorBody(error, {
  kind = 'execution',
  phase = 'daemon-response',
  outcome = 'unknown-after-dispatch',
  message = 'Execution failed',
} = {}) {
  const normalized = error instanceof BridgeDaemonError
    ? error
    : new BridgeDaemonError(error?.message || message, { kind, phase, outcome, cause: error });
  const bridgeError = Object.freeze({
    schema: BRIDGE_DAEMON_ERROR_SCHEMA,
    kind: normalized.kind,
    phase: normalized.phase,
    outcome: normalized.outcome,
    message: normalized.message,
  });
  return Object.freeze({ error: bridgeError.message, bridgeError });
}

/** Accept only the current closed envelope; malformed facts never drive policy. */
export function parseBridgeDaemonError(value) {
  if (!isRecord(value) || value.schema !== BRIDGE_DAEMON_ERROR_SCHEMA) return null;
  if (!validFacts(value)) return null;
  if (typeof value.message !== 'string' || !value.message) return null;
  if (Buffer.byteLength(value.message, 'utf8') > MAX_BRIDGE_DAEMON_ERROR_BYTES) return null;
  return Object.freeze({
    schema: BRIDGE_DAEMON_ERROR_SCHEMA,
    kind: value.kind,
    phase: value.phase,
    outcome: value.outcome,
    message: value.message,
  });
}

/**
 * Upgrade the bounded string-only response of an older running daemon into the
 * current client facts. This is the only place where legacy prose is parsed.
 */
export function adaptLegacyDaemonError(value, { status = null } = {}) {
  const message = boundedMessage(value, status == null ? 'Daemon request failed' : `HTTP ${status}`);
  let kind = 'execution';
  let phase = 'daemon-response';
  let outcome = 'unknown-after-dispatch';

  if ((status === 401 || status === 403) && /^Unauthorized(?:\b|:)/i.test(message)) {
    kind = 'authentication';
    phase = 'request-authentication';
    outcome = 'not-dispatched';
  } else if (/^Invalid execution request: action must be ["“]eval/i.test(message)) {
    kind = 'plugin-capability';
    phase = 'request-validation';
    outcome = 'not-dispatched';
  } else if (/^(?:Payload too large|Invalid JSON body|Invalid execution request):?/i.test(message)) {
    kind = 'validation';
    phase = 'request-validation';
    outcome = 'not-dispatched';
  } else if (/^(?:No connected Figma window|\d+ Figma windows are connected)/i.test(message)) {
    kind = 'targeting';
    phase = 'target-resolution';
    outcome = 'not-dispatched';
  } else if (/^Plugin not connected\b/i.test(message)) {
    kind = 'plugin-unavailable';
    phase = 'target-resolution';
    outcome = 'not-dispatched';
  } else if (/^Plugin capability missing\b/i.test(message)) {
    kind = 'plugin-capability';
    phase = 'plugin-dispatch';
    outcome = 'not-dispatched';
  } else if (/^Plugin (?:disconnected|connection superseded)\b/i.test(message)) {
    kind = 'plugin-unavailable';
    phase = 'plugin-execution';
  } else if (/^(?:Plugin execution timeout|Execution timeout)\b/i.test(message)) {
    kind = 'plugin-timeout';
    phase = 'plugin-execution';
  } else if (/^Plugin protocol error\b/i.test(message)) {
    kind = 'plugin-protocol';
    phase = 'plugin-response';
  }

  return Object.freeze({
    schema: 0,
    kind,
    phase,
    outcome,
    message,
    legacy: true,
  });
}

/** A write may switch Adapters only when the first capability never dispatched. */
export function permitsCompatibilityRedispatch(error) {
  return error?.kind === 'plugin-capability' && error?.outcome === 'not-dispatched';
}
