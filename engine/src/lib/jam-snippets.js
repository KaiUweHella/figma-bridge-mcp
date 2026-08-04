// Eval sources for the FigJam commands.
//
// Kept out of the command file so they can be built and PARSED without a Figma
// connection: a syntax error inside a generated eval string is invisible to
// `node --check` (it only sees a template literal) and would otherwise surface
// as a runtime error in the plugin sandbox, one command at a time.
// engine/tests/jam-snippets.test.js parses every one of these.

/** Named sticky colours, plus whatever hex a caller passes through. */
export const STICKY_COLORS = {
  yellow: '#FFE066', green: '#A8E6A1', blue: '#A6D8FF', pink: '#FFB3D9',
  orange: '#FFC08A', violet: '#D4B3FF', grey: '#E0E0E0', red: '#FF9B9B',
};

export const SHAPE_TYPES = [
  'SQUARE', 'ELLIPSE', 'ROUNDED_RECTANGLE', 'DIAMOND',
  'TRIANGLE_UP', 'TRIANGLE_DOWN', 'PARALLELOGRAM_RIGHT', 'PARALLELOGRAM_LEFT',
];

// FigJam text lives on sublayers that refuse to be written before their font is
// loaded, and the font a node reports can be figma.mixed. Loading Inter first
// and falling back to whatever the node claims covers both.
const FONT_PRELUDE = `
  const loadFont = async (node) => {
    try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch (e) {}
    try {
      const fn = node && node.fontName;
      if (fn && fn !== figma.mixed) await figma.loadFontAsync(fn);
    } catch (e) {}
  };`;

// A sticky command run in a design file would otherwise fail at the first API
// call with "figma.createSticky is not a function" — which reads as a broken
// bridge rather than as the wrong kind of file.
const GUARD = `
  if (figma.editorType !== 'figjam') {
    return { error: 'WRONG_EDITOR', editor: figma.editorType };
  }`;

function wrap(body) {
  return `(async () => {${GUARD}${FONT_PRELUDE}\n${body}\n})()`;
}

/**
 * Where a new node goes: an explicit `at` wins, otherwise to the right of
 * whatever is already on the board — an agent adding to a populated board
 * should not stack everything at the origin.
 */
