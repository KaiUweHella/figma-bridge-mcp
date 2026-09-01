// Command: jam — FigJam boards over the same plugin bridge as everything else.
//
// FigJam support was dropped from the fork because the upstream commands drove
// the deleted CDP transport, not because FigJam needs one: the plugin API
// covers stickies, shapes, connectors, tables and sections natively. So this
// group now delegates every action through one shared Command Application —
// engine → daemon → plugin — with no second code path or new trust boundary.
// The legacy snippet module remains only as the source of public color and
// shape vocabulary while compatibility tests keep its historical sources
// parseable.
import chalk from 'chalk';
import {
  program,
  daemonExec,
} from '../lib/cli-core.js';
import * as snippets from '../lib/jam-snippets.js';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeJamBoardPlan,
  jamBoardArgvFromRequest,
} from '../application/jam-board-command.js';
import {
  executeJamArrangePlan,
  jamArrangeArgvFromRequest,
} from '../application/jam-arrange-command.js';
import {
  executeJamStickyPlan,
  jamStickyArgvFromRequest,
} from '../application/jam-sticky-command.js';
import {
  executeJamStickiesPlan,
  jamStickiesArgvFromRequest,
} from '../application/jam-stickies-command.js';
import {
  executeJamShapePlan,
  jamShapeArgvFromRequest,
} from '../application/jam-shape-command.js';
import {
  executeJamConnectorPlan,
  jamConnectorPlanningArgvFromRequest,
} from '../application/jam-connector-command.js';
import {
  executeJamTablePlan,
  jamTableArgvFromRequest,
} from '../application/jam-table-command.js';
import {
  executeJamSectionPlan,
  jamSectionArgvFromRequest,
} from '../application/jam-section-command.js';
import {
  executeJamCodePlan,
  jamCodeArgvFromRequest,
} from '../application/jam-code-command.js';

const jam = program
  .command('jam')
  .description('FigJam boards: stickies, shapes, connectors, tables, sections');

jam
  .command('sticky <text>')
  .description('Add a sticky note')
  .option('--color <name>', `Fill: ${Object.keys(snippets.STICKY_COLORS).join(', ')}, or a hex value`)
  .option('--at <x,y>', 'Place at absolute coordinates (default: right of existing content)')
  .allowExcessArguments(false)
  .action(async (text, options) => {
    try {
      const plan = planFigmaCommand(jamStickyArgvFromRequest({
        text, color: options.color, at: options.at,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamStickyPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam sticky failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('stickies <items>')
  .description('Add many stickies at once: JSON array, or newline/semicolon-separated text')
  .option('--color <name>', 'Fill for all of them')
  .option('--at <x,y>', 'Top-left of the grid')
  .option('--columns <n>', 'Stickies per row', '4')
  .allowExcessArguments(false)
  .action(async (items, options) => {
    try {
      const plan = planFigmaCommand(jamStickiesArgvFromRequest({
        source: items, color: options.color, at: options.at, columns: options.columns,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamStickiesPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam stickies failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('shape <text>')
  .description('Add a shape with text')
  .option('--type <shape>', `One of: ${snippets.SHAPE_TYPES.join(', ')}`, 'ROUNDED_RECTANGLE')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .option('--size <w,h>', 'Size in px', '200,140')
  .allowExcessArguments(false)
  .action(async (text, options) => {
    try {
      const plan = planFigmaCommand(jamShapeArgvFromRequest({
        text, type: options.type, at: options.at, size: options.size,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamShapePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam shape failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('connector <fromId> <toId>')
  .description('Connect two nodes with an arrow')
  .option('--text <label>', 'Label on the connector')
  .option('--line <type>', 'ELBOWED or STRAIGHT', 'ELBOWED')
  .allowExcessArguments(false)
  .action(async (fromId, toId, options) => {
    try {
      const plan = planFigmaCommand(jamConnectorPlanningArgvFromRequest({
        fromId, toId, text: options.text, line: options.line,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamConnectorPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam connector failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('table <rows> <cols>')
  .description('Add a table, optionally filled from a JSON array of rows')
  .option('--data <json>', 'JSON array of rows, e.g. [["a","b"],["c","d"]]')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .allowExcessArguments(false)
  .action(async (rows, cols, options) => {
    try {
      const plan = planFigmaCommand(jamTableArgvFromRequest({
        rows, cols, data: options.data, at: options.at,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamTablePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam table failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('section <name>')
  .description('Add a section (a titled region of the board)')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .option('--size <w,h>', 'Size in px', '800,600')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const plan = planFigmaCommand(jamSectionArgvFromRequest({
        name, size: options.size, at: options.at,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamSectionPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam section failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('code <source>')
  .description('Add a code block')
  .option('--lang <language>', 'Syntax highlighting language', 'TYPESCRIPT')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .allowExcessArguments(false)
  .action(async (source, options) => {
    try {
      const plan = planFigmaCommand(jamCodeArgvFromRequest({
        source, lang: options.lang, at: options.at,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamCodePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam code failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('board')
  .description('Read the board: every sticky, shape, table and section with its text')
  .option('--json', 'Emit JSON instead of the text listing')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const plan = planFigmaCommand(jamBoardArgvFromRequest({ json: options.json === true }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamBoardPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam board failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

jam
  .command('arrange')
  .description('Lay selected nodes out on a grid (connectors and sections stay put)')
  .option('--columns <n>', 'Nodes per row', '5')
  .option('--gap <px>', 'Gap between nodes', '48')
  .option('--ids <ids>', 'Explicit comma/space-separated node IDs instead of the selection')
  .option('--all', 'Arrange every loose top-level node on the page (explicitly destructive)')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const ids = options.ids ? String(options.ids).split(/[\s,]+/).filter(Boolean) : null;
      const plan = planFigmaCommand(jamArrangeArgvFromRequest({
        columns: options.columns,
        gap: options.gap,
        ids,
        all: options.all === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeJamArrangePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Jam arrange failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
