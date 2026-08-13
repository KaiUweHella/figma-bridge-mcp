import { getBuiltinIconSvg } from './builtin-icons.js';
import {
  CSS_FIGMA_BOUNDARY_STRATEGIES as STRATEGY,
  cssFigmaFallbackAnnotationIntent,
} from './css-figma-boundary-policy.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const px = (value, fallback = 0) => finite(String(value ?? '').replace(/px$/, ''), fallback);
const camel = (value) => String(value).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function splitTracks(value) {
  const source = String(value || '').trim();
  if (!source || source === 'none') return [];
  const out = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= source.length; index++) {
    const char = source[index];
    if (char === '(') depth++;
    if (char === ')') depth--;
    if ((/\s/.test(char || '') || index === source.length) && depth === 0) {
      const token = source.slice(start, index).trim();
      if (token) out.push(token);
      start = index + 1;
    }
  }
  return out.flatMap((token) => {
    const repeat = token.match(/^repeat\((\d+)\s*,\s*(.+)\)$/i);
    return repeat ? Array.from({ length: Number(repeat[1]) }, () => repeat[2].trim()) : [token];
  });
}

/** Return only top-level CSS functions. Function arguments may themselves
 * contain functions (notably rgb()/rgba() inside drop-shadow()). */
function topLevelCssFunctions(value) {
  const source = String(value || '');
  const names = [];
  for (let index = 0; index < source.length;) {
    while (/\s/.test(source[index] || '')) index++;
    const match = source.slice(index).match(/^([a-z-]+)\(/i);
    if (!match) break;
    names.push(match[1].toLowerCase());
    index += match[0].length;
    let depth = 1;
    while (index < source.length && depth > 0) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')') depth--;
      index++;
    }
  }
  return names;
}

function track(token, measured, diagnostics, path, axis) {
  const value = String(token || '').trim();
  if (/^-?[\d.]+px$/.test(value)) return { kind: 'fixed', value: px(value), source: value };
  const fraction = value.match(/^([\d.]+)fr$/i);
  if (fraction && Number(fraction[1]) > 0) {
    return { kind: 'flex', value: Number(fraction[1]), source: value };
  }
  if (/^(auto|max-content|min-content)$/.test(value)) return { kind: 'hug', source: value };
  const minmax = value.match(/^minmax\((.+),\s*([\d.]+fr)\)$/i);
  if (minmax) {
    const minimum = /^([\d.]+)px$/i.test(minmax[1].trim()) ? px(minmax[1].trim()) : null;
    const weight = Number(minmax[2].replace(/fr$/i, '')) || 1;
    diagnostics.classifiedFallbacks.push({
      path,
      fact: `${axis} track ${value}`,
      fallback: STRATEGY.minmax,
      ...(minimum === null ? {} : { minimum }),
      minimumEnforced: false,
    });
    return { kind: 'flex', value: weight, source: value, minimum, fallback: 'minmax' };
  }
  diagnostics.classifiedFallbacks.push({ path, fact: `${axis} track ${value || 'unknown'}`, fallback: 'measured-fixed-track' });
  return { kind: 'fixed', value: Math.max(1, finite(measured, 1)), source: value, fallback: 'measured' };
}

function parseTracks(authored, computed, measuredSizes, diagnostics, path, axis) {
  const sourceTracks = splitTracks(authored).length ? splitTracks(authored) : splitTracks(computed);
  return sourceTracks.map((value, index) => track(value, measuredSizes[index], diagnostics, path, axis));
}

const align = (value) => ({
  'flex-start': 'start', start: 'start', normal: 'start', stretch: 'stretch',
  center: 'center', 'flex-end': 'end', end: 'end', 'space-between': 'between',
})[String(value || '')] || 'start';

