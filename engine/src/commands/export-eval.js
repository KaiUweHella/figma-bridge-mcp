// Commands: export-eval (extracted from index.js)
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import { workspaceIO } from '../lib/workspace-io.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  program,
  checkConnection,
  daemonExec,
  daemonExecWithMetadata,
  daemonAssetStream,
  expectedEditorForCommand,
  fastEval,
  targetFileKey,
  unescapeShell,
} from '../lib/cli-core.js';
import { DEFAULT_SPEC_FORMAT } from '../lib/spec-format.js';
import { nodeRestJsonCode } from '../lib/native-node-data.js';
import {
  codeSpecPlanningArgvFromRequest,
  executeCodeSpecPlan,
  walkWithDepthRetry,
} from '../application/code-spec-command.js';
import {
  executeScreenshotPlan,
  screenshotPlanningArgvFromRequest,
} from '../application/screenshot-command.js';
import {
  legacyRasterExportPlanningArgvFromRequest,
} from '../application/legacy-raster-export-request.js';
import { DEFAULT_RASTER_SCALE } from '../lib/raster-optimize.js';
import {
  AssetExportFailure,
  assetExportPlanningArgvFromRequest,
  assetExportResultRows,
  executeAssetExportPlan,
  formatAssetExportResult,
} from '../application/asset-export-command.js';
import {
  executeTokenExportPlan,
  tokenExportPlanningArgvFromRequest,
} from '../application/token-export-command.js';

// Compatibility export for existing tests/callers while the Implementation
// now lives behind the command application's Interface.
export { walkWithDepthRetry };

// ============ EXPORT ============

/** Normalize a node id (full Figma URLs, "12-34" dash format) and surface
 * the foreign-file-key warning on stderr. */
function normalizedId(input) {
  const r = normalizeNodeId(input);
  if (r.warning) console.error(chalk.yellow('⚠ ' + r.warning));
  return r.id;
}

