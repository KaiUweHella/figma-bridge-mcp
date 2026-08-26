import assert from 'node:assert/strict';
import { statSync } from 'node:fs';

/**
 * Assert the POSIX permission contract where Node exposes it faithfully.
 * Windows reports synthesized Unix mode bits; stat still proves the artifact
 * exists there, while its privacy comes from the inherited user-profile ACL.
 */
export function assertPosixMode(path, expected) {
  const metadata = statSync(path);
  assert.ok(metadata.isFile() || metadata.isDirectory());
  if (process.platform !== 'win32') {
    assert.equal(metadata.mode & 0o777, expected);
  }
}
