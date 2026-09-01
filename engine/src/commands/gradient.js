// Commands: gradient (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeGradientApplyPlan,
  gradientApplyPlanningArgvFromRequest,
} from '../application/gradient-apply-command.js';
import {
  executeGradientExtractPlan,
  gradientExtractPlanningArgvFromRequest,
  gradientExtractRequiresFigma,
  prepareGradientExtractPlan,
} from '../application/gradient-extract-command.js';
import {
  executeGradientMeshPlan,
  gradientMeshPlanningArgvFromRequest,
  prepareGradientMeshPlan,
} from '../application/gradient-mesh-command.js';
import {
  program,
  daemonExec,
  handleEvalError,
} from '../lib/cli-core.js';
import { workspaceIO } from '../lib/workspace-io.js';

// ============ GRADIENT ============

const gradient = program
  .command('gradient')
  .description('Extract gradients from images and apply them to nodes');

async function runGradientApply(request) {
  try {
    const plan = planFigmaCommand(gradientApplyPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeGradientApplyPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runGradientExtract(request) {
  try {
    const plan = planFigmaCommand(gradientExtractPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const prepared = prepareGradientExtractPlan(plan, { workspaceIO: workspaceIO() });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        if (gradientExtractRequiresFigma(prepared)) {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        }
        return executeGradientExtractPlan(plan, prepared, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runGradientMesh(request) {
  try {
    const plan = planFigmaCommand(gradientMeshPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const prepared = prepareGradientMeshPlan(plan);
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeGradientMeshPlan(plan, prepared, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

gradient
  .command('apply <nodeId> <value>')
  .description('Apply a CSS-like linear/radial/angular/diamond gradient directly to a fill or stroke')
  .option('--field <field>', 'Paint field: fill or stroke', 'fill')
  .option('--stroke-weight <n>', 'Also set stroke weight when --field stroke')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, value, options) => runGradientApply({
    nodeId,
    value,
    field: options.field,
    strokeWeight: options.strokeWeight ?? null,
    json: options.json === true,
  }));

gradient
  .command('extract <image>')
  .description('Extract a gradient or mesh-like gradient from an image (PNG/JPG)')
  .option('--mode <mode>', 'linear (1D, two/three-stop) or mesh (blur-stack approximation)', 'linear')
  .option('--apply-to <nodeId>', 'Apply the extracted gradient to this node. linear: sets fills. mesh: populates the frame with blur-blob children.')
  .option('--direction <dir>', '[linear] Force direction: auto|vertical|horizontal', 'auto')
  .option('--stops <n>', '[linear] Number of color stops (2, 3, or 5)', '3')
  .option('--blur <frac>', '[mesh] Blur radius as fraction of min(W, H). Default 0.38.')
  .option('--no-trim', "Don't auto-trim solid/transparent image borders")
  .option('--json', 'Output JSON instead of human-readable')
  .allowExcessArguments(false)
  .action(async (image, options) => runGradientExtract({
    image,
    mode: options.mode,
    applyTo: options.applyTo ?? null,
    direction: options.direction,
    stops: options.stops,
    blur: options.blur ?? null,
    trim: options.trim !== false,
    json: options.json === true,
  }));

gradient
  .command('mesh <colors>')
  .description('Generate a mesh-gradient wallpaper from a color palette (no image needed)')
  .option('--apply-to <frameId>', 'Populate an existing Frame instead of creating a new one')
  .option('--base <hex>', 'Base fill behind the blobs (default: palette average)')
  .option('--size <WxH>', 'Frame size for a new wallpaper', '1920x1080')
  .option('--blur <frac>', 'Blur radius as fraction of min(W, H). Default 0.42.')
  .option('--grain [intensity]', 'Add film-grain NOISE over the wallpaper (0-1 density, default 0.18)')
  .option('--texture', 'Add a paper TEXTURE grain over the wallpaper')
  .option('--style <style>', 'Composition: scatter|diagonal|bands|drift|spotlight|corners|auto', 'auto')
  .option('--seed <n>', 'Random seed for reproducible composition (default: random each run)')
  .option('--name <name>', 'Name for the created frame', 'Mesh Wallpaper')
  .option('--json', 'Output JSON instead of human-readable')
  .allowExcessArguments(false)
  .action(async (colors, options) => runGradientMesh({
    colors,
    applyTo: options.applyTo ?? null,
    base: options.base ?? null,
    size: options.size,
    blur: options.blur ?? null,
    grain: options.grain ?? null,
    texture: options.texture === true,
    style: options.style,
    seed: options.seed ?? null,
    name: options.name,
    json: options.json === true,
  }));