async function runPngExportCompatibilityCommand(request) {
  const io = workspaceIO();
  const plan = planFigmaCommand(legacyRasterExportPlanningArgvFromRequest(request), {
    adapter: 'cli',
    workspaceDir: io.roots[0],
    workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeScreenshotPlan(plan, {
        workspaceIO: io,
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

const exp = program
  .command('export')
  .description('Export from Figma');

exp
  .command('screenshot')
  .description('Take a screenshot of selected node or current page')
  .option('-o, --output <file>', 'Output file', 'screenshot.png')
  .option('-s, --scale <number>', 'Export scale (1-4)', '2')
  .option('-f, --format <format>', 'Format: png, jpg, svg, pdf', 'png')
  .action(async (options) => {
    const format = options.format.toUpperCase();
    const scale = parseFloat(options.scale);
    if (format === 'PNG') {
      try {
        const result = await runPngExportCompatibilityCommand({
          action: 'screenshot', outputPath: options.output, scale, format,
        });
        if (result.stderr) console.error(result.stderr);
        console.log(result.stdout);
      } catch (error) {
        console.error(chalk.red('✗'), error.message);
        process.exitCode = 1;
      }
      return;
    }
    await checkConnection();
    const code = `(async () => {
const sel = figma.currentPage.selection;
const node = sel.length > 0 ? sel[0] : figma.currentPage;
if (!node) return { error: 'No page or selection' };
if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
const bytes = await node.exportAsync({ format: ${JSON.stringify(format)}, constraint: { type: 'SCALE', value: ${scale} } });
return {
  name: node.name,
  id: node.id,
  width: Math.round(node.width * ${scale}),
  height: Math.round(node.height * ${scale}),
  base64: figma.base64Encode(bytes)
};
})()`;
    const result = await daemonExec('eval', { code }, 60000);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }
    // base64 transport: ~1.4x the PNG size instead of the 4-5x JSON number
    // array that used to blow the curl buffer on any real frame.
    const buffer = Buffer.from(result.base64, 'base64');
    const outputFile = options.output === 'screenshot.png' && format !== 'PNG'
      ? `screenshot.${format.toLowerCase()}`
      : options.output;
    workspaceIO().write(outputFile, buffer, { role: 'export-image-output', createParents: true });
    console.log(chalk.green('✓'), `Screenshot: ${result.name} (${result.width}x${result.height}) → ${outputFile}`);
  });

exp
  .command('node <nodeId>')
  .description('Export a node by ID as PNG')
  .option('-o, --output <file>', 'Output file', 'node-export.png')
  .option('-s, --scale <number>', 'Export scale', '2')
  .option('-f, --format <format>', 'Format: png, svg, pdf, jpg', 'png')
  .action(async (nodeId, options) => {
    const format = options.format.toUpperCase();
    const scale = parseFloat(options.scale);
    if (format === 'PNG') {
      try {
        const result = await runPngExportCompatibilityCommand({
          action: 'node', nodeId, outputPath: options.output, scale, format,
        });
        if (result.stderr) console.error(result.stderr);
        console.log(result.stdout);
      } catch (error) {
        console.error(chalk.red('✗'), error.message);
        process.exitCode = 1;
      }
      return;
    }
    await checkConnection();
    nodeId = normalizedId(nodeId);
    const code = `(async () => {
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) return { error: 'Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + figma.root.name + '" — Safe Mode only reaches the file open in Figma Desktop.' };
if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
const bytes = await node.exportAsync({ format: ${JSON.stringify(format)}, constraint: { type: 'SCALE', value: ${scale} } });
return {
  name: node.name,
  id: node.id,
  width: node.width,
  height: node.height,
  base64: figma.base64Encode(bytes)
};
})()`;
    const result = await daemonExec('eval', { code }, 60000);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }
    const buffer = Buffer.from(result.base64, 'base64');
    const outputFile = options.output === 'node-export.png' && format !== 'PNG'
      ? `node-export.${format.toLowerCase()}`
      : options.output;
    workspaceIO().write(outputFile, buffer, { role: 'export-image-output', createParents: true });
    console.log(chalk.green('✓'), `Exported ${result.name} (${result.width}x${result.height}) to ${outputFile}`);
  });

exp
  .command('video <nodeId>')
  .description('Export the containing top-level animated frame as MP4, GIF, or WebM through the Plugin API')
  .option('-o, --output <file>', 'Output file')
  .option('-f, --format <format>', 'mp4, gif, or webm', 'mp4')
  .option('--fps <fps>', 'MP4/WebM: 12|24|30|60; GIF: 8|12|15|24|30', '30')
  .option('--quality <quality>', 'MP4/WebM quality: low, medium, high', 'high')
  .option('--loop <count>', 'GIF loop count, 0 means forever', '0')
  .action(async (nodeId, options) => {
    await checkConnection();
    nodeId = normalizedId(nodeId);
    const format = String(options.format).toUpperCase();
    if (!['MP4', 'GIF', 'WEBM'].includes(format)) throw new Error('--format must be mp4, gif, or webm');
    const fps = Number(options.fps);
    const allowedFps = format === 'GIF' ? [8, 12, 15, 24, 30] : [12, 24, 30, 60];
    if (!allowedFps.includes(fps)) throw new Error(`${format} fps must be one of: ${allowedFps.join(', ')}`);
    const quality = String(options.quality).toUpperCase();
    if (format !== 'GIF' && !['LOW', 'MEDIUM', 'HIGH'].includes(quality)) throw new Error('--quality must be low, medium, or high');
    const loopCount = Number(options.loop);
    if (format === 'GIF' && (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 1000)) throw new Error('--loop must be an integer from 0 to 1000');
    const settings = format === 'GIF' ? { format, fps, loopCount } : { format, fps, quality };
    const result = await fastEval(`(async () => {
if (figma.editorType !== 'figma') throw new Error('Video export is only available in Figma Design');
const requested = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!requested || typeof requested.exportAsync !== 'function') throw new Error('Exportable node not found: ${nodeId}');
const frame = requested.type === 'FRAME' && requested.parent && requested.parent.type === 'PAGE' ? requested : (typeof requested.getTopLevelFrame === 'function' ? requested.getTopLevelFrame() : null);
if (!frame || frame.type !== 'FRAME' || !frame.parent || frame.parent.type !== 'PAGE') throw new Error('Video export requires a top-level frame or one of its descendants');
const bytes = await frame.exportAsync(${JSON.stringify(settings)});
return { requestedId: requested.id, frame: { id: frame.id, name: frame.name }, format: ${JSON.stringify(format)}, fps: ${fps}, base64: figma.base64Encode(bytes) };
})()`);
    const outputFile = resolve(options.output || `video.${format.toLowerCase()}`);
    workspaceIO().write(outputFile, Buffer.from(result.base64, 'base64'), {
      role: 'video-output', createParents: true,
    });
    console.log(chalk.green('✓'), `Exported ${result.frame.name} as ${format} at ${fps} fps → ${outputFile}`);
  });

exp
  .command('node-json <nodeId>')
  .description('Export REST-shaped JSON for a live node through the Plugin API (no REST token or network)')
  .option('-o, --output <file>', 'Write JSON to a file instead of stdout')
  .action(async (nodeId, options) => {
    await checkConnection();
    nodeId = normalizedId(nodeId);
    try {
      const result = await fastEval(nodeRestJsonCode(nodeId));
      const json = JSON.stringify(result, null, 2) + '\n';
      if (options.output) {
        const outputFile = resolve(options.output);
        workspaceIO().write(outputFile, json, { role: 'node-json-output', createParents: true });
        console.log(chalk.green('✓'), `Native node JSON written to ${outputFile}`);
      } else {
        process.stdout.write(json);
      }
    } catch (error) {
      console.error(chalk.red('✗ Native node JSON export failed: ' + error.message));
      process.exit(1);
    }
  });

async function runTokenExportCommand(request) {
  const io = workspaceIO();
  const plan = planFigmaCommand(tokenExportPlanningArgvFromRequest(request), {
    adapter: 'cli',
    workspaceDir: io.roots[0],
    workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
  });
  let domainResult = null;
  await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      const remainingMs = () => Math.max(0, deadline - Date.now());
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      domainResult = await executeTokenExportPlan(plan, {
        workspaceIO: io,
        remainingMs,
        evaluate: (code, context = {}) => daemonExecWithMetadata('eval', {
          code,
          ...(context.fileKey || fileKey ? { fileKey: context.fileKey || fileKey } : {}),
          ...(context.revisionObservation ? {
            revisionObservation: context.revisionObservation,
          } : {}),
        }, Math.max(1, context.remainingMs ?? remainingMs())),
      });
      return { ...domainResult, code: 0 };
    });
  return domainResult;
}

exp
  .command('css [nodeId]')
  .description('Export design tokens as CSS custom properties. With a node id/URL: only the variables actually BOUND in that subtree (works for library tokens too) — the scoped form every design-to-code run should use. Without: all LOCAL variables of the open file.')
  .allowExcessArguments(false)
  .action(async (nodeId) => {
    try {
      const result = await runTokenExportCommand({ format: 'css', nodeId: nodeId || null });
      if (result.stderr) console.error(result.stderr);
      if (result.stdout) console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ export css failed: ' + error.message));
      process.exitCode = 1;
    }
  });

// NOTE: there is deliberately NO `export tailwind` — the neutral token
// formats are `export css` and `export dtcg`; framework-specific configs are
// derivable from those. (Importing an EXISTING tailwind.config.js via
// the `import` command stays supported — that reads the user's project.)

function renderAssetExportRows(rows) {
  for (const row of rows) {
    const render = row.tone === 'success' ? chalk.green
      : row.tone === 'warning' ? chalk.yellow
        : row.tone === 'error' ? chalk.red
          : row.tone === 'muted' ? chalk.gray
            : (value) => value;
    console.log(render(row.text));
  }
}

async function runAssetExportCommand(request) {
  const io = workspaceIO();
  const plan = planFigmaCommand(assetExportPlanningArgvFromRequest(request), {
    adapter: 'cli',
    workspaceDir: io.roots[0],
    workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
  });
  let domainResult = null;
  const execution = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      const remainingMs = () => Math.max(0, deadline - Date.now());
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      domainResult = await executeAssetExportPlan(plan, {
        workspaceIO: io,
        remainingMs,
        yieldControl: () => new Promise((resolveYield) => setImmediate(resolveYield)),
        evaluate: (code, context = {}) => daemonExecWithMetadata('eval', {
          code,
          ...(context.fileKey || fileKey ? { fileKey: context.fileKey || fileKey } : {}),
          ...(context.revisionObservation ? {
            revisionObservation: context.revisionObservation,
          } : {}),
        }, Math.max(1, context.remainingMs ?? remainingMs())),
        streamAsset: (asset, context = {}) => daemonAssetStream(asset, {
          fileKey: context.fileKey || fileKey,
          revisionObservation: context.revisionObservation,
        }, Math.max(1, context.remainingMs ?? remainingMs())),
      });
      return { stdout: formatAssetExportResult(domainResult), stderr: '', code: 0 };
    });
  return { domainResult, execution };
}

