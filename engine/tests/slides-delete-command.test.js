import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlidesDelete,
  executeSlidesDeletePlan,
  slidesDeleteArgvFromRequest,
  slidesDeleteCode,
  slidesDeletePlanRoute,
} from '../src/application/slides-delete-command.js';
import {
  acceptsSlidesDeleteArgv,
  parseSlidesDeleteRequest,
  slidesDeleteFigmaUrlFileKeyFromArgv,
  slidesDeletePlanningArgvFromRequest,
} from '../src/application/slides-delete-request.js';

function runtime({
  behavior = 'exact', failFreshRead = false, ambiguous = false, staleNameReads = 0,
} = {}) {
  let removes = 0;
  let removed = false;
  const registry = new Map();
  const labels = new Map();
  const grid = [[]];
  const makeSlide = (id, nameValue, label) => {
    const slide = {
      id, type: 'SLIDE',
      get name() {
        if (removed && staleNameReads > 0) {
          staleNameReads -= 1;
          throw new Error(`in get_name: The node with id "${id}" does not exist`);
        }
        return nameValue;
      },
      getPluginData(key) { return key === 'bridge-slide-label' ? labels.get(id) || '' : ''; },
      remove() {
        removes += 1;
        if (behavior === 'throw-before' || behavior === 'no-effect') {
          if (behavior === 'throw-before') throw new Error('injected removal failure');
          return;
        }
        const removeId = (nodeId) => {
          registry.delete(nodeId);
          for (const row of grid) {
            const index = row.findIndex((node) => node.id === nodeId);
            if (index !== -1) row.splice(index, 1);
          }
        };
        removeId(id);
        if (behavior === 'cascade') removeId('1:3');
        while (grid.some((row) => row.length === 0)) {
          grid.splice(grid.findIndex((row) => row.length === 0), 1);
        }
        page.selection = page.selection.filter((node) => node.id !== id);
        if (page.focusedSlide?.id === id) page.focusedSlide = grid[0]?.[0] || null;
        removed = true;
        if (behavior === 'throw-after') throw new Error('injected acknowledgement failure');
      },
    };
    registry.set(id, slide); labels.set(id, label); grid[0].push(slide); return slide;
  };
  const intro = makeSlide('1:1', ambiguous ? 'Details' : 'Intro', 'Opening');
  const details = makeSlide('1:2', 'Details', 'Body');
  const closing = makeSlide('1:3', 'Closing', ambiguous ? 'Body' : 'End');
  const page = { id: '0:1', focusedSlide: intro, selection: [details] };
  const figma = {
    editorType: 'slides', currentPage: page,
    getCanvasGrid() { return grid; },
    async getNodeByIdAsync(id) {
      if (failFreshRead && removed && id === details.id) throw new Error('injected fresh-read failure');
      return registry.get(id) || null;
    },
  };
  return { figma, page, grid, intro, details, closing, registry, removes: () => removes };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slides Delete closes one typed reference and preserves URL target identity', () => {
  assert.deepEqual(parseSlidesDeleteRequest(['slides', 'delete', 'label:Body']), {
    reference: parseSlidesDeleteRequest(['slides', 'delete', 'label:Body']).reference,
  });
  assert.deepEqual(slidesDeleteArgvFromRequest({ reference: 'Details' }), [
    'slides', 'delete', 'query:Details',
  ]);
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  const planning = slidesDeletePlanningArgvFromRequest({ reference: `node:${url}` });
  assert.equal(slidesDeleteFigmaUrlFileKeyFromArgv(planning), 'TARGETPLACEHOLDERKEY');
  assert.deepEqual(planning, ['slides', 'delete', `node:${url}`]);
  for (const argv of [
    ['slides', 'delete'],
    ['slides', 'delete', 'Details', 'extra'],
    ['slides', 'delete', '--future'],
  ]) assert.equal(acceptsSlidesDeleteArgv(argv), false, argv.join(' '));
});

test('exact deletion proves the target absent and preserves every remaining grid identity', async () => {
  const live = runtime();
  const result = await executeSlidesDelete({ reference: 'label:Body' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'deleted');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.before.slide, {
    id: '1:2', name: 'Details', label: 'Body', row: 0, col: 1,
  });
  assert.deepEqual(result.result.actual.rows, [['1:1', '1:3']]);
  assert.equal(result.result.actual.targetPresent, false);
  assert.equal(result.result.actual.lookupPresent, false);
  assert.equal(result.stdout, '✓ Deleted slide 1:2 [Body] (Figma name: "Details")');
  assert.equal(live.removes(), 1);
});

