// Stable public error projection shared by MCP and child-process adapters.
// Internal executable paths and argv are deliberately never projected.

const firstUsefulLine = (value) => String(value || '')
  .split('\n')
  .map((line) => line.trim())
  .find(Boolean) || '';

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
  return { kind, message: firstUsefulLine(error?.message) || fallback };
}

export function publicError(error, options) {
  const projected = projectPublicError(error, options);
  const wrapped = new Error(projected.message, error ? { cause: error } : undefined);
  wrapped.name = 'PublicBridgeError';
  wrapped.kind = projected.kind;
  if (typeof error?.code === 'number') wrapped.code = error.code;
  return wrapped;
}

export function formatPublicError(error, options) {
  const projected = projectPublicError(error, options);
  return `[${projected.kind}] ${projected.message}`;
}
