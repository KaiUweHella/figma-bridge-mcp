import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  analysisLintCode,
  analysisLintPlanRoute,
  executeAnalysisLint,
  executeAnalysisLintPlan,
  MAX_ANALYSIS_LINT_ISSUES,
  MAX_ANALYSIS_LINT_NODES,
} from '../src/application/analysis-lint-command.js';
import {
  acceptsAnalysisLintArgv,
  analysisLintArgvFromRequest,
  analysisLintFigmaUrlFileKeyFromArgv,
  analysisLintPlanningArgvFromRequest,
  parseAnalysisLintRequest,
} from '../src/application/analysis-lint-request.js';

const red = { r: 1, g: 0, b: 0 };
const green = { r: 0, g: 1, b: 0 };

function fixture() {
  const root = {
    id: '1:1', name: 'Frame 12', type: 'FRAME',
    fills: [{ type: 'SOLID', color: red }],
    children: [
      {
        id: '1:2', name: 'Label', type: 'TEXT', fills: [],
        textStyleId: '', fontSize: 10,
      },
      {
        id: '1:3', name: 'Surface', type: 'RECTANGLE',
        fills: [{ type: 'SOLID', color: green }],
      },
      {
        id: '1:4', name: 'Bound surface', type: 'RECTANGLE',
        fills: [{
          type: 'SOLID', color: red,
          boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
        }],
      },
    ],
  };
  const byId = new Map([root, ...root.children].map((node) => [node.id, node]));
  return {
    currentPage: { children: [root] },
    getNodeByIdAsync: async (id) => byId.get(id) || null,
    variables: {
      getLocalVariableCollectionsAsync: async () => [{
        id: 'VariableCollectionId:1', name: 'Primitives',
      }],
      getLocalVariablesAsync: async () => [{
        id: 'VariableID:1', name: 'color/red', resolvedType: 'COLOR',
        variableCollectionId: 'VariableCollectionId:1',
        valuesByMode: {
          '1:0': red,
          '1:1': { type: 'VARIABLE_ALIAS', id: 'VariableID:2' },
        },
      }],
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Analyze lint closes flags, URL identity, kinds, limits, and excess arguments', () => {
  const url = 'https://www.figma.com/design/FILE123/Bridge?node-id=1-2';
  const parsed = parseAnalysisLintRequest([
    'analyze', 'lint', `--node=${url}`, '--kind=typography,bindable', '--limit=20',
    '--json', '--fail-on-issues',
  ]);
  assert.deepEqual({ ...parsed, warning: '' }, {
    nodeId: '1:2', kinds: ['typography', 'bindable'], limit: 20,
    json: true, failOnIssues: true, warning: '',
  });
  assert.match(parsed.warning, /id taken from a URL for Figma file FILE123/);
  assert.equal(analysisLintFigmaUrlFileKeyFromArgv([
    'analyze', 'lint', '-n', url,
  ]), 'FILE123');
  assert.deepEqual(analysisLintArgvFromRequest({
    nodeId: url, kinds: ['naming'], limit: 2, failOnIssues: true,
  }), ['analyze', 'lint', '--node=1:2', '--kind=naming', '--limit=2', '--fail-on-issues']);
  assert.deepEqual(analysisLintPlanningArgvFromRequest({ nodeId: url }), [
    'analyze', 'lint', `--node=${url}`,
  ]);
  for (const argv of [
    ['analyze', 'lint', '--future'],
    ['analyze', 'lint', '--kind=unknown'],
    ['analyze', 'lint', '--kind=naming,naming'],
    ['analyze', 'lint', '--limit=0'],
    ['analyze', 'lint', '--limit=4097'],
    ['analyze', 'lint', '--json', '--json'],
    ['analyze', 'lint', 'private-value'],
    ['analyze', 'lint', '--', '--json'],
  ]) assert.equal(acceptsAnalysisLintArgv(argv), false, argv.join(' '));
});

test('page-wide lint preserves actionable legacy findings and runnable fixes', async () => {
  const output = await executeAnalysisLint({}, { evaluate: evaluate(fixture()) });
  assert.equal(output.code, 0);
  assert.deepEqual(output.result, {
    schemaVersion: 1,
    source: 'current-page',
    nodeId: null,
    nodesWalked: 4,
    total: 4,
    counts: { naming: 1, bindable: 1, typography: 1, legibility: 1 },
    issues: [
      {
        kind: 'naming', id: '1:1', name: 'Frame 12', type: 'FRAME',
        detail: 'still carries its default layer name',
      },
      {
        kind: 'bindable', id: '1:1', name: 'Frame 12', type: 'FRAME',
        detail: 'fill is #ff0000, which is color/red',
        fix: 'node bind 1:1 fill "color/red" --collection "Primitives"',
      },
      {
        kind: 'typography', id: '1:2', name: 'Label', type: 'TEXT',
        detail: 'no text style — its typography is loose',
      },
      {
        kind: 'legibility', id: '1:2', name: 'Label', type: 'TEXT',
        detail: '10px is below the 12px readability floor',
      },
    ],
  });
  assert.match(output.stdout, /4 finding\(s\) across 4 node\(s\)/);
  assert.match(output.stdout, /fix: node bind 1:1 fill "color\/red" --collection "Primitives"/);
  assert.doesNotMatch(output.stdout, /Surface.*fill/,
    'literal colours without an exact local Variable remain non-actionable');
});

test('kind filtering, JSON, limits, and fail-on-issues retain their separate semantics', async () => {
  const filtered = await executeAnalysisLint({
    kinds: ['typography'], json: true, failOnIssues: true,
  }, { evaluate: evaluate(fixture()) });
  assert.equal(filtered.code, 1);
  const json = JSON.parse(filtered.stdout);
  assert.equal(json.total, 4, 'total continues to describe the complete scan');
  assert.deepEqual(json.counts, {
    naming: 1, bindable: 1, typography: 1, legibility: 1,
  });
  assert.deepEqual(json.issues.map((issue) => issue.kind), ['typography']);
  assert.deepEqual(filtered.result.issues.map((issue) => issue.kind), ['typography']);

  const none = await executeAnalysisLint({
    kinds: ['bindable'], failOnIssues: true,
  }, { evaluate: async () => JSON.stringify({
    schemaVersion: 1, source: 'current-page', nodeId: null,
    nodesWalked: 1, total: 1, counts: { naming: 1 },
    issues: [{
      kind: 'naming', id: '1:1', name: 'Frame', type: 'FRAME',
      detail: 'still carries its default layer name',
    }],
  }) });
  assert.equal(none.code, 0, 'only selected findings control the CI outcome');
  assert.equal(none.stdout, '✓ Nothing to fix across 1 node(s).');
});

test('explicit node reads and page reads share one bounded implementation', async () => {
  const page = await executeAnalysisLint({}, { evaluate: evaluate(fixture()) });
  const node = await executeAnalysisLint({ nodeId: '1:1' }, { evaluate: evaluate(fixture()) });
  assert.equal(node.result.source, 'node');
  assert.equal(node.result.nodeId, '1:1');
  assert.equal(node.result.total, page.result.total);
  await assert.rejects(() => executeAnalysisLint({ nodeId: '9:9' }, {
    evaluate: evaluate(fixture()),
  }), /Node not found/);
});

test('node, issue, and serialized-result boundaries fail instead of truncating facts', async () => {
  const excessiveRoots = fixture();
  excessiveRoots.currentPage.children = Array(MAX_ANALYSIS_LINT_NODES + 1).fill({
    id: '1:1', name: 'Card', type: 'FRAME', children: [],
  });
  await assert.rejects(() => executeAnalysisLint({}, {
    evaluate: evaluate(excessiveRoots),
  }), /node limit/);

  const issueNodes = Array.from({ length: MAX_ANALYSIS_LINT_ISSUES + 1 }, (_, index) => ({
    id: `2:${index + 1}`, name: 'Frame', type: 'FRAME', children: [],
  }));
  const excessiveIssues = fixture();
  excessiveIssues.currentPage.children = issueNodes;
  await assert.rejects(() => executeAnalysisLint({}, {
    evaluate: evaluate(excessiveIssues),
  }), /issue limit/);
});

test('forged or malformed Plugin results cannot become lint facts', async () => {
  const serialized = await evaluate(fixture())(analysisLintCode({}));
  const payload = JSON.parse(serialized);
  for (const value of [
    null,
    '{',
    JSON.stringify({ ...payload, total: payload.total + 1 }),
    JSON.stringify({ ...payload, counts: { naming: 4 } }),
    JSON.stringify({ ...payload, futureField: 'private' }),
    JSON.stringify({ ...payload, issues: [{ ...payload.issues[0], futureField: true }] }),
  ]) {
    await assert.rejects(() => executeAnalysisLint({}, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('CLI and MCP plans share targeting, editor effects, retry, and diagnostic exit policy', async () => {
  const url = 'https://www.figma.com/design/FILE123/Bridge?node-id=1-1';
  const cli = planFigmaCommand([
    'analyze', 'lint', '--node', url, '--kind', 'bindable', '--fail-on-issues',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'analyze', 'lint', `--node=${url}`, '--kind=bindable', '--fail-on-issues',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.target, mcp.target);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.deepEqual(cli.execution.okExitCodes, [0, 1]);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.effects.figma, 'read');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.target.fileKey, 'FILE123');
  assert.equal(cli.audit.capability, 'analyze.lint');
  assert.equal(analysisLintPlanRoute(cli), 'command-application');

  const page = planFigmaCommand(['analyze', 'lint'], { adapter: 'mcp' });
  assert.equal(page.effects.editor, 'read');
  assert.deepEqual(page.execution.okExitCodes, [0]);
  let evaluations = 0;
  const result = await executeAnalysisLintPlan(page, {
    evaluate: async (code) => {
      evaluations += 1;
      return evaluate(fixture())(code);
    },
  });
  assert.equal(result.result.total, 4);
  assert.equal(evaluations, 1);
  assert.throws(() => analysisLintPlanRoute({ ...page }), /requires a Command Plan/);
  assert.equal(analysisLintPlanRoute(
    planFigmaCommand(['analyze', 'colors'], { adapter: 'mcp' }),
  ), 'not-analysis-lint');
});

test('Analyze lint generated Plugin code parses for node and current-page reads', () => {
  assert.doesNotThrow(() => new Function(`return ${analysisLintCode({})}`));
  assert.doesNotThrow(() => new Function(`return ${analysisLintCode({ nodeId: '1:1' })}`));
});
