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
