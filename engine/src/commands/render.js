// Commands: render (extracted from index.js)
import chalk from 'chalk';
import { createHash } from 'node:crypto';
import { Option } from 'commander';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path';
import { readdirSync } from 'fs';
import { FigmaClient } from '../lib/jsx-render.js';
import { domCaptureToRenderPlan } from '../lib/dom-capture-to-jsx.js';
import { parseBoundedJson, workspaceIO } from '../lib/workspace-io.js';
import { BROWSER_DOM_CAPTURE_LIMITS, browserDomCaptureScript } from '../lib/browser-dom-capture.js';
import { resolveBrowserCaptureAssets } from '../lib/browser-capture-assets.js';
import { auditSemanticStructure, formatStructuralGate } from '../lib/semantic-structural-gate.js';
import {
  formatSemanticJsxPropReference,
  semanticJsxPropReference,
} from '../lib/semantic-jsx-props.js';
import { readImageBase64 } from '../lib/image-file.js';
import { namedContainers, matchInventory, formatReuseWarning, findRepeatedSiblings } from '../lib/render-lint.js';
import { cachedInventoryCode, projectComponentInventory } from '../lib/component-inventory.js';
import {
  componentLinksFromRegistry,
  designEntityRegistryProjection,
  readDesignLinkRegistry,
} from '../lib/design-link-registry.js';
import { inspectStructuredRenderPlan } from '../lib/structured-render-executor.js';
import {
  executePreparedCompoundSemanticRender,
  executePreparedSemanticRender,
  formatSemanticRenderResult,
  prepareCompoundSemanticRenderPlan,
  prepareSemanticRenderPlan,
  semanticRenderOutcomeCode,
  semanticRenderPlanRoute,
  semanticRenderResultRows,
} from '../application/semantic-render-command.js';
import {
  SEMANTIC_RENDER_DEVICE_PRESETS,
  semanticCompoundRenderArgvFromRequest,
  semanticCompoundRenderRequestFromArgv,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderRequestFromArgv,
} from '../application/semantic-render-request.js';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  createVerificationArtifactWriter,
  decodeVerificationPngBase64,
  VERIFICATION_ARTIFACT_ROLE,
} from '../application/verification-artifact.js';
import { verificationPngExportCode } from '../application/verification-settle.js';
import {
  formatSemanticResizeProbe,
  parseResizeProbeDelta,
  semanticRootResizeProbeCode,
} from '../lib/semantic-resize-probe.js';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  unescapeShell
} from '../lib/cli-core.js';

// ============ RENDER ============

// ---- shared render UX helpers ----

// Warn about unknown JSX props before rendering (typos and CSS-style names
// are otherwise silently ignored and the result just looks wrong).
function warnUnknownProps(jsxStrings) {
  try {
    const client = new FigmaClient();
    for (const j of jsxStrings) {
      for (const w of client.validateJsxProps(j)) {
        console.log(chalk.yellow(
          `\u26a0 Unknown prop "${w.prop}" on <${w.tag}>` +
          (w.suggestion ? ` — did you mean "${w.suggestion}"?` : ' (ignored)')
        ));
      }
    }
  } catch {}
}

function printSemanticAnalysis(model, label = 'JSX', approvedFallbacks = []) {
  const diagnostics = model?.diagnostics;
  if (!diagnostics) return true;
  const layouts = diagnostics.layouts || {};
  console.log(chalk.gray(
    `↳ ${label} structure: ${layouts.grid || 0} Grid, ${layouts.flex || 0} Auto Layout, ` +
    `${layouts.free || 0} explicit free, ${diagnostics.absoluteNodes || 0} absolute`,
  ));
  if (diagnostics.unclassifiedFallbacks?.length) {
    console.error(chalk.red('✗'), `${label} has ${diagnostics.unclassifiedFallbacks.length} unclassified structural problem(s); refusing before Figma connection.`);
    for (const finding of diagnostics.unclassifiedFallbacks.slice(0, 10)) {
      console.error(chalk.red(`  ${finding.path}: ${finding.fact}`));
    }
    return false;
  }
  if (diagnostics.classifiedFallbacks?.length) {
    console.log(chalk.yellow(`⚠ ${diagnostics.classifiedFallbacks.length} explicit/classified structural fallback(s).`));
  }
  const pendingFontAxes = (diagnostics.classifiedFallbacks || []).filter((finding) =>
    finding.fallback === 'font.named-faces'
    && !approvedFallbacks.some((approval) => approval === finding.fallback || approval === finding.path || approval === `${finding.path}:${finding.fallback}`));
  if (pendingFontAxes.length) {
    console.error(chalk.red('✗'), `${label} needs a variable-font decision before Figma connection.`);
    for (const finding of pendingFontAxes.slice(0, 10)) {
      console.error(chalk.yellow(`  ${finding.path}: ${finding.fact}`));
    }
    console.error(chalk.gray('  Install the requested variable font, or choose an available named face. Then rerun with --approve-fallback font.named-faces.'));
    return false;
  }
  if (diagnostics.unresolvedIcons?.length) {
    const names = [...new Set(diagnostics.unresolvedIcons.map((item) => item.name))];
    console.log(chalk.yellow(`⚠ ${diagnostics.unresolvedIcons.length} unresolved icon(s): ${names.join(', ')}.`));
  }
  return true;
}

