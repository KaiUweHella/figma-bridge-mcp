// Commands: export-eval (extracted from index.js)
import chalk from 'chalk';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { assetSlug, effectiveAssetName } from '../lib/asset-names.js';
import { mergeAssetManifest } from '../lib/asset-manifest.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  figmaEvalSync,
  evalPrint,
  isDaemonRunning,
  unescapeShell
} from '../lib/cli-core.js';
import { nodeWalkerCode, assetCollectorCode, imageBytesCode, svgBytesCode, usedVariablesCode, sectionFinderCode } from '../design-extract.js';
import { formatCodeSpec, specModel } from '../lib/code-spec.js';
import { formatCssTokens, buildDtcgTree } from '../lib/css-tokens.js';
import { toYaml } from '../lib/yaml.js';

// ============ EXPORT ============

/** Normalize a node id (full Figma URLs, "12-34" dash format) and surface
 * the foreign-file-key warning on stderr. */
function normalizedId(input) {
  const r = normalizeNodeId(input);
  if (r.warning) console.error(chalk.yellow('⚠ ' + r.warning));
  return r.id;
}

/** Hint appended to empty-result errors: instance-path ids are the usual cause. */
const instancePathHint = (nodeId) =>
  /^I/.test(String(nodeId))
    ? ' Instance-path ids (I…;…) often cannot be resolved — use the TOP-LEVEL instance id or the main component id instead.'
    : '';

/**
 * Run `attempt(depth)` at the REQUESTED depth, degrading only on payload/
 * timeout errors (never below 4) and retrying one blank result per depth.
 * Extracted because the old inline loop guarded on `depth >= 4` and silently
 * never executed for --depth 1–3 — every shallow spec came back "no data".
 * Returns { result, depth }; rethrows non-payload errors.
 */
export async function walkWithDepthRetry(requested, attempt) {
  let depth = Math.max(1, requested);
  let blankRetries = 1;
  for (;;) {
    try {
      const result = await attempt(depth);
      if (!result && blankRetries-- > 0) continue; // one blank retry per run
      return { result, depth };
    } catch (e) {
      if (/payload|too large|timeout/i.test(e.message) && depth > 4) { depth -= 2; continue; }
      throw e;
    }
  }
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
    await checkConnection();
    const format = options.format.toUpperCase();
    const scale = parseFloat(options.scale);
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
    const result = figmaEvalSync(code);
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
    writeFileSync(outputFile, buffer);
    console.log(chalk.green('✓'), `Screenshot: ${result.name} (${result.width}x${result.height}) → ${outputFile}`);
  });

exp
  .command('node <nodeId>')
  .description('Export a node by ID as PNG')
  .option('-o, --output <file>', 'Output file', 'node-export.png')
  .option('-s, --scale <number>', 'Export scale', '2')
  .option('-f, --format <format>', 'Format: png, svg, pdf, jpg', 'png')
  .action(async (nodeId, options) => {
    await checkConnection();
    nodeId = normalizedId(nodeId);
    const format = options.format.toUpperCase();
    const scale = parseFloat(options.scale);
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
    const result = figmaEvalSync(code);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }
    const buffer = Buffer.from(result.base64, 'base64');
    const outputFile = options.output === 'node-export.png' && format !== 'PNG'
      ? `node-export.${format.toLowerCase()}`
      : options.output;
    writeFileSync(outputFile, buffer);
    console.log(chalk.green('✓'), `Exported ${result.name} (${result.width}x${result.height}) to ${outputFile}`);
  });

