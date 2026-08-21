// Commands: create (extracted from index.js)
import chalk from 'chalk';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  progress,
  checkConnection,
  daemonExec,
  evalPrint,
  generateFillCode,
  generateStrokeCode,
  getVarName,
  isVarRef,
  program,
  smartPosCode,
  spinnerSucceed,
  varLoadingCode
} from '../lib/cli-core.js';

// ============ CREATE ============

const create = program
  .command('create')
  .description('Create Figma elements');

function childTarget(options) {
  const parentId = options.parent ? normalizeNodeId(String(options.parent)).id : null;
  const index = options.index === undefined ? null : Number(options.index);
  if (index !== null && (!Number.isInteger(index) || index < 0)) {
    throw new Error('--index must be a non-negative integer');
  }
  return { parentId, index };
}

function childTargetPrelude({ parentId, index }) {
  if (!parentId) return '';
  return `const __parent = await figma.getNodeByIdAsync(${JSON.stringify(parentId)});
if (!__parent) throw new Error('Parent not found: ' + ${JSON.stringify(parentId)});
if (typeof __parent.appendChild !== 'function') throw new Error('Target cannot contain children: ' + __parent.type);
${index === null ? '' : `if (${index} > __parent.children.length) throw new Error('Index out of range: ' + ${index});`}`;
}

