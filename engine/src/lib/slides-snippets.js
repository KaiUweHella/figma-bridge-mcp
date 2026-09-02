// Eval sources for the deliberately small Figma Slides beta surface.
//
// Slides is its own editor, but not its own transport: every source generated
// here still runs through engine -> daemon -> authenticated plugin eval. Keep
// the sources in this module so tests can parse and execute them without a
// live Figma file.

export const TRANSITION_STYLES = [
  'NONE', 'DISSOLVE',
  'SLIDE_FROM_LEFT', 'SLIDE_FROM_RIGHT', 'SLIDE_FROM_BOTTOM', 'SLIDE_FROM_TOP',
  'PUSH_FROM_LEFT', 'PUSH_FROM_RIGHT', 'PUSH_FROM_BOTTOM', 'PUSH_FROM_TOP',
  'MOVE_FROM_LEFT', 'MOVE_FROM_RIGHT', 'MOVE_FROM_TOP', 'MOVE_FROM_BOTTOM',
  'SLIDE_OUT_TO_LEFT', 'SLIDE_OUT_TO_RIGHT', 'SLIDE_OUT_TO_TOP', 'SLIDE_OUT_TO_BOTTOM',
  'MOVE_OUT_TO_LEFT', 'MOVE_OUT_TO_RIGHT', 'MOVE_OUT_TO_TOP', 'MOVE_OUT_TO_BOTTOM',
  'SMART_ANIMATE',
];

export const TRANSITION_CURVES = [
  'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR',
  'GENTLE', 'QUICK', 'BOUNCY', 'SLOW',
];

export const TRANSITION_TIMINGS = ['ON_CLICK', 'AFTER_DELAY'];
export const SLIDE_LABEL_KEY = 'bridge-slide-label';

export const MAX_DECK_ROWS = 4_096;
export const MAX_DECK_ROW_ENTRIES = 4_096;
export const MAX_DECK_SLIDES = 50_000;
export const MAX_DECK_NAME_CODE_UNITS = 4_096;
export const MAX_DECK_TRANSITION_SECONDS = 86_400;
export const DECK_FACT_KEYS = Object.freeze([
  'id', 'name', 'label', 'row', 'col', 'skipped', 'transition', 'childCount',
]);

/**
 * Eval source for reading a whole Slides deck as bounded per-slide facts.
 *
 * The existing single-slide commands each inline their own copy of this walk;
 * every reader added from here on splices this one fragment instead, so a new
 * deck-wide command cannot drift from the fact shape the others report. The
 * helpers are prefixed `__deck` so a command's own locals never collide.
 *
 * Defines: `__deckRead()` returning
 * `{ rows, slides, coordinates, focusedId }` with `rows` as slide nodes, and
 * `__deckFacts(slide)` returning one bounded fact record. Both throw on
 * anything the runtime reports that does not match the closed shape — a
 * caller is expected to turn that into an `invalid-runtime` status.
 */