function tokenReference(value) {
  const match = String(value || '').match(/var\(\s*--([a-zA-Z0-9_-]+)/);
  return match ? match[1].replace(/-/g, '/') : null;
}

function nodeName(node) {
  return String(node?.classes || node?.aria || node?.tag || 'element').trim().replace(/\s+/g, '.') || 'element';
}

function classifyPerSideBorders(source, diagnostics, path) {
  const values = ['Top', 'Right', 'Bottom', 'Left']
    .map((side) => String(source.style?.[`border${side}`] || '').trim())
    .filter((value) => value && !/^0(?:px)?\s|\bnone\b/.test(value));
  if (values.length < 2 || new Set(values).size < 2) return null;
  if (values.every((value) => /\bsolid\b/.test(value))) {
    const finding = { path, fact: 'different border paints/widths per side', fallback: STRATEGY.perSideBorderPaints };
    diagnostics.classifiedFallbacks.push(finding);
    return finding;
  } else {
    diagnostics.unclassifiedFallbacks.push({ path, fact: 'different non-solid border styles per side' });
  }
  return null;
}

function isSingleSupportedGradient(value) {
  const source = String(value || '').trim();
  const match = source.match(/^(linear|radial)-gradient\s*\(/i);
  if (!match) return false;
  let depth = 1;
  let index = match[0].length;
  while (index < source.length && depth > 0) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')') depth--;
    index++;
  }
  return depth === 0 && source.slice(index).trim() === '';
}

function classifyPaintBoundaries(source, diagnostics, path) {
  const backgroundImage = String(source.style?.backgroundImage || '').trim();
  if (backgroundImage && backgroundImage !== 'none' && !isSingleSupportedGradient(backgroundImage)) {
    diagnostics.unclassifiedFallbacks.push({
      path,
      fact: `unsupported background-image: ${backgroundImage}`,
    });
  }
  const borders = ['Top', 'Right', 'Bottom', 'Left']
    .map((side) => String(source.style?.[`border${side}`] || '').trim())
    .filter((value) => value && !/^0(?:px)?\s|\bnone\b/.test(value));
  const unsupported = borders.filter((value) => !/\b(?:solid|dashed|dotted)\b/.test(value));
  if (unsupported.length) {
    diagnostics.unclassifiedFallbacks.push({ path, fact: `unsupported border style: ${unsupported.join(', ')}` });
  }
}

const GLYPH_ICON_BY_ROLE = {
  overview: 'home', projects: 'folder', inbox: 'arrow-up-right', team: 'users',
  automations: 'zap', settings: 'settings', search: 'search',
};

const GLYPH_ICON_BY_CHARACTER = {
  '⌂': 'home', '◇': 'folder', '↗': 'arrow-up-right', '♙': 'users',
  '⌁': 'zap', '⚙': 'settings', '⌕': 'search', '◎': 'target', '◌': 'circle',
};

/** Resolve only explicit role names or known legacy glyphs. Unknown glyphs
 * remain unresolved instead of being guessed from their visual appearance. */
export function resolveGlyphIcon(iconRole) {
  if (!iconRole || iconRole.source !== 'glyph') return null;
  const candidate = GLYPH_ICON_BY_ROLE[String(iconRole.name || '').toLowerCase()]
    || GLYPH_ICON_BY_CHARACTER[String(iconRole.glyph || '').trim()]
    || null;
  return candidate && getBuiltinIconSvg(candidate) ? candidate : null;
}

function childrenMeasuredTracks(node, axis) {
  const flow = (node.children || []).filter((child) => !['absolute', 'fixed'].includes(child.style?.position));
  if (axis === 'column') return flow.map((child) => child.rect?.w || 1);
  return flow.map((child) => child.rect?.h || 1);
}

function isCenteredOneCellGrid(node, columns, rows) {
  const flowChildren = (node.children || []).filter((child) => !['absolute', 'fixed'].includes(child.style?.position));
  const directItems = [...(node.texts || []), ...flowChildren];
  if (columns.length !== 1 || rows.length !== 1 || directItems.length !== 1) return false;
  const style = node.style || {};
  if (align(style.alignItems) === 'center' && align(style.justifyItems) === 'center') return true;
  const itemRect = directItems[0]?.rect;
  if (!itemRect || !node.rect) return false;
  const nodeCenterX = node.rect.x + node.rect.w / 2;
  const nodeCenterY = node.rect.y + node.rect.h / 2;
  const itemCenterX = itemRect.x + itemRect.w / 2;
  const itemCenterY = itemRect.y + itemRect.h / 2;
  return Math.abs(nodeCenterX - itemCenterX) <= 1 && Math.abs(nodeCenterY - itemCenterY) <= 1;
}