function attachToChildTarget(nodeVar, { parentId, index }) {
  if (!parentId) return '';
  return index === null
    ? `__parent.appendChild(${nodeVar});`
    : `__parent.insertChild(${index}, ${nodeVar});`;
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`);
  }
  return number;
}

function positionCode({ target, useSmart, gap, explicitX }) {
  if (target.parentId) return `const smartX = ${explicitX === undefined ? 0 : explicitX};`;
  return useSmart ? smartPosCode(gap) : `const smartX = ${explicitX};`;
}

create
  .command('frame <name>')
  .description('Create a frame')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--smart', 'Auto-position to avoid overlaps (default if no -x)')
  .option('-g, --gap <n>', 'Gap for smart positioning', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (name, options) => {
    await checkConnection();
    const target = childTarget(options);
    const width = finiteNumber(options.width, '--width', { min: 0.01 });
    const height = finiteNumber(options.height, '--height', { min: 0.01 });
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const gap = finiteNumber(options.gap, '--gap', { min: 0 });
    const radius = options.radius === undefined ? null : finiteNumber(options.radius, '--radius', { min: 0 });
    const useSmartPos = options.smart || x === undefined;
    const usesVars = options.fill && isVarRef(options.fill);

    const fillCode = options.fill ? generateFillCode(options.fill, 'frame') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${childTargetPrelude(target)}
${positionCode({ target, useSmart: useSmartPos, gap, explicitX: x })}
const frame = figma.createFrame();
frame.name = ${JSON.stringify(name)};
frame.x = smartX;
frame.y = ${y};
frame.resize(${width}, ${height});
${fillCode ? fillCode.code : ''}
${radius === null ? '' : `frame.cornerRadius = ${radius};`}
${attachToChildTarget('frame', target)}
figma.currentPage.selection = [frame];
return ${JSON.stringify(name)} + ' created (' + frame.id + ') in ' + (frame.parent ? frame.parent.id : 'none') + ' at (' + frame.x + ', ' + frame.y + ')';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

// (create icon removed: it fetched artwork from an external icon CDN.
// The no-network build gets real icons from the Figma file via `export assets`.)

create
  .command('image <url>')
  .description('Create an image from URL (PNG, JPG, GIF, WebP)')
  .option('-w, --width <n>', 'Width (auto if not set)')
  .option('-h, --height <n>', 'Height (auto if not set)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-n, --name <name>', 'Node name', 'Image')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .action(async (url, options) => {
    await checkConnection();
    const spinner = progress('Loading image...').start();

    const code = `
(async () => {
  try {
    // Smart positioning
    let smartX = 0;
    if (${options.x === undefined}) {
      figma.currentPage.children.forEach(n => {
        smartX = Math.max(smartX, n.x + (n.width || 0));
      });
      smartX += ${options.spacing || 100};
    } else {
      smartX = ${options.x || 0};
    }

    // Create image from URL
    const image = await figma.createImageAsync("${url}");
    const { width, height } = await image.getSizeAsync();

    // Calculate dimensions
    let w = ${options.width || 'null'};
    let h = ${options.height || 'null'};
    if (w && !h) h = Math.round(height * (w / width));
    if (h && !w) w = Math.round(width * (h / height));
    if (!w && !h) { w = width; h = height; }

    // Create rectangle with image fill
    const rect = figma.createRectangle();
    rect.name = "${options.name}";
    rect.resize(w, h);
    rect.x = smartX;
    rect.y = ${options.y};
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];

    figma.currentPage.selection = [rect];
    figma.viewport.scrollAndZoomIntoView([rect]);

    return 'Image created: ' + w + 'x' + h + ' at (' + smartX + ', ${options.y})';
  } catch (e) {
    return 'Error: ' + e.message;
  }
})()
`;

    try {
      const result = evalPrint(code, { silent: true });
      spinnerSucceed(spinner, 'Image created from URL');
      if (result) console.log(chalk.gray(result.trim()));
    } catch (e) {
      spinner.fail('Failed to create image: ' + e.message);
    }
  });

// config.js continues to register subcommands on this group
export { create };

// ============ SHAPE PRIMITIVES ============
// (Moved here from commands/config.js, which defined `create` subcommands
// while importing the `create` group from this file.)

create
  .command('rect [name]')
  .alias('rectangle')
  .description('Create a rectangle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--opacity <n>', 'Opacity 0-1')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (name, options) => {
    await checkConnection();
    const rectName = name || 'Rectangle';
    const target = childTarget(options);
    const width = finiteNumber(options.width, '--width', { min: 0.01 });
    const height = finiteNumber(options.height, '--height', { min: 0.01 });
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const radius = options.radius === undefined ? null : finiteNumber(options.radius, '--radius', { min: 0 });
    const opacity = options.opacity === undefined ? null : finiteNumber(options.opacity, '--opacity', { min: 0, max: 1 });
    const useSmartPos = x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));

    const fillCode = generateFillCode(options.fill, 'rect');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'rect') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${childTargetPrelude(target)}
${positionCode({ target, useSmart: useSmartPos, gap: 100, explicitX: x })}
const rect = figma.createRectangle();
rect.name = ${JSON.stringify(rectName)};
rect.x = smartX;
rect.y = ${y};
rect.resize(${width}, ${height});
${fillCode.code}
${radius === null ? '' : `rect.cornerRadius = ${radius};`}
${opacity === null ? '' : `rect.opacity = ${opacity};`}
${strokeCode ? strokeCode.code : ''}
${attachToChildTarget('rect', target)}
figma.currentPage.selection = [rect];
return ${JSON.stringify(rectName)} + ' created (' + rect.id + ') in ' + (rect.parent ? rect.parent.id : 'none') + ' at (' + rect.x + ', ' + rect.y + ')';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('ellipse [name]')
  .alias('circle')
  .description('Create an ellipse/circle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width (diameter)', '100')
  .option('-h, --height <n>', 'Height (same as width for circle)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (name, options) => {
    await checkConnection();
    const ellipseName = name || 'Ellipse';
    const target = childTarget(options);
    const width = finiteNumber(options.width, '--width', { min: 0.01 });
    const height = finiteNumber(options.height === undefined ? options.width : options.height, '--height', { min: 0.01 });
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const useSmartPos = x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));

    const fillCode = generateFillCode(options.fill, 'ellipse');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'ellipse') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${childTargetPrelude(target)}
${positionCode({ target, useSmart: useSmartPos, gap: 100, explicitX: x })}
const ellipse = figma.createEllipse();
ellipse.name = ${JSON.stringify(ellipseName)};
ellipse.x = smartX;
ellipse.y = ${y};
ellipse.resize(${width}, ${height});
${fillCode.code}
${strokeCode ? strokeCode.code : ''}
${attachToChildTarget('ellipse', target)}
figma.currentPage.selection = [ellipse];
return ${JSON.stringify(ellipseName)} + ' created (' + ellipse.id + ') in ' + (ellipse.parent ? ellipse.parent.id : 'none') + ' at (' + ellipse.x + ', ' + ellipse.y + ')';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

function registerRadialPrimitive({ command, description, factory, defaultName, extraOptions = [], extraCode = () => '' }) {
  let primitive = create
    .command(`${command} [name]`)
    .description(description)
    .option('-w, --width <n>', 'Width', '100')
    .option('-h, --height <n>', 'Height', '100')
    .option('-x <n>', 'X position (auto if not set)')
    .option('-y <n>', 'Y position', '0')
    .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
    .option('--stroke <color>', 'Stroke color (hex or var:name)')
    .option('--parent <nodeId>', 'Create inside this existing parent')
    .option('--index <n>', 'Insert at this child index (default: append)');
  for (const option of extraOptions) primitive = primitive.option(...option);
  primitive.action(async (name, options) => {
    await checkConnection();
    const nodeName = name || defaultName;
    const target = childTarget(options);
    const width = finiteNumber(options.width, '--width', { min: 0.01 });
    const height = finiteNumber(options.height, '--height', { min: 0.01 });
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const useSmartPos = x === undefined;
    const usesVars = isVarRef(options.fill) || (options.stroke && isVarRef(options.stroke));
    const fillCode = generateFillCode(options.fill, 'shape');
    const strokeCode = options.stroke ? generateStrokeCode(options.stroke, 'shape') : null;
    const customCode = extraCode(options, finiteNumber);
    const code = `(async () => {
${usesVars ? varLoadingCode() : ''}
${childTargetPrelude(target)}
${positionCode({ target, useSmart: useSmartPos, gap: 100, explicitX: x })}
const shape = figma.${factory}();
shape.name = ${JSON.stringify(nodeName)};
shape.x = smartX;
shape.y = ${y};
shape.resize(${width}, ${height});
${customCode}
${fillCode.code}
${strokeCode ? strokeCode.code : ''}
${attachToChildTarget('shape', target)}
figma.currentPage.selection = [shape];
return { id: shape.id, name: shape.name, type: shape.type, parentId: shape.parent ? shape.parent.id : null };
})()`;
    const result = await daemonExec('eval', { code });
    console.log(chalk.green('✓'), `${result.type} "${result.name}" created (${result.id}) in ${result.parentId}`);
  });
}

registerRadialPrimitive({
  command: 'polygon',
  description: 'Create a regular polygon',
  factory: 'createPolygon',
  defaultName: 'Polygon',
  extraOptions: [['--points <n>', 'Number of sides (3 or more)', '3']],
  extraCode: (options, number) => {
    const points = number(options.points, '--points', { min: 3 });
    if (!Number.isInteger(points)) throw new Error('--points must be an integer');
    return `shape.pointCount = ${points};`;
  },
});

registerRadialPrimitive({
  command: 'star',
  description: 'Create a star',
  factory: 'createStar',
  defaultName: 'Star',
  extraOptions: [
    ['--points <n>', 'Number of outer points (3 or more)', '5'],
    ['--inner-radius <n>', 'Inner radius from 0 to 1', '0.382'],
  ],
  extraCode: (options, number) => {
    const points = number(options.points, '--points', { min: 3 });
    if (!Number.isInteger(points)) throw new Error('--points must be an integer');
    const innerRadius = number(options.innerRadius, '--inner-radius', { min: 0, max: 1 });
    return `shape.pointCount = ${points}; shape.innerRadius = ${innerRadius};`;
  },
});

create
  .command('vector [name]')
  .description('Create an empty vector, optionally with a validated VectorNetwork JSON value')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--network <json>', 'Figma VectorNetwork JSON')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (name, options) => {
    await checkConnection();
    const nodeName = name || 'Vector';
    const target = childTarget(options);
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    let network = null;
    if (options.network !== undefined) {
      try { network = JSON.parse(options.network); }
      catch (error) { throw new Error(`--network must be valid JSON: ${error.message}`); }
      if (!network || !Array.isArray(network.vertices) || !Array.isArray(network.segments)) {
        throw new Error('--network must contain vertices and segments arrays');
      }
    }
    const code = `(async () => {
${childTargetPrelude(target)}
${positionCode({ target, useSmart: x === undefined, gap: 100, explicitX: x })}
const vector = figma.createVector();
vector.name = ${JSON.stringify(nodeName)};
${network ? `await vector.setVectorNetworkAsync(${JSON.stringify(network)});` : ''}
vector.x = smartX;
vector.y = ${y};
${attachToChildTarget('vector', target)}
figma.currentPage.selection = [vector];
return { id: vector.id, name: vector.name, type: vector.type, parentId: vector.parent ? vector.parent.id : null };
})()`;
    const result = await daemonExec('eval', { code });
    console.log(chalk.green('✓'), `VECTOR "${result.name}" created (${result.id}) in ${result.parentId}`);
  });

create
  .command('slice [name]')
  .description('Create an export slice')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (name, options) => {
    await checkConnection();
    const nodeName = name || 'Slice';
    const target = childTarget(options);
    const width = finiteNumber(options.width, '--width', { min: 0.01 });
    const height = finiteNumber(options.height, '--height', { min: 0.01 });
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const code = `(async () => {
${childTargetPrelude(target)}
${positionCode({ target, useSmart: x === undefined, gap: 100, explicitX: x })}
const slice = figma.createSlice();
slice.name = ${JSON.stringify(nodeName)};
slice.x = smartX;
slice.y = ${y};
slice.resize(${width}, ${height});
${attachToChildTarget('slice', target)}
figma.currentPage.selection = [slice];
return { id: slice.id, name: slice.name, type: slice.type, parentId: slice.parent ? slice.parent.id : null };
})()`;
    const result = await daemonExec('eval', { code });
    console.log(chalk.green('✓'), `SLICE "${result.name}" created (${result.id}) in ${result.parentId}`);
  });

create
  .command('text <content>')
  .description('Create a text layer (smart positions by default)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .option('-c, --color <color>', 'Text color (hex or var:name)', '#000000')
  .option('-w, --weight <weight>', 'Font weight: regular, medium, semibold, bold', 'regular')
  .option('--font <family>', 'Font family', 'Inter')
  .option('--width <n>', 'Text box width (auto-width if not set)')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (content, options) => {
    await checkConnection();
    const weightMap = { regular: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' };
    const fontStyle = weightMap[options.weight.toLowerCase()] || 'Regular';
    const target = childTarget(options);
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const size = finiteNumber(options.size, '--size', { min: 0.01 });
    const width = options.width === undefined ? null : finiteNumber(options.width, '--width', { min: 0.01 });
    const spacing = finiteNumber(options.spacing, '--spacing', { min: 0 });
    const useSmartPos = x === undefined;
    const usesVars = isVarRef(options.color);

    const fillCode = generateFillCode(options.color, 'text');

    let code = `
