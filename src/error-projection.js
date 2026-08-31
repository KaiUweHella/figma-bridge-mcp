// Stable public error projection shared by MCP and child-process adapters.
// Internal executable paths and argv are deliberately never projected.

const firstUsefulLine = (value) => String(value || '')
  .split('\n')
  .map((line) => line.trim())
  .find(Boolean) || '';
const DISPATCH_STATES = new Set(['not-dispatched', 'completed', 'failed', 'unknown']);
const MUTATION_OUTCOMES = new Set([
  'no-mutation', 'rolled-back', 'partial-residue', 'verification-unavailable',
]);
const MAX_MUTATION_COUNT = 100_000;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MUTATION_REPORT_FIELDS = Object.freeze([
  'mutationReport',
  'collectionDeleteMutationReport', 'collectionModeMutationReport',
  'collectionUpdateMutationReport', 'styleMutationReport',
  'variableCodeSyntaxMutationReport', 'variableDeleteMutationReport',
  'variableValueBatchMutationReport', 'variableValueMutationReport',
  'variableUpdateBatchMutationReport', 'variableUpdateMutationReport',
]);

function dispatchState(value) {
  return DISPATCH_STATES.has(value) ? value : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MUTATION_COUNT
    ? value : null;
}

/** Project only bounded mutation cardinalities; identities and failure details never cross. */
export function projectMutationOutcome(value) {
  for (const field of MUTATION_REPORT_FIELDS) {
    const report = value?.[field];
    if (!report || typeof report !== 'object' || Array.isArray(report) || report.version !== 1
      || !MUTATION_OUTCOMES.has(report.outcome)
      || (value?.mutationOutcome !== undefined && value.mutationOutcome !== report.outcome)) continue;
    const residueCount = count(report.residueCount) ?? count(report.residual);
    if (residueCount === null) continue;
    const attempted = count(report.attempted) ?? count(report.created) ?? count(report.targetedCount);
    const restored = count(report.restored) ?? count(report.removed);
    if ((report.attempted !== undefined || report.created !== undefined || report.targetedCount !== undefined)
      && attempted === null) continue;
    if ((report.restored !== undefined || report.removed !== undefined) && restored === null) continue;
    if (report.outcome === 'no-mutation' && ((attempted ?? 0) !== 0 || (restored ?? 0) !== 0 || residueCount !== 0)) continue;
    if (report.outcome === 'rolled-back' && residueCount !== 0) continue;
    if (report.outcome === 'partial-residue' && residueCount === 0) continue;
    return Object.freeze({
      schemaVersion: 1,
      outcome: report.outcome,
      ...(attempted === null ? {} : { attempted }),
      ...(restored === null ? {} : { restored }),
      residueCount,
    });
  }
  return null;
}

export function isMutationOutcomeProjection(mutation) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)
    || mutation.schemaVersion !== 1 || !MUTATION_OUTCOMES.has(mutation.outcome)
    || count(mutation.residueCount) === null) return false;
  const mutationKeys = Object.keys(mutation);
  if (mutationKeys.some((key) => !['schemaVersion','outcome','attempted','restored','residueCount'].includes(key))) return false;
  if (mutation.attempted !== undefined && count(mutation.attempted) === null) return false;
  if (mutation.restored !== undefined && count(mutation.restored) === null) return false;
  if (mutation.outcome === 'no-mutation'
    && ((mutation.attempted ?? 0) !== 0 || (mutation.restored ?? 0) !== 0 || mutation.residueCount !== 0)) return false;
  if (mutation.outcome === 'rolled-back' && mutation.residueCount !== 0) return false;
  if (mutation.outcome === 'partial-residue' && mutation.residueCount === 0) return false;
  return true;
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
  const state = dispatchState(error?.dispatchState);
  const mutation = isMutationOutcomeProjection(error?.mutation)
    ? error.mutation : projectMutationOutcome(error);
  return {
    kind,
    message: firstUsefulLine(error?.message) || fallback,
    ...(state ? { dispatchState: state } : {}),
    ...(mutation ? { mutation } : {}),
  };
}

export function isPublicFailureProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.status !== 'failed'
    || typeof value.errorKind !== 'string' || !SAFE_TOKEN.test(value.errorKind)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['schemaVersion','status','errorKind','dispatchState','mutation'].includes(key))) return false;
  if (value.dispatchState !== undefined && !dispatchState(value.dispatchState)) return false;
  if (value.mutation !== undefined && !isMutationOutcomeProjection(value.mutation)) return false;
  return value.dispatchState !== undefined || value.mutation !== undefined;
}

export function projectPublicFailure(error) {
  const projected = projectPublicError(error);
  const failure = Object.freeze({
    schemaVersion: 1,
    status: 'failed',
    errorKind: SAFE_TOKEN.test(projected.kind) ? projected.kind : 'request',
    ...(projected.dispatchState ? { dispatchState: projected.dispatchState } : {}),
    ...(projected.mutation ? { mutation: projected.mutation } : {}),
  });
  return isPublicFailureProjection(failure) ? failure : null;
}

export function publicError(error, options) {
  const projected = projectPublicError(error, options);
  const wrapped = new Error(projected.message, error ? { cause: error } : undefined);
  wrapped.name = 'PublicBridgeError';
  wrapped.kind = projected.kind;
  if (projected.dispatchState) wrapped.dispatchState = projected.dispatchState;
  if (projected.mutation) wrapped.mutation = projected.mutation;
  if (typeof error?.code === 'number') wrapped.code = error.code;
  return wrapped;
}

export function formatPublicError(error, options) {
  const projected = projectPublicError(error, options);
  const dispatch = projected.dispatchState ? ` [dispatch:${projected.dispatchState}]` : '';
  const mutation = projected.mutation
    ? ` [mutation:${projected.mutation.outcome}`
      + `${projected.mutation.attempted === undefined ? '' : ` attempted:${projected.mutation.attempted}`}`
      + `${projected.mutation.restored === undefined ? '' : ` restored:${projected.mutation.restored}`}`
      + ` residue:${projected.mutation.residueCount}]`
    : '';
  return `[${projected.kind}]${dispatch}${mutation} ${projected.message}`;
}