exp
  .command('assets <nodeId>')
  .description('Export every image fill and vector artwork under a node as real files (PNG/JPG, SVG) plus an assets.json manifest — the spec\'s `→ assets/…` references point at exactly these files')
  .option('-o, --output <dir>', 'Output directory', 'assets')
  .option('--max <n>', 'Maximum number of assets to export (largest first; dropped ones are LISTED, never silent)', '100')
  .option('--raster-scale <n>', 'PNG density relative to largest Figma usage (default 2× retina; 0 keeps originals)', String(DEFAULT_RASTER_SCALE))
  .action(async (nodeId, options) => {
    try {
      const { domainResult } = await runAssetExportCommand({
        nodeId,
        outputDir: resolve(options.output),
        max: options.max,
        rasterScale: options.rasterScale,
      });
      renderAssetExportRows(assetExportResultRows(domainResult));
    } catch (error) {
      if (error instanceof AssetExportFailure && error.result) {
        renderAssetExportRows(assetExportResultRows(error.result));
      } else {
        console.error(chalk.red('✗'), error.message);
      }
      process.exitCode = 1;
    }
  });

exp
  .command('dtcg [output] [nodeId]')
  .description('Export design tokens as W3C Design Tokens (DTCG) JSON. With a node id/URL (either argument position): only the variables actually BOUND in that subtree, library tokens included. Without: all LOCAL variables of the open file. Import side: figma_run ["import", "tokens.json"]')
  .option('--dialect <dialect>', 'DTCG value dialect: legacy strings or 2025 structured values', 'legacy')
  .allowExcessArguments(false)
  .action(async (output, nodeId, options) => {
    try {
      // Preserve the useful legacy shorthand: one recognizable node in the
      // output slot is a scoped stdout export, not a path.
      const firstIsNode = !nodeId && output && /^(?:I?\d+[:-]\d+|https?:\/\/)/i.test(output);
      const result = await runTokenExportCommand({
        format: 'dtcg',
        output: firstIsNode ? null : output || null,
        nodeId: firstIsNode ? output : nodeId || null,
        dialect: options.dialect,
      });
      if (result.stderr) console.error(result.stderr);
      if (result.stdout) console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ export dtcg failed: ' + error.message));
      process.exitCode = 1;
    }
  });