function isSingleCenteredTextControl(node) {
  if (String(node?.tag || '').toLowerCase() !== 'button'
    || (node.children || []).length !== 0
    || (node.texts || []).length !== 1) return false;
  const textRect = node.texts[0]?.rect;
  if (!textRect || !node.rect || align(node.style?.textAlign) !== 'center') return false;
  const nodeCenterX = node.rect.x + node.rect.w / 2;
  const nodeCenterY = node.rect.y + node.rect.h / 2;
  const textCenterX = textRect.x + textRect.w / 2;
  const textCenterY = textRect.y + textRect.h / 2;
  return Math.abs(nodeCenterX - textCenterX) <= 1 && Math.abs(nodeCenterY - textCenterY) <= 1;
}

function layoutFor(node, diagnostics, path) {
  const style = node.style || {};
  const authored = node.authoredStyle || {};
  const display = String(style.display || 'block');
  if (display === 'flex' || display === 'inline-flex') {
    const direction = String(style.flexDirection || 'row').startsWith('column') ? 'column' : 'row';
    if (String(style.justifyContent) === 'space-around') {
      const count = Math.max(1,
        (node.children || []).filter((child) => !['absolute', 'fixed'].includes(child.style?.position)).length
        + (node.texts || []).length);
      diagnostics.classifiedFallbacks.push({
        path, fact: 'justify-content: space-around', fallback: STRATEGY.spaceAround, slots: count,
      });
      return {
        kind: 'grid',
        columns: direction === 'row' ? Array.from({ length: count }, () => ({ kind: 'flex', value: 1 })) : [{ kind: 'hug' }],
        rows: direction === 'column' ? Array.from({ length: count }, () => ({ kind: 'flex', value: 1 })) : [{ kind: 'hug' }],
        rowGap: 0, columnGap: 0, autoFlow: direction === 'row' ? 'column' : 'row',
        padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
        source: STRATEGY.spaceAround, direction,
      };
    }
    return {
      kind: 'flex', direction,
      wrap: String(style.flexWrap || 'nowrap') !== 'nowrap',
      gap: px(style.gap === 'normal' ? style.columnGap : style.gap),
      rowGap: px(style.rowGap), columnGap: px(style.columnGap),
      justify: align(style.justifyContent), items: align(style.alignItems),
      padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
    };
  }
  if (display === 'grid' || display === 'inline-grid') {
    const columns = parseTracks(authored.gridTemplateColumns, style.gridTemplateColumns, childrenMeasuredTracks(node, 'column'), diagnostics, path, 'column');
    const rows = parseTracks(authored.gridTemplateRows, style.gridTemplateRows, childrenMeasuredTracks(node, 'row'), diagnostics, path, 'row');
    if (!columns.length || !rows.length) diagnostics.unclassifiedFallbacks.push({ path, fact: 'grid tracks missing' });
    if (isCenteredOneCellGrid(node, columns, rows)) {
      return {
        kind: 'flex', direction: 'column', wrap: false,
        gap: 0, rowGap: 0, columnGap: 0, justify: 'center', items: 'center',
        padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
        source: 'trivial-centered-grid',
      };
    }
    return {
      kind: 'grid', columns, rows,
      rowGap: px(style.rowGap), columnGap: px(style.columnGap), autoFlow: style.gridAutoFlow || 'row',
      items: align(style.alignItems), justifyItems: align(style.justifyItems),
      padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
    };
  }
  if (isSingleCenteredTextControl(node)) {
    return {
      kind: 'flex', direction: 'column', wrap: false,
      gap: 0, rowGap: 0, columnGap: 0, justify: 'center', items: 'center',
      padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
      source: 'single-centered-text-control',
    };
  }
  const hasFlowChildren = (node.children || []).some((child) => !['absolute', 'fixed'].includes(child.style?.position));
  return hasFlowChildren || (node.texts || []).length ? {
    kind: 'flow', direction: 'column', gap: 0,
    padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
  } : { kind: 'leaf' };
}

