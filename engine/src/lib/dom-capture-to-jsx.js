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
import { bindSemanticDesignEntities } from './design-entity-bindings.js';
import { getBuiltinIconSvg } from './builtin-icons.js';
import { cssAnimationToMotion, repeatMotionToTimeline } from './motion-css.js';

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
  // Structured props (motion tracks) only exist on the executable plan; the
  // compatibility JSX string cannot carry them.
  return Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== '' && typeof value !== 'object')
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
  const tag = { frame: 'Frame', text: 'Text', icon: 'Icon', image: 'Image', instance: 'Instance' }[node.type];
  if (!tag) throw new Error(`Unsupported DOM render element type: ${node.type}`);
  const attributes = propsString(node.props);
  const opening = `<${tag}${attributes ? ` ${attributes}` : ''}`;
  if (node.type === 'text') return `${opening}>${esc(node.content)}</Text>`;
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

const IMAGE_PROP_KEYS = Object.freeze([
  'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
  'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR',
  'cornerSmoothing', 'opacity', 'visible', 'rotate', 'position', 'x', 'y',
  'grow',
  'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan', 'gridHAlign',
  'gridVAlign', 'filter', 'blendMode', 'mask', 'maskType',
]);

function imageProps(layoutProps) {
  return Object.fromEntries(IMAGE_PROP_KEYS
    .filter((key) => layoutProps[key] !== undefined)
    .map((key) => [key, layoutProps[key]]));
}

function positionToken(token, axis) {
  const source = String(token || '').trim().toLowerCase();
  const fractions = axis === 'x'
    ? { left: 0, center: 0.5, right: 1 }
    : { top: 0, center: 0.5, bottom: 1 };
  if (Object.hasOwn(fractions, source)) return { kind: 'fraction', value: fractions[source] };
  if (/^-?\d*\.?\d+%$/.test(source)) return { kind: 'fraction', value: Number(source.slice(0, -1)) / 100 };
  if (/^-?\d*\.?\d+px$/.test(source)) return { kind: 'length', value: Number(source.slice(0, -2)) };
  return null;
}

function parseObjectPosition(value) {
  const tokens = String(value || '50% 50%').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const vertical = positionToken(tokens[0], 'y');
    const horizontal = positionToken(tokens[0], 'x');
    if (['top', 'bottom'].includes(tokens[0].toLowerCase()) && vertical) {
      return { x: { kind: 'fraction', value: 0.5 }, y: vertical, exact: true };
    }
    if (horizontal) return { x: horizontal, y: { kind: 'fraction', value: 0.5 }, exact: true };
  }
  if (tokens.length === 2) {
    let x = positionToken(tokens[0], 'x');
    let y = positionToken(tokens[1], 'y');
    if (!x || !y) {
      x = positionToken(tokens[1], 'x');
      y = positionToken(tokens[0], 'y');
    }
    if (x && y) return { x, y, exact: true };
  }
  return {
    x: { kind: 'fraction', value: 0.5 },
    y: { kind: 'fraction', value: 0.5 },
    exact: false,
  };
}

function positionedOffset(position, freeSpace) {
  return position.kind === 'length' ? position.value : freeSpace * position.value;
}

function centeredPosition(position) {
  return position.kind === 'fraction' && Math.abs(position.value - 0.5) < 1e-9;
}

/** Map CSS replaced-image geometry to native Figma image behavior. Direct
 * FIT/CROP is used only when its fixed center alignment is exact; otherwise a
 * clipped native wrapper retains the authored position without an opaque crop
 * matrix convention. */
