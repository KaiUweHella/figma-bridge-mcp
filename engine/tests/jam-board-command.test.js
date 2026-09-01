import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamBoard,
  executeJamBoardPlan,
  formatJamBoardResult,
  jamBoardCode,
  jamBoardPlanRoute,
} from '../src/application/jam-board-command.js';
import {
  acceptsJamBoardArgv,
  jamBoardArgvFromRequest,
  parseJamBoardRequest,
} from '../src/application/jam-board-request.js';

function runtime() {
  const sticky = {
    id: '1:1', type: 'STICKY', name: 'Idea', x: 10.4, y: 20.5, width: 200, height: 200,
    text: { characters: 'Explore the bounded path' },
  };
  const cells = [['Owner', 'State'], ['Bridge', 'Ready']];
  const table = {
    id: '1:2', type: 'TABLE', name: 'Plan', x: 250, y: 20, width: 400, height: 180,
    numRows: 2, numColumns: 2,
    cellAt(row, col) { return { text: { characters: cells[row][col] } }; },
  };
  const connector = {
    id: '1:3', type: 'CONNECTOR', name: 'Flow', x: 210, y: 80, width: 40, height: 10,
    text: { characters: 'next' },
    connectorStart: { endpointNodeId: sticky.id, magnet: 'AUTO' },
    connectorEnd: { endpointNodeId: table.id, magnet: 'AUTO' },
  };
  const code = {
    id: '1:4', type: 'CODE_BLOCK', name: 'Example', x: 10, y: 260, width: 320, height: 180,
    code: 'const ready = true;',
  };
  const page = { id: '0:1', name: 'Neutral FigJam Fixture', children: [sticky, table, connector, code] };
  return { figma: { editorType: 'figjam', currentPage: page }, page, sticky, table, connector, code };
}

const evaluate = (figma) => async (source) => new Function('figma', `return ${source}`)(figma);

test('Jam Board closes its option-only grammar and canonical JSON flag', () => {
  assert.deepEqual(parseJamBoardRequest(['jam', 'board']), { json: false });
  assert.deepEqual(jamBoardArgvFromRequest({ json: true }), ['jam', 'board', '--json']);
  for (const argv of [
    ['jam', 'board', '--json', '--json'],
    ['jam', 'board', '--future'],
    ['jam', 'board', 'payload'],
  ]) assert.equal(acceptsJamBoardArgv(argv), false, argv.join(' '));
});

test('Jam Board preserves complete bounded node, table and connector facts', async () => {
  const live = runtime();
  const result = await executeJamBoard({}, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.pageId, '0:1');
  assert.equal(result.result.page, 'Neutral FigJam Fixture');
  assert.equal(result.result.count, 4);
  assert.deepEqual(result.result.nodes[0], {
    id: '1:1', type: 'STICKY', name: 'Idea', x: 10, y: 21, w: 200, h: 200,
    text: 'Explore the bounded path', table: null,
  });
  assert.deepEqual(result.result.nodes[1].table, {
    rows: 2, cols: 2, data: [['Owner', 'State'], ['Bridge', 'Ready']],
  });
  assert.deepEqual(result.result.connectors, [{
    id: '1:3', from: '1:1', to: '1:2', text: 'next',
  }]);
  assert.match(result.stdout, /Neutral FigJam Fixture — 4 node\(s\)/);
  assert.match(result.stdout, /1:1\s+STICKY/);
  assert.match(result.stdout, /1:1 → 1:2 "next"/);
});

test('Jam Board JSON retains the legacy public projection without internal page identity', async () => {
  const live = runtime();
  const result = await executeJamBoard({ json: true }, { evaluate: evaluate(live.figma) });
  const json = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(json), ['page', 'count', 'nodes', 'connectors']);
  assert.equal(json.page, 'Neutral FigJam Fixture');
  assert.equal(json.nodes[3].text, 'const ready = true;');
  assert.equal(Object.hasOwn(json, 'pageId'), false);
});

test('wrong editors and unbounded or malformed native facts fail without partial output', async () => {
  const wrong = runtime(); wrong.figma.editorType = 'figma';
  await assert.rejects(() => executeJamBoard({}, { evaluate: evaluate(wrong.figma) }), /FigJam/);

  const malformed = runtime(); malformed.table.numRows = 50_001;
  await assert.rejects(() => executeJamBoard({}, { evaluate: evaluate(malformed.figma) }), /bounded/);

  const duplicate = runtime(); duplicate.page.children.push(duplicate.sticky);
  await assert.rejects(() => executeJamBoard({}, { evaluate: evaluate(duplicate.figma) }), /bounded/);
});

test('CLI and MCP share one policy-identical safe-read Plan and Application', async () => {
  const argv = jamBoardArgvFromRequest({ json: true });
  const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'TARGETPLACEHOLDERKEY' });
  const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'TARGETPLACEHOLDERKEY' });
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'jam.board');
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'read');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(jamBoardPlanRoute(cli), 'command-application');
  assert.throws(() => jamBoardPlanRoute({ ...cli }), /requires a Command Plan/);
  const live = runtime(); let calls = 0;
  const result = await executeJamBoardPlan(cli, { evaluate: async (source) => {
    calls += 1; return evaluate(live.figma)(source);
  } });
  assert.equal(result.result.count, 4);
  assert.equal(calls, 1);
});

test('malformed and forged Plugin results cannot become board facts', async () => {
  for (const serialized of [null, '{}', 'not-json', JSON.stringify({ schemaVersion: 1, status: 'ok' })]) {
    await assert.rejects(() => executeJamBoard({}, { evaluate: async () => serialized }), /invalid/i);
  }
  const live = runtime();
  const genuine = await executeJamBoard({}, { evaluate: evaluate(live.figma) });
  const forged = JSON.stringify({ schemaVersion: 1, status: 'ok', data: {
    ...genuine.result, count: genuine.result.count + 1,
  } });
  await assert.rejects(() => executeJamBoard({}, { evaluate: async () => forged }), /invalid/i);
});

test('human formatting removes control-bearing native text', () => {
  const text = formatJamBoardResult({
    pageId: '0:1', page: 'Board\u202e', count: 1,
    nodes: [{ id: '1:1', type: 'STICKY', name: 'Idea', x: 0, y: 0, w: 10, h: 10,
      text: 'safe\u0000text', table: null }], connectors: [],
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
});

test('Jam Board generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${jamBoardCode({})}`));
});
