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

test('withAbsoluteOutputDir handles the combined --output=dir form', async () => {
  const { withAbsoluteOutputDir } = await import('../src/figma-cli.js');
  // Commander accepts --output=dir; the old findIndex missed it and silently
  // redirected the export to the default assets dir.
  const eq = withAbsoluteOutputDir(['export', 'assets', '1:2', '--output=src/assets'], '/work/project');
  assert.equal(eq.outDir, '/work/project/src/assets');
  assert.deepEqual(eq.args, ['export', 'assets', '1:2', '--output=/work/project/src/assets']);
  const eqAbs = withAbsoluteOutputDir(['export', 'assets', '1:2', '-o=/elsewhere/a'], '/work/project');
  assert.equal(eqAbs.outDir, '/elsewhere/a');
});

test('normalizeOutputArgs anchors extract / export node|screenshot outputs to the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/figma-cli.js');
  const base = '/work/project';

  // extract: positional output, also after value-taking flags
  assert.deepEqual(normalizeOutputArgs(['extract'], base).at(-1), '/work/project/DESIGN.md');
  assert.deepEqual(normalizeOutputArgs(['extract', 'docs/D.md'], base),
    ['extract', '/work/project/docs/D.md']);
  assert.deepEqual(normalizeOutputArgs(['extract', '--pages', 'Home', 'D.md'], base),
    ['extract', '--pages', 'Home', '/work/project/D.md']);
  assert.deepEqual(normalizeOutputArgs(['extract', '--selection'], base).at(-1), '/work/project/DESIGN.md');

  // export node/screenshot: -o forms and default filenames
  assert.deepEqual(normalizeOutputArgs(['export', 'node', '1:2', '-o', 'shot.png'], base),
    ['export', 'node', '1:2', '-o', '/work/project/shot.png']);
  assert.deepEqual(normalizeOutputArgs(['export', 'node', '1:2', '--output=shot.png'], base),
    ['export', 'node', '1:2', '--output=/work/project/shot.png']);
  assert.deepEqual(normalizeOutputArgs(['export', 'node', '1:2'], base).slice(-2),
    ['-o', '/work/project/node-export.png']);
  assert.deepEqual(normalizeOutputArgs(['export', 'screenshot'], base).slice(-2),
    ['-o', '/work/project/screenshot.png']);

  // everything else passes through untouched
  assert.deepEqual(normalizeOutputArgs(['canvas', 'info'], base), ['canvas', 'info']);
  assert.deepEqual(normalizeOutputArgs(['export', 'css', '1:2'], base), ['export', 'css', '1:2']);
});

test('figma_selection tool schema exists and takes no parameters', async () => {
  const { unknownParamError } = await import('../src/server.js');
  assert.equal(unknownParamError('figma_selection', {}), null);
  assert.match(unknownParamError('figma_selection', { nodeId: '1:2' }), /This tool takes no parameters/);
});

test('normalizeOutputArgs anchors map storybook output to the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/figma-cli.js');
  const base = '/work/project';
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'http://localhost:6006'], base).slice(-2),
    ['-o', '/work/project/figma-map.json']);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'u', '-o', 'maps/m.json'], base),
    ['map', 'storybook', 'u', '-o', '/work/project/maps/m.json']);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'u', '--output=m.json'], base),
    ['map', 'storybook', 'u', '--output=/work/project/m.json']);
});