function gridCell(style, parentLayout = null) {
  const integer = (value) => /^-?\d+$/.test(String(value || '')) ? Number(value) : null;
  const line = (value, count) => {
    const parsed = integer(value);
    if (parsed === null || parsed === 0) return null;
    return parsed < 0 && count ? count + 2 + parsed : parsed;
  };
  const rowCount = parentLayout?.rows?.length || 0;
  const columnCount = parentLayout?.columns?.length || 0;
  const startRow = line(style?.gridRowStart, rowCount), endRow = line(style?.gridRowEnd, rowCount);
  const startColumn = line(style?.gridColumnStart, columnCount), endColumn = line(style?.gridColumnEnd, columnCount);
  const span = (raw, start, end) => {
    const explicit = String(raw || '').match(/^span\s+(\d+)$/);
    if (explicit) return Number(explicit[1]);
    if (start && end && end > start) return end - start;
    return 1;
  };
  return {
    ...(startRow ? { row: startRow } : {}), ...(startColumn ? { column: startColumn } : {}),
    ...(startRow ? { rowSpan: span(style.gridRowEnd, startRow, endRow) } : {}),
    ...(startColumn ? { columnSpan: span(style.gridColumnEnd, startColumn, endColumn) } : {}),
  };
}

function computedTrackSizes(value) {
  return splitTracks(value)
    .map((part) => /^-?[\d.]+px$/.test(part) ? px(part) : null)
    .filter((part) => part !== null);
}

/** Resolve a measured browser rectangle back to its native CSS Grid cell.
 * Computed grid templates contain the used pixel size even when the authored
 * track was `auto`, `fr` or `minmax()`, so this remains deterministic for
 * anonymous text items and auto-placed element children. */
export function gridCellFromRect(rect, parentSource, parentLayout) {
  if (!rect || !parentSource?.rect || parentLayout?.kind !== 'grid') return null;
  const columns = computedTrackSizes(parentSource.style?.gridTemplateColumns);
  const rows = computedTrackSizes(parentSource.style?.gridTemplateRows);
  if (!columns.length || !rows.length) return null;
  const [pt = 0, , , pl = 0] = parentLayout.padding || [];
  const locate = (coordinate, sizes, gap) => {
    let cursor = 0;
    for (let index = 0; index < sizes.length; index++) {
      if (coordinate >= cursor - 0.5 && coordinate <= cursor + sizes[index] + 0.5) return index + 1;
      cursor += sizes[index] + gap;
    }
    return null;
  };
  const column = locate(rect.x - parentSource.rect.x - pl, columns, parentLayout.columnGap || 0);
  const row = locate(rect.y - parentSource.rect.y - pt, rows, parentLayout.rowGap || 0);
  return row && column ? { row, column, rowSpan: 1, columnSpan: 1 } : null;
}

/** Used pixel extent of the tracks covered by a cell, including inner gaps. */
export function gridTrackSpanSize(parentSource, parentLayout, cell, axis) {
  if (!parentSource || parentLayout?.kind !== 'grid' || !cell) return null;
  const isColumn = axis === 'column';
  const sizes = computedTrackSizes(isColumn
    ? parentSource.style?.gridTemplateColumns
    : parentSource.style?.gridTemplateRows);
  const start = Number(isColumn ? cell.column : cell.row);
  const span = Math.max(1, Number(isColumn ? cell.columnSpan : cell.rowSpan) || 1);
  if (!Number.isInteger(start) || start < 1 || start + span - 1 > sizes.length) return null;
  const gap = Number(isColumn ? parentLayout.columnGap : parentLayout.rowGap) || 0;
  return sizes.slice(start - 1, start - 1 + span).reduce((sum, size) => sum + size, 0) + gap * (span - 1);
}