exp
  .command('css [nodeId]')
  .description('Export design tokens as CSS custom properties. With a node id/URL: only the variables actually BOUND in that subtree (works for library tokens too) — the scoped form every design-to-code run should use. Without: all LOCAL variables of the open file.')
  .action(async (nodeId) => {
    await checkConnection();
    if (nodeId) {
      nodeId = normalizedId(nodeId);
      const parse = (res) => (typeof res === 'string' ? JSON.parse(res) : res);
      let scoped;
      try {
        scoped = parse(await fastEval(usedVariablesCode(nodeId)));
      } catch (e) {
        console.error(chalk.red('✗ export css failed: ' + e.message));
        process.exit(1);
      }
      if (scoped?.error) {
        console.error(chalk.red('✗ ' + scoped.error));
        process.exit(1);
      }
      if (!scoped || !Array.isArray(scoped.vars) || scoped.vars.length === 0) {
        console.error(chalk.red('✗'), `no variables are bound under node "${scoped?.node || nodeId}" — this design does not use design tokens (or the bindings live outside this subtree).`);
        console.error('  Falling back silently would deliver the WHOLE file\'s local variables, which may belong to a different design — run `export css` without a node id if you really want that.');
        process.exit(1);
      }
      const collections = [...new Set(scoped.vars.map((v) => v.collection).filter(Boolean))];
      console.log(`/* source: Figma file "${scoped.file}" — ${scoped.vars.length} token(s) actually bound under "${scoped.node}" (${scoped.id})${collections.length ? `; collections: ${collections.join(', ')}` : ''} */`);
      console.log(formatCssTokens(scoped.vars));
      return;
    }
    console.error(chalk.yellow('⚠ no node id given — exporting ALL local variables of the open file. If this file contains more than one design system, pass the frame\'s node id/URL to scope the tokens.'));
    // Plugin side only READS: name/type + alias-resolved raw value.
    // All formatting (kebab-case names, weight mapping, float rounding,
    // font-family grouping) happens Node-side in lib/css-tokens.js — pure
    // and unit-tested, instead of buried in an eval string.
    const code = `(async () => {
const vars = await figma.variables.getLocalVariablesAsync();
/* Aliased variables (color/bg -> sage/25 etc.) carry { type: 'VARIABLE_ALIAS' }
   as their value — hex-converting that produced #NaNNaNNaN. Resolve the chain
   to the target's concrete value first (guarded against cycles). NOTE: this
   eval string is flattened to one line before sending — no // comments here. */
const byId = {};
for (const v of vars) byId[v.id] = v;
const resolve = (val) => {
  let guard = 10;
  while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && guard-- > 0) {
    const target = byId[val.id];
    if (!target) return null; /* alias into a library / another file */
    val = Object.values(target.valuesByMode)[0];
  }
  return (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') ? null : val;
};
return JSON.stringify({ file: figma.root.name, vars: vars.map(v => {
  const val = resolve(Object.values(v.valuesByMode)[0]);
  let out = val;
  if (v.resolvedType === 'COLOR' && val && typeof val === 'object') {
    out = '#' + [val.r, val.g, val.b].map(n => Math.round(n*255).toString(16).padStart(2,'0')).join('');
  }
  return { name: v.name, type: v.resolvedType, value: out === undefined ? null : out };
}) });
})()`;
    const result = evalPrint(code, { silent: true });
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      console.log(result); // error text from the plugin — pass through
      return;
    }
    // Name the source file: tokens silently coming from the WRONG open file
    // (another tab's design system) are indistinguishable without this.
    const vars = Array.isArray(parsed) ? parsed : parsed.vars || [];
    if (!Array.isArray(parsed) && parsed.file) {
      console.log(`/* source: Figma file "${parsed.file}" — if this is not the design you are building, open the right file in Figma Desktop and re-export */`);
    }
    console.log(formatCssTokens(vars));
  });

// NOTE: there is deliberately NO `export tailwind` — the neutral token
// formats are `export css` and `export dtcg`; framework-specific configs are
// derivable from those. (Importing an EXISTING tailwind.config.js via
// `figma-cli import` stays supported — that reads the user's project.)

/**
 * Placement block of a manifest entry, from a collector node. The manifest
 * alone must suffice to place an overlay (no spec cross-reference): parent
 * NODE ID next to the human-readable name path, x/y `place` offsets in the
 * parent, and the two flags builders need to not lose the asset —
 * absolutePosition (out of flow) and overhang (renders beyond the parent).
 */
function placement(n) {
  return {
    ...(n.x != null ? { x: n.x, y: n.y } : {}),
    parent: n.parent,
    ...(n.parentId ? { parentId: n.parentId } : {}),
    ...(n.absolute != null ? { absolutePosition: !!n.absolute } : {}),
    ...(n.overhang != null ? { overhang: !!n.overhang } : {}),
  };
}

