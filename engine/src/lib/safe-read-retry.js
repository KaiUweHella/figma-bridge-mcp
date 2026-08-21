const TRANSIENT_KINDS = new Set([
  'unavailable',
  'timeout',
  'plugin-unavailable',
  'plugin-timeout',
]);

export function isTransientReadFailure(error) {
  if (TRANSIENT_KINDS.has(error?.kind)) return true;
  const message = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join('\n');
  return /Plugin (?:not connected|disconnected)|connection superseded|Plugin execution timeout|Execution timeout|Daemon not reachable/i.test(message);
}

/**
 * Retry an explicitly read-only operation once after the caller confirms the
 * plugin bridge is ready again. Never use this helper for writes: a socket can
 * disappear after Figma accepted a mutation but before its result returned.
 */
export async function retrySafeRead(operation, {
  retries = 1,
  waitUntilReady = async () => true,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isTransientReadFailure(error)) throw error;
      const ready = await waitUntilReady(error);
      if (ready === false) throw error;
    }
  }
  throw lastError;
}
