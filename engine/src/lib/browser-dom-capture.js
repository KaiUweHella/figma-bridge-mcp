/**
 * Portable browser-side capture for Code -> Figma.
 *
 * Rectangles remain verification evidence. Layout, token and asset provenance
 * are first-class facts so downstream code does not have to reverse-engineer
 * CSS intent from x/y coordinates.
 */

export const CAPTURE_STYLE_PROPERTIES = Object.freeze([
  'display', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'zIndex',
  'overflow', 'opacity', 'visibility', 'boxSizing',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent',
  'justifyItems', 'placeItems',
  'alignSelf', 'justifySelf', 'gap', 'rowGap', 'columnGap', 'flexGrow', 'flexShrink',
  'flexBasis', 'order',
  'gridTemplateRows', 'gridTemplateColumns', 'gridAutoRows', 'gridAutoColumns',
  'gridAutoFlow', 'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd',
  'backgroundColor', 'backgroundImage', 'maskImage', 'color',
  'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomRightRadius', 'borderBottomLeftRadius',
  'boxShadow', 'backdropFilter', 'filter', 'mixBlendMode', 'transform',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'fontVariationSettings', 'letterSpacing', 'textAlign', 'textTransform',
]);

export const SVG_PRESENTATION_PROPERTIES = Object.freeze([
  'color', 'fill', 'fillOpacity', 'stopColor', 'stopOpacity',
  'stroke', 'strokeOpacity', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeDasharray',
  'filter',
  'opacity',
]);

/** Replace one exact attribute on an SVG opening tag. Attribute names must be
 * boundary-aware: searching for `opacity=` must never match `stop-opacity=` or
 * `fill-opacity=`. Exported so the browser serializer's critical string
 * mutation has a deterministic unit-test seam. */
