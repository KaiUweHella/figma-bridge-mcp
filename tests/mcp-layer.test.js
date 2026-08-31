// MCP-layer tests: allowlist enforcement, engine-entry resolution, key pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Isolate the pairing key file so tests never touch the user's real
// ~/.figma-bridge-mcp state. Must be set BEFORE importing config.js/pairing.js.
const testState = mkdtempSync(join(tmpdir(), 'figma-bridge-mcp-layer-'));
process.env.PLUGIN_KEY_FILE = join(testState, 'plugin-key');
process.env.AUDIT_LOG_PATH = join(testState, 'audit.log');
process.env.FIGMA_WRITE_CONFIRM = '1';

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
  assert.deepEqual(eq.args, ['export', 'assets', '1:2', '-o', output]);
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
    ['export', 'node', '1:2', '-o', inWorkspace('shot.png')]);
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

test('figma_run exposes an explicit fresh-capture escape from the retry cache', async () => {
  const { handleTool, unknownParamError, TOOLS } = await import('../src/server.js');
  assert.equal(unknownParamError('figma_run', { args: ['export', 'assets', '1:2'], force: true }), null);
  const run = TOOLS.find((tool) => tool.name === 'figma_run');
  assert.match(run.inputSchema.properties.force.description, /completed retry cache/);
  const rejected = await handleTool('figma_run', { args: ['node', 'tree'], force: true });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /only available for tracked Asset Export/);
});

test('normalizeOutputArgs anchors map storybook output to the client workspace', async () => {
  const { normalizeOutputArgs } = await import('../src/engine.js');
  const base = resolve('work', 'project');
  const inWorkspace = (...parts) => join(base, ...parts);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'http://localhost:6006'], base),
    ['map', 'storybook', '--output', inWorkspace('figma-map.json'), '--', 'http://localhost:6006']);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'u', '-o', 'maps/m.json'], base),
    ['map', 'storybook', '--output', inWorkspace('maps', 'm.json'), '--', inWorkspace('u')]);
  assert.deepEqual(normalizeOutputArgs(['map', 'storybook', 'u', '--output=m.json'], base),
    ['map', 'storybook', '--output', inWorkspace('m.json'), '--', inWorkspace('u')]);
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

test('server entry-point detection resolves the symlink npm uses for installed bins', {
  skip: process.platform === 'win32',
}, async () => {
  const { rmSync, symlinkSync } = await import('node:fs');
  const { isServerEntryPoint } = await import('../src/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'figma-bridge-bin-'));
  const serverUrl = new URL('../src/server.js', import.meta.url);
  const bin = join(dir, 'figma-bridge-mcp');
  try {
    symlinkSync(fileURLToPath(serverUrl), bin);
    assert.equal(isServerEntryPoint(serverUrl.href, bin), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live STDIO server advertises the complete tool surface to MCP clients', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { TOOLS } = await import('../src/server.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    cwd: ROOT,
    env: {
      AUDIT_LOG_PATH: process.env.AUDIT_LOG_PATH,
      PLUGIN_KEY_FILE: process.env.PLUGIN_KEY_FILE,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'figma-bridge-tool-discovery-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const response = await client.listTools();
    assert.deepEqual(
      response.tools.map((tool) => tool.name),
      TOOLS.map((tool) => tool.name),
      'Codex and other MCP clients must discover every checked-in tool through tools/list',
    );
  } finally {
    await client.close();
  }
});

test('figma_run routes every Design Link action through one target-aware Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const designLinkRoute = designLinkPlanRoute(plan)');
  const end = source.indexOf('const designContractRoute = designContractPlanRoute(plan)', start);
  const route = source.slice(start, end);
  assert.match(route, /runInProcessCommandPlan\(plan/);
  assert.match(route, /compatibilityFallback: false/);
  assert.match(route, /if \(plan\.target\.kind !== "none"\)/);
  assert.match(route, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(route, /executeDesignLinkPlan\(plan, adapters\)/);
  assert.match(route, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(route, /executeDesignLink\(|runCliPlan\(/);
});

test('figma_run routes Design Contract capture/check through the shared Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const designContractRoute = designContractPlanRoute(plan)');
  const end = source.indexOf('const createFrameRoute = createFramePlanRoute(plan)', start);
  const route = source.slice(start, end);
  assert.match(route, /runInProcessCommandPlan\(plan/);
  assert.match(route, /compatibilityFallback: false/);
  assert.match(route, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(route, /executeDesignContractPlan\(plan/);
  assert.match(route, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.match(route, /formatDesignContractAdapterResult\(result\)/);
  assert.match(route, /result\.action === "check" && !result\.check\.ok \? 1 : 0/);
  assert.doesNotMatch(route, /runCliPlan\(/, 'Design Contract must not re-enter Commander');
});

test('figma_run routes Node Text through the shared non-retrying Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)');
  const end = source.indexOf('const res = await runCliPlan(plan', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeTextPlan\(plan/);
  assert.match(slice, /formatNodeTextResult\(result\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Text must not re-enter Commander');
});

test('figma_run routes Node Move through the shared verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeMoveRoute = nodeMovePlanRoute(plan)');
  const end = source.indexOf('const nodeBindingsRoute = nodeBindingsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeMovePlan\(plan/);
  assert.match(slice, /formatNodeMoveResult\(result\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Move must not re-enter Commander');
});

test('figma_run routes Node Duplicate through the rollback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeDuplicateRoute = nodeDuplicatePlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeDuplicatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Node Duplicate must not re-enter Commander');
});

test('figma_run routes Create Frame through the rollback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const createFrameRoute = createFramePlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCreateFramePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Create Frame must not re-enter Commander');
});

test('figma_run routes solid Shape creation through the rollback-verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const createShapeRoute = createShapePlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCreateShapePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Create Shape must not re-enter Commander');
});

test('figma_run routes Vector and Slice creation through the verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const createCanvasNodeRoute = createCanvasNodePlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCreateCanvasNodePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Create Canvas Node must not re-enter Commander');
});

test('figma_run routes Line creation through the rollback-verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const createLineRoute = createLinePlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCreateLinePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Create Line must not re-enter Commander');
});

test('figma_run routes Auto Layout creation through the rollback-verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const createAutoLayoutRoute = createAutoLayoutPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCreateAutoLayoutPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Create Auto Layout must not re-enter Commander');
});

test('figma_run routes Text creation through the font-preflighted Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const createTextRoute = createTextPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCreateTextPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Create Text must not re-enter Commander');
});

test('figma_run routes Measurement mutations through the structured Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const measurementMutationRoute = measurementMutationPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeMeasurementMutationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Measurement Mutation must not re-enter Commander');
});

test('figma_run routes Measurement reads through the bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const measurementReadRoute = measurementReadPlanRoute(plan)');
  const end = source.indexOf('const libraryImportRoute = libraryImportPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeMeasurementReadPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Measurement Read must not re-enter Commander');
});

test('figma_run rejects malformed Measurement reads before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_run', { args: ['measure', 'list', '1:2', '3:4'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
});

test('figma_run routes Node Rename through the rollback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeRenameRoute = nodeRenamePlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeRenamePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Rename must not re-enter Commander');
});

test('figma_run routes Node Resize through the rollback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeResizeRoute = nodeResizePlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeResizePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Resize must not re-enter Commander');
});

test('figma_run routes Node Reparent through the hierarchy-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeReparentRoute = nodeReparentPlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeReparentPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Reparent must not re-enter Commander');
});

test('figma_run routes Node Group through the rollback-owned Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeGroupRoute = nodeGroupPlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /executeNodeGroupPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run routes Node Ungroup through the hierarchy-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8'); const start = source.indexOf('const nodeUngroupRoute = nodeUngroupPlanRoute(plan)'); const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start); const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/); assert.match(slice, /compatibilityFallback: false/); assert.match(slice, /executeNodeUngroupPlan\(plan/); assert.doesNotMatch(slice, /runCliPlan\(/);
});
test('figma_run routes Node Boolean through the hierarchy-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeBooleanRoute = nodeBooleanPlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /executeNodeBooleanPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});
test('figma_run routes Node Bind through the readback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeBindRoute = nodeBindPlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /executeNodeBindPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});
test('figma_run routes Node Set through the journaled multi-property Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeSetRoute = nodeSetPlanRoute(plan)');
  const end = source.indexOf('const nodeSetFillRoute = nodeSetFillPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeSetPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});
test('figma_run routes Node Set Fill through the readback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeSetFillRoute = nodeSetFillPlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeSetFillPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});
test('figma_run routes Node Set Image through the prepared readback-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeSetImageRoute = nodeSetImagePlanRoute(plan)');
  const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /prepareNodeSetImagePlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executePreparedNodeSetImage\(prepared/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});
test('figma_run routes Node Flatten through the irreversible verified Command Application', () => { const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8'); const start = source.indexOf('const nodeFlattenRoute = nodeFlattenPlanRoute(plan)'); const end = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)', start); const slice = source.slice(start, end); assert.match(slice, /runInProcessCommandPlan\(plan/); assert.match(slice, /compatibilityFallback: false/); assert.match(slice, /executeNodeFlattenPlan\(plan/); assert.doesNotMatch(slice, /runCliPlan\(/); });

test('figma_run routes Node Delete through the shared hierarchy-verified Command Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeDeleteRoute = nodeDeletePlanRoute(plan)');
  const end = source.indexOf('const nodeBindingsRoute = nodeBindingsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeDeletePlan\(plan/);
  assert.match(slice, /formatNodeDeleteResult\(result\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Delete must not re-enter Commander');
});

test('figma_run routes Node to-component through the irreversible verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeToComponentRoute = nodeToComponentPlanRoute(plan)');
  const end = source.indexOf('const nodeBindingsRoute = nodeBindingsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeToComponentPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Node to-component must not re-enter Commander');
});

test('figma_run routes Node Tree through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeTreeRoute = nodeTreePlanRoute(plan)');
  const end = source.indexOf('const inspectRoute = inspectPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeTreePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node Tree must not re-enter Commander');
});

test('figma_run routes Node Discovery through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeDiscoveryRoute = nodeDiscoveryPlanRoute(plan)');
  const end = source.indexOf('const inspectRoute = inspectPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeDiscoveryPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Node Discovery must not re-enter Commander');
});

test('figma_run routes Prototype Inspection through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const prototypeInspectionRoute = prototypeInspectionPlanRoute(plan)');
  const end = source.indexOf('const inspectRoute = inspectPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executePrototypeInspectionPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Prototype Inspection must not re-enter Commander');
});

test('figma_run routes Prototype mutations through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const prototypeMutationRoute = prototypeMutationPlanRoute(plan)');
  const end = source.indexOf('const tokenPresetRoute = tokenPresetPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executePrototypeMutationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Prototype Mutation must not re-enter Commander');
});

test('figma_run routes Library imports through the irreversible verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const libraryImportRoute = libraryImportPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeLibraryImportPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Library Import must not re-enter Commander');
});

test('figma_run rejects malformed Library imports before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['library', 'import-variable'],
    ['library', 'import-style', 'KEY', 'EXTRA'],
    ['library', 'import-component', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Library reads through the shared bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const libraryReadRoute = libraryReadPlanRoute(plan)');
  const end = source.indexOf('const shaderMutationRoute = shaderMutationPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeLibraryReadPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Library Read must not re-enter Commander');
});

test('figma_run rejects malformed Library reads before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['library', 'collections', 'extra'],
    ['library', 'collections', '--future', 'private-value'],
    ['library', 'variables'],
    ['library', 'variables', 'Brand', '--type', 'NUMBER'],
    ['library', 'variables', 'Brand', '--type', 'COLOR', '--type', 'FLOAT'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Shader writes through the verified mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const shaderMutationRoute = shaderMutationPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeShaderMutationPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Shader Mutation must not re-enter Commander');
});

test('figma_run routes Shader reads through the bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const shaderReadRoute = shaderReadPlanRoute(plan)');
  const end = source.indexOf('const drawCommandRoute = drawCommandPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeShaderReadPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Shader Read must not re-enter Commander');
});

