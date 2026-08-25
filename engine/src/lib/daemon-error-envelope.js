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
  'timeout',
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
const DISPATCH_STATES = new Set([
  'not-dispatched',
  'failed',
  'unknown',
]);
const MUTATION_OUTCOMES = new Set(['no-mutation', 'rolled-back', 'partial-residue']);
const MUTATION_RESIDUE_KINDS = new Set([
  'scene-node',
  'variable',
  'variable-collection',
  'paint-style',
  'text-style',
  'effect-style',
  'grid-style',
  'image-resource',
]);
const MUTATION_RESIDUE_REASONS = new Set(['no-removal-api', 'remove-failed']);
const MAX_MUTATION_RESIDUE = 50;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @typedef {'authentication'|'validation'|'targeting'|'plugin-unavailable'|'plugin-capability'|'plugin-protocol'|'plugin-timeout'|'timeout'|'execution'} BridgeDaemonErrorKind */
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

function boundedMutationReport(value) {
  if (!isRecord(value) || value.version !== 1 || !MUTATION_OUTCOMES.has(value.outcome)) return null;
  const reportFields = ['version', 'outcome', 'created', 'removed', 'residueCount', 'residue', 'residueTruncated'];
  if (Object.keys(value).some((key) => !reportFields.includes(key))) return null;
  for (const key of ['created', 'removed', 'residueCount']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100_000) return null;
  }
  if (value.removed > value.created || value.residueCount > value.created) return null;
  if (value.removed + value.residueCount !== value.created) return null;
  if (!Array.isArray(value.residue) || value.residue.length > MAX_MUTATION_RESIDUE) return null;
  if (typeof value.residueTruncated !== 'boolean') return null;
  if (value.residue.length !== Math.min(value.residueCount, MAX_MUTATION_RESIDUE)) return null;
  if (value.residueTruncated !== (value.residueCount > MAX_MUTATION_RESIDUE)) return null;
  if (value.outcome === 'no-mutation' && (value.created !== 0 || value.removed !== 0 || value.residueCount !== 0)) return null;
  if (value.outcome === 'rolled-back' && (value.created === 0 || value.removed !== value.created || value.residueCount !== 0)) return null;
  if (value.outcome === 'partial-residue' && value.residueCount === 0) return null;
  const residue = [];
  for (const entry of value.residue) {
    if (!isRecord(entry) || !MUTATION_RESIDUE_KINDS.has(entry.kind)
      || !MUTATION_RESIDUE_REASONS.has(entry.reason)
      || typeof entry.handle !== 'string' || !entry.handle
      || Object.keys(entry).some((key) => !['kind', 'handle', 'reason'].includes(key))
      || Buffer.byteLength(entry.handle, 'utf8') > 1024) return null;
    residue.push(Object.freeze({ kind: entry.kind, handle: entry.handle, reason: entry.reason }));
  }
  return Object.freeze({
    version: 1,
    outcome: value.outcome,
    created: value.created,
    removed: value.removed,
    residueCount: value.residueCount,
    residue: Object.freeze(residue),
    residueTruncated: value.residueTruncated,
  });
}

export function parseStructuredMutationReport(value) {
  return boundedMutationReport(value);
}

export class BridgeDaemonError extends Error {
  /**
   * @param {string} message
   * @param {{kind?:BridgeDaemonErrorKind,phase?:BridgeDaemonErrorPhase,outcome?:BridgeDaemonErrorOutcome,dispatchState?:'not-dispatched'|'failed'|'unknown',mutationReport?:unknown,cause?:unknown}} [options]
   */
  constructor(message, { kind, phase, outcome, dispatchState = null, mutationReport = null, cause = null } = {}) {
    if (!validFacts({ kind, phase, outcome })) {
      throw new TypeError('BridgeDaemonError requires a known kind, phase, and outcome');
    }
    const normalizedDispatchState = dispatchState
      || (outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown');
    if (!DISPATCH_STATES.has(normalizedDispatchState)) {
      throw new TypeError('BridgeDaemonError requires a known dispatch state');
    }
    super(boundedMessage(message), cause ? { cause } : undefined);
    this.name = 'BridgeDaemonError';
    this.kind = kind;
    this.phase = phase;
    this.outcome = outcome;
    this.dispatchState = normalizedDispatchState;
    const mutation = mutationReport == null ? null : boundedMutationReport(mutationReport);
    if (mutationReport != null && !mutation) {
      throw new TypeError('BridgeDaemonError received an invalid structured mutation report');
    }
    if (mutation) this.mutationReport = mutation;
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
    dispatchState: normalized.dispatchState,
    message: normalized.message,
    ...(normalized.mutationReport ? { mutationReport: normalized.mutationReport } : {}),
  });
  return Object.freeze({ error: bridgeError.message, bridgeError });
}

/** Accept only the current closed envelope; malformed facts never drive policy. */
export function parseBridgeDaemonError(value) {
  if (!isRecord(value) || value.schema !== BRIDGE_DAEMON_ERROR_SCHEMA) return null;
  if (!validFacts(value)) return null;
  if (value.dispatchState != null && !DISPATCH_STATES.has(value.dispatchState)) return null;
  if (typeof value.message !== 'string' || !value.message) return null;
  if (Buffer.byteLength(value.message, 'utf8') > MAX_BRIDGE_DAEMON_ERROR_BYTES) return null;
  const mutationReport = value.mutationReport == null ? null : boundedMutationReport(value.mutationReport);
  if (value.mutationReport != null && !mutationReport) return null;
  return Object.freeze({
    schema: BRIDGE_DAEMON_ERROR_SCHEMA,
    kind: value.kind,
    phase: value.phase,
    outcome: value.outcome,
    dispatchState: DISPATCH_STATES.has(value.dispatchState)
      ? value.dispatchState
      : value.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown',
    message: value.message,
    ...(mutationReport ? { mutationReport } : {}),
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
    dispatchState: outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown',
    message,
    legacy: true,
  });
}

/** A write may switch Adapters only when the first capability never dispatched. */
export function permitsCompatibilityRedispatch(error) {
  return error?.kind === 'plugin-capability'
    && (error?.phase === 'request-validation' || error?.phase === 'plugin-dispatch')
    && error?.outcome === 'not-dispatched';
}
