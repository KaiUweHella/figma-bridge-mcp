// Commands: render (extracted from index.js)
import chalk from 'chalk';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { FigmaClient } from '../lib/jsx-render.js';
import { domCaptureToRenderPlan } from '../lib/dom-capture-to-jsx.js';
import { browserDomCaptureScript } from '../lib/browser-dom-capture.js';
import { auditSemanticStructure, formatStructuralGate } from '../lib/semantic-structural-gate.js';
import { readImageBase64 } from '../lib/image-file.js';
import { namedContainers, matchInventory, formatReuseWarning, findRepeatedSiblings } from '../lib/render-lint.js';
import { cachedInventoryCode } from '../lib/component-inventory.js';
import { componentLinksFromRegistry, readDesignLinkRegistry } from '../lib/design-link-registry.js';
import { inspectStructuredRenderPlan } from '../lib/structured-render-executor.js';
import {
  formatSemanticResizeProbe,
  parseResizeProbeDelta,
  semanticRootResizeProbeCode,
} from '../lib/semantic-resize-probe.js';
import {
  program,
  checkConnection,
  daemonExec,
  detectWrapperSplit,
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
    const inventory = await daemonExec('eval', { code: cachedInventoryCode(true) });
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
const DEVICE_PRESETS = {
  'macbook-14': [1512, 982],
  'macbook-16': [1728, 1117],
  'desktop': [1440, 1024],
  'desktop-hd': [1920, 1080],
  'iphone-15': [393, 852],
  'iphone-15-pro-max': [430, 932],
  'iphone-se': [375, 667],
  'android': [360, 800],
  'ipad-11': [834, 1194],
  'ipad-13': [1024, 1366],
};

// Inject preset w/h into the first <Frame ...> when missing. Explicit w/h in
// the JSX always wins (with a note when it disagrees with the preset).
function applyDevicePreset(jsx, presetName) {
  const preset = DEVICE_PRESETS[presetName];
  if (!preset) {
    console.error(chalk.red('\u2717'), `Unknown preset "${presetName}". Available: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
    process.exit(1);
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
// http(s) URLs pass through untouched (plugin-side createImageAsync).
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
  if (!existsSync(path)) {
    console.error(chalk.red('\u2717'), `Icon directory not found: ${dir}`);
    process.exit(1);
  }
  const icons = {};
  for (const file of readdirSync(path)) {
    if (extname(file).toLowerCase() !== '.svg') continue;
    const full = join(path, file);
    if (statSync(full).size > 100 * 1024) {
      console.log(chalk.yellow(`\u26a0 ${file} > 100 KB \u2014 skipped (icons should be small vectors).`));
      continue;
    }
    icons[basename(file, extname(file))] = readFileSync(full, 'utf8');
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
async function verifyRendered(nodeId) {
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
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: finalScale } });
      return { name: node.name, id: node.id, width: Math.round(nodeWidth * finalScale), height: Math.round(nodeHeight * finalScale), base64: figma.base64Encode(bytes) };
    })()`);
    if (result && result.base64) {
      const savePath = join(tmpdir(), `figma-verify-${String(nodeId).replace(/:/g, '-')}.png`);
      writeFileSync(savePath, Buffer.from(result.base64, 'base64'));
      console.log(JSON.stringify({ verify: { id: result.id, name: result.name, width: result.width, height: result.height, saved: savePath } }));
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
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position')
  .option('--no-smart-position', 'Disable auto-positioning')
  .option('--as-component', 'After rendering, convert the resulting frame to a Figma component')
  .option('--keep-wrapper', 'Keep an outer flex Frame as a parent — disables the auto-split that turns "N items in a flex wrapper" into independent canvas items')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--verify', 'After rendering, return a screenshot of the result (saves PNG, prints JSON) — replaces a separate `verify` roundtrip')
  .option('--preset <device>', `Root frame size preset when the JSX sets no w/h: ${Object.keys(DEVICE_PRESETS).join(', ')}`)
  .option('--icons <dir>', 'Load project icons (*.svg) from a directory; <Icon name="file-basename"> renders them as real vectors')
  .option('--dom-capture <file>', 'Render a browser DOM/computed-style capture JSON instead of hand-authored JSX')
  .option('--manifest <file>', 'Design Link Registry used to resolve data-figma-component identities', 'figma-bridge.json')
  .option('--print-browser-capture [selector]', 'Print the semantic browser capture expression (default selector: body); no Figma connection required')
  .option('--structural-gate', 'Audit semantic layout/tokens/icons without connecting to or writing Figma')
  .option('--resize-probe [delta]', 'Temporarily widen the rendered root (default 120 px), audit responsive descendants, then restore it')
  .option('--approve-fallback <list>', 'Comma-separated reviewed fallback kinds or paths approved for this render/audit')
  .option('--allow-free-layout <paths>', 'Comma-separated semantic paths allowed to use explicit free layout')
  .action(async (rawJsx, options) => {
    if (options.printBrowserCapture !== undefined) {
      const selector = typeof options.printBrowserCapture === 'string' ? options.printBrowserCapture : 'body';
      console.log(browserDomCaptureScript(selector, { serialized: true }));
      return;
    }
    let jsx;
    let adaptedRenderPlan = null;
    let captureIcons = null;
    const projectIcons = options.icons ? loadIconDir(options.icons) : {};
    let componentLinks = {};
    try {
      const manifestPath = resolve(options.manifest);
      componentLinks = componentLinksFromRegistry(
        readDesignLinkRegistry(dirname(manifestPath), { manifestPath }).registry,
      );
    } catch (error) {
      console.error(chalk.red('✗'), `Could not read component Design Links: ${error.message}`);
      return;
    }
    if (options.domCapture) {
      let capture;
      try {
        capture = JSON.parse(readFileSync(options.domCapture, 'utf8'));
      } catch (error) {
        console.error(chalk.red('✗'), `Could not read DOM capture ${options.domCapture}: ${error.message}`);
        return;
      }
      try {
        const converted = domCaptureToRenderPlan(capture, {
          projectIcons,
          componentLinks,
          variableCollection: options.collection || null,
        });
        adaptedRenderPlan = converted.renderPlan;
        captureIcons = converted.icons;
        const d = converted.diagnostics;
        console.log(chalk.gray(`↳ DOM capture: ${d.width}×${d.height}, ${d.elements} elements, ${d.texts} text runs, ${d.pseudos} pseudos, ${d.svgs} SVGs`));
        if (d.semantic) {
          const layouts = d.semantic.layouts;
          console.log(chalk.gray(`↳ semantic layout: ${layouts.grid} Grid, ${layouts.flex} Flex, ${layouts.flow} flow, ${d.semantic.absoluteNodes} true absolute`));
          if (d.semantic.unclassifiedFallbacks.length) {
            console.error(chalk.red('✗'), `Semantic capture has ${d.semantic.unclassifiedFallbacks.length} unclassified layout fallback(s); refusing a silently flattened render.`);
            for (const finding of d.semantic.unclassifiedFallbacks.slice(0, 10)) console.error(chalk.red(`  ${finding.path}: ${finding.fact}`));
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
        return;
      }
    } else if (rawJsx) {
      jsx = unescapeShell(rawJsx);
    } else {
      console.error(chalk.red('✗'), 'Pass JSX or --dom-capture <file>.');
      return;
    }
    // Auto-split: if the caller passed a layout-only outer Frame with N child
    // Frames, treat it as render-batch. This is the canonical "N buttons / N
    // cards" intent — independent items, not a single bagged Frame. Opt out
    // with --keep-wrapper. Runs BEFORE preset/image/icon processing: those
    // belong to the path that actually renders, and render-batch re-does
    // them per child (an imgref: rewritten here would arrive in the batch
    // without its bytes).
    if (!options.keepWrapper && !options.domCapture) {
      const split = detectWrapperSplit(jsx);
      if (split) {
        console.log(chalk.gray(`↳ outer flex wrapper detected — splitting to ${split.children.length} standalone items (--keep-wrapper to opt out)`));
        const args = [
          'render-batch',
          JSON.stringify(split.children),
          '--direction', split.direction,
        ];
        if (options.asComponent) args.push('--as-component');
        if (options.collection) args.push('--collection', options.collection);
        if (options.preset) args.push('--preset', options.preset);
        if (options.icons) args.push('--icons', options.icons);
        await program.parseAsync(args, { from: 'user' });
        return;
      }
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
          console.error(chalk.red('✗'), `${flag} must be a number, got "${v}"`);
          process.exit(1);
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
      client.setComponentLinks(componentLinks);
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
      if (!printSemanticAnalysis(semanticModel, options.domCapture ? 'DOM capture' : 'JSX', semanticApprovals)) return;
      await checkConnection();
      const structuredSupport = inspectStructuredRenderPlan(renderPlan);
      let result;
      if (structuredSupport.supported) {
        try {
          result = await daemonExec('render-plan', { plan: renderPlan, timeoutMs: 90000 });
        } catch (error) {
          // Compatibility is allowed only after the daemon proves that the
          // structured action was rejected before reaching a capable plugin.
          // Other failures are uncertain writes and must never be retried.
          const knownPreflightRejection = /Plugin capability missing: render-plan-v1|action must be ["“]eval/i.test(error.message || '');
          if (!knownPreflightRejection) throw error;
          const code = await client.compileRenderPlan(renderPlan);
          result = await daemonExec('eval', { code, timeoutMs: 90000 });
        }
      } else {
        const code = await client.compileRenderPlan(renderPlan);
        result = await daemonExec('eval', { code, timeoutMs: 90000 });
      }
      if (!result || !result.id) {
        console.log(chalk.red('✗ Render returned no node — daemon/plugin answered without a result.'));
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
      if (options.verify) await verifyRendered(finalNodeId);
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
  });

program
  .command('render-batch')
  .description('Render multiple JSX frames in a single call (fast). Pass --as-component to promote each rendered frame to a Figma Component.')
  .argument('<jsxArray>', 'JSON array of JSX strings, e.g. \'["<Frame>...</Frame>","<Frame>...</Frame>"]\'')
  .option('-g, --gap <n>', 'Gap between frames', '40')
  .option('-d, --direction <dir>', 'Layout direction: row (horizontal) or col (vertical)', 'row')
  .option('--as-component', 'After rendering, convert each resulting frame to a Figma component')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--verify', 'After rendering, return a screenshot of each result (saves PNGs, prints JSON)')
  .option('--preset <device>', `Root frame size preset per frame when the JSX sets no w/h: ${Object.keys(DEVICE_PRESETS).join(', ')}`)
  .option('--icons <dir>', 'Load project icons (*.svg) from a directory; <Icon name="file-basename"> renders them as real vectors')
  .action(async (jsxArrayStr, options) => {
    try {
      let jsxArray = JSON.parse(jsxArrayStr);
      if (!Array.isArray(jsxArray)) {
        throw new Error('Argument must be a JSON array of JSX strings');
      }
      const imageCtx = newImageContext();
      jsxArray = jsxArray.map(j => {
        const jsx = options.preset ? applyDevicePreset(j, options.preset) : j;
        return resolveLocalImages(jsx, imageCtx);
      });
      const images = imageCtx.images;
      const customIcons = options.icons ? loadIconDir(options.icons) : null;
      warnUnknownProps(jsxArray);
      printRepeatLint(jsxArray);
      if (options.asComponent) jsxArray.forEach(warnUnnamedComponentTexts);

      const gap = parseInt(options.gap) || 40;
      const vertical = options.direction === 'col' || options.direction === 'column' || options.direction === 'vertical';

      // ONE render path (see `render`): compile CLI-side, execute via a
      // single eval — still one daemon roundtrip for the whole batch.
      const client = new FigmaClient();
      if (options.collection) client.setCollection(options.collection);
      client.setImageData(images);
      if (customIcons) client.setIcons(customIcons);
      const renderPlans = jsxArray.map((jsx) => client.planJSX(jsx));
      for (let index = 0; index < renderPlans.length; index++) {
        if (!printSemanticAnalysis(renderPlans[index], `JSX ${index + 1}`)) return;
      }
      await checkConnection();
      const structuredSupport = renderPlans.map((plan) => inspectStructuredRenderPlan(plan));
      let batchResult;
      if (structuredSupport.every((support) => support.supported)) {
        try {
          batchResult = await daemonExec('render-plan-batch', { plans: renderPlans, options: { gap, vertical }, timeoutMs: 90000 });
        } catch (error) {
          const knownPreflightRejection = /Plugin capability missing: render-plan-batch-v1|action must be ["“]eval/i.test(error.message || '');
          if (!knownPreflightRejection) throw error;
          const code = await client.compileRenderPlans(renderPlans, { gap, vertical });
          batchResult = await daemonExec('eval', { code, timeoutMs: 90000 });
        }
      } else {
        const code = await client.compileRenderPlans(renderPlans, { gap, vertical });
        batchResult = await daemonExec('eval', { code, timeoutMs: 90000 });
      }
      let results = batchResult;
      // Unwrap the wrapped form returned when there are unresolved vars.
      let unresolvedVars = null;
      let createdVariables = null;
      let scopeQuestions = null;
      let variableReport = null;
      let fallbackAnnotationReport = null;
      if (results && !Array.isArray(results) && Array.isArray(results.frames)) {
        unresolvedVars = results.unresolved;
        createdVariables = results.createdVariables;
        scopeQuestions = results.scopeQuestions;
        variableReport = results.variableReport;
        fallbackAnnotationReport = results.fallbackAnnotationReport;
        results = results.frames;
      }

      if (Array.isArray(results)) {
        results.forEach(r => {
          console.log(chalk.green('✓ Rendered: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
          printStructuralReport(r.structuralReport);
        });
        console.log(chalk.cyan(`\n${results.length} frames created`));
        if (unresolvedVars && unresolvedVars.length > 0) {
          console.log(chalk.yellow(`\n⚠ ${unresolvedVars.length} variable reference(s) could not be resolved:`));
          console.log(chalk.yellow('  ' + unresolvedVars.join(', ')));
          console.log(chalk.gray('  These bindings rendered as grey placeholders. Check figma_run ["var", "list"] (optionally with --collection).'));
        }
        printCreatedVariables(createdVariables);
        printVariableScopeQuestions(scopeQuestions);
        printVariableReport(variableReport);
        printFallbackAnnotationReport(fallbackAnnotationReport);
        await printReuseLint(jsxArray);

        if (options.asComponent) {
          const ids = results.map(r => r.id).filter(Boolean);
          if (ids.length > 0) {
            try {
              const compInfo = await daemonExec('eval', { code:
                `(async () => {
                  const ids = ${JSON.stringify(ids)};
                  const out = [];
                  for (const id of ids) {
                    const n = await figma.getNodeByIdAsync(id);
                    if (!n) continue;
                    const c = figma.createComponentFromNode(n);
                    out.push({ id: c.id, name: c.name });
                  }
                  return out;
                })()`
              });
              if (Array.isArray(compInfo)) {
                compInfo.forEach(c => {
                  console.log(chalk.green('✓ Converted to component: ' + c.id + (c.name ? ' (' + c.name + ')' : '')));
                });
                console.log(chalk.cyan(`\n${compInfo.length} components created`));
              }
            } catch (e) {
              console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
            }
          }
        }

        if (options.verify) {
          for (const r of results) {
            if (r && r.id) await verifyRendered(r.id);
          }
        }
      } else {
        console.log(chalk.green('✓ Rendered'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Batch render failed: ' + (e.stderr || e.message)));
    }
  });

// (The `undo` command was removed: unreachable through the MCP allowlist.
// A caller undoes a render with `node delete <ids...>` using the ids the
// render call returned, or rolls the file back via `history`.)

// (The `diagnose` command was removed: it probed the CDP port, checked for a
// `figma-use` binary this build never installs, and opened a FigmaClient
// connection that always fails in Safe Mode. Use `daemon diagnose` / `status`.)
