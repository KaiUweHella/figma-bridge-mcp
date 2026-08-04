// `kit init` — the orchestration, not the steps it runs.
//
// Each step is a real command with its own tests; what is worth pinning here is
// that kit runs them as CHILD PROCESSES (several end with process.exit(0), which
// in-process would kill the run after the first one), that a failing step is
// reported rather than fatal, and that the report names what is still missing.
//
// The engine is pointed at a fake daemon, so nothing touches a real Figma file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'index.js');

/**
 * A daemon that answers /health as connected and /exec with a canned result.
 * `evalResult` decides what every eval returns, which is enough to drive the
 * read-only steps kit runs.
 */
function startFakeDaemon(evalResult) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', mode: 'safe', plugin: true, connections: [] }));
        return;
      }
      if (req.url === '/exec') {
        // A throwing evalResult means "this eval failed" — answer the way the
        // real daemon does, rather than crashing the test's own server.
        try {
          res.end(JSON.stringify({ result: evalResult(body) }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function runKit(args, port) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [CLI, 'kit', 'init', ...args],
      { env: { ...process.env, DAEMON_PORT: String(port) }, timeout: 120000 },
    );
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// Enough of a document for extract/export/component-list to produce something.
const OK_RESULT = () => ({
  name: 'Test File', pages: [{ name: 'Page 1', children: [] }],
  variables: [], components: [], nodes: [],
});

test('kit init runs every step and reports what it wrote', async (t) => {
  const { server, port } = await startFakeDaemon(OK_RESULT);
  const dir = mkdtempSync(join(tmpdir(), 'kit-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const res = await runKit([dir], port);

  // All three mandatory steps are named in the output, in order.
  const designAt = res.out.indexOf('DESIGN.md —');
  const tokensAt = res.out.indexOf('tokens.json —');
  const inventoryAt = res.out.indexOf('component inventory');
  assert.ok(designAt >= 0 && tokensAt > designAt && inventoryAt > tokensAt,
    `steps missing or out of order:\n${res.out}`);

  // And it says what an agent should read first — the point of the command.
  assert.match(res.out, /DESIGN\.md is what an agent should read first/);
});

test('without --storybook, the report says the mapping is missing', async (t) => {
  const { server, port } = await startFakeDaemon(OK_RESULT);
  const dir = mkdtempSync(join(tmpdir(), 'kit-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const res = await runKit([dir], port);
  // A setup that quietly lacks the Figma↔code mapping looks finished until an
  // agent needs it, so the gap has to be stated.
  assert.match(res.out, /No Storybook mapped/);
  assert.match(res.out, /--storybook/);
});

test('a missing project directory is refused with the fix', async (t) => {
  const { server, port } = await startFakeDaemon(OK_RESULT);
  t.after(() => server.close());

  const res = await runKit([join(tmpdir(), 'definitely-not-here-' + process.pid)], port);
  assert.equal(res.code, 1);
  assert.match(res.out, /Project directory not found/);
  assert.match(res.out, /kit init \.\/my-app/);
});

test('a failing step is reported, and the run continues to the next one', async (t) => {
  // Only the FIRST eval fails: extract dies, the rest must still run.
  let calls = 0;
  const { server, port } = await startFakeDaemon(() => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return OK_RESULT();
  });
  const dir = mkdtempSync(join(tmpdir(), 'kit-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  const res = await runKit([dir], port);
  // The later steps still ran — that is the whole reason each step is its own
  // child process rather than an in-process call.
  assert.match(res.out, /tokens\.json —/);
  assert.match(res.out, /component inventory/);
});

test('--out places the files where asked', async (t) => {
  const { server, port } = await startFakeDaemon(OK_RESULT);
  const dir = mkdtempSync(join(tmpdir(), 'kit-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  await runKit([dir, '--out', 'docs/figma'], port);
  // extract writes DESIGN.md itself; the directory must exist either way.
  assert.ok(existsSync(join(dir, 'docs', 'figma')), 'the --out directory is created');
});

test('kit is allowlisted for MCP and counts as a read of the design', async () => {
  const { ALLOWED_COMMANDS } = await import('../../src/figma-cli.js');
  const { isWrite } = await import('../../src/server.js');
  assert.ok(ALLOWED_COMMANDS.has('kit'));
  // It only runs read commands; the files it writes land in the user's repo.
  assert.equal(isWrite(['kit', 'init', './app']), false);
});
