// Closed, bounded authoring grammar for Semantic JSX element properties.
//
// This is agent-facing syntax, not a projection of arbitrary CSS or Figma
// Plugin fields. Suggestions may only target a property accepted by the
// addressed element.

const layout = [
  'name', 'flex', 'gap', 'rowGap', 'columnGap', 'wrapGap', 'counterAxisSpacing', 'wrap',
  'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'padding',
  'justify', 'items', 'align', 'grow', 'stretch', 'hug',
  'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
  'position', 'x', 'y', 'top', 'right', 'bottom', 'left', 'centerOffsetX', 'centerOffsetY',
  'gridRows', 'gridColumns', 'gridAutoFlow', 'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan',
  'gridHAlign', 'gridVAlign',
];
const paint = [
  'bg', 'fill', 'stroke', 'strokeWidth', 'strokeAlign', 'strokeDashPattern', 'strokeCap',
  'strokeTopWidth', 'strokeRightWidth', 'strokeBottomWidth', 'strokeLeftWidth', 'opacity', 'blendMode',
  'image', 'imageScale', 'visible', 'locked', 'clip', 'overflow', 'rotate', 'mask', 'maskType',
];
const corners = [
  'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing',
];
const effects = [
  'shadow', 'innerShadow', 'blur', 'bgBlur', 'filter',
  'noise', 'noiseDensity', 'noiseSize', 'noiseColor', 'noiseColor2', 'noiseOpacity',
  'texture', 'textureSize', 'textureRadius', 'textureClip',
  'progressiveBlur', 'progressiveBlurDir', 'progressiveBlurStart',
  'glass', 'glassRefraction', 'glassDepth', 'glassRadius', 'glassDispersion', 'glassLight', 'glassLightAngle',
];

const props = {
  Frame: ['entity', ...layout, ...paint, ...corners, ...effects],
  Text: [
    'name', 'size', 'weight', 'color', 'font', 'fontStyle', 'italic', 'align',
    'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH', 'grow', 'opacity',
    'x', 'y', 'position', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent',
    'truncate', 'maxLines', 'style', 'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan',
    'gridHAlign', 'gridVAlign', 'fontAxes', 'mask', 'maskType',
  ],
  Icon: [
    'name', 'size', 's', 'w', 'h', 'width', 'height', 'color', 'c', 'preserveColors',
    'x', 'y', 'position', 'opacity', 'rotate', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType',
  ],
  Rect: [
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH', 'bg', 'fill',
    'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing',
    'blendMode', 'opacity', 'x', 'y', 'position', 'filter', 'gridRow', 'gridColumn',
    'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType',
  ],
  Ellipse: [
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH', 'bg', 'fill',
    'stroke', 'strokeWidth', 'strokeAlign', 'strokeDashPattern', 'strokeCap', 'arc', 'arcStart',
    'innerRadius', 'opacity', 'x', 'y', 'position', 'filter', 'gridRow', 'gridColumn',
    'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType',
  ],
  Image: [
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH', 'bg', 'fill',
    'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing',
    'blendMode', 'opacity', 'x', 'y', 'position', 'src', 'imageScale', 'filter', 'gridRow',
    'gridColumn', 'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType',
  ],
  Slot: ['name', 'flex', 'gap', 'p', 'px', 'py', 'padding', 'w', 'h', 'width', 'height', 'bg', 'fill'],
  Instance: [
    'entity', 'name', 'component', 'id', 'key', 'variant', 'w', 'h', 'width', 'height',
    'minW', 'maxW', 'minH', 'maxH', 'grow', 'opacity', 'x', 'y', 'position',
    'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign',
  ],
};
props.Rectangle = props.Rect;
props.Circle = props.Ellipse;

export const SEMANTIC_JSX_PROPS = Object.freeze(Object.fromEntries(
  Object.entries(props).map(([element, values]) => [element, Object.freeze([...values])]),
));
export const SEMANTIC_JSX_ELEMENTS = Object.freeze(Object.keys(SEMANTIC_JSX_PROPS));

const commonAliases = Object.freeze({
  layout: 'flex',
  direction: 'flex',
  flexDirection: 'flex',
  cornerRadius: 'rounded',
  borderRadius: 'rounded',
  background: 'bg',
  backgroundColor: 'bg',
  border: 'stroke',
  borderColor: 'stroke',
  borderWidth: 'strokeWidth',
  fontSize: 'size',
  fontWeight: 'weight',
  fontFamily: 'font',
  textAlign: 'align',
  spacing: 'gap',
  itemSpacing: 'gap',
  alignItems: 'items',
  justifyContent: 'justify',
  visibility: 'visible',
});

const elementAliases = Object.freeze({
  Text: Object.freeze({ fill: 'color', paint: 'color', foregroundColor: 'color' }),
  Icon: Object.freeze({ fill: 'color', paint: 'color', foregroundColor: 'color' }),
  Ellipse: Object.freeze({ background: 'fill', backgroundColor: 'fill' }),
  Circle: Object.freeze({ background: 'fill', backgroundColor: 'fill' }),
  Instance: Object.freeze({ componentId: 'id', componentKey: 'key' }),
});

function elementName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const lowered = value.toLowerCase();
  return SEMANTIC_JSX_ELEMENTS.find((element) => element.toLowerCase() === lowered) || null;
}

function aliasesFor(element) {
  const valid = new Set(SEMANTIC_JSX_PROPS[element]);
  return Object.freeze(Object.fromEntries(Object.entries({
    ...commonAliases,
    ...(elementAliases[element] || {}),
  }).filter(([, target]) => valid.has(target))));
}

export function semanticJsxPropsForElement(value) {
  const element = elementName(value);
  return element ? SEMANTIC_JSX_PROPS[element] : null;
}

export function semanticJsxPropSuggestion(elementValue, prop) {
  const element = elementName(elementValue);
  if (!element || typeof prop !== 'string') return null;
  const alias = aliasesFor(element)[prop];
  if (alias) return alias;
  const valid = SEMANTIC_JSX_PROPS[element];
  const levenshtein = (a, b) => {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, index) => [index, ...Array(n).fill(0)]);
    for (let index = 0; index <= n; index++) d[0][index] = index;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return d[m][n];
  };
  let best = null;
  let bestDistance = 3;
  for (const candidate of valid) {
    const distance = levenshtein(prop.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function semanticJsxPropReference(value) {
  const element = elementName(value);
  if (!element) {
    throw new Error(`Unknown Semantic JSX element. Supported elements: ${SEMANTIC_JSX_ELEMENTS.join(', ')}.`);
  }
  return Object.freeze({
    version: 1,
    element,
    props: SEMANTIC_JSX_PROPS[element],
    aliases: aliasesFor(element),
    dynamicPrefixes: Object.freeze(element === 'Instance'
      ? ['prop:', 'text:', 'fill:', 'swap:']
      : []),
  });
}

export function formatSemanticJsxPropReference(reference) {
  const checked = semanticJsxPropReference(reference?.element);
  const lines = [
    `Semantic JSX props for <${checked.element}> (${checked.props.length})`,
    `  ${checked.props.join(', ')}`,
  ];
  const aliases = Object.entries(checked.aliases);
  if (aliases.length) {
    lines.push('Reviewed aliases:');
    for (const [source, target] of aliases) lines.push(`  ${source} → ${target}`);
  }
  if (checked.dynamicPrefixes.length) {
    lines.push(`Dynamic prefixes: ${checked.dynamicPrefixes.join(', ')}`);
  }
  return lines.join('\n');
}
