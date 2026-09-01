import assert from 'node:assert/strict';
import test from 'node:test';
import { gridAutoFlowCode } from '../src/application/grid-auto-flow-command.js';
import { gridPlaceCode } from '../src/application/grid-place-command.js';
import { gridSetCode } from '../src/application/grid-set-command.js';
import { gridTrackReorderCode } from '../src/application/grid-track-reorder-command.js';
import { shaderApplyCode, shaderImportCode, shaderListCode } from '../src/lib/shader-management.js';
import { parseSlotSettings, slotCreateCode, slotResetCode, slotValidateCode } from '../src/lib/slot-management.js';
import { drawBrushCode, drawPatternCode, drawStrokeProfileCode, drawTextPathCode, drawTransformGroupCode } from '../src/lib/draw-management.js';

const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

test('shader APIs list, import, and apply typed shader paints without REST', async () => {
  const shader = { id: 'SH:1', name: 'Glow', type: 'fill', imported: true, propertyDefinitions: { p: { name: 'Power', type: 'NUMBER', defaultValue: 1 } } };
  const node = { id: '1:2', name: 'Card', type: 'RECTANGLE', fills: [], strokes: [], effects: [] };
  const figma = { editorType: 'figma', mixed: Symbol('mixed'), listAvailableShaders: async () => [shader], importShaderById: async () => shader, getNodeByIdAsync: async () => node };
  assert.equal((await execute(shaderListCode(), figma))[0].name, 'Glow');
  assert.equal((await execute(shaderImportCode({ shaderId: shader.id }), figma)).imported, true);
  await execute(shaderApplyCode({ nodeId: node.id, shaderId: shader.id, field: 'fill', properties: { p: 2 } }), figma);
  assert.deepEqual(node.fills[0], { type: 'SHADER', id: shader.id, properties: { p: 2 } });
});

function gridFixture() {
  const source = {
    id: '2:1', name: 'Source', type: 'FRAME', layoutMode: 'NONE', children: [],
    insertChild(index, node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      this.children.splice(index, 0, node); node.parent = this;
    },
  };
  const child = {
    id: '2:2', name: 'Child', type: 'RECTANGLE', x: 0, y: 0, parent: source,
    layoutPositioning: 'AUTO', gridRowAnchorIndex: 0, gridColumnAnchorIndex: 0,
    gridRowSpan: 1, gridColumnSpan: 1,
    gridChildHorizontalAlign: 'AUTO', gridChildVerticalAlign: 'AUTO',
    setGridChildPosition(row, column) { this.gridRowAnchorIndex = row; this.gridColumnAnchorIndex = column; },
  };
  source.children.push(child);
  const grid = {
    id: '1:1', name: 'Grid', type: 'FRAME', layoutMode: 'NONE', gridRowGap: 0, gridColumnGap: 0,
    gridAutoTracks: 'NONE', gridItemsPositioning: 'MANUAL', gridRowSizes: [], gridColumnSizes: [], children: [],
    appendChildAt(node, row, column) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      this.children.push(node); node.parent = this;
      node.gridRowAnchorIndex = row; node.gridColumnAnchorIndex = column;
    },
    insertChild(index, node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      this.children.splice(index, 0, node); node.parent = this;
    },
    reorderRows: (options) => reorder('rows', options),
    reorderColumns: (options) => reorder('columns', options),
  };
  function reorder(axis, { fromIndices, insertionIndex }) {
    const field = axis === 'rows' ? 'gridRowSizes' : 'gridColumnSizes';
    const anchor = axis === 'rows' ? 'gridRowAnchorIndex' : 'gridColumnAnchorIndex';
    const span = axis === 'rows' ? 'gridRowSpan' : 'gridColumnSpan';
    const count = grid[field].length;
    const selected = [...new Set(fromIndices)].sort((left, right) => left - right);
    const remaining = Array.from({ length: count }, (_, index) => index)
      .filter((index) => !selected.includes(index));
    const adjusted = insertionIndex - selected.filter((index) => index < insertionIndex).length;
    const order = [...remaining]; order.splice(adjusted, 0, ...selected);
    const mapping = new Map(order.map((from, to) => [from, to]));
    grid[field] = order.map((from) => grid[field][from]);
    for (const item of grid.children) {
      const occupied = Array.from({ length: item[span] }, (_, offset) => mapping.get(item[anchor] + offset));
      item[anchor] = Math.min(...occupied);
    }
    return order.map((from, to) => ({ from, to })).filter(({ from, to }) => from !== to);
  }
  Object.defineProperty(grid, 'gridRowCount', { get() { return this.gridRowSizes.length; }, set(value) { while (this.gridRowSizes.length < value) this.gridRowSizes.push({ type: 'FLEX', value: 1 }); this.gridRowSizes.length = value; } });
  Object.defineProperty(grid, 'gridColumnCount', { get() { return this.gridColumnSizes.length; }, set(value) { while (this.gridColumnSizes.length < value) this.gridColumnSizes.push({ type: 'FLEX', value: 1 }); this.gridColumnSizes.length = value; } });
  return { grid, child, figma: { getNodeByIdAsync: async (id) => id === grid.id ? grid : id === child.id ? child : id === source.id ? source : null } };
}

