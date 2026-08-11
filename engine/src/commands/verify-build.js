// Command: verify-build — mechanical + visual build-vs-design check.
//
// Mechanical pass (always, no Figma needed): greps a project directory
// against the assets.json manifest(s) written by `export assets` — every
// exported file must be referenced somewhere in the build (the absolutely-
// positioned/overhanging SVGs are the ones that get lost) — plus a
// border-image lint (gradient stroke + radius built with border-image
// silently loses the radius).
//
// Visual pass (--compare <buildPng>): diffs a screenshot of the BUILD
// against the design render — the build-side sister of `verify` (which
// screenshots the Figma side). Reference comes from --design <png> (fully
// offline) or is fetched live from Figma (--node, or the manifest's root).
// Informational by default; --max-diff <pct> opts into gating the exit code.
import chalk from 'chalk';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve, relative, basename, extname, dirname } from 'path';
import { PNG } from 'pngjs';
import { program, checkConnection, figmaEvalSync } from '../lib/cli-core.js';
import { verifyBuild, describeMissing } from '../lib/verify-build.js';
import { diffImages, describeRegions } from '../lib/image-diff.js';
import { loadImage } from '../gradient-extractor.js';

// Directories that are never part of the source build.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.turbo', '.cache',
]);

// Text files a build references assets from. SVG/JSON are included: an SVG
// can <use> another asset, and config JSON can point at files. The manifest
// files themselves (assets.json) are excluded — they reference everything.
const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.sass',
  '.less', '.html', '.htm', '.vue', '.svelte', '.astro', '.md', '.mdx',
  '.json', '.svg',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Cap on the live-fetched reference render (largest node dimension in px).
const FETCH_MAX_DIM = 2000;

/** Recursively collect { manifests, files } under dir. */
function scanProject(dir) {
  const manifests = [];
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const path = join(d, e.name);
      if (e.name === 'assets.json') {
        try { manifests.push({ path, data: JSON.parse(readFileSync(path, 'utf8')) }); } catch {}
        continue;
      }
      if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue;
      try {
        if (statSync(path).size > MAX_FILE_BYTES) continue;
        files.push({ path, text: readFileSync(path, 'utf8') });
      } catch {}
    }
  };
  walk(dir);
  return { manifests, files };
}