export function cssImageLayout({
  boxWidth,
  boxHeight,
  intrinsicWidth,
  intrinsicHeight,
  objectFit = 'fill',
  objectPosition = '50% 50%',
}) {
  const boxW = finite(boxWidth);
  const boxH = finite(boxHeight);
  const sourceW = finite(intrinsicWidth);
  const sourceH = finite(intrinsicHeight);
  const fit = String(objectFit || 'fill').trim().toLowerCase();
  if (!(boxW > 0 && boxH > 0 && sourceW > 0 && sourceH > 0)) {
    throw new Error('DOM image needs positive box and intrinsic dimensions');
  }
  if (!['contain', 'cover', 'fill', 'none', 'scale-down'].includes(fit)) {
    throw new Error(`DOM image object-fit ${fit} is unsupported`);
  }
  if (fit === 'fill') return Object.freeze({ kind: 'native', imageScale: 'fill' });

  const position = parseObjectPosition(objectPosition);
  const containScale = Math.min(boxW / sourceW, boxH / sourceH);
  const scale = fit === 'cover' ? Math.max(boxW / sourceW, boxH / sourceH)
    : fit === 'none' ? 1
      : fit === 'scale-down' ? Math.min(1, containScale)
        : containScale;
  const width = sourceW * scale;
  const height = sourceH * scale;
  const centered = centeredPosition(position.x) && centeredPosition(position.y);
  if (position.exact && centered && fit === 'contain') {
    return Object.freeze({ kind: 'native', imageScale: 'fit' });
  }
  if (position.exact && centered && fit === 'cover') {
    return Object.freeze({ kind: 'native', imageScale: 'crop' });
  }
  if (position.exact && centered && fit === 'scale-down' && containScale < 1) {
    return Object.freeze({ kind: 'native', imageScale: 'fit' });
  }
  const fallbackAnnotations = position.exact ? [] : [{
    policy: 'dom.image-object-position',
    labelMarkdown: `CSS object-position could not be represented exactly; centered fallback retained for review: ${String(objectPosition).replace(/[\u0000-\u001f]/g, ' ').slice(0, 160)}`,
    properties: ['fills', 'width', 'height'],
  }];
  return Object.freeze({
    kind: 'wrapper',
    imageScale: 'fill',
    width: round(width),
    height: round(height),
    x: round(positionedOffset(position.x, boxW - width)),
    y: round(positionedOffset(position.y, boxH - height)),
    fallbackAnnotations: Object.freeze(fallbackAnnotations),
  });
}

