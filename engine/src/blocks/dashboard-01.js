// Dashboard-01: Analytics dashboard with sidebar, stats, chart and data table
// Combines JSX template (sidebar with icons) + JS code (table, chart)
// Uses shadcn variable bindings (var:) for all colors - supports Light/Dark mode

// JSX template for the sidebar - uses Icon components for real Lucide icons
export const sidebarJsx = `
<Frame name="Dashboard" w={1440} h={820} flex="row" bg="var:background">
  <Frame name="Sidebar" w={260} h="fill" flex="col" bg="var:muted" stroke="var:border" strokeWidth={1} strokeAlign="inside">
    <Frame name="Logo" flex="row" gap={10} items="center" p={20} pb={8} w="fill">
      <Frame w={28} h={28} bg="var:foreground" rounded={6} />
      <Text size={15} weight="semibold" color="var:foreground">Acme Inc</Text>
    </Frame>
    <Frame name="Main Nav" flex="col" gap={2} px={12} py={8} w="fill">
      <Frame name="Nav-Dashboard" flex="row" gap={10} items="center" px={12} py={8} rounded={8} bg="var:accent" w="fill">
        <Icon name="lucide:layout-dashboard" size={18} color="var:foreground" />
        <Text size={14} weight="medium" color="var:foreground" w="fill">Dashboard</Text>
      </Frame>
      <Frame name="Nav-Lifecycle" flex="row" gap={10} items="center" px={12} py={8} rounded={8} w="fill">
        <Icon name="lucide:refresh-cw" size={18} color="var:muted-foreground" />
        <Text size={14} color="var:muted-foreground" w="fill">Lifecycle</Text>
      </Frame>
      <Frame name="Nav-Analytics" flex="row" gap={10} items="center" px={12} py={8} rounded={8} w="fill">
        <Icon name="lucide:bar-chart-3" size={18} color="var:muted-foreground" />
        <Text size={14} color="var:muted-foreground" w="fill">Analytics</Text>
      </Frame>
      <Frame name="Nav-Projects" flex="row" gap={10} items="center" px={12} py={8} rounded={8} w="fill">
        <Icon name="lucide:folder" size={18} color="var:muted-foreground" />
        <Text size={14} color="var:muted-foreground" w="fill">Projects</Text>
      </Frame>
      <Frame name="Nav-Team" flex="row" gap={10} items="center" px={12} py={8} rounded={8} w="fill">
        <Icon name="lucide:users" size={18} color="var:muted-foreground" />
        <Text size={14} color="var:muted-foreground" w="fill">Team</Text>
      </Frame>
    </Frame>
    <Frame name="Section Label" px={24} py={8} w="fill">
      <Text size={12} color="var:muted-foreground">Documents</Text>
    </Frame>
    <Frame name="Doc Nav" flex="col" gap={2} px={12} w="fill">
      <Frame flex="row" gap={10} items="center" px={12} py={6} w="fill">
        <Icon name="lucide:file-text" size={16} color="var:muted-foreground" />
        <Text size={13} color="var:muted-foreground" w="fill">Data Library</Text>
      </Frame>
      <Frame flex="row" gap={10} items="center" px={12} py={6} w="fill">
        <Icon name="lucide:file-bar-chart" size={16} color="var:muted-foreground" />
        <Text size={13} color="var:muted-foreground" w="fill">Reports</Text>
      </Frame>
      <Frame flex="row" gap={10} items="center" px={12} py={6} w="fill">
        <Icon name="lucide:file-check" size={16} color="var:muted-foreground" />
        <Text size={13} color="var:muted-foreground" w="fill">Word Assistant</Text>
      </Frame>
    </Frame>
    <Frame name="User" flex="row" gap={10} items="center" px={20} py={16} w="fill" stroke="var:border" strokeWidth={1} strokeAlign="inside">
      <Frame w={32} h={32} bg="var:border" rounded={16} />
      <Frame flex="col" gap={2} grow={1}>
        <Text size={13} weight="medium" color="var:foreground">Sofia Davis</Text>
        <Text size={11} color="var:muted-foreground">sofia@acme.com</Text>
      </Frame>
      <Icon name="lucide:chevrons-up-down" size={16} color="var:muted-foreground" />
    </Frame>
  </Frame>
</Frame>
`.trim();

