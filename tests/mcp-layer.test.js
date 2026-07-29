// MCP-layer tests: allowlist enforcement, engine-entry resolution, key pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the pairing key file so tests never touch the user's real
// ~/.figma-safe-mcp/plugin-key. Must be set BEFORE importing config.js/pairing.js.
process.env.PLUGIN_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'figma-safe-key-')), 'plugin-key');

test('buildArgv resolves to the vendored engine entry with the current node', async () => {
  const { buildArgv, ENGINE_ENTRY } = await import('../src/config.js');
  const { cmd, argv } = buildArgv(['canvas', 'info']);
  assert.equal(cmd, process.execPath);
  assert.equal(argv[0], ENGINE_ENTRY);
  assert.deepEqual(argv.slice(1), ['canvas', 'info']);
  assert.ok(existsSync(ENGINE_ENTRY), 'engine entry file must exist');
});

test('connect is NOT in the command allowlist (Yolo unreachable via figma_run)', async () => {
  const { ALLOWED_COMMANDS, runCli } = await import('../src/figma-cli.js');
  assert.equal(ALLOWED_COMMANDS.has('connect'), false);
  await assert.rejects(() => runCli(['connect', '--safe']), /Command not allowed: connect/);
});

test('design-system generators stay out of the allowlist (neutral-tool policy)', async () => {
  // The engine ships no third-party design-system content — shadcn and
  // blocks were removed on purpose and must not silently return.
  const { ALLOWED_COMMANDS } = await import('../src/figma-cli.js');
  assert.equal(ALLOWED_COMMANDS.has('shadcn'), false);
  assert.equal(ALLOWED_COMMANDS.has('blocks'), false);
});

test('help flags pass the allowlist gate (discoverability), connect stays blocked', async () => {
  const { HELP_TOKENS, runCli } = await import('../src/figma-cli.js');
  // --help / -h are read-only listings; runCli must not reject them at the
  // allowlist gate. Only flag forms are allowed — the engine has no `help`
  // command, so a bare "help" token would hit its unknown-command exit path.
  assert.deepEqual([...HELP_TOKENS].sort(), ['--help', '-h']);
  const res = await runCli(['--help']);
  assert.match(res.stdout, /Usage:/);
  // The listing may MENTION connect, but executing it stays blocked.
  await assert.rejects(() => runCli(['connect', '--safe']), /Command not allowed/);
});

test('runCli rejects non-array / empty / non-string args', async () => {
  const { runCli } = await import('../src/figma-cli.js');
  await assert.rejects(() => runCli([]), /non-empty array/);
  await assert.rejects(() => runCli('canvas'), /non-empty array/);
  await assert.rejects(() => runCli([123]), /must be strings/);
});

test('pairing: ensureKey persists a stable base64url key, rotate changes it', async () => {
  const { ensureKey, readKey, rotateKey } = await import('../src/pairing.js');
  const first = ensureKey();
  assert.equal(typeof first.key, 'string');
  assert.match(first.key, /^[A-Za-z0-9_-]+$/); // base64url alphabet
  assert.equal(readKey(), first.key);

  const second = ensureKey();
  assert.equal(second.created, false);
  assert.equal(second.key, first.key); // stable across calls

  const rotated = rotateKey();
  assert.notEqual(rotated, first.key);
  assert.equal(readKey(), rotated);
});

test('rejection names the full allowlist so agents stop guessing commands', async () => {
  const { ALLOWED_COMMANDS, runCli } = await import('../src/figma-cli.js');
  // "style" was one of the real guesses from the test session.
  await assert.rejects(() => runCli(['style']), (err) => {
    assert.match(err.message, /Command not allowed: style\. Allowed: /);
    // Every allowlisted command must be listed in the message.
    for (const cmd of ALLOWED_COMMANDS) assert.ok(err.message.includes(cmd), `missing ${cmd}`);
    return true;
  });
});

test('export assets output dirs resolve against the CLIENT workspace, never the engine repo', async () => {
  const { withAbsoluteOutputDir } = await import('../src/figma-cli.js');
  // Relative -o → absolute against the given base (the MCP server's cwd).
  const rel = withAbsoluteOutputDir(['export', 'assets', '1:2', '-o', 'src/assets'], '/work/project');
  assert.equal(rel.outDir, '/work/project/src/assets');
  assert.deepEqual(rel.args, ['export', 'assets', '1:2', '-o', '/work/project/src/assets']);
  // Absolute -o passes through untouched.
  const abs = withAbsoluteOutputDir(['export', 'assets', '1:2', '--output', '/elsewhere/a'], '/work/project');
  assert.equal(abs.outDir, '/elsewhere/a');
  // No -o at all → default "assets" under the base, appended explicitly.
  const none = withAbsoluteOutputDir(['export', 'assets', '1:2'], '/work/project');
  assert.equal(none.outDir, '/work/project/assets');
  assert.deepEqual(none.args.slice(-2), ['-o', '/work/project/assets']);
  // Input argv is never mutated.
  const input = ['export', 'assets', '1:2', '-o', 'x'];
  withAbsoluteOutputDir(input, '/base');
  assert.deepEqual(input, ['export', 'assets', '1:2', '-o', 'x']);
});

test('server.js parses — a syntax error here means "cannot attach to figma-safe"', async () => {
  // The suite never imports src/server.js (importing would START the stdio
  // server), so a template-literal typo in TOOLS/INSTRUCTIONS used to reach
  // users as an MCP attach failure. node --check catches it without running.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(process.execPath, ['--check', new URL('../src/server.js', import.meta.url).pathname]);
});

test('unknownParamError: wrong parameter names get a "did you mean" instead of silent fallback', async () => {
  // Safe to import since server.js only boots when run as the entry point.
  const { unknownParamError } = await import('../src/server.js');
  // the exact parameter-shape regression failure: node_id / url instead of nodeId
  assert.match(unknownParamError('figma_screenshot', { node_id: '12:34' }),
    /Unknown parameter "node_id" — did you mean "nodeId"\?/);
  assert.match(unknownParamError('figma_screenshot', { url: 'https://…' }),
    /Unknown parameter "url" — did you mean "nodeId"\?/);
  assert.match(unknownParamError('figma_screenshot', { node_id: 'x' }), /Accepted parameters:.*nodeId/);
  // correct calls pass through untouched
  assert.equal(unknownParamError('figma_screenshot', { nodeId: '12:34' }), null);
  assert.equal(unknownParamError('figma_screenshot', {}), null);
  // unmatchable junk still names itself
  assert.match(unknownParamError('figma_screenshot', { banana: 1 }), /Unknown parameter "banana"\./);
});
