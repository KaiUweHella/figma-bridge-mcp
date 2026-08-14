import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FigmaClient } from '../src/lib/jsx-render.js';
import { executeStructuredRenderPlan, executeStructuredRenderPlanBatch, inspectStructuredRenderPlan } from '../src/lib/structured-render-executor.js';
import { VARIABLE_SCOPES_BY_TYPE } from '../src/lib/variable-scope-policy.js';

function extractStructuredRenderRuntime(source) {
  return source
    .replace(/\r\n?/g, '\n')
    .match(/\/\/ BEGIN STRUCTURED RENDER RUNTIME\n([\s\S]+?)\/\/ END STRUCTURED RENDER RUNTIME/)?.[1];
}

describe('structured Semantic Render Plan executor', () => {
  it('preflights the whole plan and rejects unsupported facts without writes', async () => {
    const client = new FigmaClient();
    const plan = client.planJSX('<Frame name="Unsupported" filter="brightness(1.2)"><Text>Hello</Text></Frame>');
    const figma = fakeFigma();

    assert.equal(inspectStructuredRenderPlan(plan).supported, false);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /brightness\(\)/);
    assert.equal(figma.created.length, 0);
  });

  it('creates native Auto Layout and text from a supported plan', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Card" flex="col" w="240" h="120" gap="8" p="12" bg="#ffffff">' +
      '<Text name="Title" size="16" weight="600" color="#111111">Hello</Text></Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    const result = await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.type === 'FRAME');
    const text = figma.created.find((node) => node.type === 'TEXT');

    assert.equal(result.executor, 'structured-v1');
    assert.equal(frame.layoutMode, 'VERTICAL');
    assert.equal(frame.itemSpacing, 8);
    assert.equal(frame.paddingTop, 12);
    assert.equal(frame.children[0], text);
    assert.equal(text.characters, 'Hello');
    assert.deepEqual(text.fontName, { family: 'Inter', style: 'Semi Bold' });
    assert.match(text.textStyleId, /^text-style:/);
    assert.deepEqual(result.textStyleReport, { references: 1, reused: 0, created: 1, bound: 1 });
    assert.equal(result.structuralReport.passed, true);
    assert.deepEqual(result.structuralReport.summary, {
      nodes: 2, grids: 0, autoLayouts: 1, freeLayouts: 0,
      instances: 0, absoluteNodes: 0,
    });
    assert.equal(frame.getPluginData('figmaBridge.semanticPath'), plan.root.path);
    assert.equal(frame.getPluginData('figmaBridge.semanticIndex'), '0');
    assert.equal(frame.getPluginData('figmaBridge.renderPlanVersion'), '1');
    assert.equal(text.getPluginData('figmaBridge.semanticPath'), plan.root.children[0].path);
  });

  it('adds deduplicated native Figma annotations and machine-readable metadata for lossy fallbacks', async () => {
    const plan = new FigmaClient().planJSX('<Frame name="Fallback" stroke="#ff0000" strokeWidth="2" />');
    plan.root.fallbackAnnotations = [{
      policy: 'border.single-paint-native',
      fact: 'different border paints per side',
      labelMarkdown: '**CSS → Figma Fallback**\n\nPer-side paints are not supported.',
      properties: ['strokes', 'strokeWeight'],
    }];
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    const result = await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Fallback');

    assert.deepEqual(frame.annotations, [{
      labelMarkdown: '**CSS → Figma Fallback**\n\nPer-side paints are not supported.',
      properties: [{ type: 'strokes' }, { type: 'strokeWeight' }],
    }]);
    assert.deepEqual(JSON.parse(frame.getPluginData('figmaBridge.fallbackAnnotations')), {
      schemaVersion: 1,
      annotations: [{ policy: 'border.single-paint-native', fact: 'different border paints per side' }],
    });
    assert.deepEqual(result.fallbackAnnotationReport, {
      requested: 1, applied: 1, deduplicated: 0, unsupported: 0,
    });
  });

  it('rejects malformed fallback annotation intent before canvas mutation', async () => {
    const plan = new FigmaClient().planJSX('<Frame />');
    plan.root.fallbackAnnotations = [{
      policy: 'border.single-paint-native', labelMarkdown: 'Fallback', properties: ['not-a-figma-property'],
    }];
    const figma = fakeFigma();

    assert.match(inspectStructuredRenderPlan(plan).problems.join('\n'), /unsupported Figma annotation property/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /unsupported Figma annotation property/);
    assert.equal(figma.created.length, 0);
  });

  it('creates and then exactly reuses a semantic named Text Style', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Typography"><Text style="Typography/Eyebrow" font="DM Sans" size="10" weight="700" lineHeight="13" letterSpacing="1.2">SYSTEM MAP</Text></Frame>',
    );
    const figma = fakeFigma();

    const first = await executeStructuredRenderPlan(figma, plan);
    const firstText = figma.created.find((node) => node.type === 'TEXT');
    const style = figma.localTextStyles.find((candidate) => candidate.name === 'Typography/Eyebrow');
    assert.ok(style);
    assert.equal(firstText.textStyleId, style.id);
    assert.deepEqual(first.textStyleReport, { references: 1, reused: 0, created: 1, bound: 1 });
    assert.deepEqual(first.createdTextStyles, ['Typography/Eyebrow']);

    const second = await executeStructuredRenderPlan(figma, plan);
    const texts = figma.created.filter((node) => node.type === 'TEXT');
    assert.equal(texts.at(-1).textStyleId, style.id);
    assert.equal(figma.localTextStyles.filter((candidate) => candidate.name === 'Typography/Eyebrow').length, 1);
    assert.deepEqual(second.textStyleReport, { references: 1, reused: 1, created: 0, bound: 1 });
  });

  it('stops when an explicit named Text Style exists with conflicting typography', async () => {
    const conflicting = {
      id: 'text-style:existing', name: 'Typography/Eyebrow',
      fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
      lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 },
      paragraphSpacing: 0, paragraphIndent: 0,
    };
    const figma = fakeFigma({ textStyles: [conflicting] });
    const plan = new FigmaClient().planJSX('<Frame><Text style="Typography/Eyebrow" size="10">Label</Text></Frame>');

    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /exists with different typography/);
    assert.equal(figma.created.length, 0);
    assert.equal(figma.localTextStyles.length, 1);
  });

  it('reconciles Figma float32 style metrics with the equivalent CSS scalar', async () => {
    const existing = {
      id: 'text-style:eyebrow', name: 'Typography/Eyebrow',
      fontName: { family: 'DM Sans', style: 'Bold' }, fontSize: 11,
      lineHeight: { unit: 'AUTO' },
      letterSpacing: { unit: 'PIXELS', value: 1.5399999618530273 },
      paragraphSpacing: 0, paragraphIndent: 0,
    };
    const figma = fakeFigma({ textStyles: [existing] });
    const plan = new FigmaClient().planJSX(
      '<Frame><Text style="Typography/Eyebrow" font="DM Sans" size="11" weight="700" letterSpacing="1.54">Label</Text></Frame>',
    );

    const result = await executeStructuredRenderPlan(figma, plan);
    assert.equal(figma.created.find((node) => node.type === 'TEXT').textStyleId, existing.id);
    assert.deepEqual(result.textStyleReport, { references: 1, reused: 1, created: 0, bound: 1 });
  });

  it('maps wrapped Flex axis gaps to native Auto Layout spacing', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Wrap" flex="row" w="300" h="160" wrap="true" columnGap="16" rowGap="12">' +
      '<Frame name="A" w="140" h="40"/><Frame name="B" w="140" h="40"/><Frame name="C" w="140" h="40"/>' +
      '</Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Wrap');

    assert.equal(frame.layoutMode, 'HORIZONTAL');
    assert.equal(frame.layoutWrap, 'WRAP');
    assert.equal(frame.itemSpacing, 16);
    assert.equal(frame.counterAxisSpacing, 12);
    assert.equal(figma.localVariables.find((variable) => variable.id === frame.boundVariables.itemSpacing)?.name, 'space/16px');
    assert.equal(figma.localVariables.find((variable) => variable.id === frame.boundVariables.counterAxisSpacing)?.name, 'space/12px');
  });

  it('keeps space-between automatic while retaining wrapped row spacing', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Between Wrap" flex="row" wrap="true" justify="between" columnGap="99" rowGap="10"><Text>A</Text><Text>B</Text></Frame>',
    );
    const figma = fakeFigma();

    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Between Wrap');
    assert.equal(frame.primaryAxisAlignItems, 'SPACE_BETWEEN');
    assert.equal(frame.itemSpacing, 0);
    assert.equal(frame.boundVariables.itemSpacing, undefined);
    assert.equal(frame.counterAxisSpacing, 10);
  });

  it('maps frame hug aliases and child stretch to native Auto Layout sizing', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Parent" flex="row" w="300" h="100">' +
      '<Frame name="Hug and stretch" flex="col" w="80" h="80" hug="height" stretch="true"><Text>Child</Text></Frame>' +
      '</Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const child = figma.created.find((node) => node.name === 'Hug and stretch');

    assert.equal(child.primaryAxisSizingMode, 'AUTO');
    assert.equal(child.counterAxisSizingMode, 'FIXED');
    assert.equal(child.layoutSizingVertical, 'FILL');
  });

  it('rejects malformed frame hug and stretch intent before writing', async () => {
    const plan = new FigmaClient().planJSX('<Frame hug="sometimes" stretch="yes"/>');
    const figma = fakeFigma();
    const problems = inspectStructuredRenderPlan(plan).problems.join('\n');

    assert.match(problems, /hug must be/);
    assert.match(problems, /stretch must be/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /stretch must be/);
    assert.equal(figma.created.length, 0);
  });

  it('maps overflow clipping plus raster mask and blend semantics without flattening', async () => {
    const client = new FigmaClient();
    client.setImageData({ photo: 'aGVsbG8=' });
    const plan = client.planJSX(
      '<Frame name="Clip" overflow="hidden"><Image name="Mask photo" src="imgref:photo" blendMode="multiply" mask="luminance" /></Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Clip');
    const image = figma.created.find((node) => node.name === 'Mask photo');

    assert.equal(frame.clipsContent, true);
    assert.equal(image.blendMode, 'MULTIPLY');
    assert.equal(image.isMask, true);
    assert.equal(image.maskType, 'LUMINANCE');
  });

  it('preserves native text truncation, masks, and approved variable-font intent', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Typography"><Text name="Clamp" w="120" truncate="true" maxLines="2" mask="alpha" fontAxes="wght=615,wdth=92">A long text value that wraps</Text></Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const text = figma.created.find((node) => node.name === 'Clamp');

    assert.equal(text.textTruncation, 'ENDING');
    assert.equal(text.maxLines, 2);
    assert.equal(text.isMask, true);
    assert.equal(text.maskType, 'ALPHA');
    assert.deepEqual(JSON.parse(text.getPluginData('figmaBridge.variableFontAxes')), {
      schemaVersion: 1,
      ranges: [{ start: 0, end: 28, axes: { wght: 615, wdth: 92 } }],
    });
  });

  it('rejects malformed text clamp and font-axis intent before canvas mutation', async () => {
    const plan = new FigmaClient().planJSX('<Frame><Text maxLines="0" fontAxes="weight=600">Bad</Text></Frame>');
    const figma = fakeFigma();

    const problems = inspectStructuredRenderPlan(plan).problems.join('\n');
    assert.match(problems, /maxLines must be a positive integer/);
    assert.match(problems, /fontAxes entry/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /maxLines must be a positive integer/);
    assert.equal(figma.created.length, 0);
  });

  it('creates native Grid tracks and places children structurally', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Grid" flex="grid" w="400" h="200" gridColumns="fixed:120,flex" gridRows="flex" columnGap="16">' +
      '<Frame name="Sidebar" gridRow="1" gridColumn="1" w="fill" h="fill" />' +
      '<Frame name="Content" gridRow="1" gridColumn="2" w="fill" h="fill" />' +
      '</Frame>',
    );
    const figma = fakeFigma();
    const result = await executeStructuredRenderPlan(figma, plan);
    const grid = figma.created.find((node) => node.name === 'Grid');

    assert.equal(result.executor, 'structured-v1');
    assert.equal(grid.layoutMode, 'GRID');
    assert.deepEqual(grid.gridColumnSizes, [{ type: 'FIXED', value: 120 }, { type: 'FLEX', value: 1 }]);
    assert.equal(grid.gridColumnGap, 16);
    assert.deepEqual(grid.children.map((node) => node.gridPosition), [[0, 0], [0, 1]]);
    assert.ok(grid.children.every((node) => node.layoutSizingHorizontal === 'FILL'));
  });

  it('rejects malformed Grid tracks before creating the root frame', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Grid" flex="grid" gridColumns="flex" gridRows="flex"><Text>A</Text></Frame>',
    );
    plan.root.source.props.gridColumns = 'minmax(20px, 1fr)';
    const figma = fakeFigma();

    assert.match(inspectStructuredRenderPlan(plan).problems.join('\n'), /unsupported Grid track/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /unsupported Grid track/);
    assert.equal(figma.created.length, 0);
  });

  it('rejects overlapping explicit Grid cells before creating nodes', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Grid" flex="grid" gridColumns="flex,flex" gridRows="flex">' +
      '<Text gridRow="1" gridColumn="1">A</Text><Text gridRow="1" gridColumn="1">B</Text></Frame>',
    );
    const figma = fakeFigma();

    assert.match(inspectStructuredRenderPlan(plan).problems.join('\n'), /overlaps cell 1:1/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /overlaps cell 1:1/);
    assert.equal(figma.created.length, 0);
  });

  it('resolves a missing requested font to the loaded fallback before mutation', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Card"><Text font="Missing Sans" weight="700">Fallback</Text></Frame>',
    );
    const figma = fakeFigma();
    figma.loadFontAsync = async (font) => {
      if (font.family === 'Missing Sans') throw new Error('missing');
    };

    const result = await executeStructuredRenderPlan(figma, plan);
    const text = figma.created.find((node) => node.type === 'TEXT');
    assert.deepEqual(text.fontName, { family: 'Inter', style: 'Bold' });
  });

  it('resolves compact DM Sans and Manrope named faces before falling back families', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame><Text name="DM" font="DM Sans" weight="600">DM</Text><Text name="Manrope" font="Manrope" weight="800">Manrope</Text></Frame>',
    );
    const figma = fakeFigma({
      loadFont: async (font) => {
        if (['Semi Bold', 'Extra Bold'].includes(font.style)) throw new Error('spaced face unavailable');
      },
    });

    await executeStructuredRenderPlan(figma, plan);
    assert.deepEqual(figma.created.find((node) => node.name === 'DM').fontName, { family: 'DM Sans', style: 'SemiBold' });
    assert.deepEqual(figma.created.find((node) => node.name === 'Manrope').fontName, { family: 'Manrope', style: 'ExtraBold' });
  });

  it('creates editable Rectangle and Ellipse primitives with native geometry', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Shapes" flex="row">' +
      '<Rect name="Tile" w="40" h="30" bg="#ff000080" rounded="8" roundedTR="4" cornerSmoothing="0.5" />' +
      '<Ellipse name="Ring" w="32" h="32" fill="none" stroke="#00ff00" strokeWidth="2" strokeDashPattern="4 2" strokeCap="round" arc="270" arcStart="-90" innerRadius="0.7" mask="vector" />' +
      '</Frame>',
    );
    const figma = fakeFigma();

    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    await executeStructuredRenderPlan(figma, plan);
    const rect = figma.created.find((node) => node.name === 'Tile');
    const ellipse = figma.created.find((node) => node.name === 'Ring');

    assert.equal(rect.type, 'RECTANGLE');
    assert.deepEqual([rect.width, rect.height, rect.cornerRadius, rect.topRightRadius], [40, 30, 8, 4]);
    assert.equal(rect.cornerSmoothing, 0.5);
    assert.equal(rect.fills[0].opacity, 128 / 255);
    assert.equal(ellipse.type, 'ELLIPSE');
    assert.deepEqual(ellipse.dashPattern, [4, 2]);
    assert.equal(ellipse.strokeCap, 'ROUND');
    assert.equal(ellipse.arcData.innerRadius, 0.7);
    assert.equal(ellipse.isMask, true);
    assert.equal(ellipse.maskType, 'VECTOR');
  });

  it('creates linear, radial, angular, and diamond paints as native gradients', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Gradients" flex="row" bg="linear-gradient(135deg, #112233 0%, #44556680 100%)" stroke="radial-gradient(circle at 60% 40%, #ffffff, transparent 100%)">' +
      '<Text name="Gradient text" color="angular-gradient(#ff0000, #0000ff)">Paint</Text>' +
      '<Rect name="Diamond" fill="diamond-gradient(#000000, rgba(255,255,255,0.5))" />' +
      '</Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Gradients');
    const text = figma.created.find((node) => node.name === 'Gradient text');
    const diamond = figma.created.find((node) => node.name === 'Diamond');

    assert.equal(frame.fills[0].type, 'GRADIENT_LINEAR');
    assert.equal(frame.fills[0].gradientStops[1].color.a, 128 / 255);
    assert.equal(frame.strokes[0].type, 'GRADIENT_RADIAL');
    assert.ok(Math.abs(frame.strokes[0].gradientTransform[0][2] - 0.1) < 1e-9);
    assert.ok(Math.abs(frame.strokes[0].gradientTransform[1][2] + 0.1) < 1e-9);
    assert.equal(frame.strokes[0].gradientStops[1].color.a, 0);
    assert.equal(text.fills[0].type, 'GRADIENT_ANGULAR');
    assert.equal(diamond.fills[0].type, 'GRADIENT_DIAMOND');
  });

  it('preserves multiple CSS gradient layers as ordered editable Figma fills', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Layered" w="320" h="220" bg="linear-gradient(135deg, #112233 0%, #445566 100%), radial-gradient(circle at 65% 35%, #ffffff80 0%, transparent 100%)">' +
      '<Rect name="Layered tile" w="80" h="60" fill="diamond-gradient(#ff0000, transparent), angular-gradient(#00ff00, #0000ff)" />' +
      '</Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Layered');
    const rect = figma.created.find((node) => node.name === 'Layered tile');

    assert.deepEqual(frame.fills.map((paint) => paint.type), ['GRADIENT_LINEAR', 'GRADIENT_RADIAL']);
    assert.deepEqual(rect.fills.map((paint) => paint.type), ['GRADIENT_DIAMOND', 'GRADIENT_ANGULAR']);
  });

  it('aspect-corrects CSS gradient angles for non-square Figma nodes', async () => {
    const plan = new FigmaClient().planJSX('<Frame name="Wide" w="320" h="220" bg="linear-gradient(135deg, #000000, #ffffff)" />');
    const figma = fakeFigma();

    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Wide');
    const transform = frame.fills[0].gradientTransform;
    const dx = transform[0][0] / frame.width;
    const dy = transform[0][1] / frame.height;
    const angle = Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);

    assert.equal(angle, 135);
  });

  it('rejects malformed native gradients before creating canvas nodes', async () => {
    const plan = new FigmaClient().planJSX('<Frame bg="linear-gradient(#fff)"><Text>Bad paint</Text></Frame>');
    const figma = fakeFigma();

    assert.match(inspectStructuredRenderPlan(plan).problems.join('\n'), /paint needs the compatibility executor/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /paint needs the compatibility executor/);
    assert.equal(figma.created.length, 0);
  });

  it('creates embedded raster assets as native editable Image paints', async () => {
    const client = new FigmaClient();
    client.setImageData({ hero: 'aGVsbG8=' });
    const plan = client.planJSX(
      '<Frame name="Gallery"><Image name="Hero" src="imgref:hero" w="200" h="120" imageScale="fit" rounded="12" roundedTR="4" cornerSmoothing="0.5" /></Frame>',
    );
    const figma = fakeFigma();

    assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
    await executeStructuredRenderPlan(figma, plan);
    const image = figma.created.find((node) => node.name === 'Hero');

    assert.equal(image.type, 'RECTANGLE');
    assert.deepEqual([image.width, image.height, image.cornerRadius, image.topRightRadius], [200, 120, 12, 4]);
    assert.equal(image.cornerSmoothing, 0.5);
    assert.deepEqual(image.fills, [{ type: 'IMAGE', imageHash: 'image:1', scaleMode: 'FIT' }]);
    assert.deepEqual([...figma.imageResources[0].bytes], [104, 101, 108, 108, 111]);
  });

  it('loads remote raster assets before creating their native Image paints', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Gallery"><Image name="Remote" src="https://example.com/hero.png" w="80" h="60" imageScale="crop" /></Frame>',
    );
    const figma = fakeFigma();

    await executeStructuredRenderPlan(figma, plan);
    const image = figma.created.find((node) => node.name === 'Remote');

    assert.equal(figma.imageResources[0].src, 'https://example.com/hero.png');
    assert.deepEqual(image.fills, [{ type: 'IMAGE', imageHash: 'image:1', scaleMode: 'CROP' }]);
  });

  it('rejects raster preflight failures before creating canvas nodes', async () => {
    const client = new FigmaClient();
    client.setImageData({ broken: 'aGVsbG8=' });
    const plan = client.planJSX('<Frame><Image src="imgref:broken" /></Frame>');
    const figma = fakeFigma({ createImage: () => { throw new Error('decode failed'); } });

    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /image preflight failed \(decode failed\)/);
    assert.equal(figma.created.length, 0);
  });

  it('executes and positions multiple plans through the same native executor', async () => {
    const client = new FigmaClient();
    const plans = [
      client.planJSX('<Frame name="One" w="120" h="80"><Text>One</Text></Frame>'),
      client.planJSX('<Frame name="Two" w="90" h="60"><Text>Two</Text></Frame>'),
    ];
    const figma = fakeFigma();

    const result = await executeStructuredRenderPlanBatch(figma, plans, { gap: 24, vertical: false });
    const one = figma.created.find((node) => node.name === 'One');
    const two = figma.created.find((node) => node.name === 'Two');

    assert.equal(result.executor, 'structured-batch-v1');
    assert.deepEqual(result.frames.map((frame) => frame.name), ['One', 'Two']);
    assert.deepEqual([one.x, one.y, two.x, two.y], [0, 100, 144, 100]);
  });

  it('preflights every batch plan and leaves no canvas roots for an unsupported plan', async () => {
    const client = new FigmaClient();
    const plans = [
      client.planJSX('<Frame name="One"><Text>One</Text></Frame>'),
      client.planJSX('<Frame name="Two" filter="brightness(1.2)" />'),
    ];
    const figma = fakeFigma();

    await assert.rejects(() => executeStructuredRenderPlanBatch(figma, plans), /plan 2.*brightness/);
    assert.equal(figma.currentPage.children.length, 0);
  });

  it('creates native per-side strokes, corners, and ordered editable effects on frames', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Styled" w="240" h="120" bg="#ffffff" clip="true" stroke="#65a30d" strokeWidth="2" strokeAlign="inside" ' +
      'strokeDashPattern="6 3" strokeCap="round" strokeLeftWidth="5" strokeTopWidth="0" ' +
      'rounded="12" roundedTL="4" cornerSmoothing="0.6" ' +
      'filter="blur(2px) drop-shadow(0 4px 8px rgba(0,0,0,0.2))" ' +
      'innerShadow="0 0 0 1 #ffffff40" />',
    );
    const figma = fakeFigma();

    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Styled');

    assert.deepEqual(frame.dashPattern, [6, 3]);
    assert.equal(frame.strokeCap, 'ROUND');
    assert.equal(frame.strokeAlign, 'INSIDE');
    assert.equal(frame.strokeLeftWeight, 5);
    assert.equal(frame.strokeTopWeight, 0);
    assert.deepEqual([frame.topLeftRadius, frame.topRightRadius, frame.cornerSmoothing], [4, 12, 0.6]);
    assert.deepEqual(frame.effects.map((effect) => effect.type), ['LAYER_BLUR', 'DROP_SHADOW', 'INNER_SHADOW']);
    assert.deepEqual(frame.effects[1].offset, { x: 0, y: 4 });
    assert.equal(frame.effects[2].spread, 1);
  });

  it('rejects Frame shadow spread that the Figma API cannot represent', async () => {
    const plan = new FigmaClient().planJSX('<Frame name="Invalid spread" innerShadow="0 0 0 2 #00000040" />');
    const figma = fakeFigma();

    assert.match(inspectStructuredRenderPlan(plan).problems.join('\n'), /visible fill and clip=true/);
    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /visible fill and clip=true/);
    assert.equal(figma.created.length, 0);
  });

  it('accepts column-flow CSS Grid intent when children have explicit native cells', () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Pipeline" flex="grid" gridColumns="flex,flex,flex,flex" gridRows="hug" gridAutoFlow="column">' +
      '<Frame name="One" gridRow="1" gridColumn="1" />' +
      '<Frame name="Two" gridRow="1" gridColumn="2" />' +
      '<Frame name="Three" gridRow="1" gridColumn="3" />' +
      '<Frame name="Four" gridRow="1" gridColumn="4" />' +
      '</Frame>',
    );

    assert.deepEqual(inspectStructuredRenderPlan(plan).problems, []);
  });

  it('preserves native Noise, Texture, Progressive Blur, and Glass descriptors', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Effects" noise="duo" noiseDensity="0.3" noiseSize="2" noiseColor="#112233" noiseColor2="#ddeeff" ' +
      'texture="true" textureSize="9" textureRadius="18" textureClip="false" ' +
      'progressiveBlur="24" progressiveBlurDir="right" progressiveBlurStart="3" ' +
      'glass="true" glassRefraction="0.8" glassDepth="40" glassRadius="7" glassDispersion="0.2" glassLight="0.6" glassLightAngle="120" />',
    );
    const figma = fakeFigma();

    await executeStructuredRenderPlan(figma, plan);
    const effects = figma.created.find((node) => node.name === 'Effects').effects;

    assert.deepEqual(effects.map((effect) => effect.type), ['NOISE', 'TEXTURE', 'LAYER_BLUR', 'GLASS']);
    assert.equal(effects[0].noiseType, 'DUOTONE');
    assert.equal(effects[0].blendMode, 'NORMAL');
    assert.deepEqual(effects[0].secondaryColor, { r: 221 / 255, g: 238 / 255, b: 1, a: 1 });
    assert.equal(effects[1].clipToShape, false);
    assert.deepEqual(effects[2].startOffset, { x: 0, y: 0.5 });
    assert.equal(effects[2].startRadius, 3);
    assert.equal(effects[3].refraction, 0.8);
  });

  it('restores captured SVG descendant filters as native effects', async () => {
    const client = new FigmaClient();
    client.setIcons({
      glow: '<svg xmlns="http://www.w3.org/2000/svg"><path id="figma-filter-glow" filter="blur(3px) drop-shadow(1px 2px 4px #00000080)" d="M0 0h8v8H0z"/></svg>',
    });
    const plan = client.planJSX('<Frame><Icon name="glow" preserveColors="true" /></Frame>');
    const figma = fakeFigma();

    await executeStructuredRenderPlan(figma, plan);
    const vector = figma.created.find((node) => node.name === 'figma-filter-glow');
    assert.deepEqual(vector.effects.map((effect) => effect.type), ['LAYER_BLUR', 'DROP_SHADOW']);
    assert.equal(vector.effects[0].blurType, 'NORMAL');
  });

  it('applies common properties to the root node too', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Root" visible="false" locked="true" rotate="12" blendMode="multiply" mask="luminance" />',
    );
    const figma = fakeFigma();

    await executeStructuredRenderPlan(figma, plan);
    const root = figma.created.find((node) => node.name === 'Root');
    assert.deepEqual(
      [root.visible, root.locked, root.rotation, root.blendMode, root.isMask, root.maskType],
      [false, true, 12, 'MULTIPLY', true, 'LUMINANCE'],
    );
  });

  it('creates Registry-identified component variants as real Figma instances', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Instances" flex="row"><Instance entity="ui.button" key="button-set-key" ' +
      'variant="State=Active, Size=Large" name="Primary action" w="140" /></Frame>',
    );
    const figma = fakeFigma({
      components: [{
        key: 'button-set-key', id: '10:1', name: 'Button',
        variants: [
          { id: '10:2', name: 'State=Default, Size=Large', width: 120, height: 40 },
          { id: '10:3', name: 'State=Active, Size=Large', width: 124, height: 44 },
        ],
      }],
    });

    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    await executeStructuredRenderPlan(figma, plan);
    const instance = figma.created.find((node) => node.type === 'INSTANCE');

    assert.equal(instance.name, 'Primary action');
    assert.equal(instance.mainComponent.name, 'State=Active, Size=Large');
    assert.deepEqual([instance.width, instance.height], [140, 44]);
    assert.equal(figma.created.find((node) => node.name === 'Instances').children[0], instance);
  });

  it('falls back from a failed published key to the same Design Entity local anchor', async () => {
    const plan = new FigmaClient().planJSX(
      '<Frame name="Local fallback"><Instance entity="ui.local-button" key="unavailable-published-key" id="30:1" /></Frame>',
    );
    const figma = fakeFigma({
      components: [{ id: '30:1', name: 'Local Button', width: 120, height: 40 }],
    });

    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    await executeStructuredRenderPlan(figma, plan);
    const instance = figma.created.find((node) => node.type === 'INSTANCE');

    assert.equal(instance.mainComponent.id, '30:1');
    assert.equal(instance.mainComponent.name, 'Local Button');
  });

  it('applies Registry-backed property, text, fill, and nested instance overrides', async () => {
    const client = new FigmaClient();
    client.setComponentLinks({
      'ui.icon.leaf': { entityId: 'ui.icon.leaf', key: 'leaf-key' },
    });
    const plan = client.planJSX(
      '<Frame name="Overrides"><Instance entity="ui.card" key="card-key" name="Plant card" ' +
      'prop:Selected="true" prop:Label="Monstera" prop:Icon="ui.icon.leaf" ' +
      'text:CardTitle="Swiss cheese plant" fill:StatusDot="var:status/healthy|#22c55e" ' +
      'swap:LeadingIcon="ui.icon.leaf" /></Frame>',
    );
    const figma = fakeFigma({
      components: [
        {
          id: '10:1', key: 'card-key', name: 'Plant Card', width: 220, height: 120,
          componentPropertyDefinitions: {
            'Selected#10:2': { type: 'BOOLEAN', defaultValue: false },
            'Label#10:3': { type: 'TEXT', defaultValue: 'Plant' },
            'Icon#10:4': { type: 'INSTANCE_SWAP', defaultValue: '10:9' },
          },
          children: [
            { type: 'TEXT', name: 'Card Title', characters: 'Plant', fontName: { family: 'Inter', style: 'Regular' } },
            { type: 'ELLIPSE', name: 'Status Dot', fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
            { type: 'INSTANCE', name: 'Leading Icon' },
          ],
        },
        { id: '20:1', key: 'leaf-key', name: 'Leaf Icon', width: 20, height: 20 },
      ],
    });

    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    await executeStructuredRenderPlan(figma, plan);
    const instance = figma.created.find((node) => node.type === 'INSTANCE' && node.name === 'Plant card');
    const descendants = instance.findAll(() => true);
    const title = descendants.find((node) => node.name === 'Card Title');
    const status = descendants.find((node) => node.name === 'Status Dot');
    const icon = descendants.find((node) => node.name === 'Leading Icon');

    assert.deepEqual(instance.appliedProperties, {
      'Selected#10:2': true,
      'Label#10:3': 'Monstera',
      'Icon#10:4': '20:1',
    });
    assert.equal(title.characters, 'Swiss cheese plant');
    assert.equal(status.fills[0].boundVariables.color, 'variable:1');
    assert.equal(icon.swappedWith.name, 'Leaf Icon');
  });

  it('stops unresolved instance override targets before creating canvas nodes', async () => {
    const client = new FigmaClient();
    client.setComponentLinks({ 'ui.icon.leaf': { key: 'missing-leaf-key' } });
    const plan = client.planJSX(
      '<Frame><Instance entity="ui.card" key="card-key" text:MissingLabel="Nope" swap:Icon="ui.icon.leaf" /></Frame>',
    );
    const figma = fakeFigma({
      components: [{ id: '10:1', key: 'card-key', name: 'Plant Card', children: [{ type: 'INSTANCE', name: 'Icon' }] }],
    });

    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /text:MissingLabel: does not exist/);
    assert.equal(figma.created.length, 0);
  });

  it('stops unresolved or name-guessed components before creating canvas nodes', async () => {
    const missing = new FigmaClient().planJSX(
      '<Frame><Instance entity="ui.missing" key="missing-key" /></Frame>',
    );
    const missingFigma = fakeFigma();
    await assert.rejects(() => executeStructuredRenderPlan(missingFigma, missing), /could not be imported/);
    assert.equal(missingFigma.created.length, 0);

    const guessed = new FigmaClient().planJSX('<Frame><Instance component="Button" /></Frame>');
    const guessedFigma = fakeFigma();
    assert.match(inspectStructuredRenderPlan(guessed).problems.join('\n'), /Registry Design Entity id/);
    await assert.rejects(() => executeStructuredRenderPlan(guessedFigma, guessed), /Registry Design Entity id/);
    assert.equal(guessedFigma.created.length, 0);
  });

  it('imports resolved Icon assets as editable SVG trees and recolors vector paint', async () => {
    const client = new FigmaClient();
    client.setIcons({ mark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#000" d="M0 0h16v16H0z"/></svg>' });
    const plan = client.planJSX(
      '<Frame name="Icons" flex="row"><Icon name="mark" w="32" h="24" color="#336699" /></Frame>',
    );
    const figma = fakeFigma();

    assert.equal(plan.root.children[0].asset.kind, 'project-icon');
    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    await executeStructuredRenderPlan(figma, plan);
    const icon = figma.created.find((node) => node.name === 'mark');

    assert.equal(icon.type, 'FRAME');
    assert.deepEqual([icon.width, icon.height], [32, 24]);
    assert.deepEqual(icon.children[0].fills[0].color, { r: 0.2, g: 0.4, b: 0.6 });
  });

  it('reuses existing COLOR variables without changing their scopes', async () => {
    const surface = fakeVariable('surface/card', 'COLOR', { r: 0.1, g: 0.2, b: 0.3, a: 1 }, ['ALL_FILLS']);
    const figma = fakeFigma({ variables: [surface] });
    const plan = new FigmaClient().planJSX(
      '<Frame name="TokenCard" bg="var:surface/card"><Text color="var:surface/card">Bound</Text></Frame>',
    );

    const result = await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'TokenCard');
    const text = figma.created.find((node) => node.type === 'TEXT');

    assert.equal(result.createdVariables, undefined);
    assert.equal(frame.fills[0].boundVariables.color, surface.id);
    assert.equal(text.fills[0].boundVariables.color, surface.id);
    assert.deepEqual(surface.scopes, ['ALL_FILLS']);
  });

  it('creates missing authored colors and returns an explicit scope question', async () => {
    const figma = fakeFigma();
    const plan = new FigmaClient().planJSX(
      '<Frame name="TokenCard" bg="var:surface/card|#336699" />',
    );

    const result = await executeStructuredRenderPlan(figma, plan);
    const variable = figma.localVariables.find((item) => item.name === 'surface/card');
    const frame = figma.created.find((node) => node.name === 'TokenCard');

    assert.deepEqual(result.createdVariables, ['Tokens/surface/card']);
    assert.equal(result.scopeQuestions[0].status, 'USER_DECISION_REQUIRED');
    assert.deepEqual(result.scopeQuestions[0].allowedScopes, [...VARIABLE_SCOPES_BY_TYPE.COLOR]);
    assert.deepEqual(variable.valuesByMode['mode:1'], { r: 0.2, g: 0.4, b: 0.6, a: 1 });
    assert.equal(frame.fills[0].boundVariables.color, variable.id);
  });

  it('creates and narrowly scopes generated spacing and radius primitives', async () => {
    const figma = fakeFigma();
    const plan = new FigmaClient().planJSX(
      '<Frame name="Card" flex="col" gap="12" p="16" rounded="8"><Text>Tokens</Text></Frame>',
    );

    const result = await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Card');
    const space12 = figma.localVariables.find((item) => item.name === 'space/12px');
    const space16 = figma.localVariables.find((item) => item.name === 'space/16px');
    const radius8 = figma.localVariables.find((item) => item.name === 'radius/8px');

    assert.deepEqual(space12.scopes, ['GAP']);
    assert.deepEqual(space16.scopes, ['GAP']);
    assert.deepEqual(radius8.scopes, ['CORNER_RADIUS']);
    assert.equal(frame.boundVariables.itemSpacing, space12.id);
    assert.equal(frame.boundVariables.paddingLeft, space16.id);
    assert.equal(frame.boundVariables.topLeftRadius, radius8.id);
    assert.equal(result.scopeQuestions, undefined);
  });

  it('uses Figma-compatible names for exact fractional radius primitives', async () => {
    const figma = fakeFigma({
      createVariableHook: (name) => {
        if (name.includes('.')) throw new Error('invalid variable name');
      },
    });
    const plan = new FigmaClient().planJSX('<Frame name="Dot" w="7" h="7" bg="#c9ff58" rounded="3.5" />');

    await executeStructuredRenderPlan(figma, plan);
    const radius = figma.localVariables.find((item) => item.name === 'radius/3-5px');
    const frame = figma.created.find((node) => node.name === 'Dot');

    assert.equal(radius.valuesByMode['mode:1'], 3.5);
    assert.deepEqual(radius.scopes, ['CORNER_RADIUS']);
    assert.equal(frame.boundVariables.topLeftRadius, radius.id);
  });

  it('rolls back variables created earlier in a rejected resource preflight', async () => {
    const figma = fakeFigma({
      createVariableHook: (name) => {
        if (name === 'radius/8px') throw new Error('simulated invalid variable name');
      },
    });
    const plan = new FigmaClient().planJSX('<Frame name="Rejected" p="4" rounded="8" />');

    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /simulated invalid variable name/);
    assert.deepEqual(figma.localVariables, []);
    assert.equal(figma.created.length, 0);
  });

  it('does not guess between authored spacing aliases that merely share a literal value', async () => {
    const compact = fakeVariable('space/5', 'FLOAT', 20, ['GAP']);
    const semantic = fakeVariable('space/xl', 'FLOAT', 20, ['GAP']);
    const figma = fakeFigma({ variables: [compact, semantic] });
    const plan = new FigmaClient().planJSX('<Frame name="Literal" p="20"><Text>Exact generated identity</Text></Frame>');

    const result = await executeStructuredRenderPlan(figma, plan);
    const generated = figma.localVariables.find((variable) => variable.name === 'space/20px');

    assert.ok(generated);
    assert.equal(generated.valuesByMode['mode:1'], 20);
    assert.deepEqual(generated.scopes, ['GAP']);
    assert.deepEqual(result.variableReport, {
      references: 4, reused: 0, created: 1, bound: 4, ambiguous: 0, unsupported: 0,
    });
  });

  it('keeps existing FLOAT scopes and auto-scopes only newly created semantic namespaces', async () => {
    const existing = fakeVariable('spacing/md', 'FLOAT', 14, ['ALL_SCOPES']);
    const figma = fakeFigma({ variables: [existing] });
    const plan = new FigmaClient().planJSX(
      '<Frame name="Card" flex="col" gap="var:spacing/md" p="var:spacing/lg|24" />',
    );

    await executeStructuredRenderPlan(figma, plan);
    const created = figma.localVariables.find((item) => item.name === 'spacing/lg');
    const frame = figma.created.find((node) => node.name === 'Card');

    assert.deepEqual(existing.scopes, ['ALL_SCOPES']);
    assert.deepEqual(created.scopes, ['GAP']);
    assert.equal(frame.boundVariables.itemSpacing, existing.id);
    assert.equal(frame.boundVariables.paddingTop, created.id);
  });

  it('honors the plan collection preference and asks for ambiguous typography scope', async () => {
    const tokenCollection = { id: 'collection:1', name: 'Tokens', modes: [{ modeId: 'mode:1', name: 'Default' }] };
    const brandCollection = { id: 'collection:2', name: 'Brand', modes: [{ modeId: 'mode:2', name: 'Default' }] };
    const tokensPrimary = fakeVariable('primary', 'COLOR', { r: 1, g: 0, b: 0, a: 1 }, ['ALL_SCOPES'], tokenCollection.id);
    const brandPrimary = fakeVariable('primary', 'COLOR', { r: 0, g: 0, b: 1, a: 1 }, ['ALL_SCOPES'], brandCollection.id);
    const figma = fakeFigma({ variables: [tokensPrimary, brandPrimary], collections: [tokenCollection, brandCollection] });
    const client = new FigmaClient();
    client.setCollection('Brand');
    const plan = client.planJSX(
      '<Frame name="BrandCard" bg="var:primary"><Text size="var:type/body|16">Brand</Text></Frame>',
    );

    const result = await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'BrandCard');
    const text = figma.created.find((node) => node.type === 'TEXT');
    const fontSize = figma.localVariables.find((item) => item.name === 'type/body');

    assert.equal(plan.variableCollection, 'Brand');
    assert.equal(frame.fills[0].boundVariables.color, brandPrimary.id);
    assert.equal(text.boundVariables.fontSize, fontSize.id);
    assert.equal(result.scopeQuestions[0].resolvedType, 'FLOAT');
    assert.deepEqual(result.scopeQuestions[0].allowedScopes, [...VARIABLE_SCOPES_BY_TYPE.FLOAT]);
  });

  it('binds native dimensions and complete typography fields', async () => {
    const variables = [
      fakeVariable('layout/card-width', 'FLOAT', 320, ['WIDTH_HEIGHT']),
      fakeVariable('layout/card-height', 'FLOAT', 180, ['WIDTH_HEIGHT']),
      fakeVariable('layout/min-width', 'FLOAT', 240, ['WIDTH_HEIGHT']),
      fakeVariable('type/family', 'STRING', 'Inter', ['FONT_FAMILY']),
      fakeVariable('type/style', 'STRING', 'Semi Bold', ['FONT_STYLE']),
      fakeVariable('type/weight', 'FLOAT', 600, ['FONT_WEIGHT']),
      fakeVariable('type/size', 'FLOAT', 18, ['FONT_SIZE']),
      fakeVariable('type/line-height', 'FLOAT', 26, ['LINE_HEIGHT']),
      fakeVariable('type/tracking', 'FLOAT', 0.5, ['LETTER_SPACING']),
      fakeVariable('type/paragraph-gap', 'FLOAT', 12, ['PARAGRAPH_SPACING']),
      fakeVariable('type/indent', 'FLOAT', 8, ['PARAGRAPH_INDENT']),
    ];
    const figma = fakeFigma({ variables });
    const plan = new FigmaClient().planJSX(
      '<Frame name="Bound card" w="var:layout/card-width" h="var:layout/card-height" minW="var:layout/min-width">' +
      '<Text name="Body" font="var:type/family" fontStyle="var:type/style" weight="var:type/weight" ' +
      'size="var:type/size" lineHeight="var:type/line-height" letterSpacing="var:type/tracking" ' +
      'paragraphSpacing="var:type/paragraph-gap" paragraphIndent="var:type/indent">Bound</Text></Frame>',
    );

    assert.equal(inspectStructuredRenderPlan(plan).supported, true);
    const result = await executeStructuredRenderPlan(figma, plan);
    const frame = figma.created.find((node) => node.name === 'Bound card');
    const text = figma.created.find((node) => node.name === 'Body');

    assert.deepEqual([frame.width, frame.height, frame.minWidth], [320, 180, 240]);
    assert.deepEqual(frame.boundVariables, {
      width: 'variable:layout/card-width', height: 'variable:layout/card-height', minWidth: 'variable:layout/min-width',
    });
    assert.deepEqual(text.fontName, { family: 'Inter', style: 'Semi Bold' });
    assert.equal(text.fontSize, 18);
    assert.deepEqual(text.lineHeight, { unit: 'PIXELS', value: 26 });
    assert.deepEqual(text.letterSpacing, { unit: 'PIXELS', value: 0.5 });
    assert.deepEqual([text.paragraphSpacing, text.paragraphIndent], [12, 8]);
    assert.deepEqual(text.boundVariables, {
      fontSize: 'variable:type/size', fontFamily: 'variable:type/family',
      fontStyle: 'variable:type/style', fontWeight: 'variable:type/weight',
      lineHeight: 'variable:type/line-height', letterSpacing: 'variable:type/tracking',
      paragraphSpacing: 'variable:type/paragraph-gap', paragraphIndent: 'variable:type/indent',
    });
    assert.deepEqual(result.variableReport, {
      references: 11, reused: 11, created: 0, bound: 11, ambiguous: 0, unsupported: 0,
    });
  });

  it('stops an unavailable bound font before variables or canvas nodes are created', async () => {
    const figma = fakeFigma({
      loadFont: async (font) => { if (font.family === 'Missing Sans') throw new Error('font missing'); },
    });
    const plan = new FigmaClient().planJSX(
      '<Frame><Text font="var:type/family|Missing Sans" size="var:type/size|18">Unavailable</Text></Frame>',
    );

    await assert.rejects(() => executeStructuredRenderPlan(figma, plan), /bound font Missing Sans\/Regular is unavailable/);
    assert.equal(figma.created.length, 0);
    assert.equal(figma.localVariables.length, 0);
  });

  it('creates missing STRING typography variables and asks for a compatible scope', async () => {
    const figma = fakeFigma();
    const plan = new FigmaClient().planJSX(
      '<Frame><Text font="var:type/family|Inter" fontStyle="var:type/style|Regular">Created strings</Text></Frame>',
    );

    const result = await executeStructuredRenderPlan(figma, plan);
    const text = figma.created.find((node) => node.type === 'TEXT');
    const family = figma.localVariables.find((variable) => variable.name === 'type/family');
    const style = figma.localVariables.find((variable) => variable.name === 'type/style');

    assert.deepEqual([family.resolvedType, style.resolvedType], ['STRING', 'STRING']);
    assert.deepEqual(text.boundVariables, { fontFamily: family.id, fontStyle: style.id });
    assert.equal(result.scopeQuestions.every((question) => question.resolvedType === 'STRING'), true);
    assert.equal(result.scopeQuestions.every((question) => question.allowedScopes.includes('FONT_FAMILY')), true);
    assert.deepEqual(result.variableReport, {
      references: 2, reused: 0, created: 2, bound: 2, ambiguous: 0, unsupported: 0,
    });
  });

  it('stops missing and ambiguous variables before creating any Figma node', async () => {
    const first = fakeVariable('theme/primary', 'COLOR', { r: 1, g: 0, b: 0, a: 1 });
    const second = fakeVariable('brand/primary', 'COLOR', { r: 0, g: 0, b: 1, a: 1 });
    const ambiguousFigma = fakeFigma({ variables: [first, second] });
    const ambiguousPlan = new FigmaClient().planJSX('<Frame bg="var:primary" />');
    await assert.rejects(() => executeStructuredRenderPlan(ambiguousFigma, ambiguousPlan), /variable is ambiguous.*ambiguous=1, unsupported=0/);
    assert.equal(ambiguousFigma.created.length, 0);

    const missingFigma = fakeFigma();
    const missingPlan = new FigmaClient().planJSX('<Frame bg="var:surface/missing" />');
    await assert.rejects(() => executeStructuredRenderPlan(missingFigma, missingPlan), /no usable fallback.*ambiguous=0, unsupported=1/);
    assert.equal(missingFigma.created.length, 0);
  });

  it('extracts the structured runtime independently of checkout line endings', () => {
    const fixture = '// BEGIN STRUCTURED RENDER RUNTIME\r\nexport function example() {}\r\n// END STRUCTURED RENDER RUNTIME\r\n';
    assert.equal(extractStructuredRenderRuntime(fixture), 'export function example() {}\n');
  });

  it('keeps the shipped plugin runtime content-identical to the canonical module', () => {
    const source = readFileSync(new URL('../src/lib/structured-render-executor.js', import.meta.url), 'utf8');
    const plugin = readFileSync(new URL('../../plugin/code.js', import.meta.url), 'utf8');
    const canonical = extractStructuredRenderRuntime(source)?.replace(/^export /gm, '');
    const shipped = extractStructuredRenderRuntime(plugin);
    assert.ok(canonical && shipped, 'both runtime markers must exist');
    assert.equal(shipped, canonical);
  });
});

