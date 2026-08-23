// Deadline-aware, per-target serialization for Plugin document mutations.
//
// The Daemon owns this queue because it is the last trusted point before a
// command crosses into an authenticated Figma Plugin runtime. The Plugin keeps
// its own defensive promise chain as a second boundary, but callers must not be
// able to fill that chain concurrently or make a timed-out write release the
// next mutation while its outcome is still unknown.

export const MAX_PLUGIN_WRITE_QUEUE = 64;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class PluginWriteLaneError extends Error {
  /** @param {'cancelled'|'deadline-elapsed'|'queue-full'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PluginWriteLaneError';
    this.code = code;
  }
}

function requiredSessionKey(value) {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError('Plugin write lane requires a bounded session key');
  }
  return value;
}

function requiredDeadline(value) {
  const deadline = Number(value);
  if (!Number.isFinite(deadline) || deadline <= 0) {
    throw new TypeError('Plugin write lane requires a positive finite deadline');
  }
  return deadline;
}

function queueError(code) {
  if (code === 'cancelled') {
    return new PluginWriteLaneError(code, 'Plugin execution cancelled before dispatch');
  }
  if (code === 'queue-full') {
    return new PluginWriteLaneError(code, 'Plugin write queue is full');
  }
  return new PluginWriteLaneError('deadline-elapsed', 'Plugin write queue deadline elapsed before dispatch');
}

/**
 * @param {{
 *   now?: () => number,
 *   maxQueue?: number,
 *   tokenMatches?: (prepared:unknown, settled:unknown) => boolean,
 * }} [options]
 */
export function createPluginWriteLanes({
  now = () => Date.now(),
  maxQueue = MAX_PLUGIN_WRITE_QUEUE,
  tokenMatches = (prepared, settled) => prepared === settled,
} = {}) {
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > MAX_PLUGIN_WRITE_QUEUE) {
    throw new TypeError(`Plugin write lane maxQueue must be 1-${MAX_PLUGIN_WRITE_QUEUE}`);
  }
  if (typeof now !== 'function' || typeof tokenMatches !== 'function') {
    throw new TypeError('Plugin write lane adapters must be functions');
  }

  /** @type {Map<string, {active:any,queue:any[],quarantine:null|{token:unknown,since:number}}>} */
  const lanes = new Map();

  function laneFor(sessionKey) {
    let lane = lanes.get(sessionKey);
    if (!lane) {
      lane = { active: null, queue: [], quarantine: null };
      lanes.set(sessionKey, lane);
    }
    return lane;
  }

  function cleanup(sessionKey, lane) {
    if (!lane.active && !lane.quarantine && lane.queue.length === 0) lanes.delete(sessionKey);
  }

  function removeQueued(sessionKey, lane, entry, code) {
    if (entry.started || entry.settled) return false;
    const index = lane.queue.indexOf(entry);
    if (index < 0) return false;
    lane.queue.splice(index, 1);
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    entry.reject(queueError(code));
    cleanup(sessionKey, lane);
    drain(sessionKey, lane);
    return true;
  }

  function clearQueueHooks(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    entry.abort = null;
  }

  function uncertainAfterDispatch(error, entry) {
    return entry.dispatchToken != null
      && error?.outcome === 'unknown-after-dispatch'
      && error?.dispatchState !== 'failed';
  }

  function finish(sessionKey, lane, entry, error, value) {
    if (entry.settled) return;
    entry.settled = true;
    lane.active = null;
    if (error && uncertainAfterDispatch(error, entry)) {
      lane.quarantine = { token: entry.dispatchToken, since: now() };
      entry.reject(error);
      return;
    }
    if (error) entry.reject(error);
    else entry.resolve(value);
    cleanup(sessionKey, lane);
    drain(sessionKey, lane);
  }

  function drain(sessionKey, lane) {
    if (lane.active || lane.quarantine) return;
    const entry = lane.queue.shift();
    if (!entry) {
      cleanup(sessionKey, lane);
      return;
    }
    if (entry.settled) {
      drain(sessionKey, lane);
      return;
    }
    if (entry.signal?.aborted) {
      entry.settled = true;
      clearQueueHooks(entry);
      entry.reject(queueError('cancelled'));
      drain(sessionKey, lane);
      return;
    }
    if (entry.deadlineAt <= now()) {
      entry.settled = true;
      clearQueueHooks(entry);
      entry.reject(queueError('deadline-elapsed'));
      drain(sessionKey, lane);
      return;
    }

    entry.started = true;
    clearQueueHooks(entry);
    lane.active = entry;
    const control = Object.freeze({
      markDispatched(token) {
        if (entry.dispatchToken != null) throw new Error('Plugin write lane dispatch was already marked');
        if (token == null) throw new TypeError('Plugin write lane dispatch token is required');
        entry.dispatchToken = token;
      },
    });
    Promise.resolve()
      .then(() => entry.operation(control))
      .then(
        (value) => finish(sessionKey, lane, entry, null, value),
        (error) => finish(sessionKey, lane, entry, error, undefined),
      );
  }

  /**
   * Run one conservative write or consistency barrier in its target lane.
   * Cancellation is intentionally observed only before start. Once dispatch
   * is marked, the Plugin receipt—not a vanished HTTP caller—owns settlement.
   *
   * @param {{
   *   sessionKey:string,
   *   deadlineAt:number,
   *   signal?:AbortSignal|null,
   *   operation:(control:{markDispatched:(token:unknown)=>void})=>Promise<unknown>|unknown,
   * }} request
   */
  function run({ sessionKey, deadlineAt, signal = null, operation }) {
    const key = requiredSessionKey(sessionKey);
    const deadline = requiredDeadline(deadlineAt);
    if (typeof operation !== 'function') throw new TypeError('Plugin write lane operation must be a function');
    if (signal != null && typeof signal.addEventListener !== 'function') {
      throw new TypeError('Plugin write lane signal must be an AbortSignal');
    }
    if (deadline <= now()) return Promise.reject(queueError('deadline-elapsed'));
    if (signal?.aborted) return Promise.reject(queueError('cancelled'));

    const lane = laneFor(key);
    if (lane.queue.length >= maxQueue) return Promise.reject(queueError('queue-full'));

    return new Promise((resolve, reject) => {
      const entry = {
        operation,
        deadlineAt: deadline,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
        dispatchToken: null,
        timer: null,
        abort: null,
      };
      const delay = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, deadline - now()));
      entry.timer = setTimeout(
        () => removeQueued(key, lane, entry, 'deadline-elapsed'),
        delay,
      );
      if (signal) {
        entry.abort = () => removeQueued(key, lane, entry, 'cancelled');
        signal.addEventListener('abort', entry.abort, { once: true });
      }
      lane.queue.push(entry);
      drain(key, lane);
    });
  }

  function waitForPriorWrites({ sessionKey, deadlineAt, signal = null }) {
    return run({ sessionKey, deadlineAt, signal, operation: () => undefined });
  }

  /** Release only the exact quarantined dispatch that later proved idle. */
  function settle(sessionKey, settlementToken) {
    const key = requiredSessionKey(sessionKey);
    const lane = lanes.get(key);
    if (!lane?.quarantine || !tokenMatches(lane.quarantine.token, settlementToken)) return false;
    lane.quarantine = null;
    cleanup(key, lane);
    drain(key, lane);
    return true;
  }

  /**
   * Explicit recovery seam. Callers must have independently proved that the
   * old Plugin runtime stopped; socket close/reconnect alone is not that proof.
   */
  function recoverStoppedRuntime(sessionKey, { runtimeStopped = false } = {}) {
    const key = requiredSessionKey(sessionKey);
    if (runtimeStopped !== true) throw new TypeError('Plugin write lane recovery requires runtime-stopped proof');
    const lane = lanes.get(key);
    if (!lane?.quarantine) return false;
    lane.quarantine = null;
    cleanup(key, lane);
    drain(key, lane);
    return true;
  }

  function summary() {
    let active = 0;
    let queued = 0;
    let quarantined = 0;
    for (const lane of lanes.values()) {
      if (lane.active) active++;
      queued += lane.queue.length;
      if (lane.quarantine) quarantined++;
    }
    return Object.freeze({ active, queued, quarantined });
  }

  return Object.freeze({ run, waitForPriorWrites, settle, recoverStoppedRuntime, summary });
}
