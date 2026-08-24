import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient } from '../src/lib/jsx-render.js';
import {
  SEMANTIC_RENDER_PLAN_KIND,
  SEMANTIC_RENDER_PLAN_VERSION,
  assertSemanticRenderPlan,
  semanticRenderPlanToJsxTree,
  stableStringifySemanticRenderPlan,
} from '../src/lib/semantic-render-plan.js';

describe('Semantic Render Plan', () => {
  const jsx = '<Frame name="Card" flex="col" gap="8">' +
    '<Text name="Title">Hello</Text>' +
    '<Frame name="Actions" flex="row"><Icon name="check" /><Text>Done</Text></Frame>' +
    '</Frame>';

  it('is a versioned, source-independent contract with stable child order', () => {
    const client = new FigmaClient();
    const plan = client.planJSX(jsx);

    assert.equal(plan.kind, SEMANTIC_RENDER_PLAN_KIND);
    assert.equal(plan.version, SEMANTIC_RENDER_PLAN_VERSION);
    assert.equal(plan.adapter, 'jsx');
    assert.deepEqual(plan.root.children.map((node) => node.name), ['Title', 'Actions']);
    assert.deepEqual(plan.root.children[1].children.map((node) => node.source.type), ['icon', 'text']);
    assert.equal(plan.root.source.props._children, undefined);
    assert.equal(plan.root.children[0].source.props._index, undefined);
    assert.equal(plan.root.children[0].source.props._type, undefined);
    assert.equal(plan.root.children[1].children[0].asset.kind, 'builtin-icon');
    assert.match(plan.root.children[1].children[0].asset.svg, /^<svg/);
  });

  it('requires one complete root Frame without silently dropping trailing content', () => {
    const client = new FigmaClient();
    assert.equal(client.planJSX('<Frame name="Only" />').root.name, 'Only');
    assert.equal(client.planJSX('  <Frame name="Only"></Frame>\n').root.name, 'Only');
    assert.throws(
      () => client.planJSX('<Frame name="Open"><Text>Lost</Text>'),
      /<Frame> is not closed/,
    );
    assert.throws(
      () => client.planJSX('<Frame name="First"></Frame><Frame name="Second"></Frame>'),
      /exactly one root <Frame>/,
    );
    assert.throws(
      () => client.planJSX('<Frame name="First"></Frame> trailing'),
      /exactly one root <Frame>|text content must be inside <Text>/,
    );
  });

  it('rejects malformed or unprojected descendants instead of rendering a partial tree', () => {
    const client = new FigmaClient();
    for (const malformed of [
      '<Frame><Text>oops</Frame>',
      '<Frame><Unknown /></Frame>',
      '<Frame>orphan text</Frame>',
      '<Frame><Rect></Rect></Frame>',
      '<Frame><Rect / ></Frame>',
      '<Frame><Text / ></Frame>',
      '<Frame><Slot / ></Frame>',
      '<Frame><Slot><Text>X</Text></Slot ><Text>Y</Text></Frame>',
      '<Frame><Text>X</Text ></Frame>',
      '<Frame><Text>X</Text></Frame >',
      '<Frame name="A" name="B" />',
      '<Frame name=A />',
    ]) {
      assert.throws(() => client.planJSX(malformed), /Invalid JSX/);
    }
    const rich = client.planJSX('<Frame><Text>Hello <strong>bold <em>italic</em></strong></Text><Text name="Empty" /></Frame>');
    assert.equal(rich.root.children.length, 2);
    assert.equal(rich.root.children[0].source.props.content, 'Hello bold italic');
    assert.equal(rich.root.children[1].source.props.content, '');

    const slot = client.planJSX('<Frame><Slot name="Content"><Frame name="Inner" /></Slot></Frame>');
    assert.deepEqual(slot.root.children.map((node) => node.source.type), ['slot']);
    assert.deepEqual(slot.root.children[0].children.map((node) => node.name), ['Inner']);
  });

  it('preserves nested Frame and Slot ownership with multiline attributes', () => {
    const client = new FigmaClient();
    const frame = client.planJSX(
      '<Frame><Frame\n name="Inner"><Text>X</Text></Frame><Text>Y</Text></Frame>',
    );
    assert.deepEqual(frame.root.children.map((node) => node.source.type), ['frame', 'text']);
    assert.equal(frame.root.children[0].name, 'Inner');
    assert.equal(frame.root.children[0].children[0].source.props.content, 'X');
    assert.equal(frame.root.children[1].source.props.content, 'Y');

    const slot = client.planJSX(
      '<Frame><Slot name="Outer"><Slot\n\tname="Inner"><Text>X</Text></Slot><Text>Y</Text></Slot></Frame>',
    );
    assert.deepEqual(slot.root.children.map((node) => node.name), ['Outer']);
    assert.deepEqual(slot.root.children[0].children.map((node) => node.source.type), ['slot', 'text']);
    assert.equal(slot.root.children[0].children[0].name, 'Inner');
    assert.equal(slot.root.children[0].children[0].children[0].source.props.content, 'X');
    assert.equal(slot.root.children[0].children[1].source.props.content, 'Y');
  });

  it('bounds JSX depth and element count before recursive projection', () => {
    const client = new FigmaClient();
    const tooDeep = '<Frame>'.repeat(201) + '</Frame>'.repeat(201);
    const tooMany = `<Frame>${'<Rect />'.repeat(20_000)}</Frame>`;

    assert.throws(() => client.planJSX(tooDeep), /Invalid JSX: nesting exceeds 200 levels/);
    assert.throws(() => client.planJSX(tooMany), /Invalid JSX: exceeds 20,000 elements/);
  });

  it('serializes deterministically without changing ordered arrays', () => {
    const client = new FigmaClient();
    const plan = client.planJSX(jsx);
    const first = stableStringifySemanticRenderPlan(plan);
    const second = stableStringifySemanticRenderPlan(structuredClone(plan));

    assert.equal(first, second);
    assert.ok(first.endsWith('\n'));
    assert.deepEqual(JSON.parse(first).root.children.map((node) => node.name), ['Title', 'Actions']);
  });

  it('carries an explicit variable collection preference in the plan contract', () => {
    const client = new FigmaClient();
    client.setCollection('Brand Tokens');
    const plan = client.planJSX('<Frame bg="var:surface/card|#ffffff" />');

    assert.equal(plan.variableCollection, 'Brand Tokens');
    assert.equal(assertSemanticRenderPlan(plan), plan);
    assert.throws(
      () => assertSemanticRenderPlan({ ...plan, variableCollection: '   ' }),
      /variableCollection must be a non-empty string/,
    );
  });

  it('validates node-local native fallback annotation intent', () => {
    const plan = new FigmaClient().planJSX('<Frame name="Annotated" />');
    plan.root.fallbackAnnotations = [{
      policy: 'border.single-paint-native',
      fact: 'different border paints per side',
      labelMarkdown: '**CSS → Figma Fallback**',
      properties: ['strokes', 'strokeWeight'],
    }];

    assert.equal(assertSemanticRenderPlan(plan), plan);
    assert.throws(
      () => assertSemanticRenderPlan({
        ...plan,
        root: { ...plan.root, fallbackAnnotations: [{ ...plan.root.fallbackAnnotations[0], properties: ['unknown'] }] },
      }),
      /unsupported Figma annotation property/,
    );
  });

  it('rejects incompatible and non-executable plans at the boundary', () => {
    const client = new FigmaClient();
    const plan = client.planJSX(jsx);

    assert.throws(
      () => assertSemanticRenderPlan({ ...plan, version: 999 }),
      /Unsupported Semantic Render Plan version/,
    );
    assert.throws(
      () => assertSemanticRenderPlan({ ...plan, root: { ...plan.root, children: {} } }),
      /children must be an array/,
    );
    const capturePlan = structuredClone(plan);
    capturePlan.root.source.kind = 'dom-capture';
    assert.throws(
      () => assertSemanticRenderPlan(capturePlan, { executable: true }),
      /cannot be executed by the JSX compiler/,
    );
    let deep = plan.root;
    for (let index = 0; index < 201; index++) {
      const child = { ...plan.root, name: `deep-${index}`, children: [] };
      deep.children = [child];
      deep = child;
    }
    assert.throws(() => assertSemanticRenderPlan(plan), /nesting exceeds 200 levels/);
  });

  it('reconstructs the legacy compiler tree without reparsing JSX', async () => {
    const client = new FigmaClient();
    const parsed = client.parseJSXTree(jsx);
    const legacyCode = client.generateCode(parsed.props, parsed.children, { ...client.customIcons });
    const plan = client.planJSX(jsx);
    const reconstructed = semanticRenderPlanToJsxTree(plan);

    assert.deepEqual(reconstructed.props, parsed.props);
    assert.deepEqual(reconstructed.children, parsed.children.map(stripParserIndexes));

    client.parseJSXTree = () => { throw new Error('JSX parser must not run during plan compilation'); };
    const plannedCode = await client.compileRenderPlan(plan);
    assert.equal(plannedCode, legacyCode);
  });

  it('compiles a batch of existing plans without reparsing JSX', async () => {
    const client = new FigmaClient();
    const plans = [
      client.planJSX('<Frame name="One"><Text>1</Text></Frame>'),
      client.planJSX('<Frame name="Two"><Text>2</Text></Frame>'),
    ];
    client.parseJSXTree = () => { throw new Error('JSX parser must not run during plan compilation'); };

    const code = await client.compileRenderPlans(plans, { gap: 24 });
    assert.match(code, /f0\.name = "One"/);
    assert.match(code, /f1\.name = "Two"/);
    assert.match(code, /posX \+= f0\.width \+ 24/);

    const explicit = await client.compileRenderPlans(plans, {
      gap: 0, vertical: true, smart: false, x: -25, y: 20,
    });
    assert.match(explicit, /let posX = -25, posY = 20/);
    assert.match(explicit, /if \(false && children\.length > 0\)/);
    assert.match(explicit, /posY \+= f0\.height \+ 0/);
  });
});

function stripParserIndexes(value) {
  if (Array.isArray(value)) return value.map(stripParserIndexes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== '_index')
    .map(([key, child]) => [key, stripParserIndexes(child)]));
}
