import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationReadCode,
  annotationReadPlanRoute,
  annotationReadPlanningArgvFromRequest,
  executeAnnotationRead,
  executeAnnotationReadPlan,
  MAX_ANNOTATION_READ_ITEMS,
} from '../src/application/annotation-read-command.js';
import {
  acceptsAnnotationReadArgv,
  annotationReadArgvFromRequest,
  annotationReadFigmaUrlFileKeyFromArgv,
  parseAnnotationReadRequest,
} from '../src/application/annotation-read-request.js';

const ANNOTATIONS = Object.freeze([
  {
    label: 'Review spacing',
    labelMarkdown: null,
    categoryId: 'C:1',
    properties: [{ type: 'width' }, { type: 'itemSpacing' }],
  },
  {
    label: null,
    labelMarkdown: '**Ready**',
    categoryId: null,
    properties: null,
  },
]);

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'node',
    node: { id: '1:2', name: 'Card', type: 'FRAME' },
    annotations: ANNOTATIONS,
    ...overrides,
  };
}

function runtime({ selected = false, annotations = ANNOTATIONS } = {}) {
  const node = {
    id: '1:2',
    name: 'Card',
    type: 'FRAME',
    annotations: annotations.map((annotation) => ({
      ...(annotation.label === null ? {} : { label: annotation.label }),
      ...(annotation.labelMarkdown === null ? {} : { labelMarkdown: annotation.labelMarkdown }),
      ...(annotation.categoryId === null ? {} : { categoryId: annotation.categoryId }),
      ...(annotation.properties === null
        ? {}
        : { properties: annotation.properties.map((property) => ({ ...property })) }),
    })),
  };
  return {
    currentPage: { selection: selected ? [node] : [] },
    getNodeByIdAsync: async (nodeId) => nodeId === node.id ? node : null,
  };
}

test('Annotation Read closes optional node references and URL target identity', () => {
  assert.deepEqual(parseAnnotationReadRequest(['annotate', 'list']), {
    nodeId: null, warning: '',
  });
  assert.deepEqual(parseAnnotationReadRequest(['annotate', 'list', '--', '1-2']), {
    nodeId: '1:2', warning: '',
  });
  assert.deepEqual(annotationReadArgvFromRequest({ nodeId: '1-2' }), [
    'annotate', 'list', '--', '1:2',
  ]);
  for (const argv of [
    ['annotate', 'list', '1:2', '1:3'],
    ['annotate', 'list', '--future'],
    ['annotate', 'list', 'not-a-node'],
  ]) assert.equal(acceptsAnnotationReadArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Annotation-Lab?node-id=1-2';
  const planning = annotationReadPlanningArgvFromRequest({ nodeId: url });
  assert.equal(annotationReadFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['annotate', 'list', '--', '1:2']);
});

test('Annotation Read projects exact labels, markdown, categories, and properties', async () => {
  const result = await executeAnnotationRead({ nodeId: '1:2' }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime()),
  });
  assert.deepEqual(result.result, payload());
  assert.equal(result.stdout, [
    'Card (1:2)',
    '  1. Review spacing',
    '  2. **Ready**',
  ].join('\n'));
});

test('Annotation Read owns current-selection and empty-list semantics', async () => {
  const selected = await executeAnnotationRead({ nodeId: null }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(
      runtime({ selected: true })),
  });
  assert.equal(selected.result.source, 'selection');
  assert.match(selected.stdout, /^Card \(1:2\)$/m);

  const empty = await executeAnnotationRead({ nodeId: '1:2' }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(
      runtime({ annotations: [] })),
  });
  assert.equal(empty.stdout, 'Card (1:2)\n  (no annotations)');
});

test('Annotation Read fails closed on missing targets and unsupported nodes', async () => {
  await assert.rejects(
    () => new Function('figma', `return ${annotationReadCode({ nodeId: '9:9' })};`)(runtime()),
    /target was not found/,
  );
  await assert.rejects(
    () => new Function('figma', `return ${annotationReadCode({ nodeId: null })};`)(runtime()),
    /requires one selected node/,
  );
  await assert.rejects(
    () => new Function('figma', `return ${annotationReadCode({ nodeId: '1:2' })};`)({
      currentPage: { selection: [] },
      getNodeByIdAsync: async () => ({ id: '1:2', name: 'Page', type: 'PAGE' }),
    }),
    /does not support annotations/,
  );
});

test('Annotation Read rejects malformed, drifting, and unbounded Plugin results', async () => {
  for (const malformed of [
    { ...payload(), privateFutureFact: true },
    payload({ node: { id: '1:3', name: 'Card', type: 'FRAME' } }),
    payload({ annotations: [{ ...ANNOTATIONS[0], privateFutureFact: true }] }),
    payload({ annotations: [{ ...ANNOTATIONS[0], properties: [{ type: 'future' }] }] }),
    payload({ annotations: Array(MAX_ANNOTATION_READ_ITEMS + 1).fill(ANNOTATIONS[0]) }),
  ]) {
    await assert.rejects(
      () => executeAnnotationRead({ nodeId: '1:2' }, {
        evaluate: async () => JSON.stringify(malformed),
      }),
      /invalid bounded result/,
    );
  }
  await assert.rejects(
    () => executeAnnotationRead({ nodeId: '1:2' }, { evaluate: async () => '{' }),
    (error) => error.phase === 'plugin-response' && error.outcome === 'unknown-after-dispatch',
  );
});

test('Annotation Read plans one policy-identical safe-read Application for CLI and MCP', async () => {
  const cli = planFigmaCommand(['annotate', 'list', '1-2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'list', '--', '1:2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.deepEqual(cli.effects, {
    figma: 'read', editor: 'none', workspace: 'none', shared: 'none', network: 'none',
  });
  assert.equal(annotationReadPlanRoute(cli), 'command-application');
  assert.deepEqual((await executeAnnotationReadPlan(cli, {
    evaluate: async () => JSON.stringify(payload()),
  })).result, payload());

  const selection = planFigmaCommand(['annotate', 'list'], { adapter: 'mcp' });
  assert.equal(selection.effects.editor, 'read');
  assert.equal(annotationReadPlanRoute(
    planFigmaCommand(['annotate', 'categories'], { adapter: 'mcp' }),
  ), 'not-annotation-read');
});

test('Annotation Read generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${annotationReadCode({ nodeId: '1:2' })}`));
  assert.doesNotThrow(() => new Function(`return ${annotationReadCode({ nodeId: null })}`));
});
