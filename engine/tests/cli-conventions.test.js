// Conventions the command layer must keep, enforced by reading the sources.
// These are the regressions the engine review found: silent failures, a
// connection guard that was never awaited, success text on stderr, and
// library code stranded inside command files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');
const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.js'));
const sources = new Map(files.map((f) => [f, readFileSync(join(COMMANDS_DIR, f), 'utf8')]));

test('every checkConnection() call is awaited', () => {
  // It is async (it can respawn an idle-shut-down daemon). Un-awaited, the
  // guard is a no-op and the command races the daemon.
  const offenders = [];
  for (const [file, src] of sources) {
    src.split('\n').forEach((line, i) => {
      if (/(?<!await\s)\bcheckConnection\(\)/.test(line) && !line.trim().startsWith('//')) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('no command uses the removed figmaUse transport', () => {
  const offenders = [];
  for (const [file, src] of sources) {
    if (/\bfigmaUse\s*\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('success text goes to stdout via spinnerSucceed, never spinner.succeed', () => {
  // ora persists to stderr; the MCP layer folds stderr into its reply under a
  // "[warnings]" header, so a success summary reached the agent as a warning.
  const offenders = [];
  for (const [file, src] of sources) {
    if (/\.succeed\(/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('a11y checks fail loudly (no console.log for execution errors)', () => {
  const src = sources.get('a11y.js');
  assert.ok(src, 'a11y.js exists');
  // Every catch reports via handleEvalError (which exits 1); result.error
  // paths exit 1 explicitly. Neither may swallow into a zero exit.
  assert.ok(!/console\.log\(chalk\.red\('✗ .*failed/.test(src),
    'failed checks must not be logged-and-forgotten on stdout');
  assert.equal((src.match(/handleEvalError\(e\)/g) || []).length, 6,
    'all six a11y subcommands route errors through handleEvalError');
  assert.equal((src.match(/options\.failOnIssues/g) || []).length, 4,
    'the four violation-reporting checks offer --fail-on-issues for CI');
});

test('library code lives in lib/, not in command files', () => {
  // commands/map.js used to import componentInventoryCode from commands/misc.js.
  for (const [file, src] of sources) {
    const badImports = [...src.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map((m) => m[1]);
    assert.deepEqual(badImports, [], `${file} imports from a sibling command file`);
  }
});
