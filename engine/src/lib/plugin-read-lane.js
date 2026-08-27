// Bounded concurrency for closed Plugin typed reads.

export const MAX_PLUGIN_READ_CONCURRENCY = 2;
export const MAX_PLUGIN_READ_CONCURRENCY_PER_SESSION = 1;
export const MAX_PLUGIN_READ_QUEUE = 64;
export const MAX_PLUGIN_READ_QUEUE_PER_SESSION = 16;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class PluginReadLaneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginReadLaneError';
    this.code = code;
  }
}

function laneError(code) {
  if (code === 'cancelled') return new PluginReadLaneError(code, 'Plugin typed read cancelled before dispatch');
  if (code === 'queue-full') return new PluginReadLaneError(code, 'Plugin typed read queue is full');
  return new PluginReadLaneError('deadline-elapsed', 'Plugin typed read deadline elapsed before dispatch');
}

function sessionKey(value) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError('Plugin read lane requires a bounded session key');
  }
  return value;
}

export function createPluginReadLane({
  now = () => Date.now(),
  maxActive = MAX_PLUGIN_READ_CONCURRENCY,
  maxActivePerSession = MAX_PLUGIN_READ_CONCURRENCY_PER_SESSION,
  maxQueue = MAX_PLUGIN_READ_QUEUE,
  maxQueuePerSession = MAX_PLUGIN_READ_QUEUE_PER_SESSION,
  tokenMatches = (prepared, settled) => prepared === settled,
} = {}) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > MAX_PLUGIN_READ_CONCURRENCY) {
    throw new TypeError(`Plugin read lane maxActive must be 1-${MAX_PLUGIN_READ_CONCURRENCY}`);
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > MAX_PLUGIN_READ_QUEUE) {
    throw new TypeError(`Plugin read lane maxQueue must be 1-${MAX_PLUGIN_READ_QUEUE}`);
  }
  if (!Number.isSafeInteger(maxActivePerSession) || maxActivePerSession < 1
    || maxActivePerSession > maxActive) {
    throw new TypeError(`Plugin read lane maxActivePerSession must be 1-${maxActive}`);
  }
  if (!Number.isSafeInteger(maxQueuePerSession) || maxQueuePerSession < 1
    || maxQueuePerSession > maxQueue) {
    throw new TypeError(`Plugin read lane maxQueuePerSession must be 1-${maxQueue}`);
  }
  const queue = [];
  const active = new Set();
  const quarantined = new Set();

  function clearHooks(entry) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    entry.timer = null;
    entry.abort = null;
  }

  function removeQueued(entry, code) {
    if (entry.started || entry.settled) return false;
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    entry.settled = true;
    clearHooks(entry);
    entry.reject(laneError(code));
    drain();
    return true;
  }

  function finish(entry, error, value) {
    if (entry.settled) return;
    entry.settled = true;
    if (error && entry.dispatchToken != null
      && error?.outcome === 'unknown-after-dispatch'
      && error?.dispatchState !== 'failed') {
      quarantined.add(entry);
      entry.reject(error);
      return;
    }
    active.delete(entry);
    if (error) entry.reject(error); else entry.resolve(value);
    drain();
  }

  function drain() {
    while (active.size < maxActive && queue.length) {
      const activeBySession = new Map();
      for (const item of active) {
        activeBySession.set(item.key, (activeBySession.get(item.key) || 0) + 1);
      }
      const runnableIndex = queue.findIndex((item) =>
        (activeBySession.get(item.key) || 0) < maxActivePerSession);
      if (runnableIndex < 0) return;
      const [entry] = queue.splice(runnableIndex, 1);
      if (entry.settled) continue;
      if (entry.signal?.aborted) {
        entry.settled = true; clearHooks(entry); entry.reject(laneError('cancelled')); continue;
      }
      if (entry.deadlineAt <= now()) {
        entry.settled = true; clearHooks(entry); entry.reject(laneError('deadline-elapsed')); continue;
      }
      entry.started = true;
      clearHooks(entry);
      active.add(entry);
      const control = Object.freeze({ markDispatched(token) {
        if (entry.dispatchToken != null) throw new Error('Plugin read lane dispatch was already marked');
        if (token == null) throw new TypeError('Plugin read lane dispatch token is required');
        entry.dispatchToken = token;
      } });
      Promise.resolve().then(() => entry.operation(control)).then(
        (value) => finish(entry, null, value),
        (error) => finish(entry, error),
      );
    }
  }

  function run({ sessionKey: keyValue, deadlineAt, signal = null, operation }) {
    const key = sessionKey(keyValue);
    const deadline = Number(deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= 0) throw new TypeError('Plugin read lane requires a positive finite deadline');
    if (typeof operation !== 'function') throw new TypeError('Plugin read lane operation must be a function');
    if (signal != null && typeof signal.addEventListener !== 'function') throw new TypeError('Plugin read lane signal must be an AbortSignal');
    if (deadline <= now()) return Promise.reject(laneError('deadline-elapsed'));
    if (signal?.aborted) return Promise.reject(laneError('cancelled'));
    if (queue.length >= maxQueue) return Promise.reject(laneError('queue-full'));
    if (queue.filter((entry) => entry.key === key).length >= maxQueuePerSession) {
      return Promise.reject(laneError('queue-full'));
    }
    return new Promise((resolve, reject) => {
      const entry = { key, deadlineAt: deadline, signal, operation, resolve, reject,
        started: false, settled: false, dispatchToken: null, timer: null, abort: null };
      entry.timer = setTimeout(() => removeQueued(entry, 'deadline-elapsed'),
        Math.max(1, Math.min(MAX_TIMER_DELAY_MS, deadline - now())));
      if (signal) {
        entry.abort = () => removeQueued(entry, 'cancelled');
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      queue.push(entry);
      drain();
    });
  }

  function settle(settlementToken) {
    for (const entry of quarantined) {
      if (!tokenMatches(entry.dispatchToken, settlementToken)) continue;
      quarantined.delete(entry);
      active.delete(entry);
      drain();
      return true;
    }
    return false;
  }

  /**
   * A typed read cannot mutate the document. Once a newly authenticated
   * connection epoch completes a main-thread probe, stale reads from older
   * epochs may release their slots without weakening write quarantine.
   */
  function recoverReconnectedSession(keyValue, { connectionEpoch } = {}) {
    const key = sessionKey(keyValue);
    if (typeof connectionEpoch !== 'string' || !connectionEpoch) {
      throw new TypeError('Plugin read lane recovery requires a connection epoch');
    }
    let recovered = 0;
    for (const entry of [...quarantined]) {
      if (entry.key !== key || entry.dispatchToken?.connectionEpoch === connectionEpoch) continue;
      quarantined.delete(entry);
      active.delete(entry);
      recovered++;
    }
    if (recovered) drain();
    return recovered;
  }

  function summary() {
    const sessions = new Set([...active, ...queue].map((entry) => entry.key)).size;
    return Object.freeze({ active: active.size, queued: queue.length,
      quarantined: quarantined.size, sessions, maxActive, maxActivePerSession,
      maxQueue, maxQueuePerSession });
  }

  return Object.freeze({ run, settle, recoverReconnectedSession, summary });
}