exp
  .command('assets <nodeId>')
  .description('Export every image fill and vector artwork under a node as real files (PNG/JPG originals, SVG) plus an assets.json manifest — the spec\'s `→ assets/…` references point at exactly these files')
  .option('-o, --output <dir>', 'Output directory', 'assets')
  .option('--max <n>', 'Maximum number of assets to export (largest first; dropped ones are LISTED, never silent)', '100')
  .action(async (nodeId, options) => {
    await checkConnection();
    nodeId = normalizedId(nodeId);
    // ABSOLUTE output dir: a relative -o resolves against the CLI's cwd —
    // when spawned by the MCP server that is the server's repo, NOT the
    // user's project (files silently landed in the wrong repo). Resolving
    // here and echoing the absolute path makes the target unambiguous.
    const outDir = resolve(options.output);
    const max = parseInt(options.max) || 100;
    const parse = (res) => (typeof res === 'string' ? JSON.parse(res) : res);
    try {
      // Phase A: one cheap eval collects the manifest (ids + names, no bytes).
      const found = parse(await fastEval(assetCollectorCode(nodeId)));
      if (found?.error) {
        console.error(chalk.red('✗ ' + found.error));
        process.exit(1);
      }
      if (!found || !Array.isArray(found.images) || !Array.isArray(found.vectors)) {
        // Never surface a raw TypeError ("reading 'images'") — say what
        // happened and what to try.
        console.error(chalk.red(`✗ export assets: the plugin returned no data for node ${nodeId}.` +
          instancePathHint(nodeId) + ' Otherwise retry — this is usually a transient bridge hiccup.'));
        process.exit(1);
      }
      // Build the work list: images (deduped by hash) first, then vectors,
      // largest first so a --max cut keeps the hero artwork, not the confetti.
      const jobs = [];
      for (const img of found.images) {
        const first = img.nodes[0];
        jobs.push({ kind: 'image', hash: img.hash, nodes: img.nodes, name: first.name, ancestors: first.ancestors, area: first.w * first.h });
      }
      for (const v of found.vectors) {
        jobs.push({ kind: 'vector', id: v.id, nodes: [v], name: v.name, ancestors: v.ancestors, area: v.w * v.h });
      }
      jobs.sort((a, b) => b.area - a.area);
      const dropped = jobs.length > max ? jobs.splice(max) : [];

      mkdirSync(outDir, { recursive: true });
      const usedNames = new Set();
      const uniqueName = (base, ext) => {
        let file = `${base}.${ext}`, i = 2;
        while (usedNames.has(file)) file = `${base}-${i++}.${ext}`;
        usedNames.add(file);
        return file;
      };
      // Content-hash dedup: identical bytes get ONE file, however many nodes
      // export them ("state-s-circle-check.svg/-2/-3" were byte-identical).
      const byContent = new Map(); // sha1 → file name already written
      const writeUnique = (base, ext, buf) => {
        const digest = createHash('sha1').update(buf).digest('hex');
        const prior = byContent.get(digest);
        if (prior) return prior;
        const file = uniqueName(base, ext);
        writeFileSync(join(outDir, file), buf);
        byContent.set(digest, file);
        return file;
      };
      const sniffExt = (buf) =>
        buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg'
          : buf[0] === 0x47 && buf[1] === 0x49 ? 'gif'
            : buf[0] === 0x52 && buf[1] === 0x49 ? 'webp' : 'png';

      // Phase B: one round-trip per asset — payload-safe for big artworks.
      const manifest = [];
      const failures = [];
      for (const job of jobs) {
        const base = assetSlug(effectiveAssetName(job.name, job.ancestors));
        try {
          if (job.kind === 'image') {
            const res = parse(await fastEval(imageBytesCode(job.hash)));
            if (res?.error) throw new Error(res.error);
            const buf = Buffer.from(res.base64, 'base64');
            const file = writeUnique(base, sniffExt(buf), buf);
            for (const n of job.nodes) {
              manifest.push({ nodeId: n.id, name: n.name, file, kind: 'image', width: n.w, height: n.h, ...placement(n) });
            }
          } else {
            const res = parse(await fastEval(svgBytesCode(job.id)));
            if (res?.error) throw new Error(res.error);
            const buf = Buffer.from(res.base64, 'base64');
            const file = writeUnique(base, 'svg', buf);
            const n = job.nodes[0];
            // Intrinsic size straight from the written file — the ground
            // truth for placing it (node dimensions lie once rotation or
            // clipping is involved).
            const dims = buf.toString('utf8', 0, Math.min(buf.length, 500))
              .match(/<svg[^>]*?\bwidth="([0-9.]+)"[^>]*?\bheight="([0-9.]+)"/);
            manifest.push({
              nodeId: n.id, name: n.name, file, kind: 'vector',
              width: dims ? Math.round(+dims[1]) : n.w, height: dims ? Math.round(+dims[2]) : n.h,
              ...placement(n),
            });
          }
        } catch (e) {
          failures.push({ name: job.name, message: e.message });
        }
      }

      // MERGE the manifest instead of clobbering it: a partial re-export used
      // to replace the full-page manifest, orphaning every earlier reference.
      const manifestPath = join(outDir, 'assets.json');
      let prior = null;
      try { prior = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}
      const merged = mergeAssetManifest(prior, manifest, { id: found.id, name: found.name },
        (file) => existsSync(join(outDir, file)));
      const kept = merged.assets.length - manifest.length;
      writeFileSync(manifestPath, JSON.stringify(merged, null, 2) + '\n');

      const files = new Set(manifest.map((m) => m.file));
      console.log(chalk.green('✓'), `${files.size} file(s) → ${outDir}/ (${manifest.length} node reference(s); manifest: ${manifestPath})`);
      for (const f of [...files].slice(0, 30)) console.log('  ' + f);
      if (files.size > 30) console.log(`  … ${files.size - 30} more (see assets.json)`);
      // The verification checklist lives HERE, in tool output — MCP clients
      // truncate server instructions (a prior acceptance run lost the whole checklist that
      // way), but tool results always arrive in full.
      const flagged = [...new Map(
        manifest.filter((m) => m.absolutePosition || m.overhang).map((m) => [m.file, m]),
      ).values()];
      if (flagged.length) {
        console.log(chalk.yellow(`⚠ ${flagged.length} of ${files.size} file(s) are absolutely positioned or overhang their parent — exactly these get lost in builds:`));
        for (const m of flagged) {
          const at = m.x != null ? ` @ ${m.x},${m.y}` : '';
          const over = m.overhang ? ' — overhangs, keep visible' : '';
          console.log(`  - ${m.file}${at} in "${m.parent || 'root'}"${over}`);
        }
      }
      console.log(`Before declaring the build done: every file above must be referenced in the project — run \`verify-build <projectDir>\` to check the whole manifest mechanically (or grep each filename).`);
      if (kept > 0) console.log(chalk.gray(`  manifest merged: ${kept} entr${kept === 1 ? 'y' : 'ies'} from earlier export(s) kept`));
      if (dropped.length) {
        console.log(chalk.yellow(`⚠ --max ${max}: dropped ${dropped.length} smaller asset(s):`),
          dropped.slice(0, 10).map((d) => d.name).join(', ') + (dropped.length > 10 ? ', …' : ''));
      }
      if (failures.length) {
        console.log(chalk.yellow(`⚠ ${failures.length} asset(s) failed to export:`));
        for (const f of failures) console.log(chalk.yellow(`  - ${f.name}: ${f.message}`));
      }
      process.exit(failures.length && manifest.length === 0 ? 1 : 0);
    } catch (e) {
      console.error(chalk.red('✗ export assets failed: ' + e.message + instancePathHint(nodeId)));
      process.exit(1);
    }
  });

