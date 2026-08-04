import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/lib/jsx-render.js';

// What survives of the old figma-client.test.js. Its first two suites tested
// URL regexes declared inside the test file itself — leftovers from the CDP
// client, exercising no product code at all. This is the part that does.
describe('FigmaClient (the JSX compiler)', () => {
  // The CDP-era connection state (pageUrl / fileType / pageTitle / ws) is gone
  // — the class is a pure JSX compiler now. What remains is the variable-
  // collection filter that var: resolution honors.
  it('starts with no collection filter', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.collectionFilter, null);
  });

  it('setCollection pins and clears the filter', () => {
    const client = new FigmaClient();
    client.setCollection('Brand');
    assert.strictEqual(client.collectionFilter, 'Brand');
    client.setCollection(null);
    assert.strictEqual(client.collectionFilter, null);
  });

  it('carries no transport state', () => {
    const client = new FigmaClient();
    assert.ok(!('ws' in client), 'no WebSocket state on a pure compiler');
  });
});