function placement(at) {
  if (at) {
    const [x, y] = String(at).split(',').map((n) => parseFloat(String(n).trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) return `const origin = { x: ${x}, y: ${y} };`;
  }
  return `
  const existing = figma.currentPage.children;
  const origin = existing.length
    ? { x: Math.max(...existing.map(n => n.x + n.width)) + 80, y: Math.min(...existing.map(n => n.y)) }
    : { x: 0, y: 0 };`;
}

/** Hex or named colour → a Figma RGB literal, or the string "null". */
export function colorLiteral(name) {
  if (!name) return 'null';
  const hex = STICKY_COLORS[String(name).toLowerCase()] || String(name);
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'null';
  const h = m[1];
  const c = (i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4);
  return `{ r: ${c(0)}, g: ${c(2)}, b: ${c(4)} }`;
}

export function sticky(text, { color, at } = {}) {
  return wrap(`
  ${placement(at)}
  const s = figma.createSticky();
  await loadFont(s.text);
  s.text.characters = ${JSON.stringify(text)};
  const fill = ${colorLiteral(color)};
  if (fill) s.fills = [{ type: 'SOLID', color: fill }];
  s.x = origin.x; s.y = origin.y;
  figma.currentPage.selection = [s];
  return { id: s.id, x: s.x, y: s.y };`);
}

export function stickies(items, { at, columns = 4 } = {}) {
  const cols = Math.max(1, parseInt(columns, 10) || 4);
  return wrap(`
  ${placement(at)}
  const items = ${JSON.stringify(items)};
  const named = ${JSON.stringify(STICKY_COLORS)};
  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(named[String(hex).toLowerCase()] || hex || '');
    if (!m) return null;
    const h = m[1];
    return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 };
  };
  const made = [];
  for (let i = 0; i < items.length; i++) {
    const s = figma.createSticky();
    if (i === 0) await loadFont(s.text);
    s.text.characters = items[i].text;
    const fill = hexToRgb(items[i].color);
    if (fill) s.fills = [{ type: 'SOLID', color: fill }];
    s.x = origin.x + (i % ${cols}) * (s.width + 24);
    s.y = origin.y + Math.floor(i / ${cols}) * (s.height + 24);
    made.push(s);
  }
  figma.currentPage.selection = made;
  return { count: made.length, ids: made.map(n => n.id).slice(0, 20) };`);
}

export function shape(text, { type = 'ROUNDED_RECTANGLE', at, width = 200, height = 140 } = {}) {
  return wrap(`
  ${placement(at)}
  const s = figma.createShapeWithText();
  s.shapeType = ${JSON.stringify(type)};
  await loadFont(s.text);
  s.text.characters = ${JSON.stringify(text)};
  s.resize(${width}, ${height});
  s.x = origin.x; s.y = origin.y;
  figma.currentPage.selection = [s];
  return { id: s.id };`);
}

export function connector(fromId, toId, { text, line = 'ELBOWED' } = {}) {
  return wrap(`
  const from = await figma.getNodeByIdAsync(${JSON.stringify(fromId)});
  const to = await figma.getNodeByIdAsync(${JSON.stringify(toId)});
  if (!from) return { error: 'Node not found: ' + ${JSON.stringify(fromId)} };
  if (!to) return { error: 'Node not found: ' + ${JSON.stringify(toId)} };
  const c = figma.createConnector();
  c.connectorStart = { endpointNodeId: from.id, magnet: 'AUTO' };
  c.connectorEnd = { endpointNodeId: to.id, magnet: 'AUTO' };
  c.connectorLineType = ${JSON.stringify(line)};
  ${text ? `await loadFont(c.text); c.text.characters = ${JSON.stringify(text)};` : ''}
  return { id: c.id };`);
}

export function table(rows, cols, { data = [], at } = {}) {
  return wrap(`
  ${placement(at)}
  const t = figma.createTable(${rows}, ${cols});
  t.x = origin.x; t.y = origin.y;
  const data = ${JSON.stringify(data)};
  let loaded = false;
  for (let row = 0; row < Math.min(data.length, ${rows}); row++) {
    const cells = Array.isArray(data[row]) ? data[row] : [];
    for (let col = 0; col < Math.min(cells.length, ${cols}); col++) {
      const cell = t.cellAt(row, col);
      if (!loaded) { await loadFont(cell.text); loaded = true; }
      cell.text.characters = String(cells[col] ?? '');
    }
  }
  figma.currentPage.selection = [t];
  return { id: t.id, rows: ${rows}, cols: ${cols} };`);
}

export function section(name, { at, width = 800, height = 600 } = {}) {
  return wrap(`
  ${placement(at)}
  const s = figma.createSection();
  s.name = ${JSON.stringify(name)};
  s.resizeWithoutConstraints(${width}, ${height});
  s.x = origin.x; s.y = origin.y;
  return { id: s.id };`);
}

export function codeBlock(source, { lang = 'TYPESCRIPT', at } = {}) {
  return wrap(`
  ${placement(at)}
  const b = figma.createCodeBlock();
  b.code = ${JSON.stringify(source)};
  try { b.codeLanguage = ${JSON.stringify(String(lang).toUpperCase())}; } catch (e) {}
  b.x = origin.x; b.y = origin.y;
  return { id: b.id };`);
}

export function board() {
  return wrap(`
  const textOf = (n) => {
    try {
      if (n.text && typeof n.text.characters === 'string') return n.text.characters;
      if (typeof n.characters === 'string') return n.characters;
      if (typeof n.code === 'string') return n.code;
    } catch (e) {}
    return '';
  };
  const nodes = figma.currentPage.children.map(n => ({
    id: n.id, type: n.type, name: n.name,
    x: Math.round(n.x), y: Math.round(n.y),
    w: Math.round(n.width), h: Math.round(n.height),
    text: textOf(n).slice(0, 200),
  }));
  const connectors = figma.currentPage.children
    .filter(n => n.type === 'CONNECTOR')
    .map(n => ({
      id: n.id,
      from: (n.connectorStart && n.connectorStart.endpointNodeId) || null,
      to: (n.connectorEnd && n.connectorEnd.endpointNodeId) || null,
      text: textOf(n).slice(0, 100),
    }));
  return { page: figma.currentPage.name, count: nodes.length, nodes, connectors };`);
}

export function arrange({ columns = 5, gap = 48 } = {}) {
  const cols = Math.max(1, parseInt(columns, 10) || 5);
  const g = parseFloat(gap) || 48;
  return wrap(`
  // Connectors follow their endpoints, and moving a section drags its whole
  // contents — neither belongs in a grid pass.
  const movable = figma.currentPage.children
    .filter(n => n.type !== 'CONNECTOR' && n.type !== 'SECTION');
  if (!movable.length) return { moved: 0 };
  const startX = Math.min(...movable.map(n => n.x));
  const startY = Math.min(...movable.map(n => n.y));
  const colW = Math.max(...movable.map(n => n.width)) + ${g};
  const rowH = Math.max(...movable.map(n => n.height)) + ${g};
  movable.forEach((n, i) => {
    n.x = startX + (i % ${cols}) * colW;
    n.y = startY + Math.floor(i / ${cols}) * rowH;
  });
  return { moved: movable.length };`);
}