test('figma-map: loader tolerates missing/corrupt files, annotates via both keys', async () => {
  const { loadFigmaMap, annotationFor, storybookTrailer } = await import('../src/figma-map.js');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'figma-map-'));

  // Missing file → null / no annotation / empty trailer — never throws.
  assert.equal(loadFigmaMap(dir), null);
  assert.equal(annotationFor('anykey', dir), null);
  assert.equal(storybookTrailer('key `anykey`', dir), '');

  // Corrupt file → same graceful behavior.
  writeFileSync(join(dir, 'figma-map.json'), '{not json');
  assert.equal(loadFigmaMap(dir), null);

  // Valid map: lookup over BOTH figmaKey and figmaVariantKey.
  writeFileSync(join(dir, 'figma-map.json'), JSON.stringify({
    version: 1,
    mappings: [{
      figmaName: 'Button', figmaKey: 'setkey1', figmaVariantKey: 'varkey1',
      storyId: 'components-button--primary', importPath: './src/Button.stories.tsx',
    }],
  }));
  assert.match(annotationFor('setkey1', dir), /↔ story components-button--primary \(\.\/src\/Button\.stories\.tsx\)/);
  assert.match(annotationFor('varkey1', dir), /components-button--primary/);
  assert.equal(annotationFor('unknown', dir), null);

  // Trailer: dedupes multiple hits of the same story, ignores unmapped keys.
  const trailer = storybookTrailer('- A · key `setkey1`\n- B · key `varkey1`\n- C · key `nope`', dir);
  assert.match(trailer, /## Storybook mapping/);
  assert.equal((trailer.match(/components-button--primary/g) || []).length, 1);
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

test('INSTRUCTIONS stay under the 2,048-char client truncation limit', async () => {
  // MCP clients (Claude Code) cut server instructions at 2,048 characters —
  // acceptance testing proved everything past that point silently never reaches the
  // model (the verify checklist was cut off, and exactly its items were the
  // fidelity bugs that shipped). 2,000 leaves margin for future edits; the
  // full guide belongs in WORKFLOW_GUIDE (figma_reference "workflow") or in
  // tool outputs, which are not truncated.
  const { INSTRUCTIONS, WORKFLOW_GUIDE } = await import('../src/server.js');
  assert.ok(INSTRUCTIONS.length < 2000,
    `INSTRUCTIONS is ${INSTRUCTIONS.length} chars — must stay < 2000 (client truncates at 2048). ` +
    'Move new guidance into WORKFLOW_GUIDE or into tool outputs instead.');
  // The short form must point at the full guide, and the guide must carry
  // the checklist that got lost in an acceptance run.
  assert.match(INSTRUCTIONS, /figma_reference \{name:"workflow"\}/);
  assert.match(WORKFLOW_GUIDE, /never border-image/);
  assert.match(WORKFLOW_GUIDE, /verify-build/);
});

test('verify-build passes the figma_run allowlist as a read-only command', async () => {
  const { ALLOWED_COMMANDS } = await import('../src/figma-cli.js');
  const { isWrite } = await import('../src/server.js');
  assert.ok(ALLOWED_COMMANDS.has('verify-build'));
  // Read-only: must never trip the write-confirm gate.
  assert.equal(isWrite(['verify-build', '/some/project']), false);
});

test('normalizeOutputArgs: verify-build paths resolve against the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/figma-cli.js');
  const base = '/work/project';
  // projectDir positional + every path flag, separated and = forms.
  assert.deepEqual(
    normalizeOutputArgs(['verify-build', '.', '--compare', 'shot.png', '--design=fig.png',
      '--diff-out', 'diff.png', '--node', '12:34', '--max-diff', '5'], base),
    ['verify-build', '/work/project', '--compare', '/work/project/shot.png',
      '--design=/work/project/fig.png', '--diff-out', '/work/project/diff.png',
      '--node', '12:34', '--max-diff', '5'],
  );
  // --node/--max-diff values are NOT paths and must never be absolutized —
  // and the value after them must not be mistaken for the positional.
  const args = normalizeOutputArgs(['verify-build', '--node', '1:2', 'proj'], base);
  assert.deepEqual(args, ['verify-build', '--node', '1:2', '/work/project/proj']);
  // absolute inputs pass through untouched
  assert.deepEqual(
    normalizeOutputArgs(['verify-build', '/abs/dir', '--compare', '/abs/b.png'], base),
    ['verify-build', '/abs/dir', '--compare', '/abs/b.png'],
  );
});