// Parse each JSX into a pseudo-item ({_type:'frame', ...rootProps,
// _children}) so the repeat lint can treat batch roots and nested children
// with one signature function.
function parsedRoots(jsxStrings) {
  const client = new FigmaClient();
  const roots = [];
  for (const jsx of jsxStrings) {
    const open = String(jsx).match(/<Frame\s+([^>]*)>/);
    if (!open) continue;
    const props = client.parseProps(open[1]);
    const children = client.parseChildren(
      client.extractContent(String(jsx).slice(open.index + open[0].length), 'Frame'));
    roots.push({ _type: 'frame', ...props, _children: children });
  }
  return roots;
}

// Repeat lint (compile-side only): N structurally identical frames in one
// render are a component begging to exist. Checked across batch roots AND
// inside each root's children.
function printRepeatLint(jsxStrings) {
  try {
    const roots = parsedRoots(jsxStrings);
    const groups = [
      ...findRepeatedSiblings(roots),
      ...roots.flatMap(r => findRepeatedSiblings(r._children)),
    ];
    for (const g of groups) {
      console.log(chalk.yellow(
        `⚠ ${g.count}× the same structure${g.sampleName ? ` ("${g.sampleName}")` : ''} in one render — ` +
        `make it a component: render ONE, figma_run ["node","to-component","<id>"], then place <Instance> copies.`));
    }
  } catch {}
}

// Reuse lint: after a successful render, warn when a freshly drawn frame is
// named like an existing component — the rebuild-instead-of-instantiate
// failure mode. Warn-only; any error (no inventory, slow file) is a silent
// no-op, a lint must never fail a render. The inventory eval is cached in
// the plugin sandbox (cachedInventoryCode) and skipped entirely when the JSX
// has no named containers.
async function printReuseLint(jsxStrings) {
  try {
    const names = namedContainers(jsxStrings);
    if (names.length === 0) return;
    const inventory = projectComponentInventory(
      await daemonExec('eval', { code: cachedInventoryCode(true) }),
    );
    for (const f of matchInventory(names, inventory)) {
      console.log(chalk.yellow('\n⚠ reuse: ') +
        chalk.yellow(formatReuseWarning(f).split('\n').join('\n  ')));
    }
  } catch {}
}

function printUnresolvedVars(unresolved) {
  if (!unresolved || unresolved.length === 0) return;
  console.log(chalk.yellow(`\n\u26a0 ${unresolved.length} variable reference(s) could not be resolved:`));
  console.log(chalk.yellow('  ' + unresolved.join(', ')));
  console.log(chalk.gray('  These bindings rendered as grey placeholders. Check figma_run ["var", "list"] (optionally with --collection).'));
}

function printCreatedVariables(created) {
  if (!created || created.length === 0) return;
  console.log(chalk.green(`↳ ${created.length} variable(s) created and bound: ${created.join(', ')}`));
}

function printVariableReport(report) {
  if (!report || !report.references) return;
  console.log(chalk.gray(
    `↳ variable report: ${report.references} reference(s), ${report.reused} reused, ` +
    `${report.created} created, ${report.bound} bound, ${report.ambiguous} ambiguous, ${report.unsupported} unsupported`,
  ));
}

function printFallbackAnnotationReport(report) {
  if (!report || !report.requested) return;
  const message = `↳ fallback annotations: ${report.applied} added, ${report.deduplicated} already present, ${report.unsupported} unsupported`;
  if (report.unsupported) console.log(chalk.yellow(message));
  else console.log(chalk.gray(message));
}

function printStructuralReport(report) {
  if (!report) return;
  const summary = report.summary || {};
  const detail = `${summary.nodes || 0} nodes, ${summary.grids || 0} Grid, `
    + `${summary.autoLayouts || 0} Auto Layout, ${summary.freeLayouts || 0} free, `
    + `${summary.instances || 0} instances, ${summary.absoluteNodes || 0} absolute`;
  if (report.passed) {
    console.log(chalk.gray(`↳ live structural audit: PASS — ${detail}`));
    return;
  }
  process.exitCode = 1;
  console.error(chalk.red(`✗ live structural audit: FAIL — ${report.mismatchCount || 0} mismatch(es); ${detail}`));
  for (const finding of (report.mismatches || []).slice(0, 5)) {
    console.error(chalk.red(`  ${finding.path}: ${finding.fact}; expected ${finding.expected}, got ${finding.actual}`));
  }
}

function printVariableScopeQuestions(questions) {
  if (!questions || questions.length === 0) return;
  console.log(chalk.yellow(`\n⚠ ${questions.length} variable scope decision(s) required:`));
  for (const question of questions) {
    console.log(chalk.yellow(`  ${question.collection ? `${question.collection}/` : ''}${question.name} (${question.resolvedType})`));
    console.log(chalk.gray(`    choices: ${(question.allowedScopes || []).join(', ')}`));
    console.log(chalk.gray(`    ${question.question}`));
  }
}

