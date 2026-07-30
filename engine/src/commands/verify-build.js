// Command: verify-build — mechanical build-vs-manifest check, no Figma needed.
//
// Greps a project directory against the assets.json manifest(s) written by
// `export assets`: every exported file must be referenced somewhere in the
// build (the absolutely-positioned/overhanging SVGs are the ones that get
// lost), plus a border-image lint (gradient stroke + radius built with
// border-image silently loses the radius). Read-only — touches neither the
// Figma document nor the project.
import chalk from 'chalk';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, basename, extname } from 'path';
import { program } from '../lib/cli-core.js';
import { verifyBuild, describeMissing } from '../lib/verify-build.js';

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

program
  .command('verify-build <projectDir>')
  .description('Grep a project against assets.json: list every exported asset file NOT referenced in the build (these are the fidelity bugs), plus a border-image lint. Read-only, needs no Figma connection.')
  .option('--assets <path>', 'assets.json file or its directory (default: found automatically anywhere under projectDir)')
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

    if (options.json) {
      console.log(JSON.stringify({
        projectDir: root,
        manifests: manifests.map((m) => relative(root, m.path) || m.path),
        total: result.total,
        referenced: result.referenced.length,
        missing: result.missing.map(({ file, entries }) => ({ file, entries })),
        borderImage: result.borderImage.map((b) => ({ file: relative(root, b.path), line: b.line })),
      }, null, 2));
      process.exit(result.missing.length ? 1 : 0);
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
    process.exit(result.missing.length ? 1 : 0);
  });
