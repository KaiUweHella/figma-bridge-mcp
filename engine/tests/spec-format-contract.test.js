// Lossless structured-output contract for design-to-code specs.
//
// YAML, pretty JSON and compact JSON are transport adapters over the SAME
// canonical model. A format is allowed to change syntax and whitespace only;
// it may never drop, coerce or invent a design fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPEC_FORMAT,
  STRUCTURED_SPEC_FORMATS,
  parseSpecModel,
  serializeSpecModel,
} from '../src/lib/spec-format.js';

const COMPLETE_MODEL = {
  schemaVersion: 1,
  capture: {
    phase: 'all', requestedDepth: 12, actualDepth: 12,
    includeHidden: true, payloadComplete: true, depthLimited: false,
  },
  name: 'Frame: true #1',
  id: '12:34',
  frames: [{
    t: 'FRAME', n: 'Hero', id: '12:35', w: 1440, h: 900,
    abs: { left: 0, top: 0 }, overhang: 'visible-by-design', s: 'S1',
    kids: [{
      t: 'TEXT', n: 'Title', id: '12:36', text: 'Grün → groß ≠ guessed',
      style: { txt: { font: 'Inter', style: 'Semi Bold', size: 48 } },
    }],
  }],
  sets: [{
    name: 'Button', id: '20:1', setKey: 'set-key', dvKey: 'variant-key',
    props: { State: ['Default', 'Hover', 'Disabled'] },
  }],
  styles: { S1: { fills: ['#ffffff'], r: [16, 16, 16, 16] } },
  checks: {
    assets: { count: 1, files: ['assets/hero-wave.svg'] },
    overlays: { count: 1, transparency: [{ overlay: 'Wave', through: ['Hero'] }] },
    interactiveSets: [{ name: 'Button', id: '20:1', axes: ['State'] }],
  },
  storybook: [{ figmaName: 'Button', storyId: 'components-button--default' }],
};

test('all structured spec adapters roundtrip the complete canonical model exactly', () => {
  assert.equal(DEFAULT_SPEC_FORMAT, 'json-compact');
  assert.deepEqual(STRUCTURED_SPEC_FORMATS, ['yaml', 'json', 'json-compact']);
  for (const format of STRUCTURED_SPEC_FORMATS) {
    const encoded = serializeSpecModel(COMPLETE_MODEL, format);
    const decoded = parseSpecModel(encoded, format);
    assert.deepEqual(decoded, COMPLETE_MODEL, `${format} changed the canonical model`);
  }
});

test('compact JSON only removes presentation whitespace', () => {
  const pretty = serializeSpecModel(COMPLETE_MODEL, 'json');
  const compact = serializeSpecModel(COMPLETE_MODEL, 'json-compact');
  assert.ok(compact.length < pretty.length, `${compact.length} !< ${pretty.length}`);
  assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
});

test('unknown structured formats fail explicitly', () => {
  assert.throws(() => serializeSpecModel(COMPLETE_MODEL, 'toml'), /Unknown structured spec format/);
  assert.throws(() => parseSpecModel('{}', 'toml'), /Unknown structured spec format/);
});