test('a thrown acknowledgement succeeds only after exact fresh absence', async () => {
  const live = runtime({ behavior: 'throw-after' });
  const result = await executeSlidesDelete({ reference: 'Details' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.removes(), 1);
});

test('Slides Delete waits for renumbered native Slide names to settle after removal', async () => {
  const live = runtime({ staleNameReads: 2 });
  const result = await executeSlidesDelete({ reference: 'label:Body' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.rows, [['1:1', '1:3']]);
});

test('ambiguous, missing and wrong-editor targets refuse before removal', async () => {
  const ambiguous = runtime({ ambiguous: true });
  const missing = runtime();
  const wrong = runtime(); wrong.figma.editorType = 'figma';
  for (const [live, reference] of [
    [ambiguous, 'Details'], [missing, 'Missing'], [wrong, 'Details'],
  ]) {
    await assert.rejects(() => executeSlidesDelete({ reference }, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.removes(), 0);
  }
});

test('a retained target reports unchanged without a destructive retry', async () => {
  for (const behavior of ['no-effect', 'throw-before']) {
    const live = runtime({ behavior });
    await assert.rejects(() => executeSlidesDelete({ reference: 'Details' }, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'unchanged');
      assert.equal(error.mutationReport.residueCount, 1);
      return true;
    });
    assert.equal(live.removes(), 1);
    assert.equal(live.registry.has('1:2'), true);
  }
});

test('unexpected sibling loss reports irreversible partial residue', async () => {
  const live = runtime({ behavior: 'cascade' });
  await assert.rejects(() => executeSlidesDelete({ reference: 'Details' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.deepEqual(live.grid.map((row) => row.map((slide) => slide.id)), [['1:1']]);
});

test('unavailable post-dispatch readback stays explicit and never retries', async () => {
  const live = runtime({ failFreshRead: true });
  await assert.rejects(() => executeSlidesDelete({ reference: 'Details' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
  assert.equal(live.removes(), 1);
});

test('CLI and MCP share one target-bound non-retrying deletion Plan', async () => {
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  const argv = slidesDeletePlanningArgvFromRequest({ reference: `node:${url}` });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(cli.id, 'slides.delete');
  assert.equal(cli.target.fileKey, 'TARGETPLACEHOLDERKEY');
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(slidesDeletePlanRoute(cli), 'command-application');
  assert.throws(() => slidesDeletePlanRoute({ ...cli }), /requires a Command Plan/);
  const live = runtime(); let calls = 0;
  const result = await executeSlidesDeletePlan(cli, { evaluate: async (code) => {
    calls += 1; return evaluate(live.figma)(code);
  } });
  assert.equal(result.result.status, 'deleted');
  assert.equal(calls, 1);
});

test('malformed and forged Plugin results cannot claim a deletion', async () => {
  for (const serialized of [null, '{}', 'not-json', JSON.stringify({ status: 'deleted' })]) {
    await assert.rejects(() => executeSlidesDelete({ reference: 'Details' }, {
      evaluate: async () => serialized,
    }), /invalid/i);
  }
});

test('Slides Delete generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${slidesDeleteCode({ reference: 'Details' })}`));
});

// figma.getCanvasGrid() lags the page tree (measured 2026-09-03): a live
// slide can be absent from the grid for minutes. The snapshot reconciles the
// two, so such a slide can be addressed and deleted, and a focus resting on
// one no longer blocks every other mutation.
function ghostIn(live) {
  let present = true;
  const ghost = {
    id: '1:9', type: 'SLIDE', name: 'Ghost',
    getPluginData(key) { return key === 'bridge-slide-label' ? 'Stray' : ''; },
    remove() { live.registry.delete('1:9'); present = false; },
  };
  live.registry.set('1:9', ghost);
  Object.defineProperty(live.page, 'children', {
    get: () => [{ type: 'SLIDE_ROW', children: [...live.grid.flat(), ...(present ? [ghost] : [])] }],
  });
  return ghost;
}

test('a slide the grid has not listed yet is deleted by existence, not by grid difference', async () => {
  const live = runtime();
  ghostIn(live);
  const before = live.grid.map((row) => row.map((node) => node.id));
  const result = await executeSlidesDelete({ reference: 'label:Stray' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'deleted');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.before.slide, {
    id: '1:9', name: 'Ghost', label: 'Stray', row: null, col: null,
  });
  assert.deepEqual(result.result.before.unlisted, ['1:9']);
  assert.deepEqual(result.result.actual.unlisted, []);
  assert.deepEqual(result.result.actual.rows, before, 'the grid itself was untouched');
  assert.equal(live.registry.has('1:9'), false);
});

test('a focus resting on an unlisted slide no longer refuses deleting a listed one', async () => {
  const live = runtime();
  const ghost = ghostIn(live);
  live.page.focusedSlide = ghost;
  const result = await executeSlidesDelete({ reference: 'label:Body' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'deleted');
  assert.equal(result.result.before.focusedId, '1:9');
  assert.deepEqual(result.result.actual.unlisted, ['1:9']);
});

test('a slide is deleted by existence while the canvas grid throws on every read', async () => {
  // Seen live: after a clone was removed, figma.getCanvasGrid() kept its id and
  // threw "does not exist" for minutes. The page tree still held every slide.
  const live = runtime();
  const ghost = ghostIn(live);
  live.figma.getCanvasGrid = () => { throw new Error('in getCanvasGrid: The node with id "21:299" does not exist'); };
  const result = await executeSlidesDelete({ reference: 'label:Stray' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'deleted');
  assert.match(result.result.before.gridError, /does not exist/);
  assert.deepEqual(result.result.before.rows, []);
  assert.deepEqual(result.result.before.unlisted, ['1:1', '1:2', '1:3', '1:9']);
  assert.deepEqual(result.result.actual.unlisted, ['1:1', '1:2', '1:3']);
  assert.equal(live.registry.has(ghost.id), false);
});
