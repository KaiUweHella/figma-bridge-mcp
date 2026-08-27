import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { IMAGE_HARD_LIMIT } from './image-file.js';
import {
  BOUNDED_REMOTE_HTTP_LIMITS,
  BoundedRemoteHttpError,
  readBoundedRemoteHttp,
} from './bounded-remote-http.js';
import { rasterDimensions, rasterKind } from './raster-dimensions.js';

const MAX_CONFIGURED_ORIGINS = 32;
const MAX_ORIGIN_CONFIG_BYTES = 8 * 1024;
const MIME_BY_KIND = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

/** @type {Readonly<{connectTimeoutMs:number,headersTimeoutMs:number,bodyTimeoutMs:number,totalTimeoutMs:number,maxRedirects:number,maxHeaderBytes:number,maxBytes:number}>} */
export const REMOTE_RENDER_IMAGE_LIMITS = Object.freeze({
  ...BOUNDED_REMOTE_HTTP_LIMITS,
  maxBytes: IMAGE_HARD_LIMIT,
});

export class RemoteRenderImageError extends Error {
  constructor(code, reason) {
    super(`Remote Render image rejected: ${reason}.`);
    this.name = 'RemoteRenderImageError';
    this.code = code;
    this.kind = 'remote-render-image-policy';
  }
}

function rejected(code, reason) {
  return new RemoteRenderImageError(code, reason);
}

function configuredOrigin(value, scope) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw rejected('IMAGE_ORIGIN_CONFIG', 'a configured origin is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw rejected('IMAGE_ORIGIN_CONFIG', 'configured origins must use HTTP or HTTPS');
  }
  if (scope === 'public' && url.protocol !== 'https:') {
    throw rejected('IMAGE_ORIGIN_CONFIG', 'public configured origins require HTTPS');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw rejected(
      'IMAGE_ORIGIN_CONFIG',
      'configured values must be exact credential-free origins',
    );
  }
  return url.origin;
}

function originEntries(value, scope) {
  if (!value) return [];
  if (Buffer.byteLength(String(value), 'utf8') > MAX_ORIGIN_CONFIG_BYTES) {
    throw rejected('IMAGE_ORIGIN_CONFIG', 'configured origin policy is too large');
  }
  const entries = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_CONFIGURED_ORIGINS) {
    throw rejected(
      'IMAGE_ORIGIN_CONFIG',
      `configured origin policy exceeds ${MAX_CONFIGURED_ORIGINS} entries`,
    );
  }
  return entries.map((entry) => [configuredOrigin(entry, scope), scope]);
}

export function createRemoteRenderImagePolicy(env = process.env) {
  const origins = new Map();
  for (const [origin, scope] of originEntries(env.FIGMA_BRIDGE_IMAGE_ORIGINS, 'public')) {
    origins.set(origin, scope);
  }
  for (const [origin, scope] of originEntries(
    env.FIGMA_BRIDGE_IMAGE_PRIVATE_ORIGINS,
    'private',
  )) {
    origins.set(origin, scope);
  }
  function authorize(input) {
    let url;
    try {
      url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    } catch {
      throw rejected('IMAGE_URL', 'URL is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw rejected('IMAGE_URL', 'URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw rejected('IMAGE_CREDENTIALS', 'URL credentials are not allowed');
    }
    if (url.hash) throw rejected('IMAGE_URL', 'URL fragments are not supported');
    const scope = origins.get(url.origin);
    if (!scope) throw rejected('IMAGE_ORIGIN', 'origin is not an approved image origin');
    return Object.freeze({ url, origin: url.origin, scope });
  }
  return Object.freeze({
    authorize,
    origins: Object.freeze([...origins.entries()].map(([origin, scope]) =>
      Object.freeze({ origin, scope }))),
  });
}

function safeSource(url) {
  const source = `${url.origin}${url.pathname}`;
  return source.length <= 2048 ? source : `${url.origin}/(path-redacted)`;
}

function safeName(url) {
  let value = basename(url.pathname) || 'Remote image';
  try { value = decodeURIComponent(value); } catch {}
  value = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return value.slice(0, 128) || 'Remote image';
}

function remoteReason(error) {
  return String(error?.message || 'approved image origin could not be read safely')
    .replace(/^Bounded remote read rejected:\s*/i, '')
    .replace(/\.$/, '');
}

/**
 * @param {string|URL} input
 * @param {{env?:NodeJS.ProcessEnv,policy?:ReturnType<typeof createRemoteRenderImagePolicy>,limits?:Partial<typeof REMOTE_RENDER_IMAGE_LIMITS>,remainingMs?:()=>number}} [options]
 */
export async function materializeRemoteRenderImage(input, {
  env = process.env,
  policy = createRemoteRenderImagePolicy(env),
  limits = REMOTE_RENDER_IMAGE_LIMITS,
  remainingMs,
  ...transport
} = {}) {
  try {
    const commandRemainingMs = typeof remainingMs === 'function'
      ? Number(remainingMs())
      : Number.POSITIVE_INFINITY;
    if (!(commandRemainingMs > 0)) {
      throw rejected('IMAGE_TIMEOUT', 'the owning Command Plan deadline expired');
    }
    const boundedLimits = {
      ...REMOTE_RENDER_IMAGE_LIMITS,
      ...limits,
      totalTimeoutMs: Math.max(1, Math.min(
        Number(limits.totalTimeoutMs ?? REMOTE_RENDER_IMAGE_LIMITS.totalTimeoutMs),
        commandRemainingMs,
      )),
    };
    const result = await readBoundedRemoteHttp(input, {
      ...transport,
      limits: boundedLimits,
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      userAgent: 'figma-bridge-mcp/render-image',
      authorize: policy.authorize,
      isAuthorizationError: (error) => error instanceof RemoteRenderImageError,
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw rejected('IMAGE_STATUS', `approved image origin returned status ${result.statusCode}`);
    }
    const kind = rasterKind(result.bytes);
    if (!kind) throw rejected('IMAGE_TYPE', 'response bytes are not a supported raster image');
    if (result.contentType !== MIME_BY_KIND[kind]) {
      throw rejected('IMAGE_MIME', 'response Content-Type does not match its raster bytes');
    }
    let dimensions;
    try {
      dimensions = rasterDimensions(result.bytes, kind);
    } catch {
      throw rejected('IMAGE_DIMENSIONS', 'raster has invalid or unsupported intrinsic dimensions');
    }
    const digest = createHash('sha256').update(result.bytes).digest('hex');
    return Object.freeze({
      kind: 'embedded-raster',
      name: safeName(result.finalUrl),
      base64: result.bytes.toString('base64'),
      ...dimensions,
      sha256: digest,
      source: Object.freeze({ kind: 'remote-http', label: safeSource(result.finalUrl) }),
    });
  } catch (error) {
    if (error instanceof RemoteRenderImageError) throw error;
    if (error instanceof BoundedRemoteHttpError) {
      throw rejected(`IMAGE_${error.code}`, remoteReason(error));
    }
    throw rejected('IMAGE_REMOTE', 'approved image origin could not be read safely');
  }
}
