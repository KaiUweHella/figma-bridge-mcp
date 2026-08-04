// REST-client unit tests: token precedence, file-key parsing, HTTP error
// mapping (injected fetch — nothing talks to the real api.figma.com), and the
// audit invariant that the token NEVER appears in the log.
//
// Env is pointed at scratch files BEFORE importing config.js (module-load
// reads), same pattern as tests/mcp-layer.test.js.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "figma-bridge-rest-unit-"));
process.env.REST_TOKEN_FILE = join(tmp, "rest-token");
process.env.AUDIT_LOG_PATH = join(tmp, "audit.log");
process.env.PLUGIN_KEY_FILE = join(tmp, "plugin-key");
delete process.env.FIGMA_REST_TOKEN;

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const {
  readRestToken,
  parseFileKey,
  restFetch,
  getVersions,
  getComments,
  postComment,
  getFileComponents,
  getRestHealth,
  clearRestHealthCache,
  NOT_CONFIGURED_MSG,
} = await import("../src/figma-rest.js");

const TOKEN = "figd_secret_value_for_tests";
const TOKEN_FILE = process.env.REST_TOKEN_FILE;
const AUDIT = process.env.AUDIT_LOG_PATH;

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function fakeFetch(status, body, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });
}

test("token precedence: env > file > null", () => {
  assert.equal(readRestToken({}), null, "nothing configured → null");
  writeFileSync(TOKEN_FILE, "from-file\n");
  assert.equal(readRestToken({}), "from-file");
  assert.equal(readRestToken({ FIGMA_REST_TOKEN: "from-env" }), "from-env");
  rmSync(TOKEN_FILE);
  assert.equal(readRestToken({}), null);
});

test("parseFileKey: bare keys and every URL form; node ids never match", () => {
  assert.equal(parseFileKey("PLACEHOLDERFILEKEY"), "PLACEHOLDERFILEKEY");
  assert.equal(parseFileKey("https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=1-2"), "PLACEHOLDERFILEKEY");
  assert.equal(parseFileKey("https://www.figma.com/file/SECONDPLACEHOLDERKEY/FILE_NAME"), "SECONDPLACEHOLDERKEY");
  assert.equal(parseFileKey("12:34"), null, "node id is not a file key");
  assert.equal(parseFileKey("1-2"), null);
  assert.equal(parseFileKey(""), null);
  assert.equal(parseFileKey("short"), null, "too short for a key");
});

test("restFetch without a token throws the setup message", async () => {
  await assert.rejects(
    () => restFetch("/v1/me", { env: {} }),
    (err) => err.message === NOT_CONFIGURED_MSG,
  );
});

test("error mapping: 401/403/404/429 → actionable messages", async () => {
  const env = { FIGMA_REST_TOKEN: TOKEN };
  await assert.rejects(
    () => restFetch("/v1/me", { env, fetchImpl: fakeFetch(401, {}) }),
    /token invalid or expired.*plugin UI/s,
  );
  await assert.rejects(
    () => restFetch("/v1/files/k/comments", { env, fetchImpl: fakeFetch(403, {}) }),
    /lacks the scope: Comments \(read and write\)/,
  );
  await assert.rejects(
    () => restFetch("/v1/files/k/versions", { env, fetchImpl: fakeFetch(404, {}) }),
    /wrong or the token's account has no access/,
  );
  await assert.rejects(
    () => restFetch("/v1/me", { env, fetchImpl: fakeFetch(429, {}, { "retry-after": "30" }) }),
    /rate limited.*Retry after 30s/s,
  );
});

test("the token NEVER appears in the audit log; entries carry method+path only", async () => {
  const env = { FIGMA_REST_TOKEN: TOKEN };
  await restFetch("/v1/files/abc/versions", { env, fetchImpl: fakeFetch(200, { versions: [] }) });
  await assert.rejects(() => restFetch("/v1/me", { env, fetchImpl: fakeFetch(401, {}) }));
  const log = readFileSync(AUDIT, "utf8");
  assert.ok(!log.includes(TOKEN), "audit log must not contain the token");
  const lines = log.trim().split("\n").map((l) => JSON.parse(l));
  const restLines = lines.filter((l) => l.rest);
  assert.ok(restLines.length >= 2, "REST calls are audited");
  // Earlier tests also audit (the log is append-only) — assert on presence.
  assert.ok(
    restLines.some((l) => l.rest.method === "GET" && l.rest.path === "/v1/files/abc/versions"),
    "versions call is audited with method+path",
  );
  for (const l of restLines) {
    assert.deepEqual(Object.keys(l.rest).sort(), ["method", "path"], "rest entries carry method+path only");
  }
  const doneLines = lines.filter((l) => l.event === "done");
  assert.ok(doneLines.some((l) => l.ok === true && l.status === 200));
  assert.ok(doneLines.some((l) => l.ok === false && l.status === 401));
});

