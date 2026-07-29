// Local history (figma_history): node-id extraction, audit enrichment,
// filtering/formatting, legacy-line back-compat, git merge degradation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate BOTH state files before any src/ import: the audit log (written by
// runCli) and the pairing key (config.js reads the env at import time).
const tmp = mkdtempSync(join(tmpdir(), 'figma-safe-history-'));
const AUDIT = join(tmp, 'audit.log');
process.env.AUDIT_LOG_PATH = AUDIT;
process.env.PLUGIN_KEY_FILE = join(tmp, 'plugin-key');

const { extractNodeIds, runCli } = await import('../src/figma-cli.js');
const { parseAuditLines, entryNodes, filterHistory, gitHistory, formatHistory, buildHistory } =
  await import('../src/history.js');

test('extractNodeIds: plain ids, URL form normalized, dedupe, cap', () => {
  assert.deepEqual(extractNodeIds(['inspect', '12:34']), ['12:34']);
  // URL form node-id=12-34 → 12:34, deduped against the plain form
  assert.deepEqual(
    extractNodeIds(['https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=12-34', '12:34']),
    ['12:34'],
  );
  assert.deepEqual(extractNodeIds(['no ids here', '--flag']), []);
  const many = Array.from({ length: 60 }, (_, i) => `${i + 1}:0`);
  assert.equal(extractNodeIds(many, 50).length, 50);
});

test('runCli with label writes an enriched audit line; old lines stay valid', async () => {
  await runCli(['--help'], { label: 'discoverability check' });
  const lines = parseAuditLines(readFileSync(AUDIT, 'utf8'));
  const entry = lines.at(-1);
  assert.deepEqual(entry.args, ['--help']);
  assert.equal(entry.label, 'discoverability check');
  assert.ok(!('nodes' in entry), 'no nodes key when the args contain no ids');

  // A pre-enrichment line {ts, args} flows through entryNodes via re-extraction.
  const legacy = { ts: '2026-01-01T00:00:00.000Z', args: ['inspect', '7:9'] };
  assert.deepEqual(entryNodes(legacy), ['7:9']);
  assert.deepEqual(entryNodes(entry), []);
});

test('parseAuditLines skips malformed/truncated lines', () => {
  const text = [
    JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', args: ['canvas', 'info'] }),
    '{"ts": "2026-01-02T00:00:00.000Z", "args": ["node", "tr', // truncated
    'not json at all',
    JSON.stringify({ ts: '2026-01-03T00:00:00.000Z', args: ['inspect', '1:2'], nodes: ['1:2'] }),
  ].join('\n');
  const entries = parseAuditLines(text);
  assert.equal(entries.length, 2);
});

test('filterHistory: newest first, nodeId matches enriched AND legacy lines, limit', () => {
  const entries = [
    { ts: '2026-01-01T00:00:00.000Z', args: ['inspect', '1:2'] }, // legacy
    { ts: '2026-01-02T00:00:00.000Z', args: ['canvas', 'info'] },
    { ts: '2026-01-03T00:00:00.000Z', args: ['node', 'set', '1:2'], nodes: ['1:2'], label: 'resize hero' },
  ];
  const all = filterHistory(entries);
  assert.equal(all[0].ts, '2026-01-03T00:00:00.000Z');

  const forNode = filterHistory(entries, { nodeId: '1:2' });
  assert.equal(forNode.length, 2);
  assert.equal(forNode[0].label, 'resize hero');

  assert.equal(filterHistory(entries, { limit: 1 }).length, 1);
});

test('formatHistory: markdown table shape and json passthrough', () => {
  const entries = [
    { ts: '2026-01-03T00:00:00.000Z', source: 'design', args: ['node', 'set', '1:2'], nodes: ['1:2'], label: 'resize hero' },
    { ts: '2026-01-02T00:00:00.000Z', source: 'code', label: 'feat: hero section', ref: 'src/App.tsx' },
  ];
  const md = formatHistory(entries);
  assert.match(md, /\| Time \| Source \| Command \/ label \| Nodes \/ file \|/);
  assert.match(md, /\| design \| resize hero \| 1:2 \|/);
  assert.match(md, /\| code \| feat: hero section \| src\/App\.tsx \|/);

  const json = JSON.parse(formatHistory(entries, { format: 'json' }));
  assert.equal(json.length, 2);
  assert.equal(formatHistory([]), 'No history entries found.');
});

test('gitHistory: parses commits from a real repo, degrades to warning otherwise', (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
  } catch {
    t.skip('git not installed');
    return;
  }
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'App.tsx'), 'export {}');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'feat: initial hero'],
    { cwd: repo, stdio: 'pipe' },
  );

  const ok = gitHistory({ repoPath: repo, paths: ['App.tsx'] });
  assert.equal(ok.warning, null);
  assert.equal(ok.entries.length, 1);
  assert.equal(ok.entries[0].label, 'feat: initial hero');
  assert.equal(ok.entries[0].source, 'code');
  assert.equal(ok.entries[0].ref, 'App.tsx');
  assert.match(ok.entries[0].ts, /^\d{4}-\d{2}-\d{2}T/);

  // Not a repo → warning, empty entries, no throw.
  const bad = gitHistory({ repoPath: tmp, paths: ['nope.tsx'] });
  assert.equal(bad.entries.length, 0);
  assert.match(bad.warning, /git history unavailable/);
});

test('buildHistory: missing audit log yields a friendly empty message', () => {
  const out = buildHistory({ auditPath: join(tmp, 'does-not-exist.log') });
  assert.match(out, /No history yet/);
});

test('formatHistory sanitizes hostile labels/refs (markdown injection)', () => {
  const entries = [
    {
      ts: '2026-01-03T00:00:00.000Z', source: 'design',
      args: ['render', 'x'], nodes: ['1:2'],
      label: 'evil\n\n# injected heading\n| a | b |',
    },
    {
      ts: '2026-01-02T00:00:00.000Z', source: 'code',
      label: 'commit | with pipes', ref: 'src/a|b\nc.tsx',
    },
  ];
  const md = formatHistory(entries);
  const lines = md.split('\n');
  // Header + separator + exactly one row per entry — the newline payload must
  // not create extra markdown lines (the injected heading stays inline text).
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.startsWith('|')), 'every line stays a table row');
  // Pipes inside cells are escaped, so each row still has exactly 4 columns
  // (5 unescaped pipes).
  for (const row of lines.slice(2)) {
    assert.equal(row.split(/(?<!\\)\|/).length - 1, 5, row);
  }
});

test('server schemas: label and figma_history params are accepted', async () => {
  const { unknownParamError } = await import('../src/server.js');
  assert.equal(unknownParamError('figma_run', { args: ['canvas', 'info'], label: 'x' }), null);
  assert.equal(unknownParamError('figma_render', { jsx: '<Frame/>', label: 'x' }), null);
  assert.equal(
    unknownParamError('figma_history', { nodeId: '1:2', limit: 5, format: 'markdown', gitPaths: ['a.tsx'], repoPath: '.' }),
    null,
  );
  // Wrong-name guard still fires on the new tool.
  assert.match(unknownParamError('figma_history', { node_id: '1:2' }), /did you mean "nodeId"/);
});
