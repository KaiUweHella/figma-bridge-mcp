/**
 * Browser DOM/computed-style capture -> ordered executable render tree.
 *
 * The primary adapter creates a Semantic Render Plan directly. JSX
 * serialization remains as a compatibility/debug projection; execution no
 * longer needs to serialize and reparse measured browser facts.
 */

import {
  domCaptureToSemanticModel,
  gridCellFromRect,
  gridTrackSpanSize,
  jsxTreeToSemanticModel,
  semanticTrackString,
} from './semantic-dom-model.js';
import { createSemanticRenderPlan } from './semantic-render-plan.js';
import { getBuiltinIconSvg } from './builtin-icons.js';

const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const px = (value, fallback = 0) => finite(String(value ?? '').replace(/px$/, ''), fallback);
const round = (value) => Math.round(finite(value) * 1000) / 1000;
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const attr = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;');

function cssColor(value) {
  const source = String(value || '').trim();
  if (!source || TRANSPARENT.has(source.toLowerCase())) return null;
  if (/^#[0-9a-f]{3,8}$/i.test(source)) return source;
  const match = source.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const alpha = parts.length > 3 ? Math.max(0, Math.min(1, parts[3])) : 1;
  return `#${hex(parts[0])}${hex(parts[1])}${hex(parts[2])}${alpha < 1 ? hex(alpha * 255) : ''}`;
}

function splitCssList(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  const source = String(value || '');
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '(') depth++;
    if (source[index] === ')') depth--;
    if (source[index] === ',' && depth === 0) {
      out.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (source.slice(start).trim()) out.push(source.slice(start).trim());
  return out;
}

function parseShadow(value) {
  return splitCssList(value).map((source) => {
    const colorMatch = source.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i);
    const color = cssColor(colorMatch?.[0]) || '#0000001a';
    const withoutColor = colorMatch ? `${source.slice(0, colorMatch.index)} ${source.slice(colorMatch.index + colorMatch[0].length)}` : source;
    const inset = /\binset\b/i.test(withoutColor);
    const numbers = withoutColor.replace(/\binset\b/ig, '').match(/-?\d*\.?\d+(?:px)?/g)?.map(px) || [];
    return { inset, x: numbers[0] || 0, y: numbers[1] || 0, blur: numbers[2] || 0, spread: numbers[3] || 0, color };
  });
}

function border(style, side) {
  const raw = String(style?.[`border${side}`] || '');
  const match = raw.match(/^([\d.]+)px\s+(\w+)\s+(.+)$/);
  if (!match || match[2] === 'none' || Number(match[1]) <= 0) return null;
  const color = cssColor(match[3]);
  return color ? { width: Number(match[1]), style: match[2], color } : null;
}

function nativeDashProps(borderValue) {
  if (!borderValue || borderValue.style === 'solid') return {};
  if (borderValue.style === 'dashed') {
    const segment = Math.max(1, round(borderValue.width * 4));
    return { strokeDashPattern: `${segment} ${segment}` };
  }
  if (borderValue.style === 'dotted') {
    return {
      strokeDashPattern: `0 ${Math.max(1, round(borderValue.width * 2))}`,
      strokeCap: 'round',
    };
  }
  return {};
}

function radii(style, rect) {
  return ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']
    .map((corner) => {
      const value = String(style?.[`border${corner}Radius`] || '0');
      if (value.endsWith('%')) return Math.min(rect.w, rect.h) * px(value.slice(0, -1)) / 100;
      return px(value);
    });
}

function nativeRadiusValue(value) {
  const number = Number(value);
  if (!(number > 0) || Number.isInteger(number)) return number;
  return `var:radius/${String(number).replace(/\./g, '-')}px|${number}`;
}

function nodeName(node, suffix = '') {
  const base = String(node?.classes || node?.aria || node?.tag || 'Element')
    .trim().replace(/\s+/g, '.').slice(0, 80) || 'Element';
  return `${base}${suffix}`;
}

function propsString(props) {
  return Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== '')
    .map(([key, value]) => `${key}="${attr(value)}"`)
    .join(' ');
}

function renderElement(type, props = {}, children = [], content = '', metadata = {}) {
  return { type, props, children, content, ...metadata };
}

function executableProps(props) {
  return Object.fromEntries(Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== ''));
}

function renderTreeToJsx(node) {
  if (!node) return '';
  const tag = { frame: 'Frame', text: 'Text', icon: 'Icon', instance: 'Instance' }[node.type];
  if (!tag) throw new Error(`Unsupported DOM render element type: ${node.type}`);
  const attributes = propsString(node.props);
  const opening = `<${tag}${attributes ? ` ${attributes}` : ''}`;
  if (node.type === 'text') return `${opening}>${node.content}</Text>`;
  if (node.type === 'frame') return `${opening}>${node.children.map(renderTreeToJsx).join('')}</Frame>`;
  return `${opening} />`;
}