function fakeVariable(name, resolvedType, value, scopes = ['ALL_SCOPES'], collectionId = 'collection:1') {
  return {
    id: `variable:${name}`, name, resolvedType, variableCollectionId: collectionId,
    valuesByMode: { 'mode:1': value }, scopes: [...scopes],
    setValueForMode(modeId, next) { this.valuesByMode[modeId] = next; },
  };
}

function fakeFigma({ variables: initialVariables = [], collections: initialCollections = null, components = [], textStyles: initialTextStyles = [], loadFont = null, createImage = null, createImageAsync = null, createVariableHook = null } = {}) {
  let id = 0;
  let imageId = 0;
  const created = [];
  const imageResources = [];
  const localVariables = [...initialVariables];
  const localTextStyles = [...initialTextStyles];
  const collections = initialCollections ? [...initialCollections] : [{ id: 'collection:1', name: 'Tokens', modes: [{ modeId: 'mode:1', name: 'Default' }] }];
  const currentPage = { children: [] };
  const base = (type) => ({
    id: `${type}:${++id}`, type, name: '', x: 0, y: 0, width: type === 'TEXT' ? 1 : 0, height: type === 'TEXT' ? 16 : 0,
    children: [], fills: [], strokes: [], effects: [], annotations: [], layoutMode: 'NONE', visible: true, locked: false,
    resize(width, height) { this.width = width; this.height = height; },
    appendChild(child) { this.children.push(child); child.parent = this; },
    remove() {
      const owner = this.parent || currentPage;
      const index = owner.children.indexOf(this);
      if (index >= 0) owner.children.splice(index, 1);
      this.parent = null;
      this.removed = true;
    },
    setGridChildPosition(row, column) { this.gridPosition = [row, column]; },
    findAll(predicate) {
      const result = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (predicate(child)) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    },
    boundVariables: {},
    pluginData: {},
    setPluginData(key, value) { this.pluginData[key] = String(value); },
    getPluginData(key) { return this.pluginData[key] || ''; },
    setBoundVariable(field, variable) { this.boundVariables[field] = variable.id || variable; },
    async setTextStyleIdAsync(styleId) { this.textStyleId = styleId; },
  });
  const enforceLayoutSizingParent = (node) => {
    let horizontal;
    Object.defineProperty(node, 'layoutSizingHorizontal', {
      get: () => horizontal,
      set(value) {
        if (value === 'FILL' && !node.parent) throw new Error('node must be a child of an auto-layout frame');
        horizontal = value;
      },
      configurable: true,
    });
    return node;
  };
  const frame = () => {
    const node = enforceLayoutSizingParent(base('FRAME'));
    let rows = [], columns = [];
    Object.defineProperty(node, 'gridRowCount', { get: () => rows.length, set: (count) => { rows = Array.from({ length: count }, () => ({})); } });
    Object.defineProperty(node, 'gridColumnCount', { get: () => columns.length, set: (count) => { columns = Array.from({ length: count }, () => ({})); } });
    Object.defineProperty(node, 'gridRowSizes', { get: () => rows });
    Object.defineProperty(node, 'gridColumnSizes', { get: () => columns });
    return node;
  };
  const componentById = new Map();
  const componentByKey = new Map();
  const layerFromSpec = (spec = {}) => {
    const node = base(spec.type || 'FRAME');
    node.name = spec.name || '';
    if (spec.characters != null) node.characters = String(spec.characters);
    if (spec.fontName) node.fontName = spec.fontName;
    if (spec.fills) node.fills = spec.fills;
    if (node.type === 'INSTANCE') {
      node.mainComponent = spec.mainComponent || null;
      node.swapComponent = (component) => { node.mainComponent = component; node.swappedWith = component; };
    }
    for (const childSpec of spec.children || []) node.appendChild(layerFromSpec(childSpec));
    return node;
  };
  const cloneLayer = (source) => {
    const node = base(source.type);
    node.name = source.name;
    node.characters = source.characters;
    node.fontName = source.fontName;
    node.fills = Array.isArray(source.fills) ? source.fills.map((paint) => ({ ...paint })) : source.fills;
    if (node.type === 'INSTANCE') {
      node.mainComponent = source.mainComponent || null;
      node.swapComponent = (component) => { node.mainComponent = component; node.swappedWith = component; };
    }
    for (const child of source.children || []) node.appendChild(cloneLayer(child));
    return node;
  };
  const createComponent = (spec) => {
    const node = base('COMPONENT');
    node.id = spec.id;
    node.key = spec.key;
    node.name = spec.name;
    node.width = spec.width || 100;
    node.height = spec.height || 40;
    node.componentPropertyDefinitions = spec.componentPropertyDefinitions || {};
    node.variantProperties = spec.variantProperties || Object.fromEntries(String(spec.name || '').split(',').map((part) => part.split('=').map((value) => value.trim())).filter((pair) => pair.length === 2));
    for (const childSpec of spec.children || []) node.appendChild(layerFromSpec(childSpec));
    node.createInstance = () => {
      const instance = base('INSTANCE');
      instance.width = node.width;
      instance.height = node.height;
      instance.mainComponent = node;
      instance.componentProperties = Object.fromEntries(Object.entries(node.componentPropertyDefinitions).map(([key, definition]) => [key, { type: definition.type, value: definition.defaultValue }]));
      instance.setProperties = (next) => {
        instance.appliedProperties = { ...(instance.appliedProperties || {}), ...next };
        for (const [key, value] of Object.entries(next)) {
          if (instance.componentProperties[key]) instance.componentProperties[key].value = value;
        }
      };
      for (const child of node.children || []) instance.appendChild(cloneLayer(child));
      created.push(instance);
      currentPage.children.push(instance);
      return instance;
    };
    componentById.set(node.id, node);
    if (node.key) componentByKey.set(node.key, node);
    return node;
  };
  for (const spec of components) {
    if (spec.variants) {
      const set = base('COMPONENT_SET');
      set.id = spec.id;
      set.key = spec.key;
      set.name = spec.name;
      set.children = spec.variants.map((variant) => createComponent(variant));
      for (const child of set.children) child.parent = set;
      set.defaultVariant = set.children[0];
      componentById.set(set.id, set);
      componentByKey.set(set.key, set);
    } else createComponent(spec);
  }
  const api = {
    created, imageResources, localVariables, localTextStyles,
    currentPage,
    async getLocalTextStylesAsync() { return [...localTextStyles]; },
    createTextStyle() {
      const style = {
        id: `text-style:${++id}`, name: '', fontName: { family: 'Inter', style: 'Regular' },
        fontSize: 14, lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 },
        paragraphSpacing: 0, paragraphIndent: 0,
        remove() {
          const index = localTextStyles.indexOf(this);
          if (index >= 0) localTextStyles.splice(index, 1);
          this.removed = true;
        },
      };
      localTextStyles.push(style);
      return style;
    },
    base64Decode(base64) { return Uint8Array.from(Buffer.from(base64, 'base64')); },
    createImage(bytes) {
      if (createImage) return createImage(bytes);
      const image = { hash: `image:${++imageId}`, bytes };
      imageResources.push(image);
      return image;
    },
    async createImageAsync(src) {
      if (createImageAsync) return createImageAsync(src);
      const image = { hash: `image:${++imageId}`, src };
      imageResources.push(image);
      return image;
    },
    async loadFontAsync(font) { if (loadFont) return loadFont(font); },
    async getNodeByIdAsync(nodeId) {
      if (componentById.has(nodeId)) return componentById.get(nodeId);
      let match = null;
      const visit = (node) => {
        if (node.id === nodeId) match = node;
        for (const child of node.children || []) visit(child);
      };
      for (const node of currentPage.children) visit(node);
      return match;
    },
    async importComponentByKeyAsync(key) {
      const node = componentByKey.get(key);
      if (!node || node.type !== 'COMPONENT') throw new Error('component not found');
      return node;
    },
    async importComponentSetByKeyAsync(key) {
      const node = componentByKey.get(key);
      if (!node || node.type !== 'COMPONENT_SET') throw new Error('component set not found');
      return node;
    },
    createFrame() { const node = frame(); created.push(node); this.currentPage.children.push(node); return node; },
    createText() {
      const node = enforceLayoutSizingParent(base('TEXT'));
      for (const field of ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent']) {
        let stored;
        Object.defineProperty(node, field, {
          get: () => stored,
          set(value) {
            stored = value;
            if (node.textStyleId) node.textStyleId = '';
          },
          configurable: true,
        });
      }
      created.push(node); this.currentPage.children.push(node); return node;
    },
    createRectangle() { const node = enforceLayoutSizingParent(base('RECTANGLE')); created.push(node); this.currentPage.children.push(node); return node; },
    createEllipse() { const node = enforceLayoutSizingParent(base('ELLIPSE')); created.push(node); this.currentPage.children.push(node); return node; },
    createNodeFromSvg(svg) {
      const node = frame();
      const vector = base('VECTOR');
      vector.name = String(svg || '').match(/\bid=["'](figma-filter-[^"']+)["']/i)?.[1] || 'Vector';
      vector.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      node.appendChild(vector);
      created.push(node, vector);
      this.currentPage.children.push(node);
      return node;
    },
    variables: {
      async getLocalVariableCollectionsAsync() { return [...collections]; },
      async getLocalVariablesAsync() { return [...localVariables]; },
      createVariableCollection(name) {
        const collection = { id: `collection:${collections.length + 1}`, name, modes: [{ modeId: `mode:${collections.length + 1}`, name: 'Default' }] };
        collections.push(collection);
        return collection;
      },
      createVariable(name, collection, type) {
        if (createVariableHook) createVariableHook(name, collection, type);
        const variable = fakeVariable(name, type, null, ['ALL_SCOPES'], collection.id);
        variable.id = `variable:${localVariables.length + 1}`;
        variable.valuesByMode = {};
        variable.remove = () => {
          const index = localVariables.indexOf(variable);
          if (index >= 0) localVariables.splice(index, 1);
        };
        localVariables.push(variable);
        return variable;
      },
      setBoundVariableForPaint(paint, field, variable) {
        return { ...paint, boundVariables: { ...(paint.boundVariables || {}), [field]: variable.id } };
      },
    },
  };
  return api;
}