test('figma_run rejects malformed Shader reads before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['shader', 'list', 'extra'],
    ['shader', 'list', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Shader writes before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['shader', 'import'],
    ['shader', 'import', 'SH:1', 'EXTRA'],
    ['shader', 'apply', '1:2', 'SH:1'],
    ['shader', 'apply', '1:2', 'SH:1', '--field', 'unknown'],
    ['shader', 'apply', '1:2', 'SH:1', '--field', 'fill', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Draw reads and writes through the shared verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const drawCommandRoute = drawCommandPlanRoute(plan)');
  const end = source.indexOf('const slotConfigurationRoute = slotConfigurationPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeDrawCommandPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Draw Command must not re-enter Commander');
});

test('figma_run rejects malformed Draw requests before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['draw', 'inspect'],
    ['draw', 'inspect', '1:2', '--future', 'private-value'],
    ['draw', 'text-path', '1:2'],
    ['draw', 'transform-group', '1:2', '--modifiers', '[]'],
    ['draw', 'stroke-profile', '1:2'],
    ['draw', 'pattern', '1:2', '1:3'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Slot create/edit through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slotConfigurationRoute = slotConfigurationPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeSlotConfigurationPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slot Configuration must not re-enter Commander');
});

test('figma_run routes Slot reads through the bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slotReadRoute = slotReadPlanRoute(plan)');
  const end = source.indexOf('const gridInspectRoute = gridInspectPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeSlotReadPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Slot Read must not re-enter Commander');
});

test('figma_run routes Grid Inspect through the bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const gridInspectRoute = gridInspectPlanRoute(plan)');
  const end = source.indexOf('const gridSetRoute = gridSetPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeGridInspectPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Grid Inspect must not re-enter Commander');
});

test('figma_run rejects malformed Grid Inspect before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['layout', 'grid', 'inspect'],
    ['layout', 'grid', 'inspect', '2:1', '3:1'],
    ['layout', 'grid', 'inspect', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Slot reads before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['slot', 'inspect'],
    ['slot', 'inspect', '1:1', '2:1'],
    ['slot', 'validate', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Slot create/edit before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['slot', 'create', '1:1'],
    ['slot', 'create', '1:1', 'Content', '--settings', '{"future":true}'],
    ['slot', 'edit', '1:1', 'Content#1:1'],
    ['slot', 'edit', '1:1', 'Content#1:1', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Slot reset through the irreversible native-confirmed Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slotResetRoute = slotResetPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeSlotResetPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Slot Reset must not re-enter Commander');
});

test('figma_run rejects malformed Slot reset before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['slot', 'reset'], ['slot', 'reset', '2:1', '3:1'],
    ['slot', 'reset', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Grid Auto Flow through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const gridAutoFlowRoute = gridAutoFlowPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeGridAutoFlowPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Grid Auto Flow must not re-enter Commander');
});

test('figma_run routes Grid Set through the journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const gridSetRoute = gridSetPlanRoute(plan)');
  const end = source.indexOf('const gridAutoFlowRoute = gridAutoFlowPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeGridSetPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Grid Set must not re-enter Commander');
});

test('figma_run rejects malformed Grid Set before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['layout', 'grid', 'set', '2:1'],
    ['layout', 'grid', 'set', '2:1', '--rows', '0'],
    ['layout', 'grid', 'set', '2:1', '--rows', '2', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Grid Auto Flow before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['layout', 'grid', 'auto-flow', '2:1'],
    ['layout', 'grid', 'auto-flow', '2:1', '--auto-tracks', 'columns', '--positioning', 'manual'],
    ['layout', 'grid', 'auto-flow', '2:1', '--auto-tracks', 'rows', '--positioning', 'manual', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Grid Place through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const gridPlaceRoute = gridPlacePlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeGridPlacePlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Grid Place must not re-enter Commander');
});

test('figma_run rejects malformed Grid Place before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '0'],
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '-1', '--column', '0'],
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '0', '--column', '0', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Grid Track Reorder through the irreversible Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const gridTrackReorderRoute = gridTrackReorderPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeGridTrackReorderPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Grid Track Reorder must not re-enter Commander');
});

test('figma_run rejects malformed Grid Track Reorder before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['layout', 'grid', 'reorder-rows', '2:1', '--from', '0'],
    ['layout', 'grid', 'reorder-columns', '2:1', '--from', '-1', '--to', '1'],
    ['layout', 'grid', 'reorder-rows', '2:1', '--from', '0', '--to', '1', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('MCP error results retain one validated bounded mutation projection', async () => {
  const { errorResult } = await import('../src/server.js');
  const structuredContent = {
    schemaVersion: 1, status: 'failed', errorKind: 'execution', dispatchState: 'failed',
    mutation: {
      schemaVersion: 1, outcome: 'partial-residue', attempted: 2, restored: 1, residueCount: 1,
    },
  };
  const result = errorResult('Mutation failed', { structuredContent });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, structuredContent);
  const forged = errorResult('Mutation failed', {
    structuredContent: { ...structuredContent, privateNode: '12:34' },
  });
  assert.equal(Object.hasOwn(forged, 'structuredContent'), false);
});

test('figma_run rejects malformed Prototype Inspection before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['prototype', 'inspect'],
    ['prototype', 'inspect', '12:34', '56:78'],
    ['prototype', 'inspect', '--future', 'private-value'],
    ['prototype', 'inspect', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Facts through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableFactsRoute = variableFactsPlanRoute(plan)');
  const end = source.indexOf('const inspectRoute = inspectPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableFactsPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Facts must not re-enter Commander');
});

test('figma_run routes Variable Discovery through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableDiscoveryRoute = variableDiscoveryPlanRoute(plan)');
  const end = source.indexOf('const variableFactsRoute = variableFactsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableDiscoveryPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Discovery must not re-enter Commander');
});

test('figma_run routes Variable Create through its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)');
  const end = source.indexOf('const collectionCreateRoute = collectionCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableCreatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Create must not re-enter Commander');
});

test('figma_run confirms Variable Create and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '-v', '12',
      '--description', 'Spacing', '--hidden', 'false', '--scopes', 'GAP', 'space/md'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'create', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FUTURE', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', 'One', 'Two'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '--scopes', 'ALL_SCOPES,GAP', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'COLOR', '--scopes', 'GAP', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Batch Creation through its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableCreateBatchRoute = variableCreateBatchPlanRoute(plan)');
  const end = source.indexOf('const variableSetValueRoute = variableSetValuePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableCreateBatchPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Batch Creation must not re-enter Commander');
});

