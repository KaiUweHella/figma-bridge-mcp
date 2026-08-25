import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleDelete, executeStyleDeletePlan, styleDeleteCommandCode, styleDeletePlanRoute,
} from '../src/application/style-delete-command.js';
import {
  acceptsStyleDeleteArgv, parseStyleDeleteRequest, styleDeleteArgvFromRequest,
} from '../src/application/style-delete-request.js';

const fixture = (overrides = {}) => ({
  id: 'S:1', key: 'KEY', name: 'Disposable', type: 'GRID', remote: false,
  remove() { this.removed = true; }, ...overrides,
});
const figmaFor = (style) => ({
  getStyleByIdAsync: async (query) => query === style.id ? style : null,
  getLocalPaintStylesAsync: async () => [], getLocalTextStylesAsync: async () => [],
  getLocalEffectStylesAsync: async () => [], getLocalGridStylesAsync: async () => [style],
});
const pluginResult = (request, figma) => new Function('figma', `return ${styleDeleteCommandCode(request)}`)(figma);

test('Style Delete closes query and optional family narrowing', () => {
  assert.deepEqual(parseStyleDeleteRequest(['style', 'delete', '-tgrid', '--', '-Disposable']), {
    style: '-Disposable', type: 'GRID',
  });
  assert.deepEqual(styleDeleteArgvFromRequest({ style: 'Disposable', type: 'grid' }),
    ['style', 'delete', '--type', 'GRID', '--', 'Disposable']);
  for (const argv of [
    ['style', 'delete'], ['style', 'delete', 'A', 'B'],
    ['style', 'delete', 'A', '--type'], ['style', 'delete', 'A', '--type', 'FUTURE'],
    ['style', 'delete', 'A', '--future'],
  ]) assert.equal(acceptsStyleDeleteArgv(argv), false, argv.join(' '));
});

test('Style Delete removes one local Style and returns compact identity', async () => {
  const style = fixture({ layoutGrids: [{ pattern: 'COLUMNS', count: Infinity }] });
  const request = { style: 'Disposable', type: 'GRID' };
  const serialized = await pluginResult(request, figmaFor(style));
  const result = await executeStyleDelete(request, { evaluate: async () => serialized });
  assert.equal(style.removed, true);
  assert.equal(result.result.status, 'deleted');
  assert.equal(Object.hasOwn(result.result.style, 'layoutGrids'), false);
  assert.equal(result.stdout.includes('null'), false);
});

test('Style Delete reports possible residue when remove throws', async () => {
  const style = fixture({ remove() { throw new Error('remove failed'); } });
  const request = { style: 'S:1', type: 'GRID' };
  const serialized = await pluginResult(request, figmaFor(style));
  await assert.rejects(() => executeStyleDelete(request, { evaluate: async () => serialized }), (error) => {
    assert.equal(error.dispatchState, 'failed');
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.styleMutationReport.residueCount, 1);
    return true;
  });
});

test('Style Delete rejects remote and malformed outcomes', async () => {
  await assert.rejects(() => pluginResult({ style: 'S:1' }, figmaFor(fixture({ remote: true }))), /Remote styles/);
  const request = { style: 'S:1' };
  const serialized = await pluginResult(request, figmaFor(fixture()));
  const payload = JSON.parse(serialized);
  await assert.rejects(() => executeStyleDelete(request, {
    evaluate: async () => JSON.stringify({ ...payload, residue: [payload.style] }),
  }), /invalid bounded result/);
});

test('Style Delete Plan is policy-identical and never retries', async () => {
  const cli = planFigmaCommand(['style', 'delete', 'Disposable', '--type', 'GRID'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['style', 'delete', '-tgrid', '--', 'Disposable'], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(styleDeletePlanRoute(cli), 'command-application');
  const serialized = await pluginResult({ style: 'Disposable', type: 'GRID' }, figmaFor(fixture()));
  assert.equal((await executeStyleDeletePlan(cli, { evaluate: async () => serialized })).result.status, 'deleted');
});
