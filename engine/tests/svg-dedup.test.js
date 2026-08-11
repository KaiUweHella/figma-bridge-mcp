import { test } from 'node:test';
import assert from 'node:assert/strict';

test('SVG visual fingerprint ignores generated ids and sub-pixel export noise', async () => {
  const { svgVisualFingerprint } = await import('../src/lib/svg-dedup.js');
  const first = Buffer.from('<svg width="24" height="24"><defs><clipPath id="clip0_1"><rect width="24" height="24"/></clipPath></defs><g clip-path="url(#clip0_1)"><path d="M10 8.33335L18.3334 11.6667"/></g></svg>');
  const duplicate = Buffer.from('<svg width="24" height="24"><defs><clipPath id="clip9_77"><rect width="24" height="24"/></clipPath></defs><g clip-path="url(#clip9_77)"><path d="M9.99996 8.33329L18.3333 11.6666"/></g></svg>');
  const different = Buffer.from('<svg width="24" height="24"><path d="M2.25 3.5L20.75 19.5"/></svg>');
  assert.equal(svgVisualFingerprint(first), svgVisualFingerprint(duplicate));
  assert.notEqual(svgVisualFingerprint(first), svgVisualFingerprint(different));
});
