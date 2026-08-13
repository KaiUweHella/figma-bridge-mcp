// Reuse/repeat lint for `render` — pure functions plus the cached inventory
// snippet. Snippets are parsed with new Function (a parser, not an executor):
// a syntax error inside a template literal is invisible to node --check.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  namedContainers,
  matchInventory,
  formatReuseWarning,
  repeatSignature,
  findRepeatedSiblings,
} from '../src/lib/render-lint.js';
import { cachedInventoryCode } from '../src/lib/component-inventory.js';
import { FigmaClient } from '../src/lib/jsx-render.js';

const parses = (code, what) =>
  assert.doesNotThrow(() => new Function(code), SyntaxError, `${what} is not valid JS`);

const INVENTORY = {
  componentSets: [
    {
      id: '10:1', name: 'Button', page: 'Components',
      variantAxes: { State: { values: ['Default', 'Hover'] }, Size: { values: ['S', 'M'] } },
      variants: [],
    },
  ],
  standaloneComponents: [
    { id: '10:9', name: 'Plant Card', page: 'Components' },
  ],
};

describe('namedContainers', () => {
  test('collects named Frames, skips Instances, auto-names and short names', () => {
    const names = namedContainers([
      '<Frame name="Button"><Instance name="Chip" component="Chip" /><Frame name="Frame"></Frame><Frame name="OK"></Frame></Frame>',
    ]);
    assert.deepEqual(names, ['Button']);
  });

  test('dedupes across strings by normalized name', () => {
    const names = namedContainers([
      '<Frame name="Button"></Frame>',
      '<Frame name="button"></Frame>',
    ]);
    assert.equal(names.length, 1);
  });
});

describe('matchInventory', () => {
  test('exact and slash-segment matches hit, case-insensitively', () => {
    assert.equal(matchInventory(['Button'], INVENTORY)[0].match.id, '10:1');
    assert.equal(matchInventory(['button'], INVENTORY)[0].match.id, '10:1');
    assert.equal(matchInventory(['Button/Primary'], INVENTORY)[0].match.id, '10:1');
    assert.equal(matchInventory(['plant card'], INVENTORY)[0].kind, 'component');
  });

  test('never a prefix test — "Buttons Overview" does not hit "Button"', () => {
    assert.deepEqual(matchInventory(['Buttons Overview'], INVENTORY), []);
    assert.deepEqual(matchInventory(['Button Bar'], INVENTORY), []);
  });
});

describe('formatReuseWarning', () => {
  test('set finding carries axes and requires a Design Entity decision instead of name-based reuse', () => {
    const [f] = matchInventory(['Button'], INVENTORY);
    const w = formatReuseWarning(f);
    assert.match(w, /component set "Button" \(10:1\)/);
    assert.match(w, /State: Default \| Hover/);
    assert.match(w, /decision required/);
    assert.match(w, /data-figma-component/);
    assert.match(w, /name equality alone never authorizes/);
  });

  test('a slash tail matching an axis value pre-fills the variant attribute', () => {
    const [f] = matchInventory(['Button/Hover'], INVENTORY);
    assert.match(formatReuseWarning(f), /with variant="State=Hover"/);
  });
});

describe('repeat lint', () => {
  const parse = (jsx) => {
    const client = new FigmaClient();
    const open = jsx.match(/<Frame\s+([^>]*)>/);
    return client.parseChildren(client.extractContent(jsx.slice(open.index + open[0].length), 'Frame'));
  };
  const card = (name, text) =>
    `<Frame name="${name}" flex="col" gap={8} p={16} bg="#ffffff" rounded={12} w={200}>` +
    `<Text size={16} weight="bold">${text}</Text><Text size={12}>Sub</Text></Frame>`;

  test('3 structurally identical cards with different content are one finding', () => {
    const kids = parse(`<Frame name="P" flex="row">${card('Card A', 'Fern')}${card('Card B', 'Monstera')}${card('Card C', 'Ivy')}</Frame>`);
    const groups = findRepeatedSiblings(kids);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 3);
  });

  test('2 identical cards are below the threshold', () => {
    const kids = parse(`<Frame name="P" flex="row">${card('A', 'x')}${card('B', 'y')}</Frame>`);
    assert.equal(findRepeatedSiblings(kids).length, 0);
  });

  test('a structural difference (extra child) breaks the group', () => {
    const odd = `<Frame name="C" flex="col" gap={8} p={16} bg="#ffffff" rounded={12} w={200}>` +
      `<Text size={16} weight="bold">Fern</Text><Text size={12}>Sub</Text><Text size={10}>Extra</Text></Frame>`;
    const kids = parse(`<Frame name="P" flex="row">${card('A', 'x')}${card('B', 'y')}${odd}</Frame>`);
    assert.equal(findRepeatedSiblings(kids).length, 0);
  });

  test('content props stay out of the signature, style props go in', () => {
    const a = { _type: 'frame', name: 'A', text: 'Fern', gap: 8, _children: [] };
    const b = { _type: 'frame', name: 'B', text: 'Ivy', gap: 8, _children: [] };
    const c = { _type: 'frame', name: 'C', text: 'Ivy', gap: 12, _children: [] };
    assert.equal(repeatSignature(a), repeatSignature(b));
    assert.notEqual(repeatSignature(b), repeatSignature(c));
  });
});

describe('cachedInventoryCode', () => {
  test('generated eval parses and carries the cache guard', () => {
    const code = cachedInventoryCode(true);
    parses(code, 'cachedInventoryCode');
    assert.match(code, /__invCache/);
    assert.match(code, /60000/);
  });
});