exp
  .command('dtcg [output] [nodeId]')
  .description('Export design tokens as W3C Design Tokens (DTCG) JSON. With a node id/URL (either argument position): only the variables actually BOUND in that subtree, library tokens included. Without: all LOCAL variables of the open file. Import side: figma-cli import tokens.json')
  .action(async (output, nodeId) => {
    await checkConnection();
    // Node id in the first slot ("dtcg 34-6455") — output is optional, the
    // id is recognizable, don't force the user to pass an empty output.
    if (!nodeId && output && /^(\d+[:-]\d+$|I\d|https?:\/\/)/.test(output)) {
      nodeId = output;
      output = undefined;
    }
    if (nodeId) {
      nodeId = normalizedId(nodeId);
      const parse = (res) => (typeof res === 'string' ? JSON.parse(res) : res);
      let scoped;
      try {
        scoped = parse(await fastEval(usedVariablesCode(nodeId)));
      } catch (e) {
        console.error(chalk.red('✗ export dtcg failed: ' + e.message));
        process.exit(1);
      }
      if (scoped?.error) {
        console.error(chalk.red('✗ ' + scoped.error));
        process.exit(1);
      }
      if (!scoped || !Array.isArray(scoped.vars) || scoped.vars.length === 0) {
        console.error(chalk.red('✗'), `no variables are bound under node "${scoped?.node || nodeId}" — this design does not use design tokens (or the bindings live outside this subtree).`);
        console.error('  Run `export dtcg` without a node id only if you really want the whole file\'s local variables.');
        process.exit(1);
      }
      const tokenJson = JSON.stringify(buildDtcgTree(scoped.vars), null, 2);
      console.error(chalk.gray(`source: Figma file "${scoped.file}" — ${scoped.vars.length} token(s) actually bound under "${scoped.node}" (${scoped.id})`));
      if (output) {
        writeFileSync(output, tokenJson + '\n');
        console.log(chalk.green('✓ Wrote DTCG tokens →'), resolve(output));
      } else {
        console.log(tokenJson);
      }
      return;
    }
    console.error(chalk.yellow('⚠ no node id given — exporting ALL local variables of the open file. If this file contains more than one design system, pass the frame\'s node id/URL to scope the tokens.'));
    const code = `(async () => {
const vars = await figma.variables.getLocalVariablesAsync();
const byId = {};
for (const v of vars) byId[v.id] = v.name;
const dot = n => n.replace(/\\//g, '.');
const h2 = n => Math.round(n*255).toString(16).padStart(2,'0');
const toColor = c => { const b = '#'+h2(c.r)+h2(c.g)+h2(c.b); return (c.a != null && c.a < 1) ? b+h2(c.a) : b; };
const tree = {};
const setPath = (path, token) => { const p = path.split('/'); let cur = tree; for (let i=0;i<p.length-1;i++){ if (!cur[p[i]] || cur[p[i]].$value !== undefined) cur[p[i]] = {}; cur = cur[p[i]]; } cur[p[p.length-1]] = token; };
for (const v of vars) {
  const val = Object.values(v.valuesByMode)[0];
  const dtype = v.resolvedType === 'COLOR' ? 'color' : v.resolvedType === 'FLOAT' ? 'dimension' : v.resolvedType === 'BOOLEAN' ? 'boolean' : 'string';
  let token;
  if (val && val.type === 'VARIABLE_ALIAS') {
    const ref = byId[val.id];
    token = { $type: dtype, $value: ref ? '{'+dot(ref)+'}' : null };
  } else if (v.resolvedType === 'COLOR') {
    token = { $type: 'color', $value: toColor(val) };
  } else if (v.resolvedType === 'FLOAT') {
    token = { $type: 'dimension', $value: val + 'px' };
  } else if (v.resolvedType === 'BOOLEAN') {
    token = { $type: 'boolean', $value: val };
  } else {
    token = { $type: 'string', $value: String(val) };
  }
  if (v.description) token.$description = v.description;
  setPath(v.name, token);
}
return JSON.stringify({ __file: figma.root.name, tree });
})()`;
    const result = evalPrint(code, { silent: true });
    // Unwrap the { __file, tree } envelope; on parse failure (plugin error
    // text) pass the raw output through unchanged.
    let tokenJson = result;
    let sourceFile = null;
    try {
      const parsed = JSON.parse(result);
      if (parsed && parsed.tree) { tokenJson = JSON.stringify(parsed.tree, null, 2); sourceFile = parsed.__file; }
      else tokenJson = JSON.stringify(parsed, null, 2);
    } catch {}
    // The source file goes to stderr (JSON stdout must stay parseable): token
    // exports silently reading another OPEN file were undetectable before.
    if (sourceFile != null) {
      console.error(chalk.gray(`source: Figma file "${sourceFile}" — if this is not the design you are building, open the right file in Figma Desktop and re-export`));
    }
    if (output) {
      writeFileSync(output, tokenJson.endsWith('\n') ? tokenJson : tokenJson + '\n');
      console.log(chalk.green('✓ Wrote DTCG tokens →'), resolve(output));
      if (sourceFile != null) console.log(chalk.gray(`  source: Figma file "${sourceFile}"`));
    } else {
      console.log(tokenJson);
    }
  });