// Content taller than a fixed-height frame is invisible with clip=true and
// easy to miss on a screenshot \u2014 surface the measured spill right away.
function printOverflow(result) {
  if (!result || !result.overflow) return;
  console.log(chalk.yellow(`\u26a0 Content overflows the fixed frame height by ${result.overflow}px` +
    ' \u2014 shrink a child (e.g. the hero image) or raise the frame h.'));
}

// Device presets: default w/h for the ROOT frame when the JSX doesn't set
// them. Keeps the "match the reference frame's format" decision explicit.
const DEVICE_PRESETS = SEMANTIC_RENDER_DEVICE_PRESETS;

// Inject preset w/h into the first <Frame ...> when missing. Explicit w/h in
// the JSX always wins (with a note when it disagrees with the preset).
function applyDevicePreset(jsx, presetName) {
  const preset = DEVICE_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}". Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
  }
  const [pw, ph] = preset;
  const m = jsx.match(/<Frame\b([^>]*)>/);
  if (!m) return jsx;
  const propsStr = m[1];
  const hasW = /\b(w|width)=/.test(propsStr);
  const hasH = /\b(h|height)=/.test(propsStr);
  if (hasW && hasH) {
    console.log(chalk.gray(`\u21b3 preset ${presetName} (${pw}\u00d7${ph}) ignored \u2014 the JSX sets explicit w/h`));
    return jsx;
  }
  const inject = `${hasW ? '' : ` w="${pw}"`}${hasH ? '' : ` h="${ph}"`}`;
  console.log(chalk.gray(`\u21b3 preset ${presetName}: root frame ${pw}\u00d7${ph}`));
  return jsx.replace(/<Frame\b/, `<Frame${inject} `);
}

function rawCommandArgv(commandName, rawProcessArgv = program.rawArgs) {
  const tokens = [...rawProcessArgv].slice(2);
  let commandIndex = -1;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === '--figma-file') { index++; continue; }
    if (tokens[index].startsWith('--figma-file=')) continue;
    if (!tokens[index].startsWith('-')) { commandIndex = index; break; }
  }
  if (commandIndex === -1 || tokens[commandIndex] !== commandName) {
    throw new Error(`Could not recover the raw ${commandName} request.`);
  }
  const args = [commandName];
  let literal = false;
  for (let index = commandIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!literal && token === '--') {
      literal = true;
      args.push(token);
      continue;
    }
    if (!literal && token === '--figma-file') { index++; continue; }
    if (!literal && token.startsWith('--figma-file=')) continue;
    args.push(token);
  }
  return args;
}

function rawRenderArgv(rawProcessArgv = program.rawArgs) {
  return rawCommandArgv('render', rawProcessArgv);
}

function printSemanticRenderRows(rows) {
  for (const row of rows) {
    const render = row.tone === 'success' ? chalk.green
      : row.tone === 'warning' ? chalk.yellow
        : row.tone === 'error' ? chalk.red
          : row.tone === 'muted' ? chalk.gray
            : (text) => text;
    const marker = row.marker
      ? `${row.markerTone === 'success' ? chalk.green(row.marker) : row.marker} `
      : '';
    console.log(`${marker}${render(row.text)}`);
  }
}

function printRenderErrorHints(message) {
  const msg = String(message || '');
  if (msg.includes('FILL can only be set on children of auto-layout')) {
    console.log(chalk.yellow('  💡 Hint: w="fill" requires the parent Frame to have flex="row" or flex="col"'));
  }
  if (msg.includes('Cannot read properties of null')) {
    console.log(chalk.yellow('  💡 Hint: A variable binding (var:name) may not exist. Check with: var list'));
  }
  if (msg.includes('not found on set')) {
    console.log(chalk.yellow('  💡 The error above lists the existing axes/values and the add-variant command that creates the missing one.'));
  }
}

async function runSimpleSemanticRender(argv) {
  const io = workspaceIO();
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    workspaceDir: io.roots[0],
    workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
  });
  if (!plan.allowed) throw new Error('Semantic Render request was denied by the Capability Catalog.');
  if (semanticRenderPlanRoute(plan) !== 'command-application') return null;

  // Parse JSX, resolve the optional registry and select the native/compatibility
  // Adapter before daemon readiness. Invalid input therefore never reaches the
  // Plugin or opens an uncertain write window.
  const prepared = prepareSemanticRenderPlan(plan, { workspaceIO: io });
  let domainResult = null;
  const execution = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      const remainingMs = () => Math.max(1, deadline - Date.now());
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      domainResult = await executePreparedSemanticRender(prepared, {
        renderPlan: (renderPlan, options) => daemonExec('render-plan', {
          plan: renderPlan,
          options,
          ...(fileKey ? { fileKey } : {}),
        }, remainingMs()),
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, remainingMs()),
        inspectInventory: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, remainingMs()),
      });
      return {
        stdout: formatSemanticRenderResult(domainResult),
        stderr: '',
        code: semanticRenderOutcomeCode(domainResult),
      };
    });
  return { domainResult, execution };
}

