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

test('token commands report failures without abruptly terminating active transports', () => {
  const adapter = sources.get('tokens.js');
  assert.ok(adapter, 'tokens.js exists');
  assert.doesNotMatch(adapter, /process\.exit\(/);
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

test('Variable Snapshot extraction pins every catalog and chunk read to one revision', () => {
  const adapter = sources.get('extract.js');
  assert.ok(adapter, 'extract.js exists');
  assert.match(adapter, /createRevisionContext\(/);
  assert.match(adapter, /daemonExecWithMetadata\('eval'/);
  assert.match(adapter, /revisionContext\.accept\(response\.metadata/);
  assert.match(adapter, /parseEvalResult\(response\.value\)/,
    'revisioned capture must consume the Daemon Client value field');
  assert.doesNotMatch(adapter, /parseEvalResult\(response\.result\)/,
    'the obsolete transport result field would turn every catalog into undefined');
  assert.match(adapter, /source\(\)\?\.proof !== 'document-revision'/);
  const variableStart = adapter.indexOf("const wantsVariables");
  const pageStart = adapter.indexOf('const results = []', variableStart);
  const variableCapture = adapter.slice(variableStart, pageStart);
  assert.doesNotMatch(variableCapture, /fastEval\(/,
    'exact Variable reads must never fall back to result-only eval');
  assert.doesNotMatch(variableCapture, /catch[^}]*= \[\]/s,
    'a failed Variable catalog must not become an empty successful catalog');
  assert.ok(variableCapture.indexOf('exactVariableCatalog(')
    < variableCapture.indexOf('for (let ci = 0; ci < cols.length'),
  'catalog count and topology bounds must apply before the first chunk loop');
  assert.ok(variableCapture.indexOf('capturedBytes += exact.bytes')
    < variableCapture.indexOf('collected.push(...exact.variables)'),
  'aggregate byte and structure budgets must apply before retaining a chunk');
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

test('style update delegates one Plan-bound rollback-owned mutation Application', () => {
  const adapter = sources.get('styles.js');
  assert.ok(adapter, 'styles.js exists');
  const start = adapter.indexOf("styles.command('update <style>')");
  const end = adapter.indexOf("styles.command('apply <style> <nodeIds>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(styleUpdatePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeStyleUpdatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|styleUpdateCode\(/,
    'Commander must not retain Style Update readiness, mutation, or formatting logic');
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

test('style delete delegates one Plan-bound compact non-retrying Application', () => {
  const adapter = sources.get('styles.js');
  const start = adapter.indexOf("styles.command('delete <style>')");
  const end = adapter.indexOf("styles.command('bind-font <style> <field>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /styleDeletePlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /executeStyleDeletePlan\(plan/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /fastEval\(|styleDeleteCode\(/);
});

test('Text Style bind and unbind delegate one preflighted rollback-owned Application', () => {
  const adapter = sources.get('styles.js');
  const start = adapter.indexOf("styles.command('bind-font <style> <field>')");
  const slice = adapter.slice(start);
  assert.match(slice, /\.allowExcessArguments\(false\)/);
  assert.match(slice, /textStyleVariableBindingPlanningArgvFromRequest/);
  assert.match(slice, /executeTextStyleVariableBindingPlan/);
  assert.match(slice, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.doesNotMatch(slice, /styleBindVariableCode\(|fastEval\(/);
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

test('top-level import delegates one conditional Plan-bound Design Source Application', () => {
  const adapter = sources.get('setup.js');
  assert.ok(adapter, 'setup.js exists');
  const start = adapter.indexOf(".command('import <source>')");
  const end = adapter.indexOf('// Default action when no command is given', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(designSourceImportPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /prepareDesignSourceImportPlan\(plan/);
  assert.match(action, /if \(designSourceImportRequiresFigma\(prepared\)\)/,
    'repository-only context must not require Plugin readiness');
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeDesignSourceImportPlan\(plan/);
  assert.doesNotMatch(action,
    /detectSourceType\(|\bconvert\(|parseDesignMd\(|writeFile|DESIGN-storybook|program\.parseAsync|tokensImportPlanningArgvFromRequest/,
    'Commander must not regain source detection, conversion, persistence, or nested command ownership');
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

test('var list and find delegate one Plan-bound bounded Variable Discovery Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const helperStart = adapter.indexOf('async function runVariableDiscovery');
  const listStart = adapter.indexOf(".command('list')");
  const listEnd = adapter.indexOf(".command('create <name>')", listStart);
  const findStart = adapter.indexOf(".command('find <pattern>')");
  const findEnd = adapter.indexOf("variables.command('show <variable>')", findStart);
  const action = adapter.slice(helperStart, listStart)
    + adapter.slice(listStart, listEnd) + adapter.slice(findStart, findEnd);

  assert.match(action, /variableDiscoveryPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableDiscoveryPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.equal((action.match(/\.allowExcessArguments\(false\)/g) || []).length, 2);
  assert.doesNotMatch(action, /checkConnection\(|listVariables\(|findVariables\(|fastEval\(/,
    'Commander must not retain Variable Discovery readiness, matching, or formatting logic');
});

test('var create delegates one Plan-bound journaled non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables\n  .command('create <name>')");
  const end = adapter.indexOf("variables\n  .command('find <pattern>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableCreatePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableCreatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|evalPrint\(|createVariable\(/,
    'Commander must not retain Variable Create execution or formatting logic');
});

test('var create-batch delegates one Plan-bound journaled non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables\n  .command('create-batch <json>')");
  const end = adapter.indexOf("variables\n  .command('delete <names...>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableCreateBatchPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableCreateBatchPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|createVariable\(|setValueForMode\(/,
    'Commander must not retain Variable Batch Creation execution or formatting logic');
});

test('var visualize delegates one Plan-bound journaled non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  const start = adapter.indexOf("variables\n  .command('visualize [collection]')");
  const end = adapter.indexOf("variables\n  .command('create-batch <json>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableVisualizationPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableVisualizationPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/); assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|createFrame\(|setBoundVariableForPaint\(/,
    'Commander must not retain Variable Visualization execution or formatting logic');
});

test('var set-value delegates one Plan-bound rollback-owned non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables.command('set-value <variable> [value]')");
  const end = adapter.indexOf("variables.command('code-syntax <variable> <platform> [value]')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableSetValuePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableSetValuePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableSetValueCode\(/,
    'Commander must not retain Variable Set Value execution or formatting logic');
});

test('var code-syntax delegates one Plan-bound rollback-owned non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables.command('code-syntax <variable> <platform> [value]')");
  const end = adapter.indexOf("variables.command('resolve <variable> <nodeId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableCodeSyntaxPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableCodeSyntaxPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableCodeSyntaxCode\(/,
    'Commander must not retain Variable Code Syntax execution or formatting logic');
});

test('var update delegates one Plan-bound field-rollback non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables.command('update <variable>')");
  const end = adapter.indexOf("variables.command('set-value <variable> [value]')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableUpdatePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableUpdatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableUpdateCode\(/,
    'Commander must not retain Variable Update execution or formatting logic');
});

test('var delete delegates one Plan-bound exact irreversible Application', () => {
  const adapter = sources.get('variables.js');
  const start = adapter.indexOf(".command('delete <names...>')");
  const end = adapter.indexOf(".command('delete-all')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableDeletePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableDeletePlan\(plan/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|const code =|getLocalVariablesAsync/,
    'Commander must not retain Variable Deletion readiness, resolution, or mutation logic');
});

test('col list and show delegate separate Plan-bound bounded read Applications', () => {
  const adapter = sources.get('tokens.js');
  assert.ok(adapter, 'tokens.js exists');
  const listStart = adapter.indexOf("collections\n  .command('list')");
  const listEnd = adapter.indexOf("collections\n  .command('create <name>')", listStart);
  const showStart = adapter.indexOf("collections.command('show <collection>')");
  const showEnd = adapter.indexOf("collections.command('update <collection>')", showStart);
  const list = adapter.slice(listStart, listEnd);
  const show = adapter.slice(showStart, showEnd);

  assert.match(list, /collectionCatalogPlanningArgvFromRequest/);
  assert.match(list, /executeCollectionCatalogPlan\(plan/);
  assert.match(show, /collectionFactsArgvFromRequest/);
  assert.match(show, /executeCollectionFactsPlan\(plan/);
  for (const action of [list, show]) {
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
    assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
    assert.match(action, /daemonExec\('eval'/);
    assert.match(action, /process\.exitCode = 1/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|listCollections\(|collectionShowCode\(/,
      'Commander must not retain Collection read execution or formatting logic');
  }
});

test('col create delegates one Plan-bound journaled non-retrying Application', () => {
  const adapter = sources.get('tokens.js');
  assert.ok(adapter, 'tokens.js exists');
  const start = adapter.indexOf("collections\n  .command('create <name>')");
  const end = adapter.indexOf("collections.command('show <collection>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /collectionCreatePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeCollectionCreatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|createCollection\(/,
    'Commander must not retain Collection Create execution or formatting logic');
});

test('col update delegates one Plan-bound field-rollback non-retrying Application', () => {
  const adapter = sources.get('tokens.js');
  assert.ok(adapter, 'tokens.js exists');
  const start = adapter.indexOf("collections.command('update <collection>')");
  const end = adapter.indexOf("collections.command('mode-add <collection> <name>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /collectionUpdatePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeCollectionUpdatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|collectionUpdateCode\(/,
    'Commander must not retain Collection Update execution or formatting logic');
});

test('col mode mutations delegate one Plan-bound action-specific non-retrying Application', () => {
  const adapter = sources.get('tokens.js');
  assert.ok(adapter, 'tokens.js exists');
  const helperStart = adapter.indexOf('async function runCollectionMode');
  const start = adapter.indexOf("collections.command('mode-add <collection> <name>')");
  const end = adapter.indexOf("collections.command('publish-status <collection>')", start);
  const action = adapter.slice(helperStart, end);
  assert.match(action, /collectionModePlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeCollectionModePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.equal((action.match(/\.allowExcessArguments\(false\)/g) || []).length, 3);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|collectionModeCode\(/,
    'Commander must not retain Collection Mode execution or formatting logic');
});

test('col delete delegates one Plan-bound irreversible non-retrying Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf("collections.command('delete <collection>')");
  const end = adapter.indexOf("collections.command('extend <collection> <name>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /collectionDeletePlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /executeCollectionDeletePlan\(plan/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|collectionDeleteCode\(/);
});

test('col extend delegates one Plan-bound journaled non-retrying Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf("collections.command('extend <collection> <name>')");
  const end = adapter.indexOf('// ============ TOKENS (PRESETS) ============', start);
  const action = adapter.slice(start, end);
  assert.match(action, /collectionExtendPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeCollectionExtendPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|collectionExtendCode\(/,
    'Commander must not retain Collection Extension readiness, creation, or formatting logic');
});

test('tokens spacing and radii delegate one Plan-bound journaled Preset Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf('async function runTokenPreset');
  const end = adapter.indexOf("tokens\n  .command('import <file>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /tokenPresetPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeTokenPresetPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/); assert.match(action, /process\.exitCode = 1/);
  assert.equal((action.match(/\.allowExcessArguments\(false\)/g) || []).length, 2);
  assert.doesNotMatch(action, /checkConnection\(|evalPrint\(|createVariableCollection\(|setValueForMode\(/,
    'Commander must not retain Token Preset readiness, factory, mode, or formatting logic');
});

test('tokens add delegates one Plan-bound journaled Token Add Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf(".command('add <name> <value>')");
  const end = adapter.indexOf('// ============ REBIND', start);
  const action = adapter.slice(start, end);
  assert.match(action, /tokenAddPlanningArgvFromRequest/);
  assert.match(action, /--allow-duplicate/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeTokenAddPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/); assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|evalPrint\(|createVariableCollection\(|createVariable\(|setValueForMode\(|startsWith\('#'\)/,
    'Commander must not retain Token Add readiness, inference, factories, scope, or formatting logic');
});

test('tokens import delegates pre-read and mutation to one Plan-bound Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf(".command('import <file>')");
  const end = adapter.indexOf('// ============ SYNC', start);
  const action = adapter.slice(start, end);
  assert.match(action, /tokenImportPlanningArgvFromRequest/);
  assert.match(action, /prepareTokenImportPlan\(plan, \{ workspaceIO: workspaceIO\(\) \}\)/);
  assert.ok(action.indexOf('prepareTokenImportPlan') < action.indexOf('ensurePluginReadiness'));
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /executeTokenImportPlan\(plan, prepared/);
  assert.match(action, /daemonExec\('eval'/); assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|readText\(|parseBoundedJson\(|createVariableCollection\(|createVariable\(|setValueForMode\(/,
    'Commander must not retain Token Import authority, parsing, factories, mode, or formatting logic');
});

test('tokens import-design-md print-context delegates one repository-only Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf(".command('import-design-md <file>')");
  const end = adapter.indexOf(".command('add <name> <value>')", start);
  const action = adapter.slice(start, end);
  const contextBranch = action.slice(0, action.indexOf('let plan;'));
  assert.match(contextBranch, /designMdPlanningArgvFromRequest/);
  assert.match(contextBranch, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(contextBranch, /executeDesignMdContextPlan\(plan/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.doesNotMatch(contextBranch, /checkConnection\(|ensurePluginReadiness\(|daemonExec\(/,
    'repository-only context must not require or dispatch to Figma');
});

test('exact v2 and simple DESIGN.md mutations delegate to one Plan-bound Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf(".command('import-design-md <file>')");
  const end = adapter.indexOf(".command('add <name> <value>')", start);
  const action = adapter.slice(start, end);
  const simpleBranch = action.slice(action.indexOf('let plan;'),
    action.indexOf('const parsed = prepared.parsed;'));
  assert.match(simpleBranch, /prepareDesignMdImportPlan\(plan, \{ workspaceIO: workspaceIO\(\) \}\)/);
  assert.ok(simpleBranch.indexOf('prepareDesignMdImportPlan')
    < simpleBranch.indexOf('ensurePluginReadiness'));
  assert.match(simpleBranch, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(simpleBranch, /executeDesignMdImportPlan\(plan, prepared/);
  assert.match(simpleBranch, /prepared\.kind === 'variable-snapshot-v2'/);
  assert.match(simpleBranch, /daemonExec\('eval'/);
  assert.doesNotMatch(simpleBranch,
    /checkConnection\(|variableImportCode|createVariableCollection\(|createVariable\(|modes\[0\]/,
    'simple DESIGN.md import must not retain readiness, factories, modes, or generated mutation logic');
});

test('DESIGN.md CLI rejects an explicitly empty Collection before workspace or Plugin access', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  for (const suffix of [[], ['--print-context']]) {
    const result = spawnSync(process.execPath, [
      entry, 'tokens', 'import-design-md', '/missing/private/DESIGN.md', '--collection=', ...suffix,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /--collection requires a value/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,
      /Workspace|Plugin not connected|figma_connect|ENOENT/,
      'empty target identity must fail before either Adapter gains file or Plugin access');
  }
});

test('tokens overlap delegates one Plan-bound bounded-read Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf(".command('overlap <collections...>')");
  const end = adapter.indexOf(".command('import-design-md <file>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /tokenOverlapPlanningArgvFromRequest/);
  assert.match(action, /--limit <count>/); assert.match(action, /--json/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeTokenOverlapPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/); assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|getLocalVariablesAsync|new Set\(|commonCore|missing_here|only_here/,
    'Commander must not retain Token Overlap readiness, resolution, set arithmetic, or formatting');
});

test('tokens rebind delegates one Plan-bound dry-run and rollback-owned Application', () => {
  const adapter = sources.get('tokens.js');
  const start = adapter.indexOf(".command('rebind <collection>')");
  const action = adapter.slice(start);
  assert.match(action, /tokenRebindPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeTokenRebindPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|getLocalVariablesAsync|setBoundVariableForPaint/,
    'Commander must not retain Token Rebind gates, resolution, mutation, rollback, or formatting');
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

test('var and col publish-status delegate one compact Token Publish Status Application', () => {
  const variableAdapter = sources.get('variables.js');
  const collectionAdapter = sources.get('tokens.js');
  const variableStart = variableAdapter.indexOf("variables.command('publish-status <variable>')");
  const variableEnd = variableAdapter.indexOf("variables\n  .command('visualize [collection]')", variableStart);
  const collectionStart = collectionAdapter.indexOf("collections.command('publish-status <collection>')");
  const collectionEnd = collectionAdapter.indexOf("collections.command('delete <collection>')", collectionStart);
  for (const action of [
    variableAdapter.slice(variableStart, variableEnd),
    collectionAdapter.slice(collectionStart, collectionEnd),
  ]) {
    assert.match(action, /tokenPublishStatusPlanningArgvFromRequest/);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
    assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
    assert.match(action, /executeTokenPublishStatusPlan\(plan/);
    assert.match(action, /daemonExec\('eval'/);
    assert.match(action, /process\.exitCode = 1/);
    assert.doesNotMatch(action,
      /checkConnection\(|fastEval\(|variablePublishStatusCode\(|collectionPublishStatusCode\(/,
      'Commander must not retain Token Publish Status execution or formatting logic');
  }
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
  assert.doesNotMatch(application, /permitsCompatibilityRedispatch/);
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
  assert.match(rebind, /tokenRebindPlanningArgvFromRequest/);
  assert.match(rebind, /executeTokenRebindPlan\(plan/);
  assert.doesNotMatch(rebind, /checkConnection\(|fastEval\(|rebindCode\(/,
    'Commander delegates the page gate and all rebinding work to the closed Application');

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
