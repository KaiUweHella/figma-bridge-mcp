// MCP-layer tests: allowlist enforcement, engine-entry resolution, key pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate the pairing key file so tests never touch the user's real
// ~/.figma-bridge-mcp/plugin-key. Must be set BEFORE importing config.js/pairing.js.
process.env.PLUGIN_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'figma-bridge-key-')), 'plugin-key');

test('buildArgv resolves to the vendored engine entry with the current node', async () => {
  const { buildArgv, ENGINE_ENTRY } = await import('../src/config.js');
  const { cmd, argv } = buildArgv(['canvas', 'info']);
  assert.equal(cmd, process.execPath);
  assert.equal(argv[0], ENGINE_ENTRY);
  assert.deepEqual(argv.slice(1), ['canvas', 'info']);
  assert.ok(existsSync(ENGINE_ENTRY), 'engine entry file must exist');
});

test('connect is NOT in the command allowlist (Yolo unreachable via figma_run)', async () => {
  const { ALLOWED_COMMANDS, runCli } = await import('../src/engine.js');
  assert.equal(ALLOWED_COMMANDS.has('connect'), false);
  await assert.rejects(() => runCli(['connect', '--safe']), /Command not allowed: connect/);
});

test('design-system generators stay out of the allowlist (neutral-tool policy)', async () => {
  // The engine ships no third-party design-system content — shadcn and
  // blocks were removed on purpose and must not silently return.
  const { ALLOWED_COMMANDS } = await import('../src/engine.js');
  assert.equal(ALLOWED_COMMANDS.has('shadcn'), false);
  assert.equal(ALLOWED_COMMANDS.has('blocks'), false);
});

test('help flags pass the allowlist gate (discoverability), connect stays blocked', async () => {
  const { HELP_TOKENS, runCli } = await import('../src/engine.js');
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
  const { runCli } = await import('../src/engine.js');
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
  const { ALLOWED_COMMANDS, runCli } = await import('../src/engine.js');
  // Use a permanently unknown sentinel: real command groups may become
  // allowlisted as the Plugin API coverage grows (as `style` did).
  await assert.rejects(() => runCli(['definitely-not-a-command']), (err) => {
    assert.match(err.message, /Command not allowed: definitely-not-a-command\. Allowed: /);
    // Every allowlisted command must be listed in the message.
    for (const cmd of ALLOWED_COMMANDS) assert.ok(err.message.includes(cmd), `missing ${cmd}`);
    return true;
  });
});

test('export assets output dirs resolve against the CLIENT workspace, never the engine repo', async () => {
  const { withAbsoluteOutputDir } = await import('../src/engine.js');
  const base = resolve('work', 'project');
  const output = join(base, 'src', 'assets');
  // Relative -o → absolute against the given base (the MCP server's cwd).
  const rel = withAbsoluteOutputDir(['export', 'assets', '1:2', '-o', 'src/assets'], base);
  assert.equal(rel.outDir, output);
  assert.deepEqual(rel.args, ['export', 'assets', '1:2', '-o', output]);
  // Absolute -o passes through untouched.
  const absoluteOutput = resolve('elsewhere', 'a');
  const abs = withAbsoluteOutputDir(['export', 'assets', '1:2', '--output', absoluteOutput], base);
  assert.equal(abs.outDir, absoluteOutput);
  // No -o at all → default "assets" under the base, appended explicitly.
  const none = withAbsoluteOutputDir(['export', 'assets', '1:2'], base);
  assert.equal(none.outDir, join(base, 'assets'));
  assert.deepEqual(none.args.slice(-2), ['-o', join(base, 'assets')]);
  // Input argv is never mutated.
  const input = ['export', 'assets', '1:2', '-o', 'x'];
  withAbsoluteOutputDir(input, '/base');
  assert.deepEqual(input, ['export', 'assets', '1:2', '-o', 'x']);
});

test('withAbsoluteOutputDir handles the combined --output=dir form', async () => {
  const { withAbsoluteOutputDir } = await import('../src/engine.js');
  const base = resolve('work', 'project');
  const output = join(base, 'src', 'assets');
  // Commander accepts --output=dir; the old findIndex missed it and silently
  // redirected the export to the default assets dir.
  const eq = withAbsoluteOutputDir(['export', 'assets', '1:2', '--output=src/assets'], base);
  assert.equal(eq.outDir, output);
  assert.deepEqual(eq.args, ['export', 'assets', '1:2', `--output=${output}`]);
  const absoluteOutput = resolve('elsewhere', 'a');
  const eqAbs = withAbsoluteOutputDir(['export', 'assets', '1:2', `-o=${absoluteOutput}`], base);
  assert.equal(eqAbs.outDir, absoluteOutput);
});

