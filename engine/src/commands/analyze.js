// Commands: analyze (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  program,
  daemonExec,
} from '../lib/cli-core.js';
import {
  analysisCensusArgvFromRequest,
  executeAnalysisCensusPlan,
} from '../application/analysis-census-command.js';
import {
  analysisLintPlanningArgvFromRequest,
  executeAnalysisLintPlan,
} from '../application/analysis-lint-command.js';
import { ANALYSIS_LINT_KINDS } from '../application/analysis-lint-request.js';

export { lintCode } from '../application/analysis-lint-command.js';

// ============ DESIGN ANALYSIS ============


// ============ LINT ============
//
// Rebuilt from the deleted `lint`, with one change that decides whether the
// output is usable at all: an unbound colour is only reported when a local
// variable ALREADY HOLDS THAT EXACT VALUE. The original flagged every solid
// fill in the file as "Hardcoded fill color", which on a real design is
// thousands of lines nobody reads. Reported this way each finding comes with
// the fix — the variable name to pass to `node bind`.
//
// The other checks are the ones a design-system review actually acts on:
// literal layer names, text with no style, text too small to read.
// `analyze colors|typography|spacing` still give the full census; this is the
// single pass that says whether anything needs doing.

const analyze = program
  .command('analyze')
  .description('Analyze design (colors, typography, spacing, clusters)');

async function runAnalysisCensus(action, options) {
  try {
    const plan = planFigmaCommand(analysisCensusArgvFromRequest({
      action, json: options.json === true,
    }), {
      adapter: 'cli',
      fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
        return executeAnalysisCensusPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code,
            ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Analyze failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

analyze
  .command('colors')
  .description('Analyze color usage')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (options) => runAnalysisCensus('colors', options));

analyze
  .command('typography')
  .alias('type')
  .description('Analyze typography usage')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (options) => runAnalysisCensus('typography', options));

analyze
  .command('spacing')
  .description('Analyze spacing (gap/padding) usage')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (options) => runAnalysisCensus('spacing', options));

analyze
  .command('clusters')
  .description('Find repeated patterns (potential components)')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (options) => runAnalysisCensus('clusters', options));

analyze
  .command('lint')
  .description('One pass over a subtree for the things a design-system review acts on: colours that match an existing variable but are not bound, default layer names, text without a style, text under 12px. `analyze colors|typography|spacing` give the full census; this says whether anything needs doing.')
  .option('-n, --node <id>', 'Root node (default: the whole current page)')
  .option('--kind <kinds>', 'Comma-separated subset: ' + ANALYSIS_LINT_KINDS.join(', '))
  .option('--limit <n>', 'How many findings to print per kind', '10')
  .option('--json', 'Machine-readable output (never truncated)')
  .option('--fail-on-issues', 'Exit 1 when anything is found — for CI')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const plan = planFigmaCommand(analysisLintPlanningArgvFromRequest({
        nodeId: options.node || null,
        kinds: options.kind || undefined,
        limit: options.limit,
        json: options.json === true,
        failOnIssues: options.failOnIssues === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnalysisLintPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      if (result.code !== 0) process.exitCode = result.code;
    } catch (error) {
      console.error(chalk.red('✗ Lint failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
