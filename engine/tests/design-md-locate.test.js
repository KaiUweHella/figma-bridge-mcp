import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateDesignMd } from '../src/lib/design-md-locate.js';

test('locateDesignMd returns an explicit path when it exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dml-'));
  const f = join(dir, 'DESIGN.md');
  writeFileSync(f, '# x');
  assert.equal(locateDesignMd(f), f);
});

test('locateDesignMd prefers a file containing a Components section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dml-'));
  writeFileSync(join(dir, 'other.md'), '# nothing here');
  const good = join(dir, 'DESIGN.md');
  writeFileSync(good, 'Sample variant structure:\n- **X** · `FRAME`');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    // process.cwd() resolves macOS /var → /private/var symlinks, matching what
    // the scanner returns; derive the expected path from it, not from `good`.
    assert.equal(locateDesignMd(), join(process.cwd(), 'DESIGN.md'));
  } finally { process.chdir(cwd); }
});
