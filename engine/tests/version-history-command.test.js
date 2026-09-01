import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeHistory,
  executeHistoryPlan,
  historyPlanRoute,
  MAX_VERSION_SAVE_RESULT_CODE_UNITS,
  versionHistorySaveCode,
} from '../src/application/history-command.js';
import {
  acceptsHistoryArgv,
  historyArgvFromRequest,
  parseHistoryRequest,
} from '../src/application/history-request.js';
import { normalizeVersionRequest, saveVersionCode } from '../src/lib/version-history.js';

test('version requests trim user text and reject empty titles', () => {
  assert.deepEqual(normalizeVersionRequest({ title: '  Release 1 ', description: '  ready ' }), {
    title: 'Release 1', description: 'ready',
  });
  assert.throws(() => normalizeVersionRequest({ title: '   ' }), /must not be empty/);
});

test('history save uses the Plugin API and returns its version id', async () => {
  let received = null;
  const figma = {
    saveVersionHistoryAsync: async (...args) => { received = args; return { id: 'version-7' }; },
  };
  const result = await new Function('figma', `return ${saveVersionCode({ title: 'Release 1', description: 'Ready' })}`)(figma);
  assert.deepEqual(received, ['Release 1', 'Ready']);
  assert.deepEqual(result, { id: 'version-7', title: 'Release 1', description: 'Ready' });
});

test('History Save closes options, literal titles, and canonical argv', () => {
  assert.deepEqual(parseHistoryRequest([
    'history', 'save', '-d', ' Ready ', '--', '--help',
  ]), { action: 'save', title: '--help', description: 'Ready' });
  assert.deepEqual(historyArgvFromRequest({ title: ' Release 1 ', description: ' Ready ', action: 'save' }), [
    'history', 'save', '--description', 'Ready', '--', 'Release 1',
  ]);
  assert.deepEqual(parseHistoryRequest(['history', 'save', '-dReady', 'Release 1']), {
    action: 'save', title: 'Release 1', description: 'Ready',
  });
  for (const argv of [
    ['history', 'save'],
    ['history', 'save', 'A', 'B'],
    ['history', 'save', 'A', '--future', 'private-value'],
    ['history', 'save', 'A', '--description', 'one', '--description', 'two'],
  ]) assert.equal(acceptsHistoryArgv(argv), false, argv.join(' '));
});

test('History Save returns one bounded native version fact', async () => {
  let calls = 0;
  const figma = {
    saveVersionHistoryAsync: async (title, description) => {
      calls += 1;
      assert.deepEqual([title, description], ['Release 1', 'Ready']);
      return { id: 'version-7' };
    },
  };
  const result = await executeHistory({ action: 'save', title: 'Release 1', description: 'Ready' }, {
    evaluate: async (code) => new Function('figma', `return ${code}`)(figma),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.result, { id: 'version-7', title: 'Release 1', description: 'Ready' });
  assert.match(result.stdout, /Saved Figma version "Release 1" \(version-7\)/);
  assert.doesNotMatch(versionHistorySaveCode({ action: 'save', title: 'Release 1' }), /setTimeout/);
});

test('History Save rejects malformed, forged, and oversized Plugin results', async () => {
  for (const value of [
    'not-json',
    JSON.stringify({ id: 'version-7', title: 'Forged', description: null }),
    JSON.stringify({ id: 'version-7', title: 'Release 1', description: null, privateField: true }),
    'x'.repeat(MAX_VERSION_SAVE_RESULT_CODE_UNITS + 1),
  ]) {
    await assert.rejects(
      () => executeHistory({ action: 'save', title: 'Release 1' }, { evaluate: async () => value }),
      /invalid (?:JSON|bounded result)/,
    );
  }
});

test('History Save owns one authentic cross-Adapter non-retrying write Plan', async () => {
  const mcp = planFigmaCommand([
    'history', 'save', '--description', 'Ready', '--', 'Release 1',
  ], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'history.save'); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.effects.figma, 'write'); assert.equal(mcp.execution.retry, 'never');
  assert.equal(historyPlanRoute(mcp), 'command-application');
  let evaluations = 0;
  const result = await executeHistoryPlan(mcp, {
    evaluate: async () => {
      evaluations += 1;
      return JSON.stringify({ id: null, title: 'Release 1', description: 'Ready' });
    },
  });
  assert.equal(evaluations, 1); assert.equal(result.code, 0);
});
