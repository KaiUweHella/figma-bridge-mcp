// Semantic regression: `export code-spec --depth 1–3`
// always returned "no data" — the old retry loop guarded on `depth >= 4`
// and never executed shallow requests at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkWithDepthRetry } from '../src/commands/export-eval.js';

test('shallow depths (1–3) actually execute instead of returning null', async () => {
  const calls = [];
  const { result, depth } = await walkWithDepthRetry(2, async (d) => {
    calls.push(d);
    return { frames: [] };
  });
  assert.deepEqual(calls, [2], 'one attempt at the requested depth');
  assert.equal(depth, 2);
  assert.deepEqual(result, { frames: [] });
});

test('payload errors degrade the depth, never below the floor', async () => {
  const calls = [];
  const { result, depth } = await walkWithDepthRetry(8, async (d) => {
    calls.push(d);
    if (d > 4) throw new Error('payload too large');
    return { frames: ['ok'] };
  });
  assert.deepEqual(calls, [8, 6, 4]);
  assert.equal(depth, 4);
  assert.deepEqual(result, { frames: ['ok'] });
});

test('non-payload errors rethrow immediately', async () => {
  await assert.rejects(
    () => walkWithDepthRetry(6, async () => { throw new Error('node not found'); }),
    /node not found/,
  );
});

test('a blank result is retried once, then returned as-is', async () => {
  const calls = [];
  const { result } = await walkWithDepthRetry(3, async (d) => {
    calls.push(d);
    return null;
  });
  assert.deepEqual(calls, [3, 3], 'exactly one blank retry');
  assert.equal(result, null);
});
