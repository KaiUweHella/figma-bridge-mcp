import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamConnector,
  executeJamConnectorPlan,
  jamConnectorCode,
  jamConnectorPlanRoute,
} from '../src/application/jam-connector-command.js';
import {
  acceptsJamConnectorArgv,
  jamConnectorArgvFromRequest,
  jamConnectorFigmaUrlFileKeyFromArgv,
  parseJamConnectorRequest,
} from '../src/application/jam-connector-request.js';

function runtime({
  editorType = 'figjam', wrongEndpoint = false, removeNoEffect = false,
  throwAfterLine = false, factoryThrows = false, switchPageDuringFontLoad = false,
  canonicalStraightMagnet = false,
} = {}) {
  const registry = new Map();
  const page = { id: '0:1', type: 'PAGE', children: [], selection: [] };
  const from = { id: '1:1', type: 'STICKY', parent: page };
  const to = { id: '1:2', type: 'SHAPE_WITH_TEXT', parent: page };
  page.children.push(from, to);
  page.selection = [from];
  const otherPage = { id: '0:2', type: 'PAGE', children: [], selection: [] };
  for (const node of [page, otherPage, from, to]) registry.set(node.id, node);
  let creates = 0;
  let fontLoads = 0;
  const figma = {
    editorType, currentPage: page, mixed: Symbol('mixed'),
    async loadFontAsync() {
      fontLoads += 1;
      if (switchPageDuringFontLoad) this.currentPage = otherPage;
    },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    createConnector() {
      creates += 1;
      let start = { endpointNodeId: from.id, magnet: 'AUTO' };
      let end = { endpointNodeId: to.id, magnet: 'AUTO' };
      let line = 'ELBOWED';
      const text = { characters: '', fontName: { family: 'Inter', style: 'Medium' } };
      const node = {
        id: `9:${creates}`, type: 'CONNECTOR', parent: page, text,
        get connectorStart() { return start; }, set connectorStart(value) { start = value; },
        get connectorEnd() { return end; },
        set connectorEnd(value) {
          end = wrongEndpoint ? { ...value, endpointNodeId: from.id } : value;
        },
        get connectorLineType() { return line; },
        set connectorLineType(value) {
          line = value;
          if (canonicalStraightMagnet && value === 'STRAIGHT') {
            start = { ...start, magnet: 'CENTER' };
            end = { ...end, magnet: 'CENTER' };
          }
          if (throwAfterLine) throw new Error('injected acknowledgement');
        },
        remove() {
          if (removeNoEffect) return;
          const index = page.children.indexOf(this);
          if (index !== -1) page.children.splice(index, 1);
          registry.delete(this.id); this.parent = null;
        },
      };
      page.children.push(node); registry.set(node.id, node);
      if (factoryThrows) throw new Error('injected factory failure');
      return node;
    },
  };
  return { figma, page, otherPage, from, to, creates: () => creates, fontLoads: () => fontLoads };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Connector closes endpoints, text, line fallback, and URL identity', () => {
  const url = 'https://www.figma.com/board/BOARDPLACEHOLDERKEY/FILE_NAME?node-id=1-1';
  const argv = ['jam', 'connector', url, '1:2', '--text=- yes', '--line=straight'];
  assert.deepEqual(parseJamConnectorRequest(argv), {
    fromId: '1:1', toId: '1:2', text: '- yes', line: 'STRAIGHT',
  });
  assert.equal(jamConnectorFigmaUrlFileKeyFromArgv(argv), 'BOARDPLACEHOLDERKEY');
  assert.deepEqual(parseJamConnectorRequest([
    'jam', 'connector', '1:1', '1:2', '--line=curved', '--text=',
  ]), { fromId: '1:1', toId: '1:2', text: null, line: 'ELBOWED' });
  assert.deepEqual(jamConnectorArgvFromRequest({
    fromId: '1-1', toId: '1:2', text: 'yes', line: 'straight',
  }), ['jam', 'connector', '1:1', '1:2', '--text=yes', '--line=STRAIGHT']);
  for (const value of [
    ['jam', 'connector'],
    ['jam', 'connector', '1:1'],
    ['jam', 'connector', 'bad', '1:2'],
    ['jam', 'connector', '1:1', '1:2', '1:3'],
    ['jam', 'connector', '1:1', '1:2', '--text'],
    ['jam', 'connector', '1:1', '1:2', '--future'],
    ['jam', 'connector', '1:1', '1:2', '--line=x', '--line=y'],
  ]) assert.equal(acceptsJamConnectorArgv(value), false, value.join(' '));
});

