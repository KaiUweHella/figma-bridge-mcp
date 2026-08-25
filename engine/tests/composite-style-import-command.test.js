import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compositeStyleImportCommandCode,
  executeCompositeStyleImport,
  prepareCompositeStyleImport,
} from '../src/application/composite-style-import-command.js';

function fixture({ existing = [], variables = [], failEffect = false, failFont = false } = {}) {
  const calls = [];
  const styles = new Map(existing.map((style) => [style.id, style]));
  let next = 1;
  const create = (type) => {
    const style = {
      id: `S:${next++}`, key: `KEY:${type}:${next}`, name: '', description: '', type,
      remote: false, boundVariables: {}, removed: false,
      setBoundVariable(field, variable) {
        calls.push(['bind', field, variable.name]);
        this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: variable.id };
      },
      remove() { calls.push(['remove', this.id]); this.removed = true; styles.delete(this.id); },
    };
    if (type === 'EFFECT' && failEffect) {
      Object.defineProperty(style, 'effects', { set() { throw new Error('effect rejected'); } });
    }
    styles.set(style.id, style); calls.push(['create', type, style.id]); return style;
  };
  return {
    calls, styles,
    figma: {
      getLocalTextStylesAsync: async () => existing.filter((style) => style.type === 'TEXT'),
      getLocalEffectStylesAsync: async () => existing.filter((style) => style.type === 'EFFECT'),
      getStyleByIdAsync: async (id) => styles.get(id) || null,
      loadFontAsync: async (font) => {
        calls.push(['font', font]);
        if (failFont) throw new Error('font unavailable');
      },
      createTextStyle: () => create('TEXT'),
      createEffectStyle: () => create('EFFECT'),
      variables: { getLocalVariablesAsync: async () => variables },
    },
  };
}

const source = () => ({ tokens: {
  typography: {
    'Type/Body': {
      fontFamily: 'Inter', fontStyle: 'Regular',
      fontSize: { value: 16, alias: 'size/body' }, lineHeight: 24,
    },
  },
  shadow: { 'Effect/Card': '0 2px 8px #00000033' },
} });

test('Composite Style facts are versioned, typed, structured, bound and deeply frozen', () => {
  const prepared = prepareCompositeStyleImport(source());
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(prepared.styles.map((style) => style.kind), ['TEXT', 'EFFECT']);
  assert.deepEqual(prepared.styles[0].properties, {
    fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
    lineHeight: { unit: 'PIXELS', value: 24 },
  });
  assert.deepEqual(prepared.styles[0].bindings.fontSize, {
    query: 'size/body', expectedType: 'FLOAT',
  });
  assert.deepEqual(prepared.styles[1].properties.effects[0], {
    type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 },
    offset: { x: 0, y: 2 }, radius: 8, spread: 0,
    visible: true, blendMode: 'NORMAL', showShadowBehindNode: false,
  });
});

test('Composite Style Import preflights then creates native Text/Effect Styles and verifies aliases', async () => {
  const prepared = prepareCompositeStyleImport(source());
  const variable = { id: 'V:1', name: 'size/body', resolvedType: 'FLOAT', remote: false };
  const live = fixture({ variables: [variable] });
  const result = await executeCompositeStyleImport(prepared, {
    evaluate: (code) => new Function('figma', `return ${code}`)(live.figma),
  });
  assert.equal(result.result.created, 2);
  assert.equal(result.result.matching, 0);
  assert.deepEqual(live.calls.slice(0, 2), [
    ['font', { family: 'Inter', style: 'Regular' }], ['create', 'TEXT', 'S:1'],
  ]);
  assert.ok(live.calls.some((call) => call[0] === 'bind' && call[1] === 'fontSize'));
  const effect = [...live.styles.values()].find((style) => style.type === 'EFFECT');
  assert.equal(Array.isArray(effect.effects), true);
  assert.equal(effect.effects[0].type, 'DROP_SHADOW');
});