test('auto-layout grid APIs configure tracks, place children, auto-flow, and reorder', async () => {
  const { grid, child, figma } = gridFixture();
  const result = JSON.parse(await execute(gridSetCode({ nodeId: grid.id, rows: 2, columns: 2, rowGap: 8, rowSizes: [{ type: 'FIXED', value: 100 }, { type: 'FLEX', value: 1 }] }), figma));
  assert.equal(result.after.layoutMode, 'GRID');
  assert.equal(grid.gridRowSizes[0].type, 'FIXED');
  const placed = JSON.parse(await execute(gridPlaceCode({
    gridId: grid.id, childId: child.id, row: 1, column: 1,
  }), figma));
  assert.equal(placed.outcome, 'verified');
  assert.equal(child.gridRowAnchorIndex, 1);
  const autoFlow = JSON.parse(await execute(gridAutoFlowCode({ nodeId: grid.id, autoTracks: 'rows', positioning: 'row_auto_flow' }), figma));
  assert.equal(autoFlow.outcome, 'verified');
  assert.equal(grid.gridItemsPositioning, 'ROW_AUTO_FLOW');
  const reordered = JSON.parse(await execute(gridTrackReorderCode({
    nodeId: grid.id, axis: 'rows', from: '0', insertionIndex: 2,
  }), figma));
  assert.equal(reordered.moves[0].from, 0);
});

test('occupied native grids grow without resetting layout mode', async () => {
  const { grid, child, figma } = gridFixture();
  let mode = 'GRID';
  Object.defineProperty(grid, 'layoutMode', {
    configurable: true,
    get: () => mode,
    set: (next) => {
      if (mode === 'GRID' && next === 'GRID') throw new Error('Cannot delete occupied row/column');
      mode = next;
    },
  });
  grid.gridRowCount = 1;
  grid.gridColumnCount = 1;
  grid.appendChildAt(child, 0, 0);

  const result = JSON.parse(await execute(gridSetCode({ nodeId: grid.id, rows: 2 }), figma));

  assert.equal(result.after.layoutMode, 'GRID');
  assert.equal(grid.gridRowCount, 2);
  assert.equal(child.gridRowAnchorIndex, 0);
});

test('typed grid placement preserves explicit spans and alignment', async () => {
  const { grid, child, figma } = gridFixture();
  grid.layoutMode = 'GRID';
  grid.gridRowCount = 3;
  grid.gridColumnCount = 4;

  const result = JSON.parse(await execute(gridPlaceCode({
    gridId: grid.id,
    childId: child.id,
    row: 1,
    column: 1,
    rowSpan: 2,
    columnSpan: 3,
    horizontalAlign: 'center',
    verticalAlign: 'max',
  }), figma));

  assert.equal(result.child.rowSpan, 2);
  assert.equal(result.child.columnSpan, 3);
  assert.equal(result.child.horizontalAlign, 'CENTER');
  assert.equal(result.child.verticalAlign, 'MAX');
  assert.equal(child.gridRowSpan, 2);
  assert.equal(child.gridColumnSpan, 3);
});