test('figma_run confirms Variable Batch Creation and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['var', 'create-batch', '-c', 'Tokens',
      '[{"name":"space/md","type":"FLOAT","value":12,"description":"Spacing","hidden":false,"scopes":["GAP"]}]'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'create-batch', '-c', 'Tokens', '[]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","future":true}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x"},{"name":"x"}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","type":"FLOAT","scopes":["ALL_SCOPES","GAP"]}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","type":"COLOR","scopes":["GAP"]}]'],
    ['var', 'create-batch', '-c', 'Tokens', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Visualization through its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableVisualizationRoute = variableVisualizationPlanRoute(plan)');
  const end = source.indexOf('const variableSetValueRoute = variableSetValuePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableVisualizationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run confirms Variable Visualization and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', { args: ['var', 'visualize', 'Semantic Colors'] });
  assert.equal(preview.isError, undefined); assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'visualize', 'One', 'Two'], ['var', 'visualize', '--mode'],
    ['var', 'visualize', '-mLight', '-mDark'], ['var', 'visualize', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Token Presets through their shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const tokenPresetRoute = tokenPresetPlanRoute(plan)');
  const end = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeTokenPresetPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run confirms Token Presets and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', { args: ['tokens', 'radii', '-cFoundation'] });
  assert.equal(preview.isError, undefined); assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['tokens', 'spacing', 'extra'], ['tokens', 'radii', '--collection'],
    ['tokens', 'spacing', '-cOne', '-cTwo'], ['tokens', 'radii', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Token Add through its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const tokenAddRoute = tokenAddPlanRoute(plan)');
  const end = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeTokenAddPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run confirms Token Add and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['tokens', 'add', '-cFoundation', 'spacing/md', '16'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['tokens', 'add', 'name'], ['tokens', 'add', 'name', 'value', 'extra'],
    ['tokens', 'add', '--collection'], ['tokens', 'add', '-cOne', '-cTwo', 'name', 'value'],
    ['tokens', 'add', '--future', 'private-value', 'name', 'value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Token Import through pre-read and its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('if (tokenImportRoute === "command-application")');
  const end = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /prepareTokenImportPlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.ok(slice.indexOf('prepareTokenImportPlan') < slice.indexOf('runInProcessCommandPlan'));
  assert.ok(slice.indexOf('prepareTokenImportPlan') < slice.indexOf('ensurePluginReadiness'));
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /executeTokenImportPlan\(plan, prepared/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run routes DESIGN.md context without confirmation, readiness, or Commander', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const designMdContextRoute = designMdContextPlanRoute(plan)');
  const end = source.indexOf('const designMdImportRoute = designMdImportPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /executeDesignMdContextPlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.doesNotMatch(slice, /ensurePluginReadiness\(|runCliPlan\(/);

  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_run', {
    args: ['tokens', 'import-design-md', 'engine/tests/fixtures/design-context.md', '--print-context'],
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Design system loaded: Context Fixture/);
  assert.doesNotMatch(result.content[0].text, /Write-confirm mode is on/);
});

test('figma_run routes simple DESIGN.md mutation through preflight and the journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const designMdImportRoute = designMdImportPlanRoute(plan)');
  const end = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /prepareDesignMdImportPlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.ok(slice.indexOf('prepareDesignMdImportPlan')
    < slice.indexOf('ensurePluginReadiness'));
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /executeDesignMdImportPlan\(plan, prepared/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run owns generic Design Source Import in-process with one outer audit', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const designSourceImportRoute = designSourceImportPlanRoute(plan)');
  const end = source.indexOf('if (tokenImportRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /prepareDesignSourceImportPlan\(plan/);
  assert.match(slice, /if \(designSourceImportRequiresFigma\(prepared\)\)/);
  assert.ok(slice.indexOf('prepareDesignSourceImportPlan')
    < slice.indexOf('ensurePluginReadiness'));
  assert.match(slice, /executeDesignSourceImportPlan\(plan, prepared/);
  assert.doesNotMatch(slice, /runCliPlan\(|program\.parseAsync|executeTokenImportPlan/);

  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_run', {
    args: ['import', 'engine/tests/fixtures/code-import/shadcn-globals.css', '--print-context'],
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Design system loaded: css variables/);
  assert.doesNotMatch(result.content[0].text, /Write-confirm mode is on|Plugin/);
});

test('figma_run rejects malformed DESIGN.md context requests before file or Plugin access', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['tokens', 'import-design-md', '--print-context'],
    ['tokens', 'import-design-md', '--print-context', 'one.md', 'two.md'],
    ['tokens', 'import-design-md', '--print-context', '--future', 'private-value', 'one.md'],
    ['tokens', 'import-design-md', '--print-context', '--collection'],
    ['tokens', 'import-design-md', '--print-context', '--force-slash', 'one.md'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run confirms Token Import and rejects malformed input before source or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['tokens', 'import', '-cFoundation', 'package.json'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['tokens', 'import'], ['tokens', 'import', 'one.json', 'two.json'],
    ['tokens', 'import', '--collection=A/B', 'tokens.json'],
    ['tokens', 'import', '--collection'],
    ['tokens', 'import', '--future', 'private-value', 'tokens.json'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Token Overlap through its shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const tokenOverlapRoute = tokenOverlapPlanRoute(plan)');
  const end = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeTokenOverlapPlan\(plan/);
  assert.match(slice, /typedReadFigma\(/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run executes Token Overlap without confirmation and rejects malformed input', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['tokens', 'overlap', 'One'], ['tokens', 'overlap', 'One', 'one'],
    ['tokens', 'overlap', '--limit', 'One', 'Two'],
    ['tokens', 'overlap', '--future', 'private-value', 'One', 'Two'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes CSS/DTCG through one revision-aware Token Export Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const tokenExportRoute = tokenExportPlanRoute(plan)');
  const end = source.indexOf('if (tokenPresetRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeTokenExportPlan\(plan/);
  assert.match(slice, /evaluateFigmaWithMetadata\(/);
  assert.match(slice, /revisionObservation: context\.revisionObservation/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run rejects malformed CSS/DTCG requests before Plugin readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['export', 'css', '1:2', 'private-value'],
    ['export', 'css', '--dialect', '2025'],
    ['export', 'dtcg', '--dialect', 'future'],
    ['export', 'dtcg', '--future', 'private-value'],
    ['export', 'dtcg', 'tokens.json', '1:2', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Token Rebind through its shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const tokenRebindRoute = tokenRebindPlanRoute(plan)');
  const end = source.indexOf('const variableCreateRoute = variableCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeTokenRebindPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run gates Token Rebind apply and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['tokens', 'rebind', 'Theme', '--node', '1:2', '--apply'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['tokens', 'rebind', 'Theme'],
    ['tokens', 'rebind', 'Theme', '--node', '1:2', '--page'],
    ['tokens', 'rebind', 'Theme', '--page', '--apply'],
    ['tokens', 'rebind', '--future', 'private-value', '--node', '1:2', 'Theme'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command|disabled/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Set Value through its shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableSetValueRoute = variableSetValuePlanRoute(plan)');
  const end = source.indexOf('const collectionCreateRoute = collectionCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableSetValuePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Set Value must not re-enter Commander');
});

test('figma_run confirms Variable Set Value and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['var', 'set-value', '-m', 'Mode 1', '-c', 'Tokens', 'space/md', '20'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'set-value', 'space/md', '20'],
    ['var', 'set-value', '-m', 'Mode 1', 'space/md'],
    ['var', 'set-value', '-m', 'Mode 1', '--alias', 'space/lg', 'space/md', '20'],
    ['var', 'set-value', '-m', 'Mode 1', '--future', 'private-value', 'space/md'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Code Syntax through its shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableCodeSyntaxRoute = variableCodeSyntaxPlanRoute(plan)');
  const end = source.indexOf('const collectionCreateRoute = collectionCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableCodeSyntaxPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Code Syntax must not re-enter Commander');
});

test('figma_run confirms Variable Code Syntax and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['var', 'code-syntax', '-c', 'Tokens', 'space/md', 'WEB', 'var(--space-md)'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'code-syntax', 'space/md', 'WEB'],
    ['var', 'code-syntax', '--remove', 'space/md', 'WEB', 'value'],
    ['var', 'code-syntax', 'space/md', 'FUTURE', 'value'],
    ['var', 'code-syntax', '--future', 'private-value', 'space/md', 'WEB'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Update through its shared field-rollback Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableUpdateRoute = variableUpdatePlanRoute(plan)');
  const end = source.indexOf('const collectionCreateRoute = collectionCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableUpdatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Update must not re-enter Commander');
});

test('figma_run confirms Variable Update and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['var', 'update', '-c', 'Tokens', '-d', 'Medium', '--scopes', 'GAP', 'space/md'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'update', 'space/md'],
    ['var', 'update', '-c', 'Tokens', 'space/md'],
    ['var', 'update', '--hidden', 'maybe', 'space/md'],
    ['var', 'update', '--scopes', 'FUTURE', 'space/md'],
    ['var', 'update', '--scopes', 'ALL_SCOPES,GAP', 'space/md'],
    ['var', 'update', '--future', 'private-value', 'space/md'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Metadata Update Batch through one shared rollback Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableUpdateBatchRoute = variableUpdateBatchPlanRoute(plan)');
  const end = source.indexOf('const variableDeleteRoute = variableDeletePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableUpdateBatchPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Metadata Update Batch must not re-enter Commander');
});

test('figma_run confirms one Variable Metadata Update Batch and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const json = JSON.stringify([
    { variable: 'space/md', collection: 'Tokens', description: 'Medium' },
    { variable: 'space/lg', collection: 'Tokens', hidden: true },
  ]);
  const preview = await handleTool('figma_run', {
    args: ['var', 'update-batch', json],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'update-batch', '[]'],
    ['var', 'update-batch', '[{"variable":"x"}]'],
    ['var', 'update-batch', '[{"variable":"x","future":true}]'],
    ['var', 'update-batch', '[{"variable":"x","scopes":["ALL_SCOPES","GAP"]}]'],
    ['var', 'update-batch', '[{"variable":"x","description":"a"},{"variable":"x","description":"b"}]'],
    ['var', 'update-batch', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes and previews one Variable Set Value Batch rollback policy', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableSetValueBatchRoute = variableSetValueBatchPlanRoute(plan)');
  const end = source.indexOf('const variableCodeSyntaxRoute = variableCodeSyntaxPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableSetValueBatchPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Set Value Batch must not re-enter Commander');

  const { handleTool } = await import('../src/server.js');
  const json = JSON.stringify([
    { variable: 'space/md', mode: 'Light', value: 20 },
    { variable: 'space/lg', mode: 'Dark', alias: 'space/md' },
  ]);
  const preview = await handleTool('figma_run', {
    args: ['var', 'set-value-batch', json],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  assert.match(preview.content[0].text, /mutation rollback policy: best-effort-rollback/);
  for (const args of [
    ['var', 'set-value-batch', '[]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light"}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1,"alias":"y"}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1,"future":true}]'],
    ['var', 'set-value-batch', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Deletion through its shared irreversible Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableDeleteRoute = variableDeletePlanRoute(plan)');
  const end = source.indexOf('const collectionCreateRoute = collectionCreatePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /executeVariableDeletePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run confirms Variable Deletion and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['var', 'delete', '--collection', 'Primitives', 'space/md'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['var', 'delete'],
    ['var', 'delete', 'space/md', 'space/md'],
    ['var', 'delete', '--collection', 'Primitives'],
    ['var', 'delete', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Collection Catalog and Facts through shared bounded-read Applications', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const collectionCatalogRoute = collectionCatalogPlanRoute(plan)');
  const end = source.indexOf('if (variableDiscoveryRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /executeCollectionCatalogPlan\(plan/);
  assert.match(slice, /executeCollectionFactsPlan\(plan/);
  assert.equal((slice.match(/runInProcessCommandPlan\(plan/g) || []).length, 2);
  assert.equal((slice.match(/compatibilityFallback:\s*false/g) || []).length, 2);
  assert.equal((slice.match(/await ensurePluginReadiness\(\{ deadline/g) || []).length, 2);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Collection reads must not re-enter Commander');
});

test('figma_run routes Collection Create through its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const collectionCreateRoute = collectionCreatePlanRoute(plan)');
  const end = source.indexOf('if (collectionCatalogRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCollectionCreatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Collection Create must not re-enter Commander');
});

test('figma_run confirms Collection Create and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', { args: ['col', 'create', 'Theme'] });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['col', 'create'], ['col', 'create', 'one', 'two'],
    ['col', 'create', '--allow-duplicate', '--allow-duplicate', 'Theme'],
    ['col', 'create', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Collection Update through its shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const collectionUpdateRoute = collectionUpdatePlanRoute(plan)');
  const end = source.indexOf('const collectionCatalogRoute = collectionCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCollectionUpdatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Collection Update must not re-enter Commander');
});

test('figma_run confirms Collection Update and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['col', 'update', '--hidden', 'false', 'Primitives'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['col', 'update', 'Primitives'],
    ['col', 'update', '--name', 'One', '--name', 'Two', 'Primitives'],
    ['col', 'update', '--hidden', 'maybe', 'Primitives'],
    ['col', 'update', '--future', 'private-value', 'Primitives'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Collection Mode actions through one shared action-specific Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const collectionModeRoute = collectionModePlanRoute(plan)');
  const end = source.indexOf('const collectionCatalogRoute = collectionCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCollectionModePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Collection Mode actions must not re-enter Commander');
});

test('figma_run confirms Collection Mode actions and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['col', 'mode-add', 'Primitives', 'Dark'],
    ['col', 'mode-rename', 'Primitives', 'Dark', 'Night'],
    ['col', 'mode-remove', 'Primitives', 'Night'],
  ]) {
    const preview = await handleTool('figma_run', { args });
    assert.equal(preview.isError, undefined, args.join(' '));
    assert.match(preview.content[0].text, /Write-confirm mode is on/);
  }
  for (const args of [
    ['col', 'mode-add', 'Primitives'],
    ['col', 'mode-add', '--future', 'private-value', 'Dark'],
    ['col', 'mode-rename', 'Primitives', 'Dark'],
    ['col', 'mode-remove', 'Primitives', 'Dark', 'extra'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Collection Delete through its shared irreversible Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const collectionDeleteRoute = collectionDeletePlanRoute(plan)');
  const end = source.indexOf('const collectionCatalogRoute = collectionCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /executeCollectionDeletePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run confirms Collection Delete and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', { args: ['col', 'delete', 'Disposable'] });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['col', 'delete'], ['col', 'delete', 'one', 'two'],
    ['col', 'delete', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown or unsupported/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Collection Extension through its shared journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const collectionExtendRoute = collectionExtendPlanRoute(plan)');
  const end = source.indexOf('const collectionCatalogRoute = collectionCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /executeCollectionExtendPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run confirms Collection Extension and rejects malformed input before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['col', 'extend', 'Primitives', 'Brand'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  for (const args of [
    ['col', 'extend'], ['col', 'extend', 'Primitives'],
    ['col', 'extend', 'Primitives', 'Brand', 'extra'],
    ['col', 'extend', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown or unsupported/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Collection reads before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['col', 'list', '--limit', '0'],
    ['col', 'list', 'private-value'],
    ['col', 'show'],
    ['col', 'show', 'one', 'two'],
    ['col', 'show', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Token Publish Status through its shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const tokenPublishStatusRoute = tokenPublishStatusPlanRoute(plan)');
  const end = source.indexOf('const variableFactsRoute = variableFactsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeTokenPublishStatusPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Token Publish Status must not re-enter Commander');
});

test('figma_run rejects malformed Token Publish Status before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['var', 'publish-status'],
    ['var', 'publish-status', 'one', 'two'],
    ['var', 'publish-status', '--collection'],
    ['col', 'publish-status', '--collection', 'Theme', 'Theme'],
    ['col', 'publish-status', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Variable Discovery before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['var', 'find'],
    ['var', 'find', 'one', 'two'],
    ['var', 'list', 'private-value'],
    ['var', 'list', '--limit', '0'],
    ['var', 'find', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Variable Resolution through the shared target-bound Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const variableResolutionRoute = variableResolutionPlanRoute(plan)');
  const end = source.indexOf('const fontAxisMetadataRoute = fontAxisMetadataPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeVariableResolutionPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Variable Resolution must not re-enter Commander');
});

test('figma_run routes Font Axis Metadata through the bounded readback-verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const fontAxisMetadataRoute = fontAxisMetadataPlanRoute(plan)');
  const end = source.indexOf('const fontInspectionRoute = fontInspectionPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeFontAxisMetadataPlan\(plan/);
  assert.match(slice, /timeoutMs: Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Font Axis Metadata must not re-enter Commander');
});

test('figma_run rejects malformed Font Axis Metadata before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['font', 'axes'],
    ['font', 'axes', '1:1', '2:2'],
    ['font', 'remember-axes', '1:1', 'wght=nope'],
    ['font', 'forget-axes', '1:1', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value|Plugin not connected|figma_connect/);
  }
});

test('figma_run routes Font Inspection through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const fontInspectionRoute = fontInspectionPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeFontInspectionPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Font Inspection must not re-enter Commander');
});

test('figma_run routes Font binding through the shared readback-verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const fontVariableBindingRoute = fontVariableBindingPlanRoute(plan)');
  const end = source.indexOf('const componentMainRoute = componentMainPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeFontVariableBindingPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Font binding must not re-enter Commander or a second approval path');
});

test('figma_run rejects malformed Font binding before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['font','bind','1:2','fontSize'], ['font','unbind','1:2','width'],
    ['font','unbind','--collection','private-value','1:2','fontSize'],
    ['font','bind','--start','1','--start','2','1:2','fontSize','V:1'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Font Inspection before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['font', 'inspect'],
    ['font', 'inspect', 'not-a-node'],
    ['font', 'inspect', '12:34', '56:78'],
    ['font', 'inspect', '12:34', '--start', '-1'],
    ['font', 'inspect', '12:34', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Variable Resolution before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['var', 'resolve'],
    ['var', 'resolve', 'space/md'],
    ['var', 'resolve', 'space/md', 'not-a-node'],
    ['var', 'resolve', 'space/md', '12:34', 'extra'],
    ['var', 'resolve', 'space/md', '12:34', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Variable Facts before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['var', 'show'],
    ['var', 'show', 'space/md', 'other'],
    ['var', 'show', 'space/md', '--collection'],
    ['var', 'show', 'space/md', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Node Discovery before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['find'],
    ['find', 'One', 'Two'],
    ['find', '--future', 'private-value'],
    ['find', '--limit', 'globalThis.privateValue', 'Card'],
    ['find', '--type', 'FRAME;globalThis.privateValue', 'Card'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Canvas Awareness through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const canvasAwarenessRoute = canvasAwarenessPlanRoute(plan)');
  const end = source.indexOf('const inspectRoute = inspectPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCanvasAwarenessPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Canvas Awareness must not re-enter Commander');
});

test('figma_run rejects malformed Canvas Awareness before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['canvas', 'info', 'payload'],
    ['canvas', 'next', '--direction', 'diagonal'],
    ['canvas', 'next', '--gap', 'globalThis.privateValue'],
    ['canvas', 'next', '--gap', '1', '-g2'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run routes Page Navigation through the shared Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const pageNavigationRoute = pageNavigationPlanRoute(plan)');
  const end = source.indexOf('const canvasAwarenessRoute = canvasAwarenessPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executePageNavigationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Page Navigation must not re-enter Commander');
});

test('figma_run rejects malformed Page Navigation before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['canvas', 'pages', '--json', '--json'],
    ['canvas', 'pages', 'payload'],
    ['canvas', 'page'],
    ['canvas', 'page', 'One', 'Two'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run routes Page Structure through the shared non-retrying Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)');
  const end = source.indexOf('const pageNavigationRoute = pageNavigationPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executePageStructurePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Page Structure must not re-enter Commander');
});

test('figma_run rejects malformed Page Structure before confirmation or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['canvas', 'page-create'],
    ['canvas', 'page-create', 'One', 'Two'],
    ['canvas', 'page-divider', '--index', '-1'],
    ['canvas', 'page-divider', '--json', '--json'],
    ['canvas', 'page-divider', 'Not a native divider'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run routes Node Binding Facts through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeBindingsRoute = nodeBindingsPlanRoute(plan)');
  const end = source.indexOf('const nodeCssRoute = nodeCssPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeBindingsPlan\(plan/);
  assert.match(slice, /typedReadFigma\(/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Node Binding Facts must not re-enter Commander');
});

test('figma_run routes Node CSS through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const nodeCssRoute = nodeCssPlanRoute(plan)');
  const end = source.indexOf('const nodeTreeRoute = nodeTreePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeNodeCssPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Node CSS must not re-enter Commander');
});

test('figma_run routes Component Main through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentMainRoute = componentMainPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentMainPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Main must not re-enter Commander');
});

test('figma_run routes Component Combine through the shared verified mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentCombineRoute = componentCombinePlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentCombinePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Combine must not re-enter Commander');
});

test('figma_run routes Component Add Variant through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentAddVariantRoute = componentAddVariantPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentAddVariantPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Add Variant must not re-enter Commander');
});

test('figma_run routes Component Property Set through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentPropertySetRoute = componentPropertySetPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentPropertySetPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Property Set must not re-enter Commander');
});

test('figma_run routes Component Property Add through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentPropertyAddRoute = componentPropertyAddPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentPropertyAddPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Property Add must not re-enter Commander');
});

test('figma_run routes Component Property Delete through the irreversible Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentPropertyDeleteRoute = componentPropertyDeletePlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentPropertyDeletePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Property Delete must not re-enter Commander');
});

test('figma_run routes Component Property List through the bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentPropertyListRoute = componentPropertyListPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentPropertyListPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Property List must not re-enter Commander');
});

test('figma_run routes Component Instantiate through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentInstantiateRoute = componentInstantiatePlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentInstantiatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Instantiate must not re-enter Commander');
});

test('figma_run rejects malformed Component Instantiate before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'instantiate'],
    ['component', 'instantiate', 'bad'],
    ['component', 'instantiate', '2:1', '--index', '-1'],
    ['component', 'instantiate', '2:1', '-x', 'not-a-number'],
    ['component', 'instantiate', '2:1', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run routes Component Create through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentCreateRoute = componentCreatePlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentCreatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Create must not re-enter Commander');
});

test('figma_run routes Component Swap through the one-shot verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentSwapRoute = componentSwapPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentSwapPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Swap must not re-enter Commander');
});

test('figma_run rejects malformed Component Swap before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'swap'],
    ['component', 'swap', '3:1'],
    ['component', 'swap', 'bad', '2:2'],
    ['component', 'swap', '3:1', 'bad'],
    ['component', 'swap', '3:1', '2:2', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run routes Component Detach through the irreversible verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentDetachRoute = componentDetachPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentDetachPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Detach must not re-enter Commander');
});

test('figma_run routes Component Overrides through the one-shot verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentOverridesRoute = componentOverridesPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentOverridesPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Overrides must not re-enter Commander');
});

test('figma_run rejects malformed Component Overrides before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'overrides'],
    ['component', 'overrides', 'bad', 'reset'],
    ['component', 'overrides', '3:1'],
    ['component', 'overrides', '3:1', 'clear'],
    ['component', 'overrides', '3:1', 'remove', 'extra'],
    ['component', 'overrides', '3:1', 'remove', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run rejects malformed Component Detach before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'detach'],
    ['component', 'detach', 'bad'],
    ['component', 'detach', '3:1', 'extra'],
    ['component', 'detach', '3:1', '--name'],
    ['component', 'detach', '3:1', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run rejects malformed Component Create before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'create', 'Card', '-w', '0'],
    ['component', 'create', 'Card', '-h', 'not-a-number'],
    ['component', 'create', 'Card', '--index', '-1'],
    ['component', 'create', 'Card', '--parent', 'bad'],
    ['component', 'create', 'Card', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid|positive/i);
  }
});

