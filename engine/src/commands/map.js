// Command Adapter for Plan-bound Figma↔Storybook mapping.

import chalk from 'chalk';
import { resolve } from 'node:path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  executeStorybookMapPlan,
  prepareStorybookMapPlan,
  storybookMapPlanningArgvFromRequest,
} from '../application/storybook-map-command.js';
import { storybookMapSourceIsRemote } from '../application/storybook-map-request.js';
import { program, daemonExec } from '../lib/cli-core.js';
import { workspaceIO } from '../lib/workspace-io.js';

const mapCmd = program
  .command('map')
  .description('Create Figma↔code mapping files (writes into your project, never into Figma)');

mapCmd
  .command('storybook <urlOrPath>')
  .description('Match Figma components against a Storybook index and write figma-map.json')
  .option('-o, --output <file>', 'Output file', './figma-map.json')
  .option('--json', 'Print the resulting map as JSON to stdout')
  .option('--current-page', 'Only scan the current Figma page (default: all pages)')
  .allowExcessArguments(false)
  .action(async (urlOrPath, options) => {
    try {
      const plan = planFigmaCommand(storybookMapPlanningArgvFromRequest({
        source: storybookMapSourceIsRemote(urlOrPath) ? urlOrPath : resolve(urlOrPath),
        output: resolve(options.output),
        json: options.json === true,
        currentPage: options.currentPage === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const prepared = await prepareStorybookMapPlan(plan, { workspaceIO: workspaceIO() });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeStorybookMapPlan(plan, prepared, {
            workspaceIO: workspaceIO(),
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red(`✗ Storybook Map failed: ${error?.message || String(error)}`));
      process.exitCode = 1;
    }
  });