test('normalizeOutputArgs anchors extract / export node|screenshot outputs to the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/engine.js');
  const base = resolve('work', 'project');
  const inWorkspace = (...parts) => join(base, ...parts);

  // extract: positional output, also after value-taking flags
  assert.deepEqual(normalizeOutputArgs(['extract'], base).at(-1), inWorkspace('DESIGN.md'));
  assert.deepEqual(normalizeOutputArgs(['extract', 'docs/D.md'], base),
    ['extract', inWorkspace('docs', 'D.md')]);
  assert.deepEqual(normalizeOutputArgs(['extract', '--pages', 'Home', 'D.md'], base),
    ['extract', '--pages', 'Home', inWorkspace('D.md')]);
  assert.deepEqual(normalizeOutputArgs(['extract', '--selection'], base).at(-1), inWorkspace('DESIGN.md'));

  // export node/screenshot: -o forms and default filenames
  assert.deepEqual(normalizeOutputArgs(['export', 'node', '1:2', '-o', 'shot.png'], base),
    ['export', 'node', '1:2', '-o', inWorkspace('shot.png')]);
  assert.deepEqual(normalizeOutputArgs(['export', 'node', '1:2', '--output=shot.png'], base),
    ['export', 'node', '1:2', `--output=${inWorkspace('shot.png')}`]);
  assert.deepEqual(normalizeOutputArgs(['export', 'node', '1:2'], base).slice(-2),
    ['-o', inWorkspace('node-export.png')]);
  assert.deepEqual(normalizeOutputArgs(['export', 'screenshot'], base).slice(-2),
    ['-o', inWorkspace('screenshot.png')]);

  // everything else passes through untouched
  assert.deepEqual(normalizeOutputArgs(['canvas', 'info'], base), ['canvas', 'info']);
  assert.deepEqual(normalizeOutputArgs(['export', 'css', '1:2'], base), ['export', 'css', '1:2']);
});

test('figma_selection accepts only an optional file target', async () => {
  const { unknownParamError } = await import('../src/server.js');
  assert.equal(unknownParamError('figma_selection', {}), null);
  assert.equal(unknownParamError('figma_selection', { fileKey: 'FILE_A' }), null);
  assert.match(unknownParamError('figma_selection', { nodeId: '1:2' }), /Accepted parameters: fileKey/);
});

test('normalizeOutputArgs anchors map storybook output to the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/engine.js');
  const base = resolve('work', 'project');
  const inWorkspace = (...parts) => join(base, ...parts);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'http://localhost:6006'], base).slice(-2),
    ['-o', inWorkspace('figma-map.json')]);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'u', '-o', 'maps/m.json'], base),
    ['map', 'storybook', 'u', '-o', inWorkspace('maps', 'm.json')]);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'u', '--output=m.json'], base),
    ['map', 'storybook', 'u', `--output=${inWorkspace('m.json')}`]);
});

