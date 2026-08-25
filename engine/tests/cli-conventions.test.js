// Conventions the command layer must keep, enforced by reading the sources.
// These are the regressions the engine review found: silent failures, a
// connection guard that was never awaited, success text on stderr, and
// library code stranded inside command files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
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

test('surfaced Commander catch failures always retain a nonzero process outcome', () => {
  const offenders = [];
  for (const [file, source] of sources) {
    const sourceFile = ts.createSourceFile(
      file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'action') {
        const action = node.arguments[0];
        if (action && ts.isFunctionLike(action)) {
          const visitAction = (child) => {
            if (child !== action && ts.isFunctionLike(child)) return;
            if (ts.isCatchClause(child)) {
              const text = child.getText(sourceFile);
              const surfacesFailure = /chalk\.red|spinner\.fail|console\.error/.test(text);
              const ownsOutcome = /handleEvalError\s*\(|process\.(?:exitCode\s*=|exit\s*\()/.test(text);
              if (surfacesFailure && !ownsOutcome) {
                const line = sourceFile.getLineAndCharacterOfPosition(child.getStart(sourceFile)).line + 1;
                offenders.push(`${file}:${line}`);
              }
            }
            ts.forEachChild(child, visitAction);
          };
          visitAction(action);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  assert.deepEqual(offenders, [],
    'a caught, user-visible failure must not let Commander finish with code 0');
});

test('the shared eval error reporter sets exitCode without terminating reusable code', () => {
  const helperStart = cliCoreSource.indexOf('function handleEvalError');
  const helperEnd = cliCoreSource.indexOf('\n}\n\nexport {', helperStart) + 2;
  const helper = cliCoreSource.slice(helperStart, helperEnd);
  assert.match(helper, /process\.exitCode = 1/);
  assert.doesNotMatch(helper, /process\.exit\(/);

  const cliCoreUrl = pathToFileURL(join(LIB_DIR, 'cli-core.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { handleEvalError } from ${JSON.stringify(cliCoreUrl)}; handleEvalError(new Error('fixture failure'));`,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture failure/);
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

test('node bindings delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('bindings [nodeId]')");
  const end = adapter.indexOf(".command('css <nodeId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(nodeBindingsPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeBindingsPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|boundVariables|getVariableByIdAsync/,
    'Commander must not retain Node Binding Facts readiness, capture, or formatting logic');
});

test('node css delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('css <nodeId>')");
  const end = adapter.indexOf(".command('to-component <nodeIds...>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(nodeCssPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeCssPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|nodeCssCode\(|formatNodeCss\(/,
    'Commander must not retain Node CSS readiness, capture, or formatting logic');
});

test('component main delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('main <instanceId>')");
  const end = adapter.indexOf(".command('swap <instanceId> <componentId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(componentMainPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentMainPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|componentContextExpr\(|getMainComponentAsync/,
    'Commander must not retain component identity readiness, capture, or formatting logic');
});

test('style show delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('show <style>')");
  const end = adapter.indexOf("styles.command('create <type> <name>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(styleFactsPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStyleFactsPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|styleShowCode\(/,
    'Commander must not retain Style Facts readiness, capture, or formatting logic');
});

test('style list delegates one Plan-bound bounded Style Catalog Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('list')");
  const end = adapter.indexOf("styles.command('show <style>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(styleCatalogPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStyleCatalogPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|styleListCode\(/,
    'Commander must not retain Style Catalog readiness, capture, or formatting logic');
});

test('style create delegates one Plan-bound journaled mutation Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('create <type> <name>')");
  const end = adapter.indexOf("styles.command('update <style>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(styleCreatePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStyleCreatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|styleCreateCode\(/,
    'Commander must not retain Style Create readiness, mutation, or formatting logic');
});

test('style apply delegates one Plan-bound preflighted mutation Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('apply <style> <nodeIds>')");
  const end = adapter.indexOf("styles.command('consumers <style>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /layout-guide\/Grid Style \(grid alias; not Auto Layout Grid\)/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(styleApplyPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStyleApplyPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|styleApplyCode\(/,
    'Commander must not retain Style Apply readiness, mutation, or formatting logic');
});

test('grid command vocabulary separates Layout Guides from Auto Layout Grid', () => {
  const guides = sources.get('misc.js');
  const autoLayout = sources.get('grid-layout.js');
  assert.ok(guides, 'misc.js exists');
  assert.ok(autoLayout, 'grid-layout.js exists');

  const guideStart = guides.indexOf(".command('grid')");
  const guideEnd = guides.indexOf('// ============ COMPONENT PROPERTIES', guideStart);
  const guideCommands = guides.slice(guideStart, guideEnd);
  assert.match(guideCommands, /Manage Layout Guides on frames \(not Auto Layout Grid\)/);
  assert.match(guideCommands, /Set a column or row Layout Guide/);
  assert.match(guideCommands, /List Layout Guides/);
  assert.match(guideCommands, /Remove all Layout Guides/);

  assert.match(autoLayout, /Manage Auto Layout Grid containers \(not Layout Guides\)/);
  assert.match(autoLayout, /command\('layout'\).*Manage native Auto Layout features/s);
});

test('style consumers delegates one Plan-bound bounded Consumer Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('consumers <style>')");
  const end = adapter.indexOf("styles.command('publish-status <style>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(styleConsumerPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStyleConsumerPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|styleConsumersCode\(/,
    'Commander must not retain Style Consumer readiness, scan, or formatting logic');
});

test('style publish-status delegates one Plan-bound bounded-read Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('publish-status <style>')");
  const end = adapter.indexOf("styles.command('delete <style>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(stylePublishStatusPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStylePublishStatusPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|stylePublishStatusCode\(/,
    'Commander must not retain Style Publish Status readiness, capture, or formatting logic');
});

test('grid list delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('list [nodeId]')", adapter.indexOf(".command('grid')"));
  const end = adapter.indexOf(".command('clear <nodeId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(layoutGridFactsPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeLayoutGridFactsPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|figma\.currentPage\.selection|n\.layoutGrids/,
    'Commander must not retain Layout Grid Facts readiness, capture, or formatting logic');
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

test('top-level find delegates one Plan-bound bounded Node Discovery Application', () => {
  const adapter = sources.get('canvas-ops.js');
  assert.ok(adapter, 'canvas-ops.js exists');
  const start = adapter.indexOf(".command('find <name>')");
  const helperStart = adapter.indexOf('async function runNodeDiscoveryCommand');
  const helperEnd = adapter.indexOf("canvas\n  .command('info')", helperStart);
  const action = adapter.slice(helperStart, helperEnd) + adapter.slice(start);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(nodeDiscoveryPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeDiscoveryPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|evalPrint\(|function search\(|currentPage\)/,
    'Commander must not retain Node Discovery readiness, traversal, or formatting logic');
});

test('prototype inspect delegates one Plan-bound bounded Prototype Inspection Application', () => {
  const adapter = sources.get('prototype.js');
  assert.ok(adapter, 'prototype.js exists');
  const start = adapter.indexOf("prototype.command('inspect <nodeId>')");
  const end = adapter.indexOf("prototype.command('add <nodeId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(prototypeInspectionPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executePrototypeInspectionPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|prototypeInspectCode\(/,
    'Commander must not retain Prototype Inspection readiness, execution, or formatting logic');
});

test('var show delegates one Plan-bound bounded Variable Facts Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables.command('show <variable>')");
  const end = adapter.indexOf("variables.command('update <variable>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(variableFactsArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableFactsPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableShowCode\(/,
    'Commander must not retain Variable Facts readiness, execution, or formatting logic');
});

test('var resolve delegates one target-bound Variable Resolution Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables.command('resolve <variable> <nodeId>')");
  const end = adapter.indexOf("variables.command('publish-status <variable>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(variableResolutionPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableResolutionPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableResolveCode\(/,
    'Commander must not retain Variable Resolution readiness, execution, or formatting logic');
});

test('canvas info and next delegate one Plan-bound Canvas Awareness Application', () => {
  const adapter = sources.get('canvas-ops.js');
  assert.ok(adapter, 'canvas-ops.js exists');
  const infoStart = adapter.indexOf(".command('info')");
  const infoEnd = adapter.indexOf(".command('pages')", infoStart);
  const nextStart = adapter.indexOf(".command('next')");
  const nextEnd = adapter.indexOf('// (The selection-driven command groups', nextStart);
  const actions = adapter.slice(infoStart, infoEnd) + adapter.slice(nextStart, nextEnd);
  const helperStart = adapter.indexOf('async function runCanvasAwarenessCommand');
  const helper = adapter.slice(helperStart, infoStart);

  assert.equal((actions.match(/runCanvasAwarenessCommand\(/g) || []).length, 2);
  assert.match(helper, /canvasAwarenessPlanningArgvFromRequest/);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /executeCanvasAwarenessPlan\(plan/);
  assert.match(helper, /await ensurePluginReadiness\(\{ deadline/);
  assert.doesNotMatch(actions, /checkConnection\(|evalPrint\(|currentPage\.children/,
    'Commander must not retain Canvas Awareness readiness, traversal, or formatting logic');
});

test('canvas pages and page delegate one Plan-bound Page Navigation Application', () => {
  const adapter = sources.get('canvas-ops.js');
  assert.ok(adapter, 'canvas-ops.js exists');
  const pagesStart = adapter.indexOf(".command('pages')");
  const pagesEnd = adapter.indexOf(".command('page-create <name>')", pagesStart);
  const pageStart = adapter.indexOf(".command('page <nameOrId>')");
  const pageEnd = adapter.indexOf(".command('next')", pageStart);
  const actions = adapter.slice(pagesStart, pagesEnd) + adapter.slice(pageStart, pageEnd);
  const helperStart = adapter.indexOf('async function runPageNavigationCommand');
  const helper = adapter.slice(helperStart, pagesStart);

  assert.equal((actions.match(/runPageNavigationCommand\(/g) || []).length, 2);
  assert.match(helper, /pageNavigationPlanningArgvFromRequest/);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /executePageNavigationPlan\(plan/);
  assert.match(helper, /await ensurePluginReadiness\(\{ deadline/);
  assert.doesNotMatch(actions, /checkConnection\(|pageLookupCode\(|figma\.root\.children|setCurrentPageAsync/,
    'Commander must not retain Page Navigation readiness, resolution, or formatting logic');
});

test('canvas page-create and page-divider delegate one Plan-bound Page Structure Application', () => {
  const adapter = sources.get('canvas-ops.js');
  assert.ok(adapter, 'canvas-ops.js exists');
  const start = adapter.indexOf(".command('page-create <name>')");
  const end = adapter.indexOf(".command('page <nameOrId>')", start);
  const actions = adapter.slice(start, end);
  const helperStart = adapter.indexOf('async function runPageStructureCommand');
  const helper = adapter.slice(helperStart, start);

  assert.equal((actions.match(/runPageStructureCommand\(/g) || []).length, 2);
  assert.match(helper, /pageStructurePlanningArgvFromRequest/);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /executePageStructurePlan\(plan/);
  assert.match(helper, /await ensurePluginReadiness\(\{ deadline/);
  assert.doesNotMatch(actions,
    /checkConnection\(|figma\.createPage|figma\.createPageDivider|setCurrentPageAsync|insertChild/,
    'Commander must not retain Page Structure readiness, mutation, or formatting logic');
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

test('font inspect delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('font.js');
  assert.ok(adapter, 'font.js exists');
  const start = adapter.indexOf(".command('inspect <nodeId>')");
  const end = adapter.indexOf(".command('axes <nodeId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(fontInspectionPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeFontInspectionPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|fontInspectCode\(|getStyledTextSegments/,
    'Commander must not retain Font Inspection readiness, capture, or formatting logic');
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

test('unsafe legacy bulk writes stop before connection or generated mutation code', () => {
  const variables = sources.get('variables.js');
  const deleteStart = variables.indexOf(".command('delete-all')");
  const deleteEnd = variables.indexOf('// (The batch operations', deleteStart);
  const deleteAll = variables.slice(deleteStart, deleteEnd);
  assert.match(deleteAll, /delete-all is disabled/);
  assert.match(deleteAll, /process\.exitCode = 1/);
  assert.doesNotMatch(deleteAll, /checkConnection\(|daemonExec\(|\.remove\(/);

  const tokens = sources.get('tokens.js');
  const rebindStart = tokens.indexOf(".command('rebind <collection>')");
  const rebind = tokens.slice(rebindStart);
  assert.ok(rebind.indexOf('options.page && options.apply') < rebind.indexOf('await checkConnection()'));

  const nodes = sources.get('node-ops.js');
  for (const [action, endMarker] of [
    [".command('bind [nodeId] [property] [varName]')", 'const SET_ENUMS'],
    [".command('set [nodeId]')", null],
  ]) {
    const start = nodes.indexOf(action);
    const end = endMarker ? nodes.indexOf(endMarker, start) : nodes.length;
    const slice = nodes.slice(start, end);
    assert.ok(slice.indexOf('if (options.batch)') < slice.indexOf('await checkConnection()'));
    assert.match(slice, /process\.exitCode = 1/);
  }
});
