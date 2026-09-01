import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlidesProperty,
  executeSlidesPropertyPlan,
  slidesPropertyArgvFromRequest,
  slidesPropertyCode,
  slidesPropertyPlanRoute,
} from '../src/application/slides-property-command.js';
import {
  acceptsSlidesPropertyArgv,
  parseSlidesPropertyRequest,
  slidesPropertyFigmaUrlFileKeyFromArgv,
  slidesPropertyPlanningArgvFromRequest,
} from '../src/application/slides-property-request.js';

const NONE = Object.freeze({
  style: 'NONE', duration: 0.3, curve: 'EASE_IN_AND_OUT', timing: { type: 'ON_CLICK' },
});
const DISSOLVE = Object.freeze({
  style: 'DISSOLVE', duration: 0.5, curve: 'BOUNCY',
  timing: { type: 'AFTER_DELAY', delay: 1.25 },
});

function runtime({ firstWrite = 'exact', rollbackWrite = 'exact' } = {}) {
  let writes = 0;
  const registry = new Map();
  const labels = new Map();
  const makeSlide = (id, name, label) => {
    let skipped = false;
    let transition = structuredClone(NONE);
    const behavior = () => (++writes === 1 ? firstWrite : rollbackWrite);
    const slide = {
      id, name, type: 'SLIDE', children: [{ id: `${id}:child` }],
      getSlideTransition() { return structuredClone(transition); },
      setSlideTransition(value) {
        const mode = behavior();
        if (mode === 'throw-before') throw new Error('transition setter failed');
        transition = mode === 'wrong' ? structuredClone(NONE) : structuredClone(value);
        if (mode === 'throw-after') throw new Error('transition acknowledgement failed');
      },
      getPluginData(key) { return key === 'bridge-slide-label' ? labels.get(id) || '' : ''; },
    };
    Object.defineProperty(slide, 'isSkippedSlide', {
      enumerable: true,
      get() { return skipped; },
      set(value) {
        const mode = behavior();
        if (mode === 'throw-before') throw new Error('skip setter failed');
        skipped = mode === 'wrong' ? !value : value;
        if (mode === 'throw-after') throw new Error('skip acknowledgement failed');
      },
    });
    labels.set(id, label);
    registry.set(id, slide);
    return slide;
  };
  const intro = makeSlide('1:1', 'Intro', 'Opening');
  const details = makeSlide('1:2', 'Details', 'Body');
  const grid = [[intro, details]];
  const page = { id: '0:1', focusedSlide: intro, selection: [details] };
  const figma = {
    editorType: 'slides', currentPage: page,
    getCanvasGrid() { return grid; },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
  };
  return { figma, page, intro, details, writes: () => writes };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slides Property closes transition and skip grammars with canonical defaults', () => {
  assert.deepEqual(parseSlidesPropertyRequest([
    'slides', 'transition', 'label:Body', 'dissolve', '--duration=.5', '--curve=bouncy',
    '--timing=after_delay', '--delay=1.25',
  ]), {
    action: 'transition',
    reference: parseSlidesPropertyRequest([
      'slides', 'transition', 'label:Body', 'NONE',
    ]).reference,
    transition: DISSOLVE,
  });
  assert.deepEqual(slidesPropertyArgvFromRequest({
    action: 'transition', reference: 'Details', style: 'none',
  }), ['slides', 'transition', 'query:Details', 'NONE']);
  assert.deepEqual(slidesPropertyArgvFromRequest({
    action: 'transition', reference: 'Details', style: 'dissolve', duration: 0.333333,
  }), ['slides', 'transition', 'query:Details', 'DISSOLVE', '--duration=0.3333']);
  assert.deepEqual(slidesPropertyArgvFromRequest({
    action: 'skip', reference: 'Details', skipped: false,
  }), ['slides', 'skip', 'query:Details', 'off']);
  for (const argv of [
    ['slides', 'transition', 'Details'],
    ['slides', 'transition', 'Details', 'future'],
    ['slides', 'transition', 'Details', 'NONE', '--duration=-1'],
    ['slides', 'transition', 'Details', 'NONE', '--curve=BOUNCY', '--curve=LINEAR'],
    ['slides', 'skip'],
    ['slides', 'skip', 'Details', 'maybe'],
    ['slides', 'skip', 'Details', 'on', 'extra'],
  ]) assert.equal(acceptsSlidesPropertyArgv(argv), false, argv.join(' '));
  assert.throws(() => slidesPropertyArgvFromRequest({
    action: 'transition', reference: 'Details', transition: {
      style: 'NONE', duration: 0.3, curve: 'EASE_IN_AND_OUT',
      timing: { type: 'ON_CLICK', delay: 1 },
    },
  }), /does not match its type/);
});