test('Design Link Registry projection tolerates missing/corrupt files and keeps legacy Storybook mappings', async () => {
  const {
    loadFigmaMap, annotationFor, designEntityAnnotationFor,
    designEntityTrailer,
    storybookTrailer, storybookMappingsForSpecModel,
  } = await import('../src/figma-map.js');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'figma-map-'));

  // Missing file → null / no annotation / empty trailer — never throws.
  assert.equal(loadFigmaMap(dir), null);
  assert.equal(annotationFor('anykey', dir), null);
  assert.equal(storybookTrailer('key `anykey`', dir), '');
  assert.equal(designEntityTrailer('entity `ui.missing`', dir), '');

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
  assert.match(designEntityAnnotationFor({ componentKey: 'setkey1' }, dir), /entity `legacy\./);
  assert.match(designEntityAnnotationFor({ componentKey: 'setkey1' }, dir), /code src\/Button\.stories\.tsx/);
  assert.equal(annotationFor('unknown', dir), null);

  // Trailer: dedupes multiple hits of the same story, ignores unmapped keys.
  const trailer = storybookTrailer('- A · key `setkey1`\n- B · key `varkey1`\n- C · key `nope`', dir);
  assert.match(trailer, /## Storybook mapping/);
  assert.equal((trailer.match(/components-button--primary/g) || []).length, 1);

  // Structured outputs carry keys as fields, not as rendered `key` text.
  // Mapping must therefore enrich the canonical model, independent of format.
  const mappings = storybookMappingsForSpecModel({
    frames: [{ t: 'INSTANCE', n: 'Button', mainKey: 'varkey1' }],
    sets: [{ name: 'Button', setKey: 'setkey1' }],
  }, dir);
  assert.equal(mappings.length, 1, 'same story reached through two keys is deduped');
  assert.equal(mappings[0].storyId, 'components-button--primary');
});

test('explicit figma-bridge.json entity resolves by id, node, and publish key', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const {
    designEntityAnnotationFor, designEntityFor,
    designEntityMappingsForSpecModel, designEntityTrailer,
  } = await import('../src/figma-map.js');
  const dir = mkdtempSync(join(tmpdir(), 'figma-bridge-registry-'));
  writeFileSync(join(dir, 'figma-bridge.json'), JSON.stringify({
    version: 1,
    project: { name: 'app' },
    entities: [{
      id: 'screen.settings', kind: 'screen',
      code: { path: 'src/routes/settings.tsx', export: 'SettingsScreen' },
      figma: { fileKey: 'FILE', nodeId: '9:9', componentKey: 'KEY' },
    }],
  }));
  assert.equal(designEntityFor({ id: 'screen.settings' }, dir).figmaNodeId, '9:9');
  assert.equal(designEntityFor({ fileKey: 'FILE', nodeId: '9:9' }, dir).entityId, 'screen.settings');
  assert.match(designEntityAnnotationFor({ componentKey: 'KEY' }, dir), /src\/routes\/settings\.tsx#SettingsScreen/);
  assert.match(designEntityTrailer('- Settings entity `screen.settings` [screen]', dir),
    /## Design Entity links[\s\S]*src\/routes\/settings\.tsx#SettingsScreen/);
  assert.deepEqual(designEntityMappingsForSpecModel({
    frames: [{ t: 'FRAME', n: 'Settings', entityId: 'screen.settings', kids: [] }],
  }, dir), [{
    id: 'screen.settings', kind: 'screen',
    code: { path: 'src/routes/settings.tsx', export: 'SettingsScreen' },
    figma: { fileKey: 'FILE', nodeId: '9:9', componentKey: 'KEY' },
  }]);
});

test('server.js parses — a syntax error here means "cannot attach to figma-bridge"', async () => {
  // The suite never imports src/server.js (importing would START the stdio
  // server), so a template-literal typo in TOOLS/INSTRUCTIONS used to reach
  // users as an MCP attach failure. node --check catches it without running.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(process.execPath, ['--check', fileURLToPath(new URL('../src/server.js', import.meta.url))]);
});

test('figma_run keeps Design Link execution in-process', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  assert.match(source, /normalized\[0\] === "link"/);
  assert.match(source, /executeDesignLink\(designLinkRequestFromArgv\(normalized\)/);
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

test('MCP handshake keeps the complete fidelity path in the initial context', async () => {
  // MCP clients (Claude Code) cut server instructions at 2,048 characters —
  // acceptance testing proved everything past that point silently never reaches the
  // model (the verify checklist was cut off, and exactly its items were the
  // fidelity bugs that shipped). 2,000 leaves margin for future edits; the
  // full guide belongs in WORKFLOW_GUIDE (figma_reference "workflow") or in
  // tool outputs, which are not truncated.
  const { INSTRUCTIONS, VARIABLE_SCOPE_GUIDE, WORKFLOW_GUIDE, TOOLS, workflowGuideFor } = await import('../src/server.js');
  assert.ok(INSTRUCTIONS.length < 2000,
    `INSTRUCTIONS is ${INSTRUCTIONS.length} chars — Claude Code truncates at 2048.`);
  // These steps cannot be hidden behind an optional reference call. an earlier acceptance run
  // proved that a capable agent can otherwise read every spec and still ship
  // zero real assets, invented SVGs and no verification pass.
  assert.match(INSTRUCTIONS, /figma_screenshot/);
  assert.match(INSTRUCTIONS, /export","assets/);
  assert.match(INSTRUCTIONS, /Never substitute CSS|never substitute CSS/i);
  assert.match(INSTRUCTIONS, /verify-build/);
  assert.match(INSTRUCTIONS, /Do not finish|before declaring done/i);
  assert.match(INSTRUCTIONS, /figma_reference \{name:"workflow"\}/);
  assert.match(WORKFLOW_GUIDE, /never border-image/);
  assert.match(WORKFLOW_GUIDE, /verify-build/);
  assert.ok(workflowGuideFor('workflow:design-to-code').length < WORKFLOW_GUIDE.length);
  assert.match(workflowGuideFor('workflow:code-to-figma'), /Code-to-Figma workflow/);
  assert.match(workflowGuideFor('workflow:code-to-figma'), /SCOPE DECISION REQUIRED/);
  assert.match(VARIABLE_SCOPE_GUIDE, /COLOR: ALL_SCOPES, ALL_FILLS/);
  assert.match(VARIABLE_SCOPE_GUIDE, /FLOAT: ALL_SCOPES, CORNER_RADIUS, WIDTH_HEIGHT, GAP/);
  assert.match(VARIABLE_SCOPE_GUIDE, /Ask whether it should/);
});

test('variable scope reference is available without an engine round-trip', async () => {
  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_reference', { name: 'variable-scopes' });
  const text = result.content?.[0]?.text || '';
  assert.match(text, /TEXT_CONTENT, FONT_FAMILY, FONT_STYLE/);
  assert.match(text, /BOOLEAN: ALL_SCOPES/);
  assert.match(text, /var","update/);
});

test('capability index is generated on demand without an engine round-trip', async () => {
  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_reference', { name: 'capabilities' });
  const text = result.content?.[0]?.text || '';
  assert.match(text, /^a11y — /m);
  assert.match(text, /^render — /m);
  assert.doesNotMatch(text, /^connect — /m);
  assert.doesNotMatch(text, /^eval — /m);
});

test('specialized Figma tools expose consistent explicit file targeting', async () => {
  const { TOOLS } = await import('../src/server.js');
  for (const name of ['figma_render', 'figma_selection', 'figma_inspect', 'figma_screenshot', 'figma_spec']) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool?.inputSchema?.properties?.fileKey, `${name} must accept fileKey`);
  }
  const status = TOOLS.find((candidate) => candidate.name === 'figma_status');
  assert.ok(status.inputSchema.properties.validateRest, 'REST validation must be explicit/lazy');
  assert.ok(status.inputSchema.properties.probePlugin, 'plugin responsiveness probe must be controllable');
  assert.match(status.description, /round-trip/i);
  const spec = TOOLS.find((candidate) => candidate.name === 'figma_spec');
  assert.deepEqual(spec.inputSchema.properties.format.enum, ['tree', 'yaml', 'json']);
  assert.equal(spec.inputSchema.properties.format.default, 'tree');
  assert.match(spec.inputSchema.properties.format.description, /tree \(default\)/);
  assert.equal(spec.inputSchema.properties.dedup.default, false,
    'MCP design-to-code must inline local styles unless deduplication is requested');
  assert.match(spec.inputSchema.properties.dedup.description, /every layer/i);
  assert.match(spec.description, /never invent/i);
  const screenshot = TOOLS.find((candidate) => candidate.name === 'figma_screenshot');
  assert.match(screenshot.description, /mandatory/i);
});

test('oversized specs are refused as incomplete, never partially or silently truncated', async () => {
  const { budgetSpecOutput } = await import('../src/server.js');
  const original = `SECRET-TAIL-${'x'.repeat(200)}`;
  const guarded = budgetSpecOutput(original, {
    limit: 100, nodeId: '1:2', phase: 'all', depth: 12,
  });
  assert.equal(guarded.complete, false);
  assert.equal(guarded.originalChars, original.length);
  assert.doesNotMatch(guarded.text, /SECRET-TAIL/, 'must not return a misleading partial prefix');
  assert.match(guarded.text, /complete: false/);
  assert.match(guarded.text, /No partial design data was returned/);
  assert.match(guarded.text, /phase.*structure/);
  assert.match(guarded.text, /depth 0/);
  assert.match(guarded.text, /dedup true/);
  assert.equal(budgetSpecOutput('small', { limit: 100 }).text, 'small');
});

test('oversized exact specs retry once with lossless dedup before refusing', async () => {
  const { fitSpecOutput } = await import('../src/server.js');
  const modes = [];
  const fitted = await fitSpecOutput(async (dedup) => {
    modes.push(dedup);
    return { stdout: dedup ? 'shared S1 refs' : 'x'.repeat(200) };
  }, { dedup: false, limit: 100, nodeId: '1:2' });
  assert.deepEqual(modes, [false, true]);
  assert.equal(fitted.automaticDedup, true);
  assert.equal(fitted.budgeted.text, 'shared S1 refs');
  assert.equal(fitted.exactChars, 200);
});

test('asset background jobs include the target file in their identity', async () => {
  const { assetExportJobKey } = await import('../src/server.js');
  const args = ['export', 'assets', '1:2', '-o', '/tmp/assets'];
  assert.notEqual(assetExportJobKey(args, 'FILE_A'), assetExportJobKey(args, 'FILE_B'));
  assert.equal(assetExportJobKey(args, 'FILE_A'), assetExportJobKey([...args], 'FILE_A'));
});

test('file target resolver normalizes explicit URLs and infers Figma URLs in argv', async () => {
  const { resolveFileTarget } = await import('../src/engine.js');
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=12-34';
  assert.equal(resolveFileTarget(url, []), 'PLACEHOLDERFILEKEY');
  assert.equal(resolveFileTarget(undefined, ['export', 'code-spec', url]), 'PLACEHOLDERFILEKEY');
  assert.equal(resolveFileTarget(undefined, ['map', 'storybook', 'http://localhost:6006']), null);
  assert.equal(resolveFileTarget(undefined, ['annotate', 'set', 'text mentions ' + url]), null,
    'a Figma URL embedded in arbitrary content must not retarget the command');
});

test('verify-build passes the figma_run allowlist as a read-only command', async () => {
  const { ALLOWED_COMMANDS } = await import('../src/engine.js');
  const { isWrite } = await import('../src/server.js');
  assert.ok(ALLOWED_COMMANDS.has('verify-build'));
  // Read-only: must never trip the write-confirm gate.
  assert.equal(isWrite(['verify-build', '/some/project']), false);
});

test('verify-build returns its report on exit 1 because findings are an answer', async () => {
  const { runCli } = await import('../src/engine.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  // verify-build exits 1 when a project is missing exported assets, and
  // history diff exits 1 when the design changed — in both cases the code IS
  // the answer. verify-build is used here because it needs no Figma
  // connection, so the test means the same thing on a CI box as it does here.
  const dir = mkdtempSync(join(tmpdir(), 'figma-okexit-'));
  try {
    const res = await runCli(['verify-build', dir]);
    assert.equal(res.code, 1);
    // The output still comes back — that is the whole point of allowing it.
    assert.ok((res.stdout + res.stderr).length > 0, 'output must survive the allowed exit code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('motion is allowlisted, is a real engine command, and is gated as a write', async () => {
  const { ALLOWED_COMMANDS } = await import('../src/engine.js');
  const { isWrite } = await import('../src/server.js');
  assert.ok(ALLOWED_COMMANDS.has('motion'), 'motion must be reachable through figma_run');

  // An allowlist entry the engine does not implement is a dead promise in the
  // tool surface — ask the engine itself rather than trusting the list.
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const help = execFileSync(
    process.execPath,
    [join(repoRoot, 'engine', 'src', 'index.js'), 'motion', '--help'],
    { encoding: 'utf8' },
  );
  assert.match(help, /keyframes, presets, styles, timelines/);
  for (const sub of ['add', 'apply', 'preset', 'stagger', 'styles', 'style', 'timeline', 'inspect', 'clear']) {
    assert.match(help, new RegExp(`\\b${sub}\\b`), `motion ${sub} missing from the engine`);
  }

  // Keyframes mutate the document: everything but the two readbacks is gated.
  assert.equal(isWrite(['motion', 'preset', '1:2', 'fade-in']), true);
  assert.equal(isWrite(['motion', 'inspect', '1:2']), false);
});

test('normalizeOutputArgs: verify-build paths resolve against the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/engine.js');
  const base = resolve('work', 'project');
  const inWorkspace = (...parts) => join(base, ...parts);
  // projectDir positional + every path flag, separated and = forms.
  assert.deepEqual(
    normalizeOutputArgs(['verify-build', '.', '--compare', 'shot.png', '--design=fig.png',
      '--diff-out', 'diff.png', '--node', '12:34', '--max-diff', '5'], base),
    ['verify-build', base, '--compare', inWorkspace('shot.png'),
      `--design=${inWorkspace('fig.png')}`, '--diff-out', inWorkspace('diff.png'),
      '--node', '12:34', '--max-diff', '5'],
  );
  // --node/--max-diff values are NOT paths and must never be absolutized —
  // and the value after them must not be mistaken for the positional.
  const args = normalizeOutputArgs(['verify-build', '--node', '1:2', 'proj'], base);
  assert.deepEqual(args, ['verify-build', '--node', '1:2', inWorkspace('proj')]);
  // absolute inputs pass through untouched
  const absoluteProject = resolve('abs', 'dir');
  const absoluteBuild = resolve('abs', 'b.png');
  assert.deepEqual(
    normalizeOutputArgs(['verify-build', absoluteProject, '--compare', absoluteBuild], base),
    ['verify-build', absoluteProject, '--compare', absoluteBuild],
  );
});