function renderTreeToParsedTree(root) {
  const child = (node) => ({
    ...executableProps(node.props),
    _type: node.type,
    ...(node.type === 'text' ? { content: node.content } : {}),
    ...(node.fallbackAnnotations?.length ? { _fallbackAnnotations: node.fallbackAnnotations } : {}),
    ...(node.type === 'frame' ? { _children: node.children.map(child) } : {}),
  });
  return {
    props: {
      ...executableProps(root.props),
      ...(root.fallbackAnnotations?.length ? { _fallbackAnnotations: root.fallbackAnnotations } : {}),
    },
    children: root.children.map(child), content: '',
  };
}

function visualProps(style, rect, { root = false, semantic = null } = {}) {
  const layout = semantic?.layout;
  const flex = layout?.kind === 'grid' ? 'grid'
    : layout?.kind === 'flex' ? (layout.direction === 'column' ? 'col' : 'row')
      : layout?.kind === 'flow' ? 'col'
        : 'none';
  const props = {
    name: undefined,
    flex,
    w: round(rect.w),
    h: round(rect.h),
  };
  const background = cssColor(style?.backgroundColor);
  const backgroundImage = String(semantic?.paint?.backgroundImage?.value || style?.backgroundImage || '').trim();
  if (/^(?:linear|radial)-gradient\s*\(/i.test(backgroundImage)) {
    props.bg = backgroundImage;
  }
  else if (semantic?.paint?.background?.token) {
    props.bg = `var:${semantic.paint.background.token}${background ? `|${background}` : ''}`;
  }
  else if (background) props.bg = background;
  if (layout && layout.kind !== 'leaf') {
    // CSS space-between maps to Figma's automatic gap
    // (primaryAxisAlignItems = SPACE_BETWEEN). A numeric itemSpacing would
    // present a conflicting fixed-gap intent in the editable Figma frame.
    if (layout.gap > 0 && layout.justify !== 'between') props.gap = round(layout.gap);
    if (layout.wrap) props.wrap = 'true';
    if (layout.kind === 'flex') {
      if (layout.rowGap > 0) props.rowGap = round(layout.rowGap);
      if (layout.columnGap > 0) props.columnGap = round(layout.columnGap);
    }
    if (layout.justify && layout.justify !== 'start') props.justify = layout.justify;
    if (layout.items && layout.items !== 'start') props.items = layout.items;
    const [pt = 0, pr = 0, pb = 0, pl = 0] = layout.padding || [];
    if (pt) props.pt = round(pt);
    if (pr) props.pr = round(pr);
    if (pb) props.pb = round(pb);
    if (pl) props.pl = round(pl);
    if (layout.kind === 'grid') {
      props.gridColumns = semanticTrackString(layout.columns);
      props.gridRows = semanticTrackString(layout.rows);
      if (layout.columnGap > 0) props.columnGap = round(layout.columnGap);
      if (layout.rowGap > 0) props.rowGap = round(layout.rowGap);
      // Figma exposes row auto-flow only. A CSS column-flow grid whose items
      // already carry explicit measured cells needs no auto-flow instruction:
      // the Semantic Model retains the CSS provenance while the executable
      // plan places every child manually in the same native Grid cell.
      if (layout.autoFlow === 'row') props.gridAutoFlow = layout.autoFlow;
    }
  }
  const rs = radii(style, rect);
  if (rs.every((radius) => radius === rs[0])) props.rounded = rs[0] ? nativeRadiusValue(rs[0]) : undefined;
  else {
    props.roundedTL = rs[0] ? nativeRadiusValue(rs[0]) : undefined;
    props.roundedTR = rs[1] ? nativeRadiusValue(rs[1]) : undefined;
    props.roundedBR = rs[2] ? nativeRadiusValue(rs[2]) : undefined;
    props.roundedBL = rs[3] ? nativeRadiusValue(rs[3]) : undefined;
  }
  if (style?.overflow === 'hidden' || style?.overflow === 'clip') props.clip = 'true';
  if (style?.mixBlendMode && style.mixBlendMode !== 'normal') props.blendMode = style.mixBlendMode;
  const opacity = finite(style?.opacity, 1);
  if (opacity < 1) props.opacity = opacity;
  const blur = String(style?.backdropFilter || '').match(/blur\(([\d.]+)px\)/);
  if (blur) props.bgBlur = Number(blur[1]);
  if (style?.filter && style.filter !== 'none') props.filter = style.filter;

  const borders = ['Top', 'Right', 'Bottom', 'Left'].map((side) => border(style, side));
  if (borders.every((item) => item && item.width === borders[0].width && item.color === borders[0].color && item.style === borders[0].style)) {
    props.stroke = borders[0].color;
    props.strokeWidth = borders[0].width;
    props.strokeAlign = 'inside';
    Object.assign(props, nativeDashProps(borders[0]));
  } else {
    const painted = borders.filter(Boolean);
    const singleNativePaint = painted.length > 0
      && ['solid', 'dashed', 'dotted'].includes(painted[0].style)
      && painted.every((item) => item.color === painted[0].color && item.style === painted[0].style);
    const reviewedMixedSolidPaint = painted.length > 0
      && painted.every((item) => item.style === 'solid');
    if (singleNativePaint || reviewedMixedSolidPaint) {
      // Figma supports independent stroke weights but only one stroke paint.
      // For mixed CSS side colors, pick the first explicitly painted side in
      // CSS order (top → right → bottom → left) and keep every side's width.
      // This stays native/editable and avoids absolute border geometry.
      props.stroke = painted[0].color;
      props.strokeTopWidth = borders[0]?.width || 0;
      props.strokeRightWidth = borders[1]?.width || 0;
      props.strokeBottomWidth = borders[2]?.width || 0;
      props.strokeLeftWidth = borders[3]?.width || 0;
      props.strokeAlign = 'inside';
      Object.assign(props, nativeDashProps(painted[0]));
    }
  }

  const shadows = parseShadow(style?.boxShadow).filter((shadow) => shadow.blur > 0 || shadow.spread !== 0 || shadow.x !== 0 || shadow.y !== 0);
  const outer = shadows.filter((shadow) => !shadow.inset);
  const inner = shadows.filter((shadow) => shadow.inset);
  // Figma exposes spread on Frame shadows only for a visibly filled, clipped
  // frame. A captured leaf has no element descendants whose overflow could be
  // changed by clipping, so this is a semantics-preserving native mapping for
  // CSS ring shadows such as `0 0 0 3px color`.
  if (background && shadows.some((shadow) => shadow.spread !== 0) && !(semantic?.children || []).length) {
    props.clip = 'true';
  }
  if (outer.length) props.shadow = `${outer[0].x} ${outer[0].y} ${outer[0].blur} ${outer[0].spread} ${outer[0].color}`;
  if (inner.length) props.innerShadow = `${inner[0].x} ${inner[0].y} ${inner[0].blur} ${inner[0].spread} ${inner[0].color}`;
  if (!root && (!semantic || semantic.positioning.kind === 'absolute')) {
    props.position = 'absolute';
  }
  return { props, borders };
}

function namedTextStyle(owner) {
  const explicit = String(owner?.sourceIdentity?.textStyle || '').trim();
  if (explicit) return explicit;
  const classes = new Set(String(owner?.classes || '').trim().split(/\s+/).filter(Boolean));
  return classes.has('eyebrow') ? 'Typography/Eyebrow' : undefined;
}

function textLayer(text, ownerRect, index, { owner = null, positioned = true, gridCell = null, sizing = null, gridAlign = false } = {}) {
  const style = text.style || {};
  const family = String(style.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim() || 'Inter';
  const color = cssColor(style.color) || '#000000';
  const fontSize = px(style.fontSize, 14);
  // Intrinsic, in-flow single lines are true HUG text in Figma. A former
  // 20% width allowance prevented wrapping but left visibly oversized text
  // boxes throughout the System Map. Positioned and multiline runs retain a
  // measured fixed width because their box geometry is part of the source.
  const singleLine = text.rect.h <= fontSize * 1.6;
  const fittedWidth = text.rect.w + 2;
  const transformedText = style.textTransform === 'uppercase'
    ? String(text.text).toUpperCase()
    : style.textTransform === 'lowercase'
      ? String(text.text).toLowerCase()
      : style.textTransform === 'capitalize'
        ? String(text.text).replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
        : text.text;
  const lineHeight = /px$/.test(style.lineHeight || '') ? px(style.lineHeight) : undefined;
  const letterSpacing = /px$/.test(style.letterSpacing || '') ? px(style.letterSpacing) : undefined;
  const props = {
    name: `text.${index}`,
    x: positioned ? round(text.rect.x - ownerRect.x) : undefined,
    y: positioned ? round(text.rect.y - ownerRect.y) : undefined,
    position: positioned ? 'absolute' : undefined,
    w: sizing?.width || (!positioned && singleLine ? 'hug' : round(Math.max(1, fittedWidth))),
    size: fontSize,
    weight: style.fontWeight || '400',
    italic: style.fontStyle === 'italic' ? 'true' : undefined,
    color,
    font: family,
    fontAxes: style.fontVariationSettings && style.fontVariationSettings !== 'normal' ? style.fontVariationSettings : undefined,
    style: namedTextStyle(owner),
    align: sizing?.align || ({ start: 'left', end: 'right' })[style.textAlign] || style.textAlign,
    lineHeight,
    letterSpacing,
    opacity: finite(style.opacity, 1) < 1 ? finite(style.opacity, 1) : undefined,
    gridRow: gridCell?.row,
    gridColumn: gridCell?.column,
    gridRowSpan: gridCell?.rowSpan,
    gridColumnSpan: gridCell?.columnSpan,
    gridHAlign: gridAlign ? 'center' : undefined,
    gridVAlign: gridAlign ? 'center' : undefined,
  };
  return renderElement('text', props, [], esc(transformedText));
}

function textGridCell(text, node, layout, slotIndex = 0) {
  if (layout?.source === 'space-around.equal-slots') {
    return layout.direction === 'row'
      ? { row: 1, column: slotIndex + 1, rowSpan: 1, columnSpan: 1 }
      : { row: slotIndex + 1, column: 1, rowSpan: 1, columnSpan: 1 };
  }
  return gridCellFromRect(text.rect, node, layout);
}

function pseudoRect(pseudo, ownerRect) {
  const width = px(pseudo.width, ownerRect.w);
  const height = px(pseudo.height, ownerRect.h);
  let x = px(pseudo.left, 0);
  let y = px(pseudo.top, 0);
  if (pseudo.style?.position !== 'absolute') {
    x = pseudo.which === '::after' ? Math.max(0, ownerRect.w - width) : 0;
    y = Math.max(0, (ownerRect.h - height) / 2);
  } else {
    if (pseudo.left === 'auto' && pseudo.right !== 'auto') x = ownerRect.w - width - px(pseudo.right, 0);
    if (pseudo.top === 'auto' && pseudo.bottom !== 'auto') y = ownerRect.h - height - px(pseudo.bottom, 0);
  }
  return { x, y, w: width, h: height };
}

function svgIcon(node, parentRect, state, layoutProps = {}) {
  const iconName = `dom-svg-${++state.iconIndex}`;
  const color = cssColor(node.style?.color) || '#000000';
  state.icons[iconName] = String(node.svg)
    .replace(/currentColor/g, color)
    .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  return renderElement('icon', {
    name: iconName,
    preserveColors: 'true',
    position: layoutProps.position,
    x: layoutProps.x,
    y: layoutProps.y,
    w: layoutProps.w || round(node.rect.w),
    h: layoutProps.h || round(node.rect.h),
    grow: layoutProps.grow,
    gridRow: layoutProps.gridRow,
    gridColumn: layoutProps.gridColumn,
    gridRowSpan: layoutProps.gridRowSpan,
    gridColumnSpan: layoutProps.gridColumnSpan,
    gridHAlign: layoutProps.gridHAlign,
    gridVAlign: layoutProps.gridVAlign,
  });
}

function renderPseudo(pseudo, ownerRect, state, parentSemantic = null) {
  if (!pseudo) return null;
  const rect = pseudoRect(pseudo, ownerRect);
  const node = {
    tag: 'pseudo', classes: 'pseudo', rect: { x: ownerRect.x + rect.x, y: ownerRect.y + rect.y, w: rect.w, h: rect.h },
    style: pseudo.style || {}, texts: [], children: [], before: null, after: null,
  };
  const absolute = ['absolute', 'fixed'].includes(String(pseudo.style?.position || '').toLowerCase());
  const semantic = {
    name: `pseudo${pseudo.which || ''}`,
    path: `${parentSemantic?.path || 'pseudo'}/${pseudo.which || 'pseudo'}`,
    source: node,
    positioning: { kind: absolute ? 'absolute' : 'flow' },
    layout: { kind: 'leaf' },
    gridCell: {},
    sizing: { width: rect.w, height: rect.h, grow: 0, shrink: 1 },
    paint: { background: { value: node.style.backgroundColor || null, token: null }, backgroundImage: { value: node.style.backgroundImage || null } },
    asset: null,
    component: null,
    children: [],
  };
  return renderNode(node, ownerRect, state, {
    suffix: pseudo.which,
    forceLocal: rect,
    semantic,
    parentSemantic,
  });
}

function gridItemAlignment(selfValue, inheritedValue) {
  const self = String(selfValue || '').trim().toLowerCase();
  const selected = self && !['auto', 'normal'].includes(self) ? self : inheritedValue;
  return ({ start: 'min', 'flex-start': 'min', center: 'center', end: 'max', 'flex-end': 'max' })[
    String(selected || '').trim().toLowerCase()
  ];
}

function authoredCrossAxisCanFill(node, axis) {
  const raw = String(node.authoredStyle?.[axis === 'width' ? 'width' : 'height'] || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return true;
  return /^(?:100%|fill-available|-webkit-fill-available)$/.test(raw);
}

function fillsParentCrossAxis(node, parentSemantic, axis) {
  if (!node?.rect || !parentSemantic?.source?.rect || !authoredCrossAxisCanFill(node, axis)) return false;
  const parentLayout = parentSemantic.layout;
  if (!['flow', 'flex'].includes(parentLayout?.kind)) return false;
  const direction = parentLayout.direction || 'column';
  if ((axis === 'width' && direction !== 'column') || (axis === 'height' && direction !== 'row')) return false;

  if (parentLayout.kind === 'flex') {
    const self = String(node.style?.alignSelf || '').trim().toLowerCase();
    const parentItems = String(parentSemantic.source.style?.alignItems || '').trim().toLowerCase();
    const alignment = self && self !== 'auto' ? self : parentItems;
    if (!['', 'normal', 'stretch'].includes(alignment)) return false;
  }

  const [pt = 0, pr = 0, pb = 0, pl = 0] = parentLayout.padding || [];
  const available = axis === 'width'
    ? parentSemantic.source.rect.w - pl - pr
    : parentSemantic.source.rect.h - pt - pb;
  const measured = axis === 'width' ? node.rect.w : node.rect.h;
  return Math.abs(measured - available) <= 1;
}

function orderedDirectContent(node, semantic) {
  const texts = node.texts || [];
  const children = node.children || [];
  const explicit = node.contentOrder || [];
  if (explicit.length) {
    return coalesceAdjacentText(explicit.map((item) => item.kind === 'text'
      ? { kind: 'text', index: item.index, value: texts[item.index] }
      : { kind: 'element', index: item.index, value: children[item.index] })
      .filter((item) => item.value));
  }
  const combined = [
    ...texts.map((value, index) => ({ kind: 'text', index, value })),
    ...children.map((value, index) => ({ kind: 'element', index, value })),
  ];
  const layout = semantic?.layout;
  if (!['flex', 'flow', 'grid'].includes(layout?.kind)) return coalesceAdjacentText(combined);
  const axis = layout.kind === 'flex' && layout.direction === 'row' ? 'x' : 'y';
  return coalesceAdjacentText(combined.sort((a, b) => finite(a.value.rect?.[axis]) - finite(b.value.rect?.[axis])));
}

function coalesceAdjacentText(items) {
  const output = [];
  for (const item of items) {
    const previous = output[output.length - 1];
    if (item.kind !== 'text' || previous?.kind !== 'text') {
      output.push(item);
      continue;
    }
    const a = previous.value.rect, b = item.value.rect;
    previous.value = {
      ...previous.value,
      text: `${previous.value.text}${item.value.text}`,
      rect: {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
        h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
      },
    };
  }
  return output;
}

function autoMarginSpacer(node, parentSemantic, side) {
  if (parentSemantic?.layout?.kind !== 'flex' || node?.style?.position === 'absolute' || node?.style?.position === 'fixed') return null;
  const direction = parentSemantic.layout.direction;
  const start = direction === 'column' ? 'Top' : 'Left';
  const end = direction === 'column' ? 'Bottom' : 'Right';
  if (side !== start && side !== end) return null;
  if (String(node.authoredStyle?.[`margin${side}`] || '').trim().toLowerCase() !== 'auto') return null;
  return renderElement('frame', {
    name: `css-margin-${side.toLowerCase()}.auto`, flex: 'col', grow: 1,
    w: direction === 'column' ? 'fill' : 1,
    h: direction === 'column' ? 1 : 'fill',
  });
}

function measuredFlowSpacer(size, direction, index) {
  if (!(size > 0.5)) return null;
  return renderElement('frame', {
    name: `css-flow-gap.${index}`, flex: 'col',
    w: direction === 'column' ? 'fill' : round(size),
    h: direction === 'column' ? round(size) : 'fill',
  });
}

function textSizingForContainer(text, node, semantic) {
  if (!['trivial-centered-grid', 'single-centered-text-control'].includes(semantic?.layout?.source)) return null;
  const [, pr = 0, , pl = 0] = semantic.layout.padding || [];
  const availableWidth = Math.max(1, node.rect.w - pl - pr);
  const fillsTrack = text.rect.w >= availableWidth - 1;
  return fillsTrack ? { width: 'fill', align: 'center' } : { width: 'hug' };
}

function renderNode(node, parentRect, state, { root = false, suffix = '', forceLocal = null, semantic = null, parentSemantic = null, slotIndex = null } = {}) {
  if (!node?.rect || node.rect.w <= 0 || node.rect.h <= 0 || node.style?.display === 'none') return null;
  state.elementCount++;
  const local = forceLocal || {
    x: node.rect.x - parentRect.x,
    y: node.rect.y - parentRect.y,
    w: node.rect.w,
    h: node.rect.h,
  };
  const { props, borders } = visualProps(node.style || {}, local, { root, semantic });
  props.name = nodeName(node, suffix);
  if (!root && (!semantic || semantic.positioning.kind === 'absolute')) {
    props.x = round(local.x);
    props.y = round(local.y);
  }
  if (semantic && parentSemantic?.layout?.kind === 'grid') {
    if (parentSemantic.layout.source === 'space-around.equal-slots' && slotIndex !== null) {
      semantic.gridCell = parentSemantic.layout.direction === 'row'
        ? { row: 1, column: slotIndex + 1, rowSpan: 1, columnSpan: 1 }
        : { row: slotIndex + 1, column: 1, rowSpan: 1, columnSpan: 1 };
      props.gridHAlign = 'center';
      props.gridVAlign = 'center';
    }
    props.gridHAlign = props.gridHAlign || gridItemAlignment(
      node.style?.justifySelf,
      parentSemantic.layout.justifyItems,
    );
    props.gridVAlign = props.gridVAlign || gridItemAlignment(
      node.style?.alignSelf,
      parentSemantic.layout.items,
    );
    if (semantic.gridCell.row) props.gridRow = semantic.gridCell.row;
    if (semantic.gridCell.column) props.gridColumn = semantic.gridCell.column;
    if (semantic.gridCell.rowSpan) props.gridRowSpan = semantic.gridCell.rowSpan;
    if (semantic.gridCell.columnSpan) props.gridColumnSpan = semantic.gridCell.columnSpan;
    if (semantic.positioning.kind === 'flow') {
      const columnTracks = parentSemantic.layout.columns.slice(
        Math.max(0, (semantic.gridCell.column || 1) - 1),
        Math.max(1, (semantic.gridCell.column || 1) - 1 + (semantic.gridCell.columnSpan || 1)),
      );
      const rowTracks = parentSemantic.layout.rows.slice(
        Math.max(0, (semantic.gridCell.row || 1) - 1),
        Math.max(1, (semantic.gridCell.row || 1) - 1 + (semantic.gridCell.rowSpan || 1)),
      );
      const allocatedWidth = gridTrackSpanSize(parentSemantic.source, parentSemantic.layout, semantic.gridCell, 'column');
      const allocatedHeight = gridTrackSpanSize(parentSemantic.source, parentSemantic.layout, semantic.gridCell, 'row');
      const widthFills = allocatedWidth !== null && Math.abs(node.rect.w - allocatedWidth) <= 1
        && !columnTracks.some((track) => track.kind === 'hug');
      const heightFills = allocatedHeight !== null && Math.abs(node.rect.h - allocatedHeight) <= 1
        && !rowTracks.some((track) => track.kind === 'hug');
      props.w = widthFills ? 'fill' : round(node.rect.w);
      props.h = heightFills ? 'fill' : round(node.rect.h);
    }
  }
  if (semantic && parentSemantic?.layout?.kind === 'flex' && semantic.positioning.kind === 'flow') {
    if (semantic.sizing.grow > 0) props.grow = semantic.sizing.grow;
  }
  if (semantic?.positioning?.kind === 'flow' && parentSemantic) {
    if (fillsParentCrossAxis(node, parentSemantic, 'width')) props.w = 'fill';
    if (fillsParentCrossAxis(node, parentSemantic, 'height')) props.h = 'fill';
  }
  if (semantic?.component && !root) {
    const link = semantic.component;
    const instanceProps = {
      entity: link.entityId,
      name: props.name,
      key: link.key,
      id: link.id,
      component: !link.key && !link.id ? link.name : undefined,
      variant: node.sourceIdentity?.variant || link.variant,
      w: props.w,
      h: props.h,
      x: props.x,
      y: props.y,
      position: props.position,
      grow: props.grow,
      gridRow: props.gridRow,
      gridColumn: props.gridColumn,
      gridRowSpan: props.gridRowSpan,
      gridColumnSpan: props.gridColumnSpan,
      gridHAlign: props.gridHAlign,
      gridVAlign: props.gridVAlign,
    };
    return renderElement('instance', instanceProps);
  }
  if (node.svg) return svgIcon(node, parentRect, state, props);
  const layers = [];
  const before = renderPseudo(node.before, node.rect, state, semantic);
  if (before) { layers.push(before); state.pseudoCount++; }
  const glyphIcon = semantic && node.iconRole?.source === 'glyph';
  if (glyphIcon && ['builtin-icon', 'project-icon'].includes(semantic.asset?.kind)) {
    const color = cssColor(node.style?.color) || '#000000';
    const glyphText = (node.texts || []).find((text) => String(text.text || '').trim() === String(node.iconRole?.glyph || '').trim())
      || node.texts?.[0];
    const iconSize = Math.max(1, px(glyphText?.style?.fontSize, Math.min(node.rect.w, node.rect.h)));
    const iconX = glyphText ? glyphText.rect.x - node.rect.x + (glyphText.rect.w - iconSize) / 2 : (node.rect.w - iconSize) / 2;
    const iconY = glyphText ? glyphText.rect.y - node.rect.y + (glyphText.rect.h - iconSize) / 2 : (node.rect.h - iconSize) / 2;
    layers.push(renderElement('icon', {
      name: semantic.asset.name, color, position: 'absolute',
      x: round(iconX), y: round(iconY), w: round(iconSize), h: round(iconSize),
    }));
  } else if (glyphIcon) {
    const iconName = `unresolved-${String(node.iconRole.name || 'icon').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    layers.push(renderElement('icon', { name: iconName, w: round(node.rect.w), h: round(node.rect.h) }));
  } else {
    const directContent = orderedDirectContent(node, semantic);
    const nativeDistributedMainAxis = semantic?.layout?.kind === 'flex'
      && semantic.layout.justify === 'between';
    const preserveMeasuredFlowGaps = semantic?.layout?.kind === 'flow'
      || (semantic?.layout?.kind === 'flex'
        && !(semantic.layout.gap > 0)
        && !nativeDistributedMainAxis);
    const nativeLeadingMainAxis = semantic?.layout?.kind === 'flex'
      && ['center', 'end'].includes(semantic.layout.justify);
    const flowDirection = semantic?.layout?.direction || 'column';
    const flowAxis = flowDirection === 'column' ? 'y' : 'x';
    const flowExtent = flowDirection === 'column' ? 'h' : 'w';
    const [paddingTop = 0, , , paddingLeft = 0] = semantic?.layout?.padding || [];
    let previousFlowEnd = (flowDirection === 'column' ? node.rect.y + paddingTop : node.rect.x + paddingLeft);
    let hasPreviousFlowItem = false;
    for (let directIndex = 0; directIndex < directContent.length; directIndex++) {
      const item = directContent[directIndex];
      const childSemantic = item.kind === 'element' ? semantic?.children[item.index] : null;
      const participatesInFlow = item.kind === 'text' || childSemantic?.positioning?.kind === 'flow';
      const leadingAutoSide = flowDirection === 'column' ? 'Top' : 'Left';
      const hasLeadingAutoMargin = item.kind === 'element'
        && String(item.value.authoredStyle?.[`margin${leadingAutoSide}`] || '').trim().toLowerCase() === 'auto';
      if (preserveMeasuredFlowGaps
        && participatesInFlow
        && !hasLeadingAutoMargin
        && !(nativeLeadingMainAxis && !hasPreviousFlowItem)) {
        const gap = finite(item.value.rect?.[flowAxis]) - previousFlowEnd;
        const spacer = measuredFlowSpacer(gap, flowDirection, directIndex);
        if (spacer) layers.push(spacer);
      }
      if (item.kind === 'text') {
        layers.push(textLayer(item.value, node.rect, item.index, {
          owner: node,
          positioned: !semantic || semantic.layout.kind === 'leaf',
          gridCell: semantic ? textGridCell(item.value, node, semantic.layout, directIndex) : null,
          sizing: textSizingForContainer(item.value, node, semantic),
          gridAlign: semantic?.layout?.source === 'space-around.equal-slots',
        }));
        state.textCount++;
      } else {
        const beforeSpacer = autoMarginSpacer(item.value, semantic, semantic?.layout?.direction === 'column' ? 'Top' : 'Left');
        if (beforeSpacer) layers.push(beforeSpacer);
        const rendered = renderNode(item.value, node.rect, state, {
          semantic: semantic?.children[item.index] || null,
          parentSemantic: semantic,
          slotIndex: directIndex,
        });
        if (rendered) layers.push(rendered);
        const afterSpacer = autoMarginSpacer(item.value, semantic, semantic?.layout?.direction === 'column' ? 'Bottom' : 'Right');
        if (afterSpacer) layers.push(afterSpacer);
      }
      if (participatesInFlow) {
        previousFlowEnd = finite(item.value.rect?.[flowAxis]) + finite(item.value.rect?.[flowExtent]);
        hasPreviousFlowItem = true;
      }
    }
  }
  const after = renderPseudo(node.after, node.rect, state, semantic);
  if (after) { layers.push(after); state.pseudoCount++; }
  return renderElement('frame', props, layers, '', {
    ...(semantic?.fallbackAnnotations?.length ? { fallbackAnnotations: semantic.fallbackAnnotations } : {}),
  });
}

function projectDomCapture(capture, { projectIcons = {}, componentLinks = {} } = {}) {
  if (!capture || typeof capture !== 'object' || !capture.root?.rect || !capture.root?.style) {
    throw new Error('Invalid DOM capture: expected { root: { rect, style, children } }');
  }
  const iconNames = Object.keys(projectIcons);
  const resolveProjectIcon = (iconRole) => {
    const requested = String(iconRole?.name || '');
    if (Object.hasOwn(projectIcons, requested)) return requested;
    const matches = iconNames.filter((name) => name.toLowerCase() === requested.toLowerCase());
    return matches.length === 1 ? matches[0] : null;
  };
  const resolveComponent = (entityId, sourceIdentity = {}) => {
    const linked = typeof componentLinks === 'function'
      ? componentLinks(entityId, sourceIdentity)
      : componentLinks?.[entityId];
    if (!linked) return null;
    const key = sourceIdentity.componentKey || linked.key || null;
    const id = sourceIdentity.componentNodeId || linked.id || null;
    if (!key && !id && !linked.name) return null;
    return {
      entityId,
      ...(key ? { key } : {}),
      ...(id ? { id } : {}),
      ...(!key && !id && linked.name ? { name: linked.name } : {}),
      ...(sourceIdentity.variant || linked.variant ? { variant: sourceIdentity.variant || linked.variant } : {}),
    };
  };
  const semantic = capture.version >= 2
    ? domCaptureToSemanticModel(capture, { resolveProjectIcon, resolveComponent })
    : null;
  const state = { icons: {}, iconIndex: 0, borderIndex: 0, elementCount: 0, textCount: 0, pseudoCount: 0 };
  const tree = renderNode(capture.root, capture.root.rect, state, { root: true, semantic: semantic?.root || null });
  return {
    tree,
    icons: state.icons,
    semanticModel: semantic,
    diagnostics: {
      elements: state.elementCount,
      texts: state.textCount,
      pseudos: state.pseudoCount,
      svgs: state.iconIndex,
      borderVectors: state.borderIndex,
      width: round(capture.root.rect.w),
      height: round(capture.root.rect.h),
      ...(semantic ? { semantic: semantic.diagnostics } : {}),
    },
  };
}

export function domCaptureToJsx(capture, options = {}) {
  const projection = projectDomCapture(capture, options);
  return { ...projection, jsx: renderTreeToJsx(projection.tree) };
}

/** Direct DOM adapter into the executable plan contract. The compatibility
 * JSX string remains available to callers, but this path never serializes or
 * reparses it. Rich capture diagnostics remain authoritative on the plan. */
export function domCaptureToRenderPlan(capture, options = {}) {
  const projection = projectDomCapture(capture, options);
  const tree = renderTreeToParsedTree(projection.tree);
  const executableModel = jsxTreeToSemanticModel(tree.props, tree.children, {
    isIconResolved: (name) => Boolean(projection.icons[name]),
    resolveIconAsset: (name) => {
      const projectSvg = options.projectIcons?.[name];
      const capturedSvg = projection.icons[name];
      const builtinSvg = projectSvg || capturedSvg ? null : getBuiltinIconSvg(name);
      const svg = projectSvg || capturedSvg || builtinSvg;
      if (!svg) return null;
      return {
        kind: projectSvg ? 'project-icon' : capturedSvg ? 'captured-svg' : 'builtin-icon',
        name: String(name || 'Icon'),
        svg,
      };
    },
  });
  const renderPlan = createSemanticRenderPlan({
    ...executableModel,
    diagnostics: projection.semanticModel?.diagnostics || executableModel.diagnostics,
  }, {
    adapter: 'dom-capture',
    provenance: { captureVersion: Number(capture.version || 1) },
    variableCollection: options.variableCollection || null,
    componentLinks: options.componentLinks || null,
  });
  return { ...projection, renderPlan };
}
