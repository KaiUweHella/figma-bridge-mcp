import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
    // Resolve both macOS /var aliases and Windows 8.3 path aliases before
    // comparing with the scanner's canonical result.
    assert.equal(locateDesignMd(), realpathSync.native(join(process.cwd(), 'DESIGN.md')));
  } finally { process.chdir(cwd); }
});
