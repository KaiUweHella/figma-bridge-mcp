// Command: verify-build — mechanical and visual build-vs-design verification.

import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeVerifyBuildPlan,
  verifyBuildPlanningArgvFromRequest,
} from '../application/verify-build-command.js';
import { program, daemonExec, handleEvalError } from '../lib/cli-core.js';
import { workspaceIO } from '../lib/workspace-io.js';

program
  .command('verify-build <projectDir>')
  .description('Verify a build against the design: grep the project against assets.json (unreferenced assets = the classic fidelity bugs) + border-image lint; with --compare also a visual pixel diff of a build screenshot against the design render. Mechanical part is read-only and needs no Figma connection.')
  .option('--assets <path>', 'assets.json file or its directory (default: found automatically anywhere under projectDir)')
  .option('--compare <buildPng>', 'screenshot of YOUR BUILD (PNG/JPEG) — enables the visual diff')
  .option('--design <designPng>', 'design reference image; skips the live Figma fetch (fully offline)')
  .option('--node <nodeId>', 'Figma node to fetch the reference from (default: the sole export root in assets.json)')
  .option('--diff-out <path>', 'where to write the diff PNG (default: next to the build screenshot, <name>-diff.png)')
  .option('--max-diff <pct>', 'fail (exit 1) when the visual diff exceeds this percentage — off by default')
  .option('--fidelity-ledger <path>', 'bounded source-fact ledger for mechanical Figma-to-browser acceptance')
  .option('--browser-capture <path>', 'browser DOM capture paired with --fidelity-ledger')
  .option('--json', 'Machine-readable JSON output')
  .allowExcessArguments(false)
  .action(async (projectDir, options) => {
    try {
      const io = workspaceIO();
      const plan = planFigmaCommand(verifyBuildPlanningArgvFromRequest({
        projectDir,
        assetsPath: options.assets,
        comparePath: options.compare,
        designPath: options.design,
        nodeId: options.node,
        diffOutPath: options.diffOut,
        maxDiff: options.maxDiff,
        fidelityLedgerPath: options.fidelityLedger,
        browserCapturePath: options.browserCapture,
        json: options.json === true,
      }), {
        adapter: 'cli',
        workspaceDir: io.roots[0],
        workspaceIO: io,
        fileKey: program.opts().figmaFile || null,
      });
      const execution = await runInProcessCommandPlan(
        plan,
        { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          if (plan.target.kind !== 'none') {
            await ensurePluginReadiness({
              deadline, maxWaitMs: 8000, fileKey, expectedEditor,
            });
          }
          return executeVerifyBuildPlan(plan, {
            workspaceIO: io,
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        },
      );
      if (execution.stderr) console.error(chalk.yellow(execution.stderr));
      if (execution.stdout) console.log(execution.stdout);
      if (execution.code !== 0) process.exitCode = execution.code;
    } catch (error) {
      handleEvalError(error);
    }
  });
