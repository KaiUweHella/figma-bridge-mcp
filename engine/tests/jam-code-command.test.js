import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamCode,
  executeJamCodePlan,
  jamCodeBlockCode,
  jamCodePlanRoute,
} from '../src/application/jam-code-command.js';
import {
  acceptsJamCodeArgv,
  jamCodeArgvFromRequest,
  parseJamCodeRequest,
} from '../src/application/jam-code-request.js';

const LANGUAGES = new Set([
  'TYPESCRIPT', 'CPP', 'RUBY', 'CSS', 'JAVASCRIPT', 'HTML', 'JSON', 'GRAPHQL',
  'PYTHON', 'GO', 'SQL', 'SWIFT', 'KOTLIN', 'RUST', 'BASH', 'PLAINTEXT', 'DART',
]);

function runtime({
  editorType = 'figjam', wrongCode = false, removeNoEffect = false,
  throwAfterY = false, factoryThrows = false, switchPageDuringFontLoad = false,
  fontFailure = false,
} = {}) {
  const registry = new Map();
  const page = { id: '0:1', type: 'PAGE', children: [], selection: [] };
  const existing = {
    id: '1:1', type: 'STICKY', parent: page, x: 10, y: 20, width: 100, height: 80,
  };
  page.children.push(existing);
  page.selection = [existing];
  const otherPage = { id: '0:2', type: 'PAGE', children: [], selection: [] };
  for (const node of [page, otherPage, existing]) registry.set(node.id, node);
  let creates = 0;
  let fontLoads = 0;
  const figma = {
    editorType, currentPage: page,
    async loadFontAsync() {
      fontLoads += 1;
      if (switchPageDuringFontLoad) this.currentPage = otherPage;
      if (fontFailure) throw new Error('injected font failure');
    },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    createCodeBlock() {
      creates += 1;
      let code = '';
      let language = 'PLAINTEXT';
      let y = 0;
      const block = {
        id: `9:${creates}`, type: 'CODE_BLOCK', parent: page,
        x: 0, width: 320, height: 180,
        get y() { return y; },
        set y(value) {
          y = value;
          if (throwAfterY) throw new Error('injected acknowledgement');
        },
        get code() { return code; },
        set code(value) { code = wrongCode ? `${value}!` : value; },
        get codeLanguage() { return language; },
        set codeLanguage(value) {
          if (!LANGUAGES.has(value)) throw new Error('unsupported language');
          language = value;
        },
        remove() {
          if (removeNoEffect) return;
          const index = page.children.indexOf(this);
          if (index !== -1) page.children.splice(index, 1);
          registry.delete(this.id); this.parent = null;
        },
      };
      page.children.push(block); registry.set(block.id, block);
      if (factoryThrows) throw new Error('injected factory failure');
      return block;
    },
  };
  return {
    figma, page, otherPage, existing,
    creates: () => creates, fontLoads: () => fontLoads,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Code closes source, forward-compatible language, placement, and excess input', () => {
  assert.deepEqual(parseJamCodeRequest([
    'jam', 'code', '--lang=python', '--at=10,-20', '--', '- print(1)',
  ]), { source: '- print(1)', language: 'PYTHON', x: 10, y: -20 });
  assert.deepEqual(parseJamCodeRequest([
    'jam', 'code', 'x', '--lang=future_lang', '--at=bad',
  ]), { source: 'x', language: 'FUTURE_LANG', x: null, y: null });
  assert.deepEqual(jamCodeArgvFromRequest({
    source: 'const x = 1;', lang: 'javascript', x: 5, y: 6,
  }), ['jam', 'code', '--lang=JAVASCRIPT', '--at=5,6', '--', 'const x = 1;']);
  for (const value of [
    ['jam', 'code'],
    ['jam', 'code', 'one', 'two'],
    ['jam', 'code', 'one', '--lang'],
    ['jam', 'code', 'one', '--future'],
    ['jam', 'code', 'one', '--lang=a', '--lang=b'],
    ['jam', 'code', 'one', '--lang=bad\u0000value'],
  ]) assert.equal(acceptsJamCodeArgv(value), false, value.join(' '));
});

test('Jam Code creates and freshly verifies exact native facts without changing selection', async () => {
  const live = runtime();
  const result = await executeJamCode({ source: 'print(1)', language: 'python' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.actual.node.code, 'print(1)');
  assert.equal(result.result.actual.node.language, 'PYTHON');
  assert.equal(result.result.actual.node.languageApplied, true);
  assert.equal(result.result.actual.node.x, 190);
  assert.equal(result.result.actual.node.y, 20);
  assert.equal(result.stdout, '✓ Code block 9:1');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:1']);
  assert.equal(live.fontLoads(), 1);
});

test('unsupported languages preserve and report the exact native fallback', async () => {
  const live = runtime();
  const result = await executeJamCode({ source: 'future()', language: 'future_lang' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.initialLanguage, 'PLAINTEXT');
  assert.equal(result.result.actual.node.language, 'PLAINTEXT');
  assert.equal(result.result.actual.node.languageApplied, false);
  assert.equal(result.stderr, '');
});

test('setter acknowledgement errors require exact fresh Code Block readback', async () => {
  const live = runtime({ throwAfterY: true });
  const result = await executeJamCode({ source: 'ack()', x: 10, y: 20 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('code mismatch rolls back the Code Block or reports exact residue', async () => {
  const rollback = runtime({ wrongCode: true });
  await assert.rejects(() => executeJamCode({ source: 'rollback()' }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1']);
  assert.deepEqual(rollback.page.selection.map((node) => node.id), ['1:1']);

  const residue = runtime({ wrongCode: true, removeNoEffect: true });
  await assert.rejects(() => executeJamCode({ source: 'residue()' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('font failure, page switches, and factory failures retain explicit outcomes', async () => {
  const font = runtime({ fontFailure: true });
  await assert.rejects(() => executeJamCode({ source: 'font()' }, {
    evaluate: evaluate(font.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');

  const switched = runtime({ switchPageDuringFontLoad: true });
  await assert.rejects(() => executeJamCode({ source: 'page()' }, {
    evaluate: evaluate(switched.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(switched.page.children.map((node) => node.id), ['1:1']);
  assert.deepEqual(switched.otherPage.children, []);

  const factory = runtime({ factoryThrows: true });
  await assert.rejects(() => executeJamCode({ source: 'unknown()' }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('wrong editor and oversized snapshots refuse before Code Block creation', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamCode({ source: 'no()' }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const oversized = runtime();
  oversized.page.children = [oversized.existing,
    ...Array.from({ length: 700 }, (_, index) => ({
      id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`,
      x: index, y: 0, width: 10, height: 10, parent: oversized.page,
    }))];
  await assert.rejects(() => executeJamCode({ source: 'x'.repeat(280_000) }, {
    evaluate: evaluate(oversized.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(oversized.creates(), 0);
});

test('one non-retrying Jam Code Plan owns equivalent CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'code', 'print(1)', '--lang=python', '--at=10,-20',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'code', '--at', '10,-20', '--lang', 'PYTHON', '--', 'print(1)',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamCodePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamCodePlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Code Blocks', async () => {
  const request = { source: 'safe()' };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamCode(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamCodeBlockCode(request));
  const forged = JSON.parse(serialized);
  forged.actual.node.languageApplied = false;
  await assert.rejects(() => executeJamCode(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Code generated Plugin code parses with hostile source inert', () => {
  const source = '`; figma.currentPage.remove(); //';
  const code = jamCodeBlockCode({ source });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify(source)));
});
