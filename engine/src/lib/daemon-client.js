// Authenticated client for the one Safe-Mode daemon transport.
//
// This Module owns the transport Interface: token lookup, request signing,
// file targeting, timeouts and daemon/plugin error normalization. CLI and MCP
// are adapters at this seam; neither needs to know the wire protocol.
import { signRequest } from './daemon-auth.js';

export class DaemonClientError extends Error {
  constructor(message, { kind = 'request', status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DaemonClientError';
    this.kind = kind;
    if (status != null) this.status = status;
  }
}

function parsedJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
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
    throw new DaemonClientError(detail, { kind: 'missing-token' });
  };

  async function request(route, {
    authPath = route.split('?')[0],
    method = 'GET',
    body = '',
    timeoutMs = 3000,
    headers = {},
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
          `Execution timeout (${timeoutMs / 1000}s). Try reconnecting: node src/index.js connect`,
          { kind: 'timeout', cause: error },
        );
      }
      throw new DaemonClientError(
        `Daemon not reachable at ${url}: ${error?.message || String(error)}`,
        { kind: 'unavailable', cause: error },
      );
    }

    const text = await response.text();
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
    const body = JSON.stringify(payload);
    const response = await request('/exec', {
      method: 'POST',
      body,
      timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok || response.data?.error) {
      const raw = response.data?.error || response.text || `HTTP ${response.status}`;
      let message = String(raw).split('\n')[0];
      let kind = 'response';
      if (/Unauthorized|token/i.test(raw)) {
        kind = 'authentication';
        message = `${raw}\nToken file: ${tokenFile}\nTry: node src/index.js daemon restart`;
      } else if (/Plugin not connected/i.test(raw)) {
        kind = 'plugin-unavailable';
        message = 'Plugin not connected.\nIn Figma: Plugins → Development → Figma Bridge (keep that tab open).';
      }
      throw new DaemonClientError(message, { kind, status: response.status });
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
    evaluate(code, options) {
      return execute('eval', { code }, options);
    },
    evaluateWithMetadata(code, options) {
      return executeWithMetadata('eval', { code }, options);
    },
    health(options = {}) {
      return request('/health', { timeoutMs: options.timeoutMs || 3000 });
    },
    selection(options = {}) {
      const target = options.fileKey || null;
      const route = target ? `/selection?fileKey=${encodeURIComponent(target)}` : '/selection';
      return request(route, { authPath: '/selection', timeoutMs: options.timeoutMs || 3000 });
    },
  };
}