test('Jam Connector creates and freshly verifies exact native endpoint facts', async () => {
  const live = runtime();
  const result = await executeJamConnector({
    fromId: '1:1', toId: '1:2', text: 'yes', line: 'STRAIGHT',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.node.start, { endpointNodeId: '1:1', magnet: 'AUTO' });
  assert.deepEqual(result.result.actual.node.end, { endpointNodeId: '1:2', magnet: 'AUTO' });
  assert.equal(result.result.actual.node.line, 'STRAIGHT');
  assert.equal(result.result.actual.node.text, 'yes');
  assert.equal(result.stdout, '✓ Connector 9:1');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:1']);
  assert.equal(live.fontLoads(), 2);
});

test('Jam Connector accepts Figma canonical CENTER magnets on straight endpoints', async () => {
  const live = runtime({ canonicalStraightMagnet: true });
  const result = await executeJamConnector({
    fromId: '1:1', toId: '1:2', text: 'next', line: 'STRAIGHT',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.node.start, { endpointNodeId: '1:1', magnet: 'CENTER' });
  assert.deepEqual(result.result.actual.node.end, { endpointNodeId: '1:2', magnet: 'CENTER' });
});

test('setter acknowledgement errors require exact fresh Connector readback', async () => {
  const live = runtime({ throwAfterLine: true });
  const result = await executeJamConnector({ fromId: '1:1', toId: '1:2' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('endpoint mismatch rolls back the Connector or reports exact residue', async () => {
  const rollback = runtime({ wrongEndpoint: true });
  await assert.rejects(() => executeJamConnector({ fromId: '1:1', toId: '1:2' }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1', '1:2']);

  const residue = runtime({ wrongEndpoint: true, removeNoEffect: true });
  await assert.rejects(() => executeJamConnector({ fromId: '1:1', toId: '1:2' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('missing endpoints refuse while page switches and factory failures stay explicit', async () => {
  const missing = runtime();
  await assert.rejects(() => executeJamConnector({ fromId: '1:1', toId: '9:9' }, {
    evaluate: evaluate(missing.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(missing.creates(), 0);

  const switched = runtime({ switchPageDuringFontLoad: true });
  await assert.rejects(() => executeJamConnector({
    fromId: '1:1', toId: '1:2', text: 'label',
  }, { evaluate: evaluate(switched.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(switched.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(switched.otherPage.children, []);

  const factory = runtime({ factoryThrows: true });
  await assert.rejects(() => executeJamConnector({ fromId: '1:1', toId: '1:2' }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('wrong editor and oversized snapshots refuse before Connector creation', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamConnector({ fromId: '1:1', toId: '1:2' }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const oversized = runtime();
  oversized.page.children = [oversized.from, oversized.to,
    ...Array.from({ length: 700 }, (_, index) => ({
      id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`, parent: oversized.page,
    }))];
  await assert.rejects(() => executeJamConnector({ fromId: '1:1', toId: '1:2' }, {
    evaluate: evaluate(oversized.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(oversized.creates(), 0);
});

test('one non-retrying Jam Connector Plan owns equivalent URL-targeted CLI and MCP policy', async () => {
  const url = 'https://www.figma.com/board/BOARDPLACEHOLDERKEY/FILE_NAME?node-id=1-1';
  const cli = planFigmaCommand([
    'jam', 'connector', url, '1:2', '--text=yes', '--line=straight',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'connector', '1:1', '1:2', '--line', 'STRAIGHT', '--text', 'yes',
  ], { adapter: 'mcp', fileKey: 'BOARDPLACEHOLDERKEY' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.target.fileKey, 'BOARDPLACEHOLDERKEY');
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamConnectorPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamConnectorPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Connectors', async () => {
  const request = { fromId: '1:1', toId: '1:2' };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamConnector(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamConnectorCode(request));
  const forged = JSON.parse(serialized);
  forged.actual.node.end.endpointNodeId = '1:1';
  await assert.rejects(() => executeJamConnector(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Connector generated Plugin code parses with hostile text inert', () => {
  const text = '`; figma.currentPage.remove(); //';
  const code = jamConnectorCode({ fromId: '1:1', toId: '1:2', text });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify(text)));
});
