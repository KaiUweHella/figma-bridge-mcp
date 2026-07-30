// Commands: misc (extracted from index.js)
import chalk from 'chalk';
import * as apiDocs from '../api-docs.js';
import { componentInventoryCode } from '../lib/component-inventory.js';
import {
  program,
  checkConnection,
  componentContextExpr,
  daemonExec,
  getDaemonToken,
  handleEvalError
} from '../lib/cli-core.js';

// NOTE: there is deliberately NO `blocks` command — this tool ships no
// pre-built page content. Agents compose layouts themselves via `render`.


// ============ DEV RESOURCES ============
// Link Figma nodes to dev artifacts (Storybook, GitHub, docs, etc.)

const devCmd = program
  .command('dev')
  .description('Manage dev resources (Storybook/GitHub/doc links on nodes)');

devCmd
  .command('link <nodeId> <url>')
  .description('Add a dev resource link to a node')
  .option('-n, --name <name>', 'Display name for the link')
  .action(async (nodeId, url, options) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (typeof n.addDevResourceAsync !== 'function') throw new Error('Node does not support dev resources');
      await n.addDevResourceAsync(${JSON.stringify(url)}, ${JSON.stringify(options.name || '')});
      const all = await n.getDevResourcesAsync();
      return { id: n.id, name: n.name, count: all.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Linked: ${r.name} (${r.id}) → ${url}`);
      console.log(chalk.gray(`  Total dev resources: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

devCmd
  .command('list [nodeId]')
  .description('List dev resources on a node (or current selection)')
  .action(async (nodeId) => {
    await checkConnection();
    const target = nodeId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (typeof n.getDevResourcesAsync !== 'function') throw new Error('Node does not support dev resources');
      const r = await n.getDevResourcesAsync();
      return { id: n.id, name: n.name, resources: r };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      if (!r.resources || r.resources.length === 0) {
        console.log(chalk.gray('  (no dev resources)'));
        return;
      }
      r.resources.forEach((res, i) => {
        console.log(`  ${i + 1}. ${res.name || '(unnamed)'}`);
        console.log(chalk.gray(`     ${res.url}`));
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

devCmd
  .command('unlink <nodeId> <url>')
  .description('Remove a dev resource link from a node')
  .action(async (nodeId, url) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (typeof n.deleteDevResourceAsync !== 'function') throw new Error('Node does not support dev resources');
      await n.deleteDevResourceAsync(${JSON.stringify(url)});
      const all = await n.getDevResourcesAsync();
      return { id: n.id, name: n.name, count: all.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Unlinked from ${r.name} (${r.id})`);
      console.log(chalk.gray(`  Remaining dev resources: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

devCmd
  .command('edit <nodeId> <currentUrl> <newUrl>')
  .description('Edit an existing dev resource (replace URL and/or name)')
  .option('-n, --name <name>', 'New display name')
  .action(async (nodeId, currentUrl, newUrl, options) => {
    await checkConnection();
    const updateObj = { url: newUrl };
    if (options.name) updateObj.name = options.name;
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (typeof n.editDevResourceAsync !== 'function') throw new Error('Node does not support dev resources');
      await n.editDevResourceAsync(${JSON.stringify(currentUrl)}, ${JSON.stringify(updateObj)});
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Edited dev resource on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ SECTIONS ============
// Group frames into named Figma sections for canvas organization.

const sectionCmd = program
  .command('section')
  .description('Manage Figma sections (organize frames into named groups)');

sectionCmd
  .command('create <name> [nodeIds]')
  .description('Create a section, optionally moving comma-separated node IDs into it')
  .action(async (name, nodeIds) => {
    await checkConnection();
    const ids = nodeIds ? JSON.stringify(nodeIds.split(',').map(s => s.trim())) : '[]';
    const code = `(async () => {
      const section = figma.createSection();
      section.name = ${JSON.stringify(name)};
      const ids = ${ids};
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        section.appendChild(n);
      }
      return { id: section.id, name: section.name, count: ids.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Created section "${r.name}" (${r.id}) with ${r.count} child(ren)`);
    } catch (e) {
      handleEvalError(e);
    }
  });

sectionCmd
  .command('list')
  .description('List all sections on the current page')
  .action(async () => {
    await checkConnection();
    const code = `(async () => {
      const sections = figma.currentPage.findAll(n => n.type === 'SECTION');
      return sections.map(s => ({ id: s.id, name: s.name, count: s.children.length }));
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (!r || r.length === 0) {
        console.log(chalk.gray('(no sections on this page)'));
        return;
      }
      r.forEach(s => {
        console.log(`  ${s.name}  ${chalk.gray('(' + s.id + ')')}  ${chalk.gray(s.count + ' children')}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

sectionCmd
  .command('add <sectionId> <nodeIds>')
  .description('Add comma-separated nodes into an existing section')
  .action(async (sectionId, nodeIds) => {
    await checkConnection();
    const ids = JSON.stringify(nodeIds.split(',').map(s => s.trim()));
    const code = `(async () => {
      const s = await figma.getNodeByIdAsync(${JSON.stringify(sectionId)});
      if (!s) throw new Error('Section not found: ${sectionId}');
      if (s.type !== 'SECTION') throw new Error('Not a section: ${sectionId}');
      const ids = ${ids};
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        s.appendChild(n);
      }
      return { id: s.id, name: s.name, count: s.children.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Added to section "${r.name}" (${r.id}). Total children: ${r.count}`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ LAYOUT GRIDS ============
// Manage column/row grids on frames (12-col grids, baseline grids, etc.)

const gridCmd = program
  .command('grid')
  .description('Manage layout grids on frames (columns, rows, gutters)');

gridCmd
  .command('set <nodeId>')
  .description('Set a column or row grid on a frame')
  .option('-c, --columns <n>', 'Number of columns', parseInt)
  .option('-r, --rows <n>', 'Number of rows', parseInt)
  .option('-g, --gutter <n>', 'Gutter size in px', parseInt, 16)
  .option('-m, --margin <n>', 'Outer margin in px', parseInt, 0)
  .option('-a, --alignment <align>', 'Alignment: stretch|min|center|max', 'stretch')
  .option('--color <hex>', 'Grid color (hex)', '#FF008B')
  .option('--opacity <n>', 'Grid opacity (0-1)', parseFloat, 0.1)
  .option('--append', 'Append to existing grids instead of replacing')
  .action(async (nodeId, options) => {
    await checkConnection();
    if (!options.columns && !options.rows) {
      console.error(chalk.red('✗'), 'Specify at least --columns or --rows');
      process.exit(1);
    }
    const alignmentMap = { stretch: 'STRETCH', min: 'MIN', center: 'CENTER', max: 'MAX' };
    const alignment = alignmentMap[options.alignment.toLowerCase()] || 'STRETCH';
    const hex = options.color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const colorObj = `{r:${r.toFixed(4)},g:${g.toFixed(4)},b:${b.toFixed(4)},a:${options.opacity}}`;

    const grids = [];
    if (options.columns) {
      grids.push(`{pattern:'COLUMNS',alignment:'${alignment}',count:${options.columns},gutterSize:${options.gutter},offset:${options.margin},color:${colorObj},visible:true}`);
    }
    if (options.rows) {
      grids.push(`{pattern:'ROWS',alignment:'${alignment}',count:${options.rows},gutterSize:${options.gutter},offset:${options.margin},color:${colorObj},visible:true}`);
    }
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('layoutGrids' in n)) throw new Error('Node does not support layout grids (must be FRAME, COMPONENT, or COMPONENT_SET)');
      const newGrids = [${grids.join(',')}];
      n.layoutGrids = ${options.append ? '[...n.layoutGrids, ...newGrids]' : 'newGrids'};
      return { id: n.id, name: n.name, count: n.layoutGrids.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Set grid on ${r.name} (${r.id})`);
      console.log(chalk.gray(`  Total grids: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

gridCmd
  .command('list [nodeId]')
  .description('List layout grids on a frame (or current selection)')
  .action(async (nodeId) => {
    await checkConnection();
    const target = nodeId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (!('layoutGrids' in n)) throw new Error('Node does not support layout grids');
      return { id: n.id, name: n.name, grids: n.layoutGrids };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      if (!r.grids || r.grids.length === 0) {
        console.log(chalk.gray('  (no layout grids)'));
        return;
      }
      r.grids.forEach((g, i) => {
        if (g.pattern === 'GRID') {
          console.log(`  ${i + 1}. GRID  size=${g.sectionSize}px`);
        } else {
          console.log(`  ${i + 1}. ${g.pattern}  count=${g.count}  gutter=${g.gutterSize}  offset=${g.offset}  align=${g.alignment}`);
        }
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

gridCmd
  .command('clear <nodeId>')
  .description('Remove all layout grids from a frame')
  .action(async (nodeId) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('layoutGrids' in n)) throw new Error('Node does not support layout grids');
      n.layoutGrids = [];
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Cleared grids on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ COMPONENT PROPERTIES ============
// Manage variant/boolean/text/instance-swap properties on Figma components.

// (componentInventoryCode moved to lib/component-inventory.js — it is shared
// library code, and commands/map.js was importing a command file for it.)
const componentCmd = program
  .command('component')
  .description('Manage component properties and variants');

componentCmd
  .command('list')
  .description('List component sets (with variant axes) and standalone components')
  .option('--all-pages', 'Search every page, not just the current one (slower on big files)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();
    const code = componentInventoryCode(options.allPages);
    try {
      const r = await daemonExec('eval', { code });
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      if (r.componentSets.length === 0 && r.standaloneComponents.length === 0) {
        console.log(chalk.yellow(options.allPages
          ? 'No components in this file.'
          : 'No components on the current page. Try --all-pages.'));
        return;
      }
      if (r.componentSets.length > 0) {
        console.log(chalk.cyan('\nComponent sets:'));
        r.componentSets.forEach(s => {
          console.log(`  ${chalk.white(s.name)} ${chalk.gray('(' + s.id + (options.allPages ? ', page: ' + s.page : '') + ')')}`);
          if (s.key) console.log(chalk.gray(`    key: ${s.key}`));
          if (s.variantAxes) {
            Object.entries(s.variantAxes).forEach(([axis, def]) => {
              console.log(chalk.gray(`    ${axis}: ${def.values.join(' | ')}`));
            });
          }
          console.log(chalk.gray(`    ${s.variants.length} variant(s)`));
        });
      }
      if (r.standaloneComponents.length > 0) {
        console.log(chalk.cyan('\nStandalone components:'));
        r.standaloneComponents.forEach(c => {
          console.log(`  ${chalk.white(c.name)} ${chalk.gray('(' + c.id + (options.allPages ? ', page: ' + c.page : '') + (c.key ? ', key ' + c.key : '') + ')')}`);
        });
      }
      console.log();
    } catch (e) {
      handleEvalError(e);
    }
  });

componentCmd
  .command('main <instanceId>')
  .description('Resolve an instance to its main component (and variant set, if any)')
  .option('--json', 'Output as JSON')
  .action(async (instanceId, options) => {
    await checkConnection();
    // Resolution shared with `inspect` via componentContextExpr — one source
    // of truth for instance → main component / variant set / property facts.
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(instanceId)});
      if (!n) throw new Error('Node not found: ' + ${JSON.stringify(instanceId)});
      if (n.type !== 'INSTANCE') throw new Error('Not an INSTANCE (got ' + n.type + '): ' + n.name);
      const ctx = ${componentContextExpr('n')};
      if (!ctx.mainComponent) throw new Error('Instance has no resolvable main component (library not loaded?)');
      return { instance: { id: n.id, name: n.name }, ...ctx };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(chalk.cyan(`\n${r.instance.name} ${chalk.gray('(' + r.instance.id + ')')}`));
      console.log(`  main: ${chalk.white(r.mainComponent.name)} ${chalk.gray('(' + r.mainComponent.id + (r.mainComponent.key ? ', key ' + r.mainComponent.key : '') + (r.mainComponent.remote ? ', remote library' : '') + ')')}`);
      if (r.set) {
        console.log(`  set:  ${chalk.white(r.set.name)} ${chalk.gray('(' + r.set.id + (r.set.key ? ', key ' + r.set.key : '') + ', ' + r.set.variants.length + ' variants)')}`);
      }
      if (r.variantProperties && Object.keys(r.variantProperties).length > 0) {
        console.log('  variant values:');
        Object.entries(r.variantProperties).forEach(([k, v]) => console.log(chalk.gray(`    ${k} = ${v}`)));
      }
      if (r.componentPropertyDefinitions && Object.keys(r.componentPropertyDefinitions).length > 0) {
        console.log('  property definitions:');
        Object.entries(r.componentPropertyDefinitions).forEach(([k, def]) => {
          const opts = def.variantOptions ? ` [${def.variantOptions.join(' | ')}]` : '';
          console.log(chalk.gray(`    ${k}: ${def.type}${opts} (default: ${JSON.stringify(def.defaultValue)})`));
        });
      }
      console.log();
    } catch (e) {
      handleEvalError(e);
    }
  });

const propCmd = componentCmd
  .command('prop')
  .description('Manage component properties (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT)');

propCmd
  .command('add <componentId> <name> <type> <defaultValue>')
  .description('Add a property. Type: boolean | text | instance-swap | variant')
  .option('-o, --options <opts>', 'Comma-separated VARIANT options (e.g. "Small,Medium,Large")')
  .action(async (componentId, name, type, defaultValue, options) => {
    await checkConnection();
    const typeMap = { boolean: 'BOOLEAN', text: 'TEXT', 'instance-swap': 'INSTANCE_SWAP', variant: 'VARIANT' };
    const apiType = typeMap[type.toLowerCase()] || type.toUpperCase();
    if (!['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT'].includes(apiType)) {
      console.error(chalk.red('✗'), `Invalid type "${type}". Use: boolean, text, instance-swap, variant`);
      process.exit(1);
    }
    let parsedDefault = defaultValue;
    if (apiType === 'BOOLEAN') parsedDefault = defaultValue === 'true' || defaultValue === '1';
    if (apiType === 'VARIANT') {
      console.error(chalk.red('✗'), 'VARIANT properties cannot be added directly. Create variants by:');
      console.error('  1. Render multiple components (one per variant)');
      console.error('  2. Convert each: figma-cli node to-component <id>');
      console.error('  3. Combine: figma-cli component combine <id1,id2,id3> --name "MyComponent"');
      process.exit(1);
    }
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(componentId)});
      if (!n) throw new Error('Node not found: ${componentId}');
      if (typeof n.addComponentProperty !== 'function') throw new Error('Node is not a component or component set');
      const propName = n.addComponentProperty(${JSON.stringify(name)}, ${JSON.stringify(apiType)}, ${JSON.stringify(parsedDefault)});
      return { id: n.id, name: n.name, propName };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Added property "${r.propName}" on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

propCmd
  .command('list [componentId]')
  .description('List component properties on a component (or current selection)')
  .action(async (componentId) => {
    await checkConnection();
    const target = componentId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(componentId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (!('componentPropertyDefinitions' in n)) throw new Error('Node has no component properties');
      return { id: n.id, name: n.name, props: n.componentPropertyDefinitions };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      const entries = Object.entries(r.props || {});
      if (entries.length === 0) {
        console.log(chalk.gray('  (no component properties)'));
        return;
      }
      entries.forEach(([propName, def]) => {
        const tail = def.type === 'VARIANT' && Array.isArray(def.variantOptions)
          ? ` [${def.variantOptions.join(', ')}]`
          : '';
        console.log(`  ${propName}  ${chalk.gray(def.type)}  default=${JSON.stringify(def.defaultValue)}${tail}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

propCmd
  .command('delete <componentId> <propName>')
  .description('Delete a component property (use full name including #suffix)')
  .action(async (componentId, propName) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(componentId)});
      if (!n) throw new Error('Node not found: ${componentId}');
      if (typeof n.deleteComponentProperty !== 'function') throw new Error('Node is not a component or component set');
      n.deleteComponentProperty(${JSON.stringify(propName)});
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Deleted "${propName}" on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

componentCmd
  .command('combine <ids>')
  .description('Combine components (comma-separated IDs) into a single variant set')
  .option('-n, --name <name>', 'Name for the resulting component set', 'ComponentSet')
  .action(async (ids, options) => {
    await checkConnection();
    const idArr = ids.split(',').map(s => s.trim());
    const code = `(async () => {
      const components = [];
      for (const id of ${JSON.stringify(idArr)}) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        if (n.type !== 'COMPONENT') throw new Error('Not a component: ' + id + ' (type=' + n.type + ')');
        components.push(n);
      }
      const set = figma.combineAsVariants(components, figma.currentPage);
      set.name = ${JSON.stringify(options.name)};
      return { id: set.id, name: set.name, count: components.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Combined ${r.count} components into "${r.name}" (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ ANNOTATIONS ============
// Inline notes / specs on Figma nodes (tokens, usage rules, etc.)

const annotateCmd = program
  .command('annotate')
  .description('Manage annotations (inline notes) on nodes');

annotateCmd
  .command('add')
  .description('Add an annotation. Pass --node <id> for one, or --query <pattern> for all matches.')
  .argument('<text>', 'Annotation text (or markdown if --markdown)')
  .option('-m, --markdown', 'Treat text as markdown')
  .option('-n, --node <id>', 'Node ID to annotate')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern> (case-insensitive)')
  .action(async (text, options) => {
    await checkConnection();
    if (!options.node && !options.query) {
      console.error(chalk.red('✗'), 'Provide either --node <id> or --query <pattern>');
      process.exit(1);
    }
    const labelKey = options.markdown ? 'labelMarkdown' : 'label';
    const targetSelector = options.query
      ? `(figma.currentPage.findAll(n => 'annotations' in n && typeof n.name === 'string' && n.name.toLowerCase().includes(${JSON.stringify(options.query.toLowerCase())})))`
      : `[await figma.getNodeByIdAsync(${JSON.stringify(options.node)})].filter(Boolean)`;
    const code = `(async () => {
      const nodes = ${targetSelector};
      if (nodes.length === 0) throw new Error(${options.query ? `'No nodes matched query: ${options.query}'` : `'Node not found: ${options.node}'`});
      const results = [];
      for (const n of nodes) {
        if (!('annotations' in n)) continue;
        const existing = (n.annotations || []).map(a => {
          const c = {};
          if (a.labelMarkdown) c.labelMarkdown = a.labelMarkdown;
          else if (a.label) c.label = a.label;
          if (a.categoryId) c.categoryId = a.categoryId;
          if (a.properties) c.properties = a.properties;
          return c;
        });
        n.annotations = [...existing, { ${labelKey}: ${JSON.stringify(text)} }];
        results.push({ id: n.id, name: n.name });
      }
      return results;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Annotated ${r.length} node(s):`);
      r.forEach(n => console.log(chalk.gray(`  ${n.name} (${n.id})`)));
    } catch (e) {
      handleEvalError(e);
    }
  });

annotateCmd
  .command('list [nodeId]')
  .description('List annotations on a node (or current selection)')
  .action(async (nodeId) => {
    await checkConnection();
    const target = nodeId
      ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
      : `figma.currentPage.selection[0]`;
    const code = `(async () => {
      const n = ${target};
      if (!n) throw new Error('No node found');
      if (!('annotations' in n)) throw new Error('Node does not support annotations');
      return { id: n.id, name: n.name, annotations: n.annotations || [] };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.bold(`${r.name} (${r.id})`));
      if (!r.annotations || r.annotations.length === 0) {
        console.log(chalk.gray('  (no annotations)'));
        return;
      }
      r.annotations.forEach((a, i) => {
        const label = a.label || a.labelMarkdown || '(empty)';
        console.log(`  ${i + 1}. ${label}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

annotateCmd
  .command('clear <nodeId>')
  .description('Remove all annotations from a node')
  .action(async (nodeId) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('annotations' in n)) throw new Error('Node does not support annotations');
      n.annotations = [];
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Cleared annotations on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ PLUGINS ============
// The `plugins` command group (voice plugins etc.) was removed in
// figma-safe-mcp — plugins.js and plugins/voice/ are not vendored.

// === API docs (offline Figma Plugin API reference) ===
const apiCmd = program
  .command('api [name]')
  .description('Look up Figma Plugin API interface or type (offline). Run `api setup` first.')
  .option('--full', 'Full markdown dump (default is a compact signatures-only view)')
  .action((name, options) => apiDocs.show(name, { full: !!options.full }));

// `api show <name>` forces a reference lookup: unlike `api <name>`, a name that
// collides with a subcommand (setup/list/index/context/age/gap/search) is taken
// as the lookup argument, never dispatched. The MCP figma_reference tool uses
// this so no interface name can trigger a side-effecting subcommand.
apiCmd
  .command('show <name>')
  .description('Show a specific interface/type by name (never dispatches to a subcommand)')
  .option('--full', 'Full markdown dump (default is a compact signatures-only view)')
  .action((name, options) => apiDocs.show(name, { full: !!options.full }));

apiCmd
  .command('setup')
  .description('Download Figma Plugin API docs locally (~5 MB, one-time). Use --update to pull the latest version instead of re-cloning.')
  .option('--update', 'git pull the docs repo instead of re-cloning (faster, keeps the dir)')
  .action((options) => apiDocs.setup({ update: !!options.update }));

apiCmd
  .command('index')
  .description('Build/refresh the compact "what APIs exist" index (~5 KB). LLM-friendly first-fetch handle.')
  .action(() => apiDocs.buildIndex());

apiCmd
  .command('context [topic]')
  .description('Print an LLM-ready context block. Without topic: the compact index. With topic: index + relevant interface bodies.')
  .action((topic) => {
    process.stdout.write(apiDocs.getContext(topic || ''));
  });

apiCmd
  .command('age')
  .description('Days since the docs repo was last updated. Lets agent tooling decide when to auto-refresh.')
  .action(() => {
    const days = apiDocs.ageInDays();
    if (days === Infinity) {
      console.log('not installed');
      process.exit(1);
    }
    console.log(days.toFixed(1));
  });

apiCmd
  .command('list [filter]')
  .description('List all interfaces and types (optional substring filter)')
  .action((filter) => apiDocs.list(filter));

apiCmd
  .command('gap')
  .description('Show Figma Plugin API capabilities not yet exposed by figma-cli')
  .action(() => apiDocs.gap());

apiCmd
  .command('search <keyword>')
  .description('Find Plugin API methods/properties whose name contains <keyword> (e.g. "scale", "resize")')
  .option('--json', 'Output as JSON (machine-readable, for the API-doc auto-fallback)')
  .option('-l, --limit <n>', 'Max results', '8')
  .action((keyword, options) => {
    const results = apiDocs.searchMethods(keyword);
    if (results.length === 0) {
      if (options.json) {
        console.log('[]');
      } else {
        console.error(`No Plugin API method matching "${keyword}".`);
      }
      return;
    }
    const top = results.slice(0, parseInt(options.limit) || 8);
    if (options.json) {
      console.log(JSON.stringify(top.map(r => ({
        method: r.method, signature: r.signature, interface: r.interface
      })), null, 2));
      return;
    }
    console.log(`Top Plugin API matches for "${keyword}":\n`);
    for (const r of top) {
      console.log(`  ${chalk.cyan(r.method)}  ${chalk.dim('on ' + r.interface)}`);
      if (r.signature) console.log(`    ${chalk.gray(r.signature)}`);
    }
    console.log('\nTip: use these inside a `figma-cli eval "..."` call when no subcommand fits.');
  });

// (Unknown-command handling lives inside the default program.action)
