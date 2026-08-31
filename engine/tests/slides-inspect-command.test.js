import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  MAX_SLIDES_INSPECT_GRID_ENTRIES,
  MAX_SLIDES_INSPECT_ROW_ENTRIES,
  MAX_SLIDES_INSPECT_ROWS,
  executeSlidesInspect,
  executeSlidesInspectPlan,
  slidesInspectArgvFromRequest,
  slidesInspectCode,
  slidesInspectPlanRoute,
  slidesInspectPlanningArgvFromRequest,
} from '../src/application/slides-inspect-command.js';
import { slidesReferenceFigmaUrlFileKeyFromArgv } from '../src/application/slides-reference-request.js';

const transition = Object.freeze({
  style: 'NONE', duration: 0, curve: 'LINEAR', timing: { type: 'ON_CLICK' },
});

function runtime() {
  const labels = new Map();
  const makeSlide = (id, name) => ({
    id, name, type: 'SLIDE', children: [], isSkippedSlide: false,
    getPluginData(key) { return key === 'bridge-slide-label' ? labels.get(id) || '' : ''; },
    getSlideTransition() { return transition; },
  });
  const intro = makeSlide('1:1', 'Intro');
  const details = makeSlide('1:2', 'Details');
  details.children.push({ id: '2:1', type: 'TEXT' });
  labels.set(details.id, 'Tail');
  const grid = [[intro, details]];
  const rectangle = { id: '9:9', name: 'Rectangle', type: 'RECTANGLE' };
  const registry = new Map([intro, details, rectangle].map((node) => [node.id, node]));
  return {
    grid, intro, details, labels,
    figma: {
      editorType: 'slides',
      currentPage: { focusedSlide: intro },
      getCanvasGrid() { return grid; },
      async getNodeByIdAsync(id) { return registry.get(id) || null; },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slides Inspect closes typed requests and preserves URL target identity only for node references', () => {
  const url = 'https://www.figma.com/design/ARGUMENTPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  assert.deepEqual(slidesInspectArgvFromRequest({ reference: `node:${url}` }), [
    'slides', 'inspect', 'node:1:2',
  ]);
  const planning = slidesInspectPlanningArgvFromRequest({ reference: `node:${url}` });
  assert.equal(slidesReferenceFigmaUrlFileKeyFromArgv(planning), 'ARGUMENTPLACEHOLDERKEY');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey,
    'ARGUMENTPLACEHOLDERKEY');
  assert.deepEqual(slidesInspectArgvFromRequest({ reference: `label:${url}` }), [
    'slides', 'inspect', `label:${url}`,
  ]);
  assert.deepEqual(slidesInspectArgvFromRequest({ reference: null }), ['slides', 'inspect']);
  assert.throws(() => slidesInspectArgvFromRequest({ reference: null, future: true }), /unknown field/);
  assert.throws(() => slidesInspectArgvFromRequest({ reference: '' }), /Invalid Slides/);
  assert.throws(() => slidesInspectArgvFromRequest({ reference: 'x'.repeat(4097) }), /Invalid Slides/);
});

test('deck inspection returns the complete native grid, focus, labels and transition facts', async () => {
  const live = runtime();
  live.details.isSkippedSlide = true;
  const result = await executeSlidesInspect({ reference: null }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.result, {
    editor: 'slides', focusedId: '1:1',
    rows: [[
      {
        id: '1:1', name: 'Intro', label: null, row: 0, col: 0,
        skipped: false, transition, childCount: 0,
      },
      {
        id: '1:2', name: 'Details', label: 'Tail', row: 0, col: 1,
        skipped: true, transition, childCount: 1,
      },
    ]],
    slideCount: 2,
  });
  assert.deepEqual(JSON.parse(result.stdout), result.result);
});