test("getVersions/getComments/getFileComponents unwrap their payloads", async () => {
  const env = { FIGMA_REST_TOKEN: TOKEN };
  const versions = await getVersions("k", {
    env,
    fetchImpl: fakeFetch(200, { versions: [{ id: "1", created_at: "2026-08-01T10:00:00Z", label: "v1", user: { handle: "alice" } }] }),
  });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].label, "v1");

  const comments = await getComments("k", {
    env,
    fetchImpl: fakeFetch(200, { comments: [{ id: "c1", message: "fix spacing" }] }),
  });
  assert.equal(comments[0].message, "fix spacing");

  const byKey = await getFileComponents("k", {
    env,
    fetchImpl: fakeFetch(200, {
      meta: {
        components: [
          { key: "K1", name: "Button", description: "Use src/Button.tsx", documentation_links: [{ uri: "https://docs" }] },
          { key: "K2", name: "Card", description: "", documentation_links: [] },
        ],
      },
    }),
  });
  assert.equal(byKey.get("K1").description, "Use src/Button.tsx");
  assert.deepEqual(byKey.get("K1").documentationLinks, ["https://docs"]);
  assert.equal(byKey.get("K2").description, "");
});

test("postComment shapes the body: reply, node anchor, canvas anchor", async () => {
  const env = { FIGMA_REST_TOKEN: TOKEN };
  const bodies = [];
  const capture = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: "new" }) };
  };
  await postComment("k", { message: "reply!", replyTo: "c9", fetchImpl: capture, env });
  await postComment("k", { message: "on node", nodeId: "1:2", x: 5, y: 6, fetchImpl: capture, env });
  await postComment("k", { message: "on canvas", x: 10, y: 20, fetchImpl: capture, env });
  assert.deepEqual(bodies[0], { message: "reply!", comment_id: "c9" });
  assert.deepEqual(bodies[1], { message: "on node", client_meta: { node_id: "1:2", node_offset: { x: 5, y: 6 } } });
  assert.deepEqual(bodies[2], { message: "on canvas", client_meta: { x: 10, y: 20 } });
});

test("getRestHealth: /v1/me success reports the handle", async () => {
  clearRestHealthCache();
  const env = { FIGMA_REST_TOKEN: TOKEN };
  const health = await getRestHealth({
    env,
    force: true,
    fetchImpl: fakeFetch(200, { handle: "alice", email: "alice@example.com" }),
  });
  assert.equal(health.ok, true);
  assert.equal(health.handle, "alice");
  assert.ok(!health.noUserScope);
});

// Scoped PATs 403 on /v1/me without "current_user:read" — a scope no feature
// here uses. The file probe decides, otherwise a working token reads as broken.
test("getRestHealth: 403 on /v1/me falls back to a file probe", async () => {
  clearRestHealthCache();
  const env = { FIGMA_REST_TOKEN: TOKEN };
  const paths = [];
  const fetchImpl = async (url) => {
    paths.push(url);
    return url.includes("/v1/me")
      ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }
      : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ versions: [] }) };
  };
  const health = await getRestHealth({ env, force: true, fileKey: "PLACEHOLDERFILEKEY", fetchImpl });
  assert.equal(health.ok, true, "file access works → token is usable");
  assert.equal(health.noUserScope, true);
  assert.match(paths[1], /\/v1\/files\/PLACEHOLDERFILEKEY\/versions\?page_size=1$/);
});

test("getRestHealth: 403 everywhere stays a failure", async () => {
  clearRestHealthCache();
  const env = { FIGMA_REST_TOKEN: TOKEN };
  const health = await getRestHealth({
    env,
    force: true,
    fileKey: "PLACEHOLDERFILEKEY",
    fetchImpl: fakeFetch(403, {}),
  });
  assert.equal(health.ok, false);
  assert.match(health.error, /lacks the scope/);
});

test("getRestHealth: no file key → 403 on /v1/me is reported as-is", async () => {
  clearRestHealthCache();
  const env = { FIGMA_REST_TOKEN: TOKEN };
  const health = await getRestHealth({ env, force: true, fetchImpl: fakeFetch(403, {}) });
  assert.equal(health.ok, false);
  assert.match(health.error, /\/v1\/me/);
});

test("getRestHealth: result is cached until cleared", async () => {
  clearRestHealthCache();
  const env = { FIGMA_REST_TOKEN: TOKEN };
  let calls = 0;
  const counting = async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ handle: "alice" }) };
  };
  await getRestHealth({ env, force: true, fetchImpl: counting });
  await getRestHealth({ env, fetchImpl: counting });
  assert.equal(calls, 1, "second call served from cache");
  clearRestHealthCache();
  await getRestHealth({ env, fetchImpl: counting });
  assert.equal(calls, 2);
});
