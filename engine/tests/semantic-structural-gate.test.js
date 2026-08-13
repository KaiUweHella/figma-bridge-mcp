import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditSemanticStructure, formatStructuralGate } from '../src/lib/semantic-structural-gate.js';
import { FigmaClient } from '../src/lib/jsx-render.js';

const node = (name, layout, children = [], extra = {}) => ({
  name, path: name, layout, positioning: { kind: 'flow' }, source: { kind: 'jsx', props: {} },
  paint: { background: { value: null, token: null } }, children, ...extra,
});

const model = (root, diagnostics = {}) => ({
  version: 1,
  root,
  diagnostics: {
    layouts: {}, absoluteNodes: 0, tokenReferences: 0,
    unresolvedIcons: [], classifiedFallbacks: [], unclassifiedFallbacks: [],
    ...diagnostics,
  },
});

describe('semantic structural acceptance gate', () => {
  it('passes a native Grid/Auto Layout tree with sourced tokens and absolutes', () => {
    const overlay = node('Shell/Overlay', { kind: 'leaf' }, [], {
      positioning: { kind: 'absolute' },
      source: { kind: 'jsx', props: { position: 'absolute' } },
    });
    const card = node('Shell/Card', { kind: 'flex', direction: 'column' }, [overlay], {
      paint: { background: { token: 'surface/card', value: '#ffffff' } },
    });
    const report = auditSemanticStructure(model(node('Shell', { kind: 'grid' }, [card])));
    assert.equal(report.passed, true);
    assert.deepEqual(report.summary, {
      nodes: 3, containers: 2, grids: 1, autoLayouts: 1,
      freeLayouts: 0, absoluteNodes: 1, tokenReferences: 1,
    });
    assert.match(formatStructuralGate(report), /Structural gate: PASS/);
  });

  it('fails unresolved icons, free layout and unapproved fallbacks', () => {
    const root = node('FreeRoot', { kind: 'free' });
    const report = auditSemanticStructure(model(root, {
      unresolvedIcons: [{ path: 'FreeRoot/Icon', name: 'mystery' }],
      classifiedFallbacks: [{ path: 'FreeRoot', fact: 'minmax()', fallback: 'weighted-flex-track-with-unenforced-minimum' }],
    }));
    assert.equal(report.passed, false);
    assert.deepEqual(report.checks.filter((check) => !check.passed).map((check) => check.id), [
      'free-layout', 'resolved-icons', 'approved-fallbacks',
    ]);
    assert.match(formatStructuralGate(report), /Structural gate: FAIL/);
  });

  it('accepts only explicitly named free paths and fallback classes', () => {
    const root = node('FreeRoot', { kind: 'free' });
    const report = auditSemanticStructure(model(root, {
      classifiedFallbacks: [{ path: 'FreeRoot', fact: 'flex=none', fallback: 'explicit-free-layout' }],
    }), {
      allowedFreePaths: ['FreeRoot'],
      approvedFallbacks: ['explicit-free-layout'],
    });
    assert.equal(report.passed, true);
  });

  it('accepts reviewed boundary defaults but stops for variable font axes', () => {
    const root = node('Grid', { kind: 'grid' });
    const accepted = auditSemanticStructure(model(root, {
      classifiedFallbacks: [
        { path: 'Grid', fact: 'minmax()', fallback: 'minmax.native-grid' },
        { path: 'Grid', fact: 'space-around', fallback: 'space-around.equal-slots' },
        { path: 'Grid', fact: 'mixed border paints', fallback: 'border.single-paint-native' },
      ],
    }));
    assert.equal(accepted.passed, true);

    const font = auditSemanticStructure(model(root, {
      classifiedFallbacks: [{ path: 'Grid/Label', fact: 'font axes', fallback: 'font.named-faces' }],
    }));
    assert.equal(font.passed, false);
    assert.match(formatStructuralGate(font), /Decision required before render/);
  });

  it('classifies hand-authored JSX font axes for the same preflight', () => {
    const model = new FigmaClient().analyzeJSX('<Frame><Text font="Roboto Flex" fontAxes="&quot;wght&quot; 615">Variable</Text></Frame>');
    assert.equal(model.diagnostics.classifiedFallbacks[0].fallback, 'font.named-faces');
    assert.equal(auditSemanticStructure(model).passed, false);
  });
});