test('figma_run routes Component Inventory through the bounded safe-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentInventoryRoute = componentInventoryPlanRoute(plan)');
  const end = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeComponentInventoryPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Component Inventory must not re-enter Commander');
});

test('figma_run rejects malformed Component Inventory before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'list', '--future'],
    ['component', 'list', '--json', '--json'],
    ['component', 'list', 'payload'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run rejects malformed Component Property List before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'prop', 'list', 'bad'],
    ['component', 'prop', 'list', '2:1', '3:1'],
    ['component', 'prop', 'list', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
  }
});

test('figma_run rejects malformed Component Property Delete before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'prop', 'delete', '2:1'],
    ['component', 'prop', 'delete', 'bad', 'private-name'],
    ['component', 'prop', 'delete', '2:1', 'private-name', 'extra'],
    ['component', 'prop', 'delete', '2:1', 'private-name', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
    assert.doesNotMatch(result.content[0].text, /private-name/);
  }
});

test('figma_run rejects malformed Component Property Add before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'prop', 'add', '2:1', 'Label', 'text'],
    ['component', 'prop', 'add', '2:1', 'Label', 'unknown', 'private-value'],
    ['component', 'prop', 'add', '2:1', 'Mode', 'variant', 'Default'],
    ['component', 'prop', 'add', '2:1', 'Label', 'text', 'Value', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|unsupported|invalid/i);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Style Facts through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleFactsRoute = styleFactsPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStyleFactsPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Style Facts must not re-enter Commander');
});

test('figma_run routes Style Catalog through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleCatalogRoute = styleCatalogPlanRoute(plan)');
  const end = source.indexOf('const styleFactsRoute = styleFactsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStyleCatalogPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Style Catalog must not re-enter Commander');
});

test('figma_run routes Style Consumer through its longer bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleConsumerRoute = styleConsumerPlanRoute(plan)');
  const end = source.indexOf('const styleFactsRoute = styleFactsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStyleConsumerPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Style Consumer must not re-enter Commander');
});

test('figma_run routes Style Publish Status through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const stylePublishStatusRoute = stylePublishStatusPlanRoute(plan)');
  const end = source.indexOf('const layoutGridFactsRoute = layoutGridFactsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStylePublishStatusPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Style Publish Status must not re-enter Commander');
});

test('figma_run routes Style Apply through the shared non-retrying mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleApplyRoute = styleApplyPlanRoute(plan)');
  const end = source.indexOf('const layoutGridFactsRoute = layoutGridFactsPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStyleApplyPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Style Apply must not re-enter Commander');
});

test('figma_run routes Style Create through the shared journaled mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleCreateRoute = styleCreatePlanRoute(plan)');
  const end = source.indexOf('if (styleApplyRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStyleCreatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Style Create must not re-enter Commander');
});

test('figma_run routes Style Update through the shared rollback-owned mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleUpdateRoute = styleUpdatePlanRoute(plan)');
  const end = source.indexOf('if (styleApplyRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeStyleUpdatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Style Update must not re-enter Commander');
});

test('figma_run rejects malformed Style Update argv before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'update', 'Columns'],
    ['style', 'update', 'Columns', '--type', 'GRID'],
    ['style', 'update', 'Columns', '--properties', '{"layoutGrids":[]}'],
    ['style', 'update', 'Columns', '--type', 'GRID', '--properties', '{}'],
    ['style', 'update', 'Columns', '--name', 'Next', '--name', 'Again'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Style Delete through the shared compact mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const styleDeleteRoute = styleDeletePlanRoute(plan)');
  const end = source.indexOf('if (styleApplyRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /executeStyleDeletePlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run rejects malformed Style Delete argv before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'delete'], ['style', 'delete', 'A', 'B'],
    ['style', 'delete', 'A', '--type', 'FUTURE'], ['style', 'delete', 'A', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Text Style binding through the shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const textStyleBindingRoute = textStyleVariableBindingPlanRoute(plan)');
  const end = source.indexOf('if (styleApplyRoute === "command-application")', start);
  const slice = source.slice(start, end);
  assert.match(slice, /executeTextStyleVariableBindingPlan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run rejects malformed Text Style binding before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [['style','bind-font','Body','fontSize'], ['style','unbind-font','Body','width'], ['style','unbind-font','Body','fontSize','--variable','V:1']]) {
    const result = await handleTool('figma_run', { args, confirm: true }); assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown or unsupported/);
  }
});

test('figma_run rejects malformed Style Create argv before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'create', 'PAINT'],
    ['style', 'create', 'FUTURE', 'Name'],
    ['style', 'create', 'PAINT', 'Name', '--description'],
    ['style', 'create', 'PAINT', 'Name', '--properties', '[]'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Style Apply argv before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'apply', 'Surface', '10:1'],
    ['style', 'apply', 'Surface', '10:1,10:1', '--field', 'fill'],
    ['style', 'apply', 'Surface', 'bad', '--field', 'fill'],
    ['style', 'apply', 'Surface', '10:1', '--field', 'future'],
  ]) {
    const result = await handleTool('figma_run', { args, confirm: true });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Style Publish Status argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'publish-status'],
    ['style', 'publish-status', 'A', 'B'],
    ['style', 'publish-status', '--future', 'private-value'],
    ['style', 'publish-status', '--type', 'FUTURE', 'Body'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Style Consumer argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'consumers'],
    ['style', 'consumers', 'A', 'B'],
    ['style', 'consumers', '--future', 'private-value'],
    ['style', 'consumers', '--limit', '0', 'Surface'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Style Catalog argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'list', 'private-value'],
    ['style', 'list', '--future', 'private-value'],
    ['style', 'list', '--limit', '0'],
    ['style', 'list', '--cursor', 'not/base64'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Layout Grid Facts through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const layoutGridFactsRoute = layoutGridFactsPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeLayoutGridFactsPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Layout Grid Facts must not re-enter Commander');
});

test('figma_run routes Layout Guide mutations through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const layoutGuideMutationRoute = layoutGuideMutationPlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeLayoutGuideMutationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Layout Guide mutations must not re-enter Commander');
});

test('figma_run routes Analyze census reads through the bounded Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const analysisCensusRoute = analysisCensusPlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnalysisCensusPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Analyze census must not re-enter Commander');
});

test('figma_run routes Slides Inspect through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slidesInspectRoute = slidesInspectPlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSlidesInspectPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slides Inspect must not re-enter Commander');
});

test('figma_run routes Slides Create through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slidesCreateRoute = slidesCreatePlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSlidesCreatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slides Create must not re-enter Commander');
});

test('figma_run routes Slides Duplicate through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slidesDuplicateRoute = slidesDuplicatePlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSlidesDuplicatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slides Duplicate must not re-enter Commander');
});

test('figma_run routes Slides Move through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slidesMoveRoute = slidesMovePlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSlidesMovePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slides Move must not re-enter Commander');
});

test('figma_run routes Slides properties through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slidesPropertyRoute = slidesPropertyPlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSlidesPropertyPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slides properties must not re-enter Commander');
});

test('figma_run routes Slides Delete through the irreversible verified Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const slidesDeleteRoute = slidesDeletePlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSlidesDeletePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Slides Delete must not re-enter Commander');
});

test('figma_run routes Jam Board through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const jamBoardRoute = jamBoardPlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeJamBoardPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Jam Board must not re-enter Commander');
});

test('figma_run routes Jam Arrange through the shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const jamArrangeRoute = jamArrangePlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeJamArrangePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Jam Arrange must not re-enter Commander');
});

test('figma_run routes Jam Sticky through the shared rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const jamStickyRoute = jamStickyPlanRoute(plan)');
  const end = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeJamStickyPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Jam Sticky must not re-enter Commander');
});

test('figma_run routes Dev Resource Read through the shared bounded-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const devResourceReadRoute = devResourceReadPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeDevResourceReadPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Dev Resource Read must not re-enter Commander');
});

test('figma_run routes Dev Resource mutations through the rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const devResourceMutationRoute = devResourceMutationPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeDevResourceMutationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Dev Resource Mutation must not re-enter Commander');
});

test('figma_run routes Section Inventory through the bounded current-page Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const sectionInventoryRoute = sectionInventoryPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSectionInventoryPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Section Inventory must not re-enter Commander');
});

test('figma_run routes Section Fit through the rollback-verified geometry Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const sectionFitRoute = sectionFitPlanRoute(plan)');
  const end = source.indexOf('const annotationCategoryInventoryRoute = annotationCategoryInventoryPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSectionFitPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Section Fit must not re-enter Commander');
});

test('figma_run routes Section Arrange through the rollback-verified geometry Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const sectionArrangeRoute = sectionArrangePlanRoute(plan)');
  const end = source.indexOf('const annotationCategoryInventoryRoute = annotationCategoryInventoryPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSectionArrangePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Section Arrange must not re-enter Commander');
});

test('figma_run routes Section Add through the rollback-verified batch Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const sectionAddRoute = sectionAddPlanRoute(plan)');
  const end = source.indexOf('const annotationCategoryInventoryRoute = annotationCategoryInventoryPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSectionAddPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Section Add must not re-enter Commander');
});

test('figma_run routes Section Create through the rollback-verified creation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const sectionCreateRoute = sectionCreatePlanRoute(plan)');
  const end = source.indexOf('const annotationCategoryInventoryRoute = annotationCategoryInventoryPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeSectionCreatePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Section Create must not re-enter Commander');
});

