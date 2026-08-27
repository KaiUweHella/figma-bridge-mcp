// Authenticated client for the one Safe-Mode daemon transport.
//
// This Module owns the transport Interface: token lookup, request signing,
// file targeting, timeouts and daemon/plugin error normalization. CLI and MCP
// are adapters at this seam; neither needs to know the wire protocol.
import { signRequest } from './daemon-auth.js';
import {
  MAX_BRIDGE_DAEMON_ERROR_BYTES,
  adaptLegacyDaemonError,
  parseBridgeDaemonError,
} from './daemon-error-envelope.js';
import { typedReadRequestValidationError } from './typed-read-operations.js';
import {
  recordRuntimeTrace,
  runtimeDuration,
  runtimeNow,
  runtimeTraceEnabled,
} from './runtime-trace.js';

export class DaemonClientError extends Error {
  constructor(message, {
    kind = 'request',
    phase = 'daemon-request',
    outcome = 'unknown-after-dispatch',
    status = null,
    schema = null,
    legacy = false,
    dispatchState = null,
    mutationReport = null,
    cause = null,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DaemonClientError';
    this.kind = kind;
    this.phase = phase;
    this.outcome = outcome;
    this.schema = schema;
    this.legacy = legacy;
    if (dispatchState != null) this.dispatchState = dispatchState;
    if (mutationReport != null) this.mutationReport = mutationReport;
    if (status != null) this.status = status;
  }
}

function parsedJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const MAX_DAEMON_ERROR_BODY_BYTES = (MAX_BRIDGE_DAEMON_ERROR_BYTES * 2) + 4096;

function boundedText(value, limit = MAX_DAEMON_ERROR_BODY_BYTES) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= limit) return bytes.toString('utf8');
  return 'Daemon error response exceeded the bounded compatibility limit';
}

async function readErrorText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return boundedText(await response.text());
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_DAEMON_ERROR_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return 'Daemon error response exceeded the bounded compatibility limit';
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function timeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout/i.test(error?.message || '');
}

/**
 * Create one daemon client.
 *
 * Callers provide state lookups instead of global configuration, which keeps
 * the Interface usable by both the long-lived MCP process and short-lived CLI
 * processes without duplicating the transport Implementation.
 */
/**
 * @param {{readToken:()=>string|null,getPort:()=>number,host?:string,tokenFile?:string,defaultFileKey?:()=>string|null,missingTokenMessage?:null|(()=>string),fetchImpl?:typeof fetch}} options
 */
