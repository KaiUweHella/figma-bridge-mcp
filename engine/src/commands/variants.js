// Commands: variants (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  program,
  daemonExec,
} from '../lib/cli-core.js';
import {
  executeSizeVariantsPlan,
  sizeVariantsPlanningArgvFromRequest,
} from '../application/size-variants-command.js';
import {
  componentCombinationsPlanningArgvFromRequest,
  executeComponentCombinationsPlan,
} from '../application/component-combinations-command.js';

// ============ SIZES ============

program
  .command('sizes [nodeId]')
  .description('Generate Small/Medium/Large size variants from a component')
  .option('-b, --base <size>', 'Which size is the source: small, medium, large', 'medium')
  .option('-g, --gap <n>', 'Gap between variants', '40')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(sizeVariantsPlanningArgvFromRequest({
        nodeId: nodeId || null,
        baseSize: options.base,
        gap: options.gap,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeSizeVariantsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      console.error(chalk.red('✗ Size Variants failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// (The `variants from` group was removed: unreachable through the MCP
// allowlist, and `component combine <ids>` — which IS allowlisted — builds
// the same Component Set. `sizes` and `combos` below stay.)

// ============ COMBOS ============

program
  .command('combos [nodeId]')
  .description('Generate all component variant combinations in a labeled grid')
  .option('-g, --gap <n>', 'Gap between instances', '40')
  .option('--no-labels', 'Skip row/column labels')
  .option('--no-boolean', 'Skip boolean properties')
  .option('--dry-run', 'Show combinations without creating instances')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(componentCombinationsPlanningArgvFromRequest({
        nodeId: nodeId || null,
        gap: options.gap,
        labels: options.labels !== false,
        includeBoolean: options.boolean !== false,
        dryRun: Boolean(options.dryRun),
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeComponentCombinationsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      console.error(chalk.red('✗ Component Combinations failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// NOTE: there is deliberately NO `shadcn` generator here — this tool ships
// no third-party design-system content. `sizes`, `combos` and `variants`
// below stay: they operate on the USER's own components.
