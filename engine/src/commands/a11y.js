// Commands: a11y (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  a11yReadPlanningArgvFromRequest,
  executeA11yReadPlan,
} from '../application/a11y-read-command.js';
import {
  a11yVisionPlanningArgvFromRequest,
  executeA11yVisionPlan,
} from '../application/a11y-vision-command.js';
import { daemonExec, program } from '../lib/cli-core.js';

const a11y = program
  .command('a11y')
  .description('Accessibility checks (contrast, vision, touch targets, audit)');

async function runA11yPlan(plan, execute, label) {
  try {
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({
          deadline, maxWaitMs: 8000, fileKey, expectedEditor,
        });
        return execute(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (Number.isInteger(result.code) && result.code !== 0) process.exitCode = result.code;
  } catch (error) {
    console.error(chalk.red(`✗ ${label} failed: ` + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

function runA11yRead(request) {
  const plan = planFigmaCommand(a11yReadPlanningArgvFromRequest(request), {
    adapter: 'cli', fileKey: program.opts().figmaFile || null,
  });
  return runA11yPlan(plan, executeA11yReadPlan, 'A11y');
}

a11y
  .command('contrast [nodeId]')
  .description('Check WCAG contrast ratios for all text/background pairs')
  .option('--level <level>', 'WCAG level: AA or AAA', 'AA')
  .option('--json', 'Output as JSON')
  .option('--fail-on-issues', 'Exit 1 when issues are found (for CI; the MCP layer never passes this)')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runA11yRead({
    action: 'contrast', nodeId: nodeId || null, level: options.level,
    json: options.json === true, failOnIssues: options.failOnIssues === true,
  }));

a11y
  .command('vision [nodeId]')
  .description('Simulate color blindness (protanopia, deuteranopia, tritanopia, achromatopsia)')
  .option('--type <type>', 'Type: protanopia, deuteranopia, tritanopia, achromatopsia, all', 'all')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    const plan = planFigmaCommand(a11yVisionPlanningArgvFromRequest({
      nodeId: nodeId || null,
      type: options.type,
      json: options.json === true,
    }), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    return runA11yPlan(plan, executeA11yVisionPlan, 'A11y Vision');
  });

a11y
  .command('touch [nodeId]')
  .description('Check touch target sizes (WCAG 2.5.8: min 24x24, recommended 44x44)')
  .option('--min <size>', 'Minimum target size in px', '44')
  .option('--json', 'Output as JSON')
  .option('--fail-on-issues', 'Exit 1 when issues are found (for CI; the MCP layer never passes this)')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runA11yRead({
    action: 'touch', nodeId: nodeId || null, minimum: options.min,
    json: options.json === true, failOnIssues: options.failOnIssues === true,
  }));

a11y
  .command('text [nodeId]')
  .description('Check text accessibility (min sizes, line height, paragraph spacing)')
  .option('--json', 'Output as JSON')
  .option('--fail-on-issues', 'Exit 1 when issues are found (for CI; the MCP layer never passes this)')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runA11yRead({
    action: 'text', nodeId: nodeId || null,
    json: options.json === true, failOnIssues: options.failOnIssues === true,
  }));

a11y
  .command('focus [nodeId]')
  .description('Show reading/focus order of interactive elements')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runA11yRead({
    action: 'focus', nodeId: nodeId || null, json: options.json === true,
  }));

a11y
  .command('audit [nodeId]')
  .description('Full accessibility audit (contrast + touch targets + text + focus order)')
  .option('--level <level>', 'WCAG level: AA or AAA', 'AA')
  .option('--json', 'Output as JSON')
  .option('--fail-on-issues', 'Exit 1 when issues are found (for CI; the MCP layer never passes this)')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runA11yRead({
    action: 'audit', nodeId: nodeId || null, level: options.level,
    json: options.json === true, failOnIssues: options.failOnIssues === true,
  }));