async function runCompoundSemanticRender(argv) {
  const io = workspaceIO();
  const plan = planFigmaCommand(argv, {
    adapter: 'cli', workspaceDir: io.roots[0], workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
  });
  if (!plan.allowed) throw new Error('Compound Semantic Render request was denied by the Capability Catalog.');
  if (semanticRenderPlanRoute(plan) !== 'compound-command-application') return null;
  const request = semanticCompoundRenderRequestFromArgv([...plan.argv]);
  let domainResult = null;
  const verificationWriter = request.stages.verification
    ? createVerificationArtifactWriter(
      plan.outputs.filter((output) => output.role === VERIFICATION_ARTIFACT_ROLE),
      { workspaceIO: io },
    )
    : null;
  const execution = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      const remainingMs = () => Math.max(1, deadline - Date.now());
      const prepared = await prepareCompoundSemanticRenderPlan(plan, {
        workspaceIO: io,
        remainingMs,
      });
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      const evaluate = (code) => daemonExec('eval', {
        code, ...(fileKey ? { fileKey } : {}),
      }, remainingMs());
      domainResult = await executePreparedCompoundSemanticRender(prepared, {
        renderPlanBatch: (plans, options) => daemonExec('render-plan-batch', {
          plans, options, ...(fileKey ? { fileKey } : {}),
        }, remainingMs()),
        evaluate,
        inspectInventory: evaluate,
        writeVerification: ({ index, bytes }) => verificationWriter.write(index, bytes),
      });
      return {
        stdout: formatSemanticRenderResult(domainResult), stderr: '',
        code: semanticRenderOutcomeCode(domainResult),
      };
    });
  return { domainResult, execution };
}

// ---- local image + icon-dir loading (Code2Figma: real files into Figma) ----

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

// Fresh context for resolveLocalImages: `images` collects key -> base64 for
// FigmaClient.setImageData(); `pathKeys` dedupes repeated files (a thumbnail
// used on 6 cards is read and embedded once, not 6 times).
function newImageContext() {
  return { images: {}, pathKeys: new Map() };
}

// Replace local file paths in <Image src="\u2026"> / image="\u2026" with imgref:<key>
// markers, collecting base64 data into ctx. Returns the rewritten JSX.
// http(s) URLs pass through only for legacy syntax classification; generated
// compatibility has no Plugin-side network path and cannot materialize them.
// One ctx may span a whole render-batch: keys keep counting, repeats dedupe.
function resolveLocalImages(jsx, ctx) {
  return jsx.replace(/\b(src|image)="([^"]+)"/g, (full, attr, value) => {
    if (/^(https?:|imgref:|data:)/i.test(value)) return full;
    if (!IMAGE_EXT.test(value)) return full; // gradients/keywords on image= stay untouched
    const path = isAbsolute(value) ? value : resolve(process.cwd(), value);
    let key = ctx.pathKeys.get(path);
    if (key === undefined) {
      const { b64, error } = readImageBase64(value);
      if (error) return ''; // drop the attribute; the element keeps its placeholder fill
      key = `img${ctx.pathKeys.size}`;
      ctx.pathKeys.set(path, key);
      ctx.images[key] = b64;
    }
    return `${attr}="imgref:${key}"`;
  });
}

// Load every *.svg in a directory as icon name -> markup (name = filename
// without extension). Used by `render --icons <dir>`.
function loadIconDir(dir) {
  const path = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  let accepted;
  try {
    accepted = workspaceIO().authorizePath(path, { access: 'read', role: 'render-icons', kind: 'directory' });
  } catch {
    console.error(chalk.red('\u2717'), `Icon directory not found: ${dir}`);
    process.exit(1);
  }
  const icons = {};
  const files = readdirSync(accepted.canonical);
  if (files.length > 10_000) throw new Error('Workspace render-icons rejected: collection exceeds 10000 entries.');
  for (const file of files) {
    if (extname(file).toLowerCase() !== '.svg') continue;
    const full = join(accepted.canonical, file);
    let svg;
    try {
      svg = workspaceIO().readText(full, { role: 'render-icon', maxBytes: 100 * 1024 });
    } catch (error) {
      console.log(chalk.yellow(`\u26a0 ${file} > 100 KB \u2014 skipped (icons should be small vectors).`));
      continue;
    }
    icons[basename(file, extname(file))] = svg;
  }
  if (Object.keys(icons).length === 0) {
    console.log(chalk.yellow(`\u26a0 No .svg files found in ${dir}.`));
  } else {
    console.log(chalk.gray(`\u21b3 ${Object.keys(icons).length} project icon(s) loaded from ${dir}`));
  }
  return icons;
}

// Component text layers without an explicit name= get named after their
// content \u2014 `text:` overrides then need the (often unwieldy) content string
// as the key. Warn while the component is being created, not when the first
// override fails.
function warnUnnamedComponentTexts(jsx) {
  const unnamed = [];
  const re = /<Text\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(jsx)) !== null) {
    if (!/\bname=/.test(m[1])) unnamed.push(m[0].slice(0, 60));
  }
  if (unnamed.length > 0) {
    console.log(chalk.yellow(`\u26a0 ${unnamed.length} <Text> layer(s) without name= in a component render.`));
    console.log(chalk.gray('  They will be named after their content \u2014 give stable names (name="label") so `text:` overrides stay short and robust.'));
  }
}

