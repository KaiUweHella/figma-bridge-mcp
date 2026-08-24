// Commands: canvas-ops (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeInspectPlan,
  inspectPlanningArgvFromRequest,
} from '../application/inspect-command.js';
import {
  canvasAwarenessPlanningArgvFromRequest,
  executeCanvasAwarenessPlan,
} from '../application/canvas-awareness-command.js';
import {
  executePageNavigationPlan,
  pageNavigationPlanningArgvFromRequest,
} from '../application/page-navigation-command.js';
import {
  executePageStructurePlan,
  pageStructurePlanningArgvFromRequest,
} from '../application/page-structure-command.js';
import {
  executeNodeDiscoveryPlan,
  nodeDiscoveryPlanningArgvFromRequest,
} from '../application/node-discovery-command.js';
import {
  program,
  buildNodeSelector,
  checkConnection,
  daemonExec,
  evalPrint,
  handleEvalError
} from '../lib/cli-core.js';

// ============ CANVAS ============

const canvas = program
  .command('canvas')
  .description('Canvas awareness and smart positioning');

async function runCanvasAwarenessCommand(request) {
  const plan = planFigmaCommand(canvasAwarenessPlanningArgvFromRequest(request), {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeCanvasAwarenessPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runPageNavigationCommand(request) {
  const plan = planFigmaCommand(pageNavigationPlanningArgvFromRequest(request), {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executePageNavigationPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runPageStructureCommand(request) {
  const plan = planFigmaCommand(pageStructurePlanningArgvFromRequest(request), {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executePageStructurePlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runNodeDiscoveryCommand(request) {
  const plan = planFigmaCommand(nodeDiscoveryPlanningArgvFromRequest(request), {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeNodeDiscoveryPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

canvas
  .command('info')
  .description('Show canvas info (bounds, element count, free space)')
  .allowExcessArguments(false)
  .action(async () => {
    try {
      const result = await runCanvasAwarenessCommand({ action: 'info' });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

canvas
  .command('pages')
  .description('List all pages in the file (current page marked)')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const result = await runPageNavigationCommand({
        action: 'pages',
        json: options.json === true,
      });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

canvas
  .command('page-create <name>')
  .description('Create a new page and switch to it')
  .option('--no-switch', 'Create the page without switching to it')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const result = await runPageStructureCommand({
        action: 'page-create',
        name,
        switchPage: options.switch !== false,
      });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

canvas
  .command('page-divider [name]')
  .description('Create a native page divider')
  .option('--index <n>', 'Insert at this zero-based document index')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const result = await runPageStructureCommand({
        action: 'page-divider',
        name: name === undefined ? null : name,
        index: options.index === undefined ? null : options.index,
        json: options.json === true,
      });
      console.log(result.stdout);
    } catch (error) { handleEvalError(error); }
  });

canvas
  .command('page <nameOrId>')
  .description('Switch the current page (by exact id, exact name, or unique substring)')
  .allowExcessArguments(false)
  .action(async (nameOrId) => {
    try {
      const result = await runPageNavigationCommand({ action: 'page', query: nameOrId });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

canvas
  .command('next')
  .description('Get next free position on canvas (no overlap)')
  .option('-g, --gap <n>', 'Gap from existing elements', '100')
  .option('-d, --direction <dir>', 'Direction: right, below', 'right')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const result = await runCanvasAwarenessCommand({
        action: 'next',
        gap: options.gap,
        direction: options.direction,
      });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

// (The selection-driven command groups `bind`, `sizing`, `padding`, `gap`,
// `align`, `select`, `delete`, `duplicate` and `set` were removed. Every one
// of them read figma.currentPage.selection, which an MCP caller cannot set,
// and none was allowlisted. The id-addressed equivalents live in `node`
// (move/resize/rename/set-text/set-fill/set-image/delete) and `create`.
// docu/FUNDLISTE-toter-code.md lists what has no equivalent yet.)

// ============ PIN (edge-anchored absolute positioning) ============
//
// Implements the directededges "Absolute Positioning" spec:
// https://directededges.github.io/specs/guides/absolute-positioning/
//
// Figma stores absolutely-positioned elements as raw x/y from the parent's
// top-left, plus a `constraints` object that records the anchor edge.
// Designers think in terms of edges ("16 from right"), but figma's API
// forces you to compute raw x = parent.width - node.width - 16 yourself.
// `pin` does the math AND sets the matching constraint so the element
// stays anchored when the parent resizes.

program
  .command('pin <edge>')
  .description('Pin node(s) to a parent edge with an edge-relative offset. Edges: left | right | top | bottom | top-left | top-right | bottom-left | bottom-right | center-x | center-y | stretch-x | stretch-y | scale-x | scale-y')
  .option('-n, --node <id>', 'Node ID (or comma-separated list)')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('-o, --offset <n>', 'Offset from the edge in px (default: 0). For top-right etc. it applies to the FIRST edge; use --offset-x / --offset-y to split.')
  .option('--offset-x <n>', 'Horizontal offset (overrides --offset on the horizontal axis)')
  .option('--offset-y <n>', 'Vertical offset (overrides --offset on the vertical axis)')
  .option('--start <v>', 'For stretch-x/stretch-y/scale-x/scale-y: start offset (px) or percentage string for scale')
  .option('--end <v>', 'For stretch-x/stretch-y/scale-x/scale-y: end offset (px) or percentage string for scale')
  .action(async (edge, options) => {
    await checkConnection();
    const validEdges = new Set([
      'left', 'right', 'top', 'bottom',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
      'center-x', 'center-y',
      'stretch-x', 'stretch-y',
      'scale-x', 'scale-y',
    ]);
    if (!validEdges.has(edge)) {
      console.error(chalk.red('✗'), `Unknown edge "${edge}". Valid: ${[...validEdges].join(', ')}`);
      process.exit(1);
    }
    const off = parseFloat(options.offset ?? 0);
    const offX = options.offsetX !== undefined ? parseFloat(options.offsetX) : off;
    const offY = options.offsetY !== undefined ? parseFloat(options.offsetY) : off;
    const start = options.start;
    const end = options.end;

    // Build the per-node mutation. Runs inside the eval, so it can read each
    // node's parent dimensions and compute the raw x/y per the Spec formulas.
    // Constraints are set so Figma keeps the anchor when the parent resizes.
    const pinExpr = `
      function pinOne(n) {
        if (!n || typeof n.x !== 'number' || !('constraints' in n)) return false;
        const p = n.parent;
        if (!p || typeof p.width !== 'number') return false;
        const pw = p.width, ph = p.height;
        const c = { ...n.constraints };
        const edge = ${JSON.stringify(edge)};
        const offX = ${offX}, offY = ${offY};
        if (edge === 'left')        { n.x = offX;                          c.horizontal = 'MIN'; }
        else if (edge === 'right')  { n.x = pw - n.width - offX;            c.horizontal = 'MAX'; }
        else if (edge === 'top')    { n.y = offY;                          c.vertical = 'MIN'; }
        else if (edge === 'bottom') { n.y = ph - n.height - offY;           c.vertical = 'MAX'; }
        else if (edge === 'top-left')     { n.x = offX; n.y = offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MIN'; }
        else if (edge === 'top-right')    { n.x = pw - n.width - offX; n.y = offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MIN'; }
        else if (edge === 'bottom-left')  { n.x = offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MAX'; }
        else if (edge === 'bottom-right') { n.x = pw - n.width - offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MAX'; }
        else if (edge === 'center-x') { n.x = (pw - n.width) / 2 + offX; c.horizontal = 'CENTER'; }
        else if (edge === 'center-y') { n.y = (ph - n.height) / 2 + offY; c.vertical = 'CENTER'; }
        else if (edge === 'stretch-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.x = sNum;
          n.resize(Math.max(1, pw - sNum - eNum), n.height);
          c.horizontal = 'STRETCH';
        }
        else if (edge === 'stretch-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.y = sNum;
          n.resize(n.width, Math.max(1, ph - sNum - eNum));
          c.vertical = 'STRETCH';
        }
        else if (edge === 'scale-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / pw;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / pw;
          n.x = pw * sPct;
          n.resize(Math.max(1, pw - n.x - pw * ePct), n.height);
          c.horizontal = 'SCALE';
        }
        else if (edge === 'scale-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / ph;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / ph;
          n.y = ph * sPct;
          n.resize(n.width, Math.max(1, ph - n.y - ph * ePct));
          c.vertical = 'SCALE';
        }
        n.constraints = c;
        return true;
      }
    `;

    const selector = buildNodeSelector(options);
    const code = `(async () => {
      ${selector}
      if (nodes.length === 0) return 'No node found';
      ${pinExpr}
      let count = 0;
      for (const n of nodes) if (pinOne(n)) count++;
      return 'Pinned ' + count + ' element(s) to ' + ${JSON.stringify(edge)};
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

// (`unwrap` and `use`/`theme` were removed: unreachable through the MCP
// allowlist. `use` — rebinding every bound variable to a target collection —
// is the one with no replacement; see docu/FUNDLISTE-toter-code.md.)

// ============ INSPECT (reverse: Figma → Spec) ============

program
  .command('inspect <nodeId>')
  .description('Inspect a node and emit its position as Spec-canonical properties (start/end/centerOffset/etc.). Machine-readable via --format yaml (compact) or --json.')
  .option('--json', 'Output as JSON (machine-readable)')
  .option('-f, --format <fmt>', 'yaml | json — structured output (yaml is the token-cheaper default for agents)')
  .option('--spec', 'Output only the absolute-positioning spec block (compact)')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    const format = options.format
      ? String(options.format).toLowerCase()
      : options.json ? 'json' : options.spec ? 'spec' : 'text';
    try {
      const plan = planFigmaCommand(inspectPlanningArgvFromRequest({ nodeId, format }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeInspectPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
    }
  });

// (`unstack`, `arrange` and `get` were removed: all three worked on the
// current selection or on every top-level frame, which no MCP caller can
// set up. `node tree` reads structure; `node move` positions by id.)

// ============ FIND ============

program
  .command('find <name>')
  .description('Find nodes by name (partial match)')
  .option('-t, --type <type>', 'Filter by type (FRAME, TEXT, RECTANGLE, etc.)')
  .option('-l, --limit <n>', 'Limit results', '20')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const result = await runNodeDiscoveryCommand({
        query: name,
        type: options.type || null,
        limit: options.limit,
      });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });
