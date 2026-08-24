// Conventions the command layer must keep, enforced by reading the sources.
// These are the regressions the engine review found: silent failures, a
// connection guard that was never awaited, success text on stderr, and
// library code stranded inside command files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectWrapperSplit } from '../src/lib/jsx-split.js';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');
const LIB_DIR = join(COMMANDS_DIR, '..', 'lib');
const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.js'));
const sources = new Map(files.map((f) => [f, readFileSync(join(COMMANDS_DIR, f), 'utf8')]));
const cliCoreSource = readFileSync(join(LIB_DIR, 'cli-core.js'), 'utf8');

test('every checkConnection() call is awaited', () => {
  // It is async (it can respawn an idle-shut-down daemon). Un-awaited, the
  // guard is a no-op and the command races the daemon.
  const offenders = [];
  for (const [file, src] of sources) {
    src.split('\n').forEach((line, i) => {
      if (/(?<!await\s)\bcheckConnection\(\)/.test(line) && !line.trim().startsWith('//')) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('no command uses the removed figmaUse transport', () => {
  const offenders = [];
  for (const [file, src] of sources) {
    if (/\bfigmaUse\s*\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('success text goes to stdout via spinnerSucceed, never spinner.succeed', () => {
  // ora persists to stderr; the MCP layer folds stderr into its reply under a
  // "[warnings]" header, so a success summary reached the agent as a warning.
  const offenders = [];
  for (const [file, src] of sources) {
    if (/\.succeed\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('a11y checks fail loudly (no console.log for execution errors)', () => {
  const src = sources.get('a11y.js');
  assert.ok(src, 'a11y.js exists');
  // Every catch reports via handleEvalError (which exits 1); result.error
  // paths exit 1 explicitly. Neither may swallow into a zero exit.
  assert.ok(!/console\.log\(chalk\.red\('✗ .*failed/.test(src),
    'failed checks must not be logged-and-forgotten on stdout');
  assert.equal((src.match(/handleEvalError\(e\)/g) || []).length, 6,
    'all six a11y subcommands route errors through handleEvalError');
  assert.equal((src.match(/options\.failOnIssues/g) || []).length, 4,
    'the four violation-reporting checks offer --fail-on-issues for CI');
});

test('eval uses the one Daemon Client path and lets execution errors reject', () => {
  const src = sources.get('export-eval.js');
  assert.ok(src, 'export-eval.js exists');
  const start = src.indexOf(".command('eval [code]')");
  const end = src.indexOf('// Run command - alias for eval', start);
  const evalCommand = src.slice(start, end);

  assert.match(evalCommand, /await daemonExec\('eval', \{ code: jsCode \}\)/,
    'eval must use the shared Daemon Client Implementation');
  assert.doesNotMatch(evalCommand, /catch\s*\(|figmaEvalSync|sync path|ECONNREFUSED|fetch failed/,
    'eval must not classify transport errors or select another path itself');
});

test('supported Figma Commands never implement or spawn a daemon transport', () => {
  for (const [file, src] of sources) {
    assert.doesNotMatch(src, /\bdaemonCurl\b|\bfigmaEvalSync\b|\bsignRequest\b|\bfetch\(/,
      `${file} must cross the Daemon Client seam`);
  }
  assert.doesNotMatch(cliCoreSource, /\bdaemonCurl\b|\bfigmaEvalSync\b|\bsignRequest\b|\bfetch\(|execFileSync\s*\(\s*['"]curl['"]/,
    'CLI lifecycle and execution must not depend on a platform curl binary or duplicate signing');
  const daemonClientSource = readFileSync(join(LIB_DIR, 'daemon-client.js'), 'utf8');
  assert.match(daemonClientSource, /signRequest\(/,
    'request signing belongs to the Daemon Client Implementation');
  for (const operation of ['health', 'reconnect', 'shutdown', 'execute']) {
    assert.match(daemonClientSource, new RegExp(`\\b${operation}\\b`),
      `Daemon Client must expose ${operation}`);
  }
});

test('history delegates private structural persistence to the Snapshot Store', () => {
  const src = sources.get('history.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'history-command.js'), 'utf8');
  assert.ok(src, 'history.js exists');
  assert.match(src, /executeHistoryPlan\(/);
  assert.doesNotMatch(src, /snapshotStore\./,
    'Commander must not own Structural Snapshot Store operations');
  for (const operation of ['save', 'list', 'resolve', 'read']) {
    assert.match(application, new RegExp(`store\\.${operation}\\(`),
      `History Application must use Snapshot Store ${operation}`);
  }
  assert.doesNotMatch(application, /store\.directory\(/,
    'History results must not expose the private Snapshot Store directory');
  assert.doesNotMatch(src, /node:fs|node:zlib|readFileSync|writeFileSync|gunzipSync|gzipSync/,
    'the Command Adapter must not regain direct shared-state persistence');
});

test('asset export Adapter delegates one Command Application to Manifest v2', () => {
  const adapter = sources.get('export-eval.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'asset-export-command.js'), 'utf8');
  assert.ok(adapter, 'export-eval.js exists');
  assert.match(adapter, /runInProcessCommandPlan\(/);
  assert.match(adapter, /executeAssetExportPlan\(/);
  const implementationStart = adapter.indexOf('async function runAssetExportCommand');
  const actionEnd = adapter.indexOf(".command('dtcg", implementationStart);
  const assetAdapter = adapter.slice(implementationStart, actionEnd);
  assert.doesNotMatch(assetAdapter, /checkConnection\(/,
    'Asset Export connection recovery must stay inside its audited Command Plan');
  assert.match(assetAdapter, /await ensurePluginReadiness\(\{ deadline/,
    'Asset Export must use the shared bounded readiness Adapter');
  assert.match(adapter, /daemonExecWithMetadata\(/,
    'every Asset Export roundtrip must carry daemon-owned revision metadata');
  assert.doesNotMatch(adapter, /planAssetExport\(|publishAssetExportPlan\(/,
    'Commander must not own Asset Export domain logic');
  assert.match(application, /planAssetExport\(/,
    'asset export must resolve cross-run identity and filename collisions centrally');
  assert.match(application, /publishAssetExportPlan\(/,
    'asset export must use staged publication with the manifest written last');
  assert.doesNotMatch(application, /const usedNames\s*=|const byContent\s*=/,
    'run-local filename ordinals and dedup maps must not return');
});

test('node set-text delegates one non-retrying Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'node-text-command.js'), 'utf8');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('set-text <nodeId> <text>')");
  const end = adapter.indexOf(".command('set-fill <nodeId> <color>')", start);
  const action = adapter.slice(start, end);
  const helperStart = adapter.indexOf('async function runNodeTextCommand');
  const helper = adapter.slice(helperStart, start);

  assert.match(action, /\.allowExcessArguments\(false\)/,
    'Commander must reject ignored positional values before readiness');
  assert.match(action, /runNodeTextCommand\(\{ nodeId, text \}\)/);
  assert.match(action, /process\.exitCode = 1/,
    'the CLI Adapter must expose Application failure as a nonzero process outcome');
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|loadFontAsync|getRangeAllFontNames|node\.characters\s*=/,
    'Commander must not retain Node Text execution logic');
  assert.match(helper, /planFigmaCommand\(nodeTextPlanningArgvFromRequest\(request\)/);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(helper, /executeNodeTextPlan\(plan/);
  assert.match(helper, /daemonExec\('eval'/);
  assert.match(application, /await Promise\.all\(fonts\.map/,
    'every unique font preflight must settle before the write');
  assert.ok(
    application.indexOf('await Promise.all(fonts.map') < application.indexOf('node.characters ='),
    'font preflight must precede the only mutation',
  );
});

test('node tree delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('tree [nodeId]')");
  const end = adapter.indexOf(".command('bindings [nodeId]')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(nodeTreePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeTreePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|getNodeByIdAsync|printNode\(/,
    'Commander must not retain Node Tree readiness, traversal, or execution logic');
});

test('top-level inspect delegates one Plan-bound safe-read Command Application', () => {
  const adapter = sources.get('canvas-ops.js');
  assert.ok(adapter, 'canvas-ops.js exists');
  const start = adapter.indexOf(".command('inspect <nodeId>')");
  const end = adapter.indexOf('// ============ FIND ============', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/,
    'Commander must reject excess Inspect positionals before readiness');
  assert.match(action, /planFigmaCommand\(inspectPlanningArgvFromRequest\(\{ nodeId, format \}\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeInspectPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.doesNotMatch(action, /checkConnection\(|executeInspect\(\{/,
    'Commander must not retain Inspect readiness or execution logic');
});

test('code-spec delegates one Plan-bound safe-read Command Application', () => {
  const adapter = sources.get('export-eval.js');
  assert.ok(adapter, 'export-eval.js exists');
  const start = adapter.indexOf(".command('code-spec [nodeId]')");
  const end = adapter.indexOf('// ============ VERIFY', start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(codeSpecPlanningArgvFromRequest\(request\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeCodeSpecPlan\(plan/);
  assert.doesNotMatch(action, /checkConnection\(|safeReadEval|executeCodeSpec\(\{/,
    'Commander must not retain Code Spec readiness or execution logic');
});

test('verify delegates capture and persistence to one Plan-bound Screenshot Application', () => {
  const adapter = sources.get('export-eval.js');
  assert.ok(adapter, 'export-eval.js exists');
  const start = adapter.indexOf(".command('verify [nodeId]')");
  const end = adapter.indexOf('// ============ EVAL', start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(screenshotPlanningArgvFromRequest\(request\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeScreenshotPlan\(plan/);
  assert.doesNotMatch(action, /checkConnection\(|safeReadEval|writeFileSync|defaultSavePath/,
    'Commander must not retain Screenshot readiness or persistence policy');
});

test('simple render delegates one non-retrying Semantic Render Application', () => {
  const adapter = sources.get('render.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'semantic-render-command.js'), 'utf8');
  assert.ok(adapter, 'render.js exists');
  const commandStart = adapter.indexOf(".command('render [jsx]')");
  const commandEnd = adapter.indexOf(".command('render-batch')", commandStart);
  const action = adapter.slice(commandStart, commandEnd);
  const helperStart = adapter.indexOf('async function runSimpleSemanticRender');
  const helper = adapter.slice(helperStart, commandStart);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /const originalArgv = rawRenderArgv\(\)/);
  assert.match(action, /semanticRenderArgvRoute\(originalArgv\)/);
  assert.match(action, /runSimpleSemanticRender\(simpleArgv\)/);
  assert.match(action, /process\.exitCode = 1/);
  assert.match(helper, /planFigmaCommand\(argv/);
  assert.match(helper, /prepareSemanticRenderPlan\(plan/);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(helper, /executePreparedSemanticRender\(prepared/);
  assert.match(helper, /daemonExec\('render-plan'/);
  assert.match(application, /permitsCompatibilityRedispatch/);
});

test('render rejects duplicate and malformed raw options before compatibility can run', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  const cases = [
    ['render', '<Frame name="NoWrite" />', '--collection', 'A', '--collection', 'B', '--structural-gate'],
    ['render', '<Frame name="NoWrite" />', '--preset', 'desktop', '--preset', 'iphone-se', '--structural-gate'],
    ['render', '<Frame name="NoWrite" />', '--structural-gate', '--resize-probe=bogus'],
  ];
  for (const argv of cases) {
    const result = spawnSync(process.execPath, [entry, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 1, argv.join(' '));
    assert.match(`${result.stdout}\n${result.stderr}`, /Invalid render command/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Plugin not connected|figma_connect|structural audit: PASS/,
      'raw request rejection must happen before either compatibility Adapter');
  }
});

test('structural gate never auto-splits an outer wrapper into a writing render-batch', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  const jsx = '<Frame flex="row"><Frame name="Card 1"><Text>One</Text></Frame><Frame name="Card 2"><Text>Two</Text></Frame></Frame>';
  assert.equal(detectWrapperSplit(jsx)?.children.length, 2, 'fixture must exercise auto-split');
  const result = spawnSync(process.execPath, [entry, 'render', jsx, '--structural-gate'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Structural gate: PASS/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,
    /outer flex wrapper detected|Rendered:|Plugin not connected|figma_connect/,
    'audit-only requests must never redispatch the mutating render-batch Adapter');
});

test('browser capture ignores unused render project inputs without touching the workspace', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  const result = spawnSync(process.execPath, [
    entry, 'render', '--print-browser-capture', '--icons', '/outside-workspace',
    '--dom-capture', '/also-unused',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /getComputedStyle|querySelector/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,
    /Icon directory not found|Could not read DOM capture|Workspace render-icons rejected/);
});

test('node set-text rejects excess CLI positionals before Plugin readiness', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  const result = spawnSync(process.execPath, [entry, 'node', 'set-text', '1:2', 'Hello', 'extra'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /too many arguments for 'set-text'/);
  assert.doesNotMatch(result.stderr, /Plugin not connected|figma_connect/,
    'request rejection must happen before the readiness Adapter');
});

test('token export projects valuesByMode centrally instead of selecting the first value', () => {
  const src = sources.get('export-eval.js');
  assert.match(src, /projectVariableModes\(/);
  assert.doesNotMatch(src, /Object\.values\([^\n]*valuesByMode/,
    'CSS/DTCG export must never silently select the first collection mode');
});

test('library code lives in lib/, not in command files', () => {
  // commands/map.js used to import componentInventoryCode from commands/misc.js.
  for (const [file, src] of sources) {
    const badImports = [...src.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => m[1]);
    assert.deepEqual(badImports, [], `${file} imports from a sibling command file`);
  }
});

test('component prop set keeps a validated local id for INSTANCE_SWAP values', () => {
  const src = sources.get('misc.js');
  const start = src.indexOf(".command('set <instanceId> <name> <value>')");
  const end = src.indexOf(".command('delete <componentId> <propName>')", start);
  const propSet = src.slice(start, end);
  assert.match(propSet, /parsed = component\.id;/,
    'Figma setProperties expects a local component node id for INSTANCE_SWAP');
  assert.doesNotMatch(propSet, /parsed = component\.key;/,
    'a publish key is not a valid local INSTANCE_SWAP property value');
});