// (The last-render.json state file went with `undo`: it existed only so that
// command could find the nodes to remove. Render already returns the ids it
// created, which is what a caller deletes with.)

// Screenshot a freshly rendered node (same export logic as the `verify` command)
// so render --verify gives Claude the visual check in a single roundtrip.
async function verifyRendered(nodeId, plan) {
  try {
    const result = await fastEval(`(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!node) return { error: 'Node not found' };
      if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
      const nodeWidth = node.width || 100;
      const nodeHeight = node.height || 100;
      let finalScale = 1;
      const maxNodeDim = Math.max(nodeWidth, nodeHeight);
      if (maxNodeDim * finalScale > 2000) finalScale = 2000 / maxNodeDim;
      ${verificationPngExportCode('node', 'finalScale')}
      return { name: node.name, id: node.id, nodeWidth, nodeHeight,
        requestedScale: 0.5, appliedScale: finalScale, base64: figma.base64Encode(bytes) };
    })()`);
    if (result && result.base64) {
      const image = decodeVerificationPngBase64(result.base64);
      const writer = createVerificationArtifactWriter(
        plan.outputs.filter((output) => output.role === VERIFICATION_ARTIFACT_ROLE),
        { workspaceIO: workspaceIO() },
      );
      const savePath = await writer.write(0, image.bytes);
      console.log(JSON.stringify({ verify: {
        id: result.id, name: result.name,
        width: image.width, height: image.height,
        pixelWidth: image.width, pixelHeight: image.height,
        nodeWidth: result.nodeWidth, nodeHeight: result.nodeHeight,
        requestedScale: result.requestedScale, appliedScale: result.appliedScale,
        scale: result.appliedScale, saved: savePath,
      } }));
    } else if (result && result.error) {
      console.error(chalk.yellow('\u26a0 verify failed:'), result.error);
    }
  } catch (e) {
    console.error(chalk.yellow('\u26a0 verify failed:'), e.message);
  }
}