(async function() {
  ${usesVars ? varLoadingCode() : ''}
  ${childTargetPrelude(target)}
  ${positionCode({ target, useSmart: useSmartPos, gap: spacing, explicitX: x })}
  await figma.loadFontAsync({ family: ${JSON.stringify(options.font)}, style: ${JSON.stringify(fontStyle)} });
  const text = figma.createText();
  text.fontName = { family: ${JSON.stringify(options.font)}, style: ${JSON.stringify(fontStyle)} };
  text.characters = ${JSON.stringify(content)};
  text.fontSize = ${size};
  ${fillCode.code}
  text.x = smartX;
  text.y = ${y};
  ${width === null ? '' : `text.resize(${width}, text.height); text.textAutoResize = 'HEIGHT';`}
  ${attachToChildTarget('text', target)}
  figma.currentPage.selection = [text];
  return 'Text created (' + text.id + ') in ' + (text.parent ? text.parent.id : 'none') + ' at (' + text.x + ', ' + text.y + ')';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('line')
  .description('Create a line (smart positions by default)')
  .option('--x1 <n>', 'Start X (auto if not set)')
  .option('--y1 <n>', 'Start Y', '0')
  .option('--x2 <n>', 'End X (auto + length if x1 not set)')
  .option('--y2 <n>', 'End Y', '0')
  .option('-l, --length <n>', 'Line length', '100')
  .option('-c, --color <color>', 'Line color (hex or var:name)', '#000000')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (options) => {
    await checkConnection();
    const target = childTarget(options);
    const x1 = options.x1 === undefined ? undefined : finiteNumber(options.x1, '--x1');
    const y1 = finiteNumber(options.y1, '--y1');
    const x2 = options.x2 === undefined ? null : finiteNumber(options.x2, '--x2');
    const y2 = finiteNumber(options.y2, '--y2');
    const lineLength = finiteNumber(options.length, '--length', { min: 0.01 });
    const strokeWeight = finiteNumber(options.weight, '--weight', { min: 0 });
    const spacing = finiteNumber(options.spacing, '--spacing', { min: 0 });
    const useSmartPos = x1 === undefined;
    const usesVars = isVarRef(options.color);

    const strokeCode = generateStrokeCode(options.color, 'line', strokeWeight);
    const renderedLength = x1 !== undefined && x2 !== null ? Math.abs(x2 - x1) || lineLength : lineLength;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${childTargetPrelude(target)}
${positionCode({ target, useSmart: useSmartPos, gap: spacing, explicitX: x1 })}
const line = figma.createLine();
line.x = smartX;
line.y = ${y1};
line.resize(${renderedLength}, 0);
${x1 !== undefined && x2 !== null ? `line.rotation = Math.atan2(${y2} - ${y1}, ${x2} - ${x1}) * 180 / Math.PI;` : ''}
${strokeCode.code}
${attachToChildTarget('line', target)}
figma.currentPage.selection = [line];
return 'Line created (' + line.id + ') in ' + (line.parent ? line.parent.id : 'none') + ' with length ${renderedLength}';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });

create
  .command('component [name]')
  .description('Convert selection to component')
  .action(async (name) => {
    await checkConnection();
    const compName = name || 'Component';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else if (sel.length === 1) {
  const comp = figma.createComponentFromNode(sel[0]);
  comp.name = ${JSON.stringify(compName)};
  figma.currentPage.selection = [comp];
  'Component created: ' + comp.name;
} else {
  const group = figma.group(sel, figma.currentPage);
  const comp = figma.createComponentFromNode(group);
  comp.name = ${JSON.stringify(compName)};
  figma.currentPage.selection = [comp];
  'Component created from ' + sel.length + ' elements: ' + comp.name;
}
`;
    evalPrint(code);
  });

create
  .command('group [name]')
  .description('Group current selection')
  .action(async (name) => {
    await checkConnection();
    const groupName = name || 'Group';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length < 2) 'Select 2+ elements to group';
else {
  const group = figma.group(sel, figma.currentPage);
  group.name = ${JSON.stringify(groupName)};
  figma.currentPage.selection = [group];
  'Grouped ' + sel.length + ' elements';
}
`;
    evalPrint(code);
  });

create
  .command('autolayout [name]')
  .alias('al')
  .description('Create an auto-layout frame (smart positions by default)')
  .option('-d, --direction <dir>', 'Direction: row, col', 'row')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Padding', '16')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .action(async (name, options) => {
    await checkConnection();
    const frameName = name || 'Auto Layout';
    const layoutMode = options.direction === 'col' ? 'VERTICAL' : 'HORIZONTAL';
    const target = childTarget(options);
    const gap = finiteNumber(options.gap, '--gap', { min: 0 });
    const padding = finiteNumber(options.padding, '--padding', { min: 0 });
    const x = options.x === undefined ? undefined : finiteNumber(options.x, '-x');
    const y = finiteNumber(options.y, '-y');
    const radius = options.radius === undefined ? null : finiteNumber(options.radius, '--radius', { min: 0 });
    const spacing = finiteNumber(options.spacing, '--spacing', { min: 0 });
    const useSmartPos = x === undefined;
    const usesVars = options.fill && isVarRef(options.fill);

    const fillCode = options.fill ? generateFillCode(options.fill, 'frame') : null;

    let code = `
(async () => {
${usesVars ? varLoadingCode() : ''}
${childTargetPrelude(target)}
${positionCode({ target, useSmart: useSmartPos, gap: spacing, explicitX: x })}
const frame = figma.createFrame();
frame.name = ${JSON.stringify(frameName)};
frame.x = smartX;
frame.y = ${y};
frame.layoutMode = '${layoutMode}';
frame.primaryAxisSizingMode = 'AUTO';
frame.counterAxisSizingMode = 'AUTO';
frame.itemSpacing = ${gap};
frame.paddingTop = ${padding};
frame.paddingRight = ${padding};
frame.paddingBottom = ${padding};
frame.paddingLeft = ${padding};
${fillCode ? fillCode.code : 'frame.fills = [];'}
${radius === null ? '' : `frame.cornerRadius = ${radius};`}
${attachToChildTarget('frame', target)}
figma.currentPage.selection = [frame];
return 'Auto-layout frame created (' + frame.id + ') in ' + (frame.parent ? frame.parent.id : 'none') + ' at (' + frame.x + ', ' + frame.y + ')';
})()
`;
    const result = await daemonExec('eval', { code });
    console.log(result);
  });