export function slideDeckFactsFragment() {
  return `
    const __deckStyles = new Set(${JSON.stringify(TRANSITION_STYLES)});
    const __deckCurves = new Set(${JSON.stringify(TRANSITION_CURVES)});
    const __deckTimings = new Set(${JSON.stringify(TRANSITION_TIMINGS)});
    const __deckIdPattern = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
    const __deckExact = (value, keys) => value && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    const __deckId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= 4096 && __deckIdPattern.test(value);
    const __deckText = (value) => typeof value === 'string'
      && value.length <= ${MAX_DECK_NAME_CODE_UNITS};
    const __deckRounded = (value) => Math.round(value * 10000) / 10000;

    const __deckLabel = (slide) => {
      let label = '';
      try { label = slide.getPluginData(${JSON.stringify(SLIDE_LABEL_KEY)}) || ''; } catch {}
      if (!__deckText(label)) throw new Error('invalid slide label');
      return label;
    };

    const __deckTransition = (slide) => {
      if (typeof slide.getSlideTransition !== 'function') {
        throw new Error('invalid slide transition reader');
      }
      const value = slide.getSlideTransition();
      if (!__deckExact(value, ['style', 'duration', 'curve', 'timing'])
        || !__deckStyles.has(value.style) || !__deckCurves.has(value.curve)
        || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
        || value.duration < 0 || value.duration > ${MAX_DECK_TRANSITION_SECONDS}
        || !value.timing || !__deckTimings.has(value.timing.type)) {
        throw new Error('invalid slide transition');
      }
      const keys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
      if (!__deckExact(value.timing, keys)
        || (value.timing.type === 'AFTER_DELAY'
          && (typeof value.timing.delay !== 'number' || !Number.isFinite(value.timing.delay)
            || value.timing.delay < 0 || value.timing.delay > ${MAX_DECK_TRANSITION_SECONDS}))) {
        throw new Error('invalid slide transition timing');
      }
      return {
        style: value.style,
        duration: __deckRounded(value.duration),
        curve: value.curve,
        timing: value.timing.type === 'AFTER_DELAY'
          ? { type: value.timing.type, delay: __deckRounded(value.timing.delay) }
          : { type: value.timing.type },
      };
    };

    const __deckCoordinates = new Map();

    const __deckRead = () => {
      if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function') {
        throw new Error('invalid slides runtime');
      }
      // Callers re-read after a mutation, so stale coordinates must not
      // survive from the previous walk.
      __deckCoordinates.clear();
      const grid = figma.getCanvasGrid();
      if (!Array.isArray(grid) || grid.length > ${MAX_DECK_ROWS}) {
        throw new Error('invalid slide grid');
      }
      const rows = [];
      const slides = [];
      const seen = new Set();
      for (let row = 0; row < grid.length; row++) {
        const source = grid[row];
        if (!Array.isArray(source) || source.length > ${MAX_DECK_ROW_ENTRIES}) {
          throw new Error('invalid slide row');
        }
        const slideRow = [];
        for (let col = 0; col < source.length; col++) {
          const node = source[col];
          if (!node || node.type !== 'SLIDE') continue;
          if (!__deckId(node.id) || !__deckText(node.name) || seen.has(node.id)
            || slides.length >= ${MAX_DECK_SLIDES}) {
            throw new Error('invalid slide identity');
          }
          seen.add(node.id);
          __deckCoordinates.set(node.id, { row, col });
          slides.push(node);
          slideRow.push(node);
        }
        rows.push(slideRow);
      }
      const focused = figma.currentPage.focusedSlide;
      const focusedId = focused == null ? null : focused.id;
      if (focusedId !== null && !__deckId(focusedId)) throw new Error('invalid focused slide');
      return { rows, slides, coordinates: __deckCoordinates, focusedId };
    };

    const __deckFacts = (slide) => {
      if (!slide || slide.type !== 'SLIDE' || !__deckId(slide.id) || !__deckText(slide.name)) {
        throw new Error('invalid slide identity');
      }
      if (!Array.isArray(slide.children) || typeof slide.isSkippedSlide !== 'boolean') {
        throw new Error('invalid slide facts');
      }
      const coordinate = __deckCoordinates.get(slide.id) || { row: null, col: null };
      return {
        id: slide.id,
        name: slide.name,
        label: __deckLabel(slide) || null,
        row: coordinate.row,
        col: coordinate.col,
        skipped: slide.isSkippedSlide,
        transition: __deckTransition(slide),
        childCount: slide.children.length,
      };
    };
  `;
}

const GUARD = `
  if (figma.editorType !== 'slides') {
    return { error: 'WRONG_EDITOR', editor: figma.editorType };
  }`;

// Resolution is intentionally discriminated before Plugin dispatch. Explicit
// node/name/label variants use only their named identity surface; the query
// variant preserves the prior id -> exact name/label -> unique substring
// behavior without contributing Figma Target Context.
const RESOLVER = `
  const __label = (slide) => {
    try { return slide.getPluginData(${JSON.stringify('bridge-slide-label')}) || ''; } catch (e) { return ''; }
  };
  const __grid = () => figma.getCanvasGrid();
  const __slides = () => __grid().flat().filter(n => n && n.type === 'SLIDE');
  const __resolveSlide = async (reference) => {
    const kind = reference.kind;
    const q = String(reference.value);
    if (kind === 'node' || kind === 'query') {
      const byId = await figma.getNodeByIdAsync(q);
      if (byId && byId.type === 'SLIDE') return byId;
      if (kind === 'node') {
        if (byId) throw new Error('Node ' + q + ' is a ' + byId.type + ', not a SLIDE.');
        throw new Error('Slide node not found: ' + q);
      }
    }
    const slides = __slides();
    const exact = kind === 'name'
      ? slides.filter(n => n.name === q)
      : kind === 'label'
        ? slides.filter(n => __label(n) === q)
        : slides.filter(n => n.name === q || __label(n) === q);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error('Ambiguous slide name "' + q + '": ' + exact.map(n => n.id).join(', '));
    if (kind === 'name') throw new Error('Slide name not found: ' + q);
    if (kind === 'label') throw new Error('Slide label not found: ' + q);
    const lower = q.toLowerCase();
    const fuzzy = slides.filter(n => n.name.toLowerCase().includes(lower) || __label(n).toLowerCase().includes(lower));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) throw new Error('Ambiguous slide reference "' + q + '": ' + fuzzy.map(n => (__label(n) || n.name) + ' (' + n.id + ')').join(', '));
    throw new Error('Slide not found: ' + q);
  };
  const __coord = (slide) => {
    const grid = __grid();
    for (let row = 0; row < grid.length; row++) {
      const col = grid[row].findIndex(n => n.id === slide.id);
      if (col !== -1) return { row, col };
    }
    return { row: null, col: null };
  };
  // Canvas-grid mutations are applied at the end of Figma's current plugin
  // task. Yield once before reading coordinates or assigning a durable Bridge
  // label. Native SlideNode names are presentation numbers and Figma rewrites
  // them whenever the grid changes, so user-facing labels live in plugin data.
  const __settleGrid = () => new Promise(resolve => setTimeout(resolve, 0));
  const __rounded = (value) => Math.round(value * 10000) / 10000;
  const __facts = (slide) => {
    const transition = slide.getSlideTransition();
    const timing = transition.timing && transition.timing.type === 'AFTER_DELAY'
      ? { ...transition.timing, delay: __rounded(transition.timing.delay) }
      : transition.timing;
    return {
      id: slide.id,
      name: slide.name,
      label: __label(slide) || null,
      ...__coord(slide),
      skipped: !!slide.isSkippedSlide,
      transition: { ...transition, duration: __rounded(transition.duration), timing },
      childCount: Array.isArray(slide.children) ? slide.children.length : 0,
    };
  };`;