exp
  .command('code-spec [nodeId]')
  .description('Design-to-code spec of a node (default: selection). Phase structure = hierarchy + real content; style = layout/paints/typography with variable bindings. Descends into instances and resolves real component names.')
  .option('-p, --phase <phase>', 'structure | style | all', 'all')
  .option('-d, --depth <n>', 'Max depth', '12')
  .option('-s, --section <name>', 'Spec only the child section with this layer name (from the structure map), in full depth — instead of copying its node id')
  .option('--include-hidden', 'Include invisible nodes, marked "(hidden — not rendered)" (default: filtered out)')
  .option('-f, --format <fmt>', 'tree (compact text, default) | yaml | json (structured, with styles map)', 'tree')
  .option('--no-dedup', 'Print every style value inline instead of S<n> bundle refs')
  .action(async (nodeId, options) => {
    await checkConnection();
    const phase = String(options.phase).toLowerCase();
    if (!['structure', 'style', 'all'].includes(phase)) {
      console.error(chalk.red(`✗ Unknown phase "${options.phase}" — use structure, style or all.`));
      process.exit(1);
    }
    const format = String(options.format).toLowerCase();
    if (!['tree', 'yaml', 'json'].includes(format)) {
      console.error(chalk.red(`✗ Unknown format "${options.format}" — use tree, yaml or json.`));
      process.exit(1);
    }
    const parse = (res) => (typeof res === 'string' ? JSON.parse(res) : res);
    try {
      if (!nodeId) {
        const sel = parse(await fastEval(`(async () => JSON.stringify(figma.currentPage.selection.map(n => n.id)))()`));
        if (!sel.length) {
          console.error(chalk.red('✗ No nodeId given and nothing selected in Figma.'), 'Pass a node id or select a frame.');
          process.exit(1);
        }
        nodeId = sel[0];
      } else {
        nodeId = normalizedId(nodeId);
      }
      // --section: resolve the named child section and spec THAT node —
      // saves the copy-the-long-instance-id roundtrip on large screens.
      if (options.section) {
        const sec = parse(await fastEval(sectionFinderCode(nodeId, options.section)));
        if (sec?.error) {
          console.error(chalk.red('✗ ' + sec.error));
          process.exit(1);
        }
        console.error(chalk.gray(`section "${options.section}" → ${sec.name} [${sec.id}]${sec.matches > 1 ? ` (${sec.matches} name matches — shallowest/exact one taken; pass a node id to target another)` : ''}`));
        nodeId = sec.id;
      }
      // Instance descent makes trees deep; on payload/timeout errors retry
      // shallower (same strategy as `extract`) so big frames degrade gracefully
      // instead of failing.
      const requested = parseInt(options.depth) || 12;
      const { result, depth } = await walkWithDepthRetry(requested, async (d) =>
        parse(await fastEval(nodeWalkerCode(nodeId, {
          maxDepth: d, textLimit: 200,
          resolveInstances: true, withIds: true, withVars: true,
          includeHidden: options.includeHidden === true,
        }))));
      if (result?.error) {
        console.error(chalk.red('✗ ' + result.error));
        process.exit(1);
      }
      if (!result || !Array.isArray(result.frames)) {
        // Guard BEFORE the formatters — "Cannot read properties of null
        // (reading 'frames')" told the user nothing.
        console.error(chalk.red(`✗ code-spec: the plugin returned no data for node ${nodeId}.` +
          instancePathHint(nodeId) + ' Otherwise retry, or reduce --depth.'));
        process.exit(1);
      }
      if (depth < requested) {
        console.error(chalk.yellow(`⚠ payload limit — reduced depth to ${depth}; nested content may be truncated`));
      }
      let output;
      if (format === 'tree') {
        output = formatCodeSpec(result, { phase, dedup: options.dedup });
      } else {
        const model = specModel(result, { phase, dedup: options.dedup });
        output = format === 'yaml' ? toYaml(model) : JSON.stringify(model, null, 2);
      }
      // process.exit right after console.log DROPS unflushed stdout beyond
      // 64KB (classic Node pitfall — surfaced as yaml/json output truncated
      // at exactly 65536 bytes). Exit only once the write has been flushed.
      process.stdout.write(output + '\n', () => process.exit(0));
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
  .option('--save [path]', 'Custom PNG path (default: /tmp/figma-verify-{id}.png — save is the DEFAULT)')
  .option('--base64', 'Dump the base64 PNG to stdout instead of saving (token-heavy — opt-in only)')
  .option('--measure', 'Also return real (unscaled) node + child dimensions so size bugs are caught by measurement, not just the screenshot')
  .action(async (nodeId, options) => {
    await checkConnection();
    if (nodeId) nodeId = normalizedId(nodeId);
    const scale = parseFloat(options.scale);
    const maxDim = parseInt(options.max);
    const withMeasure = !!options.measure;

    const code = `(async () => {
      let node;
      ${nodeId ? `node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});` : `
      const sel = figma.currentPage.selection;
      node = sel.length > 0 ? sel[0] : null;
      `}
      if (!node) return { error: ${nodeId
        ? `'Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + figma.root.name + '". Safe Mode can only access the file open in Figma Desktop — if this id comes from another file (check the URL file key), open that file first.'`
        : `'Nothing selected in Figma — select a frame or pass a node id.'`} };
      if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
        // Pages have no width/height — the old fallback (100 * scale) exported
        // a useless 50x50 tile. Point at the page's top-level containers instead.
        if (node.type === 'PAGE') await node.loadAsync();
        const kids = (node.children || [])
          .filter(n => n.type === 'SECTION' || n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')
          .slice(0, 12)
          .map(n => '  ' + n.type + '  ' + n.id + '  "' + n.name + '"');
        return { error: 'Cannot screenshot a whole ' + node.type + ' — pass a frame or section id instead.'
          + (kids.length ? ' Top-level candidates:\\n' + kids.join('\\n') : '') };
      }
      if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };

      // Calculate optimal scale to stay under max dimension
      const nodeWidth = node.width || 100;
      const nodeHeight = node.height || 100;
      let finalScale = ${scale};
      const maxNodeDim = Math.max(nodeWidth, nodeHeight);
      if (maxNodeDim * finalScale > ${maxDim}) {
        finalScale = ${maxDim} / maxNodeDim;
      }
      // Ensure we don't exceed 8000px (API limit)
      if (maxNodeDim * finalScale > 7500) {
        finalScale = 7500 / maxNodeDim;
      }

      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: finalScale }
      });

      // Convert to base64
      const base64 = figma.base64Encode(bytes);

      // Optional measurement tree: real (unscaled) dimensions of the node and
      // its children, so size regressions ("too tall") are caught by numbers.
      let measure = null;
      if (${withMeasure}) {
        const walk = (n, depth) => {
          const m = {
            name: n.name, type: n.type,
            w: Math.round(n.width), h: Math.round(n.height),
            layout: n.layoutMode && n.layoutMode !== 'NONE' ? n.layoutMode : undefined,
            sizeH: n.layoutSizingHorizontal, sizeV: n.layoutSizingVertical
          };
          if (depth > 0 && 'children' in n && n.children.length) {
            m.children = n.children.slice(0, 24).map(c => walk(c, depth - 1));
          }
          return m;
        };
        measure = walk(node, 3);
      }

      return {
        name: node.name,
        id: node.id,
        width: Math.round(nodeWidth * finalScale),
        height: Math.round(nodeHeight * finalScale),
        scale: Math.round(finalScale * 1000) / 1000,
        base64: base64,
        measure: measure
      };
    })()`;

    const result = figmaEvalSync(code);
    if (result.error) {
      console.error(chalk.red('✗'), result.error);
      process.exit(1);
    }

    // Default: save the PNG to disk and return only metadata (lean on tokens).
    // Dumping the raw base64 into stdout is now opt-in via --base64, because it
    // lands in the agent's context as raw text (tens of thousands of tokens for
    // a full frame). Reading the saved PNG back instead enters it as a real image.
    // The applied scale rides along: a 561×300 node rendered at 0.5 reports
    // 281×150 — without `scale`, pixel comparisons against node dimensions
    // are silently off by the factor.
    if (options.base64) {
      console.log(JSON.stringify({
        name: result.name,
        id: result.id,
        width: result.width,
        height: result.height,
        scale: result.scale,
        base64: result.base64,
        ...(result.measure ? { measure: result.measure } : {})
      }));
    } else {
      const safeId = result.id.replace(/:/g, '-');
      const savePath = typeof options.save === 'string'
        ? options.save
        : `/tmp/figma-verify-${safeId}.png`;

      const buffer = Buffer.from(result.base64, 'base64');
      writeFileSync(savePath, buffer);

      console.log(JSON.stringify({
        name: result.name,
        id: result.id,
        width: result.width,
        height: result.height,
        scale: result.scale,
        saved: savePath,
        ...(result.measure ? { measure: result.measure } : {})
      }));
    }
  });

// ============ EVAL ============

program
  .command('eval [code]')
  .description('Execute JavaScript in Figma plugin context')
  .option('-f, --file <path>', 'Run code from file instead of argument')
  .action(async (code, options) => {
    await checkConnection();
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

    // Always prefer async daemon (more reliable, no shell timeout issues)
    if (isDaemonRunning()) {
      try {
        const result = await daemonExec('eval', { code: jsCode });
        if (result !== undefined && result !== null) {
          console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
        }
        return;
      } catch (e) {
        // Check if this is a connection/daemon error vs user code error
        const isConnectionError = e.message.includes('ECONNREFUSED') ||
                                  e.message.includes('fetch failed') ||
                                  e.message.includes('network') ||
                                  e.message.includes('timeout') ||
                                  e.message.includes('disconnected');
        if (isConnectionError) {
          // Connection/daemon error - fall back to sync path
          console.log(chalk.yellow('⚠ Daemon error, trying sync path...'));
        } else {
          // User code error - display directly, don't fall back
          console.log(chalk.red('✗ ' + e.message));
          return;
        }
      }
    }

    // Sync fallback (when daemon not running)
    try {
      const result = figmaEvalSync(jsCode);
      if (result !== undefined && result !== null) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
    } catch (error) {
      console.log(chalk.red('✗ ' + error.message));
    }
  });

// Run command - alias for eval --file (uses async for better performance)
program
  .command('run <file>')
  .description('Run JavaScript file in Figma (alias for eval --file)')
  .action(async (file) => {
    await checkConnection();
    if (!existsSync(file)) {
      console.log(chalk.red('✗ File not found: ' + file));
      return;
    }
    const code = readFileSync(file, 'utf8');
    try {
      // Use async daemon path for better performance with long scripts
      if (isDaemonRunning()) {
        const result = await daemonExec('eval', { code });
        if (result !== undefined) {
          console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
        }
      } else {
        // Fallback to the sync path (same daemon, no async wrapper)
        evalPrint(code);
      }
    } catch (e) {
      console.log(chalk.red('✗ ' + e.message));
    }
  });

// (The `raw` passthrough command was removed: it forwarded arbitrary strings
// to the legacy figma-use command layer, which no longer exists. Use `eval`.)

// (The `export-jsx` command was removed: unreachable through the MCP
// allowlist and superseded by `export code-spec` + `spec`, which resolve
// variable bindings and assets instead of guessing at JSX.)
