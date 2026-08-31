// Command: history — structural snapshots and diffs of the open Figma file.
//
// Figma's plugin API can write a version but not read one back, so "what
// changed since this morning" has no answer from the bridge alone. This group
// supplies one without any credential: snapshot a subtree, snapshot it again
// later, diff the two. With the opt-in REST layer the same differ also runs on
// real Figma versions (see src/figma-rest.js) — one diff engine, two sources.
//
// Structural snapshots are read-only with respect to the design. `save` is the
// one explicit native version-history write; local snapshots and optional
// changelogs remain separate shared/workspace effects.
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  program,
  daemonExec,
  handleEvalError,
} from '../lib/cli-core.js';
import {
  executeHistoryPlan,
  historyPlanningArgvFromRequest,
} from '../application/history-command.js';
import { workspaceIO } from '../lib/workspace-io.js';

const historyCmd = program
  .command('history')
  .description('Structural snapshots, diffs, and named Figma versions');

historyCmd
  .command('save <title>')
  .description('Save a named version through the Plugin API (no REST token; reading versions remains REST-only)')
  .option('-d, --description <text>', 'Optional version description')
  .allowExcessArguments(false)
  .action(async (title, options) => {
    try {
      const result = await runHistory({ action: 'save', title, description: options.description });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

async function runHistory(request) {
  const io = workspaceIO();
  const plan = planFigmaCommand(historyPlanningArgvFromRequest(request), {
    adapter: 'cli',
    workspaceDir: io.roots[0],
    workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, expectedEditor, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
      return executeHistoryPlan(plan, {
        workspaceIO: io,
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

historyCmd
  .command('snapshot')
  .description('Record the current structure of a subtree (default: the current page)')
  .option('-n, --node <id>', 'Subtree root (default: current page)')
  .option('-d, --depth <n>', 'Limit how many levels below the root are recorded')
  .option('-l, --label <text>', 'Name this snapshot (shown in list and diff headers)')
  .option('--json', 'Print the snapshot as JSON instead of saving it')
  .action(async (options) => {
    try {
      const result = await runHistory({
        action: 'snapshot', nodeId: options.node, depth: options.depth,
        label: options.label, format: options.json ? 'json' : 'save',
      });
      console.log(result.stdout);
    } catch (e) {
      handleEvalError(e);
    }
  });

historyCmd
  .command('list')
  .description('List stored snapshots for the open file, newest first')
  .action(async () => {
    try {
      const result = await runHistory({ action: 'list' });
      console.log(result.stdout);
    } catch (e) {
      handleEvalError(e);
    }
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
    try {
      const result = await runHistory({
        action: 'diff', from: from || 'previous', to: to || 'latest',
        nodeId: options.node, depth: options.depth,
        format: options.json ? 'json' : options.changelog !== undefined ? 'changelog' : 'text',
        changelogPath: typeof options.changelog === 'string' ? options.changelog : null,
        maxItems: options.maxItems,
      });
      console.log(result.stdout);
      if (result.code !== 0) process.exitCode = result.code;
    } catch (e) {
      handleEvalError(e);
    }
  });