test('figma_run routes Annotation Category Inventory through the bounded file-read Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const annotationCategoryInventoryRoute = annotationCategoryInventoryPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationCategoryInventoryPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Category Inventory must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Category Inventory before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'categories', 'private'],
    ['annotate', 'categories', '--future'],
    ['annotate', 'categories', '--', 'private'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Annotation Read through the bounded node-or-selection Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const annotationReadRoute = annotationReadPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationReadPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Read must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Read before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'list', '1:2', '1:3'],
    ['annotate', 'list', '--future'],
    ['annotate', 'list', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Annotation Clear through the rollback-verified mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const annotationClearRoute = annotationClearPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationClearPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Clear must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Clear before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'clear'],
    ['annotate', 'clear', '1:2', '1:3'],
    ['annotate', 'clear', '--future'],
    ['annotate', 'clear', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Annotation Remove through the index-exact mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const annotationRemoveRoute = annotationRemovePlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationRemovePlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Remove must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Remove before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'remove'],
    ['annotate', 'remove', '1:2'],
    ['annotate', 'remove', '1:2', '-1'],
    ['annotate', 'remove', '1:2', '0', 'extra'],
    ['annotate', 'remove', 'not-a-node', '0'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Annotation Edit through the patch-exact mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const annotationEditRoute = annotationEditPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationEditPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Edit must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Edit before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'edit', '1:2', '0'],
    ['annotate', 'edit', '1:2', '-1', '--text=x'],
    ['annotate', 'edit', '1:2', '0', '--text=x', '--text=y'],
    ['annotate', 'edit', '1:2', '0', '--properties=future'],
    ['annotate', 'edit', '1:2', '0', '--text=x', 'extra'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Annotation Category writes through one mutation Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf(
    'const annotationCategoryMutationRoute = annotationCategoryMutationPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationCategoryMutationPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Category Mutation must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Category writes before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'category-add', 'Ready'],
    ['annotate', 'category-add', 'Ready', '--color=purple'],
    ['annotate', 'category-edit', 'Review'],
    ['annotate', 'category-edit', 'Review', '--label=x', '--label=y'],
    ['annotate', 'category-remove', 'Review', '--color=blue'],
    ['annotate', 'category-remove', 'Review', 'extra'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run routes Annotation Add through the bounded journaled Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const annotationAddRoute = annotationAddPlanRoute(plan)');
  const end = source.indexOf('const pageStructureRoute = pageStructurePlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{/);
  assert.match(slice, /fileKey, expectedEditor/);
  assert.match(slice, /executeAnnotationAddPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/,
    'Annotation Add must not re-enter Commander');
});

test('figma_run rejects malformed Annotation Add before readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['annotate', 'add', 'Note'],
    ['annotate', 'add', '--node=1:1'],
    ['annotate', 'add', '--node=1:1', '--node=1:2', 'Note'],
    ['annotate', 'add', '--query=Card', '--properties=future', 'Note'],
    ['annotate', 'add', '--query=Card', 'Note', 'extra'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Section Inventory before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['section', 'list', 'private'],
    ['section', 'list', '--future'],
    ['section', 'list', '--', 'private'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Section Fit before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['section', 'fit'],
    ['section', 'fit', '1:1', '1:2'],
    ['section', 'fit', '1:1', '--pad=-1'],
    ['section', 'fit', '1:1', '--pad=1', '--pad=2'],
    ['section', 'fit', '1:1', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Section Arrange before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['section', 'arrange'],
    ['section', 'arrange', '1:1', '1:2'],
    ['section', 'arrange', '1:1', '--cols=0'],
    ['section', 'arrange', '1:1', '--gap=-1'],
    ['section', 'arrange', '1:1', '--group-rows', '--group-rows'],
    ['section', 'arrange', '1:1', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Section Add before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['section', 'add'],
    ['section', 'add', '1:1'],
    ['section', 'add', '1:1', '2:1,'],
    ['section', 'add', '1:1', '2:1,2-1'],
    ['section', 'add', '1:1', '1:1'],
    ['section', 'add', '1:1', '2:1', '3:1'],
    ['section', 'add', '1:1', '2:1', '--future'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Section Create before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['section', 'create'],
    ['section', 'create', ''],
    ['section', 'create', 'Name', '2:1,'],
    ['section', 'create', 'Name', '2:1,2-1'],
    ['section', 'create', 'Name', 'not-a-node'],
    ['section', 'create', 'Name', '2:1', '3:1'],
    ['section', 'create', '--future', 'Name'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Dev Resource mutations before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['dev', 'link', '1:2'],
    ['dev', 'unlink', '--name=forbidden', '1:2', 'https://example.test'],
    ['dev', 'edit', '1:2', 'https://example.test/old'],
    ['dev', 'link', '--future', 'private', '1:2', 'https://example.test'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Dev Resource Read argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['dev', 'list', '1:2', '1:3'],
    ['dev', 'list', '--future', 'private-value'],
    ['dev', 'list', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Layout Grid Facts argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['grid', 'list', '10:3', '10:4'],
    ['grid', 'list', '--future', 'private-value'],
    ['grid', 'list', '--json', '--json'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Layout Guide mutation argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['grid', 'set', '10:3'],
    ['grid', 'set', '10:3', '--columns=0'],
    ['grid', 'set', '10:3', '--columns=1', '--future'],
    ['grid', 'clear', '10:3', '--append'],
    ['grid', 'clear', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Analyze census argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['analyze', 'colors', 'private-value'],
    ['analyze', 'typography', '--future'],
    ['analyze', 'spacing', '--json', '--json'],
    ['analyze', 'clusters', '--', '--json'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Style Facts argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['style', 'show'],
    ['style', 'show', 'A', 'B'],
    ['style', 'show', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
});

test('figma_run rejects malformed Component Main argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'main'],
    ['component', 'main', '10:3', '10:4'],
    ['component', 'main', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|not allowed|invalid/i);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Component Combine argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['component', 'combine', '10:1'],
    ['component', 'combine', '10:1', '10:1'],
    ['component', 'combine', '10:1', '10:2', '--name'],
    ['component', 'combine', '10:1', '10:2', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|not allowed|invalid/i);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Node CSS argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'css'],
    ['node', 'css', '1:2', '3:4'],
    ['node', 'css', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /unknown|not allowed|invalid/i);
  }
});

test('figma_run rejects malformed Node Tree argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'tree', '1:2', '3:4'],
    ['node', 'tree', '--future', 'private-value'],
    ['node', 'tree', '--depth', '65'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Node Binding Facts argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'bindings', '1:2', '3:4'],
    ['node', 'bindings', '--future', 'private-value'],
    ['node', 'bindings', '--json', '--json'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run and figma_history share the Plan-bound History Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const runStart = source.indexOf('const historyRoute = historyPlanRoute(plan)');
  const runEnd = source.indexOf('if (semanticRenderApplication)', runStart);
  const dedicatedStart = source.indexOf('case "figma_history"');
  const dedicatedEnd = source.indexOf('// Entirely MCP-side', dedicatedStart);
  for (const slice of [source.slice(runStart, runEnd), source.slice(dedicatedStart, dedicatedEnd)]) {
    assert.match(slice, /runInProcessCommandPlan\(plan/);
    assert.match(slice, /compatibilityFallback:\s*false/);
    assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
    assert.match(slice, /executeHistoryPlan\(plan/);
    assert.doesNotMatch(slice, /runCli(?:Plan)?\(/,
      'History must not re-enter Commander');
  }
});

test('figma_run rejects malformed History argv before readiness or shared-state access', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['history', 'save'],
    ['history', 'save', 'Release 1', 'private-value'],
    ['history', 'save', 'Release 1', '--description', 'a', '-d', 'b'],
    ['history', 'list', 'extra'],
    ['history', 'snapshot', '--depth', '-1'],
    ['history', 'diff', 'latest', 'live', '--json', '--changelog'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /Plugin not connected|figma_connect/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run and figma_render share simple and compound non-retrying Semantic Render Applications', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const helperStart = source.indexOf('async function runSemanticRenderApplication');
  const helperEnd = source.indexOf('/**\n * Resolve one figma_run Command Plan', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /runInProcessCommandPlan\(plan/);
  assert.match(helper, /compatibilityFallback: false/);
  assert.match(helper, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(helper, /executePreparedSemanticRender\(effectivePrepared/);
  assert.match(helper, /executePreparedCompoundSemanticRender\(effectivePrepared/);
  assert.match(helper, /renderFigmaPlan\(renderPlan/);
  assert.match(helper, /renderFigmaPlans\(renderPlans, options/);
  assert.match(helper, /formatSemanticRenderResult\(outcome\)/);
  assert.match(helper, /semanticRenderOutcomeCode\(outcome\)/);
  assert.match(helper, /structuredContent: outcome/,
    'MCP text and structured content must project the same Application Outcome');
  assert.match(source, /structuredContent: err\?\.semanticRenderOutcome \|\| projectPublicFailure\(err\)/,
    'known failure, Dispatch and rollback facts must survive the MCP error projection');
  assert.doesNotMatch(helper, /runCliPlan\(|runCli\(/);

  assert.match(source, /semanticRenderRoute === "command-application"[\s\S]*?runSemanticRenderApplication\(plan, input\.label, preparedSemanticRender\)/);
  assert.match(source, /semanticRenderRoute === "compound-command-application"[\s\S]*?validateCompoundSemanticRenderPlan\(plan/);
  assert.match(helper, /prepareCompoundSemanticRenderPlan\(plan/);
  const dedicatedStart = source.indexOf('case "figma_render"');
  const dedicatedEnd = source.indexOf('case "figma_selection"', dedicatedStart);
  const dedicated = source.slice(dedicatedStart, dedicatedEnd);
  assert.match(dedicated, /prepareSemanticRenderPlan\(plan/);
  assert.match(dedicated, /semanticRenderToolArgv\(input\)/);
  assert.match(dedicated, /runSemanticRenderApplication\(plan, input\.label, prepared\)/);
  assert.doesNotMatch(dedicated, /runCli\(/, 'simple dedicated Render must not re-enter Commander');
});

test('figma_render exposes complete typed simple and compound requests', async () => {
  const { TOOLS, handleTool } = await import('../src/server.js');
  const schema = TOOLS.find((tool) => tool.name === 'figma_render').inputSchema.properties;
  for (const field of [
    'jsx', 'roots', 'keepWrapper', 'gap', 'direction', 'x', 'y', 'smartPosition',
    'asComponent', 'verify', 'resizeProbe', 'collection', 'materializeResources', 'preset', 'manifest', 'icons',
    'approvedFallbacks', 'approvedFlatRepetitions', 'allowedFreePaths', 'confirm', 'preview', 'label', 'fileKey',
  ]) assert.ok(schema[field], `figma_render schema misses ${field}`);

  const preview = await handleTool('figma_render', {
    jsx: '<Frame name="Typed dedicated render" flex="col"><Text>Hello</Text></Frame>',
    keepWrapper: true,
    collection: 'Brand',
    preset: 'desktop',
    approvedFallbacks: ['font.named-faces'],
    allowedFreePaths: ['root.free'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);

  const compoundPreview = await handleTool('figma_render', {
    roots: ['<Frame name="Card 1"/>', '<Frame name="Card 2"/>'],
    gap: 0,
    direction: 'col',
    x: 10,
    y: 20,
    smartPosition: false,
    asComponent: true,
    verify: true,
    resizeProbe: 120,
  });
  assert.equal(compoundPreview.isError, undefined);
  assert.match(compoundPreview.content[0].text, /Write-confirm mode is on/);

  const malformed = await handleTool('figma_render', {
    jsx: '<Frame />', approvedFallbacks: [false],
  });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /approvedFallbacks/);

  const broadReuseApproval = await handleTool('figma_render', {
    roots: ['<Frame />', '<Frame />'], approvedFlatRepetitions: ['*'],
  });
  assert.equal(broadReuseApproval.isError, true);
  assert.match(broadReuseApproval.content[0].text, /approve-flat-repetition.*exact flat-/);

  const excessive = await handleTool('figma_render', {
    jsx: '<Frame />',
    approvedFallbacks: Array.from({ length: 101 }, (_, index) => `fallback-${index}`),
  });
  assert.equal(excessive.isError, true);
  assert.match(excessive.content[0].text, /at most 100/);

  for (const jsx of ['--help', '--print-browser-capture']) {
    const literal = await handleTool('figma_render', { jsx });
    assert.equal(literal.isError, true);
    assert.match(literal.content[0].text, /Invalid JSX/);
    assert.doesNotMatch(literal.content[0].text, /Usage:|querySelector|getComputedStyle/);
  }

  for (const jsx of [
    '<Frame flex="row"><Frame name="Card 1"><Text>One</Text></Frame><Frame name="Card 2"><Text>Two</Text></Frame></Frame>',
    '<Frame><Image src="https://unapproved.example/photo.png" /></Frame>',
  ]) {
    const compatibility = await handleTool('figma_render', { jsx });
    assert.equal(compatibility.isError, undefined, jsx);
    assert.match(compatibility.content[0].text, /Write-confirm mode is on/);
    assert.doesNotMatch(compatibility.content[0].text, /Invalid JSX|Usage:|getComputedStyle/);
  }

  for (const jsx of ['<Frame/>', '<Frame />', '<Frame></Frame>']) {
    const typed = await handleTool('figma_render', { jsx });
    assert.equal(typed.isError, undefined, `typed ${jsx}`);
    assert.match(typed.content[0].text, /Write-confirm mode is on/);
    const generic = await handleTool('figma_run', { args: ['render', jsx] });
    assert.equal(generic.isError, undefined, `generic ${jsx}`);
    assert.match(generic.content[0].text, /Write-confirm mode is on/);
  }
});

test('explicit Command Preview is payload-free and wins over confirm:true', async () => {
  const {
    TOOLS,
    commandPreviewReason,
    commandPlanPreviewFacts,
    handleTool,
    planFigmaRunCommand,
    writeExecutionPolicyFacts,
    writeExecutionPolicyStatusLines,
  } = await import('../src/server.js');
  for (const toolName of ['figma_run', 'figma_render']) {
    const schema = TOOLS.find((tool) => tool.name === toolName).inputSchema.properties;
    assert.ok(schema.preview, `${toolName} must expose guaranteed preview`);
    assert.match(schema.confirm.description, /omission is not a preview/i);
    assert.match(schema.preview.description, /non-mutating Command Plan/i);
  }

  assert.deepEqual(writeExecutionPolicyFacts(), {
    version: 1,
    confirmation: 'required',
    guaranteedPreview: true,
    previewTools: ['figma_run', 'figma_render'],
  });
  assert.deepEqual(writeExecutionPolicyStatusLines(), [
    'write confirmation: required',
    'guaranteed preview: figma_run/figma_render preview:true (never dispatches or mutates)',
  ]);
  const facts = commandPlanPreviewFacts(planFigmaRunCommand([
    'var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '-v', '12', 'private-variable-name',
  ]));
  assert.equal(facts.guaranteedNonMutating, true);
  assert.equal(facts.dispatched, false);
  assert.equal(facts.capability, 'var.create');
  assert.equal(facts.effects.figma, 'write');
  assert.equal(facts.effects.editor, 'none');
  const navigationFacts = commandPlanPreviewFacts(planFigmaRunCommand([
    'canvas', 'page', 'Components',
  ]));
  assert.equal(navigationFacts.effects.figma, 'read');
  assert.equal(navigationFacts.effects.editor, 'write');
  assert.equal(facts.confirmationPolicy, 'required');
  assert.equal(JSON.stringify(facts).includes('private-variable-name'), false);
  const plan = planFigmaRunCommand(['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', 'name']);
  assert.equal(commandPreviewReason({}, plan), 'write-confirm-policy');
  assert.equal(commandPreviewReason({ confirm: true }, plan), null);
  assert.equal(commandPreviewReason({ preview: true, confirm: true }, plan), 'explicit-preview');

  const preview = await handleTool('figma_render', {
    jsx: '<Frame name="private-preview-payload"><Text>do not echo me</Text></Frame>',
    preview: true,
    confirm: true,
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Guaranteed non-mutating Command Preview/);
  assert.match(preview.content[0].text, /capability: render/);
  assert.match(preview.content[0].text, /dispatched: no/);
  assert.match(preview.content[0].text, /generated resource creation: disabled/);
  assert.doesNotMatch(preview.content[0].text, /private-preview-payload|do not echo me/);

  const materializedPreview = await handleTool('figma_render', {
    jsx: '<Frame name="private-materialized-preview"><Text>still private</Text></Frame>',
    materializeResources: true,
    preview: true,
    confirm: true,
  });
  assert.equal(materializedPreview.isError, undefined);
  assert.match(materializedPreview.content[0].text, /generated resource creation: enabled/);
  assert.doesNotMatch(materializedPreview.content[0].text, /private-materialized-preview|still private/);

  const remotePreview = await handleTool('figma_render', {
    jsx: '<Frame><Image src="https://unapproved.example/private.png?signed-secret=never-fetch" /></Frame>',
    preview: true,
    confirm: true,
  });
  assert.equal(remotePreview.isError, undefined);
  assert.match(remotePreview.content[0].text, /Guaranteed non-mutating Command Preview/);
  assert.doesNotMatch(remotePreview.content[0].text, /unapproved\.example|signed-secret|never-fetch/);
});

test('malformed Render argv and JSX fail before confirmation or Plugin readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const bypass = await handleTool('figma_run', {
    args: ['render', '<Frame name="Safe" />', '--', '--structural-gate'],
  });
  assert.equal(bypass.isError, true);
  assert.match(bypass.content[0].text, /Unknown or unsupported Figma Command/);

  const unclosed = await handleTool('figma_render', { jsx: '<Frame name="Never dispatched">' });
  assert.equal(unclosed.isError, true);
  assert.match(unclosed.content[0].text, /not closed|closing tag|complete root/i);
});

test('figma_run preserves an option-terminated Semantic Render payload through planning', async () => {
  const { handleTool } = await import('../src/server.js');
  const preview = await handleTool('figma_run', {
    args: ['render', '--', '<Frame name="Literal boundary" />'],
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.content[0].text, /Write-confirm mode is on/);
  assert.match(preview.content[0].text, /render/);

  const literalHelp = await handleTool('figma_run', { args: ['render', '--', '--help'] });
  assert.equal(literalHelp.isError, true);
  assert.doesNotMatch(literalHelp.content[0].text, /Unknown or unsupported Figma Command/);
  assert.match(literalHelp.content[0].text, /Invalid JSX/i);
});

test('figma_run keeps Asset Export polling around the shared in-process Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('async function runAssetExport');
  const end = source.indexOf('/**\n * Resolve one figma_run Command Plan', start);
  const slice = source.slice(start, end);
  assert.match(slice, /assetJobs\.attach\(/);
  assert.match(slice, /force && !attached\.started && attached\.job\.done/);
  assert.match(slice, /runInProcessCommandPlan\(/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeAssetExportPlan\(plan/);
  assert.ok(
    slice.indexOf('await ensurePluginReadiness') < slice.indexOf('executeAssetExportPlan(plan'),
    'readiness must complete inside the Plan before Asset Export dispatches',
  );
  assert.match(slice, /formatAssetExportResult\(result\)/);
  assert.doesNotMatch(slice, /runCliPlan\(/, 'Asset Export must not re-enter Commander');
});

test('figma_run and figma_inspect share the Plan-bound Inspect Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const runStart = source.indexOf('case "figma_run"');
  const inspectToolStart = source.indexOf('case "figma_inspect"');
  const inspectRouteStart = source.indexOf('const inspectRoute = inspectPlanRoute(plan)', runStart);
  const runSlice = source.slice(inspectRouteStart, source.indexOf('if (semanticRenderApplication)', inspectRouteStart));
  const toolSlice = source.slice(inspectToolStart, source.indexOf('case "figma_reference"', inspectToolStart));
  for (const slice of [runSlice, toolSlice]) {
    assert.match(slice, /compatibilityFallback:\s*false/);
    assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
    assert.match(slice, /executeInspectPlan\(plan/);
    assert.doesNotMatch(slice, /runCliPlan\(/, 'Inspect must not re-enter Commander');
  }
});

test('figma_run rejects malformed Inspect argv before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['inspect'],
    ['inspect', '1:2', '3:4'],
    ['inspect', '1:2', '--future', 'private-value'],
    ['inspect', '1:2', '--format', 'toml'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_inspect rejects a malformed typed node before readiness or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_inspect', { nodeId: 'not-a-node' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nodeId must be a bounded Figma node id/i);
});

test('figma_run denies an unknown nested command before write confirmation', async () => {
  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_run', { args: ['node', 'future-action', 'private-value'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  assert.doesNotMatch(result.content[0].text, /PREVIEW|private-value/);
});

test('figma_run rejects malformed Legacy policy options before readiness or effects', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['tokens', 'sync', 'private-value', '--ours', '--theirs'],
    ['gradient', 'extract', 'private-value', '--apply-to'],
    ['verify-build', 'private-value', '--future'],
    ['create', 'frame', 'private-value', '--figma-file', 'ONE', '--figma-file', 'TWO'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /PREVIEW|RUNNING|private-value/);
  }
});

test('figma_run rejects malformed Design Link argv before confirmation or dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['link', 'inspect', '--future', 'private-value'],
    ['link', 'inspect', '--manifest'],
    ['link', 'inspect', '1:2', '3:4'],
    ['link', 'set', '1:2'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /PREVIEW|private-value/);
  }
});

test('figma_run rejects malformed Design Contract argv before dispatch', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['contract', 'capture'],
    ['contract', 'check', 'ui.button', '--future', 'private-value'],
    ['contract', 'capture', 'ui.button', '--file'],
    ['contract', 'check', 'ui.button', 'extra'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run rejects malformed Asset Export argv before job scheduling', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['export', 'assets'],
    ['export', 'assets', '1:2', '--future', 'private-value'],
    ['export', 'assets', '1:2', '--max', '3x'],
    ['export', 'assets', '1:2', '--raster-scale', '5'],
    ['export', 'assets', '1:2', '-o', 'a', '--output', 'b'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /RUNNING|private-value/);
  }
});

test('figma_run rejects malformed Node Text argv before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'set-text'],
    ['node', 'set-text', '1:2'],
    ['node', 'set-text', '1:2', '--future', 'private-value'],
    ['node', 'set-text', '1:2', 'Hello', 'private-value'],
    ['node', 'set-text', '1:2', '--'],
    ['node', 'set-text', '1:2', 'x'.repeat(200_001)],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.slice(0, 5).join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /PREVIEW|private-value/);
  }
});

test('figma_run preserves precise Node Move request errors before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  const unknown = await handleTool('figma_run', {
    args: ['node', 'move', '1:2', '--future', '2', '3'],
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Invalid node move command: unknown option --future/);
  assert.doesNotMatch(unknown.content[0].text, /Unknown or unsupported Figma Command/);

  const malformed = await handleTool('figma_run', {
    args: ['node', 'move', '1:2', '-4', 'not-a-number'],
  });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /Invalid node move command: y must be a finite number/);
  assert.doesNotMatch(malformed.content[0].text, /Plugin not connected|figma_connect/);
});

test('figma_run rejects malformed Node Delete before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'delete'],
    ['node', 'delete', '--future', 'private-value'],
    ['node', 'delete', '1:2', '1-2'],
    ['node', 'delete', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /Plugin not connected|figma_connect|PREVIEW|private-value/);
  }
});

test('figma_run rejects malformed Node Duplicate before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'duplicate'],
    ['node', 'duplicate', '--future', 'private-value'],
    ['node', 'duplicate', '1:2', '1-2'],
    ['node', 'duplicate', '1:2', '--index', '-1'],
    ['node', 'duplicate', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /Plugin not connected|figma_connect|PREVIEW|private-value/);
  }
});

test('figma_run rejects malformed Node Rename before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'rename'],
    ['node', 'rename', '1:2'],
    ['node', 'rename', '--future', 'private-value'],
    ['node', 'rename', '1:2', 'After', 'private-value'],
    ['node', 'rename', 'not-a-node', 'After'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text,
      /Plugin not connected|figma_connect|PREVIEW|private-value/);
  }
});

test('figma_run rejects malformed Node Resize before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'resize'], ['node', 'resize', '1:2', '20'],
    ['node', 'resize', '--future', '20', '30'],
    ['node', 'resize', '1:2', '20', '30', 'private-value'],
    ['node', 'resize', 'not-a-node', '20', '30'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text,
      /Plugin not connected|figma_connect|PREVIEW|private-value/);
  }
});

test('figma_run rejects malformed Node to-component before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['node', 'to-component'],
    ['node', 'to-component', '--future', 'private-value'],
    ['node', 'to-component', '1:2', '1-2'],
    ['node', 'to-component', 'not-a-node'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /Plugin not connected|figma_connect|PREVIEW|private-value/);
  }
});

test('figma_run distinguishes command groups, actions, options and malformed values', async () => {
  const { handleTool } = await import('../src/server.js');
  const cases = [
    [['future-group', 'private-payload'], /Unknown command group/],
    [['var', 'future-action', 'private-payload'], /Unknown action for var/],
    [['var', 'list', '--future', 'private-payload'], /Unsupported option --future for var list/],
    [['var', 'list', '--limit', '0'], /Malformed value for var list/],
    [['var', 'list', '--collection', 'private-payload'], /does not support --collection/],
  ];
  for (const [args, pattern] of cases) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, pattern, args.join(' '));
    assert.doesNotMatch(result.content[0].text, /private-payload/, args.join(' '));
  }
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
  assert.match(INSTRUCTIONS, /Never add Tailwind/);
  assert.match(INSTRUCTIONS, /fact ledger/i);
  assert.match(INSTRUCTIONS, /ask the user\s+before changing design semantics/i);
  assert.match(INSTRUCTIONS, /figma_reference \{name:"workflow"\}/);
  assert.match(WORKFLOW_GUIDE, /never border-image/);
  assert.match(WORKFLOW_GUIDE, /verify-build/);
  assert.match(WORKFLOW_GUIDE, /do not install Playwright/i);
  assert.match(WORKFLOW_GUIDE, /Parallel implementation is an OPTIONAL/);
  assert.match(WORKFLOW_GUIDE, /Workers must not repeat global Figma reads/);
  assert.match(WORKFLOW_GUIDE, /Prototype reaction:/);
  assert.match(WORKFLOW_GUIDE, /corner\s+smoothing/);
  assert.match(WORKFLOW_GUIDE, /computed\s+font-family and loaded face/i);
  assert.match(WORKFLOW_GUIDE, /accounted for in the fact ledger/i);
  assert.match(WORKFLOW_GUIDE, /ask the user before changing design semantics/i);
  assert.ok(workflowGuideFor('workflow:design-to-code').length < WORKFLOW_GUIDE.length);
  assert.match(workflowGuideFor('workflow:code-to-figma'), /Code-to-Figma workflow/);
  assert.match(workflowGuideFor('workflow:code-to-figma'), /SCOPE DECISION REQUIRED/);
  assert.match(workflowGuideFor('workflow:code-to-figma'), /prototype","inspect/);
  assert.match(workflowGuideFor('workflow:code-to-figma'), /DOM-capture adapter/i);
  assert.match(VARIABLE_SCOPE_GUIDE, /COLOR: ALL_SCOPES, ALL_FILLS/);
  assert.match(VARIABLE_SCOPE_GUIDE, /FLOAT: ALL_SCOPES, CORNER_RADIUS, WIDTH_HEIGHT, GAP/);
  assert.match(VARIABLE_SCOPE_GUIDE, /Ask whether it should/);
});

test('mixed Figma MCPs stay explicitly scoped to Figma Bridge', async () => {
  const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { INSTRUCTIONS, MCP_SERVER_ID, TOOLS, handleTool } = await import('../src/server.js');

  assert.equal(MCP_SERVER_ID, 'figma-bridge-mcp');
  assert.match(INSTRUCTIONS, /server figma-bridge-mcp/i);
  assert.match(INSTRUCTIONS, /does not prove.*Figma.*unavailable/i);
  assert.match(INSTRUCTIONS, /never.*switch.*write/i);

  const status = TOOLS.find((candidate) => candidate.name === 'figma_status');
  assert.match(status.description, /this Figma Bridge only/i);

  const success = await handleTool('figma_reference', { name: 'variable-scopes' });
  assert.equal(success._mcp, MCP_SERVER_ID);
  assert.deepEqual(success._meta?.[MCP_SERVER_ID], {
    serverId: MCP_SERVER_ID,
    toolNamespace: 'figma-bridge',
    failureScope: 'this-server-only',
  });
  assert.equal(CallToolResultSchema.safeParse(success).success, true);

  const failure = await handleTool('not-a-real-tool', {});
  assert.equal(failure.isError, true);
  assert.equal(failure._mcp, MCP_SERVER_ID);
  assert.match(failure.content[0].text, /^\[figma-bridge-mcp\]/);
  assert.match(failure.content[0].text, /only this Figma Bridge transport/i);
  assert.match(failure.content[0].text, /does not mean Figma or another Figma MCP is unavailable/i);
  assert.equal(CallToolResultSchema.safeParse(failure).success, true);
});

test('MCP prompts bundle both directions and component creation for non-plugin clients', async () => {
  const {
    PROMPTS,
    designToCodePrompt,
    codeToFigmaPrompt,
    createFigmaComponentPrompt,
  } = await import('../src/server.js');
  assert.deepEqual(PROMPTS.map(prompt => prompt.name), [
    'design-to-code',
    'code-to-figma',
    'create-figma-component',
  ]);
  const prompt = designToCodePrompt({ nodeId: '12:34', projectPath: '/work/app' });
  const text = prompt.messages[0].content.text;
  assert.match(text, /12:34/);
  assert.match(text, /\/work\/app/);
  assert.match(text, /workflow:design-to-code/);
  assert.match(text, /Design Entity and Storybook links/);
  assert.match(text, /parallelize only substantial sections/);
  assert.match(text, /Do not install Playwright/);

  const reverse = codeToFigmaPrompt({ sourcePath: '/work/app/src/Page.tsx', target: 'screen.settings' })
    .messages[0].content.text;
  assert.match(reverse, /\/work\/app\/src\/Page\.tsx/);
  assert.match(reverse, /screen\.settings/);
  assert.match(reverse, /semantic DOM-capture/);
  assert.match(reverse, /mutations sequentially/);
  assert.match(reverse, /link accept pixel baseline/);

  const component = createFigmaComponentPrompt({ componentName: 'Button', sourcePath: 'src/Button.tsx' })
    .messages[0].content.text;
  assert.match(component, /Button/);
  assert.match(component, /src\/Button\.tsx/);
  assert.match(component, /INSTANCE_SWAP/);
  assert.match(component, /one variant at a time/);
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

test('round-trip fidelity is exposed without a Figma connection', async () => {
  const { handleTool } = await import('../src/server.js');
  const result = await handleTool('figma_reference', { name: 'fidelity' });
  const text = result.content?.[0]?.text || '';
  assert.match(text, /Round-trip Fidelity Contract v2/);
  assert.match(text, /asset-identity \[assets\]/);
  assert.match(text, /variable-modes \[design-system\]/);
  assert.match(text, /hidden-content-and-alternate-states \[content\]/);
  assert.match(text, /component-state-coverage \[design-system\]/);
  assert.match(text, /native-effects \[effects\]/);
  assert.match(text, /prototype-reactions \[interaction\]/);
  assert.match(text, /verification\.prototype-inspection/);
  assert.match(text, /code -> Figma/);
  assert.match(text, /Figma -> code/);
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

test('MCP responsiveness probing uses the closed health read, never eval or the write lane', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/engine.js', import.meta.url)), 'utf8');
  const start = source.indexOf('export async function probePluginResponsiveness');
  const end = source.indexOf('/** Ask a still-connected plugin main thread', start);
  assert.ok(start > 0 && end > start);
  const probe = source.slice(start, end);
  assert.match(probe, /daemonClient\(\)\.health\(\{/);
  assert.match(probe, /probe:\s*true/);
  assert.doesNotMatch(probe, /\.execute\(|\.evaluate\(|\beval\b/);
});

test('figma_spec batches bounded reads behind one manual approval', async () => {
  const { TOOLS, INSTRUCTIONS, WORKFLOW_GUIDE, executeSpecBatch } = await import('../src/server.js');
  const spec = TOOLS.find((candidate) => candidate.name === 'figma_spec');
  const nodeIds = spec.inputSchema.properties.nodeIds;
  assert.equal(nodeIds.type, 'array');
  assert.ok(nodeIds.maxItems <= 8, 'a batch must stay bounded');
  assert.equal(nodeIds.items.type, 'string');
  assert.match(spec.description, /one approval/i);

  const calls = [];
  const result = await executeSpecBatch([
    { nodeId: '1:2', phase: 'structure', depth: 4 },
    { nodeId: '2:3', phase: 'style', depth: 0 },
    { nodeId: '3:4', phase: 'style', depth: 0 },
    { nodeId: '4:5', phase: 'style', depth: 0 },
  ], async (request) => {
    calls.push(request);
    return { content: [{ type: 'text', text: `spec:${request.nodeId}` }] };
  });
  assert.equal(calls.length, 4, 'one MCP call may contain four internal bounded reads');
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /spec:1:2/);
  assert.match(result.content[0].text, /spec:4:5/);

  assert.match(INSTRUCTIONS, /one figma_spec call/i);
  assert.match(INSTRUCTIONS, /nodeIds/i);
  assert.match(WORKFLOW_GUIDE, /one manual approval/i);
});

test('figma_spec routes every bounded read through the Plan-bound Code Spec Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('case "figma_spec"');
  const slice = source.slice(start, source.indexOf('default:', start));
  assert.match(slice, /codeSpecPlanningArgvFromRequest\(/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCodeSpecPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(|executeCodeSpec\(\{/);
});

test('figma_run routes Code Spec in-process without Commander re-entry', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const codeSpecRoute = codeSpecPlanRoute(plan)');
  const slice = source.slice(start, source.indexOf('if (semanticRenderApplication)', start));
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback:\s*false/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeCodeSpecPlan\(plan/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run rejects malformed Code Spec argv before readiness or capture', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['export', 'code-spec', 'bad-node'],
    ['export', 'code-spec', '1:2', '2:3'],
    ['export', 'code-spec', '1:2', '--future', 'private-value'],
    ['export', 'code-spec', '1:2', '--depth', '3x'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});

test('figma_run routes Component Spec through repository-first conditional execution', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const componentSpecRoute = componentSpecPlanRoute(plan)');
  const end = source.indexOf('const screenshotRoute = screenshotPlanRoute(plan)', start);
  const route = source.slice(start, end);
  assert.match(route, /prepareComponentSpecPlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.match(route, /runInProcessCommandPlan\(plan/);
  assert.match(route, /compatibilityFallback: false/);
  assert.match(route, /if \(plan\.target\.kind !== "none"\)/);
  assert.match(route, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(route, /executeComponentSpecPlan\(plan, prepared/);
  assert.match(route, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(route, /runCliPlan\(/, 'Component Spec must not re-enter Commander');
});

test('figma_run rejects malformed Component Spec before workspace or Plugin access', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['spec'],
    ['spec', 'Button', 'Card'],
    ['spec', 'Button', '--check', 'bad-node'],
    ['spec', 'Button', '--tolerance', '2px'],
    ['spec', 'Button', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /PREVIEW|RUNNING|private-value/);
  }
});

test('figma_run routes Storybook Map through source-first in-process execution', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const storybookMapRoute = storybookMapPlanRoute(plan)');
  const end = source.indexOf('const screenshotRoute = screenshotPlanRoute(plan)', start);
  const route = source.slice(start, end);
  assert.match(route, /prepareStorybookMapPlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.ok(route.indexOf('prepareStorybookMapPlan') < route.indexOf('ensurePluginReadiness'));
  assert.match(route, /runInProcessCommandPlan\(plan/);
  assert.match(route, /compatibilityFallback: false/);
  assert.match(route, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(route, /executeStorybookMapPlan\(plan, prepared/);
  assert.match(route, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.match(route, /enrichFigmaMap\(normalized, plan\.target\.fileKey\)/,
    'the opt-in REST metadata enrichment remains after publication');
  assert.doesNotMatch(route, /runCliPlan\(/, 'Storybook Map must not re-enter Commander');
});

test('figma_run rejects malformed Storybook Map argv before workspace, network, or Plugin access', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['map', 'storybook'],
    ['map', 'storybook', 'one', 'two'],
    ['map', 'storybook', 'source', '--output'],
    ['map', 'storybook', 'source', '--json', '--json'],
    ['map', 'storybook', 'source', '--future', 'private-value'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /PREVIEW|RUNNING|private-value/);
  }
});

test('figma_screenshot, figma_run and PNG export aliases share the Plan-bound Screenshot Application', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const dedicatedStart = source.indexOf('case "figma_screenshot"');
  const dedicated = source.slice(dedicatedStart, source.indexOf('case "figma_spec"', dedicatedStart));
  assert.match(dedicated, /screenshotPlanningArgvFromRequest\(/);
  assert.match(dedicated, /compatibilityFallback:\s*false/);
  assert.match(dedicated, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(dedicated, /executeScreenshotPlan\(plan/);
  assert.doesNotMatch(dedicated, /tmpdir\(|writeFileSync\(|executeScreenshot\(/);

  const genericStart = source.indexOf('const screenshotRoute = screenshotPlanRoute(plan)');
  const generic = source.slice(genericStart, source.indexOf('if (semanticRenderApplication)', genericStart));
  assert.match(generic, /runInProcessCommandPlan\(plan/);
  assert.match(generic, /compatibilityFallback:\s*false/);
  assert.match(generic, /executeScreenshotPlan\(plan/);
  assert.doesNotMatch(generic, /runCliPlan\(/);

  const { screenshotPlanRoute } = await import('../engine/src/application/screenshot-command.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  for (const args of [
    ['export', 'node', '1:2'],
    ['export', 'screenshot'],
  ]) {
    assert.equal(screenshotPlanRoute(planFigmaCommand(args)), 'command-application');
  }
  assert.equal(screenshotPlanRoute(planFigmaCommand([
    'export', 'node', '1:2', '--format', 'svg',
  ])), 'not-screenshot');
});

test('malformed Screenshot requests stop before readiness or persistence', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['verify', 'bad-node'],
    ['verify', '1:2', '2:3'],
    ['verify', '1:2', '--scale', '0'],
    ['verify', '1:2', '--save', 'shot.png', '--base64'],
    ['export', 'node', 'bad-node'],
    ['export', 'screenshot', '1:2'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
  }
  const dedicated = await handleTool('figma_screenshot', { nodeId: 'bad-node' });
  assert.equal(dedicated.isError, true);
  assert.match(dedicated.content[0].text, /Invalid verify command/);
});

test('figma_spec batch fails closed without partial or unbounded output', async () => {
  const { executeSpecBatch } = await import('../src/server.js');
  let calls = 0;
  const tooMany = await executeSpecBatch(
    Array.from({ length: 9 }, (_, index) => ({ nodeId: `${index + 1}:1` })),
    async () => { calls++; return { content: [] }; },
  );
  assert.equal(tooMany.isError, true);
  assert.equal(calls, 0, 'an invalid batch must fail before contacting Figma');

  const failed = await executeSpecBatch([
    { nodeId: '1:2', phase: 'style', depth: 0 },
    { nodeId: '2:3', phase: 'style', depth: 0 },
    { nodeId: '3:4', phase: 'style', depth: 0 },
  ], async (request, index) => {
    calls++;
    return index === 1
      ? { isError: true, content: [{ type: 'text', text: 'second failed' }] }
      : { content: [{ type: 'text', text: `private-result:${request.nodeId}` }] };
  });
  assert.equal(failed.isError, true);
  assert.equal(calls, 2, 'batch must stop at the first failed bounded read');
  assert.match(failed.content[0].text, /second failed/);
  assert.doesNotMatch(failed.content[0].text, /private-result/, 'earlier partial specs must not leak as a complete batch');

  const oversized = await executeSpecBatch(
    [{ nodeId: '1:2' }, { nodeId: '2:3' }],
    async () => ({ content: [{ type: 'text', text: 'x'.repeat(80) }] }),
    { limit: 100 },
  );
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /complete: false/);
  assert.doesNotMatch(oversized.content[0].text, /x{20}/, 'an oversized combined result must not be truncated into partial design data');
});

test('every MCP tool declares conservative safety annotations', async () => {
  const { TOOLS } = await import('../src/server.js');
  for (const tool of TOOLS) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} needs ${hint}`);
    }
  }

  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.annotations]));
  assert.equal(byName.figma_pairing.destructiveHint, true,
    'credential rotation invalidates the previous pairing');
  assert.equal(byName.figma_run.destructiveHint, true,
    'the generic capability surface must advertise its most dangerous allowed behavior');
  assert.equal(byName.figma_comments.openWorldHint, true,
    'comments can become visible to Figma collaborators');
  for (const name of ['figma_connect', 'figma_status', 'figma_run', 'figma_render', 'figma_selection',
    'figma_history', 'figma_comments', 'figma_inspect', 'figma_screenshot', 'figma_spec']) {
    assert.equal(byName[name].openWorldHint, true, `${name} crosses the Figma trust boundary`);
  }
  for (const name of ['figma_pairing', 'figma_reference']) {
    assert.equal(byName[name].openWorldHint, false, `${name} stays in a closed local domain`);
  }
  for (const name of ['figma_selection', 'figma_inspect', 'figma_reference', 'figma_screenshot', 'figma_spec']) {
    assert.equal(byName[name].readOnlyHint, true, `${name} stays read-only`);
    assert.equal(byName[name].destructiveHint, false, `${name} stays non-destructive`);
  }
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
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const args = ['export', 'assets', '1:2', '-o', '/tmp/assets'];
  assert.notEqual(assetExportJobKey(args, 'FILE_A'), assetExportJobKey(args, 'FILE_B'));
  assert.equal(assetExportJobKey(args, 'FILE_A'), assetExportJobKey([...args], 'FILE_A'));
  const plan = planFigmaCommand(args, { fileKey: 'FILE_A' });
  assert.equal(JSON.parse(plan.execution.jobKey).fileKey, plan.target.fileKey);

  const url = 'https://www.figma.com/design/FILEA/Asset-Lab?node-id=1-2';
  assert.equal(
    assetExportJobKey(['export', 'assets', '1-2', '-o', '/tmp/assets'], 'FILEA'),
    assetExportJobKey(['export', 'assets', url, '-o', '/tmp/assets'], null),
    'equivalent node spellings and URL-derived targeting share one job identity',
  );
});

test('figma_run creates one registry-targeted plan for Link and Contract execution', async () => {
  const { planFigmaRunCommand } = await import('../src/server.js');
  const { createWorkspaceIO } = await import('../engine/src/lib/workspace-io.js');
  const dir = mkdtempSync(join(tmpdir(), 'figma-run-target-plan-'));
  const manifest = join(dir, 'figma-bridge.json');
  const contractFile = join(dir, 'contract.json');
  writeFileSync(manifest, JSON.stringify({
    version: 1,
    entities: [{
      id: 'screen.settings',
      kind: 'screen',
      figma: { fileKey: 'REGISTRYPLACEHOLDERKEY', nodeId: '1:2' },
    }],
  }));
  writeFileSync(contractFile, '{}');
  const workspaceIO = createWorkspaceIO({ root: dir });

  const link = planFigmaRunCommand(
    ['link', 'context', 'screen.settings', '--manifest', manifest],
    { workspaceDir: dir, workspaceIO },
  );
  const contract = planFigmaRunCommand(
    ['contract', 'check', 'screen.settings', '--manifest', manifest, '--file', contractFile],
    { workspaceDir: dir, workspaceIO },
  );
  for (const plan of [link, contract]) {
    assert.equal(plan.target.fileKey, 'REGISTRYPLACEHOLDERKEY');
    assert.equal(plan.target.source, 'design-link-registry');
  }
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
  const dir = mkdtempSync(join(process.cwd(), '.figma-okexit-'));
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
      '--diff-out', 'diff.png', '--fidelity-ledger', 'facts.json',
      '--browser-capture=capture.json', '--node', '12:34', '--max-diff', '5'], base),
    ['verify-build', base, '--compare', inWorkspace('shot.png'),
      `--design=${inWorkspace('fig.png')}`, '--diff-out', inWorkspace('diff.png'),
      '--fidelity-ledger', inWorkspace('facts.json'),
      `--browser-capture=${inWorkspace('capture.json')}`,
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

test('figma_run routes Pin through the same target-aware rollback-owned Application', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  const start = source.indexOf('const pinRoute = pinPlanRoute(plan)');
  const end = source.indexOf('const nodeTextRoute = nodeTextPlanRoute(plan)', start);
  const slice = source.slice(start, end);
  assert.match(slice, /runInProcessCommandPlan\(plan/);
  assert.match(slice, /compatibilityFallback: false/);
  assert.match(slice, /ensurePluginReadiness\(\{ deadline, maxWaitMs: 8000, fileKey, expectedEditor \}\)/);
  assert.match(slice, /executePinPlan\(plan/);
  assert.match(slice, /evaluateFigma\(code, \{[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.doesNotMatch(slice, /runCliPlan\(/);
});

test('figma_run rejects malformed Pin requests before confirmation or readiness', async () => {
  const { handleTool } = await import('../src/server.js');
  for (const args of [
    ['pin', 'future-edge'],
    ['pin', '--node', '3:1', '--query', 'private-value', 'left'],
    ['pin', '--offset', 'globalThis.privateValue', 'left'],
    ['pin', '--query', 'Frame', 'left'],
  ]) {
    const result = await handleTool('figma_run', { args });
    assert.equal(result.isError, true, args.join(' '));
    assert.match(result.content[0].text, /Unknown or unsupported Figma Command/);
    assert.doesNotMatch(result.content[0].text, /private-value/);
  }
});
