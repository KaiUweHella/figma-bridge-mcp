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
import { buildMeshFromColors } from '../gradient-extractor.js';
import {
  progress,
  program,
  checkConnection,
  daemonExec,
  fastEval,
  handleEvalError,
  spinnerSucceed
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
  .action(async (colorsArg, options) => {
    const colors = colorsArg.split(',').map((c) => c.trim()).filter(Boolean);
    let recipe;
    try {
      recipe = buildMeshFromColors(colors, {
        base: options.base,
        blur: options.blur != null ? Math.max(0.05, Math.min(0.8, parseFloat(options.blur))) : undefined,
        style: options.style,
        seed: options.seed != null ? parseInt(options.seed, 10) : undefined,
      });
    } catch (e) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }

    if (!options.json) {
      console.log();
      console.log(chalk.cyan('  Mesh wallpaper recipe'));
      console.log(chalk.gray('  ─────────────────────────────────────────'));
      console.log(chalk.white(`  Style: `) + chalk.gray(`${recipe.style}  (seed ${recipe.seed})`));
      console.log(chalk.white(`  Base:  `) + chalk.gray(recipe.base));
      console.log(chalk.white(`  Blobs: `) + chalk.gray(`${recipe.blobs.length}, blur ${(recipe.blurFraction * 100).toFixed(0)}% of min side`));
      recipe.blobs.forEach((b, i) => {
        const pos = `(${b.fx.toFixed(2)}, ${b.fy.toFixed(2)})`;
        console.log(chalk.gray(`    ${i + 1}.  ${pos.padEnd(18)} r=${b.r.toFixed(2)}  `) + chalk.white(b.color));
      });
    } else {
      console.log(JSON.stringify(recipe, null, 2));
    }

    await checkConnection();
    let W = 1920, H = 1080;
    const m = (options.size || '').match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (m) { W = parseInt(m[1], 10); H = parseInt(m[2], 10); }

    const code = `
      (async () => {
        await figma.loadAllPagesAsync();
        const __hex = (h) => { h = h.replace('#', ''); return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 }; };
        let __target;
        ${options.applyTo ? `
        const __wantId = ${JSON.stringify(options.applyTo)};
        if (/^selected$/i.test(__wantId)) {
          __target = figma.currentPage.selection[0];
          if (!__target) throw new Error('Nothing selected in Figma');
        } else {
          __target = await figma.getNodeByIdAsync(__wantId);
          if (!__target) throw new Error('Node not found: ' + __wantId);
        }
        if (__target.type !== 'FRAME') throw new Error('Mesh requires a FRAME target; got ' + __target.type);
        for (const c of [...__target.children]) c.remove();
        ` : `
        __target = figma.createFrame();
        __target.name = ${JSON.stringify(options.name || 'Mesh Wallpaper')};
        __target.resize(${W}, ${H});
        let __x = 0;
        figma.currentPage.children.forEach(n => { __x = Math.max(__x, n.x + (n.width || 0)); });
        __target.x = __x + 100;
        __target.y = 0;
        `}
        const W = __target.width, H = __target.height, D = Math.min(W, H);
        __target.clipsContent = true;
        __target.fills = [{ type:'SOLID', color: __hex(${JSON.stringify(recipe.base)}), opacity:1, visible:true, blendMode:'NORMAL' }];
        const __blobs = ${JSON.stringify(recipe.blobs)};
        const __blur = Math.round(D * ${recipe.blurFraction});
        for (const b of __blobs) {
          const e = figma.createEllipse();
          const R = Math.round(D * b.r);
          e.resize(R * 2, R * 2);
          e.x = b.fx * W - R;
          e.y = b.fy * H - R;
          e.fills = [{ type:'SOLID', color: __hex(b.color), opacity:1, visible:true, blendMode:'NORMAL' }];
          e.effects = [{ type:'LAYER_BLUR', radius: Math.round(__blur * (b.blurMul || 1)), visible: true }];
          __target.appendChild(e);
        }
        ${(() => {
          const fx = [];
          if (options.grain) {
            const dens = (options.grain === true) ? 0.18 : Math.max(0, Math.min(1, parseFloat(options.grain)));
            fx.push(`{type:'NOISE',noiseType:'MONOTONE',density:${dens},noiseSize:1.2,color:{r:0,g:0,b:0,a:1},visible:true}`);
          }
          if (options.texture) {
            fx.push(`{type:'TEXTURE',noiseSize:12,radius:24,clipToShape:true,visible:true}`);
          }
          return fx.length ? `__target.effects = [${fx.join(',')}];` : '';
        })()}
        figma.viewport.scrollAndZoomIntoView([__target]);
        return JSON.stringify({ id: __target.id, name: __target.name, blobs: __blobs.length, blur: __blur, w: W, h: H });
      })()
    `;
    const spinner = options.json ? null : progress('Building wallpaper...').start();
    try {
      const res = await fastEval(code);
      const info = JSON.parse(res);
      if (spinner) spinnerSucceed(spinner, `${options.applyTo ? 'Built on' : 'Created'} ${info.name} (${info.w}x${info.h}, ${info.blobs} blobs)`);
      else if (!options.json) console.log(chalk.green(`  ✓ ${info.name} (${info.id})`));
    } catch (e) {
      if (spinner) spinner.fail(`Build failed: ${e.message}`);
      else console.error(chalk.red(`Build failed: ${e.message}`));
      process.exit(1);
    }
  });
