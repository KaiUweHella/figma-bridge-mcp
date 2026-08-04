// Every FigJam eval snippet, parsed.
//
// This suite exists because of a real bug: a full-width "］" slipped into a
// generated eval string. `node --check` sees only a template literal, so it
// passed; the error would have surfaced in the plugin sandbox, on one command,
// at runtime. Parsing each built snippet closes that gap for the whole group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import * as jam from '../src/lib/jam-snippets.js';

// Every builder with arguments that exercise its optional branches too.
const CASES = {
  'sticky (plain)': () => jam.sticky('Hello'),
  'sticky (named colour + placement)': () => jam.sticky('Hi', { color: 'green', at: '100,200' }),
  'sticky (hex colour)': () => jam.sticky('Hi', { color: '#ff00aa' }),
  'sticky (quotes and newlines in the text)': () => jam.sticky('He said "hi"\nthen `left`; ${x}'),
  stickies: () => jam.stickies([{ text: 'a', color: 'blue' }, { text: 'b', color: null }], { columns: 3 }),
  'stickies (placed)': () => jam.stickies([{ text: 'a', color: null }], { at: '10,20' }),
  shape: () => jam.shape('Decide', { type: 'DIAMOND', width: 120, height: 90 }),
  'connector (bare)': () => jam.connector('1:2', '3:4'),
  'connector (labelled, straight)': () => jam.connector('1:2', '3:4', { text: 'yes', line: 'STRAIGHT' }),
  'table (empty)': () => jam.table(2, 2),
  'table (with data)': () => jam.table(2, 2, { data: [['a', 'b'], ['c', 'd']], at: '0,0' }),
  section: () => jam.section('Ideas', { width: 400, height: 300 }),
  codeBlock: () => jam.codeBlock('const x = 1;', { lang: 'javascript' }),
  board: () => jam.board(),
  arrange: () => jam.arrange({ columns: 3, gap: 20 }),
};

for (const [name, build] of Object.entries(CASES)) {
  test(`snippet parses: ${name}`, () => {
    const source = build();
    assert.equal(typeof source, 'string');
    // Throws a SyntaxError with a useful message if the generated code is
    // malformed — which is the whole point.
    new Script(source, { filename: `jam-snippet:${name}` });
  });
}

test('every snippet guards on the editor before touching the API', () => {
  for (const [name, build] of Object.entries(CASES)) {
    const source = build();
    assert.match(source, /figma\.editorType !== 'figjam'/, `${name} is missing the editor guard`);
    // The guard has to come before the first API call, or it guards nothing.
    const guardAt = source.indexOf('editorType');
    const firstCreate = source.search(/figma\.create/);
    if (firstCreate !== -1) {
      assert.ok(guardAt < firstCreate, `${name} calls figma.create* before the guard`);
    }
  }
});

test('user text is embedded as JSON, so quotes and backticks cannot break out', () => {
  const nasty = '`; figma.currentPage.children.forEach(n => n.remove()); //';
  const source = jam.sticky(nasty);
  new Script(source, { filename: 'jam-snippet:injection' });
  // The payload must appear only inside a string literal, never as code.
  assert.ok(source.includes(JSON.stringify(nasty)));
  assert.equal(source.includes('n.remove()); //'), source.includes(JSON.stringify(nasty)));
});

test('colours resolve names, accept hex, and refuse anything else', () => {
  assert.match(jam.colorLiteral('yellow'), /^\{ r: [\d.]+, g: [\d.]+, b: [\d.]+ \}$/);
  assert.match(jam.colorLiteral('#0d7c74'), /^\{ r: 0\.05/);
  assert.equal(jam.colorLiteral('not-a-colour'), 'null');
  assert.equal(jam.colorLiteral(undefined), 'null');
  // A colour that is not understood must produce no fill at all rather than a
  // literal that would throw inside the sandbox.
  assert.match(jam.sticky('x', { color: 'chartreuse' }), /const fill = null;/);
});

test('an explicit position wins; a malformed one falls back to auto-placement', () => {
  assert.match(jam.sticky('x', { at: '10,20' }), /const origin = \{ x: 10, y: 20 \};/);
  assert.match(jam.sticky('x', { at: 'nonsense' }), /Math\.max\(\.\.\.existing/);
  assert.match(jam.sticky('x'), /Math\.max\(\.\.\.existing/);
});

test('arrange leaves connectors and sections alone', () => {
  const source = jam.arrange();
  assert.match(source, /n\.type !== 'CONNECTOR' && n\.type !== 'SECTION'/);
});