exp
  .command('code-spec [nodeId]')
  .description('Design-to-code spec of a node (default: selection). Phase structure = hierarchy + real content; style = layout/paints/typography with variable bindings. Descends into instances and resolves real component names.')
  .option('-p, --phase <phase>', 'structure | style | all', 'all')
  .option('-d, --depth <n>', 'Max depth', '12')
  .option('-s, --section <name>', 'Spec only the child section with this layer name (from the structure map), in full depth — instead of copying its node id')
  .option('--include-hidden', 'Include invisible nodes, marked "(hidden — not rendered)" (default: filtered out)')
  .option(
    '-f, --format <fmt>',
    'tree (readable agent default) | yaml | json (lossless canonical model)',
    DEFAULT_SPEC_FORMAT,
  )
  .option('--no-dedup', 'Print every style value inline instead of S<n> bundle refs')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const request = {
        nodeId,
        phase: options.phase,
        depth: options.depth,
        section: options.section,
        includeHidden: options.includeHidden,
        format: options.format,
        dedup: options.dedup,
      };
      const plan = planFigmaCommand(codeSpecPlanningArgvFromRequest(request), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const execution = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCodeSpecPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (execution.stderr) process.stderr.write(execution.stderr + '\n');
      // process.exit right after console.log DROPS unflushed stdout beyond
      // 64KB (classic Node pitfall — surfaced as yaml/json output truncated
      // at exactly 65536 bytes). Exit only once the write has been flushed.
      process.stdout.write(execution.stdout + '\n', () => process.exit(0));
    } catch (e) {
      console.error(chalk.red('✗ code-spec failed: ' + e.message));
      process.exit(1);
    }
  });

