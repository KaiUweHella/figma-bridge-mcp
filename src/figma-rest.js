// Opt-in Figma REST API client (Personal Access Token).
//
// This is the ONLY module that talks to api.figma.com. It exists for exactly
// the things the local plugin bridge structurally cannot do:
//   - version history READ (the plugin API can only write versions),
//   - comments read/write (unreachable from the plugin API),
//   - published library component metadata (description/documentation links).
//
// Security posture:
//   - No token → every function reports "not configured"; nothing else changes.
//   - The token is entered in the PLUGIN UI and persisted 0600 by the daemon
//     (~/.figma-bridge-mcp/rest-token). FIGMA_REST_TOKEN env overrides the
//     file for headless/CI use. The token never appears in chat, MCP client
//     config, tool output, or the audit log.
//   - Every REST call is audited with method + path only.
//   - Default file scope is the file open in Figma Desktop (fileKey pushed by
//     the plugin); other files only via an explicit key/URL parameter.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { REST_TOKEN_FILE } from "./config.js";
import { appendAudit, getSelection } from "./figma-cli.js";

const BASE_URL = "https://api.figma.com";
const TIMEOUT_MS = 10000;

/**
 * Resolve the REST token: env override first (headless/CI), then the file the
 * daemon wrote from the plugin UI. Returns null when unconfigured.
 * @returns {string|null}
 */