/** Distinct export-root ids across the manifests ({ id, name } each). */
function manifestRoots(manifests) {
  const byId = new Map();
  for (const m of manifests) {
    const roots = m.data?.roots
      || (m.data?.root ? [{ id: m.data.root, name: m.data.rootName }] : []);
    for (const r of roots) if (r?.id && !byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Load an image file with an actionable error instead of a decoder throw. */
function loadImageOrExit(path, role) {
  const ext = extname(path).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    console.error(chalk.red(`✗ verify-build: ${role} must be a PNG or JPEG, got "${basename(path)}".`));
    process.exit(1);
  }
  try {
    return loadImage(path);
  } catch (e) {
    console.error(chalk.red(`✗ verify-build: cannot read ${role} ${path}: ${e.message}`));
    process.exit(1);
  }
}

/**
 * Fetch the design reference PNG live from Figma (same export approach as
 * `verify`, scale capped so huge frames stay tractable). Returns
 * { image, scale, nodeName } — region coordinates get divided by `scale`
 * later so findings always speak NODE pixels.
 */
async function fetchDesignReference(nodeId) {
  await checkConnection();
  const code = `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!node) return { error: 'Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + figma.root.name + '" — Safe Mode only reaches the file open in Figma Desktop.' };
    if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
    const maxDim = Math.max(node.width || 1, node.height || 1);
    const scale = Math.min(1, ${FETCH_MAX_DIM} / maxDim);
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
    return { name: node.name, scale, base64: figma.base64Encode(bytes) };
  })()`;
  const result = figmaEvalSync(code);
  if (result.error) {
    console.error(chalk.red('✗ ' + result.error));
    process.exit(1);
  }
  const png = PNG.sync.read(Buffer.from(result.base64, 'base64'));
  return {
    image: { width: png.width, height: png.height, data: new Uint8Array(png.data) },
    scale: result.scale,
    nodeName: result.name,
  };
}

/** Encode { width, height, data } RGBA as a PNG buffer. */
function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  return PNG.sync.write(png);
}

program
  .command('verify-build <projectDir>')
  .description('Verify a build against the design: grep the project against assets.json (unreferenced assets = the classic fidelity bugs) + border-image lint; with --compare also a visual pixel diff of a build screenshot against the design render. Mechanical part is read-only and needs no Figma connection.')
  .option('--assets <path>', 'assets.json file or its directory (default: found automatically anywhere under projectDir)')
  .option('--compare <buildPng>', 'screenshot of YOUR BUILD (PNG/JPEG) — enables the visual diff')
  .option('--design <designPng>', 'design reference image; skips the live Figma fetch (fully offline)')
  .option('--node <nodeId>', 'Figma node to fetch the reference from (default: the sole export root in assets.json)')
  .option('--diff-out <path>', 'where to write the diff PNG (default: next to the build screenshot, <name>-diff.png)')
  .option('--max-diff <pct>', 'fail (exit 1) when the visual diff exceeds this percentage — off by default')
  .option('--json', 'Machine-readable JSON output')
  .action(async (projectDir, options) => {
    const root = resolve(projectDir);
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
    } catch {
      console.error(chalk.red(`✗ verify-build: ${root} is not a readable directory.`));
      process.exit(1);
    }
    const { manifests: foundManifests, files } = scanProject(root);
    let manifests = foundManifests;
    if (options.assets) {
      const p = resolve(options.assets);
      const manifestPath = basename(p) === 'assets.json' ? p : join(p, 'assets.json');
      try {
        manifests = [{ path: manifestPath, data: JSON.parse(readFileSync(manifestPath, 'utf8')) }];
      } catch (e) {
        console.error(chalk.red(`✗ verify-build: cannot read ${manifestPath}: ${e.message}`));
        process.exit(1);
      }
    }
    if (!manifests.length) {
      console.error(chalk.red('✗ verify-build: no assets.json found under ' + root + '.'));
      console.error('  Run `export assets <nodeId> -o <projectDir>/src/assets` first, or point at the manifest with --assets <path>.');
      process.exit(1);
    }

    const result = verifyBuild(manifests.map((m) => m.data), files);

    // ---- visual pass (optional) ----
    let visual = null;
    if (options.compare) {
      const buildPath = resolve(options.compare);
      const build = loadImageOrExit(buildPath, 'build screenshot (--compare)');
      let design, reference, nodeScale = 1;
      if (options.design) {
        if (options.node) console.error(chalk.yellow('⚠ both --design and --node given — using the --design file, no Figma fetch.'));
        const designPath = resolve(options.design);
        design = loadImageOrExit(designPath, 'design reference (--design)');
        reference = { source: 'file', path: designPath };
      } else {
        let nodeId = options.node;
        if (!nodeId) {
          const roots = manifestRoots(manifests);
          if (roots.length === 1) nodeId = roots[0].id;
          else if (roots.length === 0) {
            console.error(chalk.red('✗ verify-build --compare: assets.json names no export root — pass --node <nodeId> or --design <png>.'));
            process.exit(1);
          } else {
            console.error(chalk.red(`✗ verify-build --compare: assets.json has ${roots.length} export roots — pass --node to pick the frame to compare against:`));
            for (const r of roots) console.error(`  - ${r.id}  "${r.name || ''}"`);
            process.exit(1);
          }
        }
        const fetched = await fetchDesignReference(nodeId);
        design = fetched.image;
        nodeScale = fetched.scale;
        reference = { source: 'figma', nodeId, nodeName: fetched.nodeName, scale: fetched.scale };
      }
      const diff = diffImages(design, build);
      // Live fetch at scale s: the design image is node-px × s. Convert the
      // findings so they always speak NODE pixels — the coordinate system of
      // the spec and assets.json. (--design files: coordinates stay in that
      // image's own pixel space; the caller knows what scale it was taken at.)
      const toNode = (v) => Math.round(v / nodeScale);
      const regions = diff.regions.map((r) => ({
        x0: toNode(r.x0), y0: toNode(r.y0), x1: toNode(r.x1), y1: toNode(r.y1), diffPct: r.diffPct,
      }));
      const diffOut = options.diffOut
        ? resolve(options.diffOut)
        : join(dirname(buildPath), basename(buildPath, extname(buildPath)) + '-diff.png');
      writeFileSync(diffOut, encodePng(diff.diffImage));
      visual = {
        diffPct: diff.diffPct,
        compare: diff.compare,
        heightMismatch: diff.heightMismatch,
        regions,
        coordinateSpace: reference.source === 'figma' ? 'node px' : 'design-image px',
        reference,
        diffOut,
      };
    }

    const maxDiff = options.maxDiff !== undefined ? parseFloat(options.maxDiff) : null;
    const visualFail = visual && maxDiff !== null && Number.isFinite(maxDiff) && visual.diffPct > maxDiff;
    const exitCode = result.missing.length || visualFail ? 1 : 0;

    if (options.json) {
      console.log(JSON.stringify({
        projectDir: root,
        manifests: manifests.map((m) => relative(root, m.path) || m.path),
        total: result.total,
        referenced: result.referenced.length,
        missing: result.missing.map(({ file, entries }) => ({ file, entries })),
        borderImage: result.borderImage.map((b) => ({ file: relative(root, b.path), line: b.line })),
        ...(visual ? { visual } : {}),
      }, null, 2));
      process.exit(exitCode);
    }

    console.log(`manifest(s): ${manifests.map((m) => relative(root, m.path) || m.path).join(', ')}`);
    console.log(`${result.referenced.length}/${result.total} asset file(s) referenced in the build (${files.length} project files scanned)`);
    if (result.missing.length) {
      console.log(chalk.red(`✗ ${result.missing.length} exported file(s) are NOT referenced anywhere:`));
      for (const m of result.missing) console.log('  - ' + describeMissing(m));
      console.log('  Each of these is real artwork from the design. Place the file at its x/y offsets inside its parent (placement fields are in assets.json) — never approximate it with CSS.');
    } else if (result.total) {
      console.log(chalk.green('✓ every exported asset file is referenced.'));
    }
    if (result.borderImage.length) {
      console.log(chalk.yellow(`⚠ border-image found (ignores border-radius — gradient strokes on rounded boxes lose their corners; use the wrapper/padding or mask pattern instead):`));
      for (const b of result.borderImage) console.log(`  - ${relative(root, b.path)}:${b.line}`);
    }

    if (visual) {
      const ref = visual.reference.source === 'figma'
        ? `Figma node ${visual.reference.nodeId} "${visual.reference.nodeName}" (fetched at scale ${visual.reference.scale})`
        : visual.reference.path;
      console.log('');
      console.log(`visual diff vs ${ref}:`);
      const pctLine = `${visual.diffPct}% of the compared area differs`;
      console.log(visual.diffPct > 10 ? chalk.red('✗ ' + pctLine) : visual.diffPct > 2 ? chalk.yellow('⚠ ' + pctLine) : chalk.green('✓ ' + pctLine));
      if (visual.heightMismatch) {
        const h = visual.heightMismatch;
        console.log(chalk.yellow(`⚠ the build is ${h.deltaPct}% ${h.direction} than the design (normalized heights ${h.buildH} vs ${h.designH}) — a missing or extra block; only the overlapping rows were compared.`));
      }
      if (visual.regions.length) {
        console.log(`  worst regions (${visual.coordinateSpace}, worst first):`);
        for (const line of describeRegions({ regions: visual.regions })) console.log('  - ' + line);
      }
      console.log(`  diff image: ${visual.diffOut} — Read it; red = differing pixels on a dimmed design.`);
      console.log('  A solid red band with correct content above it usually means a block was inserted/dropped there — everything below shifts. Cross-check the missing-asset findings above; region coordinates match the spec and assets.json placement fields.');
      if (visualFail) console.log(chalk.red(`✗ --max-diff ${maxDiff}% exceeded.`));
    } else if (!result.missing.length) {
      console.log(chalk.yellow('⚠ ASSET-ONLY CHECK PASSED; VISUAL FIDELITY IS NOT VERIFIED. Do not declare the implementation done yet.'));
      console.log('  Screenshot your build at the design\'s width and re-run with --compare <build.png> (add --design <figma.png> to stay offline). This catches omitted gradients, wrong component variants/sizes, and shifted absolute overlays.');
    }
    process.exit(exitCode);
  });