export function setSvgOpeningAttribute(opening, name, rawValue) {
  const value = String(rawValue)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\s)(${escapedName})\\s*=\\s*(["'])`, 'i').exec(opening);
  if (!match) return opening + ' ' + name + '="' + value + '"';
  const valueStart = match.index + match[0].length;
  const valueEnd = opening.indexOf(match[3], valueStart);
  if (valueEnd < 0) return opening;
  return opening.slice(0, valueStart) + value + opening.slice(valueEnd);
}

const kebab = (value) => String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const AUTHORED_LAYOUT_PROPERTIES = Object.freeze([
  'display', 'position', 'top', 'right', 'bottom', 'left', 'zIndex',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent',
  'justifyItems', 'placeItems',
  'alignSelf', 'justifySelf', 'gap', 'rowGap', 'columnGap', 'flexGrow', 'flexShrink', 'flexBasis', 'order',
  'gridTemplateRows', 'gridTemplateColumns', 'gridAutoRows', 'gridAutoColumns',
  'gridAutoFlow', 'gridRowStart', 'gridRowEnd', 'gridColumnStart', 'gridColumnEnd',
  'backgroundImage', 'maskImage', 'filter', 'fontVariationSettings', 'transform',
]);

/**
 * Return a self-contained expression that captures one live DOM subtree.
 * The result is JSON-safe and can be passed directly to render --dom-capture.
 */
export function browserDomCaptureScript(selector = 'body', { serialized = false, maxDepth = Infinity } = {}) {
  const properties = JSON.stringify(CAPTURE_STYLE_PROPERTIES);
  const svgProperties = JSON.stringify(SVG_PRESENTATION_PROPERTIES);
  const propertyNames = JSON.stringify(Object.fromEntries(CAPTURE_STYLE_PROPERTIES.map((name) => [kebab(name), name])));
  const authoredProperties = JSON.stringify(AUTHORED_LAYOUT_PROPERTIES);
  return `(() => {
    const selector = ${JSON.stringify(String(selector))};
    const MAX_DEPTH = ${Number.isFinite(Number(maxDepth)) ? Math.max(0, Math.floor(Number(maxDepth))) : 'Infinity'};
    const PROPS = ${properties};
    const SVG_PROPS = ${svgProperties};
    const PROP_NAMES = ${propertyNames};
    const AUTHORED = new Set(${authoredProperties});
    const root = document.querySelector(selector);
    if (!root) throw new Error('Capture root not found: ' + selector);
    const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
    const pick = (style) => Object.fromEntries(PROPS.map((name) => [name, style[name]]));
    const ownRules = [];
    const collectRules = (rules) => {
      for (const rule of Array.from(rules || [])) {
        if (rule.media?.mediaText && !matchMedia(rule.media.mediaText).matches) continue;
        if (rule.conditionText && String(rule.constructor?.name || '').includes('Supports') && !CSS.supports(rule.conditionText)) continue;
        if (rule.selectorText && rule.style) ownRules.push(rule);
        else if (rule.cssRules) collectRules(rule.cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { collectRules(sheet.cssRules); } catch (error) { /* cross-origin stylesheet */ }
    }
    const authored = (element) => {
      const out = {};
      for (const rule of ownRules) {
        try {
          if (!element.matches(rule.selectorText)) continue;
          for (const raw of Array.from(rule.style)) {
            if (!(raw in PROP_NAMES) && !raw.startsWith('--')) continue;
            const name = PROP_NAMES[raw] || raw;
            const value = rule.style.getPropertyValue(raw).trim();
            if (!AUTHORED.has(name) && !value.includes('var(') && !raw.startsWith('--')) continue;
            out[name] = value;
          }
        } catch (error) { /* unsupported selector */ }
      }
      for (const raw of Array.from(element.style || [])) {
        if (!(raw in PROP_NAMES) && !raw.startsWith('--')) continue;
        const name = PROP_NAMES[raw] || raw;
        const value = element.style.getPropertyValue(raw).trim();
        if (!AUTHORED.has(name) && !value.includes('var(') && !raw.startsWith('--')) continue;
        out[name] = value;
      }
      return out;
    };
    const customProperties = (style) => {
      const out = {};
      for (const name of Array.from(style)) {
        if (name.startsWith('--')) out[name] = style.getPropertyValue(name).trim();
      }
      return out;
    };
    const textRuns = (element, style) => Array.from(element.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
      .map((child) => {
        const range = document.createRange();
        range.selectNodeContents(child);
        return { text: child.textContent.trim(), rect: rect(range.getBoundingClientRect()), style: pick(style) };
      });
    const contentOrder = (element) => {
      let textIndex = 0;
      let elementIndex = 0;
      const order = [];
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          order.push({ kind: 'text', index: textIndex++ });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          order.push({ kind: 'element', index: elementIndex++ });
        }
      }
      return order;
    };
    const pseudo = (element, which) => {
      const style = getComputedStyle(element, which);
      if (!style || style.content === 'none' || style.content === 'normal') return null;
      return {
        which, content: style.content, style: pick(style),
        width: style.width, height: style.height,
        top: style.top, right: style.right, bottom: style.bottom, left: style.left,
      };
    };
    const svgMarkup = (element) => {
      let markup = element.outerHTML;
      let cursor = 0;
      let filterIndex = 0;
      const setAttribute = ${setSvgOpeningAttribute.toString()};
      const sources = [element, ...Array.from(element.querySelectorAll('*'))];
      for (const source of sources) {
        const tag = String(source.tagName || '').toLowerCase();
        const start = markup.indexOf('<' + tag, cursor);
        const end = markup.indexOf('>', start);
        if (start < 0 || end < 0) continue;
        const computed = getComputedStyle(source);
        let opening = markup.slice(start, end);
        for (const name of SVG_PROPS) {
          const value = computed[name];
          if (!value) continue;
          if ((name === 'filter' || name === 'strokeDasharray') && value === 'none') continue;
          const attribute = name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
          if (name === 'filter' && value !== 'none') {
            opening = setAttribute(opening, 'id', 'figma-filter-' + (++filterIndex));
          }
          opening = setAttribute(opening, attribute, value);
        }
        markup = markup.slice(0, start) + opening + markup.slice(end);
        cursor = start + opening.length + 1;
      }
      return markup;
    };
    const slug = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const iconRole = (element) => {
      const classes = String(element.className || '');
      const explicit = element.getAttribute('data-figma-icon') || element.getAttribute('data-icon');
      const likely = explicit || element.getAttribute('aria-hidden') === 'true' || /(^|\\s)(icon|metric-icon|icon-button)(\\s|$)/.test(classes);
      if (!likely) return null;
      const glyph = element.textContent.trim();
      if (!glyph || element.querySelector('svg,img')) return null;
      const parentHint = element.closest('[href]')?.getAttribute('href')?.replace(/^#/, '');
      const name = slug(explicit || element.getAttribute('aria-label') || parentHint || classes.replace(/\\b(icon|metric-icon|icon-button)\\b/g, '')) || 'unknown';
      return { name, source: 'glyph', glyph };
    };
    const visit = (element, depth = 0) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const tagName = String(element.tagName || '').toLowerCase();
      const isSvg = tagName === 'svg';
      return {
        tag: tagName,
        classes: typeof element.className === 'string' ? element.className : '',
        aria: element.getAttribute('aria-label') || '',
        rect: rect(box), style: pick(style), authoredStyle: authored(element),
        customProperties: customProperties(style), iconRole: iconRole(element),
        sourceIdentity: {
          entity: element.getAttribute('data-figma-entity') || null,
          component: element.getAttribute('data-figma-component') || null,
          componentKey: element.getAttribute('data-figma-component-key') || null,
          componentNodeId: element.getAttribute('data-figma-component-node') || null,
          variant: element.getAttribute('data-figma-variant') || null,
          exportName: element.getAttribute('data-figma-export') || null,
          textStyle: element.getAttribute('data-figma-text-style') || null,
        },
        texts: isSvg ? [] : textRuns(element, style),
        contentOrder: isSvg ? [] : contentOrder(element),
        before: isSvg ? null : pseudo(element, '::before'),
        after: isSvg ? null : pseudo(element, '::after'),
        svg: isSvg ? svgMarkup(element) : null,
        asset: tagName === 'img' ? { kind: 'image', src: element.currentSrc || element.src } : null,
        children: isSvg || depth >= MAX_DEPTH ? [] : Array.from(element.children).map((child) => visit(child, depth + 1)),
      };
    };
    const capture = { version: 2, capturedAt: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight }, root: visit(root) };
    return ${serialized ? 'JSON.stringify(capture)' : 'capture'};
  })()`;
}