function placeGridChildren(model) {
  if (model.layout?.kind !== 'grid') return;
  if (model.layout.source === STRATEGY.spaceAround) {
    let slot = 0;
    for (const item of model.source?.contentOrder || []) {
      if (item.kind === 'text') { slot++; continue; }
      const child = model.children[item.index];
      if (!child || child.positioning?.kind === 'absolute') continue;
      child.gridCell = model.layout.direction === 'row'
        ? { row: 1, column: slot + 1, rowSpan: 1, columnSpan: 1 }
        : { row: slot + 1, column: 1, rowSpan: 1, columnSpan: 1 };
      slot++;
    }
    if (!(model.source?.contentOrder || []).length) {
      for (const child of model.children.filter((item) => item.positioning?.kind !== 'absolute')) {
        child.gridCell = model.layout.direction === 'row'
          ? { row: 1, column: ++slot, rowSpan: 1, columnSpan: 1 }
          : { row: ++slot, column: 1, rowSpan: 1, columnSpan: 1 };
      }
    }
    return;
  }
  const columns = Math.max(1, model.layout.columns?.length || 1);
  const occupied = new Set();
  const fits = (row, column, rowSpan, columnSpan) => {
    if (column < 1 || column + columnSpan - 1 > columns) return false;
    for (let r = row; r < row + rowSpan; r++) {
      for (let c = column; c < column + columnSpan; c++) {
        if (occupied.has(`${r}:${c}`)) return false;
      }
    }
    return true;
  };
  const reserve = (row, column, rowSpan, columnSpan) => {
    for (let r = row; r < row + rowSpan; r++) {
      for (let c = column; c < column + columnSpan; c++) occupied.add(`${r}:${c}`);
    }
  };
  for (const text of model.source?.texts || []) {
    const cell = gridCellFromRect(text.rect, model.source, model.layout);
    if (cell) reserve(cell.row, cell.column, cell.rowSpan, cell.columnSpan);
  }
  for (const child of model.children) {
    if (child.positioning?.kind === 'absolute') continue;
    const cell = child.gridCell || (child.gridCell = {});
    const measured = gridCellFromRect(child.source?.rect, model.source, model.layout);
    const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
    const columnSpan = Math.min(columns, Math.max(1, Number(cell.columnSpan) || 1));
    let placed = null;
    const preferredRow = cell.row || measured?.row;
    const preferredColumn = cell.column || measured?.column;
    if (preferredRow && preferredColumn && fits(preferredRow, preferredColumn, rowSpan, columnSpan)) {
      placed = { row: preferredRow, column: preferredColumn };
    }
    for (let row = cell.row || 1; row < 1000 && !placed; row++) {
      const startColumn = cell.column || 1;
      const endColumn = cell.column || columns;
      for (let column = startColumn; column <= endColumn; column++) {
        if (fits(row, column, rowSpan, columnSpan)) { placed = { row, column }; break; }
      }
      if (cell.row) break;
    }
    if (!placed) continue;
    cell.row = placed.row;
    cell.column = placed.column;
    cell.rowSpan = rowSpan;
    cell.columnSpan = columnSpan;
    reserve(placed.row, placed.column, rowSpan, columnSpan);
  }
}

