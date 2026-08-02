// Commands: render (extracted from index.js)
import chalk from 'chalk';
import { basename, extname, isAbsolute, join, resolve } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { FigmaClient } from '../figma-client.js';
import { readImageBase64 } from '../lib/image-file.js';
import {
  program,
  CONFIG_DIR,
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

function printUnresolvedVars(unresolved) {
  if (!unresolved || unresolved.length === 0) return;
  console.log(chalk.yellow(`\n\u26a0 ${unresolved.length} variable reference(s) could not be resolved:`));
  console.log(chalk.yellow('  ' + unresolved.join(', ')));
  console.log(chalk.gray('  These bindings rendered as grey placeholders. Check `figma-cli var list` (optionally with --collection).'));
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

// Remember what the last render created so `figma-cli undo` can remove
// exactly those nodes. CLI-side state file: covers every render path
// (eval-based, daemon render, render-batch) and survives daemon restarts.
const LAST_RENDER_FILE = join(CONFIG_DIR, 'last-render.json');

function recordCreated(nodes) {
  try {
    const list = nodes.filter(n => n && n.id).map(n => ({ id: n.id, name: n.name || '' }));
    if (list.length) writeFileSync(LAST_RENDER_FILE, JSON.stringify({ nodes: list, at: new Date().toISOString() }));
  } catch {}
}

// Screenshot a freshly rendered node (same export logic as `figma-cli verify`)
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
  .command('render <jsx>')
  .description('Render JSX to Figma (use --as-component to also convert result to a Figma component)')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position')
  .option('--no-smart-position', 'Disable auto-positioning')
  .option('--as-component', 'After rendering, convert the resulting frame to a Figma component')
  .option('--keep-wrapper', 'Keep an outer flex Frame as a parent — disables the auto-split that turns "N items in a flex wrapper" into independent canvas items')
  .option('-c, --collection <name>', 'Pin var:<name> resolution to this variable collection (case-insensitive, fuzzy match). Per-attr `var:collection:name` overrides this.')
  .option('--verify', 'After rendering, return a screenshot of the result (saves PNG, prints JSON) — replaces a separate `figma-cli verify` roundtrip')
  .option('--preset <device>', `Root frame size preset when the JSX sets no w/h: ${Object.keys(DEVICE_PRESETS).join(', ')}`)
  .option('--icons <dir>', 'Load project icons (*.svg) from a directory; <Icon name="file-basename"> renders them as real vectors')
  .action(async (rawJsx, options) => {
    let jsx = unescapeShell(rawJsx);
    await checkConnection();

    // Auto-split: if the caller passed a layout-only outer Frame with N child
    // Frames, treat it as render-batch. This is the canonical "N buttons / N
    // cards" intent — independent items, not a single bagged Frame. Opt out
    // with --keep-wrapper. Runs BEFORE preset/image/icon processing: those
    // belong to the path that actually renders, and render-batch re-does
    // them per child (an imgref: rewritten here would arrive in the batch
    // without its bytes).
    if (!options.keepWrapper) {
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

    if (options.preset) jsx = applyDevicePreset(jsx, options.preset);
    // Local images: read files CLI-side, embed as imgref markers (the plugin
    // has no filesystem access — bytes must travel with the eval).
    const imageCtx = newImageContext();
    jsx = resolveLocalImages(jsx, imageCtx);
    const images = imageCtx.images;
    const customIcons = options.icons ? loadIconDir(options.icons) : null;
    warnUnknownProps([jsx]);
    if (options.asComponent) warnUnnamedComponentTexts(jsx);

    try {
      // Helper: convert a rendered frame to a Figma component if --as-component was passed
      const maybeAsComponent = async (id) => {
        if (!options.asComponent) return;
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
          }
        } catch (e) {
          console.error(chalk.yellow('⚠ rendered, but to-component failed:'), e.message);
        }
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
      if (customIcons) client.setIcons(customIcons);
      const code = await client.parseJSX(jsx);
      const result = await daemonExec('eval', { code, timeoutMs: 90000 });
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
      printUnresolvedVars(result.unresolved);
      printOverflow(result);
      recordCreated([result]);
      await maybeAsComponent(result.id);
      if (options.verify) await verifyRendered(result.id);
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
    await checkConnection();
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
      if (options.asComponent) jsxArray.forEach(warnUnnamedComponentTexts);

      const gap = parseInt(options.gap) || 40;
      const vertical = options.direction === 'col' || options.direction === 'column' || options.direction === 'vertical';

      // ONE render path (see `render`): compile CLI-side, execute via a
      // single eval — still one daemon roundtrip for the whole batch.
      const client = new FigmaClient();
      if (options.collection) client.setCollection(options.collection);
      client.setImageData(images);
      if (customIcons) client.setIcons(customIcons);
      const code = await client.parseJSXBatch(jsxArray, { gap, vertical });
      let results = await daemonExec('eval', { code, timeoutMs: 90000 });
      // Unwrap the wrapped form returned when there are unresolved vars.
      let unresolvedVars = null;
      if (results && !Array.isArray(results) && Array.isArray(results.frames)) {
        unresolvedVars = results.unresolved;
        results = results.frames;
      }

      if (Array.isArray(results)) {
        results.forEach(r => {
          console.log(chalk.green('✓ Rendered: ' + r.id + (r.name ? ' (' + r.name + ')' : '')));
        });
        console.log(chalk.cyan(`\n${results.length} frames created`));
        recordCreated(results);
        if (unresolvedVars && unresolvedVars.length > 0) {
          console.log(chalk.yellow(`\n⚠ ${unresolvedVars.length} variable reference(s) could not be resolved:`));
          console.log(chalk.yellow('  ' + unresolvedVars.join(', ')));
          console.log(chalk.gray('  These bindings rendered as grey placeholders. Check `figma-cli var list` (optionally with --collection).'));
        }

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

// ============ UNDO (last render) ============

program
  .command('undo')
  .description('Remove the node(s) created by the most recent render / render-batch')
  .action(async () => {
    await checkConnection();
    try {
      if (!existsSync(LAST_RENDER_FILE)) {
        console.log(chalk.gray('Nothing to undo.'));
        return;
      }
      const state = JSON.parse(readFileSync(LAST_RENDER_FILE, 'utf8'));
      const nodes = (state.nodes || []).filter(n => n && n.id);
      if (nodes.length === 0) {
        console.log(chalk.gray('Nothing to undo.'));
        return;
      }
      const result = await fastEval(`(async () => {
        let removed = 0;
        const names = [];
        for (const id of ${JSON.stringify(nodes.map(n => n.id))}) {
          const node = await figma.getNodeByIdAsync(id);
          if (node && !node.removed) { names.push(node.name); node.remove(); removed++; }
        }
        return { removed, names };
      })()`);
      try { unlinkSync(LAST_RENDER_FILE); } catch {}
      if (result && result.removed > 0) {
        console.log(chalk.green(`✓ Removed ${result.removed} node(s) from the last render:`));
        result.names.forEach(n => console.log(chalk.gray('  ' + n)));
      } else {
        console.log(chalk.gray('Nothing to undo (nodes already gone).'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Undo failed: ' + e.message));
    }
  });

// (The `diagnose` command was removed: it probed the CDP port, checked for a
// `figma-use` binary this build never installs, and opened a FigmaClient
// connection that always fails in Safe Mode. Use `daemon diagnose` / `status`.)

