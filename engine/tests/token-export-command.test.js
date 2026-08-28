import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenExport,
  executeTokenExportPlan,
  tokenExportPlanRoute,
} from '../src/application/token-export-command.js';
import {
  parseTokenExportRequest,
  tokenExportArgvFromRequest,
  tokenExportFigmaUrlFileKeyFromArgv,
  tokenExportPlanningArgvFromRequest,
} from '../src/application/token-export-request.js';

const here = dirname(fileURLToPath(import.meta.url));

const metadata = (revision = 7) => ({
  connectionId: 'connection:test',
  fileKey: 'FILE123',
  pluginVersion: '3.3.26',
  documentRevisionBefore: revision,
  documentRevisionAfter: revision,
});

function scopedCapture(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: 'subtree',
    complete: true,
    file: 'Bridge Test',
    node: 'Card',
    id: '1:2',
    visitedNodes: 3,
    referencedVariables: 2,
    returnedVariables: 2,
    vars: [
      {
        id: 'Variable:surface', name: 'color/surface', type: 'COLOR', value: '#ffffff', ref: null, refId: null,
        valuesByMode: {
          'Mode:light': { value: '#ffffff', ref: null, refId: null },
          'Mode:dark': { value: '#111111', ref: null, refId: null },
        },
        modes: [{ modeId: 'Mode:light', name: 'Light' }, { modeId: 'Mode:dark', name: 'Dark' }],
        defaultModeId: 'Mode:light', collection: 'Theme', description: 'Surface',
        scopes: ['ALL_FILLS'], codeSyntax: { WEB: '--color-surface' },
      },
      {
        id: 'Variable:space', name: 'space/md', type: 'FLOAT', value: 16, ref: null, refId: null,
        valuesByMode: {
          'Mode:light': { value: 16, ref: null, refId: null },
          'Mode:dark': { value: 20, ref: null, refId: null },
        },
        modes: [{ modeId: 'Mode:light', name: 'Light' }, { modeId: 'Mode:dark', name: 'Dark' }],
        defaultModeId: 'Mode:light', collection: 'Theme', scopes: ['GAP'], codeSyntax: {},
      },
    ],
    ...overrides,
  };
}

const catalog = [{
  id: 'Collection:theme', key: 'collection-key', name: 'Theme',
  defaultModeId: 'Mode:light', hiddenFromPublishing: false,
  modes: [{ id: 'Mode:light', name: 'Light' }, { id: 'Mode:dark', name: 'Dark' }],
  variableIds: ['Variable:space'],
}];
const chunk = [{
  id: 'Variable:space', key: 'variable-key', name: 'space/md', type: 'FLOAT',
  variableCollectionId: 'Collection:theme', description: '', hiddenFromPublishing: false,
  scopes: ['GAP'], codeSyntax: {}, values: { Light: 16, Dark: 20 },
  exactValues: { 'Mode:light': 16, 'Mode:dark': 20 },
}];

function fileEvaluate({ finalCatalog = catalog, chunkResult = chunk, revision = 7 } = {}) {
  let catalogs = 0;
  return async (code, context) => {
    assert.deepEqual(context.revisionObservation, { scope: 'document' });
    if (code.includes('const ids =')) {
      return { value: JSON.stringify(chunkResult), metadata: metadata(revision) };
    }
    catalogs++;
    return {
      value: JSON.stringify({ file: 'Bridge Test', catalog: catalogs === 1 ? catalog : finalCatalog }),
      metadata: metadata(revision),
    };
  };
}

test('Token Export request preserves CSS and legacy DTCG positional forms', () => {
  assert.deepEqual(parseTokenExportRequest(['export', 'css']), {
    format: 'css', nodeId: null, output: null, dialect: null,
  });
  assert.deepEqual(parseTokenExportRequest(['export', 'css', '12-34']), {
    format: 'css', nodeId: '12:34', output: null, dialect: null,
  });
  assert.deepEqual(parseTokenExportRequest(['export', 'dtcg', 'tokens.json', '12:34', '--dialect=2025']), {
    format: 'dtcg', nodeId: '12:34', output: 'tokens.json', dialect: '2025',
  });
  assert.deepEqual(parseTokenExportRequest(['export', 'dtcg', '12-34']), {
    format: 'dtcg', nodeId: '12:34', output: null, dialect: 'legacy',
  });
  assert.deepEqual(tokenExportArgvFromRequest({
    format: 'dtcg', output: 'tokens.json', nodeId: '12-34', dialect: '2025',
  }), ['export', 'dtcg', 'tokens.json', '12:34', '--dialect', '2025']);
});