export function readRestToken(env = process.env) {
  const fromEnv = (env.FIGMA_REST_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const v = fs.readFileSync(REST_TOKEN_FILE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** One-paragraph setup pointer used by every tool when no token is present. */
export const NOT_CONFIGURED_MSG =
  "Figma REST access is not configured (optional). To enable version history, " +
  "comments and library metadata: open the FigCli plugin in Figma Desktop and " +
  "paste a Figma personal access token into 'REST token (optional)' — it is " +
  "stored 0600 on this machine only. Headless alternative: set the " +
  "FIGMA_REST_TOKEN environment variable. Required scopes: file content " +
  "(read), file versions (read), comments (read/write).";

/**
 * Extract a Figma file key from a bare key or any Figma URL form
 * (…/file/<key>/…, …/design/<key>/…). Returns null if nothing matches.
 * @param {string} input
 * @returns {string|null}
 */
export function parseFileKey(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  const s = input.trim();
  const url = s.match(/(?:file|design|board)\/([A-Za-z0-9]{10,64})/);
  if (url) return url[1];
  // Bare keys are alphanumeric; node ids ("12:34") and paths must not match.
  if (/^[A-Za-z0-9]{10,64}$/.test(s)) return s;
  return null;
}

/**
 * Resolve the target file key: explicit param > fileKey pushed by the plugin
 * with the live selection. Returns {key} or {error} with an actionable message.
 * @param {string} [explicit]
 * @returns {Promise<{key: string|null, source: string, error?: string}>}
 */
export async function resolveFileKey(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    const key = parseFileKey(String(explicit));
    if (key) return { key, source: "explicit" };
    return {
      key: null,
      source: "explicit",
      error:
        `Could not parse a file key from "${String(explicit).slice(0, 120)}". ` +
        "Pass the bare key or a full Figma URL (…figma.com/design/<key>/…).",
    };
  }
  const sel = await getSelection();
  const key = sel.ok && sel.selection && typeof sel.selection.fileKey === "string"
    ? sel.selection.fileKey
    : null;
  if (key) return { key, source: "open-file" };
  return {
    key: null,
    source: "open-file",
    error:
      "No file key available: pass fileKey (bare key or Figma URL) explicitly, " +
      "or select something in the target file in Figma Desktop so the plugin " +
      "pushes its file identity (needs the current plugin version; drafts that " +
      "were never saved have no key).",
  };
}

/**
 * Map a non-OK REST response to an actionable error message.
 * @param {number} status
 * @param {string} path
 * @param {Headers} [headers]
 * @returns {string}
 */
function restErrorMessage(status, path, headers) {
  if (status === 401)
    return "Figma REST: token invalid or expired (401). Re-paste a fresh personal access token in the FigCli plugin UI (or update FIGMA_REST_TOKEN).";
  if (status === 403) {
    // Name the ONE scope this path needs — the generic list sent people
    // hunting through settings for scopes their call never touched.
    const scope = /\/components$/.test(path)
      ? "Library content (read) — and the file must be a published library"
      : /\/comments$/.test(path)
        ? "Comments (read and write)"
        : /\/versions/.test(path)
          ? "File versions (read)"
          : path === "/v1/me"
            ? "Current user (read) — optional here, no feature needs it"
            : "File content (read)";
    return `Figma REST: forbidden (403) for ${path}. The token lacks the scope: ${scope}. Edit the token's scopes in Figma (Settings → Security → Personal access tokens) and re-paste it in the plugin.`;
  }
  if (status === 404)
    return `Figma REST: not found (404) for ${path}. The file key is wrong or the token's account has no access to this file.`;
  if (status === 429) {
    const retry = headers && headers.get ? headers.get("retry-after") : null;
    return `Figma REST: rate limited (429).${retry ? ` Retry after ${retry}s.` : ""} Wait and re-run.`;
  }
  return `Figma REST: HTTP ${status} for ${path}.`;
}

/**
 * Authenticated fetch against api.figma.com with audit logging (method + path
 * only — never the token, headers, or body). Throws Error with an actionable
 * message on any failure.
 * @param {string} path - e.g. "/v1/files/abc/versions"
 * @param {{method?: string, body?: object, fetchImpl?: typeof fetch, env?: object}} [opts]
 * @returns {Promise<any>} parsed JSON
 */
export async function restFetch(path, opts = {}) {
  const token = readRestToken(opts.env);
  if (!token) throw new Error(NOT_CONFIGURED_MSG);
  const doFetch = opts.fetchImpl || fetch;
  const method = opts.method || "GET";
  const id = randomUUID();
  appendAudit({ id, ts: new Date().toISOString(), rest: { method, path } });
  let ok = false;
  let status = null;
  try {
    const res = await doFetch(BASE_URL + path, {
      method,
      headers: {
        "X-Figma-Token": token,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    if (!res.ok) throw new Error(restErrorMessage(res.status, path, res.headers));
    ok = true;
    return await res.json();
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Figma REST: request to ${path} timed out after ${TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    appendAudit({
      id,
      ts: new Date().toISOString(),
      event: "done",
      ok,
      ...(status !== null ? { status } : {}),
    });
  }
}

// --- Token health with a short in-memory cache (figma_status validation) ---
let healthCache = null; // { at: ms, value: {ok, handle?, email?, error?} }
const HEALTH_CACHE_MS = 5 * 60 * 1000;

/**
 * Validate the token for status display. Cached for 5 minutes. Returns
 * {ok, handle?, email?, error?} instead of throwing.
 *
 * /v1/me is the cheap probe, but on scoped personal access tokens it needs
 * "current_user:read" — a scope NONE of our features use. A 403 there says
 * nothing about file access, so fall back to probing what we actually call:
 * the versions endpoint of the target file.
 * @param {{fileKey?: string, fetchImpl?: typeof fetch, env?: object, force?: boolean}} [opts]
 */
export async function getRestHealth(opts = {}) {
  if (!opts.force && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_MS) {
    return healthCache.value;
  }
  const { fileKey, ...fetchOpts } = opts;
  let value;
  try {
    const me = await restFetch("/v1/me", { ...fetchOpts });
    value = { ok: true, handle: me.handle || me.email || "unknown", email: me.email };
  } catch (err) {
    value = { ok: false, error: err.message };
    if (/\(403\)/.test(err.message) && fileKey) {
      try {
        await restFetch(
          `/v1/files/${encodeURIComponent(fileKey)}/versions?page_size=1`,
          fetchOpts,
        );
        value = { ok: true, handle: null, noUserScope: true };
      } catch (err2) {
        value = { ok: false, error: err2.message };
      }
    }
  }
  healthCache = { at: Date.now(), value };
  return value;
}

/** Test hook / token-change hook: drop the health cache. */
export function clearRestHealthCache() {
  healthCache = null;
}

/**
 * Version history of a file (what DESIGNERS did — the plugin API cannot read
 * this). Returns the raw versions array (newest first, as Figma returns it).
 * @param {string} fileKey
 * @param {{fetchImpl?: typeof fetch, env?: object}} [opts]
 * @returns {Promise<Array<{id:string, created_at:string, label:string|null, description:string|null, user:{handle:string}}>>}
 */
export async function getVersions(fileKey, opts = {}) {
  const data = await restFetch(`/v1/files/${encodeURIComponent(fileKey)}/versions`, opts);
  return Array.isArray(data.versions) ? data.versions : [];
}

/**
 * Comments of a file, flat list as Figma returns it (replies carry parent_id).
 * @param {string} fileKey
 * @param {{fetchImpl?: typeof fetch, env?: object}} [opts]
 */
export async function getComments(fileKey, opts = {}) {
  const data = await restFetch(`/v1/files/${encodeURIComponent(fileKey)}/comments`, opts);
  return Array.isArray(data.comments) ? data.comments : [];
}

/**
 * Post a comment. Caller is responsible for the confirm gate — this function
 * just executes. Anchoring: nodeId pins to a node (with optional offset),
 * x/y alone pin to canvas coordinates, replyTo threads under a comment.
 * @param {string} fileKey
 * @param {{message: string, nodeId?: string, x?: number, y?: number, replyTo?: string, fetchImpl?: typeof fetch, env?: object}} params
 */
export async function postComment(fileKey, params) {
  const body = { message: params.message };
  if (params.replyTo) body.comment_id = params.replyTo;
  else if (params.nodeId) {
    body.client_meta = {
      node_id: params.nodeId,
      node_offset: { x: params.x || 0, y: params.y || 0 },
    };
  } else if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
    body.client_meta = { x: params.x, y: params.y };
  }
  return restFetch(`/v1/files/${encodeURIComponent(fileKey)}/comments`, {
    method: "POST",
    body,
    fetchImpl: params.fetchImpl,
    env: params.env,
  });
}

/**
 * Published components of a file (library metadata: description and
 * documentation_links — a stronger mapping signal than name matching).
 * Returns a Map keyed by component key.
 * @param {string} fileKey
 * @param {{fetchImpl?: typeof fetch, env?: object}} [opts]
 * @returns {Promise<Map<string, {name: string, description: string, documentationLinks: string[]}>>}
 */
export async function getFileComponents(fileKey, opts = {}) {
  const data = await restFetch(`/v1/files/${encodeURIComponent(fileKey)}/components`, opts);
  const list = (data.meta && Array.isArray(data.meta.components)) ? data.meta.components : [];
  const byKey = new Map();
  for (const c of list) {
    if (!c || typeof c.key !== "string") continue;
    byKey.set(c.key, {
      name: c.name || "",
      description: (c.description || "").trim(),
      documentationLinks: Array.isArray(c.documentation_links)
        ? c.documentation_links.map((l) => (l && l.uri) || "").filter(Boolean)
        : [],
    });
  }
  return byKey;
}
