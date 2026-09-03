// Slides editor context: focus and view. Neither touches the document.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SLIDE_LABEL_KEY } from '../src/lib/slides-snippets.js';
import {
  SLIDES_VIEW_MODES,
  acceptsSlidesViewArgv,
  executeSlidesFocus,
  executeSlidesView,
  parseSlidesViewRequest,
} from '../src/application/slides-viewport-command.js';

function slide(id, name, label = '') {
  return {
    id,
    name,
    type: 'SLIDE',
    getPluginData(key) { return key === SLIDE_LABEL_KEY ? label : ''; },
  };
}

function runtime({
  rows = [[slide('1:1', '1', 'Cover'), slide('1:2', '2', 'Body')]],
  editorType = 'slides',
  focusedSlide = null,
  slidesView = 'grid',
  refuseFocus = false,
  refuseView = false,
} = {}) {
  const state = { focusedSlide, slidesView };
  const figma = {
    editorType,
    currentPage: {
      get focusedSlide() { return state.focusedSlide; },
      set focusedSlide(value) { if (!refuseFocus) state.focusedSlide = value; },
    },
    viewport: {
      get slidesView() { return state.slidesView; },
      set slidesView(value) { if (!refuseView) state.slidesView = value; },
    },
    getCanvasGrid() { return rows; },
    async getNodeByIdAsync(id) { return rows.flat().find((entry) => entry.id === id) || null; },
  };
  return { figma, state, evaluate: (code) => new Function('figma', `return ${code}`)(figma) };
}

describe('Slides focus', () => {
  it('focuses a slide by label and reports what was focused before', async () => {
    const live = runtime({ focusedSlide: null });
    const result = await executeSlidesFocus(['slides', 'focus', 'label:Body'], { evaluate: live.evaluate });

    assert.equal(result.result.focusedId, '1:2');
    assert.equal(result.result.label, 'Body');
    assert.equal(result.result.previousId, null);
    assert.equal(live.state.focusedSlide.id, '1:2', 'the editor actually moved');
    assert.match(result.stdout, /Focused Body \(1:2\)/);

    const again = await executeSlidesFocus(['slides', 'focus', 'node:1:1'], { evaluate: live.evaluate });
    assert.equal(again.result.previousId, '1:2', 'the prior focus is reported');
    assert.equal(live.state.focusedSlide.id, '1:1');
  });

  it('focuses a slide by label when the canvas grid has not listed it yet', async () => {
    const live = runtime();
    const ghost = slide('9:9', '9', 'Stray');
    Object.defineProperty(live.figma.currentPage, 'children', {
      get: () => [{ type: 'SLIDE_ROW', children: [ghost] }],
    });
    const result = await executeSlidesFocus(['slides', 'focus', 'label:Stray'], { evaluate: live.evaluate });
    assert.equal(result.result.focusedId, '9:9');
    assert.equal(live.state.focusedSlide.id, '9:9');
  });

  it('focuses by label when the canvas grid throws instead of listing', async () => {
    const live = runtime();
    const ghost = slide('9:9', '9', 'Stray');
    live.figma.getCanvasGrid = () => { throw new Error('in getCanvasGrid: The node with id "1:2" does not exist'); };
    Object.defineProperty(live.figma.currentPage, 'children', {
      get: () => [{ type: 'SLIDE_ROW', children: [ghost] }],
    });
    const result = await executeSlidesFocus(['slides', 'focus', 'label:Stray'], { evaluate: live.evaluate });
    assert.equal(result.result.focusedId, '9:9');
  });

  it('refuses a reference it cannot resolve to exactly one slide', async () => {
    const live = runtime({
      rows: [[slide('1:1', 'dup'), slide('1:2', 'dup')]],
    });
    await assert.rejects(
      () => executeSlidesFocus(['slides', 'focus', 'name:dup'], { evaluate: live.evaluate }),
      /Ambiguous slide reference: 2 slides match/,
    );
    assert.equal(live.state.focusedSlide, null, 'an ambiguous reference changes nothing');

    await assert.rejects(
      () => executeSlidesFocus(['slides', 'focus', 'label:missing'], { evaluate: live.evaluate }),
      /Slide not found/,
    );
  });

  it('reports a focus Figma did not accept instead of claiming success', async () => {
    const live = runtime({ refuseFocus: true });
    await assert.rejects(
      () => executeSlidesFocus(['slides', 'focus', 'label:Cover'], { evaluate: live.evaluate }),
      /did not accept the focus change/,
    );
  });

  it('refuses a non-Slides editor', async () => {
    const live = runtime({ editorType: 'figma' });
    await assert.rejects(
      () => executeSlidesFocus(['slides', 'focus', 'label:Cover'], { evaluate: live.evaluate }),
      /requires a Figma Slides deck/,
    );
  });
});

describe('Slides view', () => {
  it('accepts only the modes the typings declare', () => {
    assert.deepEqual([...SLIDES_VIEW_MODES], ['grid', 'single-slide']);
    for (const mode of SLIDES_VIEW_MODES) {
      assert.equal(parseSlidesViewRequest(['slides', 'view', mode]).mode, mode);
    }
    for (const bad of ['single', 'GRID', 'canvas', '']) {
      assert.equal(acceptsSlidesViewArgv(['slides', 'view', bad]), false, bad);
    }
  });

  it('switches the deck view and reports the previous mode', async () => {
    const live = runtime({ slidesView: 'grid' });
    const result = await executeSlidesView(['slides', 'view', 'single-slide'], { evaluate: live.evaluate });
    assert.deepEqual(result.result, { mode: 'single-slide', previousMode: 'grid' });
    assert.equal(live.state.slidesView, 'single-slide');
    assert.match(result.stdout, /Slides view: single-slide \(was grid\)/);

    const same = await executeSlidesView(['slides', 'view', 'single-slide'], { evaluate: live.evaluate });
    assert.match(same.stdout, /^Slides view: single-slide$/, 'an unchanged mode is not reported as a change');
  });

  it('reports a view Figma did not accept instead of claiming success', async () => {
    const live = runtime({ refuseView: true, slidesView: 'grid' });
    await assert.rejects(
      () => executeSlidesView(['slides', 'view', 'single-slide'], { evaluate: live.evaluate }),
      /did not accept the view change/,
    );
    assert.equal(live.state.slidesView, 'grid');
  });
});