// ============ VERIFY (AI Screenshot Check) ============

program
  .command('verify [nodeId]')
  .description('Take a small screenshot for AI verification (saves PNG to disk by default; --base64 to dump inline)')
  .option('-s, --scale <number>', 'Export scale (default: 0.5 for small size)', '0.5')
  .option('--max <pixels>', 'Max dimension in pixels (default: 2000)', '2000')
  .option('--save [path]', 'Custom workspace PNG path (default: collision-safe private temporary PNG — save is the DEFAULT)')
  .option('--base64', 'Dump the base64 PNG to stdout instead of saving (token-heavy — opt-in only)')
  .option('--measure', 'Also return real (unscaled) node + child dimensions so size bugs are caught by measurement, not just the screenshot')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const request = {
        nodeId,
        scale: options.scale,
        maxDimension: options.max,
        measure: !!options.measure,
        includeBase64: !!options.base64,
        savePath: !options.base64 && typeof options.save === 'string' ? options.save : null,
      };
      const io = workspaceIO();
      const plan = planFigmaCommand(screenshotPlanningArgvFromRequest(request), {
        adapter: 'cli',
        workspaceDir: io.roots[0],
        workspaceIO: io,
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeScreenshotPlan(plan, {
            workspaceIO: io,
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗'), error.message);
      process.exit(1);
    }
  });

// ============ EVAL ============

const LEGACY_EVAL_TIMEOUT_MS = 90_000;

async function executeLegacyEval(jsCode) {
  const fileKey = targetFileKey();
  const expectedEditor = expectedEditorForCommand();
  const deadline = Date.now() + LEGACY_EVAL_TIMEOUT_MS;
  await ensurePluginReadiness({
    deadline,
    maxWaitMs: 8000,
    fileKey,
    expectedEditor,
  });
  return daemonExec('eval', {
    code: jsCode,
    ...(fileKey ? { fileKey } : {}),
  }, Math.max(1, deadline - Date.now()));
}

program
  .command('eval [code]')
  .description('Execute JavaScript in Figma plugin context')
  .option('-f, --file <path>', 'Run code from file instead of argument')
  .action(async (code, options) => {
    let jsCode = code ? unescapeShell(code) : code;

    // If --file option provided, read code from file
    if (options.file) {
      if (!existsSync(options.file)) {
        console.log(chalk.red('✗ File not found: ' + options.file));
        return;
      }
      jsCode = readFileSync(options.file, 'utf8');
    }

    if (!jsCode) {
      console.log(chalk.red('✗ No code provided. Use: eval "code" or eval --file /path/to/script.js'));
      return;
    }

    const result = await executeLegacyEval(jsCode);
    if (result !== undefined && result !== null) {
      console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
    }
  });

// Run command - alias for eval --file (uses async for better performance)
program
  .command('run <file>')
  .description('Run JavaScript file in Figma (alias for eval --file)')
  .action(async (file) => {
    if (!existsSync(file)) {
      console.log(chalk.red('✗ File not found: ' + file));
      return;
    }
    const code = readFileSync(file, 'utf8');
    try {
      const result = await executeLegacyEval(code);
      if (result !== undefined) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
    } catch (e) {
      console.log(chalk.red('✗ ' + e.message));
      process.exitCode = 1;
    }
  });

// (The `raw` passthrough command was removed: it forwarded arbitrary strings
// to the legacy figma-use command layer, which no longer exists. Use `eval`.)

// (The `export-jsx` command was removed: unreachable through the MCP
// allowlist and superseded by `export code-spec` + `spec`, which resolve
// variable bindings and assets instead of guessing at JSX.)