test('slot APIs validate settings, configure the generated SLOT property, validate, and reset', async () => {
  assert.deepEqual(parseSlotSettings('{"minChildren":1,"maxChildren":2}'), { minChildren: 1, maxChildren: 2 });
  assert.throws(() => parseSlotSettings({ minChildren: 3, maxChildren: 2 }), /minChildren/);
  const slot = { id: 'S:1', name: 'Slot', type: 'SLOT', children: [], limitViolations: ['BELOW_MIN'], resetSlot() { this.limitViolations = []; } };
  const component = {
    id: 'C:1', name: 'Card', type: 'COMPONENT', remote: false, componentPropertyDefinitions: {},
    createSlot() { this.componentPropertyDefinitions['Slot#1'] = { type: 'SLOT', defaultValue: '' }; return slot; },
    editComponentProperty(name, update) { this.componentPropertyDefinitions[name] = { ...this.componentPropertyDefinitions[name], ...update }; return name; },
  };
  const figma = { currentPage: { type: 'PAGE', findAll: () => [slot] }, getNodeByIdAsync: async (id) => id === component.id ? component : slot };
  const created = await execute(slotCreateCode({ componentId: component.id, name: 'Content', settings: { minChildren: 1 } }), figma);
  assert.equal(created.propertyName, 'Slot#1');
  assert.equal((await execute(slotValidateCode({}), figma)).valid, false);
  await execute(slotResetCode({ nodeId: slot.id }), figma);
  assert.deepEqual(slot.limitViolations, []);
});

test('Draw APIs use native text-path, transform, brush, width-profile, and async pattern methods', async () => {
  const base = { id: 'V:1', name: 'Circle', type: 'ELLIPSE', x: 0, parent: null, complexStrokeProperties: { type: 'BASIC' }, variableWidthStrokeProperties: null, fills: [], strokes: [], async setFillsAsync(value) { this.fills = value; }, async setStrokesAsync(value) { this.strokes = value; } };
  const other = { id: 'V:2', name: 'Dot', type: 'ELLIPSE', x: 1 };
  const page = { type: 'PAGE', children: [base, other] };
  const figma = {
    editorType: 'figma', mixed: Symbol('mixed'), currentPage: page, loadFontAsync: async () => {}, loadBrushesAsync: async () => {},
    getNodeByIdAsync: async (id) => id === base.id ? base : id === other.id ? other : null,
    createTextPath(node, segment, position) { return { ...node, type: 'TEXT_PATH', textPathStartData: { segment, position }, characters: '', fontName: null }; },
    transformGroup(nodes, parent, index, modifiers) { return { id: 'TG:1', name: 'Group', type: 'TRANSFORM_GROUP', children: nodes, parent, index, transformModifiers: modifiers }; },
  };
  assert.equal((await execute(drawTextPathCode({ nodeId: base.id, text: 'Hello' }), figma)).characters, 'Hello');
  assert.equal((await execute(drawTransformGroupCode({ nodeIds: 'V:1,V:2', modifiers: [{ type: 'REPEAT', repeatType: 'RADIAL', count: 4, unitType: 'PIXELS', offset: 20 }] }), figma)).type, 'TRANSFORM_GROUP');
  await execute(drawBrushCode({ nodeId: base.id, properties: { type: 'BRUSH', brushType: 'STRETCH', brushName: 'NOIR', direction: 'FORWARD' } }), figma);
  assert.equal(base.complexStrokeProperties.brushName, 'NOIR');
  await execute(drawStrokeProfileCode({ nodeId: base.id, preset: 'TAPER' }), figma);
  assert.equal(base.variableWidthStrokeProperties.widthProfile, 'TAPER');
  await execute(drawPatternCode({ nodeId: base.id, sourceNodeId: other.id, field: 'fill' }), figma);
  assert.equal(base.fills[0].type, 'PATTERN');
});
