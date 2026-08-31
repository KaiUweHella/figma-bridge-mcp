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
const APPLICATION_DIR = join(COMMANDS_DIR, '..', 'application');
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

test('extract --no-split does not imply bypassing hard Workspace limits', () => {
  const source = sources.get('extract.js');
  const option = source.match(/\.option\('--no-split',\s*'([^']+)'\)/)?.[1] || '';
  assert.match(option, /Structure/);
  assert.match(option, /hard Workspace limits/);
  assert.match(option, /safe Variable degradation/);
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
  const helperStart = src.indexOf('async function executeLegacyEval');
  const start = src.indexOf(".command('eval [code]')");
  const end = src.indexOf('// Run command - alias for eval', start);
  const helper = src.slice(helperStart, start);
  const evalCommand = src.slice(start, end);

  assert.match(helper, /const fileKey = targetFileKey\(\)/);
  assert.match(helper, /const expectedEditor = expectedEditorForCommand\(\)/);
  assert.match(helper, /const deadline = Date\.now\(\) \+ LEGACY_EVAL_TIMEOUT_MS/);
  assert.match(helper, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor,/);
  assert.match(helper, /daemonExec\('eval',[\s\S]*fileKey[\s\S]*deadline - Date\.now\(\)/,
    'eval readiness and dispatch must share one explicit target and decreasing deadline');
  assert.match(evalCommand, /executeLegacyEval\(jsCode\)/,
    'eval must use the shared target-bound Legacy Eval Implementation');
  assert.doesNotMatch(evalCommand, /catch\s*\(|figmaEvalSync|sync path|ECONNREFUSED|fetch failed/,
    'eval must not classify transport errors or select another path itself');
});

test('run alias uses the same target-bound Legacy Eval Implementation', () => {
  const src = sources.get('export-eval.js');
  const start = src.indexOf(".command('run <file>')");
  const end = src.indexOf('// (The `raw` passthrough command was removed', start);
  const runCommand = src.slice(start, end);
  assert.match(runCommand, /executeLegacyEval\(code\)/);
  assert.doesNotMatch(runCommand, /checkConnection\(|daemonExec\(/);
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

test('history save delegates one Plan-bound native version write Application', () => {
  const adapter = sources.get('history.js');
  const start = adapter.indexOf(".command('save <title>')");
  const end = adapter.indexOf('async function runHistory', start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runHistory\(\{ action: 'save'/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|saveVersionCode\(/);
  const application = readFileSync(join(APPLICATION_DIR, 'history-command.js'), 'utf8');
  assert.match(application, /figma\.saveVersionHistoryAsync\(request\.title/);
  assert.match(application, /MAX_VERSION_SAVE_RESULT_CODE_UNITS/);
});

test('the remaining direct History write inventory is explicit', () => {
  const adapter = sources.get('history.js');
  const start = adapter.indexOf(".command('save <title>')");
  const end = adapter.indexOf('async function runHistory', start);
  const direct = /checkConnection\(\)|fastEval\(/.test(adapter.slice(start, end)) ? ['save'] : [];
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-06 History Legacy Write count may decrease, but must never increase silently');
});

test('Design Contract delegates target-bound readiness and execution to its Command Plan', () => {
  const adapter = sources.get('contract.js');
  assert.ok(adapter, 'contract.js exists');
  const helperStart = adapter.indexOf('async function runContract');
  const actionStart = adapter.indexOf("contract\n  .command('capture <entityId>')", helperStart);
  const helper = adapter.slice(helperStart, actionStart);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(helper, /executeDesignContractPlan\(plan/);
  assert.match(helper, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(adapter, /checkConnection\(|fastEval\(/,
    'Design Contract must not regain Legacy Adapter readiness or eval');
});

test('every Design Link action delegates through one target-aware Command Application', () => {
  const adapter = sources.get('link.js');
  assert.ok(adapter, 'link.js exists');
  const helperStart = adapter.indexOf('async function runTracer');
  const helperEnd = adapter.indexOf("link\n  .command('set <nodeId> <entityId>')", helperStart);
  const helper = adapter.slice(helperStart, helperEnd);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /if \(plan\.target\.kind !== 'none'\)/);
  assert.match(helper, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(helper, /executeDesignLinkPlan\(plan/);
  assert.match(helper, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  for (const action of ['set', 'inspect', 'list', 'configure', 'status', 'accept', 'context']) {
    const start = adapter.indexOf(`.command('${action}`);
    const next = adapter.indexOf("\nlink\n  .command('", start + 1);
    const slice = adapter.slice(start, next === -1 ? adapter.length : next);
    assert.match(slice, /runTracer\(/, action);
  }
  assert.doesNotMatch(adapter, /checkConnection\(|fastEval\(|executeDesignLink\(/,
    'Design Link must not regain per-Adapter readiness or domain execution');
});

test('asset export Adapter delegates one Command Application to Manifest v2', () => {
  const adapter = sources.get('export-eval.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'asset-export-command.js'), 'utf8');
  const publicationWorker = readFileSync(join(LIB_DIR, 'asset-publication-worker-runtime.js'), 'utf8');
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
  assert.match(application, /AssetPublicationWorker/,
    'asset export must keep CPU and large publication work off the MCP event loop');
  assert.match(application, /byteWorker\.stage\(/,
    'asset bytes must be staged before the shared output lock');
  assert.match(application, /byteWorker\.publish\(/,
    'the Application must delegate the lock-bounded merge and commit');
  assert.match(publicationWorker, /planAssetExport\(/,
    'the Worker must resolve cross-run identity and filename collisions centrally');
  assert.match(publicationWorker, /prepareAssetExportPublication\(/,
    'the Worker must use staged atomic manifest-last publication');
  assert.doesNotMatch(application, /const usedNames\s*=|const byContent\s*=/,
    'run-local filename ordinals and dedup maps must not return');
});

test('Variable Snapshot extraction pins every catalog and chunk read to one revision', () => {
  const adapter = sources.get('extract.js');
  assert.ok(adapter, 'extract.js exists');
  assert.match(adapter, /createRevisionContext\(/);
  assert.match(adapter, /daemonExecWithMetadata\('eval'/);
  assert.match(cliCoreSource, /revisionObservation: data\.revisionObservation \|\| \{ scope: 'document' \}/,
    'multi-page metadata reads must select Document observation explicitly');
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

test('node move delegates raw signed positionals to one closed Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'node-move-command.js'), 'utf8');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('move [args...]')");
  const end = adapter.indexOf(".command('resize <nodeId> <width> <height>')", start);
  const action = adapter.slice(start, end);
  const helperStart = adapter.indexOf('async function runNodeMoveCommand');
  const helper = adapter.slice(helperStart, start);

  assert.match(action, /\.allowUnknownOption\(true\)/,
    'Commander must retain signed numeric tokens for the closed parser');
  assert.match(action, /runNodeMoveCommand\(\['node', 'move', \.\.\.args\]\)/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|node\.x\s*=|node\.y\s*=/,
    'Commander must not retain Node Move execution logic');
  assert.match(helper, /nodeMoveRequestFromArgv\(argv\)/);
  assert.match(helper, /nodeMoveRequestFromArgv\(argv\)/);
  assert.match(helper, /planFigmaCommand\(argv/);
  assert.match(helper, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(helper, /executeNodeMovePlan\(plan/);
  assert.match(application, /absoluteBoundingBox/,
    'the Application must verify in absolute canvas coordinates');
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

test('node delete delegates one Plan-bound hierarchy-verified Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'node-delete-command.js'), 'utf8');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('delete <nodeIds...>')");
  const end = adapter.indexOf(".command('bind [nodeId] [property] [varName]')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /planFigmaCommand\(nodeDeletePlanningArgvFromRequest\(\{ nodeIds \}\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeDeletePlan\(plan/);
  assert.match(action, /formatNodeDeleteResult\(domainResult\)/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|getNodeByIdAsync|\.remove\(\)/,
    'Commander must not retain Node Delete resolution, mutation, or verification logic');
  assert.match(application, /former parent still contains the target/,
    'success must depend on fresh former-parent membership');
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
  assert.match(action, /daemonTypedRead\(/);
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

test('node to-component delegates one Plan-bound irreversible non-retrying Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('to-component <nodeIds...>')");
  const end = adapter.indexOf('function structuralParentOptions', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeToComponentPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeToComponentPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|createComponentFromNode/,
    'Commander must not retain Node-to-Component preflight, mutation, or formatting logic');
});

test('node duplicate delegates one Plan-bound rollback-verified non-retrying Application', () => {
  const adapter = sources.get('node-ops.js');
  const application = readFileSync(join(
    COMMANDS_DIR, '..', 'application', 'node-duplicate-command.js',
  ), 'utf8');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('duplicate <nodeId>')");
  const end = adapter.indexOf(".command('reparent <nodeId> <parentId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeDuplicatePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeDuplicatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|\.clone\(\)|\.remove\(\)/,
    'Commander must not retain Node Duplicate preflight, mutation, rollback, or formatting');
  assert.match(application, /copy = source\.clone\(\)/,
    'the Application must own the only clone operation');
  assert.match(application, /try \{ copy\.remove\(\); \} catch \{\}/,
    'the Application must own best-effort rollback of only its new copy');
});

test('node set delegates one Plan-bound journaled multi-property Application', () => {
  const adapter = sources.get('node-ops.js');
  const start = adapter.indexOf(".command('set [nodeId]')");
  const action = adapter.slice(start);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeSetPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeSetPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|setCode\(/,
    'Commander must not retain Node Set preflight, mutation, rollback, or formatting');
});

test('the remaining direct Node write inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const matches = [...adapter.matchAll(/\.command\('([^']+)'/g)];
  const direct = [];
  for (let index = 0; index < matches.length; index++) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? adapter.length;
    const slice = adapter.slice(start, end);
    if (/checkConnection\(\)/.test(slice) && /fastEval\(/.test(slice)) {
      direct.push(matches[index][1].split(/[ <\[]/, 1)[0]);
    }
  }
  assert.deepEqual(direct.sort(), []);
  assert.equal(direct.length, 0,
    'STAB-26 Node-family Legacy Write count may decrease, but must never increase silently');
});

test('create frame delegates one Plan-bound rollback-verified Command Application', () => {
  const adapter = sources.get('create.js');
  const start = adapter.indexOf(".command('frame <name>')");
  const end = adapter.indexOf(".command('image <url>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /createFramePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeCreateFramePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|generateFillCode\(|createFrame\(\)|\.resize\(/,
    'Commander must not retain Create Frame preflight, mutation, rollback, or formatting');
});

test('the remaining public direct Create write inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('create.js');
  assert.ok(adapter, 'create.js exists');
  const direct = [];
  const named = [
    ['frame', ".command('frame <name>')"], ['rect', ".command('rect [name]')"],
    ['ellipse', ".command('ellipse [name]')"], ['vector', ".command('vector [name]')"],
    ['slice', ".command('slice [name]')"], ['text', ".command('text <content>')"],
    ['line', ".command('line')"], ['autolayout', ".command('autolayout [name]')"],
  ];
  for (const [name, marker] of named) {
    const start = adapter.indexOf(marker);
    const next = adapter.indexOf('.command(', start + marker.length);
    const end = next === -1 ? adapter.length : next;
    const slice = adapter.slice(start, end);
    if (/checkConnection\(\)/.test(slice)) direct.push(name);
  }
  const radialStart = adapter.indexOf('function registerRadialPrimitive');
  const radialEnd = adapter.indexOf(".command('vector [name]')", radialStart);
  if (/checkConnection\(\)/.test(adapter.slice(radialStart, radialEnd))) {
    direct.push('polygon', 'star');
  }
  assert.deepEqual(direct.sort(), []);
  assert.equal(direct.length, 0,
    'STAB-26 public Create-family Legacy Write count may decrease, but must never increase silently');
});

test('Text creation delegates one Plan-bound font-preflighted Application', () => {
  const adapter = sources.get('create.js');
  const start = adapter.indexOf(".command('text <content>')");
  const end = adapter.indexOf('.command(', start + 25);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runCreateText\(content, options\)/);
  assert.doesNotMatch(action, /checkConnection\(|daemonExec\(|figma\.createText\(/);
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'create-text-command.js'), 'utf8');
  assert.match(application, /await figma\.loadFontAsync\(request\.font\)/);
  assert.match(application, /figma\.createText\(\)/);
});

test('Measurement writes delegate one Plan-bound mutation Application', () => {
  const adapter = sources.get('measurements.js');
  for (const marker of ["command('add <from> <to>')", "command('edit <id>')", "command('delete <id>')"]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('measure.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runMeasurementMutation\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|measurement(?:Add|Edit|Delete)Code\(/);
  }
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'measurement-mutation-command.js'), 'utf8');
  assert.match(application, /page\.addMeasurement\(/);
  assert.match(application, /page\.editMeasurement\(/);
  assert.match(application, /page\.deleteMeasurement\(/);
});

test('Measurement list delegates one Plan-bound bounded read Application', () => {
  const adapter = sources.get('measurements.js');
  const start = adapter.indexOf("command('list [nodeId]')");
  const end = adapter.indexOf("measure.command('add", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runMeasurementRead\(/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|measurementListCode\(/);
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'measurement-read-command.js'), 'utf8');
  assert.match(application, /page\.getMeasurements\(\)/);
  assert.match(application, /page\.getMeasurementsForNode\(node\)/);
});

test('the remaining direct Measurement Read inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('measurements.js');
  assert.deepEqual([...adapter.matchAll(/measurementListCode|fastEval|checkConnection/g)].map((match) => match[0]), []);
});

test('Prototype writes delegate one Plan-bound rollback-owned Application', () => {
  const adapter = sources.get('prototype.js');
  for (const marker of ["command('add <nodeId>')", "command('set <nodeId>')", "command('clear <nodeId>')"]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('prototype.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runPrototypeMutation\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|prototype(?:Add|Set|Clear)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'prototype-mutation-command.js'), 'utf8');
  assert.match(application, /await node\.setReactionsAsync\(desired\)/);
  assert.match(application, /await node\.setReactionsAsync\(before\)/);
});

test('Library imports delegate one Plan-bound irreversible verified Application', () => {
  const adapter = sources.get('library.js');
  for (const name of ['variable', 'style', 'component', 'component-set']) {
    const marker = `command('import-${name} <key>')`;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('library.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runLibraryImport\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|import(?:Variable|Style|Component)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'library-import-command.js'), 'utf8');
  assert.match(application, /await importResource\(request\.key\)/);
  assert.match(application, /const fresh = await readResource\(imported\.id\)/);
});

test('the remaining direct Library Import write inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('library.js');
  const direct = [];
  for (const name of ['variable', 'style', 'component', 'component-set']) {
    const marker = `command('import-${name} <key>')`;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('library.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-26 Library Import Legacy Write count may decrease, but must never increase silently');
});

test('Library discovery delegates both reads to one Plan-bound bounded Application', () => {
  const adapter = sources.get('library.js');
  for (const name of ['collections', 'variables']) {
    const marker = `command('${name}`;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('library.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runLibraryRead\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|library(?:Collections|Variables)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'library-read-command.js'), 'utf8');
  assert.match(application, /getAvailableLibraryVariableCollectionsAsync\(\)/);
  assert.match(application, /getVariablesInLibraryCollectionAsync\(matches\[0\]\.facts\.key\)/);
  assert.doesNotMatch(application, /setTimeout\(|18000/,
    'the safe-read Plan, not generated Plugin code, owns the timeout');
});

test('the remaining direct Library Read inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('library.js'); const direct = [];
  for (const name of ['collections', 'variables']) {
    const marker = `command('${name}`;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('library.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-06 Library Read Legacy Action count may decrease, but must never increase silently');
});

test('Shader writes delegate one Plan-bound verified Application', () => {
  const adapter = sources.get('shaders.js');
  for (const marker of ["command('import <shaderId>')", "command('apply <nodeId> <shaderId>')"]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('shader.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runShaderMutation\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|shader(?:Import|Apply)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'shader-mutation-command.js'), 'utf8');
  assert.match(application, /await figma\.importShaderById\(request\.shaderId\)/);
  assert.match(application, /const fresh = await figma\.getNodeByIdAsync\(request\.nodeId\)/);
});

test('Shader list delegates one Plan-bound bounded read Application', () => {
  const adapter = sources.get('shaders.js');
  const start = adapter.indexOf("command('list')");
  const end = adapter.indexOf("shader.command('import", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runShaderRead\(/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|shaderListCode\(/);
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'shader-read-command.js'), 'utf8');
  assert.match(application, /await figma\.listAvailableShaders\(\)/);
});

test('the remaining direct Shader Read inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('shaders.js');
  assert.deepEqual([...adapter.matchAll(/shaderListCode|fastEval|checkConnection/g)].map((match) => match[0]), []);
});

test('the remaining direct Shader write inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('shaders.js'); const direct = [];
  for (const name of ['import', 'apply']) {
    const marker = name === 'import' ? "command('import <shaderId>')"
      : "command('apply <nodeId> <shaderId>')";
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('shader.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-26 Shader-family Legacy Write count may decrease, but must never increase silently');
});

test('Draw reads and writes delegate one Plan-bound verified Application', () => {
  const adapter = sources.get('draw.js');
  for (const name of ['inspect', 'text-path', 'transform-group', 'brush', 'stroke-profile', 'pattern']) {
    const marker = `command('${name} `;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('draw.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.ok(start >= 0, `${name} command exists`);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runDrawCommand\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|draw(?:Inspect|TextPath|TransformGroup|Brush|StrokeProfile|Pattern)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'draw-command.js'), 'utf8');
  assert.match(application, /figma\.createTextPath\(/);
  assert.match(application, /figma\.transformGroup\(/);
  assert.match(application, /await write\(desired\)/);
  assert.match(application, /await write\(before\)/);
});

test('the remaining direct Draw Action inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('draw.js'); const direct = [];
  for (const name of ['inspect', 'text-path', 'transform-group', 'brush', 'stroke-profile', 'pattern']) {
    const marker = `command('${name} `;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('draw.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-06 Draw-family Legacy Action count may decrease, but must never increase silently');
});

test('Slot create and edit delegate one Plan-bound rollback-owned Application', () => {
  const adapter = sources.get('slots.js');
  for (const marker of [
    "command('create <componentId> <name>')",
    "command('edit <componentId> <propertyName>')",
  ]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('slot.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runSlotConfiguration\(/);
    assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|slot(?:Create|Edit)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'slot-configuration-command.js'), 'utf8');
  assert.match(application, /component\.createSlot\(\)/);
  assert.match(application, /component\.editComponentProperty\(/);
  assert.match(application, /current\.deleteComponentProperty\(/);
});

test('Slot inspect and validate delegate one Plan-bound bounded read Application', () => {
  const adapter = sources.get('slots.js');
  for (const marker of ["command('inspect <nodeId>')", "command('validate [nodeId]')"]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('slot.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runSlotRead\(/);
    assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|slot(?:Inspect|Validate)Code\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'slot-read-command.js'), 'utf8');
  assert.match(application, /componentPropertyDefinitions/);
  assert.match(application, /root\.findAll\(\(node\) => node\.type === 'SLOT'\)/);
});

test('the remaining direct Slot Read inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('slots.js');
  assert.deepEqual([...adapter.matchAll(/slot(?:Inspect|Validate)Code|fastEval|checkConnection/g)].map((match) => match[0]), []);
});

test('the remaining direct Slot write inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('slots.js'); const direct = [];
  const markers = {
    create: "command('create <componentId> <name>')",
    edit: "command('edit <componentId> <propertyName>')",
    reset: "command('reset <nodeId>')",
  };
  for (const [name, marker] of Object.entries(markers)) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('slot.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/\brun\(|checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-26 Slot-family Legacy Write count may decrease, but must never increase silently');
});

test('Slot reset delegates one Plan-bound irreversible native-confirmed Application', () => {
  const adapter = sources.get('slots.js');
  const marker = "command('reset <nodeId>')";
  const start = adapter.indexOf(marker);
  const end = adapter.indexOf('slot.command(', start + marker.length);
  const action = adapter.slice(start, end === -1 ? adapter.length : end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runSlotReset\(/);
  assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|slotResetCode\(/);
  const application = readFileSync(join(APPLICATION_DIR, 'slot-reset-command.js'), 'utf8');
  assert.match(application, /slot\.resetSlot\(\)/);
  assert.match(application, /outcome: 'native-confirmed'/);
  assert.doesNotMatch(application, /resetSlot\(\).*resetSlot\(\)/s);
});

test('the remaining direct Prototype write inventory is explicit and cannot grow silently', () => {
  const adapter = sources.get('prototype.js'); const direct = [];
  for (const name of ['add', 'set', 'clear']) {
    const marker = `command('${name} <nodeId>')`; const start = adapter.indexOf(marker);
    const end = adapter.indexOf('prototype.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-26 Prototype-family Legacy Write count may decrease, but must never increase silently');
});

test('Auto Layout creation delegates one Plan-bound rollback-verified Application', () => {
  const adapter = sources.get('create.js');
  const start = adapter.indexOf(".command('autolayout [name]')");
  const end = adapter.indexOf('.command(', start + 30);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runCreateAutoLayout\(name, options\)/);
  assert.doesNotMatch(action, /checkConnection\(|daemonExec\(|figma\.createFrame\(/);
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'create-auto-layout-command.js'), 'utf8');
  assert.match(application, /figma\.createFrame\(\)/);
  assert.match(application, /frame\.layoutMode = request\.layoutMode/);
});

test('Line creation delegates one Plan-bound rollback-verified Application', () => {
  const adapter = sources.get('create.js');
  const start = adapter.indexOf(".command('line')");
  const end = adapter.indexOf('.command(', start + 20);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runCreateLine\(options\)/);
  assert.doesNotMatch(action, /checkConnection\(|daemonExec\(|figma\.createLine\(/);
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'create-line-command.js'), 'utf8');
  assert.match(application, /figma\.createLine\(\)/);
  assert.match(application, /mutationReport/);
});

test('Vector and Slice delegate one shared Plan-bound Canvas Node Application', () => {
  const adapter = sources.get('create.js');
  const application = readFileSync(join(
    COMMANDS_DIR, '..', 'application', 'create-canvas-node-command.js',
  ), 'utf8');
  for (const marker of [".command('vector [name]')", ".command('slice [name]')"]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('.command(', start + marker.length);
    const action = adapter.slice(start, end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runCreateCanvasNode\(/);
    assert.doesNotMatch(action, /checkConnection\(|daemonExec\(|createVector\(|createSlice\(/);
  }
  assert.match(application, /figma\.createVector\(\)/);
  assert.match(application, /figma\.createSlice\(\)/);
  assert.match(application, /await node\.setVectorNetworkAsync\(request\.network\)/);
});

test('public solid Shape factories delegate one shared Plan-bound Command Application', () => {
  const adapter = sources.get('create.js');
  const application = readFileSync(join(
    COMMANDS_DIR, '..', 'application', 'create-shape-command.js',
  ), 'utf8');
  for (const marker of [
    ".command('rect [name]')", ".command('ellipse [name]')",
  ]) {
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('.command(', start + marker.length);
    const action = adapter.slice(start, end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runCreateShape\(/);
    assert.doesNotMatch(action, /checkConnection\(|daemonExec\(|createRectangle\(|createEllipse\(/);
  }
  const radialStart = adapter.indexOf('function registerRadialPrimitive');
  const radialEnd = adapter.indexOf(".command('vector [name]')", radialStart);
  const radial = adapter.slice(radialStart, radialEnd);
  assert.match(radial, /runCreateShape\(command/);
  assert.doesNotMatch(radial, /checkConnection\(|daemonExec\(|createPolygon\(|createStar\(/);
  assert.match(application, /figma\.createRectangle\(\)/);
  assert.match(application, /figma\.createEllipse\(\)/);
  assert.match(application, /figma\.createPolygon\(\)/);
  assert.match(application, /figma\.createStar\(\)/);
});

test('node set-fill delegates one Plan-bound readback-verified Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const start = adapter.indexOf(".command('set-fill <nodeId> <color>')");
  const end = adapter.indexOf(".command('set-image <nodeId> <file>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeSetFillPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeSetFillPlan\(plan/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|fastEval\(|generateFillCode\(|node\.fills\s*=|setBoundVariableForPaint\(/);
});

test('node set-image delegates prepared bytes to one Plan-bound verified Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const start = adapter.indexOf(".command('set-image <nodeId> <file>')");
  const end = adapter.indexOf(".command('delete <nodeIds...>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeSetImagePlanningArgvFromRequest\(/);
  assert.match(action, /prepareNodeSetImagePlan\(plan, \{ workspaceIO: io \}\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executePreparedNodeSetImage\(prepared/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|fastEval\(|readImageBase64\(|createImage\(|node\.fills\s*=/);
});

test('node bind delegates one Plan-bound readback-verified Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const start = adapter.indexOf(".command('bind [nodeId] [property] [varName]')");
  const end = adapter.indexOf('// ============ SET (properties, by node id)', start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeBindPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeBindPlan\(plan/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|setBoundVariable\(|setBoundVariableForPaint\(/);
});

test('node group delegates one Plan-bound rollback-owned Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const start = adapter.indexOf(".command('group <nodeIds...>')");
  const end = adapter.indexOf(".command('ungroup <nodeId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /nodeGroupPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /executeNodeGroupPlan\(plan/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|figma\.group\(/);
});

test('node ungroup delegates one Plan-bound hierarchy-verified Command Application', () => {
  const adapter = sources.get('node-ops.js'); const start = adapter.indexOf(".command('ungroup <nodeId>')"); const end = adapter.indexOf(".command('boolean <operation> <nodeIds...>')", start); const action = adapter.slice(start, end);
  assert.match(action, /nodeUngroupPlanningArgvFromRequest\(/); assert.match(action, /executeNodeUngroupPlan\(plan/); assert.match(action, /compatibilityFallback: false/); assert.doesNotMatch(action, /checkConnection\(|fastEval\(|figma\.ungroup\(/);
});
test('node boolean delegates one Plan-bound hierarchy-verified Command Application', () => {
  const adapter = sources.get('node-ops.js');
  const start = adapter.indexOf(".command('boolean <operation> <nodeIds...>')");
  const end = adapter.indexOf(".command('flatten <nodeIds...>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /nodeBooleanPlanningArgvFromRequest\(/);
  assert.match(action, /executeNodeBooleanPlan\(plan/);
  assert.match(action, /compatibilityFallback: false/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|figma\.(?:union|subtract|intersect|exclude)\(/);
});
test('node flatten delegates one Plan-bound irreversible verified Command Application', () => { const adapter = sources.get('node-ops.js'); const start = adapter.indexOf(".command('flatten <nodeIds...>')"); const end = adapter.indexOf(".command('duplicate <nodeId>')", start); const action = adapter.slice(start, end); assert.match(action, /nodeFlattenPlanningArgvFromRequest\(/); assert.match(action, /executeNodeFlattenPlan\(plan/); assert.match(action, /compatibilityFallback: false/); assert.doesNotMatch(action, /checkConnection\(|fastEval\(|figma\.flatten\(/); });

test('node reparent delegates one Plan-bound hierarchy-verified Command Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('reparent <nodeId> <parentId>')");
  const end = adapter.indexOf('async function runNodeMoveCommand', start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeReparentPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeReparentPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|appendChild\(|insertChild\(/,
    'Commander must not retain Node Reparent preflight, mutation, rollback, or formatting');
});

test('node resize delegates one Plan-bound rollback-owned Command Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('resize <nodeId> <width> <height>')");
  const end = adapter.indexOf(".command('rename <nodeId> <name>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeResizePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeResizePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|\.resize\(/,
    'Commander must not retain Node Resize preflight, mutation, rollback, or formatting');
});

test('node rename delegates one Plan-bound rollback-owned Command Application', () => {
  const adapter = sources.get('node-ops.js');
  assert.ok(adapter, 'node-ops.js exists');
  const start = adapter.indexOf(".command('rename <nodeId> <name>')");
  const end = adapter.indexOf('function renderNodeTextRows', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /nodeRenamePlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeNodeRenamePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|node\.name\s*=/,
    'Commander must not retain Node Rename preflight, mutation, rollback, or formatting');
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

test('component combine delegates every raw argument to one verified Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf('async function runComponentCombineCommand');
  const end = adapter.indexOf(".command('add-variant <set> <pairs>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.command\('combine \[args\.\.\.\]'\)/);
  assert.match(action, /componentCombineRequestFromArgv\(argv\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentCombinePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|combineAsVariants|ids\.split/,
    'Commander must not lose positionals or retain Component Combine preflight/mutation logic');
});

test('component add-variant delegates one rollback-owned non-retrying Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const helperStart = adapter.indexOf('async function runComponentAddVariantCommand');
  const helperEnd = adapter.indexOf(".command('instantiate <componentId>')", helperStart);
  const commandStart = adapter.indexOf(".command('add-variant <set> <pairs>')", helperEnd);
  const commandEnd = adapter.indexOf('// ============ ANNOTATIONS', commandStart);
  const action = adapter.slice(helperStart, helperEnd) + adapter.slice(commandStart, commandEnd);

  assert.match(action, /parseComponentSetReferenceRequest\(argv\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentAddVariantPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|addVariantCode|parseVariantPairs|clone\(/,
    'Commander must not retain Component Add Variant resolution, mutation, or formatting');
});

test('component instantiate delegates one rollback-owned non-retrying Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const helperStart = adapter.indexOf('async function runComponentInstantiateCommand');
  const commandStart = adapter.indexOf(".command('instantiate <componentId>')", helperStart);
  const commandEnd = adapter.indexOf(".command('list')", commandStart);
  const action = adapter.slice(helperStart, commandEnd);

  assert.match(action, /componentInstantiatePlanningArgvFromRequest\(request\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentInstantiatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|createInstance\(|getNodeByIdAsync/,
    'Commander must not retain Component Instantiate preflight, mutation, or formatting logic');
});

test('component create delegates one rollback-owned non-retrying Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const helperStart = adapter.indexOf('async function runComponentCreateCommand');
  const commandStart = adapter.indexOf(".command('create [name]')", helperStart);
  const commandEnd = adapter.indexOf('async function runComponentAddVariantCommand', commandStart);
  const action = adapter.slice(helperStart, commandEnd);

  assert.match(action, /componentCreatePlanningArgvFromRequest\(request\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentCreatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /\.option\('-h, --height <n>'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|figma\.createComponent\(/,
    'Commander must not retain Component Create preflight, mutation, or formatting logic');
});

test('component swap delegates one one-shot verified non-retrying Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const helperStart = adapter.indexOf('async function runComponentSwapCommand');
  const commandStart = adapter.indexOf(".command('swap <instanceId> <componentId>')", helperStart);
  const commandEnd = adapter.indexOf(".command('detach <instanceId>')", commandStart);
  const action = adapter.slice(helperStart, commandEnd);

  assert.match(action, /componentSwapPlanningArgvFromRequest\(request\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentSwapPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|swapComponent\(|getNodeByIdAsync/,
    'Commander must not retain Component Swap preflight, mutation, or formatting logic');
});

test('component detach delegates one irreversible verified non-retrying Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('detach <instanceId>')");
  const end = adapter.indexOf(".command('overrides <instanceId> <action>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /componentDetachPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentDetachPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|detachInstance\(|getNodeByIdAsync/,
    'Commander must not retain Component Detach preflight, mutation, or formatting logic');
});

test('component overrides delegates both aliases to one verified non-retrying Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('overrides <instanceId> <action>')");
  const end = adapter.indexOf("const propCmd = componentCmd", start);
  const action = adapter.slice(start, end);

  assert.match(action, /componentOverridesPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentOverridesPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|removeOverrides\(|resetOverrides\(|getNodeByIdAsync/,
    'Commander must not retain Component Overrides preflight, mutation, or formatting logic');
});

test('component list delegates one Plan-bound bounded Component Inventory Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf("componentCmd\n  .command('list')");
  const end = adapter.indexOf("componentCmd\n  .command('main", start);
  const action = adapter.slice(start, end);

  assert.match(action, /componentInventoryPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeComponentInventoryPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|componentInventoryCode\(|projectComponentInventory\(/,
    'Commander must not retain Component Inventory scan, validation, or formatting logic');
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

test('Grid Inspect delegates one Plan-bound bounded safe-read Application', () => {
  const adapter = sources.get('grid-layout.js');
  const start = adapter.indexOf("grid.command('inspect <nodeId>')");
  const end = adapter.indexOf("grid.command('set <nodeId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runGridInspect\(/);
  assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|gridLayoutInspectCode\(/);
  const application = readFileSync(join(APPLICATION_DIR, 'grid-inspect-command.js'), 'utf8');
  assert.match(application, /node\.layoutMode !== 'GRID'/);
  assert.match(application, /Grid Inspect result exceeded its bounded response limit/);
  assert.match(application, /getNodeByIdAsync\(request\.nodeId\)/);
});

test('the remaining direct Auto Layout Grid Read inventory is explicit', () => {
  const adapter = sources.get('grid-layout.js');
  const start = adapter.indexOf("grid.command('inspect <nodeId>')");
  const end = adapter.indexOf("grid.command('set <nodeId>')", start);
  const action = adapter.slice(start, end);
  const direct = /\brun\(|checkConnection\(\)|fastEval\(/.test(action) ? ['inspect'] : [];
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-06 Auto Layout Grid Legacy Read count may decrease, but must never increase silently');
});

test('Grid Set delegates one Plan-bound journaled Application', () => {
  const adapter = sources.get('grid-layout.js');
  const start = adapter.indexOf("grid.command('set <nodeId>')");
  const end = adapter.indexOf("grid.command('place <gridId> <childId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runGridSet\(/);
  assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|gridLayoutSetCode\(/);
  const application = readFileSync(join(APPLICATION_DIR, 'grid-set-command.js'), 'utf8');
  assert.match(application, /node\.gridRowCount = desiredRows/);
  assert.match(application, /Fresh Grid Set postcondition failed/);
  assert.match(application, /getNodeByIdAsync\(request\.nodeId\)/);
});

test('Grid Auto Flow delegates one Plan-bound rollback-owned Application', () => {
  const adapter = sources.get('grid-layout.js');
  const start = adapter.indexOf("grid.command('auto-flow <nodeId>')");
  const end = adapter.indexOf("grid.command('reorder-rows <nodeId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runGridAutoFlow\(/);
  assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|gridLayoutAutoFlowCode\(/);
  const application = readFileSync(join(APPLICATION_DIR, 'grid-auto-flow-command.js'), 'utf8');
  assert.match(application, /node\.gridAutoTracks = desired\.autoTracks/);
  assert.match(application, /node\.gridItemsPositioning = desired\.positioning/);
  assert.match(application, /getNodeByIdAsync\(request\.nodeId\)/);
});

test('Grid Place delegates one Plan-bound hierarchy-verified Application', () => {
  const adapter = sources.get('grid-layout.js');
  const start = adapter.indexOf("grid.command('place <gridId> <childId>')");
  const end = adapter.indexOf("grid.command('auto-flow <nodeId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runGridPlace\(/);
  assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|gridLayoutPlaceCode\(/);
  const application = readFileSync(join(APPLICATION_DIR, 'grid-place-command.js'), 'utf8');
  assert.match(application, /grid\.appendChildAt\(child, request\.row, request\.column\)/);
  assert.match(application, /rollbackSource\.insertChild\(before\.index, rollbackChild\)/);
  assert.match(application, /getNodeByIdAsync\(request\.childId\)/);
});

test('Grid Track Reorder delegates one Plan-bound irreversible Application', () => {
  const adapter = sources.get('grid-layout.js');
  for (const [name, next] of [['reorder-rows', 'reorder-columns'], ['reorder-columns', null]]) {
    const start = adapter.indexOf(`grid.command('${name} <nodeId>')`);
    const end = next ? adapter.indexOf(`grid.command('${next} <nodeId>')`, start) : adapter.length;
    const action = adapter.slice(start, end);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runGridTrackReorder\(/);
    assert.doesNotMatch(action, /\brun\(|checkConnection\(|fastEval\(|gridLayoutReorderCode\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'grid-track-reorder-command.js'), 'utf8');
  assert.match(application, /moves = grid\[method\]\(\{ fromIndices:/);
  assert.match(application, /Fresh Grid track postcondition/);
  assert.match(application, /getNodeByIdAsync\(request\.nodeId\)/);
  assert.doesNotMatch(application, /grid\[method\]\([^)]*\).*grid\[method\]\(/s);
});

test('the remaining direct Auto Layout Grid write inventory is explicit', () => {
  const adapter = sources.get('grid-layout.js'); const direct = [];
  for (const name of ['set', 'place', 'auto-flow', 'reorder-rows', 'reorder-columns']) {
    const marker = `grid.command('${name} <`;
    const start = adapter.indexOf(marker);
    const end = adapter.indexOf('grid.command(', start + marker.length);
    const action = adapter.slice(start, end === -1 ? adapter.length : end);
    if (/\brun\(|checkConnection\(\)|fastEval\(/.test(action)) direct.push(name);
  }
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-26 Auto Layout Grid Legacy Write count may decrease, but must never increase silently');
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

test('grid set and clear delegate one Plan-bound rollback-owned Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const grid = adapter.indexOf(".command('grid')");
  const setStart = adapter.indexOf(".command('set <nodeId>')", grid);
  const listStart = adapter.indexOf(".command('list [nodeId]')", setStart);
  const clearStart = adapter.indexOf(".command('clear <nodeId>')", listStart);
  const componentStart = adapter.indexOf(".command('component')", clearStart);
  for (const action of [
    adapter.slice(setStart, listStart),
    adapter.slice(clearStart, componentStart),
  ]) {
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /planFigmaCommand\(layoutGuideMutationPlanningArgvFromRequest\(/);
    assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
    assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
    assert.match(action, /executeLayoutGuideMutationPlan\(plan/);
    assert.match(action, /daemonExec\('eval'/);
    assert.match(action, /process\.exitCode = 1/);
    assert.doesNotMatch(action, /checkConnection\(|n\.layoutGrids|handleEvalError\(/,
      'Commander must not retain Layout Guide mutation or rollback logic');
  }
});

test('dev list delegates one Plan-bound bounded-read Command Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const dev = adapter.indexOf(".command('dev')");
  const start = adapter.indexOf(".command('list [nodeId]')", dev);
  const end = adapter.indexOf(".command('unlink <nodeId> <url>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(devResourceReadPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeDevResourceReadPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|figma\.currentPage\.selection|getDevResourcesAsync/,
    'Commander must not retain Dev Resource readiness, capture, or formatting logic');
});

test('dev link, unlink, and edit delegate one rollback-owned mutation Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf('async function runDevResourceMutationCommand');
  const end = adapter.indexOf('// ============ SECTIONS ============', start);
  const slice = adapter.slice(start, end);

  assert.equal((slice.match(/\.allowExcessArguments\(false\)/g) || []).length, 4);
  assert.match(slice, /planFigmaCommand\(devResourceMutationPlanningArgvFromRequest\(request\)/);
  assert.match(slice, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(slice, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(slice, /executeDevResourceMutationPlan\(plan/);
  assert.match(slice, /daemonExec\('eval'/);
  assert.match(slice, /process\.exitCode = 1/);
  assert.doesNotMatch(slice,
    /checkConnection\(|addDevResourceAsync|deleteDevResourceAsync|editDevResourceAsync|getDevResourcesAsync/,
    'Commander must not retain Dev Resource preflight, mutation, verification, or rollback logic');
});

test('section list delegates one Plan-bound bounded current-page Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const section = adapter.indexOf(".command('section')");
  const start = adapter.indexOf(".command('list')", section);
  const end = adapter.indexOf(".command('add <sectionId> <nodeIds>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(sectionInventoryArgvFromRequest\(\{\}\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeSectionInventoryPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|figma\.currentPage|findAll\(/,
    'Commander must not retain Section Inventory readiness, capture, or formatting logic');
});

test('section fit delegates geometry, readback, and rollback to one Plan-bound Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const section = adapter.indexOf(".command('section')");
  const start = adapter.indexOf(".command('fit <sectionId>')", section);
  const end = adapter.indexOf(".command('arrange <sectionId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /sectionFitPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeSectionFitPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|sectionFitSnippet\(|resizeWithoutConstraints|\.children/,
    'Commander must not retain Section Fit preflight, geometry, verification, or rollback');
});

test('section arrange delegates sorting, geometry, readback, and rollback to one Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const section = adapter.indexOf(".command('section')");
  const start = adapter.indexOf(".command('arrange <sectionId>')", section);
  const end = adapter.indexOf(".command('list')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /sectionArrangePlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeSectionArrangePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|localeCompare|resizeWithoutConstraints|\.children/,
    'Commander must not retain Section Arrange sorting, geometry, verification, or rollback');
});

test('section add delegates batch preflight, position preservation, and rollback to one Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const section = adapter.indexOf(".command('section')");
  const start = adapter.indexOf(".command('add <sectionId> <nodeIds>')", section);
  const end = adapter.indexOf('// ============ LAYOUT GUIDES', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /sectionAddPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeSectionAddPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|absoluteBoundingBox|appendChild|getNodeByIdAsync/,
    'Commander must not retain Section Add preflight, mutation, verification, or rollback');
});

test('section create delegates creation, fitting, readback, and deletion rollback to one Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const section = adapter.indexOf(".command('section')");
  const start = adapter.indexOf(".command('create <name> [nodeIds]')", section);
  const end = adapter.indexOf(".command('fit <sectionId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /sectionCreatePlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeSectionCreatePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|createSection|sectionFitSnippet|resizeWithoutConstraints|appendChild/,
    'Commander must not retain Section Create preflight, geometry, verification, or rollback');
});

test('annotate categories delegates one Plan-bound bounded file inventory Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf("annotateCmd.command('categories')");
  const end = adapter.indexOf("annotateCmd.command('category-add <label>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /planFigmaCommand\(annotationCategoryInventoryArgvFromRequest\(\{\}\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationCategoryInventoryPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|annotationCategoriesCode|getAnnotationCategoriesAsync/,
    'Commander must not retain Annotation Category readiness, capture, or formatting logic');
});

test('annotate remove delegates one Plan-bound index-exact rollback Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf("annotateCmd.command('remove <nodeId> <index>')");
  const end = adapter.indexOf("annotateCmd.command('categories')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /annotationRemovePlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationRemovePlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|annotationRemoveCode|\.annotations\s*=/,
    'Commander must not retain Annotation Remove preflight, mutation, rollback, or formatting');
});

test('annotate edit delegates one Plan-bound patch-exact rollback Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf("annotateCmd.command('edit <nodeId> <index>')");
  const end = adapter.indexOf("annotateCmd.command('remove <nodeId> <index>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /annotationEditPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationEditPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|annotationEditCode|\.annotations\s*=/,
    'Commander must not retain Annotation Edit resolution, mutation, rollback, or formatting');
});

test('annotation category writes delegate one discriminated Plan-bound mutation Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf('async function runAnnotationCategoryMutationCommand');
  const end = adapter.indexOf(".command('list [nodeId]')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /annotationCategoryMutationArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationCategoryMutationPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /category-add <label>/);
  assert.match(action, /category-edit <category>/);
  assert.match(action, /category-remove <category>/);
  assert.equal((action.match(/\.allowExcessArguments\(false\)/g) || []).length, 3);
  assert.doesNotMatch(action,
    /checkConnection\(|annotationCategory(?:Create|Edit|Remove)Code|getAnnotationCategoriesAsync/,
    'Commander must not retain Category resolution, mutation, rollback, or formatting');
});

test('annotate add delegates single-node and query journals to one Plan-bound Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('add')", adapter.indexOf('const annotateCmd'));
  const end = adapter.indexOf("annotateCmd.command('edit <nodeId> <index>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /annotationAddPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationAddPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action,
    /checkConnection\(|annotationAddCode|figma\.currentPage|findAll\(|\.annotations\s*=/,
    'Commander must not retain Annotation Add selection, preflight, journal, or formatting');
});

test('the remaining direct Annotation command inventory is empty', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf('// ============ ANNOTATIONS ============');
  const end = adapter.indexOf('// ============ PLUGINS ============', start);
  const annotationAdapter = adapter.slice(start, end);
  assert.doesNotMatch(annotationAdapter, /\.\.\/lib\/annotation-management\.js/);
  assert.doesNotMatch(annotationAdapter,
    /annotation(?:Add|Edit|Remove|Categories|CategoryCreate|CategoryEdit|CategoryRemove)Code/);
  assert.doesNotMatch(annotationAdapter, /checkConnection\(/);
});

test('annotate list delegates one Plan-bound bounded node-or-selection read Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('list [nodeId]')", adapter.indexOf('const annotateCmd'));
  const end = adapter.indexOf(".command('clear <nodeId>')", start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /annotationReadPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationReadPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|figma\.currentPage|\.annotations|labelMarkdown/,
    'Commander must not retain Annotation Read readiness, capture, or formatting logic');
});

test('annotate clear delegates one Plan-bound rollback-verified mutation Application', () => {
  const adapter = sources.get('misc.js');
  assert.ok(adapter, 'misc.js exists');
  const start = adapter.indexOf(".command('clear <nodeId>')", adapter.indexOf('const annotateCmd'));
  const end = adapter.indexOf('// ============ PLUGINS ============', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /annotationClearPlanningArgvFromRequest/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeAnnotationClearPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|figma\.getNodeByIdAsync|\.annotations\s*=/,
    'Commander must not retain Annotation Clear readiness, preflight, mutation, or formatting');
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

test('top-level pin delegates one Plan-bound preflighted rollback-owned Application', () => {
  const adapter = sources.get('canvas-ops.js');
  assert.ok(adapter, 'canvas-ops.js exists');
  const start = adapter.indexOf(".command('pin <edge>')");
  const end = adapter.indexOf('// (`unwrap` and `use`/`theme` were removed', start);
  const action = adapter.slice(start, end);

  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /pinPlanningArgvFromRequest\(/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executePinPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.doesNotMatch(action,
    /checkConnection\(|buildNodeSelector\(|function pinOne|\.resize\(|\.constraints\s*=/,
    'Commander must not retain Pin selection, preflight, mutation, rollback, or formatting');
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
  const listStart = adapter.indexOf(".command('list [args...]')");
  const listEnd = adapter.indexOf(".command('create <name>')", listStart);
  const findStart = adapter.indexOf(".command('find [args...]')");
  const findEnd = adapter.indexOf("variables.command('show <variable>')", findStart);
  const action = adapter.slice(helperStart, listStart)
    + adapter.slice(listStart, listEnd) + adapter.slice(findStart, findEnd);

  assert.match(action, /variableDiscoveryRequestFromArgv\(argv\)/);
  assert.match(action, /planFigmaCommand\(argv/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableDiscoveryPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.equal((action.match(/\.allowUnknownOption\(true\)/g) || []).length, 2);
  assert.doesNotMatch(action, /checkConnection\(|listVariables\(|findVariables\(|fastEval\(/,
    'Commander must not retain Variable Discovery readiness, matching, or formatting logic');
});

test('var discovery CLI distinguishes unsupported options and malformed values without payload echo', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  const cases = [
    {
      args: ['variables', 'list', '--collection', 'private-payload'],
      pattern: /var list does not support --collection.*\["col","list"\]/,
    },
    {
      args: ['var', 'list', '--future', 'private-payload'],
      pattern: /Unsupported option --future for var list/,
    },
    {
      args: ['var', 'list', '--limit', '0'],
      pattern: /Malformed value for var list: limit must be an integer between 1 and 1000/,
    },
  ];
  for (const { args, pattern } of cases) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, pattern, args.join(' '));
    assert.doesNotMatch(result.stderr, /private-payload/, args.join(' '));
    assert.doesNotMatch(result.stderr, /Plugin not connected|figma_connect/, args.join(' '));
  }
});

test('var create delegates one Plan-bound journaled non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables\n  .command('create <name>')");
  const end = adapter.indexOf("variables\n  .command('find [args...]')", start);
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
  const end = adapter.indexOf("variables.command('set-value-batch <json>')", start);
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

test('var set-value-batch delegates one Plan-bound best-effort rollback Application', () => {
  const adapter = sources.get('variables.js');
  const start = adapter.indexOf("variables.command('set-value-batch <json>')");
  const end = adapter.indexOf("variables.command('code-syntax <variable> <platform> [value]')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableSetValueBatchPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableSetValueBatchPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableSetValueBatchCommandCode\(/,
    'Commander must not retain Variable Set Value Batch execution or rollback logic');
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

test('var update-batch delegates one Plan-bound reverse-rollback non-retrying Application', () => {
  const adapter = sources.get('variables.js');
  assert.ok(adapter, 'variables.js exists');
  const start = adapter.indexOf("variables.command('update-batch <json>')");
  const end = adapter.indexOf("variables.command('set-value <variable> [value]')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /variableUpdateBatchPlanningArgvFromRequest/);
  assert.match(action, /\.allowExcessArguments\(false\)/);
  assert.match(action, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(action, /await ensurePluginReadiness\(\{ deadline/);
  assert.match(action, /executeVariableUpdateBatchPlan\(plan/);
  assert.match(action, /daemonExec\('eval'/);
  assert.match(action, /process\.exitCode = 1/);
  assert.doesNotMatch(action, /checkConnection\(|fastEval\(|variableUpdateBatchCommandCode\(/,
    'Commander must not retain Variable Metadata Update Batch execution or formatting logic');
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
  assert.match(action, /daemonTypedRead\(/); assert.match(action, /process\.exitCode = 1/);
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

test('component spec delegates repository preparation and optional Figma read to one Application', () => {
  const adapter = sources.get('spec.js');
  assert.ok(adapter, 'spec.js exists');
  assert.match(adapter, /\.allowExcessArguments\(false\)/);
  assert.match(adapter, /planFigmaCommand\(componentSpecPlanningArgvFromRequest\(/);
  assert.match(adapter, /prepareComponentSpecPlan\(plan/);
  assert.match(adapter, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(adapter, /if \(plan\.target\.kind !== 'none'\)/);
  assert.match(adapter, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(adapter, /executeComponentSpecPlan\(plan/);
  assert.match(adapter, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(adapter,
    /checkConnection\(|fastEval\(|findComponentSpec\(|checkConformance\(|function measureCode/,
    'Commander must not retain Component Spec preparation, readiness, measurement, or formatting logic');
});

test('map storybook delegates source preparation, bounded inventory, and publication to one Application', () => {
  const adapter = sources.get('map.js');
  assert.ok(adapter, 'map.js exists');
  assert.match(adapter, /\.allowExcessArguments\(false\)/);
  assert.match(adapter, /planFigmaCommand\(storybookMapPlanningArgvFromRequest\(/);
  assert.match(adapter, /prepareStorybookMapPlan\(plan/);
  assert.match(adapter, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(adapter, /ensurePluginReadiness\(\{[\s\S]*deadline,[\s\S]*fileKey,[\s\S]*expectedEditor/);
  assert.match(adapter, /executeStorybookMapPlan\(plan/);
  assert.match(adapter, /Math\.max\(1, deadline - Date\.now\(\)\)/);
  assert.doesNotMatch(adapter,
    /checkConnection\(|fetchStorybookIndex\(|componentInventoryCode\(|matchComponents\(|mergeMaps\(|workspaceIO\(\)\.write/,
    'Commander must not retain Storybook source, Figma inventory, matching, or publication logic');
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

test('legacy PNG export names delegate to the Plan-bound Screenshot Application', () => {
  const adapter = sources.get('export-eval.js');
  assert.ok(adapter, 'export-eval.js exists');
  const start = adapter.indexOf(".command('screenshot')");
  const end = adapter.indexOf(".command('video <nodeId>')", start);
  const action = adapter.slice(start, end);
  assert.match(action, /runPngExportCompatibilityCommand/);
  assert.match(action, /format === 'PNG'/);
  assert.match(adapter, /executeScreenshotPlan\(plan,/);
  assert.match(adapter, /compatibilityFallback: false/);
  assert.doesNotMatch(action, /format: 'PNG'.*exportAsync/s);
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

test('semantic JSX prop reference is bounded, offline and element-specific', () => {
  const entry = join(COMMANDS_DIR, '..', 'index.js');
  const result = spawnSync(process.execPath, [
    entry, 'render', '--prop-reference', 'Text', '--icons', '/outside-workspace',
    '--dom-capture', '/also-unused',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Semantic JSX props for <Text>/);
  assert.match(result.stdout, /fill → color/);
  assert.doesNotMatch(result.stdout, /backgroundColor → bg/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`,
    /Plugin not connected|figma_connect|Icon directory not found|Could not read DOM capture/);
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

test('token export delegates one Plan-bound exact Command Application', () => {
  const adapter = sources.get('export-eval.js');
  const application = readFileSync(join(COMMANDS_DIR, '..', 'application', 'token-export-command.js'), 'utf8');
  assert.match(adapter, /tokenExportPlanningArgvFromRequest/);
  assert.match(adapter, /executeTokenExportPlan\(/);
  assert.match(adapter, /daemonExecWithMetadata\(/);
  const start = adapter.indexOf("async function runTokenExportCommand");
  const end = adapter.indexOf('// NOTE: there is deliberately NO `export tailwind`', start);
  const actions = adapter.slice(start, end) + adapter.slice(adapter.indexOf(".command('dtcg"), adapter.indexOf(".command('code-spec"));
  assert.doesNotMatch(actions, /checkConnection\(|usedVariablesCode\(|projectVariableModes\(|formatCssTokens\(|buildDtcgTree\(/,
    'Commander must not retain Token Export readiness, capture, projection, or formatting');
  assert.match(application, /projectVariableModes\(/);
  assert.doesNotMatch(application, /Object\.values\([^\n]*valuesByMode/,
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

test('font bind and unbind delegate one readback-verified rollback-owned Application', () => {
  const adapter = sources.get('font.js');
  const start = adapter.indexOf(".command('bind <nodeId> <field> <variable>')");
  const end = adapter.indexOf(".command('inspect <nodeId>')", start);
  const slice = adapter.slice(start, end);
  assert.match(slice, /\.allowExcessArguments\(false\)/);
  assert.match(slice, /fontVariableBindingPlanningArgvFromRequest/);
  assert.match(slice, /runInProcessCommandPlan\(plan, \{ compatibilityFallback: false \}/);
  assert.match(slice, /executeFontVariableBindingPlan/);
  assert.match(slice, /daemonExec\('eval'/);
  assert.doesNotMatch(slice, /fontVariableBindingCode\(|fastEval\(|checkConnection\(/,
    'Commander must not retain an unverified legacy binding path');
});

test('font axis metadata delegates reads and writes to one bounded Application', () => {
  const adapter = sources.get('font.js');
  const start = adapter.indexOf(".command('axes <nodeId>')");
  const slice = adapter.slice(start);
  for (const command of ['axes <nodeId>', 'remember-axes <nodeId> <axes>', 'forget-axes <nodeId>']) {
    const commandStart = slice.indexOf(`.command('${command}')`);
    const commandEnd = slice.indexOf(".command('", commandStart + command.length);
    const action = slice.slice(commandStart, commandEnd === -1 ? slice.length : commandEnd);
    assert.match(action, /\.allowExcessArguments\(false\)/);
    assert.match(action, /runFontAxisMetadata\(/);
    assert.doesNotMatch(action, /checkConnection\(|fastEval\(|fontAxesCode\(|rememberAxesCode\(|forgetAxesCode\(/);
  }
  const application = readFileSync(join(APPLICATION_DIR, 'font-axis-metadata-command.js'), 'utf8');
  assert.match(application, /node\.setPluginData\(metadataKey, desiredRaw\)/);
  assert.match(application, /fresh\.getPluginData\(metadataKey\) === desiredRaw/);
  assert.match(application, /node\.setPluginData\(metadataKey, beforeRaw\)/);
  assert.match(application, /appliedToFont: false/);
});

test('the remaining direct Font Axis Metadata inventory is explicit', () => {
  const adapter = sources.get('font.js');
  const start = adapter.indexOf(".command('axes <nodeId>')");
  const direct = /checkConnection\(\)|fastEval\(/.test(adapter.slice(start))
    ? ['axes-metadata'] : [];
  assert.deepEqual(direct, []);
  assert.equal(direct.length, 0,
    'STAB-06 Font Axis Metadata Legacy Action count may decrease, but must never increase silently');
});

test('library code lives in lib/, not in command files', () => {
  // commands/map.js used to import componentInventoryCode from commands/misc.js.
  for (const [file, src] of sources) {
    const badImports = [...src.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => m[1]);
    assert.deepEqual(badImports, [], `${file} imports from a sibling command file`);
  }
});

test('component prop set delegates while its Application keeps a validated local INSTANCE_SWAP id', () => {
  const src = sources.get('misc.js');
  const start = src.indexOf(".command('set <instanceId> <name> <value>')");
  const end = src.indexOf(".command('delete <componentId> <propName>')", start);
  const propSet = src.slice(start, end);
  assert.match(propSet, /runComponentPropertySetCommand/);
  assert.doesNotMatch(propSet, /setProperties\(|getMainComponentAsync/,
    'Commander must not retain Component Property Set resolution or mutation logic');
  const application = readFileSync(join(APPLICATION_DIR, 'component-property-set-command.js'), 'utf8');
  assert.match(application, /parsed = component\.id;/,
    'Figma setProperties expects a local component node id for INSTANCE_SWAP');
  assert.doesNotMatch(application, /parsed = component\.key;/,
    'a publish key is not a valid local INSTANCE_SWAP property value');
});

test('component prop add delegates one rollback-owned non-retrying Application', () => {
  const src = sources.get('misc.js');
  const start = src.indexOf(".command('add <componentId> <name> <type> <defaultValue>')");
  const end = src.indexOf(".command('list [componentId]')", start);
  const propAdd = src.slice(start, end);
  assert.match(propAdd, /runComponentPropertyAddCommand/);
  assert.match(propAdd, /process\.exitCode = 1/);
  assert.doesNotMatch(propAdd, /addComponentProperty\(|daemonExec\(|checkConnection\(/,
    'Commander must not retain Component Property Add readiness or mutation logic');
});

test('component prop list delegates one bounded safe-read Application', () => {
  const src = sources.get('misc.js');
  const start = src.indexOf(".command('list [componentId]')");
  const end = src.indexOf(".command('set <instanceId> <name> <value>')", start);
  const propList = src.slice(start, end);
  assert.match(propList, /runComponentPropertyListCommand/);
  assert.match(propList, /process\.exitCode = 1/);
  assert.doesNotMatch(propList, /componentPropertyDefinitions|daemonExec\(|checkConnection\(/,
    'Commander must not retain Component Property List readiness or capture logic');
});

test('component prop delete delegates one exact irreversible non-retrying Application', () => {
  const src = sources.get('misc.js');
  const start = src.indexOf(".command('delete <componentId> <propName>')");
  const end = src.indexOf('async function runComponentCombineCommand', start);
  const propDelete = src.slice(start, end);
  assert.match(propDelete, /runComponentPropertyDeleteCommand/);
  assert.match(propDelete, /process\.exitCode = 1/);
  assert.doesNotMatch(propDelete, /deleteComponentProperty\(|daemonExec\(|checkConnection\(/,
    'Commander must not retain Component Property Delete readiness or mutation logic');
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
  const bindStart = nodes.indexOf(".command('bind [nodeId] [property] [varName]')");
  const bindEnd = nodes.indexOf('// ============ SET (properties, by node id)', bindStart);
  const bind = nodes.slice(bindStart, bindEnd);
  assert.ok(bind.indexOf('if (options.batch)') < bind.indexOf('planFigmaCommand('));
  assert.match(bind, /process\.exitCode = 1/);
  assert.doesNotMatch(bind, /checkConnection\(|fastEval\(/);

  const setStart = nodes.indexOf(".command('set [nodeId]')");
  const set = nodes.slice(setStart);
  assert.ok(set.indexOf('if (options.batch)') < set.indexOf('planFigmaCommand('));
  assert.match(set, /process\.exitCode = 1/);
  assert.doesNotMatch(set, /checkConnection\(|fastEval\(/);
});