test('transition writes one exact native value and preserves every other fact', async () => {
  const live = runtime();
  const result = await executeSlidesProperty({
    action: 'transition', reference: 'label:Body', style: 'DISSOLVE',
    duration: 0.5, curve: 'BOUNCY', timing: 'AFTER_DELAY', delay: 1.25,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.slide.transition, DISSOLVE);
  assert.equal(result.result.actual.slide.skipped, false);
  assert.equal(result.stdout, '✓ Slide 1:2 transition: DISSOLVE');
  assert.equal(live.page.focusedSlide.id, '1:1');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:2']);
});

test('skip and include write one exact native boolean', async () => {
  const skipped = runtime();
  const first = await executeSlidesProperty({
    action: 'skip', reference: 'Details', skipped: true,
  }, { evaluate: evaluate(skipped.figma) });
  assert.equal(first.result.actual.slide.skipped, true);
  assert.equal(first.stdout, '✓ Slide 1:2 is skipped');

  const included = await executeSlidesProperty({
    action: 'skip', reference: 'Details', skipped: false,
  }, { evaluate: evaluate(skipped.figma) });
  assert.equal(included.result.actual.slide.skipped, false);
  assert.equal(included.stdout, '✓ Slide 1:2 is included');
});

test('ambiguous references refuse both property writes before mutation', async () => {
  for (const request of [
    { action: 'skip', reference: 'name:Same', skipped: true },
    { action: 'transition', reference: 'name:Same', style: 'NONE' },
  ]) {
    const live = runtime(); live.intro.name = 'Same'; live.details.name = 'Same';
    await assert.rejects(() => executeSlidesProperty(request, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.writes(), 0);
  }
});

test('setter acknowledgement errors succeed only after exact fresh readback', async () => {
  for (const request of [
    { action: 'skip', reference: 'Details', skipped: true },
    { action: 'transition', reference: 'Details', style: 'DISSOLVE' },
  ]) {
    const live = runtime({ firstWrite: 'throw-after' });
    const result = await executeSlidesProperty(request, { evaluate: evaluate(live.figma) });
    assert.equal(result.result.outcome, 'verified-after-error');
    assert.match(result.stderr, /fresh Slides readback verified/);
    assert.equal(live.writes(), 1);
  }
});

test('failed or wrong writes restore the exact prior property', async () => {
  for (const request of [
    { action: 'skip', reference: 'Details', skipped: true },
    { action: 'transition', reference: 'Details', style: 'DISSOLVE' },
  ]) {
    for (const firstWrite of ['throw-before', 'wrong']) {
      const live = runtime({ firstWrite });
      await assert.rejects(() => executeSlidesProperty(request, {
        evaluate: evaluate(live.figma),
      }), (error) => {
        assert.equal(error.mutationOutcome, 'rolled-back');
        assert.equal(error.mutationReport.restored, 1);
        return true;
      });
      assert.equal(live.details.isSkippedSlide, false);
      assert.deepEqual(live.details.getSlideTransition(), NONE);
    }
  }
});

test('rollback residue and post-rollback acknowledgement remain distinct', async () => {
  const residue = runtime({ firstWrite: 'wrong', rollbackWrite: 'throw-before' });
  await assert.rejects(() => executeSlidesProperty({
    action: 'skip', reference: 'Details', skipped: false,
  }, { evaluate: evaluate(residue.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue'); return true;
  });
  const restored = runtime({ firstWrite: 'wrong', rollbackWrite: 'throw-after' });
  await assert.rejects(() => executeSlidesProperty({
    action: 'transition', reference: 'Details', style: 'DISSOLVE',
  }, { evaluate: evaluate(restored.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back'); return true;
  });
});

test('CLI and MCP share typed target identity, policy and one execution', async () => {
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  for (const request of [
    { action: 'skip', reference: `node:${url}`, skipped: true },
    { action: 'transition', reference: `node:${url}`, style: 'DISSOLVE' },
  ]) {
    const argv = slidesPropertyPlanningArgvFromRequest(request);
    assert.equal(slidesPropertyFigmaUrlFileKeyFromArgv(argv), 'TARGETPLACEHOLDERKEY');
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.target.fileKey, 'TARGETPLACEHOLDERKEY');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(slidesPropertyPlanRoute(cli), 'command-application');
    const live = runtime(); let calls = 0;
    const result = await executeSlidesPropertyPlan(cli, { evaluate: async (code) => {
      calls += 1; return evaluate(live.figma)(code);
    } });
    assert.equal(result.result.actual.slide.id, '1:2');
    assert.equal(calls, 1);
  }
  const plan = planFigmaCommand(['slides', 'skip', 'Details'], { adapter: 'cli' });
  assert.throws(() => slidesPropertyPlanRoute({ ...plan }), /requires a Command Plan/);
});

test('wrong editors and forged Plugin results cannot claim a property mutation', async () => {
  const request = { action: 'skip', reference: 'Details', skipped: true };
  const wrong = runtime(); wrong.figma.editorType = 'figma';
  await assert.rejects(() => executeSlidesProperty(request, {
    evaluate: evaluate(wrong.figma),
  }), (error) => { assert.equal(error.mutationOutcome, 'no-mutation'); return true; });
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'updated' })]) {
    await assert.rejects(() => executeSlidesProperty(request, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const payload = JSON.parse(await evaluate(live.figma)(slidesPropertyCode(request)));
  for (const forged of [
    { ...payload, future: true },
    { ...payload, request: { ...payload.request, skipped: false } },
    { ...payload, actual: { ...payload.actual, rows: [] } },
    { ...payload, actual: { ...payload.actual, slide: {
      ...payload.actual.slide, childCount: 2,
    } } },
  ]) {
    await assert.rejects(() => executeSlidesProperty(request, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
});

test('Slides Property generated Plugin code parses for both actions', () => {
  assert.doesNotThrow(() => new Function(`return ${slidesPropertyCode({
    action: 'transition', reference: 'Details', style: 'SMART_ANIMATE',
  })}`));
  assert.doesNotThrow(() => new Function(`return ${slidesPropertyCode({
    action: 'skip', reference: 'Details', skipped: true,
  })}`));
});