program
  .command('render [jsx]')
  .description('Render JSX or a measured browser DOM capture to Figma')
  .allowExcessArguments(false)
  .option('-g, --gap <n>', 'Gap between auto-split roots')
  .option('-d, --direction <dir>', 'Override auto-split direction: row or col')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position')
  .option('--no-smart-position', 'Disable auto-positioning')
  .option('--as-component', 'After rendering, convert the resulting frame to a Figma component')
  .option('--keep-wrapper', 'Keep an outer flex Frame as a parent — disables the auto-split that turns "N items in a flex wrapper" into independent canvas items')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--materialize-resources', 'Create unmatched generated spacing/radius Variables and Text Styles; otherwise reuse exact resources or preserve literals')
  .option('--verify', 'After rendering, return a screenshot of the result (saves PNG, prints JSON) — replaces a separate `verify` roundtrip')
  .addOption(new Option('--verification-output-dir <path>').hideHelp())
  .option('--preset <device>', `Root frame size preset when the JSX sets no w/h: ${Object.keys(DEVICE_PRESETS).join(', ')}`)
  .option('--icons <dir>', 'Load project icons (*.svg) from a directory; <Icon name="file-basename"> renders them as real vectors')
  .option('--dom-capture <file>', 'Render a browser DOM/computed-style capture JSON instead of hand-authored JSX')
  .option('--manifest <file>', 'Design Link Registry used to resolve data-figma-component identities', 'figma-bridge.json')
  .option('--print-browser-capture [selector]', 'Print the semantic browser capture expression (default selector: body); no Figma connection required')
  .option('--prop-reference <element>', 'Print the bounded valid props and reviewed aliases for one Semantic JSX element; no Figma connection required')
  .option('--structural-gate', 'Audit semantic layout/tokens/icons without connecting to or writing Figma')
  .option('--resize-probe [delta]', 'Temporarily widen the rendered root (default 120 px), audit responsive descendants, then restore it')
  .option('--approve-fallback <list>', 'Comma-separated reviewed fallback kinds or paths approved for this render/audit')
  .option('--approve-flat-repetition <ids>', 'Approve exact flat-repetition finding ids for a multi-root render')
  .option('--allow-free-layout <paths>', 'Comma-separated semantic paths allowed to use explicit free layout')
  .action(async (rawJsx, options) => {
    let legacyVerificationPlan = null;
    try {
      // Commander intentionally presents convenient collapsed option values.
      // Security policy must instead validate the original argv so duplicate
      // aliases and malformed optional values cannot disappear before the
      // closed Render request Interface sees them.
      const originalArgv = rawRenderArgv();
      const originalRoute = semanticRenderArgvRoute(originalArgv);
      if (originalRoute.kind === 'simple') {
        const request = semanticRenderRequestFromArgv(originalArgv);
        const simpleArgv = semanticRenderArgvFromRequest({
          ...request,
          jsx: unescapeShell(request.jsx),
        });
        const simple = await runSimpleSemanticRender(simpleArgv);
        printSemanticRenderRows(semanticRenderResultRows(simple.domainResult));
        if (simple.execution.code !== 0) process.exitCode = simple.execution.code;
        return;
      }
      if (originalRoute.kind === 'compound') {
        const request = semanticCompoundRenderRequestFromArgv(originalArgv);
        const compoundArgv = semanticCompoundRenderArgvFromRequest({
          ...request,
          sourceJsx: request.sourceJsx ? unescapeShell(request.sourceJsx) : null,
          roots: request.roots.map((root) => unescapeShell(root)),
        });
        const compound = await runCompoundSemanticRender(compoundArgv);
        printSemanticRenderRows(semanticRenderResultRows(compound.domainResult));
        if (compound.execution.code !== 0) process.exitCode = compound.execution.code;
        return;
      }
      legacyVerificationPlan = options.verify
        ? planFigmaCommand(originalArgv, {
          adapter: 'cli',
          workspaceDir: workspaceIO().roots[0],
          workspaceIO: workspaceIO(),
          fileKey: program.opts().figmaFile || null,
        })
        : null;
    } catch (error) {
      const message = error?.message || String(error);
      console.error(chalk.red('✗'), message);
      printRenderErrorHints(message);
      process.exitCode = 1;
      return;
    }
    if (options.printBrowserCapture !== undefined) {
      const selector = typeof options.printBrowserCapture === 'string' ? options.printBrowserCapture : 'body';
      console.log(browserDomCaptureScript(selector, { serialized: true }));
      return;
    }
    if (options.propReference !== undefined) {
      console.log(formatSemanticJsxPropReference(semanticJsxPropReference(options.propReference)));
      return;
    }
    let jsx;
    let adaptedRenderPlan = null;
    let captureIcons = null;
    let captureImages = {};
    const projectIcons = options.icons ? loadIconDir(options.icons) : {};
    let componentLinks = {};
    let designEntityProjection = null;
    let manifestPath;
    try {
      manifestPath = resolve(options.manifest);
      const registry = readDesignLinkRegistry(dirname(manifestPath), { manifestPath }).registry;
      componentLinks = componentLinksFromRegistry(registry);
      designEntityProjection = designEntityRegistryProjection(registry, {
        targetFileKey: program.opts().figmaFile || null,
      });
    } catch (error) {
      console.error(chalk.red('✗'), `Could not read component Design Links: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (options.domCapture) {
      let capture;
      let captureHash;
      try {
        const text = workspaceIO().readText(options.domCapture, {
          role: 'dom-capture', maxBytes: BROWSER_DOM_CAPTURE_LIMITS.jsonBytes,
        });
        captureHash = createHash('sha256').update(text, 'utf8').digest('hex');
        capture = parseBoundedJson(text, {
          role: 'dom-capture',
          limits: { ...workspaceIO().limits, ...BROWSER_DOM_CAPTURE_LIMITS },
        });
      } catch (error) {
        console.error(chalk.red('✗'), `Could not read DOM capture ${options.domCapture}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      try {
        const assetResolution = resolveBrowserCaptureAssets(capture, {
          projectRoot: dirname(manifestPath),
        });
        const converted = domCaptureToRenderPlan(capture, {
          projectIcons,
          componentLinks,
          designEntityProjection,
          variableCollection: options.collection || null,
          captureHash,
        });
        adaptedRenderPlan = converted.renderPlan;
        captureIcons = converted.icons;
        captureImages = converted.images || {};
        const d = converted.diagnostics;
        console.log(chalk.gray(`↳ DOM capture: ${d.width}×${d.height}, ${d.elements} elements, ${d.texts} text runs, ${d.pseudos} pseudos, ${d.svgs} SVGs`));
        if (assetResolution.diagnostics.references) {
          const a = assetResolution.diagnostics;
          console.log(chalk.gray(`↳ DOM assets: ${a.references} references, ${a.uniqueAssets} project files (${a.svgAssets} SVG, ${a.rasterAssets} raster), ${a.totalBytes} bytes; Plugin network unchanged`));
        }
        if (d.semantic) {
          const layouts = d.semantic.layouts;
          console.log(chalk.gray(`↳ semantic layout: ${layouts.grid} Grid, ${layouts.flex} Flex, ${layouts.flow} flow, ${d.semantic.absoluteNodes} true absolute`));
          if (d.semantic.unclassifiedFallbacks.length) {
            console.error(chalk.red('✗'), `Semantic capture has ${d.semantic.unclassifiedFallbacks.length} unclassified layout fallback(s); refusing a silently flattened render.`);
            for (const finding of d.semantic.unclassifiedFallbacks.slice(0, 10)) console.error(chalk.red(`  ${finding.path}: ${finding.fact}`));
            process.exitCode = 1;
            return;
          }
          if (d.semantic.classifiedFallbacks.length) {
            console.log(chalk.yellow(`⚠ ${d.semantic.classifiedFallbacks.length} classified layout fallback(s); inspect structural diagnostics before acceptance.`));
          }
          if (d.semantic.unresolvedIcons.length) {
            const names = [...new Set(d.semantic.unresolvedIcons.map((item) => item.name))];
            console.log(chalk.yellow(`⚠ ${d.semantic.unresolvedIcons.length} unresolved icon role(s): ${names.join(', ')} — provide SVGs or Design Entity mappings before acceptance.`));
          }
        }
      } catch (error) {
        console.error(chalk.red('✗'), `Invalid DOM capture: ${error.message}`);
        process.exitCode = 1;
        return;
      }
    } else if (rawJsx) {
      jsx = unescapeShell(rawJsx);
    } else {
      console.error(chalk.red('✗'), 'Pass JSX or --dom-capture <file>.');
      process.exitCode = 1;
      return;
    }
    if (options.preset && jsx) jsx = applyDevicePreset(jsx, options.preset);
    if (options.preset && adaptedRenderPlan) {
      console.log(chalk.gray(`↳ preset ${options.preset} ignored — DOM capture sets explicit measured w/h`));
    }
    // Local images: read files CLI-side, embed as imgref markers (the plugin
    // has no filesystem access — bytes must travel with the eval).
    const imageCtx = newImageContext();
    if (jsx) jsx = resolveLocalImages(jsx, imageCtx);
    const images = imageCtx.images;
    Object.assign(images, captureImages);
    const customIcons = {
      ...projectIcons,
      ...(captureIcons || {}),
    };
    if (jsx) {
      warnUnknownProps([jsx]);
      printRepeatLint([jsx]);
      if (options.asComponent) warnUnnamedComponentTexts(jsx);
    }

    try {
      // Helper: convert a rendered frame to a Figma component if --as-component was passed
      const maybeAsComponent = async (id) => {
        if (!options.asComponent) return id;
        try {
          const r = await daemonExec('eval', { code:
            `(async () => {
              const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
              if (!n) throw new Error('Node not found after render: ${id}');
              const c = figma.createComponentFromNode(n);
              return { id: c.id, name: c.name };
            })()`
          });
          if (r && r.id) {
            console.log(chalk.green('✓ Converted to component: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
            return r.id;
          }
        } catch (e) {
          console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
        }
        return id;
      };

      // Position: -x/-y arrive as raw user strings and are later interpolated
      // into generated plugin-eval code, so coerce to finite numbers first and
      // reject anything else (avoids code injection / ReferenceError from
      // `n.x = <non-numeric>`).
      const parsePos = (v, flag) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) {
          throw new Error(`${flag} must be a number, got "${v}"`);
        }
        return n;
      };
      let posX = parsePos(options.x, '-x');
      const posY = parsePos(options.y, '-y');
      // --no-smart-position without -x: pin to the origin instead of letting
      // the generated code pick the next free spot.
      if (posX === undefined && options.smartPosition === false) posX = 0;

      // ONE render path: compile CLI-side, execute via eval. The old routing
      // (a feature-detection list choosing between this and a daemon-side
      // 'render' action) meant every new JSX capability had to be remembered
      // in the list — a miss silently rendered through the daemon's
      // potentially stale compiler without CLI-side state (image bytes,
      // project icons, presets). The generated code smart-positions itself
      // when the JSX sets no x.
      const client = new FigmaClient();
      if (options.collection) client.setCollection(options.collection);
      client.setImageData(images);
      client.setDesignEntityProjection(designEntityProjection);
      if (Object.keys(customIcons).length > 0) client.setIcons(customIcons);
      // Every adapter stops here. JSX is parsed once; DOM capture supplies an
      // executable plan directly without serializing/reparsing JSX. Analysis,
      // Structural Gate and execution therefore see the same ordered plan.
      const renderPlan = adaptedRenderPlan || client.planJSX(jsx);
      const semanticModel = renderPlan;
      if (options.structuralGate) {
        const csv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
        const report = auditSemanticStructure(semanticModel, {
          approvedFallbacks: csv(options.approveFallback),
          allowedFreePaths: csv(options.allowFreeLayout),
        });
        console.log(formatStructuralGate(report));
        if (!report.passed) process.exitCode = 1;
        return;
      }
      const semanticApprovals = String(options.approveFallback || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (!printSemanticAnalysis(semanticModel, options.domCapture ? 'DOM capture' : 'JSX', semanticApprovals)) {
        process.exitCode = 1;
        return;
      }
      await checkConnection();
      const structuredSupport = inspectStructuredRenderPlan(renderPlan);
      let result;
      if (structuredSupport.supported) {
        // Supported semantic facts are a migrated typed mutation. Missing or
        // stale Plugin capability must fail with upgrade guidance; it must
        // never change protocol identity by redispatching generated code.
        result = await daemonExec('render-plan', { plan: renderPlan, timeoutMs: 90000 });
      } else {
        const code = await client.compileRenderPlan(renderPlan);
        result = await daemonExec('eval', { code, timeoutMs: 90000 });
      }
      if (!result || !result.id) {
        console.log(chalk.red('✗ Render returned no node — daemon/plugin answered without a result.'));
        process.exitCode = 1;
        return;
      }

      // Explicit -x/-y override the generated smart positioning. Only run
      // the extra roundtrip when the caller actually asked for a position.
      if (posX !== undefined || posY !== undefined) {
        await fastEval(`(async () => {
          const n = await figma.getNodeByIdAsync(${JSON.stringify(result.id)});
          if (n) {
            ${posX !== undefined ? `n.x = ${posX};` : ''}
            ${posY !== undefined ? `n.y = ${posY};` : ''}
          }
        })()`);
      }

      console.log(chalk.green('✓ Rendered: ' + result.id));
      if (result.name) console.log(chalk.gray('  name: ' + result.name));
      if (result.executor === 'structured-v1') console.log(chalk.gray('  executor: Semantic Render Plan v1'));
      printStructuralReport(result.structuralReport);
      printUnresolvedVars(result.unresolved);
      printVariableReport(result.variableReport);
      printFallbackAnnotationReport(result.fallbackAnnotationReport);
      printCreatedVariables(result.createdVariables);
      printVariableScopeQuestions(result.scopeQuestions);
      printOverflow(result);
      if (options.resizeProbe !== undefined) {
        const delta = parseResizeProbeDelta(options.resizeProbe);
        const resizeReport = await fastEval(semanticRootResizeProbeCode(result.id, delta));
        const formatted = formatSemanticResizeProbe(resizeReport);
        if (resizeReport?.passed) console.log(chalk.gray(`↳ live resize probe: ${formatted}`));
        else {
          process.exitCode = 1;
          console.error(chalk.red(`✗ live resize probe: ${formatted}`));
          for (const finding of [...(resizeReport?.stuck || []), ...(resizeReport?.suspiciousFixed || [])].slice(0, 5)) {
            console.error(chalk.red(`  ${finding.path}: ${finding.beforeWidth} → ${finding.probeWidth}`));
          }
        }
      }
      if (jsx) await printReuseLint([jsx]);
      const finalNodeId = await maybeAsComponent(result.id);
      if (options.verify) await verifyRendered(finalNodeId, legacyVerificationPlan);
    } catch (e) {
      const msg = e.stderr || e.message || String(e);
      // Extract node context from error if available
      const nodeMatch = msg.match(/\[Node: ([^\]]+)\]/);
      if (nodeMatch) {
        console.log(chalk.red('✗ Render failed at ' + chalk.yellow(nodeMatch[1]) + ':'));
        console.log(chalk.red('  ' + msg.replace(/\[Node: [^\]]+\]\s*/, '')));
      } else {
        console.log(chalk.red('✗ Render failed: ' + msg));
      }
      // Hint for common errors
      printRenderErrorHints(msg);
      process.exitCode = 1;
    }
  });

