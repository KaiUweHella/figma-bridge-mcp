// Command: history — structural snapshots and diffs of the open Figma file.
//
// Figma's plugin API can write a version but not read one back, so "what
// changed since this morning" has no answer from the bridge alone. This group
// supplies one without any credential: snapshot a subtree, snapshot it again
// later, diff the two. With the opt-in REST layer the same differ also runs on
// real Figma versions (see src/figma-rest.js) — one diff engine, two sources.
//
// Reads only. Nothing here mutates the design; `snapshot` writes into
// ~/.figma-bridge-mcp/snapshots and `diff --changelog` writes a markdown file
// if asked to.
import chalk from 'chalk';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  program,
  checkConnection,
  fastEval,
  handleEvalError,
} from '../lib/cli-core.js';
import { buildSnapshotEval, normalizeSnapshot } from '../lib/doc-snapshot.js';
import {
  saveSnapshot, listSnapshots, readSnapshot, resolveRef, snapshotDir,
} from '../lib/snapshot-store.js';
import { diffSnapshots, formatDiff, formatChangelog, isEmptyDiff } from '../lib/doc-diff.js';

const historyCmd = program
  .command('history')
  .description('Structural snapshots and diffs of the open file (no Figma credential needed)');

/** Take a snapshot via the plugin bridge and normalize it. */
async function capture({ nodeId, depth, label }) {
  const code = buildSnapshotEval({
    nodeId: nodeId || null,
    depth: depth !== undefined ? parseInt(depth, 10) : null,
  });
  const raw = await fastEval(code);
  if (raw && raw.error === 'NOT_FOUND') {
    console.error(chalk.red(`✗ Node "${nodeId}" not found in the open file.`));
    process.exit(1);
  }
  return normalizeSnapshot(raw, { label: label || null });
}

function bytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}

historyCmd
  .command('snapshot')
  .description('Record the current structure of a subtree (default: the current page)')
  .option('-n, --node <id>', 'Subtree root (default: current page)')
  .option('-d, --depth <n>', 'Limit how many levels below the root are recorded')
  .option('-l, --label <text>', 'Name this snapshot (shown in list and diff headers)')
  .option('--json', 'Print the snapshot as JSON instead of saving it')
  .action(async (options) => {
    await checkConnection();
    try {
      const snap = await capture(options);
      if (options.json) {
        console.log(JSON.stringify(snap, null, 2));
        return;
      }
      const { path, bytes: size, pruned } = saveSnapshot(snap);
      console.log(chalk.green('✓'), `Snapshot saved — ${snap.nodeCount} nodes, ${bytes(size)}`);
      console.log(chalk.gray(`  root:  ${snap.rootName} (${snap.rootId})`));
      if (snap.label) console.log(chalk.gray(`  label: ${snap.label}`));
      console.log(chalk.gray(`  file:  ${path}`));
      if (pruned.length) {
        console.log(chalk.gray(`  pruned ${pruned.length} older snapshot(s)`));
      }
      console.log(chalk.gray('\n  Diff against it later with: figma_run ["history","diff","latest","live"]'));
    } catch (e) {
      handleEvalError(e);
    }
  });

historyCmd
  .command('list')
  .description('List stored snapshots for the open file, newest first')
  .action(async () => {
    await checkConnection();
    let fileKey = null;
    try {
      fileKey = await fastEval('(async () => figma.fileKey || null)()');
    } catch (e) {
      handleEvalError(e);
    }
    const snaps = listSnapshots(fileKey);
    if (!snaps.length) {
      console.log(chalk.yellow('No snapshots yet for this file.'));
      console.log(chalk.gray('  Record one with: figma_run ["history","snapshot"]'));
      return;
    }
    console.log(chalk.white(`${snaps.length} snapshot(s) in ${snapshotDir(fileKey)}\n`));
    snaps.forEach((s, i) => {
      let meta = {};
      try { meta = readSnapshot(s.path); } catch { /* unreadable file: still list it */ }
      const parts = [
        chalk.gray(String(i).padStart(2)),
        meta.takenAt || s.file,
        chalk.gray(`${meta.nodeCount ?? '?'} nodes`),
        chalk.gray(bytes(s.bytes)),
      ];
      if (meta.label) parts.push(chalk.cyan(meta.label));
      console.log('  ' + parts.join('  '));
    });
    console.log(chalk.gray('\n  Refer to these by index, by "latest"/"previous", or by filename.'));
  });

historyCmd
  .command('diff [from] [to]')
  .description('Compare two snapshots. Refs: latest, previous, an index, a filename, or "live"')
  .option('-n, --node <id>', 'Subtree root when one side is "live" (default: current page)')
  .option('-d, --depth <n>', 'Depth limit when one side is "live"')
  .option('--changelog [file]', 'Emit markdown instead; with a path, write it there')
  .option('--json', 'Emit the raw diff as JSON')
  .option('--max-items <n>', 'Max entries per section in the text report', '40')
  .action(async (from, to, options) => {
    await checkConnection();

    // Default: what changed since the last snapshot.
    const fromRef = from || 'previous';
    const toRef = to || 'latest';

    let fileKey = null;
    try {
      fileKey = await fastEval('(async () => figma.fileKey || null)()');
    } catch (e) {
      handleEvalError(e);
    }

    const load = async (ref, side) => {
      if (ref === 'live') {
        return capture({ nodeId: options.node, depth: options.depth, label: 'live' });
      }
      const path = resolveRef(ref, fileKey);
      if (!path) {
        const available = listSnapshots(fileKey);
        console.error(chalk.red(`✗ No snapshot matches "${ref}" (${side} side).`));
        if (!available.length) {
          console.error(chalk.yellow('  There are no snapshots for this file yet — run: figma_run ["history","snapshot"]'));
        } else {
          console.error(chalk.yellow(`  ${available.length} available; list them with: figma_run ["history","list"]`));
          console.error(chalk.gray('  Or compare against the live document: figma_run ["history","diff","latest","live"]'));
        }
        process.exit(1);
      }
      try {
        return readSnapshot(path);
      } catch (e) {
        console.error(chalk.red(`✗ Could not read snapshot ${path}: ${e.message}`));
        process.exit(1);
      }
    };

    let before;
    let after;
    try {
      before = await load(fromRef, 'from');
      after = await load(toRef, 'to');
    } catch (e) {
      handleEvalError(e);
    }

    // Comparing a snapshot with itself is almost always a typo'd ref, and
    // "no differences" would look like a real answer.
    if (before.takenAt === after.takenAt && before.source === after.source && fromRef !== 'live' && toRef !== 'live') {
      console.error(chalk.red(`✗ Both refs resolve to the same snapshot (${before.takenAt}).`));
      console.error(chalk.yellow('  Pass two different refs, or use "live" for the current state.'));
      process.exit(1);
    }

    const diff = diffSnapshots(before, after);

    if (options.json) {
      console.log(JSON.stringify({ summary: diff.summary, ...diff }, null, 2));
      return;
    }

    if (options.changelog !== undefined) {
      const md = formatChangelog(diff, { before, after });
      if (typeof options.changelog === 'string') {
        const out = resolve(options.changelog);
        writeFileSync(out, md + '\n');
        console.log(chalk.green('✓'), `Changelog written to ${out}`);
        return;
      }
      console.log(md);
      return;
    }

    console.log(formatDiff(diff, {
      before, after,
      maxPerSection: parseInt(options.maxItems, 10) || 40,
    }));

    // Exit code carries the answer too, so this works as a CI gate for
    // "did anything in the design move?".
    if (!isEmptyDiff(diff)) process.exitCode = 1;
  });