test('typed and compatibility references retain their distinct resolution semantics', async () => {
  const live = runtime();
  for (const [reference, id] of [
    ['node:1:2', '1:2'], ['name:Intro', '1:1'], ['label:Tail', '1:2'],
    ['query:tail', '1:2'], ['1:1', '1:1'],
  ]) {
    const result = await executeSlidesInspect({ reference }, { evaluate: evaluate(live.figma) });
    assert.equal(result.result.slide.id, id, reference);
  }

  live.intro.name = 'Tail';
  await assert.rejects(() => executeSlidesInspect({ reference: 'query:Tail' }, {
    evaluate: evaluate(live.figma),
  }), /Ambiguous slide reference/);
  await assert.rejects(() => executeSlidesInspect({ reference: 'name:Missing' }, {
    evaluate: evaluate(live.figma),
  }), /Slide not found/);
  await assert.rejects(() => executeSlidesInspect({ reference: 'node:9:9' }, {
    evaluate: evaluate(live.figma),
  }), /RECTANGLE, not a SLIDE/);
});

test('CLI and MCP receive policy-identical safe-read Plans and the same Application result', async () => {
  const cli = planFigmaCommand(['slides', 'inspect', 'label:Tail'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['slides', 'inspect', 'label:Tail'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.deepEqual(cli.effects, {
    figma: 'read', editor: 'read', workspace: 'none', network: 'none', shared: 'none',
  });
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.availability.editor, 'slides');
  assert.equal(cli.availability.feature, 'slides-beta');
  assert.equal(slidesInspectPlanRoute(cli), 'command-application');
  assert.throws(() => slidesInspectPlanRoute({ ...cli }), /requires a Command Plan/);

  const live = runtime();
  let calls = 0;
  const adapters = { evaluate: async (code) => {
    calls += 1;
    return evaluate(live.figma)(code);
  } };
  const cliResult = await executeSlidesInspectPlan(cli, adapters);
  const mcpResult = await executeSlidesInspectPlan(mcp, adapters);
  assert.deepEqual(cliResult, mcpResult);
  assert.equal(calls, 2);
});

test('wrong editors, malformed grids and excessive inventories fail without partial facts', async () => {
  const live = runtime();
  live.figma.editorType = 'figma';
  await assert.rejects(() => executeSlidesInspect({ reference: null }, {
    evaluate: evaluate(live.figma),
  }), /requires a Figma Slides deck/);

  const malformed = runtime();
  malformed.grid.push(...Array.from({ length: MAX_SLIDES_INSPECT_ROWS }, () => []));
  await assert.rejects(() => executeSlidesInspect({ reference: null }, {
    evaluate: evaluate(malformed.figma),
  }), /bounded native deck/);

  const duplicate = runtime();
  duplicate.grid.push([duplicate.intro]);
  await assert.rejects(() => executeSlidesInspect({ reference: null }, {
    evaluate: evaluate(duplicate.figma),
  }), /bounded native deck/);

  const excessiveEntries = runtime();
  const foreign = { id: '8:8', type: 'RECTANGLE' };
  const rowCount = Math.ceil(MAX_SLIDES_INSPECT_GRID_ENTRIES
    / MAX_SLIDES_INSPECT_ROW_ENTRIES) + 1;
  excessiveEntries.grid.push(...Array.from({ length: rowCount }, () => Array(
    MAX_SLIDES_INSPECT_ROW_ENTRIES).fill(foreign)));
  await assert.rejects(() => executeSlidesInspect({ reference: null }, {
    evaluate: evaluate(excessiveEntries.figma),
  }), /bounded native deck/);
});

test('malformed and forged Plugin results cannot become Slides facts', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ schemaVersion: 1, status: 'ok' })]) {
    await assert.rejects(() => executeSlidesInspect({ reference: null }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(slidesInspectCode({ reference: null }));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, future: true },
    { ...payload, data: { ...payload.data, slideCount: 1 } },
    { ...payload, data: { ...payload.data, focusedId: 'private' } },
    { ...payload, data: { ...payload.data, rows: [[
      payload.data.rows[0][0], payload.data.rows[0][0],
    ]] } },
  ]) {
    await assert.rejects(() => executeSlidesInspect({ reference: null }, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
});

test('Slides Inspect generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${slidesInspectCode({ reference: null })}`));
  assert.doesNotThrow(() => new Function(`return ${slidesInspectCode({ reference: 'label:Tail' })}`));
});
