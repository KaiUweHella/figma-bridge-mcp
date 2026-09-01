// Command Adapter for repository-backed Component Spec reads and conformance checks.
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import { program, daemonExec, handleEvalError } from '../lib/cli-core.js';
import { workspaceIO } from '../lib/workspace-io.js';
import {
  componentSpecPlanningArgvFromRequest,
  executeComponentSpecPlan,
  prepareComponentSpecPlan,
} from '../application/component-spec-command.js';

program
  .command('spec <component>')
  .description('Read a component\'s authoritative spec (axes, sizes) from an extracted DESIGN.md; --check enforces it against a built node')
  .option('-f, --file <path>', 'DESIGN.md to read (default: auto-locate in cwd / subdirs)')
  .option('--check <nodeId>', 'Measure this node and ENFORCE the spec (exit 1 on violation)')
  .option('--tolerance <px>', 'Dimension tolerance in px for --check', '2')
  .allowExcessArguments(false)
  .action(async (component, options) => {
    try {
      const io = workspaceIO();
      const plan = planFigmaCommand(componentSpecPlanningArgvFromRequest({
        component,
        file: options.file,
        checkNodeId: options.check,
        tolerance: options.tolerance,
      }), {
        adapter: 'cli', workspaceDir: io.roots[0], workspaceIO: io,
        fileKey: program.opts().figmaFile || null,
      });
      const prepared = prepareComponentSpecPlan(plan, { workspaceIO: io });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          if (plan.target.kind !== 'none') {
            await ensurePluginReadiness({
              deadline, maxWaitMs: 8000, fileKey, expectedEditor,
            });
          }
          return executeComponentSpecPlan(plan, prepared, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      if (result.stdout) console.log(result.stdout);
      if (result.code !== 0) process.exitCode = result.code;
    } catch (error) {
      handleEvalError(error);
    }
  });
