// Small in-memory registry for long-running, semantically deduplicated jobs.
//
// The Command Capability owns each job key. This Module owns attachment,
// completion state and bounded success caching; command Adapters own polling
// text and error projection.

/** @typedef {number | { unref?: () => void }} TimerHandle */

/**
 * @param {{
 *   resultCacheMs?: number,
 *   terminalRetentionMs?: number,
 *   now?: () => number,
 *   setTimer?: (callback: () => void, delay: number) => TimerHandle,
 * }} [options]
 */
export function createTrackedJobRegistry({
  resultCacheMs = 60_000,
  terminalRetentionMs = resultCacheMs,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!Number.isFinite(resultCacheMs) || resultCacheMs < 0) {
    throw new TypeError('Tracked Job resultCacheMs must be a finite non-negative number.');
  }
  if (!Number.isFinite(terminalRetentionMs) || terminalRetentionMs < 0) {
    throw new TypeError('Tracked Job terminalRetentionMs must be a finite non-negative number.');
  }
  const jobs = new Map();

  function unrefTimer(timer) {
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  function discard(key, job) {
    if (jobs.get(key) === job) jobs.delete(key);
  }

  function scheduleEviction(key, job, evictAt) {
    if (jobs.get(key) !== job) return;
    if (job.evictAt !== null && job.evictAt <= evictAt) return;
    job.evictAt = evictAt;
    const delay = Math.max(0, evictAt - now());
    const timer = setTimer(() => discard(key, job), delay);
    unrefTimer(timer);
  }

  function retainTerminalJob(key, job) {
    job.settledAt = now();
    job.terminalEvictAt = job.settledAt + terminalRetentionMs;
    scheduleEviction(key, job, job.terminalEvictAt);
  }

  function attach(key, operation) {
    if (typeof key !== 'string' || !key) throw new TypeError('Tracked Job key is required.');
    if (typeof operation !== 'function') throw new TypeError('Tracked Job operation is required.');
    const existing = jobs.get(key);
    if (existing) return Object.freeze({ job: existing, started: false });

    const job = {
      startedAt: now(),
      done: false,
      result: null,
      error: null,
      settledAt: null,
      terminalEvictAt: null,
      evictAt: null,
      promise: null,
    };
    job.promise = Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          job.done = true;
          job.result = result;
          retainTerminalJob(key, job);
          return result;
        },
        (error) => {
          job.done = true;
          job.error = error;
          retainTerminalJob(key, job);
          // Keep the rejection observed: consumers inspect job.error after
          // awaiting this shared settlement Promise.
          return null;
        },
      );
    jobs.set(key, job);
    return Object.freeze({ job, started: true });
  }

  function cacheSuccess(key, job) {
    if (jobs.get(key) !== job || !job.done || job.error || job.terminalEvictAt === null) return;
    // Observation may shorten retention, but it must never move the hard
    // terminal deadline forward. Repeated identical polls therefore cannot
    // keep a stale result alive indefinitely.
    const observedEvictAt = Math.min(job.terminalEvictAt, now() + resultCacheMs);
    scheduleEviction(key, job, observedEvictAt);
  }

  function size() {
    return jobs.size;
  }

  return Object.freeze({ attach, discard, cacheSuccess, size });
}