function domImage(node, state, layoutProps = {}) {
  const asset = node.asset;
  if (!asset || asset.kind === 'image') {
    throw new Error(`DOM image asset was not resolved host-side: ${String(asset?.src || 'missing source')}`);
  }
  if (asset.kind !== 'embedded-raster') {
    throw new Error(`DOM image asset kind ${String(asset.kind || 'missing')} is unsupported`);
  }
  const key = `dom-image-${Object.keys(state.images).length + 1}`;
  state.images[key] = asset.base64;
  state.imageAssets[key] = asset;
  const objectFit = String(node.style?.objectFit || '').toLowerCase();
  const layout = cssImageLayout({
    boxWidth: node.rect.w,
    boxHeight: node.rect.h,
    intrinsicWidth: asset.width,
    intrinsicHeight: asset.height,
    objectFit: objectFit || 'fill',
    objectPosition: node.style?.objectPosition || '50% 50%',
  });
  const directProps = imageProps(layoutProps);
  if (layout.kind === 'native') {
    return renderElement('image', {
      ...directProps,
      src: `imgref:${key}`,
      imageScale: layout.imageScale,
    });
  }
  const wrapperProps = {
    ...layoutProps,
    flex: 'none',
    clip: 'true',
  };
  const paint = renderElement('image', {
    name: `${layoutProps.name || 'Image'}.object-fit-paint`,
    src: `imgref:${key}`,
    imageScale: layout.imageScale,
    position: 'absolute',
    x: layout.x,
    y: layout.y,
    w: layout.width,
    h: layout.height,
  });
  return renderElement('frame', wrapperProps, [paint], '', {
    ...(layout.fallbackAnnotations.length ? { fallbackAnnotations: layout.fallbackAnnotations } : {}),
  });
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
    // Figma Auto Layout has no container-side STRETCH enum. CSS stretch is
    // represented by FILL sizing on each flow child (including direct Text),
    // so emitting items="stretch" would make the Plugin reject the render.
    if (layout.items && !['start', 'stretch'].includes(layout.items)) props.items = layout.items;
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
  // Keep the executable render tree as literal DOM text. Only the legacy JSX
  // projection escapes markup characters; the direct Render Plan bypasses an
  // HTML parser and must not turn a literal `&` into visible `&amp;` copy.
  return renderElement('text', props, [], transformedText);
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
  let markup = String(node.svg).replace(/currentColor/g, color);
  if (!/^\s*<svg\b[^>]*\sxmlns\s*=/i.test(markup)) {
    markup = markup.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  state.icons[iconName] = markup;
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
  const bt = border(parentSemantic.source.style, 'Top')?.width || 0;
  const br = border(parentSemantic.source.style, 'Right')?.width || 0;
  const bb = border(parentSemantic.source.style, 'Bottom')?.width || 0;
  const bl = border(parentSemantic.source.style, 'Left')?.width || 0;
  const available = axis === 'width'
    ? parentSemantic.source.rect.w - pl - pr - bl - br
    : parentSemantic.source.rect.h - pt - pb - bt - bb;
  const measured = axis === 'width' ? node.rect.w : node.rect.h;
  return Math.abs(measured - available) <= 1;
}

function wrappingTextConsumesAvailableWidth(node, parentSemantic) {
  if (!node?.rect || parentSemantic?.layout?.kind !== 'flex'
    || parentSemantic.layout.direction !== 'column' || !(node.texts || []).length) return false;
  const multiline = node.texts.some((text) => text.rect?.h > px(text.style?.fontSize, 14) * 1.6);
  if (!multiline || !node.texts.some((text) => textCanWrap(text.style))) return false;
  const [, pr = 0, , pl = 0] = parentSemantic.layout.padding || [];
  const br = border(parentSemantic.source.style, 'Right')?.width || 0;
  const bl = border(parentSemantic.source.style, 'Left')?.width || 0;
  const available = parentSemantic.source.rect.w - pl - pr - bl - br;
  return available > 0 && Math.abs(node.rect.w - available) <= 1;
}

function intrinsicSingleLineTextContainer(node, semantic) {
  if (!node?.rect || !semantic || semantic.positioning?.kind !== 'flow'
    || ['trivial-centered-grid', 'single-centered-text-control'].includes(semantic.layout?.source)
    || !(node.texts || []).length || (node.children || []).some((child) => isRenderableDirectItem({ kind: 'element', value: child }))) {
    return false;
  }
  const authoredWidth = String(node.authoredStyle?.width || '').trim().toLowerCase();
  const authoredHeight = String(node.authoredStyle?.height || '').trim().toLowerCase();
  if ((authoredWidth && authoredWidth !== 'auto') || semantic.sizing?.grow > 0) return false;
  if (node.texts.some((text) => text.rect?.h > px(text.style?.fontSize, 14) * 1.6)) return false;

  const left = Math.min(...node.texts.map((text) => text.rect.x));
  const right = Math.max(...node.texts.map((text) => text.rect.x + text.rect.w));
  const top = Math.min(...node.texts.map((text) => text.rect.y));
  const bottom = Math.max(...node.texts.map((text) => text.rect.y + text.rect.h));
  const [pt = 0, pr = 0, pb = 0, pl = 0] = semantic.layout?.padding || [];
  const bt = border(node.style, 'Top')?.width || 0;
  const br = border(node.style, 'Right')?.width || 0;
  const bb = border(node.style, 'Bottom')?.width || 0;
  const bl = border(node.style, 'Left')?.width || 0;
  const intrinsicWidth = right - left + pl + pr + bl + br;
  const intrinsicHeight = bottom - top + pt + pb + bt + bb;
  return {
    width: Math.abs(node.rect.w - intrinsicWidth) <= 2,
    height: (!authoredHeight || authoredHeight === 'auto')
      && Math.abs(node.rect.h - intrinsicHeight) <= 2,
  };
}

function orderedDirectContent(node, semantic) {
  const texts = node.texts || [];
  const children = node.children || [];
  const explicit = node.contentOrder || [];
  if (explicit.length) {
    return coalesceAdjacentText(explicit.map((item) => {
      if (item.kind === 'text') return { kind: 'text', index: item.index, value: texts[item.index] };
      const child = children[item.index];
      // Capture v2 originally represented BR as a zero-sized element. Treat
      // it as authored text intent at the adapter boundary so old captures do
      // not concatenate lines after the visual BR node is filtered out.
      if (String(child?.tag || '').toLowerCase() === 'br') {
        return {
          kind: 'text', index: `br-${item.index}`,
          value: {
            text: '\n',
            rect: {
              x: node.rect.x, y: node.rect.y, w: 1,
              h: Math.max(1, px(node.style?.lineHeight, px(node.style?.fontSize, 14))),
            },
            style: node.style || {},
          },
        };
      }
      return { kind: 'element', index: item.index, value: child };
    })
      .filter(isRenderableDirectItem));
  }
  const combined = [
    ...texts.map((value, index) => ({ kind: 'text', index, value })),
    ...children.map((value, index) => ({ kind: 'element', index, value })),
  ];
  const layout = semantic?.layout;
  const renderable = combined.filter(isRenderableDirectItem);
  if (!['flex', 'flow', 'grid'].includes(layout?.kind)) return coalesceAdjacentText(renderable);
  const axis = layout.kind === 'flex' && layout.direction === 'row' ? 'x' : 'y';
  return coalesceAdjacentText(renderable.sort((a, b) => finite(a.value.rect?.[axis]) - finite(b.value.rect?.[axis])));
}

function isRenderableDirectItem(item) {
  if (!item?.value?.rect || item.value.rect.w <= 0 || item.value.rect.h <= 0) return false;
  if (item.kind === 'text') return true;
  const display = String(item.value.style?.display || '').toLowerCase();
  const visibility = String(item.value.style?.visibility || '').toLowerCase();
  return display !== 'none' && !['hidden', 'collapse'].includes(visibility);
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

function autoCrossMarginWrapper(node, parentSemantic, rendered) {
  if (!rendered || parentSemantic?.layout?.kind !== 'flex'
    || node?.style?.position === 'absolute' || node?.style?.position === 'fixed') return rendered;
  const direction = parentSemantic.layout.direction;
  const leading = direction === 'column' ? 'Left' : 'Top';
  const trailing = direction === 'column' ? 'Right' : 'Bottom';
  const leadingAuto = String(node.authoredStyle?.[`margin${leading}`] || '').trim().toLowerCase() === 'auto';
  const trailingAuto = String(node.authoredStyle?.[`margin${trailing}`] || '').trim().toLowerCase() === 'auto';
  if (!leadingAuto && !trailingAuto) return rendered;

  // Figma Auto Layout has no per-child equivalent for CSS cross-axis auto
  // margins. Preserve the authored relationship with one editable, fill-sized
  // wrapper instead of freezing the browser's measured x/y position.
  const justify = leadingAuto && trailingAuto ? 'center' : leadingAuto ? 'end' : 'start';
  const logicalAxis = direction === 'column' ? 'inline' : 'block';
  const autoSide = leadingAuto ? leading : trailing;
  const suffix = leadingAuto && trailingAuto ? 'auto' : `${autoSide.toLowerCase()}-auto`;
  return renderElement('frame', {
    name: `css-margin-${logicalAxis}.${suffix}`,
    flex: direction === 'column' ? 'row' : 'col',
    w: direction === 'column' ? 'fill' : round(node.rect.w),
    h: direction === 'column' ? round(node.rect.h) : 'fill',
    justify,
  }, [rendered]);
}

function measuredFlowWrapper(size, direction, index, child) {
  if (!(size > 0.5)) return null;
  return renderElement('frame', {
    name: `css-flow-offset.${index}`,
    flex: direction === 'column' ? 'col' : 'row',
    w: direction === 'column' ? 'fill' : 'hug',
    h: direction === 'column' ? 'hug' : 'fill',
    pt: direction === 'column' ? round(size) : undefined,
    pl: direction === 'row' ? round(size) : undefined,
  }, [child]);
}

function normalizedTextAlignment(value) {
  return ({ start: 'left', end: 'right', justify: 'justified' })[
    String(value || '').trim().toLowerCase()
  ] || String(value || '').trim().toLowerCase();
}

function textCanWrap(style) {
  const whiteSpace = String(style?.whiteSpace || 'normal').trim().toLowerCase();
  return !['nowrap', 'pre'].includes(whiteSpace);
}

function textSizingForContainer(text, node, semantic, containerProps = {}) {
  const layout = semantic?.layout || {};
  if (!semantic || layout.kind === 'leaf') return null;
  const [, pr = 0, , pl = 0] = layout.padding || [];
  const availableWidth = Math.max(1, node.rect.w - pl - pr);
  const fillsTrack = text.rect.w >= availableWidth - 1;
  const alignment = normalizedTextAlignment(text.style?.textAlign || node.style?.textAlign);
  const centeredControl = ['trivial-centered-grid', 'single-centered-text-control'].includes(layout.source);
  if (containerProps.w === 'hug') return { width: 'hug', align: alignment };
  const boundedContainer = containerProps.w === 'fill' || Number.isFinite(Number(containerProps.w));
  const responsiveContainer = containerProps.w === 'fill';
  const multiline = text.rect.h > px(text.style?.fontSize, 14) * 1.6;
  const needsContainerWidth = fillsTrack || multiline
    || (boundedContainer && ['center', 'right', 'justified'].includes(alignment))
    || (responsiveContainer && textCanWrap(text.style));
  return needsContainerWidth
    ? { width: 'fill', align: centeredControl ? 'center' : alignment }
    : { width: 'hug', align: alignment };
}

function intrinsicAxisCanHug(node, semantic, parentSemantic, axis) {
  if (!semantic || semantic.positioning?.kind !== 'flow' || !parentSemantic
    || semantic.component || ['leaf', 'grid'].includes(semantic.layout?.kind)
    || parentSemantic.layout?.kind === 'grid') return false;
  const authored = String(node.authoredStyle?.[axis] || '').trim().toLowerCase();
  if (authored && authored !== 'auto') return false;
  const parentLayout = parentSemantic.layout;
  const direction = parentLayout.direction || 'column';
  const isMainAxis = (axis === 'width' && direction === 'row')
    || (axis === 'height' && direction === 'column');
  if (isMainAxis && semantic.sizing?.grow > 0) return false;
  if (parentLayout.kind === 'flex' && !isMainAxis) {
    const self = String(node.style?.alignSelf || '').trim().toLowerCase();
    const inherited = String(parentSemantic.source.style?.alignItems || '').trim().toLowerCase();
    const alignment = self && self !== 'auto' ? self : inherited;
    if (['', 'normal', 'stretch'].includes(alignment)) return false;
  }
  return true;
}

function renderNode(node, parentRect, state, { root = false, suffix = '', forceLocal = null, semantic = null, parentSemantic = null, slotIndex = null } = {}) {
  if (!node?.rect || node.rect.w <= 0 || node.rect.h <= 0 || node.style?.display === 'none'
    || ['hidden', 'collapse'].includes(String(node.style?.visibility || '').toLowerCase())) return null;
  state.elementCount++;
  const local = forceLocal || {
    x: node.rect.x - parentRect.x,
    y: node.rect.y - parentRect.y,
    w: node.rect.w,
    h: node.rect.h,
  };
  const { props, borders } = visualProps(node.style || {}, local, { root, semantic });
  props.name = nodeName(node, suffix);
  if (Array.isArray(node.animation) && node.animation.length && state.keyframes) {
    // CSS animations become native Figma Motion tracks on the created layer.
    const motion = cssAnimationToMotion(node.animation, state.keyframes, node.style || {});
    if (motion) {
      props.motion = { duration: motion.duration, tracks: motion.tracks };
      state.motionCount++;
      // The frame's timeline is the longest animation on it, which is only
      // known once the whole tree is walked. fillSharedMotionTimeline also
      // flushes the limitations, because whether a loop actually got repeated
      // decides how it must be reported.
      state.motionNodes.push({ props, name: props.name, motion });
    }
  }
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
    // A flex-start item may still be clamped to all available width because
    // its copy wraps. Preserve that responsive relationship as FILL instead
    // of converting the measured browser rectangle into HUG/max-content.
    if (props.w !== 'fill' && wrappingTextConsumesAvailableWidth(node, parentSemantic)) props.w = 'fill';
    if (props.w !== 'fill' && intrinsicAxisCanHug(node, semantic, parentSemantic, 'width')) props.w = 'hug';
    if (props.h !== 'fill' && intrinsicAxisCanHug(node, semantic, parentSemantic, 'height')) props.h = 'hug';
  }
  const intrinsicText = intrinsicSingleLineTextContainer(node, semantic);
  const gridColumnTracks = parentSemantic?.layout?.kind === 'grid'
    ? parentSemantic.layout.columns.slice(
      Math.max(0, (semantic?.gridCell?.column || 1) - 1),
      Math.max(1, (semantic?.gridCell?.column || 1) - 1 + (semantic?.gridCell?.columnSpan || 1)),
    )
    : [];
  const intrinsicWidthAllowed = parentSemantic?.layout?.kind !== 'grid'
    || (gridColumnTracks.length > 0 && gridColumnTracks.every((track) => track.kind === 'hug'));
  if (intrinsicText?.width && intrinsicWidthAllowed) props.w = 'hug';
  if (intrinsicText?.height && intrinsicWidthAllowed) props.h = 'hug';
  if (semantic?.sizing?.minWidth > 0) props.minW = round(semantic.sizing.minWidth);
  if (semantic?.sizing?.minHeight > 0) props.minH = round(semantic.sizing.minHeight);
  if (semantic?.sizing?.maxWidth > 0) props.maxW = round(semantic.sizing.maxWidth);
  if (semantic?.sizing?.maxHeight > 0) props.maxH = round(semantic.sizing.maxHeight);
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
  if (node.tag === 'img' || node.asset) return domImage(node, state, props);
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
    const borderTop = border(node.style, 'Top')?.width || 0;
    const borderLeft = border(node.style, 'Left')?.width || 0;
    let previousFlowEnd = (flowDirection === 'column'
      ? node.rect.y + paddingTop + borderTop
      : node.rect.x + paddingLeft + borderLeft);
    let hasPreviousFlowItem = false;
    for (let directIndex = 0; directIndex < directContent.length; directIndex++) {
      const item = directContent[directIndex];
      const childSemantic = item.kind === 'element' ? semantic?.children[item.index] : null;
      const participatesInFlow = item.kind === 'text' || childSemantic?.positioning?.kind === 'flow';
      const leadingAutoSide = flowDirection === 'column' ? 'Top' : 'Left';
      const hasLeadingAutoMargin = item.kind === 'element'
        && String(item.value.authoredStyle?.[`margin${leadingAutoSide}`] || '').trim().toLowerCase() === 'auto';
      let measuredGap = 0;
      if (preserveMeasuredFlowGaps
        && participatesInFlow
        && !hasLeadingAutoMargin
        && !(nativeLeadingMainAxis && !hasPreviousFlowItem)) {
        measuredGap = finite(item.value.rect?.[flowAxis]) - previousFlowEnd;
      }
      let renderedItem = null;
      if (item.kind === 'text') {
        renderedItem = textLayer(item.value, node.rect, item.index, {
          owner: node,
          positioned: !semantic || semantic.layout.kind === 'leaf',
          gridCell: semantic ? textGridCell(item.value, node, semantic.layout, directIndex) : null,
          sizing: textSizingForContainer(item.value, node, semantic, props),
          gridAlign: semantic?.layout?.source === 'space-around.equal-slots',
        });
        state.textCount++;
      } else {
        const beforeSpacer = autoMarginSpacer(item.value, semantic, semantic?.layout?.direction === 'column' ? 'Top' : 'Left');
        if (beforeSpacer) layers.push(beforeSpacer);
        const rendered = renderNode(item.value, node.rect, state, {
          semantic: semantic?.children[item.index] || null,
          parentSemantic: semantic,
          slotIndex: directIndex,
        });
        if (rendered) renderedItem = autoCrossMarginWrapper(item.value, semantic, rendered);
      }
      if (renderedItem) {
        if (measuredGap > 0.5 && !hasPreviousFlowItem) {
          // A leading browser offset belongs to the container's content box:
          // typical sources are inline line-box leading or collapsed block
          // flow. Keep it editable as native padding instead of adding an
          // empty Figma child.
          if (flowDirection === 'column') props.pt = round((props.pt || 0) + measuredGap);
          else props.pl = round((props.pl || 0) + measuredGap);
          layers.push(renderedItem);
        } else if (measuredGap > 0.5) {
          // Non-uniform CSS flow spacing has no per-child Figma Auto Layout
          // property. A content-bearing padded wrapper preserves it without
          // materializing a misleading empty Frame.
          layers.push(measuredFlowWrapper(measuredGap, flowDirection, directIndex, renderedItem));
        } else {
          layers.push(renderedItem);
        }
      }
      if (item.kind === 'element') {
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
    if (sourceIdentity.componentKey && linked.key
      && sourceIdentity.componentKey !== linked.key) {
      throw new Error(`Design Entity ${entityId} has a conflicting captured component key`);
    }
    if (sourceIdentity.componentNodeId && linked.id
      && sourceIdentity.componentNodeId !== linked.id) {
      throw new Error(`Design Entity ${entityId} has a conflicting captured component node id`);
    }
    return {
      entityId,
      ...(sourceIdentity.variant || linked.variant ? { variant: sourceIdentity.variant || linked.variant } : {}),
    };
  };
  const semantic = capture.version >= 2
    ? domCaptureToSemanticModel(capture, { resolveProjectIcon, resolveComponent })
    : null;
  const state = {
    icons: {}, images: {}, imageAssets: {}, iconIndex: 0, borderIndex: 0, elementCount: 0, textCount: 0, pseudoCount: 0,
    keyframes: capture.keyframes && typeof capture.keyframes === 'object' ? capture.keyframes : null,
    motionCount: 0, motionLimitations: [], motionNodes: [],
  };
  const tree = renderNode(capture.root, capture.root.rect, state, { root: true, semantic: semantic?.root || null });
  const motionTimeline = fillSharedMotionTimeline(state);
  return {
    tree,
    icons: state.icons,
    images: state.images,
    imageAssets: state.imageAssets,
    semanticModel: semantic,
    diagnostics: {
      elements: state.elementCount,
      texts: state.textCount,
      pseudos: state.pseudoCount,
      svgs: state.iconIndex,
      borderVectors: state.borderIndex,
      width: round(capture.root.rect.w),
      height: round(capture.root.rect.h),
      ...(state.motionCount ? { motion: { nodes: state.motionCount, timeline: motionTimeline, limitations: state.motionLimitations } } : {}),
      ...(semantic ? { semantic: semantic.diagnostics } : {}),
    },
  };
}

/**
 * A Figma frame has one timeline, so every layer on it shares the longest
 * animation's duration. An endless CSS loop with a shorter period is repeated
 * to fill that timeline — otherwise it would freeze partway through while a
 * longer sibling kept moving. A period that cannot be repeated (a finite
 * iteration count, a positive delay, mixed cycles) keeps its own length and
 * says so.
 */
function fillSharedMotionTimeline(state) {
  const nodes = state.motionNodes;
  if (!nodes.length) return 0;
  const timeline = round(Math.max(...nodes.map((entry) => entry.motion.duration)));
  for (const entry of nodes) {
    const shorter = entry.motion.duration < timeline - 1e-6;
    const filled = shorter ? repeatMotionToTimeline(entry.motion, timeline) : entry.motion;
    const repeated = shorter && filled.duration >= timeline - 1e-6;
    if (repeated) entry.props.motion = { duration: filled.duration, tracks: filled.tracks };
    for (const text of entry.motion.limitations) {
      state.motionLimitations.push(`${entry.name}: ${rephraseLoopLimitation(text, { timeline, repeated })}`);
    }
    // A period the projection cannot repeat must be named even when the
    // animation itself raised no limitation: it stops while siblings move on.
    if (shorter && !repeated) {
      state.motionLimitations.push(
        `${entry.name}: the ${entry.motion.duration}s animation cannot be repeated to fill the frame's ${timeline}s timeline; the layer holds its last value afterwards`,
      );
    }
  }
  return timeline;
}

/**
 * The per-animation projection can only say that a loop is endless; whether
 * its period was repeated to fill the frame's timeline is decided afterwards.
 * Keep that report truthful instead of always claiming "one period".
 */
function rephraseLoopLimitation(text, { timeline, repeated }) {
  const match = /^animation (.+?) repeats \((.+?)\); Figma receives one (alternate )?period$/.exec(text);
  if (!match) return text;
  const [, name, iterations, alternate] = match;
  const period = `one ${alternate || ''}period`;
  return repeated
    ? `animation ${name} repeats (${iterations}); ${period} is repeated to fill the frame's ${timeline}s timeline, which Figma plays once`
    : `animation ${name} repeats (${iterations}); Figma receives ${period} and plays the ${timeline}s timeline once`;
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
    resolveImageAsset: (props) => {
      const src = String(props?.src || '');
      if (!src.startsWith('imgref:')) return null;
      const key = src.slice(7);
      const base64 = projection.images[key];
      const asset = projection.imageAssets[key];
      return base64 ? {
        kind: 'embedded-raster',
        name: props?.name || asset?.name || key || 'Image',
        base64,
        ...(asset?.width ? { width: asset.width } : {}),
        ...(asset?.height ? { height: asset.height } : {}),
      } : null;
    },
  });
  const bound = bindSemanticDesignEntities({
    ...executableModel,
    diagnostics: projection.semanticModel?.diagnostics || executableModel.diagnostics,
  }, options.designEntityProjection || {
    version: 1,
    registry: { schemaVersion: 1, sourceFingerprint: '0'.repeat(64) },
    targetConstraint: { kind: 'authenticated-session' },
    entities: {},
  });
  const renderPlan = createSemanticRenderPlan(bound.model, {
    adapter: 'dom-capture',
    provenance: {
      captureVersion: Number(capture.version || 1),
      ...(options.captureHash ? { captureHash: String(options.captureHash) } : {}),
      ...(Number.isFinite(capture.viewport?.width) && capture.viewport.width > 0
        && Number.isFinite(capture.viewport?.height) && capture.viewport.height > 0 ? {
          viewport: {
            width: round(capture.viewport.width),
            height: round(capture.viewport.height),
          },
        } : {}),
    },
    variableCollection: options.variableCollection || null,
    designEntityBindings: bound.designEntityBindings,
  });
  return { ...projection, renderPlan };
}
