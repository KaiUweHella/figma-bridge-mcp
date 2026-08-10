import assert from 'node:assert/strict';
import test from 'node:test';
import { shaderApplyCode, shaderImportCode, shaderListCode } from '../src/lib/shader-management.js';
import { gridLayoutAutoFlowCode, gridLayoutPlaceCode, gridLayoutReorderCode, gridLayoutSetCode } from '../src/lib/grid-layout-management.js';
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
  const child = { id: '2:2', name: 'Child', type: 'RECTANGLE', x: 0, gridRowAnchorIndex: 0, gridColumnAnchorIndex: 0 };
  const grid = {
    id: '1:1', name: 'Grid', type: 'FRAME', layoutMode: 'NONE', gridRowGap: 0, gridColumnGap: 0,
    gridAutoTracks: 'NONE', gridItemsPositioning: 'MANUAL', gridRowSizes: [], gridColumnSizes: [], children: [],
    appendChildAt(node, row, column) { this.children.push(node); node.gridRowAnchorIndex = row; node.gridColumnAnchorIndex = column; },
    reorderRows: ({ fromIndices, insertionIndex }) => fromIndices.map((from) => ({ from, to: insertionIndex - 1 })),
    reorderColumns: () => [],
  };
  Object.defineProperty(grid, 'gridRowCount', { get() { return this.gridRowSizes.length; }, set(value) { while (this.gridRowSizes.length < value) this.gridRowSizes.push({ type: 'FLEX', value: 1 }); this.gridRowSizes.length = value; } });
  Object.defineProperty(grid, 'gridColumnCount', { get() { return this.gridColumnSizes.length; }, set(value) { while (this.gridColumnSizes.length < value) this.gridColumnSizes.push({ type: 'FLEX', value: 1 }); this.gridColumnSizes.length = value; } });
  return { grid, child, figma: { getNodeByIdAsync: async (id) => id === grid.id ? grid : id === child.id ? child : null } };
}

test('auto-layout grid APIs configure tracks, place children, auto-flow, and reorder', async () => {
  const { grid, child, figma } = gridFixture();
  const result = await execute(gridLayoutSetCode({ nodeId: grid.id, rows: 2, columns: 2, rowGap: 8, rowSizes: [{ type: 'FIXED', value: 100 }, { type: 'FLEX', value: 1 }] }), figma);
  assert.equal(result.after.layoutMode, 'GRID');
  assert.equal(grid.gridRowSizes[0].type, 'FIXED');
  await execute(gridLayoutPlaceCode({ gridId: grid.id, childId: child.id, row: 1, column: 1 }), figma);
  assert.equal(child.gridRowAnchorIndex, 1);
  await execute(gridLayoutAutoFlowCode({ nodeId: grid.id, autoTracks: 'rows', positioning: 'row_auto_flow' }), figma);
  assert.equal(grid.gridItemsPositioning, 'ROW_AUTO_FLOW');
  assert.equal((await execute(gridLayoutReorderCode({ nodeId: grid.id, axis: 'rows', from: '0', insertionIndex: 2 }), figma)).moves[0].from, 0);
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