// JS code for main content (header, stats, chart, table)
// Uses variable binding for all colors
export function getMainContentCode(dashboardNodeId) {
  return `(async function() {
  var dashboard = await figma.getNodeByIdAsync('${dashboardNodeId}');
  if (!dashboard) return 'Dashboard not found';

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  // Load shadcn variables for binding
  var collections = await figma.variables.getLocalVariableCollectionsAsync();
  var shadcnCollections = collections.filter(function(c) { return c.name.startsWith('shadcn'); });
  var varCache = {};

  for (var ci = 0; ci < shadcnCollections.length; ci++) {
    var col = shadcnCollections[ci];
    for (var vi = 0; vi < col.variableIds.length; vi++) {
      var v = await figma.variables.getVariableByIdAsync(col.variableIds[vi]);
      if (v) varCache[v.name] = v;
    }
  }

  var hasVars = Object.keys(varCache).length > 0;

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }

  // Bind a fill to a variable, with hex fallback
  function bindFill(node, varName, fallbackHex) {
    if (hasVars && varCache[varName]) {
      var paint = { type: 'SOLID', color: hexToRgb(fallbackHex) };
      var bound = figma.variables.setBoundVariableForPaint(paint, 'color', varCache[varName]);
      node.fills = [bound];
    } else {
      node.fills = [{ type: 'SOLID', color: hexToRgb(fallbackHex) }];
    }
  }

  function bindStroke(node, varName, fallbackHex) {
    if (hasVars && varCache[varName]) {
      var paint = { type: 'SOLID', color: hexToRgb(fallbackHex) };
      var bound = figma.variables.setBoundVariableForPaint(paint, 'color', varCache[varName]);
      node.strokes = [bound];
    } else {
      node.strokes = [{ type: 'SOLID', color: hexToRgb(fallbackHex) }];
    }
  }

  function bindTextFill(node, varName, fallbackHex) {
    if (hasVars && varCache[varName]) {
      var paint = { type: 'SOLID', color: hexToRgb(fallbackHex) };
      var bound = figma.variables.setBoundVariableForPaint(paint, 'color', varCache[varName]);
      node.fills = [bound];
    } else {
      node.fills = [{ type: 'SOLID', color: hexToRgb(fallbackHex) }];
    }
  }

  function f(props) {
    var frame = figma.createFrame();
    frame.fills = [];
    if (props.bg) bindFill(frame, props.bg, props.bgFallback || '#ffffff');
    if (props.name) frame.name = props.name;
    if (props.layout) {
      frame.layoutMode = props.layout;
      frame.primaryAxisSizingMode = 'AUTO';
      frame.counterAxisSizingMode = 'AUTO';
    }
    if (props.gap !== undefined) frame.itemSpacing = props.gap;
    if (props.p !== undefined) frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = props.p;
    if (props.px !== undefined) { frame.paddingLeft = frame.paddingRight = props.px; }
    if (props.py !== undefined) { frame.paddingTop = frame.paddingBottom = props.py; }
    if (props.w !== undefined) frame.resize(props.w, frame.height);
    if (props.h !== undefined) frame.resize(frame.width, props.h);
    if (props.rounded !== undefined) frame.cornerRadius = props.rounded;
    if (props.stroke) {
      bindStroke(frame, props.stroke, props.strokeFallback || '#e4e4e7');
      frame.strokeWeight = props.strokeWeight || 1;
      frame.strokeAlign = 'INSIDE';
    }
    if (props.clip) frame.clipsContent = true;
    return frame;
  }

  function txt(str, props) {
    var t = figma.createText();
    t.fontName = { family: 'Inter', style: props.style || 'Regular' };
    t.characters = str;
    t.fontSize = props.size || 14;
    bindTextFill(t, props.color, props.colorFallback || '#18181b');
    if (props.name) t.name = props.name;
    return t;
  }

  // Fix sidebar: left-align everything + spacer for user at bottom
  var sidebar = dashboard.children.find(function(n) { return n.name === 'Sidebar'; });
  if (sidebar) {
    sidebar.counterAxisAlignItems = 'MIN';
    sidebar.layoutSizingVertical = 'FILL';
    for (var si = 0; si < sidebar.children.length; si++) {
      var sc = sidebar.children[si];
      if (sc.name === 'Logo') sc.layoutSizingHorizontal = 'FILL';
      if (sc.name === 'Section Label') sc.primaryAxisAlignItems = 'MIN';
      if (sc.name === 'Main Nav' || sc.name === 'Doc Nav') {
        sc.counterAxisAlignItems = 'MIN';
        sc.primaryAxisAlignItems = 'MIN';
      }
    }
    var user = sidebar.children.find(function(n) { return n.name === 'User'; });
    if (user) {
      var spacer = figma.createFrame();
      spacer.name = 'Spacer';
      spacer.fills = [];
      spacer.layoutMode = 'VERTICAL';
      var idx = sidebar.children.indexOf(user);
      sidebar.insertChild(idx, spacer);
      spacer.layoutSizingHorizontal = 'FILL';
      spacer.layoutGrow = 1;
    }
  }

  // Main content area
  var main = f({ name: 'Main Content', layout: 'VERTICAL', gap: 0, bg: 'background', bgFallback: '#ffffff' });
  dashboard.appendChild(main);
  main.layoutSizingHorizontal = 'FILL';
  main.layoutSizingVertical = 'FILL';

  // Header
  var header = f({ name: 'Header', layout: 'HORIZONTAL', gap: 16, px: 32, py: 20, stroke: 'border', strokeFallback: '#e4e4e7' });
  main.appendChild(header);
  header.layoutSizingHorizontal = 'FILL';
  header.counterAxisAlignItems = 'CENTER';
  header.appendChild(txt('Documents', { size: 20, style: 'Semi Bold', color: 'foreground', colorFallback: '#18181b' }));

  // Stats Row
  var statsRow = f({ name: 'Stats Row', layout: 'HORIZONTAL', gap: 16, px: 24, py: 16 });
  main.appendChild(statsRow);
  statsRow.layoutSizingHorizontal = 'FILL';

  var stats = [
    { label: 'Total Revenue', value: '$1,250.00', change: '+12.5%', up: true },
    { label: 'New Customers', value: '1,234', change: '-20%', up: false },
    { label: 'Active Accounts', value: '45,678', change: '+12.5%', up: true },
    { label: 'Growth Rate', value: '4.5%', change: '+4.5%', up: true }
  ];

  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    var card = f({ name: s.label, layout: 'VERTICAL', gap: 8, p: 20, rounded: 12, bg: 'card', bgFallback: '#ffffff', stroke: 'border', strokeFallback: '#e4e4e7' });
    statsRow.appendChild(card);
    card.layoutSizingHorizontal = 'FILL';
    card.appendChild(txt(s.label, { size: 13, style: 'Medium', color: 'muted-foreground', colorFallback: '#71717a' }));
    var vr = f({ name: 'Value Row', layout: 'HORIZONTAL', gap: 8 });
    card.appendChild(vr);
    vr.layoutSizingHorizontal = 'FILL';
    vr.counterAxisAlignItems = 'MAX';
    vr.appendChild(txt(s.value, { size: 28, style: 'Bold', color: 'card-foreground', colorFallback: '#18181b' }));
    vr.appendChild(txt((s.up ? '\\u2191 ' : '\\u2193 ') + s.change, { size: 12, color: s.up ? '#16a34a' : '#dc2626', colorFallback: s.up ? '#16a34a' : '#dc2626', style: 'Medium' }));
  }

  // Chart Card
  var chartWrap = f({ name: 'Chart Wrapper', layout: 'VERTICAL', gap: 0, px: 24 });
  main.appendChild(chartWrap);
  chartWrap.layoutSizingHorizontal = 'FILL';

  var chartCard = f({ name: 'Chart Card', layout: 'VERTICAL', gap: 12, p: 20, rounded: 12, bg: 'card', bgFallback: '#ffffff', stroke: 'border', strokeFallback: '#e4e4e7' });
  chartWrap.appendChild(chartCard);
  chartCard.layoutSizingHorizontal = 'FILL';
  chartCard.appendChild(txt('Total Visitors', { size: 16, style: 'Semi Bold', color: 'card-foreground', colorFallback: '#18181b' }));
  chartCard.appendChild(txt('Showing total visitors for the last 3 months', { size: 13, color: 'muted-foreground', colorFallback: '#a1a1aa' }));

  // SVG Area Chart
  var cW = 1100, cH = 180;
  var d1 = [40, 85, 55, 120, 90, 145];
  var d2 = [20, 50, 35, 75, 55, 95];
  var maxV = 160;

  function toPoints(data) {
    var pts = [];
    for (var j = 0; j < data.length; j++) {
      pts.push(Math.round(j * cW / (data.length - 1)) + ',' + Math.round(cH - (data[j] / maxV) * cH));
    }
    return pts;
  }

  function toLine(pts) { return 'M ' + pts.join(' L '); }
  function toArea(pts) { return toLine(pts) + ' L ' + cW + ',' + cH + ' L 0,' + cH + ' Z'; }

  var p1 = toPoints(d1), p2 = toPoints(d2);
  var grid = '';
  for (var g = 0; g < 5; g++) {
    var gy = Math.round(g / 4 * cH);
    grid += '<line x1="0" y1="' + gy + '" x2="' + cW + '" y2="' + gy + '" stroke="#e4e4e7" stroke-width="1" stroke-dasharray="4,4"/>';
  }

  var svg = '<svg width="' + cW + '" height="' + cH + '" xmlns="http://www.w3.org/2000/svg">' + grid +
    '<path d="' + toArea(p1) + '" fill="rgba(59,130,246,0.15)"/>' +
    '<path d="' + toLine(p1) + '" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="' + toArea(p2) + '" fill="rgba(139,92,246,0.12)"/>' +
    '<path d="' + toLine(p2) + '" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linejoin="round"/>' +
    p1.map(function(p) { var xy = p.split(','); return '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="3" fill="#3b82f6"/>'; }).join('') +
    p2.map(function(p) { var xy = p.split(','); return '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="3" fill="#8b5cf6"/>'; }).join('') +
    '</svg>';

  var svgNode = figma.createNodeFromSvg(svg);
  svgNode.name = 'Area Chart';
  chartCard.appendChild(svgNode);
  svgNode.layoutSizingHorizontal = 'FILL';

  // X-axis labels
  var xAxis = f({ name: 'X Axis', layout: 'HORIZONTAL' });
  chartCard.appendChild(xAxis);
  xAxis.layoutSizingHorizontal = 'FILL';
  xAxis.primaryAxisAlignItems = 'SPACE_BETWEEN';
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].forEach(function(m) {
    xAxis.appendChild(txt(m, { size: 12, color: 'muted-foreground', colorFallback: '#a1a1aa' }));
  });

  // Data Table
  var tableWrap = f({ name: 'Table Wrapper', layout: 'VERTICAL', gap: 0, px: 24, py: 8 });
  main.appendChild(tableWrap);
  tableWrap.layoutSizingHorizontal = 'FILL';

  var table = f({ name: 'Data Table', layout: 'VERTICAL', gap: 0, rounded: 12, bg: 'card', bgFallback: '#ffffff', stroke: 'border', strokeFallback: '#e4e4e7', clip: true });
  tableWrap.appendChild(table);
  table.layoutSizingHorizontal = 'FILL';

  function makeRow(cells, isHeader) {
    var row = f({
      name: isHeader ? 'Table Header' : 'Row',
      layout: 'HORIZONTAL', gap: 0, px: 16, py: 10,
      bg: isHeader ? 'muted' : undefined,
      bgFallback: '#fafafa',
      stroke: 'border', strokeFallback: '#f4f4f5'
    });
    table.appendChild(row);
    row.layoutSizingHorizontal = 'FILL';
    row.counterAxisAlignItems = 'CENTER';

    // Checkbox
    var chk = f({ name: 'Checkbox', w: 18, h: 18, rounded: 4, stroke: 'border', strokeFallback: '#d4d4d8' });
    row.appendChild(chk);
    row.appendChild(f({ w: 16, h: 1 }));

    for (var j = 0; j < cells.length; j++) {
      var style = isHeader ? 'Medium' : (j === 0 ? 'Medium' : 'Regular');
      var varName = isHeader ? 'muted-foreground' : (j === 0 ? 'foreground' : 'muted-foreground');
      var fallback = isHeader ? '#71717a' : (j === 0 ? '#18181b' : '#71717a');
      var cell = txt(cells[j], { size: 13, color: varName, colorFallback: fallback, style: style });
      row.appendChild(cell);
      if (j === 0) {
        cell.layoutSizingHorizontal = 'FILL';
      } else {
        cell.resize(90, cell.height);
      }
    }
    return row;
  }

  makeRow(['Header', 'Type', 'Status', 'Target', 'Limit', 'Reviewer'], true);
  makeRow(['Cover page', 'Introduction', 'Done', '80', '100', 'Eddie Lake'], false);
  makeRow(['Table of contents', 'Narrative', 'In Process', '120', '150', 'Jamik Tashian'], false);
  makeRow(['Executive summary', 'Technical', 'Done', '60', '80', 'Emily Zhang'], false);
  makeRow(['Technical approach', 'Technical', 'Done', '100', '120', 'Alex Rivera'], false);
  makeRow(['Design system', 'Design', 'In Process', '90', '110', 'Jordan Lee'], false);

  // Footer
  var footer = f({ name: 'Table Footer', layout: 'HORIZONTAL', gap: 8, px: 16, py: 10, bg: 'muted', bgFallback: '#fafafa' });
  table.appendChild(footer);
  footer.layoutSizingHorizontal = 'FILL';
  footer.counterAxisAlignItems = 'CENTER';
  footer.primaryAxisAlignItems = 'SPACE_BETWEEN';

  footer.appendChild(txt('Showing 5 of 20 rows', { size: 12, color: 'muted-foreground', colorFallback: '#a1a1aa' }));

  var btnGroup = f({ name: 'Buttons', layout: 'HORIZONTAL', gap: 8 });
  footer.appendChild(btnGroup);

  var prev = f({ name: 'Prev', layout: 'HORIZONTAL', px: 12, py: 6, rounded: 6, stroke: 'border', strokeFallback: '#e4e4e7' });
  btnGroup.appendChild(prev);
  prev.counterAxisAlignItems = 'CENTER';
  prev.appendChild(txt('Previous', { size: 12, color: 'muted-foreground', colorFallback: '#71717a', style: 'Medium' }));

  var next = f({ name: 'Next', layout: 'HORIZONTAL', px: 12, py: 6, rounded: 6, stroke: 'border', strokeFallback: '#e4e4e7' });
  btnGroup.appendChild(next);
  next.counterAxisAlignItems = 'CENTER';
  next.appendChild(txt('Next', { size: 12, color: 'muted-foreground', colorFallback: '#71717a', style: 'Medium' }));

  return { id: dashboard.id, name: dashboard.name, variables: hasVars ? 'bound' : 'fallback' };
})()`;
}

// Main create function - called by the blocks command
export async function dashboard01(context) {
  const { renderJsx, evalFile, writeTemp } = context;

  // Step 1: Render sidebar with JSX (gets real Lucide icons + var: bindings)
  const result = await renderJsx(sidebarJsx);
  const dashboardId = result.id;

  // Step 2: Add main content via eval (tables, charts, data-driven + var bindings)
  const code = getMainContentCode(dashboardId);
  const tmpFile = writeTemp('dashboard-main.js', code);
  await evalFile(tmpFile);

  return dashboardId;
}