test('font, Variable and existing-state conflicts fail before the first Style write', async () => {
  const prepared = prepareCompositeStyleImport(source());
  const variable = { id: 'V:1', name: 'size/body', resolvedType: 'FLOAT', remote: false };
  for (const live of [
    fixture({ variables: [] }),
    fixture({ variables: [variable], failFont: true }),
    fixture({ variables: [variable], existing: [{
      id: 'S:old', key: 'K:old', name: 'Type/Body', description: '', type: 'TEXT',
      remote: false, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 15,
      lineHeight: { unit: 'PIXELS', value: 24 }, boundVariables: {
        fontSize: { type: 'VARIABLE_ALIAS', id: 'V:1' },
      },
    }] }),
  ]) {
    await assert.rejects(
      () => new Function('figma', `return ${compositeStyleImportCommandCode(prepared)}`)(live.figma),
      /Variable was not found|font unavailable|authored state differs/,
    );
    assert.equal(live.calls.some((call) => call[0] === 'create'), false);
  }
});

test('duplicate existing Style identity is ambiguous before font or factory work', async () => {
  const prepared = prepareCompositeStyleImport({ tokens: { typography: {
    Body: { fontFamily: 'Inter', fontSize: 16 },
  } } });
  const existing = [1, 2].map((index) => ({
    id: `S:${index}`, key: `K:${index}`, name: 'Body', description: '', type: 'TEXT',
    remote: false, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16,
    boundVariables: {},
  }));
  const live = fixture({ existing });
  await assert.rejects(
    () => new Function('figma', `return ${compositeStyleImportCommandCode(prepared)}`)(live.figma),
    /identity is ambiguous/,
  );
  assert.deepEqual(live.calls, []);
});

test('a later Style failure removes the complete command-owned Style journal', async () => {
  const prepared = prepareCompositeStyleImport(source());
  const variable = { id: 'V:1', name: 'size/body', resolvedType: 'FLOAT', remote: false };
  const live = fixture({ variables: [variable], failEffect: true });
  await assert.rejects(
    () => executeCompositeStyleImport(prepared, {
      evaluate: (code) => new Function('figma', `return ${code}`)(live.figma),
    }),
    (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.equal(error.compositeStyleReport.attempted, 2);
      assert.equal(error.compositeStyleReport.removed, 2);
      return true;
    },
  );
  assert.deepEqual(live.calls.filter((call) => call[0] === 'remove').map((call) => call[1]), ['S:2', 'S:1']);
  assert.equal(live.styles.size, 0);
});

test('source identity reuses one exact authored Style without mutation', async () => {
  const existing = {
    id: 'S:source', key: 'KEY:source', name: 'Type/Body', description: 'Source exact',
    type: 'TEXT', remote: false, fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 16, boundVariables: {},
  };
  const prepared = prepareCompositeStyleImport({ tokens: { typography: {
    'Type/Body': {
      fontFamily: 'Inter', fontSize: 16, description: 'Source exact',
      sourceIdentity: { key: 'KEY:source' },
    },
  } } });
  const live = fixture({ existing: [existing] });
  const result = await executeCompositeStyleImport(prepared, {
    evaluate: (code) => new Function('figma', `return ${code}`)(live.figma),
  });
  assert.equal(result.result.created, 0);
  assert.equal(result.result.matching, 1);
  assert.equal(live.calls.some((call) => call[0] === 'create'), false);
});

test('unsupported composites stay explicit and do not require Plugin evaluation', async () => {
  const prepared = prepareCompositeStyleImport({ tokens: {
    typography: { Broken: { fontFamily: 'Inter' } }, shadow: { Broken: 'calc(1px) #000' },
  } });
  assert.equal(prepared.styles.length, 0);
  assert.equal(prepared.unsupported.length, 2);
  const result = await executeCompositeStyleImport(prepared, {});
  assert.equal(result.result.created, 0);
  assert.equal(result.result.unsupported.length, 2);
});

test('multi-layer CSS shadows become one Effect Style with ordered native effects', () => {
  const prepared = prepareCompositeStyleImport({ tokens: { shadow: {
    Raised: '0 1px 2px rgba(0, 0, 0, 0.1), inset 0 0px 1px #ffffff80',
  } } });
  assert.equal(prepared.unsupported.length, 0);
  assert.deepEqual(prepared.styles[0].properties.effects.map((effect) => effect.type), [
    'DROP_SHADOW', 'INNER_SHADOW',
  ]);
  assert.equal(prepared.styles[0].properties.effects[0].color.a, 0.1);
});
