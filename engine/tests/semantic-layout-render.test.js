import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient } from '../src/lib/jsx-render.js';

describe('semantic Grid renderer', () => {
  it('creates native Grid tracks and places/spans children', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Shell" flex="grid" w="1440" h="1000" gridColumns="fixed:236,flex" gridRows="fixed:1000" columnGap="0" rowGap="0" pt="10" pr="20" pb="30" pl="40">' +
      '<Frame name="Sidebar" gridRow="1" gridColumn="1" w="fill" h="fill" />' +
      '<Frame name="Workspace" gridRow="1" gridColumn="2" gridRowSpan="1" gridColumnSpan="1" w="fill" h="fill" />' +
      '</Frame>',
    );
    assert.match(code, /layoutMode = 'GRID'/);
    assert.match(code, /gridColumnCount = 2/);
    assert.match(code, /gridRowCount = 1/);
    assert.match(code, /gridColumnSizes\[0\]\.type = 'FIXED'/);
    assert.match(code, /gridColumnSizes\[0\]\.value = 236/);
    assert.match(code, /gridColumnSizes\[1\]\.type = 'FLEX'/);
    assert.match(code, /paddingTop = 10/);
    assert.match(code, /paddingRight = 20/);
    assert.match(code, /paddingBottom = 30/);
    assert.match(code, /paddingLeft = 40/);
    assert.match(code, /setGridChildPosition\(0, 1\)/);
    assert.match(code, /gridRowSpan = 1/);
    assert.match(code, /gridColumnSpan = 1/);
  });

  it('places direct text nodes in native Grid cells', async () => {
    const client = new FigmaClient();
    const jsx = '<Frame name="Metadata" flex="grid" gridColumns="fixed:12,flex" gridRows="fixed:12,fixed:17">' +
      '<Text gridRow="1" gridColumn="2">Design handoff</Text>' +
      '<Frame name="Signal" gridRow="1" gridColumn="1" w="8" h="8" />' +
      '<Text gridRow="2" gridColumn="2">312</Text>' +
      '</Frame>';
    const code = await client.parseJSX(jsx);

    assert.deepEqual(client.validateJsxProps(jsx), []);
    assert.match(code, /Text: Design handoff[\s\S]*setGridChildPosition\(0, 1\)/);
    assert.match(code, /Text: 312[\s\S]*setGridChildPosition\(1, 1\)/);
  });

  it('preserves asymmetric root padding on Flexbox Auto Layout', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX('<Frame name="Sidebar" flex="col" pt="26" pr="18" pb="20" pl="18"><Text>Hi</Text></Frame>');
    assert.match(code, /layoutMode = 'VERTICAL'/);
    assert.match(code, /paddingTop = 26/);
    assert.match(code, /paddingRight = 18/);
    assert.match(code, /paddingBottom = 20/);
    assert.match(code, /paddingLeft = 18/);
  });

  it('keeps an explicit measured text width instead of forcing parent fill', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Title" flex="col" w="228"><Text w="274" size="22">Team command center</Text></Frame>',
    );
    const textBlock = code.slice(code.indexOf('Text: Team command center'));
    assert.match(textBlock, /textAutoResize = 'HEIGHT';[^]*resize\(274,/);
    assert.doesNotMatch(textBlock, /layoutSizingHorizontal = 'FILL'/);
  });

  it('keeps hug text intrinsic and maps between to Figma automatic spacing', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Toolbar" flex="row" justify="between" gap="12" w="240">' +
      '<Text w="hug">Left</Text><Text w="hug">Right</Text></Frame>',
    );
    assert.match(code, /primaryAxisAlignItems = 'SPACE_BETWEEN'/);
    assert.match(code, /itemSpacing = 0/);
    assert.doesNotMatch(code, /itemSpacing = 12/);
    assert.match(code, /textAutoResize = 'WIDTH_AND_HEIGHT'/);
    assert.doesNotMatch(code, /Text: Left[^]*layoutSizingHorizontal = 'FILL'/);
  });

  it('renders individual frame stroke weights natively', async () => {
    const client = new FigmaClient();
    const jsx = '<Frame name="Active" stroke="#9fd624" strokeAlign="inside" ' +
      'strokeTopWidth="0" strokeRightWidth="0" strokeBottomWidth="0" strokeLeftWidth="3" />';
    const code = await client.parseJSX(jsx);
    const nestedCode = await client.parseJSX(`<Frame name="Root">${jsx}</Frame>`);
    const batchCode = await client.parseJSXBatch([jsx]);

    assert.deepEqual(client.validateJsxProps(jsx), []);
    assert.match(code, /frame\.strokeTopWeight = 0/);
    assert.match(code, /frame\.strokeRightWeight = 0/);
    assert.match(code, /frame\.strokeBottomWeight = 0/);
    assert.match(code, /frame\.strokeLeftWeight = 3/);
    assert.match(nestedCode, /el\d+\.strokeLeftWeight = 3/);
    assert.match(batchCode, /f0\.strokeLeftWeight = 3/);
  });

  it('preserves CSS shadow spread in native Figma effects', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Inset" bg="#ffffff" innerShadow="3 0 0 2 #9fd624" />',
    );

    assert.match(code, /type:'INNER_SHADOW'[^]*offset:\{x:3,y:0\}[^]*radius:0,spread:2/);
  });

  it('preserves CSS fr weights in native Figma Grid tracks', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Content" flex="grid" gridColumns="flex:1.3,flex:0.7" gridRows="flex">' +
      '<Frame gridRow="1" gridColumn="1" /><Frame gridRow="1" gridColumn="2" />' +
      '</Frame>',
    );
    assert.match(code, /gridColumnSizes\[0\]\.type = 'FLEX'; frame\.gridColumnSizes\[0\]\.value = 1\.3/);
    assert.match(code, /gridColumnSizes\[1\]\.type = 'FLEX'; frame\.gridColumnSizes\[1\]\.value = 0\.7/);
  });

  it('analyzes hand-authored JSX through the semantic model', () => {
    const client = new FigmaClient();
    const model = client.analyzeJSX(
      '<Frame name="Card" flex="col" bg="var:surface/card">' +
      '<Frame name="Row" flex="row"><Text color="var:text/primary">Hello</Text></Frame>' +
      '<Frame name="Badge" position="absolute" x="8" y="8" />' +
      '</Frame>',
    );
    assert.equal(model.root.layout.kind, 'flex');
    assert.equal(model.root.children[0].layout.direction, 'row');
    assert.equal(model.root.children[1].positioning.kind, 'absolute');
    assert.equal(model.diagnostics.absoluteNodes, 1);
    assert.equal(model.diagnostics.tokenReferences, 2);
    assert.equal(model.diagnostics.unclassifiedFallbacks.length, 0);
  });

  it('refuses structurally invalid JSX before code generation', async () => {
    const client = new FigmaClient();
    await assert.rejects(
      client.parseJSX('<Frame name="NotGrid" flex="col"><Frame gridColumn="2" /></Frame>'),
      /grid cell props outside a Grid parent/,
    );
    await assert.rejects(
      client.parseJSX('<Frame name="BrokenGrid" flex="grid" gridColumns="flex" />'),
      /row tracks missing/,
    );
  });

  it('carries authored color fallbacks into deterministic variable creation', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="TokenCard" bg="var:surface/card|#f5f5f1" stroke="var:border/subtle|#d9d9d4" />',
    );
    assert.match(code, /createVariable\(variableName, collection, 'COLOR'\)/);
    assert.match(code, /boundFill\(lookupVar\("surface\/card"\), "surface\/card", "#f5f5f1"\)/);
    assert.match(code, /boundFill\(lookupVar\("border\/subtle"\), "border\/subtle", "#d9d9d4"\)/);
    assert.match(code, /createdVariables/);
  });

  it('creates and binds a missing authored color variable at runtime', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX('<Frame name="TokenCard" bg="var:surface/runtime-test|#336699" />');
    const created = [];
    const collection = { id: 'collection:1', name: 'Tokens', modes: [{ modeId: 'mode:1' }] };
    const figma = {
      loadFontAsync: async () => {},
      currentPage: { children: [] },
      createFrame() {
        return {
          id: 'frame:1', name: '', width: 0, height: 0, children: [], paddingBottom: 0,
          resize(w, h) { this.width = w; this.height = h; },
          remove() {},
        };
      },
      variables: {
        getLocalVariableCollectionsAsync: async () => [collection],
        getLocalVariablesAsync: async () => [],
        createVariableCollection: () => collection,
        createVariable(name, col, type) {
          const variable = {
            id: `variable:${created.length + 1}`, name, variableCollectionId: col.id, resolvedType: type,
            valuesByMode: {}, setValueForMode(modeId, value) { this.valuesByMode[modeId] = value; },
          };
          created.push(variable);
          return variable;
        },
        setBoundVariableForPaint(paint, field, variable) { return { ...paint, boundVariables: { [field]: variable.id } }; },
      },
    };
    for (const key of ['__varsCache', '__varsCacheFilter', '__varsCacheTime', '__varsByCollection', '__varCollections', '__unresolvedVars', '__createdVars', '__variableScopeQuestions', '__loadedFonts']) {
      delete globalThis[key];
    }
    const result = await new Function('figma', `return ${code.trim()}`)(figma);
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'surface/runtime-test');
    assert.deepEqual(created[0].valuesByMode['mode:1'], { r: 0.2, g: 0.4, b: 0.6 });
    assert.deepEqual(result.createdVariables, ['Tokens/surface/runtime-test']);
    assert.equal(result.scopeQuestions[0].status, 'USER_DECISION_REQUIRED');
    assert.equal(result.scopeQuestions[0].name, 'surface/runtime-test');
    assert.ok(result.scopeQuestions[0].allowedScopes.includes('FRAME_FILL'));
  });
});
