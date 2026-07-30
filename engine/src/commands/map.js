// Command: map — Figma↔code mapping files.
//
// `map storybook <urlOrPath>` matches the open Figma file's components
// (stable publish keys) against a Storybook index (story ids/import paths)
// and writes figma-map.json — the bridge an agent uses to know which
// Storybook story mirrors which Figma component. Writes a REPO FILE only;
// never mutates the Figma document.
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  program,
  checkConnection,
  daemonExec,
  handleEvalError,
} from '../lib/cli-core.js';
import { componentInventoryCode } from '../lib/component-inventory.js';
import { fetchStorybookIndex, parseStorybookIndex } from '../code-import/storybook.js';
import { matchComponents, mergeMaps } from '../lib/story-match.js';

const mapCmd = program
  .command('map')
  .description('Create Figma↔code mapping files (writes into your project, never into Figma)');

mapCmd
  .command('storybook <urlOrPath>')
  .description('Match Figma components against a Storybook index and write figma-map.json')
  .option('-o, --output <file>', 'Output file', './figma-map.json')
  .option('--json', 'Print the resulting map as JSON to stdout')
  .option('--current-page', 'Only scan the current Figma page (default: all pages)')
  .action(async (urlOrPath, options) => {
    await checkConnection();

    // 1. Storybook side: index.json → component groups with story ids.
    let storyComponents;
    try {
      const text = await fetchStorybookIndex(urlOrPath);
      storyComponents = parseStorybookIndex(text).meta.components;
    } catch (e) {
      console.error(chalk.red('✗ ' + e.message));
      process.exitCode = 1;
      return;
    }

    // 2. Figma side: one eval — component inventory with stable keys.
    let inventory;
    try {
      inventory = await daemonExec('eval', { code: componentInventoryCode(!options.currentPage) });
    } catch (e) {
      handleEvalError(e);
      return;
    }

    const figmaComponents = [
      ...inventory.componentSets.map((s) => {
        const dv = s.variants.find((v) => v.id === s.defaultVariantId) || s.variants[0];
        return {
          name: s.name, page: s.page, nodeId: s.id, kind: 'set',
          figmaKey: s.key, figmaVariantKey: dv?.key ?? null,
        };
      }),
      ...inventory.standaloneComponents.map((c) => ({
        name: c.name, page: c.page, nodeId: c.id, kind: 'component',
        // A standalone's own key is both identity and instancing handle.
        figmaKey: c.key, figmaVariantKey: c.key,
      })),
    ];

    // 3. Match, merge with pinned manual entries from a previous run.
    let result = matchComponents(figmaComponents, storyComponents);
    const outPath = resolve(options.output);
    if (existsSync(outPath)) {
      try {
        result = mergeMaps(JSON.parse(readFileSync(outPath, 'utf8')), result);
      } catch {
        console.log(chalk.yellow(`! Existing ${options.output} is not valid JSON — overwriting.`));
      }
    }

    const map = {
      version: 1,
      generatedAt: new Date().toISOString(),
      figmaFile: inventory.fileName || null,
      storybookSource: urlOrPath,
      mappings: result.mappings,
      unmatchedFigma: result.unmatchedFigma.map(({ name, page, figmaKey, nodeId, reason }) => ({
        figmaName: name, figmaPage: page, figmaKey: figmaKey ?? null, figmaNodeId: nodeId, reason,
      })),
      unmatchedStories: result.unmatchedStories,
    };

    writeFileSync(outPath, JSON.stringify(map, null, 2) + '\n');

    if (options.json) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }

    const by = (conf) => result.mappings.filter((m) => m.confidence === conf).length;
    const manual = result.mappings.filter((m) => m.matchedBy === 'manual').length;
    console.log(chalk.green(`✓ ${result.mappings.length} mapped`) + chalk.gray(
      ` (${by('high')} high / ${by('medium')} medium / ${by('low')} low${manual ? ` / ${manual} manual` : ''})`,
    ));
    for (const m of result.mappings) {
      const conf = m.matchedBy === 'manual' ? 'manual' : m.confidence;
      console.log(`  ${chalk.white(m.figmaName)} ↔ ${m.storyTitle} ${chalk.gray(`(${conf})`)}`);
    }
    if (result.unmatchedFigma.length) {
      console.log(chalk.yellow(`\n${result.unmatchedFigma.length} Figma component(s) without a story:`));
      result.unmatchedFigma.forEach((f) => console.log(chalk.gray(`  ${f.name ?? f.figmaName} (${f.reason ?? 'no-match'})`)));
    }
    if (result.unmatchedStories.length) {
      console.log(chalk.yellow(`\n${result.unmatchedStories.length} story component(s) without a Figma component:`));
      result.unmatchedStories.forEach((s) => console.log(chalk.gray(`  ${s.storyTitle}`)));
    }
    console.log(chalk.gray(`\nWritten to ${outPath}. Pin entries by setting "matchedBy": "manual" — they survive re-runs.`));
  });
