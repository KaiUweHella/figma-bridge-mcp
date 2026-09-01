import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  analysisCensusCode,
  analysisCensusPlanRoute,
  executeAnalysisCensus,
  executeAnalysisCensusPlan,
  MAX_ANALYSIS_CENSUS_NODES,
} from '../src/application/analysis-census-command.js';
import {
  acceptsAnalysisCensusArgv,
  analysisCensusArgvFromRequest,
  parseAnalysisCensusRequest,
} from '../src/application/analysis-census-request.js';

const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0 } };
const blue = { type: 'SOLID', color: { r: 0, g: 0, b: 1 } };
const rectangle = (id, name, fills = []) => ({ id, name, type: 'RECTANGLE', fills });

function fixture() {
  return {
    currentPage: {
      children: [
        {
          id: '1:1', name: 'Card', type: 'FRAME', fills: [red],
          layoutMode: 'HORIZONTAL', itemSpacing: 8,
          paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
          children: [
            {
              id: '1:2', name: 'Label', type: 'TEXT', fills: [red],
              fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
            },
            rectangle('1:3', 'Surface', [blue]),
          ],
        },
        {
          id: '2:1', name: 'Row A', type: 'GROUP',
          children: [rectangle('2:2', 'Icon A')],
        },
        {
          id: '3:1', name: 'Row B', type: 'GROUP',
          children: [rectangle('3:2', 'Icon B')],
        },
      ],
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Analyze census closes action aliases, JSON, and excess arguments', () => {
  assert.deepEqual(parseAnalysisCensusRequest(['analyze', 'type', '--json']), {
    action: 'typography', json: true,
  });
  assert.deepEqual(analysisCensusArgvFromRequest({ action: 'typography' }),
    ['analyze', 'typography']);
  assert.deepEqual(analysisCensusArgvFromRequest({ action: 'colors', json: true }),
    ['analyze', 'colors', '--json']);
  for (const argv of [
    ['analyze'],
    ['analyze', 'lint'],
    ['analyze', 'colors', 'private-value'],
    ['analyze', 'colors', '--future'],
    ['analyze', 'colors', '--json', '--json'],
    ['analyze', 'colors', '--', '--json'],
  ]) assert.equal(acceptsAnalysisCensusArgv(argv), false, argv.join(' '));
});

test('Colors census preserves legacy ranking with exact bounded facts', async () => {
  const result = await executeAnalysisCensus({ action: 'colors' }, {
    evaluate: evaluate(fixture()),
  });
  assert.deepEqual(result.result, {
    schemaVersion: 1, action: 'colors', visited: 7,
    data: [{ hex: '#ff0000', count: 2 }, { hex: '#0000ff', count: 1 }],
  });
  assert.equal(result.stdout, 'Top colors used:\n  ██ #ff0000 (2x)\n  ██ #0000ff (1x)');
});

test('Typography census handles exact and native mixed text facts', async () => {
  const figma = fixture();
  figma.currentPage.children.push({
    id: '4:1', name: 'Mixed label', type: 'TEXT',
    fontName: Symbol('mixed'), fontSize: Symbol('mixed'), fills: [],
  });
  const result = await executeAnalysisCensus({ action: 'typography', json: true }, {
    evaluate: evaluate(figma),
  });
  assert.deepEqual(result.result.data, [
    { family: 'Inter', size: 16, style: 'Regular', count: 1 },
    { family: '(mixed)', size: null, style: '(mixed)', count: 1 },
  ]);
  assert.deepEqual(JSON.parse(result.stdout), result.result.data);
  const plain = await executeAnalysisCensus({ action: 'typography' }, {
    evaluate: async () => JSON.stringify(result.result),
  });
  assert.match(plain.stdout, /\(mixed\) mixed \(mixed\)/);
});

test('Spacing census counts every legacy gap and positive edge occurrence', async () => {
  const result = await executeAnalysisCensus({ action: 'spacing' }, {
    evaluate: evaluate(fixture()),
  });
  assert.deepEqual(result.result.data, {
    gaps: [{ value: 8, count: 1 }],
    paddings: [{ value: 16, count: 4 }],
  });
  assert.match(result.stdout, /^Gap values:\n  8px \(1x\)/);
  assert.match(result.stdout, /Padding values:\n  16px \(4x\)$/);
});

test('Clusters census retains repeated signatures and bounded examples', async () => {
  const result = await executeAnalysisCensus({ action: 'clusters' }, {
    evaluate: evaluate(fixture()),
  });
  assert.deepEqual(result.result.data, [{
    pattern: 'GROUP:RECTANGLE', count: 2,
    examples: [{ id: '2:1', name: 'Row A' }, { id: '3:1', name: 'Row B' }],
  }]);
  assert.equal(result.stdout,
    'Repeated patterns (potential components):\n  2x: Row A, Row B');
});

test('missing, malformed, and excessive page facts fail closed', async () => {
  await assert.rejects(() => executeAnalysisCensus({ action: 'colors' }, {
    evaluate: evaluate({ currentPage: null }),
  }), /current page/);

  const malformed = fixture();
  malformed.currentPage.children[0].fills = [{
    type: 'SOLID', color: { r: NaN, g: 0, b: 0 },
  }];
  await assert.rejects(() => executeAnalysisCensus({ action: 'colors' }, {
    evaluate: evaluate(malformed),
  }), /invalid solid color/);

  const repeated = rectangle('1:1', 'Repeated', []);
  const excessive = {
    currentPage: { children: Array(MAX_ANALYSIS_CENSUS_NODES + 1).fill(repeated) },
  };
  await assert.rejects(() => executeAnalysisCensus({ action: 'colors' }, {
    evaluate: evaluate(excessive),
  }), /node limit/);
});

test('CLI and MCP share policy-identical safe current-page reads', async () => {
  for (const [cliArgv, mcpArgv, action] of [
    [['analyze', 'colors'], ['analyze', 'colors'], 'analyze.colors'],
    [['analyze', 'type', '--json'], ['analyze', 'typography', '--json'], 'analyze.typography'],
    [['analyze', 'spacing'], ['analyze', 'spacing'], 'analyze.spacing'],
    [['analyze', 'clusters'], ['analyze', 'clusters'], 'analyze.clusters'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'read');
    assert.equal(cli.effects.editor, 'read');
    assert.equal(cli.execution.retry, 'safe-read');
    assert.equal(cli.audit.capability, action);
    assert.equal(analysisCensusPlanRoute(cli), 'command-application');
  }
  const plan = planFigmaCommand(['analyze', 'colors'], { adapter: 'mcp' });
  assert.equal((await executeAnalysisCensusPlan(plan, {
    evaluate: evaluate(fixture()),
  })).result.action, 'colors');
  assert.throws(() => analysisCensusPlanRoute({ ...plan }), /requires a Command Plan/);
  assert.equal(analysisCensusPlanRoute(
    planFigmaCommand(['analyze', 'lint'], { adapter: 'mcp' }),
  ), 'not-analysis-census');
});

test('forged or malformed Plugin results cannot become census facts', async () => {
  const serialized = await evaluate(fixture())(analysisCensusCode({ action: 'colors' }));
  const payload = JSON.parse(serialized);
  for (const value of [
    null,
    '{',
    JSON.stringify({ action: 'colors' }),
    JSON.stringify({ ...payload, action: 'spacing' }),
    JSON.stringify({ ...payload, data: [{ hex: '#ff0000', count: 0 }] }),
    JSON.stringify({ ...payload, futureField: 'private' }),
  ]) {
    await assert.rejects(() => executeAnalysisCensus({ action: 'colors' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('Analyze census generated Plugin code parses for every action', () => {
  for (const action of ['colors', 'typography', 'spacing', 'clusters']) {
    assert.doesNotThrow(() => new Function(`return ${analysisCensusCode({ action })}`));
  }
});