function wrap(body) {
  return `(async () => {${GUARD}${RESOLVER}\n${body}\n})()`;
}

function referenceValue(value) {
  if (typeof value === 'string') return { kind: 'query', value };
  if (!value || typeof value !== 'object'
    || !['node', 'name', 'label', 'query'].includes(value.kind)
    || typeof value.value !== 'string' || value.value.length === 0) {
    throw new TypeError('Slides requires a typed slide reference.');
  }
  return { kind: value.kind, value: value.value };
}

export function inspect(slideRef) {
  const reference = slideRef ? referenceValue(slideRef) : null;
  return wrap(slideRef ? `
  const slide = await __resolveSlide(${JSON.stringify(reference)});
  return { editor: 'slides', focusedId: figma.currentPage.focusedSlide?.id || null, slide: __facts(slide) };`
    : `
  const grid = __grid();
  return {
    editor: 'slides',
    focusedId: figma.currentPage.focusedSlide?.id || null,
    rows: grid.map(row => row.filter(n => n.type === 'SLIDE').map(__facts)),
    slideCount: __slides().length,
  };`);
}

export function create(label, { row = null, col = null } = {}) {
  const args = row === null ? '' : col === null ? `${row}` : `${row}, ${col}`;
  return wrap(`
  const slide = figma.createSlide(${args});
  figma.currentPage.focusedSlide = slide;
  figma.currentPage.selection = [slide];
  await __settleGrid();
  slide.setPluginData(${JSON.stringify(SLIDE_LABEL_KEY)}, ${JSON.stringify(label || '')});
  return __facts(slide);`);
}

export function duplicate(slideRef, { label = null, row = null, col = null } = {}) {
  const reference = referenceValue(slideRef);
  const moveArgs = row === null ? '' : col === null ? `, ${row}` : `, ${row}, ${col}`;
  return wrap(`
  const source = await __resolveSlide(${JSON.stringify(reference)});
  ${row === null ? '' : `const targetGrid = __grid();
  if (!targetGrid[${row}]) throw new Error('Target row ${row} does not exist. Create a slide in that row first.');
  if (${col === null ? 'false' : `${col} > targetGrid[${row}].length`}) throw new Error('Target column ${col} is outside row ${row}.');`}
  const copy = source.clone();
  figma.moveNodesToCoord([copy.id]${moveArgs});
  figma.currentPage.focusedSlide = copy;
  figma.currentPage.selection = [copy];
  await __settleGrid();
  copy.setPluginData(${JSON.stringify(SLIDE_LABEL_KEY)}, ${label ? JSON.stringify(String(label)) : `(__label(source) || source.name) + ' copy'`});
  return { sourceId: source.id, slide: __facts(copy) };`);
}

export function move(slideRef, row, col) {
  const reference = referenceValue(slideRef);
  return wrap(`
  const slide = await __resolveSlide(${JSON.stringify(reference)});
  const targetGrid = __grid();
  if (!targetGrid[${row}]) throw new Error('Target row ${row} does not exist. Create a slide in that row first.');
  if (${col} > targetGrid[${row}].length) throw new Error('Target column ${col} is outside row ${row}.');
  figma.moveNodesToCoord([slide.id], ${row}, ${col});
  await __settleGrid();
  return __facts(slide);`);
}

export function transition(slideRef, value) {
  const reference = referenceValue(slideRef);
  return wrap(`
  const slide = await __resolveSlide(${JSON.stringify(reference)});
  const transition = ${JSON.stringify(value)};
  slide.setSlideTransition(transition);
  return __facts(slide);`);
}

export function skip(slideRef, skipped = true) {
  const reference = referenceValue(slideRef);
  return wrap(`
  const slide = await __resolveSlide(${JSON.stringify(reference)});
  slide.isSkippedSlide = ${skipped ? 'true' : 'false'};
  return __facts(slide);`);
}

export function remove(slideRef) {
  const reference = referenceValue(slideRef);
  return wrap(`
  const slide = await __resolveSlide(${JSON.stringify(reference)});
  const result = { id: slide.id, name: slide.name, label: __label(slide) || null };
  slide.remove();
  return result;`);
}