export function domCaptureToSemanticModel(capture, {
  resolveProjectIcon = () => null,
  resolveComponent = () => null,
} = {}) {
  if (!capture || typeof capture !== 'object' || !capture.root?.rect || !capture.root?.style) {
    throw new Error('Invalid DOM capture: expected { root: { rect, style, children } }');
  }
  const diagnostics = {
    layouts: { grid: 0, flex: 0, flow: 0, leaf: 0 },
    absoluteNodes: 0,
    tokenReferences: 0,
    unresolvedIcons: [], unresolvedComponents: [], classifiedFallbacks: [], unclassifiedFallbacks: [],
    codeOnlyFacts: [], fontRequirements: [],
  };
  const visit = (source, parentPath = '', parentLayout = null) => {
    const name = nodeName(source);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const backgroundToken = tokenReference(source.authoredStyle?.backgroundColor);
    const projectIcon = source.iconRole?.source === 'glyph' ? resolveProjectIcon(source.iconRole) : null;
    const resolvedIcon = projectIcon || resolveGlyphIcon(source.iconRole);
    if (source.iconRole?.source === 'glyph' && !resolvedIcon) {
      diagnostics.unresolvedIcons.push({ name: source.iconRole.name, source: 'glyph', path });
    }
    const componentEntityId = String(source.sourceIdentity?.component || '').trim() || null;
    const component = componentEntityId ? resolveComponent(componentEntityId, source.sourceIdentity) : null;
    if (componentEntityId && !component) {
      diagnostics.unresolvedComponents.push({ entityId: componentEntityId, path });
      diagnostics.unclassifiedFallbacks.push({
        path,
        fact: `Design Entity ${componentEntityId} has no explicit Figma component link`,
      });
    }
    const positioning = ['absolute', 'fixed'].includes(source.style?.position)
      ? { kind: 'absolute' }
      : { kind: 'flow' };
    if (positioning.kind === 'absolute') diagnostics.absoluteNodes++;
    if (source.style?.position === 'sticky') {
      diagnostics.codeOnlyFacts.push({ path, fact: 'position: sticky', strategy: STRATEGY.sticky });
    }
    const filter = String(source.style?.filter || '').trim();
    if (filter && filter !== 'none') {
      const names = topLevelCssFunctions(filter);
      const unsupported = names.filter((name) => !['blur', 'drop-shadow'].includes(name));
      if (unsupported.length) diagnostics.unclassifiedFallbacks.push({ path, fact: `unsupported CSS filter(s): ${[...new Set(unsupported)].join(', ')}` });
      else diagnostics.classifiedFallbacks.push({ path, fact: `filter: ${filter}`, fallback: STRATEGY.filterChains });
    }
    const maskImage = String(source.style?.maskImage || '').trim();
    if (maskImage && maskImage !== 'none') {
      diagnostics.unclassifiedFallbacks.push({ path, fact: 'CSS mask has no materialized vector shape; real Figma mask required' });
    }
    const axes = String(source.style?.fontVariationSettings || '').trim();
    if (axes && axes !== 'normal') {
      diagnostics.fontRequirements.push({ path, family: source.style?.fontFamily, axes, strategy: STRATEGY.variableFontAxes });
      diagnostics.classifiedFallbacks.push({ path, fact: `font-variation-settings: ${axes}`, fallback: STRATEGY.variableFontAxes });
    }
    const perSideBorderFinding = classifyPerSideBorders(source, diagnostics, path);
    classifyPaintBoundaries(source, diagnostics, path);
    const layout = layoutFor(source, diagnostics, path);
    diagnostics.layouts[layout.kind] = (diagnostics.layouts[layout.kind] || 0) + 1;
    if (backgroundToken) diagnostics.tokenReferences++;
    const model = {
      name, path, source, positioning, component,
      ...(perSideBorderFinding ? { fallbackAnnotations: [cssFigmaFallbackAnnotationIntent(perSideBorderFinding)] } : {}),
      layout,
      gridCell: gridCell(source.style, parentLayout),
      sizing: {
        width: source.rect.w, height: source.rect.h,
        grow: finite(source.style?.flexGrow), shrink: finite(source.style?.flexShrink, 1),
        minWidth: px(source.style?.minWidth), minHeight: px(source.style?.minHeight),
        maxWidth: source.style?.maxWidth === 'none' ? null : px(source.style?.maxWidth),
        maxHeight: source.style?.maxHeight === 'none' ? null : px(source.style?.maxHeight),
      },
      paint: {
        background: { value: source.style?.backgroundColor || null, token: backgroundToken },
        backgroundImage: { value: source.style?.backgroundImage || null },
      },
      asset: resolvedIcon ? { kind: projectIcon ? 'project-icon' : 'builtin-icon', name: resolvedIcon } : null,
      children: [],
    };
    model.children = (source.children || []).map((child) => visit(child, path, layout));
    placeGridChildren(model);
    return model;
  };
  return { version: 1, root: visit(capture.root), diagnostics };
}