program
  .command('render-batch')
  .description('Render multiple JSX frames in a single call (fast). Pass --as-component to promote each rendered frame to a Figma Component.')
  .argument('<jsxArray>', 'JSON array of JSX strings, e.g. \'["<Frame>...</Frame>","<Frame>...</Frame>"]\'')
  .option('-g, --gap <n>', 'Gap between frames', '40')
  .option('-d, --direction <dir>', 'Layout direction: row (horizontal) or col (vertical)', 'row')
  .option('-x <n>', 'Explicit starting X position')
  .option('-y <n>', 'Explicit starting Y position')
  .option('--no-smart-position', 'Disable automatic start positioning')
  .option('--as-component', 'After rendering, convert each resulting frame to a Figma component')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--materialize-resources', 'Create unmatched generated spacing/radius Variables and Text Styles; otherwise reuse exact resources or preserve literals')
  .option('--verify', 'After rendering, return a screenshot of each result (saves PNGs, prints JSON)')
  .addOption(new Option('--verification-output-dir <path>').hideHelp())
  .option('--preset <device>', `Root frame size preset per frame when the JSX sets no w/h: ${Object.keys(DEVICE_PRESETS).join(', ')}`)
  .option('--icons <dir>', 'Load project icons (*.svg) from a directory; <Icon name="file-basename"> renders them as real vectors')
  .option('--manifest <file>', 'Design Link Registry used to resolve data-figma-component identities', 'figma-bridge.json')
  .option('--resize-probe [delta]', 'Temporarily widen every rendered root, audit responsive descendants, then restore it')
  .option('--approve-fallback <list>', 'Comma-separated reviewed fallback kinds or paths approved for this batch')
  .option('--approve-flat-repetition <ids>', 'Approve exact flat-repetition finding ids for this batch')
  .option('--allow-free-layout <paths>', 'Comma-separated semantic paths allowed to use explicit free layout')
  .action(async (jsxArrayStr, options) => {
    try {
      const originalArgv = rawCommandArgv('render-batch');
      const request = semanticCompoundRenderRequestFromArgv(originalArgv);
      const compoundArgv = semanticCompoundRenderArgvFromRequest({
        ...request,
        roots: request.roots.map((root) => unescapeShell(root)),
      });
      const compound = await runCompoundSemanticRender(compoundArgv);
      printSemanticRenderRows(semanticRenderResultRows(compound.domainResult));
      if (compound.execution.code !== 0) process.exitCode = compound.execution.code;
      return;
    } catch (error) {
      const message = error?.message || String(error);
      console.error(chalk.red('✗'), message);
      printRenderErrorHints(message);
      process.exitCode = 1;
      return;
    }
  });

// (The `undo` command was removed: unreachable through the MCP allowlist.
// A caller undoes a render with `node delete <ids...>` using the ids the
// render call returned, or rolls the file back via `history`.)

// (The `diagnose` command was removed: it probed the CDP port, checked for a
// `figma-use` binary this build never installs, and opened a FigmaClient
// connection that always fails in Safe Mode. Use `daemon diagnose` / `status`.)
