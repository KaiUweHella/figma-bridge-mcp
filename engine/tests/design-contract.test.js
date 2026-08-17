import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesignContract,
  canonicalDesignCapture,
  checkDesignContract,
  serializeDesignContract,
  validateDesignRules,
} from '../src/lib/design-contract.js';

const entity = {
  id: 'ui.button', kind: 'component',
  figma: { fileKey: 'FILE', nodeId: '1:1' },
};

function capture({ id = '1:1', width = 200, variantCount = 4, bindings = true, reaction = true } = {}) {
  const variants = [
    ['Size=S, State=Default', 80, 32],
    ['Size=S, State=Hover', 80, 32],
    ['Size=M, State=Default', 96, 40],
    ['Size=M, State=Hover', 96, 40],
  ].slice(0, variantCount).map(([n, w, h], index) => ({
    id: `${id}:${index}`, key: `KEY_${index}`, t: 'COMPONENT', n, w, h,
    ...(bindings ? { bv: { fills: 'color/action/background' } } : {}),
    ...(reaction && index === 0 ? { rx: [{ on: 'MOUSE_ENTER', do: 'CHANGE_TO', to: 'State=Hover' }] } : {}),
    kids: [],
  }));
  return {
    schemaVersion: 5,
    source: { fileKey: 'FILE', connectionId: 'CONN', documentRevisionBefore: 1, documentRevisionAfter: 1 },
    completeness: { payloadComplete: true, depthLimited: false },
    result: {
      id, name: 'Button',
      frames: [{
        id, key: 'SET_KEY', t: 'COMPONENT_SET', n: 'Button', w: width, h: 100,
        vp: { State: { values: ['Default', 'Hover'] }, Size: { values: ['S', 'M'] } },
        kidCount: variantCount, kids: variants,
      }],
      sets: [],
    },
  };
}

test('canonical Design Capture removes volatile handles but preserves authored child order', () => {
  const first = canonicalDesignCapture(capture({ id: '1:1' }));
  const recreated = canonicalDesignCapture(capture({ id: '99:4' }));
  assert.deepEqual(first, recreated);
  assert.equal('id' in first.frames[0], false);
  assert.equal('key' in first.frames[0], false);
  assert.equal(first.frames[0].kids[0].n, 'Size=S, State=Default');
});

test('contract combines exact canonical drift with semantic component-set rules', () => {
  const contract = buildDesignContract({ entity, capture: capture(), createdAt: '2026-08-17T10:00:00.000Z' });
  assert.equal(contract.version, 1);
  assert.deepEqual(contract.rules.componentSets[0].axes, {
    Size: ['M', 'S'], State: ['Default', 'Hover'],
  });
  assert.equal(contract.rules.componentSets[0].exhaustive, true);
  assert.equal(contract.rules.componentSets[0].minTokenBindings, 4);
  assert.equal(contract.rules.componentSets[0].transitions.length, 1);
  assert.equal(checkDesignContract(contract, capture({ id: '8:8' })).ok, true,
    'recreated Figma ids are not design drift');
});

test('rules identify incomplete variants, lost token bindings, geometry drift and reactions', () => {
  const contract = buildDesignContract({ entity, capture: capture() });
  const changed = capture({ variantCount: 3, bindings: false, reaction: false });
  changed.result.frames[0].kids[0].h = 60;
  const check = checkDesignContract(contract, changed);
  assert.equal(check.ok, false);
  assert.equal(check.canonicalEqual, false);
  const codes = new Set(check.rules.violations.map((violation) => violation.code));
  assert.ok(codes.has('variant-count'));
  assert.ok(codes.has('variant-matrix-incomplete'));
  assert.ok(codes.has('token-bindings'));
  assert.ok(codes.has('prototype-transition'));
  assert.ok(codes.has('variant-geometry'));
});

test('geometry tolerance absorbs renderer noise but not authored size changes', () => {
  const contract = buildDesignContract({ entity, capture: capture(), geometryTolerance: 0.5 });
  const noise = capture({ width: 200.3 });
  assert.equal(validateDesignRules(contract.rules, noise).ok, true);
  const changed = capture({ width: 201 });
  assert.equal(validateDesignRules(contract.rules, changed).ok, false);
});

test('incomplete captures cannot become an apparently clean contract', () => {
  const incomplete = capture();
  incomplete.completeness.depthLimited = true;
  assert.throws(() => buildDesignContract({ entity, capture: incomplete }), /incomplete or depth-limited/);
});

test('serialized contract is deterministic and retains provenance handles', () => {
  const contract = buildDesignContract({ entity, capture: capture(), createdAt: '2026-08-17T10:00:00.000Z' });
  const text = serializeDesignContract(contract);
  const parsed = JSON.parse(text);
  assert.equal(parsed.provenance.nodeId, '1:1');
  assert.equal(parsed.provenance.fileKey, 'FILE');
  assert.equal(text, serializeDesignContract(parsed));
});
