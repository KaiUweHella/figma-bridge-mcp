import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient } from '../src/lib/jsx-render.js';
import {
  evaluateTextFidelity,
  formatTextFidelity,
  planTextExpectations,
  semanticTextFidelityProbeCode,
} from '../src/lib/semantic-text-fidelity.js';

const plan = () => new FigmaClient().planJSX(
  '<Frame name="card" flex="col" w={406}>'
  + '<Text name="text.0" font="DM Sans" weight="700" size={40} w="fill">Keep decisions moving.</Text>'
  + '<Text name="text.1" font="DM Sans" size={12} w="hug">Sub</Text>'
  + '<Text name="text.2" size={12} w="fill">Body copy on three lines in the browser.</Text>'
  + '</Frame>',
);
const measuredLines = { 'card/text.0': 1, 'card/text.1': 1, 'card/text.2': 3 };

const record = (overrides) => ({
  id: '1:1', path: 'card/text.0', family: 'DM Sans', style: 'Bold', size: 40,
  lineHeight: { unit: 'AUTO' }, width: 406, height: 48, autoResize: 'HEIGHT', characters: 22,
  ...overrides,
});

describe('text fidelity', () => {
  it('reads every text the plan asked for, with the requested font and the measured line count', () => {
    assert.deepEqual(planTextExpectations(plan()).map((e) => e.lines), [null, null, null], 'no measurement, no line expectation');
    const expectations = planTextExpectations(plan(), { measuredLines });
    assert.deepEqual(expectations.map((e) => [e.path, e.family, e.style, e.lines, e.width]), [
      ['card/text.0', 'DM Sans', 'Bold', 1, 'fill'],
      ['card/text.1', 'DM Sans', 'Regular', 1, 'hug'],
      ['card/text.2', null, null, 3, 'fill'],
    ]);
  });

  it('reports a font that fell back and a run that wrapped, and nothing when Figma agreed', () => {
    const expectations = planTextExpectations(plan(), { measuredLines });
    const report = evaluateTextFidelity(expectations, [
      record({ family: 'Inter', style: 'Bold', height: 96 }),
      record({ id: '1:2', path: 'card/text.1', style: 'Regular', size: 12, width: 20, height: 14 }),
      record({ id: '1:3', path: 'card/text.2', family: 'Inter', style: 'Regular', size: 12, width: 406, height: 44 }),
    ]);
    assert.equal(report.matched, 3);
    assert.deepEqual(report.findings.map((f) => [f.kind, f.path]), [
      ['font-fallback', 'card/text.0'],
      ['line-count', 'card/text.0'],
    ]);
    assert.match(report.findings[0].actual, /^Inter Bold$/);
    assert.match(report.findings[1].actual, /2 line\(s\) in Figma/);
    assert.match(formatTextFidelity(report), /3\/3 text\(s\) measured, 2 finding\(s\)/);

    const agreed = evaluateTextFidelity(expectations, [
      record({ height: 48 }),
      record({ id: '1:2', path: 'card/text.1', style: 'Regular', size: 12, width: 20, height: 14 }),
      record({ id: '1:3', path: 'card/text.2', family: 'Inter', style: 'Regular', size: 12, width: 406, height: 44 }),
    ]);
    assert.deepEqual(agreed.findings, []);
  });

  it('treats a style-only difference as its own finding and compares styles loosely', () => {
    const expectations = planTextExpectations(plan(), { measuredLines });
    const report = evaluateTextFidelity(expectations, [record({ style: 'ExtraBold' })]);
    assert.deepEqual(report.findings.map((f) => f.kind), ['font-style-fallback']);
    assert.deepEqual(evaluateTextFidelity(expectations, [record({ style: 'bold' })]).findings, []);
  });

  it('counts a text the probe did not find by path and refuses an invalid probe', () => {
    const expectations = planTextExpectations(plan(), { measuredLines });
    const report = evaluateTextFidelity(expectations, [record({ path: 'somewhere/else' })]);
    assert.equal(report.unmatched, 3);
    assert.throws(() => evaluateTextFidelity(expectations, [{ path: 1 }]), /invalid bounded result/);
    assert.throws(() => evaluateTextFidelity(expectations, 'nope'), /invalid bounded result/);
  });

  it('builds a parsable probe for a node id only', () => {
    assert.match(semanticTextFidelityProbeCode('12:34'), /figmaBridge\.semanticPath/);
    assert.throws(() => semanticTextFidelityProbeCode('drop table'), /node id/);
  });
});
