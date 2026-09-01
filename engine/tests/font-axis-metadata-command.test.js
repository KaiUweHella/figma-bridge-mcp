import assert from 'node:assert/strict';
import test from 'node:test';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeFontAxisMetadata,
  executeFontAxisMetadataPlan,
  fontAxisMetadataCode,
  fontAxisMetadataPlanRoute,
  fontAxisMetadataPlanningArgvFromRequest,
  MAX_FONT_AXIS_METADATA_CODE_UNITS,
  MAX_FONT_AXIS_METADATA_RESULT_CODE_UNITS,
} from '../src/application/font-axis-metadata-command.js';
import {
  acceptsFontAxisMetadataArgv,
  fontAxisMetadataArgvFromRequest,
  fontAxisMetadataFigmaUrlFileKeyFromArgv,
  parseFontAxisMetadataRequest,
} from '../src/application/font-axis-metadata-request.js';
import { FONT_AXIS_METADATA_KEY } from '../src/lib/font-introspection.js';

function fixture({ initial = '', behavior = 'normal' } = {}) {
  let raw = initial; let writes = 0; let reads = 0;
  const node = {
    id: '1:1', name: 'Neutral Text', type: 'TEXT', characters: 'Hello',
    getPluginData(key) { assert.equal(key, FONT_AXIS_METADATA_KEY); return raw; },
    setPluginData(key, value) {
      assert.equal(key, FONT_AXIS_METADATA_KEY); writes += 1;
      if (behavior === 'throw-before-apply') throw new Error('setter failed');
      raw = value;
      if (behavior === 'throw-after-apply') throw new Error('setter acknowledgement failed');
    },
  };
  return {
    node,
    get raw() { return raw; },
    get writes() { return writes; },
    get reads() { return reads; },
    figma: { getNodeByIdAsync: async (id) => { reads += 1; return id === node.id ? node : null; } },
  };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Font Axis Metadata closes all action grammars, ranges, axes, and URL targeting', () => {
  const url = 'https://www.figma.com/design/FILEA/Font-Lab?node-id=1-1';
  assert.deepEqual(parseFontAxisMetadataRequest(['font', 'axes', '1-1']), {
    action: 'axes', nodeId: '1:1', warning: '',
  });
  const urlRequest = parseFontAxisMetadataRequest([
    'font', 'remember-axes', '--end=4', url, 'wght=357,wdth=82', '--start', '1',
  ]);
  assert.deepEqual({ ...urlRequest, warning: '' }, {
    action: 'remember-axes', nodeId: '1:1', axes: { wght: 357, wdth: 82 },
    start: 1, end: 4, warning: '',
  });
  assert.match(urlRequest.warning, /Safe Mode/);
  assert.equal(fontAxisMetadataFigmaUrlFileKeyFromArgv(['font', 'axes', url]), 'FILEA');
  assert.deepEqual(fontAxisMetadataArgvFromRequest({
    action: 'remember-axes', nodeId: '1-1', axes: 'wght=357', start: 1, end: 4,
  }), ['font', 'remember-axes', '--start', '1', '--end', '4', '--', '1:1', 'wght=357']);
  for (const argv of [
    ['font', 'axes'],
    ['font', 'axes', '1:1', '2:2'],
    ['font', 'axes', '1:1', '--start', '0'],
    ['font', 'remember-axes', '1:1'],
    ['font', 'remember-axes', '1:1', 'weight=357'],
    ['font', 'remember-axes', '1:1', 'wght=nope'],
    ['font', 'forget-axes', '1:1', '--start', '4', '--end', '2'],
    ['font', 'forget-axes', '1:1', '--future', 'private-value'],
  ]) assert.equal(acceptsFontAxisMetadataArgv(argv), false, argv.join(' '));
});