export function createDaemonClient({
  readToken,
  getPort,
  host = '127.0.0.1',
  tokenFile = 'the daemon token file',
  defaultFileKey = () => null,
  missingTokenMessage = null,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof readToken !== 'function') throw new TypeError('createDaemonClient requires readToken()');
  if (typeof getPort !== 'function') throw new TypeError('createDaemonClient requires getPort()');
  if (typeof fetchImpl !== 'function') throw new TypeError('createDaemonClient requires fetch');

  const tokenOrThrow = () => {
    const token = readToken();
    if (token) return token;
    const detail = typeof missingTokenMessage === 'function'
      ? missingTokenMessage()
      : `Daemon token not found at ${tokenFile}`;
    throw new DaemonClientError(detail, {
      kind: 'missing-token',
      phase: 'client-authentication',
      outcome: 'not-dispatched',
      dispatchState: 'not-dispatched',
    });
  };

  async function request(route, {
    authPath = route.split('?')[0],
    method = 'GET',
    body = '',
    timeoutMs = 3000,
    headers = {},
    execution = false,
  } = {}) {
    const token = tokenOrThrow();
    const port = getPort();
    const url = `http://${host}:${port}${route}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          ...headers,
          ...signRequest(token, method, authPath, body),
          Host: `${host}:${port}`,
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (timeoutError(error)) {
        throw new DaemonClientError(
          execution
            ? `Execution timeout (${timeoutMs / 1000}s). The Figma operation may have completed; do not repeat it automatically. Inspect the explicitly targeted file before deciding any follow-up. Bring Figma Desktop and the Figma Bridge plugin to the foreground; use figma_connect if the Bridge stays unresponsive.`
            : `Daemon request timeout (${timeoutMs / 1000}s). Bring Figma Desktop and the Figma Bridge plugin to the foreground; use figma_connect if the Bridge stays unresponsive.`,
          {
            kind: 'timeout',
            phase: 'daemon-request',
            outcome: execution ? 'unknown-after-dispatch' : 'not-dispatched',
            ...(execution ? { dispatchState: 'unknown' } : {}),
            cause: error,
          },
        );
      }
      throw new DaemonClientError(
        `Daemon not reachable at ${url}: ${error?.message || String(error)}`,
        {
          kind: 'unavailable',
          phase: 'daemon-request',
          outcome: execution ? 'unknown-after-dispatch' : 'not-dispatched',
          ...(execution ? { dispatchState: 'unknown' } : {}),
          cause: error,
        },
      );
    }

    const text = response.ok ? await response.text() : await readErrorText(response);
    return {
      ok: response.ok,
      status: response.status,
      data: parsedJson(text),
      text,
      url,
    };
  }

  /** @param {string} action @param {Record<string, any>} [data] @param {{timeoutMs?:number,fileKey?:string|null,expectedEditor?:'figma'|'figjam'|'slides'|'dev'}} [options] */
  async function executeWithMetadata(action, data = {}, { timeoutMs = 90000, fileKey, expectedEditor } = {}) {
    const traceEnabled = runtimeTraceEnabled();
    const traceStartedAt = traceEnabled ? runtimeNow() : null;
    if (!['figma', 'figjam', 'slides', 'dev'].includes(expectedEditor)) {
      throw new TypeError('Daemon Client execution requires expectedEditor from the Command Plan');
    }
    const explicitTarget = data.fileKey ?? fileKey;
    const target = explicitTarget ?? defaultFileKey();
    /** @type {Record<string, any>} */
    const payload = { action, ...data, expectedEditor };
    if (target) payload.fileKey = target;
    // The same deadline must govern both legs of execution. Without this wire
    // field the HTTP client could wait for the owning Command Plan while the
    // Daemon silently cut the Plugin leg off at its 30-second default.
    payload.timeoutMs = timeoutMs;
    payload.deadlineAt = Date.now() + timeoutMs;
    const body = JSON.stringify(payload);
    let response;
    try {
      response = await request('/exec', {
        method: 'POST',
        body,
        timeoutMs,
        headers: { 'Content-Type': 'application/json' },
        execution: true,
      });
    } catch (error) {
      if (traceEnabled) {
        recordRuntimeTrace({
          kind: 'daemon-execution', action, ok: false,
          elapsedMs: runtimeDuration(traceStartedAt),
          requestBytes: Buffer.byteLength(body, 'utf8'),
        });
      }
      throw error;
    }

    if (!response.ok || response.data?.error || response.data?.bridgeError) {
      const raw = typeof response.data?.error === 'string'
        ? response.data.error
        : response.text || `HTTP ${response.status}`;
      const structured = parseBridgeDaemonError(response.data?.bridgeError);
      const facts = structured || adaptLegacyDaemonError(raw, { status: response.status });
      let message = facts.message;
      if (facts.kind === 'authentication') {
        message = `${facts.message}\nToken file: ${tokenFile}\nTry: node src/index.js daemon restart`;
      } else if (facts.kind === 'plugin-unavailable' && facts.outcome === 'not-dispatched') {
        message = 'Plugin not connected.\nIn Figma: Plugins → Development → Figma Bridge (keep that tab open).';
      } else if (facts.kind === 'plugin-unavailable') {
        message = 'Plugin disconnected while the request was running. The Figma operation may have completed; do not repeat it automatically. Reconnect the plugin and inspect the explicitly targeted file before deciding any follow-up.';
      } else if (facts.kind === 'plugin-timeout') {
        message = `${facts.message.split('\n')[0]}\nThe socket is open but Figma did not answer. The Figma operation may have completed; do not repeat it automatically. Inspect the explicitly targeted file before deciding any follow-up, and bring Figma Desktop plus the plugin tab to the foreground.`;
      }
      throw new DaemonClientError(message, {
        kind: facts.kind,
        phase: facts.phase,
        outcome: facts.outcome,
        schema: facts.schema,
        legacy: structured === null,
        dispatchState: facts.dispatchState
          || (facts.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown'),
        mutationReport: 'mutationReport' in facts ? facts.mutationReport : null,
        status: response.status,
      });
    }
    const outcome = {
      value: response.data?.result,
      metadata: response.data?.metadata || null,
    };
    if (traceEnabled) {
      recordRuntimeTrace({
        kind: 'daemon-execution', action, ok: true,
        elapsedMs: runtimeDuration(traceStartedAt),
        requestBytes: Buffer.byteLength(body, 'utf8'),
        responseBytes: Buffer.byteLength(response.text || '', 'utf8'),
        pluginExecutionTiming: outcome.metadata?.pluginExecutionTiming,
        bridgeExecutionTiming: outcome.metadata?.bridgeExecutionTiming,
      });
    }
    return outcome;
  }

  async function execute(action, data = {}, options = {}) {
    return (await executeWithMetadata(action, data, options)).value;
  }

  async function typedRead(operation, typedRequest, options = {}) {
    const error = typedReadRequestValidationError(operation, typedRequest);
    if (error) throw new TypeError(error);
    return execute('typed-read', { operation, request: typedRequest }, options);
  }

  async function typedReadWithFallback(operation, typedRequest, fallbackCode, options = {}) {
    if (typeof fallbackCode !== 'string' || !fallbackCode) {
      throw new TypeError('Typed read compatibility fallback requires bounded eval code');
    }
    const startedAt = Date.now();
    try {
      return await typedRead(operation, typedRequest, options);
    } catch (error) {
      const unsupportedBeforeDispatch = error?.outcome === 'not-dispatched'
        && (error?.kind === 'plugin-capability' || error?.kind === 'validation');
      if (!unsupportedBeforeDispatch) throw error;
      const remaining = Math.max(1, Number(options.timeoutMs || 90000) - (Date.now() - startedAt));
      return execute('eval', { code: fallbackCode }, { ...options, timeoutMs: remaining });
    }
  }

  return {
    execute,
    executeWithMetadata,
    evaluate(code, options) {
      return execute('eval', { code }, options);
    },
    evaluateWithMetadata(code, options) {
      return executeWithMetadata('eval', { code, requireDocumentRevision: true }, options);
    },
    typedRead,
    typedReadWithFallback,
    renderPlan(plan, options = {}) {
      const { renderOptions, ...requestOptions } = options;
      return execute('render-plan', {
        plan,
        ...(renderOptions === undefined ? {} : { options: renderOptions }),
      }, requestOptions);
    },
    renderPlanBatch(plans, batchOptions = {}, options) {
      return execute('render-plan-batch', { plans, options: batchOptions }, options);
    },
    health(options = {}) {
      const query = new URLSearchParams();
      if (options.probe === true) query.set('probe', '1');
      if (options.fileKey) query.set('fileKey', options.fileKey);
      const route = query.size ? `/health?${query}` : '/health';
      return request(route, { authPath: '/health', timeoutMs: options.timeoutMs || 3000 });
    },
    selection(options = {}) {
      const target = options.fileKey || null;
      const query = new URLSearchParams();
      if (target) query.set('fileKey', target);
      if (options.readAfterWrite === true) query.set('consistency', 'after-write');
      const route = query.size ? `/selection?${query}` : '/selection';
      return request(route, { authPath: '/selection', timeoutMs: options.timeoutMs || 3000 });
    },
    reconnect(options = {}) {
      const target = options.fileKey || null;
      const route = target ? `/reconnect?fileKey=${encodeURIComponent(target)}` : '/reconnect';
      return request(route, { authPath: '/reconnect', timeoutMs: options.timeoutMs || 6500 });
    },
    shutdown(options = {}) {
      return request('/shutdown', { timeoutMs: options.timeoutMs || 3000 });
    },
  };
}
