import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamSection,
  executeJamSectionPlan,
  jamSectionCode,
  jamSectionPlanRoute,
} from '../src/application/jam-section-command.js';
import {
  acceptsJamSectionArgv,
  jamSectionArgvFromRequest,
  parseJamSectionRequest,
} from '../src/application/jam-section-request.js';

function runtime({
  editorType = 'figjam', wrongSize = false, removeNoEffect = false,
  throwAfterY = false, factoryThrows = false, switchPageDuringResize = false,
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
  const figma = {
    editorType, currentPage: page,
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    createSection() {
      creates += 1;
      let y = 0;
      const section = {
        id: `9:${creates}`, type: 'SECTION', parent: page, children: [], name: 'Section',
        x: 0, width: 100, height: 100,
        get y() { return y; },
        set y(value) {
          y = value;
          if (throwAfterY) throw new Error('injected acknowledgement');
        },
        resizeWithoutConstraints(width, height) {
          this.width = wrongSize ? width + 1 : width;
          this.height = height;
          if (switchPageDuringResize) figma.currentPage = otherPage;
        },
        remove() {
          if (removeNoEffect) return;
          const index = page.children.indexOf(this);
          if (index !== -1) page.children.splice(index, 1);
          registry.delete(this.id); this.parent = null;
        },
      };
      page.children.push(section); registry.set(section.id, section);
      if (factoryThrows) throw new Error('injected factory failure');
      return section;
    },
  };
  return { figma, page, otherPage, existing, creates: () => creates };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Section closes name, legacy size fallback, placement, and excess input', () => {
  assert.deepEqual(parseJamSectionRequest([
    'jam', 'section', '--size=120px,bad', '--at=10,-20', '--', '- Phase',
  ]), { name: '- Phase', width: 120, height: 600, x: 10, y: -20 });
  assert.deepEqual(parseJamSectionRequest([
    'jam', 'section', 'Phase', '--size=bad,900rest', '--at=bad',
  ]), { name: 'Phase', width: 800, height: 900, x: null, y: null });
  assert.deepEqual(jamSectionArgvFromRequest({
    name: 'Phase', width: 120, height: 80, x: 5, y: 6,
  }), ['jam', 'section', '--size=120,80', '--at=5,6', '--', 'Phase']);
  for (const value of [
    ['jam', 'section'],
    ['jam', 'section', 'one', 'two'],
    ['jam', 'section', 'one', '--size=0,10'],
    ['jam', 'section', 'one', '--size=-1,10'],
    ['jam', 'section', 'one', '--size'],
    ['jam', 'section', 'one', '--future'],
    ['jam', 'section', 'one', '--at=1,2', '--at=3,4'],
  ]) assert.equal(acceptsJamSectionArgv(value), false, value.join(' '));
});

test('Jam Section creates and freshly verifies exact native facts without changing selection', async () => {
  const live = runtime();
  const result = await executeJamSection({ name: 'Phase', width: 300, height: 200 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.actual.node.name, 'Phase');
  assert.equal(result.result.actual.node.x, 190);
  assert.equal(result.result.actual.node.y, 20);
  assert.equal(result.result.actual.node.width, 300);
  assert.equal(result.result.actual.node.height, 200);
  assert.equal(result.stdout, '✓ Section 9:1');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:1']);
});

test('setter acknowledgement errors require exact fresh Section readback', async () => {
  const live = runtime({ throwAfterY: true });
  const result = await executeJamSection({ name: 'Ack', x: 10, y: 20 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('size mismatch rolls back the Section or reports exact residue', async () => {
  const rollback = runtime({ wrongSize: true });
  await assert.rejects(() => executeJamSection({ name: 'Rollback' }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1']);
  assert.deepEqual(rollback.page.selection.map((node) => node.id), ['1:1']);

  const residue = runtime({ wrongSize: true, removeNoEffect: true });
  await assert.rejects(() => executeJamSection({ name: 'Residue' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('page switches and factory failures retain explicit outcomes', async () => {
  const switched = runtime({ switchPageDuringResize: true });
  await assert.rejects(() => executeJamSection({ name: 'Bound page' }, {
    evaluate: evaluate(switched.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(switched.page.children.map((node) => node.id), ['1:1']);
  assert.deepEqual(switched.otherPage.children, []);

  const factory = runtime({ factoryThrows: true });
  await assert.rejects(() => executeJamSection({ name: 'Unknown' }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('wrong editor and oversized snapshots refuse before Section creation', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamSection({ name: 'No' }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const oversized = runtime();
  oversized.page.children = [oversized.existing,
    ...Array.from({ length: 700 }, (_, index) => ({
      id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`,
      x: index, y: 0, width: 10, height: 10, parent: oversized.page,
    }))];
  await assert.rejects(() => executeJamSection({ name: 'Bounded' }, {
    evaluate: evaluate(oversized.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(oversized.creates(), 0);
});

test('one non-retrying Jam Section Plan owns equivalent CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'section', 'Phase', '--size=120px,80rest', '--at=10,-20',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'section', '--at', '10,-20', '--size', '120,80', '--', 'Phase',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamSectionPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamSectionPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Sections', async () => {
  const request = { name: 'Safe' };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamSection(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamSectionCode(request));
  const forged = JSON.parse(serialized);
  forged.actual.node.childCount = 1;
  await assert.rejects(() => executeJamSection(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Section generated Plugin code parses with hostile names inert', () => {
  const name = '`; figma.currentPage.remove(); //';
  const code = jamSectionCode({ name });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify(name)));
});
