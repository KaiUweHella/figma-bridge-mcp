// Commands: slots (extracted from index.js)
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval
} from '../lib/cli-core.js';

// ============ SLOT COMMANDS ============

// Shared snippet (spliced into eval templates) that normalizes an empty slot so it
// reads as a compact drop zone instead of a 100px FIXED void. Assumes a `slot`
// variable is in scope. Fills width when the parent is auto-layout, hugs height,
// and applies a small min-height so the empty slot stays visible.
const NORMALIZE_EMPTY_SLOT = `
      try { if (slot.parent && slot.parent.layoutMode && slot.parent.layoutMode !== 'NONE') slot.layoutSizingHorizontal = 'FILL'; } catch (e) {}
      if (slot.children.length === 0) {
        try { slot.primaryAxisSizingMode = 'AUTO'; } catch (e) {}
        try { slot.layoutSizingVertical = 'HUG'; } catch (e) {}
        try { slot.minHeight = Math.max(slot.minHeight || 0, 40); } catch (e) {}
      }`;

const slot = program
  .command('slot')
  .description('Slot operations (create, list, preferred, reset, convert)');

slot
  .command('create <name>')
  .description('Create a slot on selected component')
  .option('-f, --flex <direction>', 'Layout direction: row or col', 'col')
  .option('-g, --gap <value>', 'Gap between items', '0')
  .option('-p, --padding <value>', 'Padding')
  .action(async (name, options) => {
    await checkConnection();

    const flex = options.flex === 'row' ? 'HORIZONTAL' : 'VERTICAL';
    const gap = parseInt(options.gap) || 0;
    const padding = options.padding ? parseInt(options.padding) : 0;

    const code = `(async () => {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) return { error: 'No component selected' };

      const comp = selection[0];
      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') {
        return { error: 'Selected node is not a component. Select a component first.' };
      }

      const slot = comp.createSlot(${JSON.stringify(name)});
      try { slot.name = ${JSON.stringify(name)}; } catch (e) {}
      slot.layoutMode = '${flex}';
      slot.itemSpacing = ${gap};
      slot.paddingTop = ${padding};
      slot.paddingBottom = ${padding};
      slot.paddingLeft = ${padding};
      slot.paddingRight = ${padding};
${NORMALIZE_EMPTY_SLOT}

      return {
        success: true,
        slotId: slot.id,
        slotName: slot.name,
        componentName: comp.name
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Created slot "${result.slotName}" in component "${result.componentName}"`));
        console.log(chalk.gray(`  ID: ${result.slotId}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('list [nodeId]')
  .description('List slots in a component')
  .action(async (nodeId) => {
    await checkConnection();

    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      let comp;

      if (targetId) {
        comp = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No component selected' };
        comp = selection[0];
      }

      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') {
        return { error: 'Node is not a component' };
      }

      const propDefs = comp.componentPropertyDefinitions;
      const slots = [];

      for (const [key, def] of Object.entries(propDefs)) {
        if (def.type === 'SLOT') {
          slots.push({
            key,
            description: def.description,
            preferredCount: def.preferredValues ? def.preferredValues.length : 0
          });
        }
      }

      // Also find SLOT nodes in children
      const slotNodes = [];
      function findSlots(node) {
        if (node.type === 'SLOT') {
          slotNodes.push({ id: node.id, name: node.name });
        }
        if ('children' in node) {
          node.children.forEach(findSlots);
        }
      }
      findSlots(comp);

      return {
        componentName: comp.name,
        componentId: comp.id,
        properties: slots,
        slotNodes
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.cyan(`\nSlots in "${result.componentName}" (${result.componentId}):`));

        if (result.properties.length === 0) {
          console.log(chalk.gray('  No slot properties found'));
        } else {
          console.log(chalk.white('\nSlot Properties:'));
          result.properties.forEach(s => {
            console.log(`  ${chalk.green(s.key)}`);
            if (s.description) console.log(chalk.gray(`    Description: ${s.description}`));
            console.log(chalk.gray(`    Preferred values: ${s.preferredCount}`));
          });
        }

        if (result.slotNodes.length > 0) {
          console.log(chalk.white('\nSlot Nodes:'));
          result.slotNodes.forEach(s => {
            console.log(`  ${chalk.yellow(s.name)} (${s.id})`);
          });
        }
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('preferred <slotKey> <componentIds...>')
  .description('Set preferred components for a slot')
  .option('-n, --node <nodeId>', 'Component ID to modify (otherwise uses selection)')
  .action(async (slotKey, componentIds, options) => {
    await checkConnection();

    const code = `(async () => {
      const targetId = ${options.node ? `"${options.node}"` : 'null'};
      let comp;

      if (targetId) {
        comp = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No component selected' };
        comp = selection[0];
      }

      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') {
        return { error: 'Node is not a component' };
      }

      const propDefs = comp.componentPropertyDefinitions;

      // Find the slot property (might need to match partially)
      let slotPropKey = null;
      for (const key of Object.keys(propDefs)) {
        if (key === ${JSON.stringify(slotKey)} || key.startsWith(${JSON.stringify(slotKey)} + '#')) {
          slotPropKey = key;
          break;
        }
      }

      if (!slotPropKey) {
        return { error: 'Slot property not found: ' + ${JSON.stringify(slotKey)} };
      }

      // Get component keys for preferred values
      const preferredValues = [];
      const compIds = ${JSON.stringify(componentIds)};

      for (const id of compIds) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET')) {
          preferredValues.push({ type: 'COMPONENT', key: node.key });
        }
      }

      if (preferredValues.length === 0) {
        return { error: 'No valid components found' };
      }

      comp.editComponentProperty(slotPropKey, { preferredValues });

      return {
        success: true,
        slotKey: slotPropKey,
        preferredCount: preferredValues.length
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Set ${result.preferredCount} preferred component(s) for slot "${result.slotKey}"`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('reset [nodeId]')
  .description('Reset slot in instance to defaults')
  .action(async (nodeId) => {
    await checkConnection();

    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      let node;

      if (targetId) {
        node = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No slot selected' };
        node = selection[0];
      }

      if (node.type !== 'SLOT') {
        // Try to find slot in instance
        if (node.type === 'INSTANCE') {
          const slots = node.children.filter(c => c.type === 'SLOT');
          if (slots.length === 0) return { error: 'No slots found in instance' };
          if (slots.length === 1) {
            node = slots[0];
          } else {
            return { error: 'Multiple slots found. Select a specific slot or provide its ID.' };
          }
        } else {
          return { error: 'Node is not a slot. Select a slot node or instance.' };
        }
      }

      const beforeCount = node.children.length;
      node.resetSlot();
      const afterCount = node.children.length;

      return {
        success: true,
        slotName: node.name,
        beforeCount,
        afterCount
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Reset slot "${result.slotName}"`));
        console.log(chalk.gray(`  Children: ${result.beforeCount} → ${result.afterCount}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('convert [nodeId]')
  .description('Convert a frame to a slot (must be inside a component)')
  .option('-n, --name <name>', 'Slot name')
  .action(async (nodeId, options) => {
    await checkConnection();

    const slotName = options.name || 'Slot';

    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      let frame;

      if (targetId) {
        frame = await figma.getNodeByIdAsync(targetId);
      } else {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) return { error: 'No frame selected' };
        frame = selection[0];
      }

      if (frame.type !== 'FRAME') {
        return { error: 'Node is not a frame' };
      }

      // Find parent component
      let parent = frame.parent;
      let component = null;
      while (parent) {
        if (parent.type === 'COMPONENT' || parent.type === 'COMPONENT_SET') {
          component = parent;
          break;
        }
        parent = parent.parent;
      }

      if (!component) {
        return { error: 'Frame is not inside a component' };
      }

      // Store frame properties
      const frameProps = {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        layoutMode: frame.layoutMode,
        itemSpacing: frame.itemSpacing,
        paddingTop: frame.paddingTop,
        paddingBottom: frame.paddingBottom,
        paddingLeft: frame.paddingLeft,
        paddingRight: frame.paddingRight,
        fills: frame.fills,
        children: [...frame.children]
      };

      // Capture layout alignment + auto-layout sizing so the slot inherits how the
      // frame was sized (FILL/HUG/FIXED) instead of hard-coding a FIXED box.
      let alignPrimary = null, alignCounter = null, sizeH = null, sizeV = null;
      try { alignPrimary = frame.primaryAxisAlignItems; alignCounter = frame.counterAxisAlignItems; } catch (e) {}
      try { sizeH = frame.layoutSizingHorizontal; sizeV = frame.layoutSizingVertical; } catch (e) {}

      // Remember the frame's exact position so the slot lands in place, not at the
      // end of the component (createSlot always appends).
      const origParent = frame.parent;
      const origIndex = origParent.children.indexOf(frame);

      // Create slot. createSlot() ignores its name argument and always names the
      // node "Slot"/"Slot 2", so set the name explicitly to honor --name.
      const slot = component.createSlot(${JSON.stringify(slotName)});
      try { slot.name = ${JSON.stringify(slotName)}; } catch (e) {}

      // Apply frame properties to slot
      slot.layoutMode = frameProps.layoutMode;
      slot.itemSpacing = frameProps.itemSpacing;
      slot.paddingTop = frameProps.paddingTop;
      slot.paddingBottom = frameProps.paddingBottom;
      slot.paddingLeft = frameProps.paddingLeft;
      slot.paddingRight = frameProps.paddingRight;
      slot.fills = frameProps.fills;
      if (alignPrimary != null) { try { slot.primaryAxisAlignItems = alignPrimary; } catch (e) {} }
      if (alignCounter != null) { try { slot.counterAxisAlignItems = alignCounter; } catch (e) {} }
      slot.resize(frameProps.width, frameProps.height);
      slot.x = frameProps.x;
      slot.y = frameProps.y;

      // Move children to slot
      frameProps.children.forEach(child => {
        slot.appendChild(child);
      });

      // Restore the frame's position in its parent (preserve sibling order + nesting).
      try { origParent.insertChild(origIndex, slot); } catch (e) {}

      // Remove original frame
      frame.remove();

      // Restore auto-layout sizing so the slot hugs/fills like the frame did,
      // instead of staying a FIXED-height box that renders as a large void.
      if (sizeH) { try { slot.layoutSizingHorizontal = sizeH; } catch (e) {} }
      if (sizeV) { try { slot.layoutSizingVertical = sizeV; } catch (e) {} }

      // An empty slot should read as a compact drop zone, not a tall void.
${NORMALIZE_EMPTY_SLOT}

      return {
        success: true,
        slotId: slot.id,
        slotName: slot.name,
        componentName: component.name
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Converted frame to slot "${result.slotName}" in "${result.componentName}"`));
        console.log(chalk.gray(`  Slot ID: ${result.slotId}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

slot
  .command('add <nodeId>')
  .description('Add content to a slot in an instance')
  .option('-c, --component <componentId>', 'Component to instantiate')
  .option('-f, --frame', 'Add empty frame')
  .option('-t, --text <content>', 'Add text')
  .action(async (nodeId, options) => {
    await checkConnection();

    let addCode = '';
    if (options.component) {
      addCode = `
        const comp = await figma.getNodeByIdAsync(${JSON.stringify(options.component)});
        if (comp && comp.type === 'COMPONENT') {
          const inst = comp.createInstance();
          slot.appendChild(inst);
          added = { type: 'instance', name: inst.name };
        } else {
          return { error: 'Component not found' };
        }`;
    } else if (options.frame) {
      addCode = `
        const newFrame = figma.createFrame();
        newFrame.name = 'Content';
        newFrame.resize(100, 50);
        slot.appendChild(newFrame);
        added = { type: 'frame', name: newFrame.name };`;
    } else if (options.text) {
      addCode = `
        await figma.loadFontAsync({family:'Inter',style:'Regular'});
        const newText = figma.createText();
        newText.characters = ${JSON.stringify(options.text)};
        slot.appendChild(newText);
        added = { type: 'text', content: ${JSON.stringify(options.text)} };`;
    } else {
      console.log(chalk.red('✗ Specify --component, --frame, or --text'));
      return;
    }

    const code = `(async () => {
      const slot = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!slot) return { error: 'Node not found' };
      if (slot.type !== 'SLOT') return { error: 'Node is not a slot' };

      let added = null;
      ${addCode}

      return {
        success: true,
        slotName: slot.name,
        added,
        childCount: slot.children.length
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) {
        console.log(chalk.red('✗ ' + result.error));
      } else {
        console.log(chalk.green(`✓ Added ${result.added.type} to slot "${result.slotName}"`));
        console.log(chalk.gray(`  Children: ${result.childCount}`));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
    }
  });