export function semanticTrackString(tracks) {
  return (tracks || []).map((item) => {
    if (item.kind === 'fixed') return `fixed:${item.value}`;
    if (item.kind === 'flex' && Number(item.value) !== 1) return `flex:${item.value}`;
    return item.kind;
  }).join(',');
}

function jsxTrack(raw, diagnostics, path, axis) {
  const value = String(raw || '').trim();
  const fixed = value.match(/^fixed:([\d.]+)$/i);
  if (fixed) return { kind: 'fixed', value: Number(fixed[1]) };
  const flex = value.match(/^flex(?::([\d.]+))?$/i);
  if (flex && Number(flex[1] || 1) > 0) return { kind: 'flex', value: Number(flex[1] || 1) };
  if (value === 'hug') return { kind: 'hug' };
  diagnostics.unclassifiedFallbacks.push({ path, fact: `${axis} track ${value || 'missing'}` });
  return { kind: 'unsupported', source: value };
}

function jsxTracks(raw, diagnostics, path, axis) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    diagnostics.unclassifiedFallbacks.push({ path, fact: `${axis} tracks missing` });
    return [];
  }
  return String(raw).split(',').map((value) => jsxTrack(value, diagnostics, path, axis));
}

function jsxTokenCount(props) {
  return Object.values(props || {}).filter((value) => typeof value === 'string' && value.startsWith('var:')).length;
}

function jsxColorIntent(props) {
  const authored = props?.bg ?? props?.fill ?? null;
  if (typeof authored !== 'string' || !authored.startsWith('var:')) {
    return { value: authored, token: null };
  }
  const source = authored.slice(4);
  const separator = source.indexOf('|');
  return separator < 0
    ? { value: null, token: source }
    : { value: source.slice(separator + 1) || null, token: source.slice(0, separator) };
}

/** Adapt the already-parsed render JSX tree into the same semantic node
 * contract used by browser capture. This runs before any Figma connection or
 * write so unsupported structure cannot degrade silently in the renderer. */
