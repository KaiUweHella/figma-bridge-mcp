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

export class DaemonClientError extends Error {
  constructor(message, {
    kind = 'request',
    phase = 'daemon-request',
    outcome = 'unknown-after-dispatch',
    status = null,
    schema = null,
    legacy = false,
    cause = null,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DaemonClientError';
    this.kind = kind;
    this.phase = phase;
    this.outcome = outcome;
    this.schema = schema;
    this.legacy = legacy;
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

  /** @param {string} action @param {Record<string, any>} [data] @param {{timeoutMs?:number,fileKey?:string|null}} [options] */
  async function executeWithMetadata(action, data = {}, { timeoutMs = 90000, fileKey } = {}) {
    const explicitTarget = data.fileKey ?? fileKey;
    const target = explicitTarget ?? defaultFileKey();
    /** @type {Record<string, any>} */
    const payload = { action, ...data };
    if (target) payload.fileKey = target;
    // The same deadline must govern both legs of execution. Without this wire
    // field the HTTP client could wait for the owning Command Plan while the
    // Daemon silently cut the Plugin leg off at its 30-second default.
    payload.timeoutMs = timeoutMs;
    const body = JSON.stringify(payload);
    const response = await request('/exec', {
      method: 'POST',
      body,
      timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      execution: true,
    });

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
        status: response.status,
      });
    }
    return {
      value: response.data?.result,
      metadata: response.data?.metadata || null,
    };
  }

  async function execute(action, data = {}, options = {}) {
    return (await executeWithMetadata(action, data, options)).value;
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
    renderPlan(plan, options) {
      return execute('render-plan', { plan }, options);
    },
    renderPlanBatch(plans, batchOptions = {}, options) {
      return execute('render-plan-batch', { plans, options: batchOptions }, options);
    },
    health(options = {}) {
      return request('/health', { timeoutMs: options.timeoutMs || 3000 });
    },
    selection(options = {}) {
      const target = options.fileKey || null;
      const route = target ? `/selection?fileKey=${encodeURIComponent(target)}` : '/selection';
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
