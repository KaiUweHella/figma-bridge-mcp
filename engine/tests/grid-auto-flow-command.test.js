import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGridAutoFlow,
  executeGridAutoFlowPlan,
  gridAutoFlowCode,
  gridAutoFlowPlanRoute,
} from '../src/application/grid-auto-flow-command.js';
import {
  acceptsGridAutoFlowArgv,
  gridAutoFlowArgvFromRequest,
  gridAutoFlowFigmaUrlFileKeyFromArgv,
  gridAutoFlowPlanningArgvFromRequest,
  parseGridAutoFlowRequest,
} from '../src/application/grid-auto-flow-request.js';

function fixture({
  beforeTracks = 'NONE',
  beforePositioning = 'MANUAL',
  mode = 'apply',
} = {}) {
  let tracks = beforeTracks;
  let positioning = beforePositioning;
  let reads = 0;
  const writes = [];
  const node = {
    id: '2:1', name: 'Neutral Grid', type: 'FRAME', layoutMode: 'GRID',
    get gridAutoTracks() { return tracks; },
    set gridAutoTracks(value) {
      writes.push(['autoTracks', value]);
      if (mode === 'wrong-positioning-rollback-tracks-fails' && value === beforeTracks && tracks !== beforeTracks) return;
      tracks = value;
    },
    get gridItemsPositioning() { return positioning; },
    set gridItemsPositioning(value) {
      writes.push(['positioning', value]);
      if (['wrong-positioning','wrong-positioning-rollback-tracks-fails'].includes(mode) && value === 'ROW_AUTO_FLOW') return;
      positioning = value;
      if (mode === 'throw-after-apply' && value === 'ROW_AUTO_FLOW') throw new Error('native setter reported failure');
    },
  };
  return {
    figma: { getNodeByIdAsync: async (id) => { reads += 1; return id === node.id ? node : null; } },
    reads: () => reads,
    state: () => ({ tracks, positioning }),
    writes,
  };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Grid Auto Flow closes and canonicalizes one URL-targeted request', () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=2-1';
  assert.deepEqual(parseGridAutoFlowRequest([
    'layout', 'grid', 'auto-flow', '--positioning=row_auto_flow', url, '--auto-tracks', 'rows',
  ]), { nodeId: '2:1', autoTracks: 'ROWS', positioning: 'ROW_AUTO_FLOW' });
  assert.equal(gridAutoFlowFigmaUrlFileKeyFromArgv([
    'layout', 'grid', 'auto-flow', url, '--auto-tracks', 'none', '--positioning', 'manual',
  ]), 'PLACEHOLDERFILEKEY');
  assert.deepEqual(gridAutoFlowArgvFromRequest({
    nodeId: '2-1', autoTracks: 'rows', positioning: 'row_auto_flow',
  }), ['layout', 'grid', 'auto-flow', '--auto-tracks', 'rows', '--positioning', 'row_auto_flow', '--', '2:1']);
  for (const args of [
    ['layout', 'grid', 'auto-flow', '2:1', '--auto-tracks', 'rows'],
    ['layout', 'grid', 'auto-flow', '2:1', '--auto-tracks', 'columns', '--positioning', 'manual'],
    ['layout', 'grid', 'auto-flow', '2:1', '--auto-tracks', 'rows', '--positioning', 'manual', '--future'],
    ['layout', 'grid', 'auto-flow', '2:1', '3:1', '--auto-tracks', 'rows', '--positioning', 'manual'],
  ]) assert.equal(acceptsGridAutoFlowArgv(args), false, args.join(' '));
});

test('Grid Auto Flow assigns both fields once and proves them by fresh readback', async () => {
  const live = fixture();
  const result = await executeGridAutoFlow({
    nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'applied');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.before, { autoTracks: 'NONE', positioning: 'MANUAL' });
  assert.deepEqual(result.result.after, { autoTracks: 'ROWS', positioning: 'ROW_AUTO_FLOW' });
  assert.deepEqual(live.writes, [['autoTracks', 'ROWS'], ['positioning', 'ROW_AUTO_FLOW']]);
  assert.equal(live.reads(), 2);
});

test('Grid Auto Flow detects an exact no-op without dispatch', async () => {
  const live = fixture({ beforeTracks: 'ROWS', beforePositioning: 'ROW_AUTO_FLOW' });
  const result = await executeGridAutoFlow({
    nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'unchanged');
  assert.equal(result.result.outcome, 'no-mutation');
  assert.equal(result.result.attempted, 0);
  assert.deepEqual(live.writes, []);
  assert.equal(live.reads(), 1);
});

test('Grid Auto Flow trusts fresh exact facts after a native setter error', async () => {
  const live = fixture({ mode: 'throw-after-apply' });
  const result = await executeGridAutoFlow({
    nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.deepEqual(live.state(), { tracks: 'ROWS', positioning: 'ROW_AUTO_FLOW' });
});

test('Grid Auto Flow rolls both fields back when the fresh postcondition fails', async () => {
  const live = fixture({ mode: 'wrong-positioning' });
  await assert.rejects(() => executeGridAutoFlow({
    nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.attempted === 1 && error.mutationReport.restored === 2
    && error.mutationReport.residueCount === 0);
  assert.deepEqual(live.state(), { tracks: 'NONE', positioning: 'MANUAL' });
});

test('Grid Auto Flow reports bounded residue when rollback cannot restore one field', async () => {
  const live = fixture({ mode: 'wrong-positioning-rollback-tracks-fails' });
  await assert.rejects(() => executeGridAutoFlow({
    nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);
});

test('Grid Auto Flow uses one non-retrying canonical Plan in both Adapters', async () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=2-1';
  const request = { nodeId: url, autoTracks: 'rows', positioning: 'row_auto_flow' };
  const cli = planFigmaCommand(gridAutoFlowArgvFromRequest(request), { adapter: 'cli' });
  const mcp = planFigmaCommand(gridAutoFlowPlanningArgvFromRequest(request), { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.equal(cli.id, 'layout.grid.auto-flow'); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'PLACEHOLDERFILEKEY');
  assert.equal(gridAutoFlowPlanRoute(mcp), 'command-application');
  const live = fixture(); let evaluations = 0;
  await executeGridAutoFlowPlan(mcp, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(evaluations, 1);
});

test('Grid Auto Flow rejects malformed Plugin results after dispatch', async () => {
  for (const payload of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeGridAutoFlow({
      nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
    }, { evaluate: async () => payload }), /invalid/i);
  }
  assert.doesNotThrow(() => new Function('figma', `return ${gridAutoFlowCode({
    nodeId: '2:1', autoTracks: 'rows', positioning: 'row_auto_flow',
  })}`));
});
