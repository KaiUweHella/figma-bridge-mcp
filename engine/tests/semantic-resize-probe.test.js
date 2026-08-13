import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import {
  formatSemanticResizeProbe,
  parseResizeProbeDelta,
  semanticRootResizeProbeCode,
} from '../src/lib/semantic-resize-probe.js';

describe('live semantic root resize probe', () => {
  it('validates the probe delta and generates parseable reversible code', () => {
    assert.equal(parseResizeProbeDelta(true), 120);
    assert.equal(parseResizeProbeDelta('240'), 240);
    assert.throws(() => parseResizeProbeDelta('0'), /1 to 2000/);
    assert.throws(() => parseResizeProbeDelta('wide'), /1 to 2000/);
    const code = semanticRootResizeProbeCode('12:34', 160);
    assert.doesNotThrow(() => new Script(code));
    assert.match(code, /getNodeByIdAsync\("12:34"\)/);
    assert.match(code, /root\.resize\(root\.width \+ 160/);
    assert.match(code, /finally/);
  });

  it('reports a responsive tree as passing and restores its exact geometry', async () => {
    const { figma, root } = responsiveFixture({ childFill: true });
    const report = await new Script(semanticRootResizeProbeCode(root.id, 120)).runInNewContext({ figma });
    assert.equal(report.passed, true);
    assert.equal(report.summary.responsiveCandidates, 2);
    assert.equal(report.summary.stuckResponsiveNodes, 0);
    assert.equal(report.summary.suspiciousFixedWidthNodes, 0);
    assert.equal(report.summary.restoreMismatches, 0);
    assert.equal(root.width, 400);
    assert.match(formatSemanticResizeProbe(report), /^PASS — \+120 px/);
  });

  it('fails when a measured full-width vertical child lost its FILL semantics', async () => {
    const { figma, root } = responsiveFixture({ childFill: false });
    const report = await new Script(semanticRootResizeProbeCode(root.id, 120)).runInNewContext({ figma });
    assert.equal(report.passed, false);
    assert.equal(report.summary.suspiciousFixedWidthNodes, 1);
    assert.equal(report.suspiciousFixed[0].path, 'root/workspace/topbar');
    assert.equal(report.summary.restoreMismatches, 0);
    assert.equal(root.width, 400);
  });
});

function responsiveFixture({ childFill }) {
  const pluginData = (path) => ({
    getPluginData(key) { return key === 'figmaBridge.semanticPath' ? path : ''; },
  });
  const root = {
    id: 'root', name: 'root', width: 400, height: 300, x: 0, y: 0,
    layoutMode: 'GRID', gridColumnSizes: [{ type: 'FIXED' }, { type: 'FLEX' }],
    ...pluginData('root'),
  };
  const workspace = {
    id: 'workspace', name: 'workspace', width: 300, height: 300, x: 100, y: 0,
    parent: root, layoutMode: 'VERTICAL', layoutSizingHorizontal: 'FILL',
    gridColumnAnchorIndex: 1, gridColumnSpan: 1, paddingLeft: 0, paddingRight: 0,
    ...pluginData('root/workspace'),
  };
  const topbar = {
    id: 'topbar', name: 'topbar', width: 300, height: 80, x: 0, y: 0,
    parent: workspace, layoutMode: 'HORIZONTAL',
    layoutSizingHorizontal: childFill ? 'FILL' : 'FIXED',
    ...pluginData('root/workspace/topbar'),
  };
  root.findAll = () => [workspace, topbar];
  root.resize = (width, height) => {
    root.width = width; root.height = height;
    workspace.width = width - 100;
    if (topbar.layoutSizingHorizontal === 'FILL') topbar.width = workspace.width;
  };
  return { root, figma: { getNodeByIdAsync: async () => root } };
}