test('Font axes preserves truthful metadata-only read facts and explicit corruption', async () => {
  const live = fixture({ initial: JSON.stringify({ schemaVersion: 1, ranges: [
    { start: 1, end: 4, axes: { wght: 357 } },
  ] }) });
  const read = await executeFontAxisMetadata({ action: 'axes', nodeId: '1:1' }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(read.result, {
    id: '1:1', name: 'Neutral Text', source: 'plugin-data', appliedToFont: false,
    schemaVersion: 1, ranges: [{ start: 1, end: 4, axes: { wght: 357 } }],
  });
  const corrupt = await executeFontAxisMetadata({ action: 'axes', nodeId: '1:1' }, {
    evaluate: evaluate(fixture({ initial: '{bad' }).figma),
  });
  assert.equal(corrupt.result.error, 'Axis metadata is not valid JSON.');
  assert.deepEqual(corrupt.result.ranges, []);
  const oversized = await executeFontAxisMetadata({ action: 'axes', nodeId: '1:1' }, {
    evaluate: evaluate(fixture({
      initial: 'x'.repeat(MAX_FONT_AXIS_METADATA_CODE_UNITS + 1),
    }).figma),
  });
  assert.equal(oversized.result.error, 'Axis metadata exceeds its bounded size.');
  assert.deepEqual(oversized.result.ranges, []);
});

test('Font remember-axes writes once, proves fresh state, and skips an exact no-op', async () => {
  const live = fixture();
  const applied = await executeFontAxisMetadata({
    action: 'remember-axes', nodeId: '1:1', axes: { wght: 357 }, start: 1, end: 4,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(applied.result.status, 'applied'); assert.equal(applied.result.outcome, 'verified');
  assert.equal(applied.result.result.appliedToFont, false); assert.equal(live.writes, 1); assert.equal(live.reads, 2);
  assert.deepEqual(JSON.parse(live.raw), {
    schemaVersion: 1, ranges: [{ start: 1, end: 4, axes: { wght: 357 } }],
  });
  const unchanged = await executeFontAxisMetadata({
    action: 'remember-axes', nodeId: '1:1', axes: { wght: 357 }, start: 1, end: 4,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(unchanged.result.status, 'unchanged'); assert.equal(live.writes, 1);
});

test('Font forget-axes removes one exact range or clears all corrupted metadata', async () => {
  const initial = JSON.stringify({ schemaVersion: 1, ranges: [
    { start: 0, end: 1, axes: { wght: 300 } },
    { start: 1, end: 4, axes: { wdth: 82 } },
  ] });
  const live = fixture({ initial });
  const scoped = await executeFontAxisMetadata({
    action: 'forget-axes', nodeId: '1:1', start: 1, end: 4,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(scoped.result.result.cleared, 1); assert.equal(scoped.result.result.all, false);
  assert.equal(JSON.parse(live.raw).ranges.length, 1);

  const corrupt = fixture({ initial: '{bad' });
  const cleared = await executeFontAxisMetadata({ action: 'forget-axes', nodeId: '1:1' }, {
    evaluate: evaluate(corrupt.figma),
  });
  assert.equal(cleared.result.result.cleared, null); assert.equal(cleared.result.result.all, true);
  assert.equal(corrupt.raw, '');
});

test('Font Axis Metadata accepts thrown acknowledgement only after proof and reports rollback', async () => {
  const applied = fixture({ behavior: 'throw-after-apply' });
  const result = await executeFontAxisMetadata({
    action: 'remember-axes', nodeId: '1:1', axes: { wght: 400 },
  }, { evaluate: evaluate(applied.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');

  const refused = fixture({ initial: '{bad' });
  await assert.rejects(() => executeFontAxisMetadata({
    action: 'remember-axes', nodeId: '1:1', axes: { wght: 400 },
  }, { evaluate: evaluate(refused.figma) }), (error) => error.mutationOutcome === 'no-mutation'
    && error.mutationReport.attempted === 0);

  const rolledBack = fixture({ behavior: 'throw-before-apply' });
  await assert.rejects(() => executeFontAxisMetadata({
    action: 'remember-axes', nodeId: '1:1', axes: { wght: 400 },
  }, { evaluate: evaluate(rolledBack.figma) }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.residueCount === 0);
});

test('Font Axis Metadata rejects forged and oversized Plugin results', async () => {
  for (const [request, value] of [
    [{ action: 'axes', nodeId: '1:1' }, 'not-json'],
    [{ action: 'axes', nodeId: '1:1' }, JSON.stringify({ id: '1:1', privateField: true })],
    [{ action: 'axes', nodeId: '1:1' }, 'x'.repeat(MAX_FONT_AXIS_METADATA_RESULT_CODE_UNITS + 1)],
    [{ action: 'remember-axes', nodeId: '1:1', axes: { wght: 400 } }, JSON.stringify({ status: 'applied' })],
    [{ action: 'remember-axes', nodeId: '1:1', axes: { wght: 400 }, start: 1, end: 4 }, JSON.stringify({ schemaVersion: 1, status: 'applied', action: 'remember-axes', outcome: 'verified', attempted: 1, result: { id: '1:1', name: 'Neutral Text', range: { start: 0, end: 5 }, axes: { wght: 400 }, source: 'plugin-data', appliedToFont: false, note: 'Stored intent only; Figma glyph rendering was not changed.' }, residueCount: 0, warnings: [] })],
  ]) await assert.rejects(() => executeFontAxisMetadata(request, { evaluate: async () => value }), /invalid/i);
});

test('Font Axis Metadata owns authentic safe-read and non-retrying write Plans', async () => {
  const url = 'https://www.figma.com/design/FILEA/Font-Lab?node-id=1-1';
  for (const request of [
    { action: 'axes', nodeId: url },
    { action: 'remember-axes', nodeId: url, axes: { wght: 357 } },
    { action: 'forget-axes', nodeId: url },
  ]) {
    const mcp = planFigmaCommand(fontAxisMetadataPlanningArgvFromRequest(request), { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true); assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(mcp.id, `font.${request.action}`); assert.equal(mcp.target.fileKey, 'FILEA');
    assert.equal(mcp.execution.retry, request.action === 'axes' ? 'safe-read' : 'never');
    assert.equal(fontAxisMetadataPlanRoute(mcp), 'command-application');
  }
  const plan = planFigmaCommand(['font', 'axes', '1:1'], { adapter: 'mcp' });
  const result = await executeFontAxisMetadataPlan(plan, {
    evaluate: async () => JSON.stringify({ id: '1:1', name: 'Neutral Text', source: 'plugin-data', appliedToFont: false, schemaVersion: 1, ranges: [] }),
  });
  assert.equal(result.result.appliedToFont, false);
});

test('Font Axis Metadata owns the Plan deadline and never writes glyph rendering fields', () => {
  for (const request of [
    { action: 'axes', nodeId: '1:1' },
    { action: 'remember-axes', nodeId: '1:1', axes: { wght: 357 } },
    { action: 'forget-axes', nodeId: '1:1' },
  ]) {
    const source = fontAxisMetadataCode(request);
    assert.doesNotMatch(source, /setTimeout|fontName\s*=|fontWeight\s*=|characters\s*=/);
    assert.doesNotThrow(() => new Function('figma', `return ${source}`));
  }
});