export function jsxTreeToSemanticModel(rootProps, children, {
  isIconResolved = () => true,
  resolveIconAsset = null,
  resolveImageAsset = null,
} = {}) {
  const diagnostics = {
    layouts: { grid: 0, flex: 0, free: 0, leaf: 0 },
    absoluteNodes: 0,
    tokenReferences: 0,
    unresolvedIcons: [], classifiedFallbacks: [], unclassifiedFallbacks: [],
    codeOnlyFacts: [], fontRequirements: [],
  };

  const visit = (props, parentPath = '', parentLayout = null, root = false) => {
    const type = root ? 'frame' : String(props?._type || 'frame');
    const name = String(props?.name || type || 'element').trim() || type;
    const path = parentPath ? `${parentPath}/${name}` : name;
    const isContainer = type === 'frame' || type === 'slot';
    const flex = String(props?.flex || 'col');
    let layout = { kind: 'leaf' };
    if (isContainer && flex === 'grid') {
      layout = {
        kind: 'grid',
        columns: jsxTracks(props.gridColumns, diagnostics, path, 'column'),
        rows: jsxTracks(props.gridRows, diagnostics, path, 'row'),
        rowGap: finite(props.rowGap), columnGap: finite(props.columnGap ?? props.gap),
        autoFlow: props.gridAutoFlow || 'row',
      };
    } else if (isContainer && ['none', 'stack', 'free'].includes(flex)) {
      layout = { kind: 'free', reason: 'explicit-free-layout' };
      diagnostics.classifiedFallbacks.push({ path, fact: `flex=${flex}`, fallback: 'explicit-free-layout' });
    } else if (isContainer && ['row', 'col', 'column'].includes(flex)) {
      layout = { kind: 'flex', direction: flex === 'row' ? 'row' : 'column' };
    } else if (isContainer) {
      diagnostics.unclassifiedFallbacks.push({ path, fact: `unsupported flex=${flex}` });
      layout = { kind: 'unsupported' };
    }

    diagnostics.layouts[layout.kind] = (diagnostics.layouts[layout.kind] || 0) + 1;
    const positioning = props?.position === 'absolute' ? { kind: 'absolute' } : { kind: 'flow' };
    if (positioning.kind === 'absolute') diagnostics.absoluteNodes++;
    if (props?.position && props.position !== 'absolute') {
      diagnostics.unclassifiedFallbacks.push({ path, fact: `unsupported position=${props.position}` });
    }
    if ((props?.gridRow || props?.gridColumn || props?.gridRowSpan || props?.gridColumnSpan) && parentLayout?.kind !== 'grid') {
      diagnostics.unclassifiedFallbacks.push({ path, fact: 'grid cell props outside a Grid parent' });
    }
    for (const key of ['gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan']) {
      if (props?.[key] !== undefined && (!Number.isInteger(Number(props[key])) || Number(props[key]) < 1)) {
        diagnostics.unclassifiedFallbacks.push({ path, fact: `${key} must be a positive integer` });
      }
    }
    diagnostics.tokenReferences += jsxTokenCount(props);
    const iconAsset = type === 'icon' && typeof resolveIconAsset === 'function'
      ? resolveIconAsset(props?.name)
      : null;
    const imageAsset = type === 'image' && typeof resolveImageAsset === 'function'
      ? resolveImageAsset(props || {})
      : null;
    if (type === 'icon' && !iconAsset && !isIconResolved(props?.name)) {
      diagnostics.unresolvedIcons.push({ name: props?.name || 'icon', source: 'jsx', path });
    }
    if (props?.fontAxes) {
      diagnostics.fontRequirements.push({ path, family: props.font || 'Inter', axes: props.fontAxes, strategy: STRATEGY.variableFontAxes });
      diagnostics.classifiedFallbacks.push({ path, fact: `font axes: ${props.fontAxes}`, fallback: STRATEGY.variableFontAxes });
    }

    // Parser-only fields describe the legacy JSX tree, not authored render
    // properties. Child order is canonical in `children`, while element type
    // is explicit metadata. Keeping `_children` here duplicated the complete
    // subtree at every level and made stable plan serialization impossible.
    const sourceChildren = props?._children || [];
    const sourceProps = Object.fromEntries(Object.entries(props || {})
      .filter(([key]) => !['_children', '_type', '_index', '_fallbackAnnotations'].includes(key)));
    const background = jsxColorIntent(sourceProps);
    const model = {
      name, path, source: { kind: 'jsx', type, props: sourceProps }, positioning, layout,
      ...(Array.isArray(props?._fallbackAnnotations) && props._fallbackAnnotations.length
        ? { fallbackAnnotations: props._fallbackAnnotations }
        : {}),
      ...(iconAsset || imageAsset ? { asset: iconAsset || imageAsset } : {}),
      gridCell: {
        ...(props?.gridRow ? { row: Number(props.gridRow) } : {}),
        ...(props?.gridColumn ? { column: Number(props.gridColumn) } : {}),
        ...(props?.gridRowSpan ? { rowSpan: Number(props.gridRowSpan) } : {}),
        ...(props?.gridColumnSpan ? { columnSpan: Number(props.gridColumnSpan) } : {}),
      },
      sizing: { width: props?.w ?? props?.width ?? null, height: props?.h ?? props?.height ?? null },
      paint: { background },
      children: [],
    };
    model.children = sourceChildren.map((child) => visit(child, path, layout));
    return model;
  };

  const root = { ...rootProps, _type: 'frame', _children: children || [] };
  return { version: 1, root: visit(root, '', null, true), diagnostics };
}

export function assertSemanticModel(model) {
  const failures = model?.diagnostics?.unclassifiedFallbacks || [];
  if (!failures.length) return model;
  const details = failures.slice(0, 5).map((item) => `${item.path}: ${item.fact}`).join('; ');
  throw new Error(`Semantic layout validation failed (${failures.length}): ${details}`);
}