test('Token Export request is closed, bounded, and keeps URL identity only while planning', () => {
  for (const args of [
    ['export', 'css', '1:2', 'extra'],
    ['export', 'css', '--dialect', '2025'],
    ['export', 'dtcg', '--future'],
    ['export', 'dtcg', '--dialect', 'future'],
    ['export', 'dtcg', '--dialect=2025', '--dialect', 'legacy'],
  ]) assert.throws(() => parseTokenExportRequest(args), /Invalid token export command/);
  assert.throws(() => tokenExportArgvFromRequest({ format: 'css', future: true }), /closed object/);
  const url = 'https://www.figma.com/design/FILE123/Test?node-id=12-34';
  assert.equal(tokenExportFigmaUrlFileKeyFromArgv(['export', 'css', url]), 'FILE123');
  assert.deepEqual(tokenExportPlanningArgvFromRequest({ format: 'css', nodeId: url }), [
    'export', 'css', url,
  ]);
  assert.deepEqual(tokenExportArgvFromRequest({ format: 'css', nodeId: url }), [
    'export', 'css', '12:34',
  ]);
});

test('scoped CSS and DTCG share one bounded capture and preserve all modes', async () => {
  const evaluate = async () => ({ value: JSON.stringify(scopedCapture()), metadata: {} });
  const css = await executeTokenExport({ format: 'css', nodeId: '1:2' }, { evaluate });
  assert.match(css.stdout, /source: Figma file "Bridge Test"/);
  assert.match(css.stdout, /--color-surface: #ffffff/);
  assert.match(css.stdout, /\[data-figma-mode="Dark"\][\s\S]*--space-md: 20px/);
  assert.equal(css.stderr, '');
  assert.deepEqual(css.result, { format: 'css', scope: 'subtree', tokenCount: 2 });

  const dtcg = await executeTokenExport({
    format: 'dtcg', nodeId: '1:2', dialect: '2025',
  }, { evaluate });
  const parsed = JSON.parse(dtcg.stdout);
  assert.deepEqual(parsed.color.surface.$value, {
    colorSpace: 'srgb', components: [1, 1, 1], alpha: 1, hex: '#ffffff',
  });
  assert.equal(parsed.space.md.$extensions['figma-bridge-mcp'].valuesByMode['Mode:dark'].value.value, 20);
  assert.match(dtcg.stderr, /2 token\(s\) actually bound/);
});

test('scoped export rejects empty, truncated, forged, and oversized capture facts', async () => {
  const run = (value) => executeTokenExport({ format: 'css', nodeId: '1:2' }, {
    evaluate: async () => ({ value: JSON.stringify(value), metadata: {} }),
  });
  await assert.rejects(run(scopedCapture({ complete: false })), /invalid or incomplete/);
  await assert.rejects(run(scopedCapture({ returnedVariables: 1 })), /invalid or incomplete/);
  await assert.rejects(run(scopedCapture({
    referencedVariables: 0, returnedVariables: 0, vars: [],
  })), /No variables are available under node/);
  await assert.rejects(run(scopedCapture({ node: '\u001b[31mprivate' })), /invalid or incomplete/);
});

test('file-wide CSS captures exact local Variables in revision-pinned chunks', async () => {
  const result = await executeTokenExport({ format: 'css' }, {
    fileKey: 'FILE123', evaluate: fileEvaluate(), remainingMs: () => 5_000,
  });
  assert.match(result.stderr, /exporting ALL local variables/);
  assert.match(result.stdout, /all 1 local token/);
  assert.match(result.stdout, /--space-md: 16px/);
  assert.match(result.stdout, /data-figma-mode="Dark"/);
});

test('file-wide export rejects catalog drift and missing revision proof', async () => {
  const changed = [{ ...catalog[0], variableIds: [] }];
  await assert.rejects(executeTokenExport({ format: 'css' }, {
    fileKey: 'FILE123', evaluate: fileEvaluate({ finalCatalog: changed }),
  }), /catalog changed/);

  const noRevision = fileEvaluate();
  await assert.rejects(executeTokenExport({ format: 'css' }, {
    fileKey: 'FILE123',
    evaluate: async (code, context) => {
      const response = await noRevision(code, context);
      return { ...response, metadata: { connectionId: 'connection:test', fileKey: 'FILE123', pluginVersion: '3.3.26' } };
    },
  }), /required document revision/);
});

test('DTCG persistence occurs only after exact capture and uses WorkspaceIO', async () => {
  const writes = [];
  const result = await executeTokenExport({
    format: 'dtcg', output: '/workspace/tokens.json', dialect: 'legacy',
  }, {
    fileKey: 'FILE123', evaluate: fileEvaluate(),
    workspaceIO: { write: (...args) => writes.push(args) },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], '/workspace/tokens.json');
  assert.equal(JSON.parse(writes[0][1]).space.md.$value, '16px');
  assert.deepEqual(writes[0][2], { role: 'dtcg-output', createParents: true });
  assert.match(result.stdout, /Wrote DTCG tokens/);
});

test('DTCG TIMING core duration normalizes back to Figma seconds', async () => {
  const capture = scopedCapture({
    referencedVariables: 1,
    returnedVariables: 1,
    vars: [{
      id: 'Variable:duration', name: 'motion/duration/fast', type: 'TIMING', value: 0.24, ref: null, refId: null,
      valuesByMode: { 'Mode:light': { value: 0.24, ref: null, refId: null } },
      modes: [{ modeId: 'Mode:light', name: 'Light' }], defaultModeId: 'Mode:light',
      collection: 'Motion', scopes: ['ALL_SCOPES'], codeSyntax: {},
    }],
  });
  const result = await executeTokenExport({
    format: 'dtcg', nodeId: '1:2', dialect: '2025',
  }, { evaluate: async () => ({ value: JSON.stringify(capture), metadata: {} }) });
  const document = JSON.parse(result.stdout);
  assert.deepEqual(document.motion.duration.fast.$value, { value: 0.24, unit: 's' });
  // Single-Collection import deliberately refuses Bridge mode topology; the
  // standard DTCG core value itself still normalizes exactly as TIMING.
  delete document.motion.duration.fast.$extensions;
  const { normalizeTokenImportSource } = await import('../src/application/token-import-source.js');
  assert.deepEqual(normalizeTokenImportSource(document).map(({ name, type, value }) => ({
    name, type, value,
  })), [{ name: 'motion/duration/fast', type: 'TIMING', value: 0.24 }]);
});

test('scoped EASING capture preserves native Motion values and rejects malformed composites', async () => {
  const easing = {
    type: 'CUSTOM_CUBIC_BEZIER',
    easingFunctionCubicBezier: { x1: 0.2, y1: -0.1, x2: 0.8, y2: 1.1 },
  };
  const capture = scopedCapture({
    referencedVariables: 1,
    returnedVariables: 1,
    vars: [{
      id: 'Variable:easing', name: 'motion/emphasis', type: 'EASING',
      value: easing, ref: null, refId: null,
      valuesByMode: {
        'Mode:light': { value: easing, ref: null, refId: null },
      },
      modes: [{ modeId: 'Mode:light', name: 'Light' }],
      defaultModeId: 'Mode:light', collection: 'Motion',
      scopes: ['ALL_SCOPES'], codeSyntax: {},
    }],
  });
  const evaluate = async () => ({ value: JSON.stringify(capture), metadata: {} });
  const css = await executeTokenExport({ format: 'css', nodeId: '1:2' }, { evaluate });
  assert.match(css.stdout, /--motion-emphasis: cubic-bezier\(0\.2, -0\.1, 0\.8, 1\.1\)/);
  const dtcg = await executeTokenExport({
    format: 'dtcg', nodeId: '1:2', dialect: '2025',
  }, { evaluate });
  assert.deepEqual(JSON.parse(dtcg.stdout).motion.emphasis.$value, [0.2, -0.1, 0.8, 1.1]);

  capture.vars[0].value = { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 2 } };
  capture.vars[0].valuesByMode['Mode:light'].value = capture.vars[0].value;
  await assert.rejects(executeTokenExport({ format: 'css', nodeId: '1:2' }, {
    evaluate: async () => ({ value: JSON.stringify(capture), metadata: {} }),
  }), /invalid or incomplete/);
});

test('Token Export Plan is authoritative for CLI/MCP routing and output', async () => {
  const output = '/workspace/tokens.json';
  const cli = planFigmaCommand(['export', 'dtcg', output, '1:2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['export', 'dtcg', output, '1-2'], { adapter: 'mcp' });
  assert.equal(tokenExportPlanRoute(cli), 'command-application');
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.deepEqual(cli.outputs, [{ role: 'dtcg-output', path: output }]);
  const writes = [];
  const result = await executeTokenExportPlan(mcp, {
    evaluate: async () => ({ value: JSON.stringify(scopedCapture()), metadata: {} }),
    workspaceIO: { write: (...args) => writes.push(args) },
  });
  assert.equal(result.result.tokenCount, 2);
  assert.equal(writes.length, 1);
  assert.throws(() => tokenExportPlanRoute({ id: 'export.css' }), /Command Plan/);
});

test('Token Export Application stays value-returning and process-independent', () => {
  const source = readFileSync(join(here, '..', 'src', 'application', 'token-export-command.js'), 'utf8');
  assert.doesNotMatch(source, /console\.|process\.(?:exit|stdout|stderr)/);
});
