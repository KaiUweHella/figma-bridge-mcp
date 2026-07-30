/**
 * JSX → Figma plugin-code compiler.
 *
 * Pure transformation, no I/O: `parseJSX` / `parseJSXBatch` turn the JSX
 * dialect used by `figma render` into the JavaScript the FigCli plugin
 * evaluates inside Figma. The daemon owns the transport.
 */


// NOTE: there is deliberately no built-in semantic color table here. An
// unresolved `var:` reference falls back to neutral grey and is reported via
// __unresolvedVars — the tool ships no design-system defaults of its own.

/**
 * Coerce a JSX attribute value into a finite number for interpolation into
 * generated plugin code. Anything non-numeric (`w="abc"`, `size="{{x}}"`)
 * falls back instead of being pasted verbatim: raw interpolation produced
 * broken generated JS at best, and an execution channel into the plugin
 * sandbox at worst — figma_render must not become a second figma_run.
 */
export function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class FigmaClient {
  constructor() {
    // Optional: pin var:<name> resolution to a single Variable Collection.
    // Set via setCollection() or directly. Per-attribute `var:collection:name`
    // in JSX overrides this. nullish = all collections, natural order.
    this.collectionFilter = null;
  }

  /** Pin variable lookups to a specific collection (by case-insensitive name match). */
  setCollection(name) {
    this.collectionFilter = name || null;
  }

  // (The Chrome DevTools transport — listPages / isConnected / connect / send /
  // eval / getPageInfo — and the convenience readers that used it were
  // removed. This build reaches Figma only through the daemon → plugin
  // bridge; what is left here is a pure JSX → plugin-code compiler with no
  // I/O of its own.)

  async parseJSXBatch(jsxArray, options = {}) {
    const gap = options.gap || 40;
    const vertical = options.vertical || false;

    // Parse each JSX to get props and children
    const parsed = jsxArray.map(jsx => {
      const openMatch = jsx.match(/<Frame\s+([^>]*)>/);
      if (!openMatch) throw new Error('Invalid JSX: must start with <Frame>');
      const propsStr = openMatch[1];
      const startIdx = openMatch.index + openMatch[0].length;
      const children = this.extractContent(jsx.slice(startIdx), 'Frame');
      const props = this.parseProps(propsStr);
      const childElements = this.parseChildren(children);
      return { props, children: childElements };
    });

    // No-network build: <Icon> elements render as named placeholder
    // rectangles (design-to-code pulls real icons from the file via
    // `export assets`; nothing is fetched from external icon CDNs).
    const iconSvgMap = {};

    // Collect all fonts needed ({ family, style } pairs, deduped)
    const allFontMap = new Map();
    const allFonts = [];
    let anyUsesVars = false;
    let anyUsesTextStyles = false;
    let anyUsesInstances = false;
    let anyUsesSpacing = false;

    parsed.forEach(({ props, children }) => {
      const bg = props.bg || props.fill || null;
      const stroke = props.stroke || null;
      if (this.isVarRef(bg)) anyUsesVars = true;
      if (stroke && this.isVarRef(stroke)) anyUsesVars = true;
      for (const k of ['gap', 'rowGap', 'wrapGap', 'counterAxisSpacing', 'p', 'padding',
        'px', 'py', 'pt', 'pr', 'pb', 'pl', 'rounded', 'radius']) {
        if (this.isVarRef(props[k])) anyUsesVars = true;
      }

      const collected = this.collectFontsAndVarUsage(children);
      collected.fonts.forEach(f => {
        const key = f.family + '/' + f.style;
        if (!allFontMap.has(key)) { allFontMap.set(key, f); allFonts.push(f); }
      });
      if (collected.usesVars) anyUsesVars = true;
      if (collected.usesTextStyles || collected.hasText) anyUsesTextStyles = true;
      if (collected.usesInstances) anyUsesInstances = true;
      if (collected.hasSpacing || this.hasSpacingProps(props)) anyUsesSpacing = true;
    });

    // Font caching: only load fonts not yet loaded in this session
    const fontLoads = this.generateFontLoadCode(allFonts);

    // Variable caching: reuse loaded vars across calls.
    // Loads ALL local variables in a single batched call (Figma's
    // getLocalVariablesAsync); no collection is privileged — first-come-wins
    // in Figma's natural collection order. Avoids N round-trips
    // when a user imports a Carbon / Material / DESIGN.md system with ~100
    // variables — the per-id loop made renders feel like a hang.
    // Resolve collection filter (case-insensitive substring), evaluated in
    // the host (we know the user-passed string here). Becomes a fixed set of
    // collection IDs that the Plugin-side resolver will restrict itself to.
    const colFilter = this.collectionFilter;
    const varLoadCode = anyUsesVars ? this.varPreambleCode(colFilter) : '';

    // Generate code for each frame
    const framesCodes = parsed.map(({ props, children }, frameIdx) => {
      const name = props.name || 'Frame';
      // "fill" / "hug" are sizing keywords that only make sense for nested
      // elements under an auto-layout parent. At top-level there's no parent
      // to fill against, so we ignore them and fall back to a sensible
      // numeric default. Without this filter, `w="fill"` interpolated raw
      // into `resize(fill, …)` → ReferenceError.
      const isNumeric = v => v !== undefined && v !== 'fill' && v !== 'hug';
      const rawW = isNumeric(props.w) ? props.w : isNumeric(props.width) ? props.width : undefined;
      const rawH = isNumeric(props.h) ? props.h : isNumeric(props.height) ? props.height : undefined;
      const hasExplicitWidth = rawW !== undefined;
      const width = rawW !== undefined ? numOr(rawW, 320) : 320;
      const hasExplicitHeight = rawH !== undefined;
      const height = rawH !== undefined ? numOr(rawH, 200) : 200;
      const bg = props.bg || props.fill || null;
      const stroke = props.stroke || null;
      const rounded = props.rounded || props.radius || 0;
      const flex = props.flex || 'col';
      const itemGap = props.gap || 0;
      const p = props.p || props.padding || 0;
      const px = props.px || p;
      const py = props.py || p;
      const align = props.items || props.align || 'MIN';
      const justify = props.justify || 'MIN';
      const wrap = props.wrap === true || props.wrap === 'true';
      const wrapGap = Number(props.wrapGap || props.rowGap || props.counterAxisSpacing || 0);
      const hug = props.hug || '';
      // Generic node-level visuals that just need straight property
      // assignment. Reading these here means callers can drop opacity / lock
      // / visible on any frame without us having to thread each through the
      // whole code-gen pipeline.
      const opacity = props.opacity !== undefined ? Number(props.opacity) : null;
      const visible = props.visible === false || props.visible === 'false' ? false : null;
      const locked = props.locked === true || props.locked === 'true' ? true : null;
      const hugWidth = hug === 'both' || hug === 'w' || hug === 'width';
      const hugHeight = hug === 'both' || hug === 'h' || hug === 'height';
      const clip = props.clip === 'true' || props.clip === true;

      const alignMap = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
      const justifyMap = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };
      const alignVal = alignMap[align] || 'MIN';
      const justifyVal = justifyMap[justify] || alignMap[justify] || 'MIN';

      const fillCode = this.generateFillCode(bg, `f${frameIdx}`);
      const strokeCode = stroke ? this.generateStrokeCode(stroke, `f${frameIdx}`, props.strokeWidth || 1, props.strokeAlign || null) : { code: '' };
      const effectsCode = this.generateEffectsCode(props, `f${frameIdx}`);
      const imageCode = props.image ? this.generateImageFillCode(props.image, `f${frameIdx}`, props.imageScale) : '';

      const childCode = this.generateChildrenCode(children, `f${frameIdx}`, flex, { counter: { value: 0 }, prefix: `${frameIdx}_`, iconSvgMap });

      return `
        const f${frameIdx} = figma.createFrame();
        f${frameIdx}.name = ${JSON.stringify(name)};
        f${frameIdx}.resize(${width}, ${height});
        f${frameIdx}.x = posX;
        f${frameIdx}.y = posY;
        f${frameIdx}.cornerRadius = ${this.spacingRaw(rounded)};
        ${this.spacingBind(`f${frameIdx}`, ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'], rounded, 'radius')}
        ${fillCode.code}
        ${strokeCode.code}
        ${effectsCode}
        ${imageCode}
        f${frameIdx}.layoutMode = '${flex === 'none' || flex === 'stack' || flex === 'free' ? 'NONE' : (flex === 'row' ? 'HORIZONTAL' : 'VERTICAL')}';
        ${flex === 'none' || flex === 'stack' || flex === 'free' ? '' : `${wrap && flex === 'row' ? `f${frameIdx}.layoutWrap = 'WRAP';` : ''}
        f${frameIdx}.itemSpacing = ${this.spacingRaw(itemGap)};
        f${frameIdx}.paddingTop = f${frameIdx}.paddingBottom = ${this.spacingRaw(py)};
        f${frameIdx}.paddingLeft = f${frameIdx}.paddingRight = ${this.spacingRaw(px)};
        ${this.spacingBind(`f${frameIdx}`, ['itemSpacing'], itemGap, 'space')}
        ${this.spacingBind(`f${frameIdx}`, ['paddingTop', 'paddingBottom'], py, 'space')}
        ${this.spacingBind(`f${frameIdx}`, ['paddingLeft', 'paddingRight'], px, 'space')}
        f${frameIdx}.primaryAxisAlignItems = '${justifyVal}';
        f${frameIdx}.counterAxisAlignItems = '${alignVal}';
        f${frameIdx}.primaryAxisSizingMode = '${flex === 'col' ? (hugHeight || !hasExplicitHeight ? 'AUTO' : 'FIXED') : (hugWidth || !hasExplicitWidth ? 'AUTO' : 'FIXED')}';
        f${frameIdx}.counterAxisSizingMode = '${flex === 'col' ? (hugWidth || !hasExplicitWidth ? 'AUTO' : 'FIXED') : (hugHeight || !hasExplicitHeight ? 'AUTO' : 'FIXED')}';
        ${wrap && flex === 'row' && wrapGap > 0 ? `f${frameIdx}.counterAxisSpacing = ${wrapGap};
        ${this.spacingBind(`f${frameIdx}`, ['counterAxisSpacing'], wrapGap, 'space')}` : ''}`}
        f${frameIdx}.clipsContent = ${clip};
        ${opacity !== null ? `f${frameIdx}.opacity = ${opacity};` : ''}
        ${visible === false ? `f${frameIdx}.visible = false;` : ''}
        ${locked === true ? `f${frameIdx}.locked = true;` : ''}
        ${childCode}
        results.push({ id: f${frameIdx}.id, name: f${frameIdx}.name, width: f${frameIdx}.width, height: f${frameIdx}.height });
        ${vertical ? `posY += f${frameIdx}.height + ${gap};` : `posX += f${frameIdx}.width + ${gap};`}
      `;
    }).join('\n');

    return `
      (async function() {
        ${fontLoads}
        ${varLoadCode}
        ${anyUsesTextStyles ? this.generateTextStyleHelperCode() : ''}
        ${anyUsesSpacing ? this.generateSpacingHelperCode() : ''}
        ${anyUsesInstances ? this.generateInstanceHelperCode() : ''}

        // Calculate start position
        let posX = 0, posY = 100;
        const children = figma.currentPage.children;
        if (children.length > 0) {
          let maxRight = 0;
          children.forEach(n => {
            const right = n.x + (n.width || 0);
            if (right > maxRight) maxRight = right;
          });
          posX = Math.round(maxRight + 100);
        }

        const results = [];
        let __currentNode = '';
        ${framesCodes}
        // Surface unresolved var: references back to the caller. Array-prop
        // shorthand is lost by JSON.stringify, so wrap in an object when we
        // have warnings — caller unwraps. Backwards-compatible: plain success
        // still returns the array directly.
        const unresolved = globalThis.__unresolvedVars
          ? [...globalThis.__unresolvedVars].sort() : [];
        globalThis.__unresolvedVars = new Set();
        return unresolved.length > 0 ? { frames: results, unresolved } : results;
      })()
    `;
  }

  /**
   * Parse JSX-like syntax to Figma Plugin API code
   */
  async parseJSX(jsx) {
    // Find opening Frame tag
    const openMatch = jsx.match(/<Frame\s+([^>]*)>/);
    if (!openMatch) {
      throw new Error('Invalid JSX: must start with <Frame>');
    }

    const propsStr = openMatch[1];
    const startIdx = openMatch.index + openMatch[0].length;

    // Find matching closing tag by counting open/close tags
    const children = this.extractContent(jsx.slice(startIdx), 'Frame');

    // Parse props
    const props = this.parseProps(propsStr);

    // Parse children
    const childElements = this.parseChildren(children);

    // Warn if children content exists but nothing was parsed
    const trimmedChildren = children.trim();
    if (trimmedChildren && childElements.length === 0) {
      console.warn('[render] Warning: Frame has content but no elements were parsed.');
      console.warn('[render] Content:', trimmedChildren.slice(0, 200) + (trimmedChildren.length > 200 ? '...' : ''));
      console.warn('[render] Supported elements: <Frame>, <Text>, <Rectangle>, <Rect>, <Image>, <Icon>');
    }

    // No-network build: <Icon> renders as a named placeholder rectangle.
    const iconSvgMap = {};

    // Generate code
    return this.generateCode(props, childElements, iconSvgMap);
  }

  /**
   * Extract content between matching open/close tags
   */
  extractContent(str, tagName) {
    let depth = 1;
    let i = 0;
    const closeTag = `</${tagName}>`;

    while (i < str.length && depth > 0) {
      const remaining = str.slice(i);

      if (remaining.startsWith(closeTag)) {
        depth--;
        if (depth === 0) {
          return str.slice(0, i);
        }
        i += closeTag.length;
      } else if (remaining.startsWith(`<${tagName} `) || remaining.startsWith(`<${tagName}>`)) {
        // Check if this is a self-closing tag (e.g. <Frame ... />)
        const selfCloseCheck = remaining.match(new RegExp(`^<${tagName}(?:\\s[^>]*?)?\\s*\\/>`));
        if (selfCloseCheck) {
          // Self-closing: skip entirely, don't change depth
          i += selfCloseCheck[0].length;
        } else {
          depth++;
          i++;
        }
      } else {
        i++;
      }
    }

    return str;
  }

  // (collectIconNames / prefetchIconSvgs removed: the no-network build never
  // fetches from icon CDNs — <Icon> renders as a named placeholder, and real
  // icons come out of the Figma file via `export assets`.)

  /**
   * Validate JSX prop names against the known vocabulary and return warnings
   * for unknown ones, with a suggestion where possible. Pure function, no
   * Figma connection needed — callers print the warnings before rendering.
   * Returns [{ tag, prop, suggestion|null }].
   */
  validateJsxProps(jsx) {
    const layout = ['name', 'flex', 'gap', 'rowGap', 'wrapGap', 'counterAxisSpacing', 'wrap',
      'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'padding',
      'justify', 'items', 'align', 'grow', 'stretch', 'hug',
      'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
      'position', 'x', 'y', 'top', 'right', 'bottom', 'left', 'centerOffsetX', 'centerOffsetY'];
    const paint = ['bg', 'fill', 'stroke', 'strokeWidth', 'strokeAlign', 'opacity', 'blendMode',
      'image', 'imageScale', 'visible', 'locked', 'clip', 'overflow', 'rotate'];
    const corners = ['rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing'];
    const effects = ['shadow', 'innerShadow', 'blur', 'bgBlur',
      'noise', 'noiseDensity', 'noiseSize', 'noiseColor', 'noiseColor2', 'noiseOpacity',
      'texture', 'textureSize', 'textureRadius', 'textureClip',
      'progressiveBlur', 'progressiveBlurDir', 'progressiveBlurStart',
      'glass', 'glassRefraction', 'glassDepth', 'glassRadius', 'glassDispersion', 'glassLight', 'glassLightAngle'];

    const known = {
      Frame: [...layout, ...paint, ...corners, ...effects],
      Text: ['name', 'size', 'weight', 'color', 'font', 'italic', 'align', 'w', 'h', 'width', 'height',
        'grow', 'opacity', 'x', 'y', 'position', 'lineHeight', 'letterSpacing', 'truncate', 'maxLines', 'style'],
      Icon: ['name', 'size', 's', 'color', 'c', 'x', 'y', 'position'],
      Rect: ['name', 'w', 'h', 'width', 'height', 'bg', 'fill', 'rounded', 'radius', 'opacity', 'x', 'y', 'position'],
      Rectangle: null, // alias of Rect, filled below
      Ellipse: ['name', 'w', 'h', 'width', 'height', 'bg', 'fill', 'stroke', 'strokeWidth', 'strokeAlign',
        'arc', 'arcStart', 'innerRadius', 'opacity', 'x', 'y', 'position'],
      Circle: null,    // alias of Ellipse, filled below
      Image: ['name', 'w', 'h', 'width', 'height', 'bg', 'fill', 'rounded', 'radius', 'opacity', 'x', 'y', 'position'],
      Slot: ['name', 'flex', 'gap', 'p', 'px', 'py', 'padding', 'w', 'h', 'width', 'height', 'bg', 'fill'],
      Instance: ['name', 'component', 'id', 'variant', 'w', 'h', 'width', 'height'],
    };
    known.Rectangle = known.Rect;
    known.Circle = known.Ellipse;

    // Common wrong names -> the prop that actually works
    const aliases = {
      layout: 'flex', direction: 'flex', flexDirection: 'flex',
      cornerRadius: 'rounded', borderRadius: 'rounded',
      background: 'bg', backgroundColor: 'bg',
      border: 'stroke', borderColor: 'stroke', borderWidth: 'strokeWidth',
      fontSize: 'size', fontWeight: 'weight', fontFamily: 'font', textAlign: 'align',
      spacing: 'gap', itemSpacing: 'gap',
      alignItems: 'items', justifyContent: 'justify',
      visibility: 'visible',
    };

    const levenshtein = (a, b) => {
      const m = a.length, n = b.length;
      const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
      for (let j = 0; j <= n; j++) d[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          d[i][j] = Math.min(
            d[i - 1][j] + 1, d[i][j - 1] + 1,
            d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
          );
        }
      }
      return d[m][n];
    };

    const warnings = [];
    const tagRegex = /<(Frame|Text|Icon|Rect|Rectangle|Ellipse|Circle|Image|Slot|Instance)([^>]*?)\/?>/g;
    let m;
    while ((m = tagRegex.exec(jsx)) !== null) {
      const tag = m[1];
      const valid = known[tag];
      if (!valid) continue;
      const props = this.parseProps(m[2] || '');
      for (const prop of Object.keys(props)) {
        if (valid.includes(prop)) continue;
        // Instance override props are dynamic by design: text:<Layer>, prop:<Property>
        if (tag === 'Instance' && (prop.startsWith('text:') || prop.startsWith('prop:'))) continue;
        let suggestion = aliases[prop] || null;
        if (!suggestion) {
          // Typo detection: closest known prop within edit distance 2
          let best = null, bestDist = 3;
          for (const k of valid) {
            const dist = levenshtein(prop.toLowerCase(), k.toLowerCase());
            if (dist < bestDist) { best = k; bestDist = dist; }
          }
          suggestion = best;
        }
        warnings.push({ tag, prop, suggestion });
      }
    }
    return warnings;
  }

  parseProps(propsStr) {
    const props = {};

    // Match name="value" or name={value}. Keys allow ":" and "-" so Instance
    // override props (text:Name="…", prop:State="…") parse too.
    const regex = /([\w:.-]+)=(?:"([^"]*)"|{([^}]*)})/g;
    let match;

    while ((match = regex.exec(propsStr)) !== null) {
      const key = match[1];
      const value = match[2] !== undefined ? match[2] : match[3];
      props[key] = value;
    }

    return props;
  }

  parseChildren(childrenStr) {
    const children = [];
    const frameRanges = [];

    // First: find all open/close Frame elements (recursive, handles nesting)
    const frameOpenRegex = /<Frame(?:\s+([^>]*?))?>/g;
    let match;

    while ((match = frameOpenRegex.exec(childrenStr)) !== null) {
      // Skip self-closing frames (regex matches /> because > is part of />)
      if (match[0].endsWith('/>')) continue;

      const frameProps = this.parseProps(match[1] || '');
      frameProps._type = 'frame';
      frameProps._index = match.index;

      // Get content between opening and matching closing tag
      const afterOpen = childrenStr.slice(match.index + match[0].length);
      const innerContent = this.extractContent(afterOpen, 'Frame');

      // Calculate full frame length
      const fullLength = match[0].length + innerContent.length + '</Frame>'.length;

      // Recursively parse children of nested frame
      frameProps._children = this.parseChildren(innerContent);
      children.push(frameProps);

      // Mark this range as consumed
      frameRanges.push({ start: match.index, end: match.index + fullLength });

      // Move regex past this frame to avoid re-matching nested frames
      frameOpenRegex.lastIndex = match.index + fullLength;
    }

    // Then: parse self-closing Frame elements NOT inside open/close frames
    const frameSelfCloseRegex = /<Frame(?:\s+([^>]*?))?\s*\/>/g;

    while ((match = frameSelfCloseRegex.exec(childrenStr)) !== null) {
      // Skip if inside an already-consumed open/close frame
      const insideFrame = frameRanges.some(r => match.index >= r.start && match.index < r.end);
      if (insideFrame) continue;

      const frameProps = this.parseProps(match[1] || '');
      frameProps._type = 'frame';
      frameProps._index = match.index;
      frameProps._children = [];
      children.push(frameProps);
      frameRanges.push({ start: match.index, end: match.index + match[0].length });
    }

    // Parse Slot elements (with children) - must be before Text parsing
    // Slots can have children (default content)
    const slotOpenRegex = /<Slot(?:\s+([^>]*?))?>/g;
    while ((match = slotOpenRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const slotProps = this.parseProps(match[1] || '');
        slotProps._type = 'slot';
        slotProps._index = idx;

        // Get content between opening and matching closing tag
        const afterOpen = childrenStr.slice(match.index + match[0].length);
        const innerContent = this.extractContent(afterOpen, 'Slot');
        const fullLength = match[0].length + innerContent.length + '</Slot>'.length;

        // Recursively parse children of slot (default content)
        slotProps._children = this.parseChildren(innerContent);
        children.push(slotProps);

        // Mark this range as consumed (so text/other elements inside are skipped)
        frameRanges.push({ start: idx, end: idx + fullLength });
        slotOpenRegex.lastIndex = idx + fullLength;
      }
    }

    // Parse self-closing Slot elements.
    // NOTE (all self-closing regexes below): the attribute section must be
    // matched with [^>] — NOT [^/] — because attribute values legitimately
    // contain slashes (var:green/600, image URLs). [^/] silently dropped the
    // whole element as soon as a value had a "/" in it.
    const slotSelfCloseRegex = /<Slot(?:\s+([^>]*?))?\s*\/>/g;
    while ((match = slotSelfCloseRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const slotProps = this.parseProps(match[1] || '');
        slotProps._type = 'slot';
        slotProps._index = idx;
        slotProps._children = [];
        children.push(slotProps);
        // Mark as consumed
        frameRanges.push({ start: idx, end: idx + match[0].length });
      }
    }

    // Parse Text elements, but skip those inside nested Frames/Slots
    // Use (?:\s+([^>]*?))? to allow Text with or without attributes
    const textRegex = /<Text(?:\s+([^>]*?))?>([^<]*)<\/Text>/g;
    while ((match = textRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      // Check if this text is inside a nested frame
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const textProps = this.parseProps(match[1] || '');
        textProps._type = 'text';
        textProps.content = match[2];
        textProps._index = idx;
        children.push(textProps);
      }
    }

    // Parse Rectangle elements (self-closing)
    // Use (?:\s+([^/]*?))? to allow Rect with or without attributes
    const rectRegex = /<(?:Rectangle|Rect)(?:\s+([^>]*?))?\s*\/>/g;
    while ((match = rectRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const rectProps = this.parseProps(match[1] || '');
        rectProps._type = 'rect';
        rectProps._index = idx;
        children.push(rectProps);
      }
    }

    // Parse Ellipse / Circle elements (self-closing). Supports rings, spinners,
    // donut/pie via arc (sweep°), arcStart (start°, 0=3 o'clock) and innerRadius.
    const ellipseRegex = /<(?:Ellipse|Circle)(?:\s+([^>]*?))?\s*\/>/g;
    while ((match = ellipseRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const ellProps = this.parseProps(match[1] || '');
        ellProps._type = 'ellipse';
        ellProps._index = idx;
        children.push(ellProps);
      }
    }

    // Parse Image elements (self-closing) - creates placeholder rectangle
    const imageRegex = /<Image(?:\s+([^>]*?))?\s*\/>/g;
    while ((match = imageRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const imgProps = this.parseProps(match[1] || '');
        imgProps._type = 'image';
        imgProps._index = idx;
        children.push(imgProps);
      }
    }

    // Parse Icon elements (self-closing) - creates placeholder
    const iconRegex = /<Icon(?:\s+([^>]*?))?\s*\/>/g;
    while ((match = iconRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const iconProps = this.parseProps(match[1] || '');
        iconProps._type = 'icon';
        iconProps._index = idx;
        children.push(iconProps);
      }
    }

    // Parse Instance elements (self-closing) - creates component instance
    const instanceRegex = /<Instance(?:\s+([^>]*?))?\s*\/>/g;
    while ((match = instanceRegex.exec(childrenStr)) !== null) {
      const idx = match.index;
      const insideFrame = frameRanges.some(r => idx >= r.start && idx < r.end);
      if (!insideFrame) {
        const instProps = this.parseProps(match[1] || '');
        instProps._type = 'instance';
        instProps._index = idx;
        children.push(instProps);
      }
    }

    // Sort by original position in JSX to maintain order
    children.sort((a, b) => a._index - b._index);

    return children;
  }

  /**
   * Walk a parsed child tree and collect required font styles plus whether
   * any var: reference is used. Shared by single render and batch render so
   * both load the same fonts and detect vars in the same places (including
   * icon colors and slot children, which the old batch collector missed).
   */
  /**
   * Map a JSX weight (+ italic flag) to a Figma font style name.
   * Full scale: thin..black, with italic variants ("Bold Italic").
   */
  weightToStyle(weight, italic) {
    const map = {
      thin: 'Thin', hairline: 'Thin',
      extralight: 'Extra Light', ultralight: 'Extra Light',
      light: 'Light',
      regular: 'Regular', normal: 'Regular',
      medium: 'Medium',
      semibold: 'Semi Bold', demibold: 'Semi Bold',
      bold: 'Bold',
      extrabold: 'Extra Bold', ultrabold: 'Extra Bold',
      black: 'Black', heavy: 'Black',
    };
    const base = map[String(weight || 'regular').toLowerCase()] || 'Regular';
    const isItalic = italic === true || italic === 'true';
    if (isItalic) return base === 'Regular' ? 'Italic' : base + ' Italic';
    return base;
  }

  collectFontsAndVarUsage(items) {
    const fontMap = new Map(); // 'family/style' -> { family, style }
    let usesVars = false;
    let usesTextStyles = false;
    let usesInstances = false;
    let hasText = false;
    let hasSpacing = false;
    const check = (v) => { if (this.isVarRef(v)) usesVars = true; };
    // Spacing/radius props get tokenised (reuse-or-create a FLOAT variable),
    // and a var: reference among them also means the var cache must load.
    const checkSpacing = (item) => {
      if (this.hasSpacingProps(item)) hasSpacing = true;
      for (const k of ['gap', 'rowGap', 'wrapGap', 'counterAxisSpacing', 'p', 'padding',
        'px', 'py', 'pt', 'pr', 'pb', 'pl', 'rounded', 'radius']) check(item[k]);
    };
    const walk = (list) => {
      list.forEach(item => {
        if (item._type === 'text') {
          hasText = true;
          const family = item.font || 'Inter';
          const style = this.weightToStyle(item.weight, item.italic);
          fontMap.set(family + '/' + style, { family, style });
          check(item.color || '#000000');
          check(item.size); // size="var:text/md" binds fontSize to a FLOAT variable
          if (item.style) usesTextStyles = true;
        } else if (item._type === 'frame' || item._type === 'slot') {
          check(item.bg || item.fill || null);
          if (item.stroke) check(item.stroke);
          checkSpacing(item);
        } else if (item._type === 'rect' || item._type === 'image' || item._type === 'icon') {
          check(item.bg || item.fill || item.color || item.c || '#e4e4e7');
          checkSpacing(item);
        } else if (item._type === 'ellipse') {
          check(item.bg || item.fill || null);
          if (item.stroke) check(item.stroke);
        } else if (item._type === 'instance') {
          usesInstances = true;
        }
        if (item._children) walk(item._children);
      });
    };
    walk(items);
    return { fonts: [...fontMap.values()], usesVars, usesTextStyles, usesInstances, hasText, hasSpacing };
  }

  /**
   * Generate the font-loading preamble for render code. Loads every needed
   * (family, style) pair with a session cache, falling back to Inter when a
   * font is missing. Also defines __font(family, style), which the text
   * code-gen uses so fontName always points at a successfully loaded font.
   */
  /**
   * Plugin-side preamble that loads and caches ALL local variables once per
   * 30s window, honouring an optional collection scope.
   *
   * Single source of truth: the batch and single-root render paths used to
   * carry their own near-identical copy of this ~65-line snippet, which is
   * exactly how the two paths drifted apart before (see
   * render-batch-parity.test.js). Emit it from here in both.
   */
  varPreambleCode(colFilter) {
    return `
      // Compose the "collection scope" once per cache window. When a filter
      // is active, ONLY variables from collections whose name matches the
      // filter make it into the cache — every other token resolves to
      // "missing", which is correct: the caller chose this scope.
      if (!globalThis.__varsCache || globalThis.__varsCacheFilter !== ${JSON.stringify(colFilter)} ||
          Date.now() - (globalThis.__varsCacheTime || 0) > 30000) {
        const [collections, allVars] = await Promise.all([
          figma.variables.getLocalVariableCollectionsAsync(),
          figma.variables.getLocalVariablesAsync(),
        ]);
        const filter = ${JSON.stringify(colFilter)};
        let scopedColIds = null;
        if (filter) {
          const fl = filter.toLowerCase();
          const scoped = collections.filter(c =>
            c.name.toLowerCase() === fl || c.name.toLowerCase().includes(fl)
          );
          scopedColIds = new Set(scoped.map(c => c.id));
        }
        globalThis.__varsCache = {};
        // Register a variable under its full name AND under its "tail" name
        // (the part after the last "/" in a slash-grouped name). So a token
        // named "colors/primary" can be resolved as either var:primary or
        // var:colors/primary. The full name always wins if both exist.
        const register = (v) => {
          if (!globalThis.__varsCache[v.name]) globalThis.__varsCache[v.name] = v;
          const slash = v.name.lastIndexOf('/');
          if (slash >= 0) {
            const tail = v.name.slice(slash + 1);
            if (tail && !globalThis.__varsCache[tail]) globalThis.__varsCache[tail] = v;
          }
        };
        if (scopedColIds) {
          for (const v of allVars) {
            if (scopedColIds.has(v.variableCollectionId)) register(v);
          }
        } else {
          for (const v of allVars) register(v);
        }
        // Also stash collection-name → id map for the var:collection:name
        // per-attribute override syntax. Same tail-aliasing applies.
        globalThis.__varsByCollection = {};
        for (const v of allVars) {
          const col = collections.find(c => c.id === v.variableCollectionId);
          if (!col) continue;
          const colKey = col.name.toLowerCase() + ':';
          globalThis.__varsByCollection[colKey + v.name] = v;
          const slash = v.name.lastIndexOf('/');
          if (slash >= 0) {
            const tail = v.name.slice(slash + 1);
            const alias = colKey + tail;
            if (tail && !globalThis.__varsByCollection[alias]) globalThis.__varsByCollection[alias] = v;
          }
        }
        globalThis.__varsCacheTime = Date.now();
        globalThis.__varsCacheFilter = filter;
      }
      const vars = globalThis.__varsCache;
      const varsByCollection = globalThis.__varsByCollection || {};
      // Lookup helper for the per-attr "var:collection:name" syntax. Falls
      // back to the scoped cache if the qualified key isn't found.
      const lookupVar = (key) => {
        if (key.includes(':')) {
          const [colName, varName] = key.split(':', 2);
          return varsByCollection[colName.toLowerCase() + ':' + varName] || vars[varName];
        }
        return vars[key];
      };
      // Collect names that callers asked for but didn't resolve so we can
      // surface them at the end instead of silently rendering grey.
      globalThis.__unresolvedVars = globalThis.__unresolvedVars || new Set();
      const boundFill = (variable, requestedKey) => {
        if (!variable) {
          if (requestedKey) globalThis.__unresolvedVars.add(requestedKey);
          // No variable loaded for this name: neutral grey + the unresolved
          // warning above. No built-in design-system defaults.
          return { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } };
        }
        return figma.variables.setBoundVariableForPaint(
          { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable
        );
      };
    `;
  }

  generateFontLoadCode(fontList) {
    const fonts = fontList && fontList.length ? fontList : [{ family: 'Inter', style: 'Regular' }];
    return `
        if (!globalThis.__loadedFonts) globalThis.__loadedFonts = new Set();
        for (const f of ${JSON.stringify(fonts)}) {
          const key = f.family + '/' + f.style;
          if (globalThis.__loadedFonts.has(key)) continue;
          try {
            await figma.loadFontAsync({ family: f.family, style: f.style });
            globalThis.__loadedFonts.add(key);
          } catch (e) {
            try {
              await figma.loadFontAsync({ family: 'Inter', style: f.style });
              globalThis.__loadedFonts.add('Inter/' + f.style);
            } catch (e2) {
              await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
              globalThis.__loadedFonts.add('Inter/Regular');
            }
          }
        }
        const __font = (family, style) => {
          const lf = globalThis.__loadedFonts;
          if (lf.has(family + '/' + style)) return { family, style };
          if (lf.has('Inter/' + style)) return { family: 'Inter', style };
          return { family: 'Inter', style: 'Regular' };
        };
    `;
  }

  /**
   * Helper preamble for text styles. Two entry points:
   *
   * __applyTextStyle(node, name) — for explicit <Text style="Name">: resolves
   * a LOCAL text style by name (exact, then "…/name" suffix, then substring —
   * case-insensitive). If none exists it is CREATED from the node's current
   * typography, so the given name becomes a reusable style from then on.
   *
   * __ensureTextStyle(node, family, style, size) — for every plain <Text>:
   * derives a deterministic style name ("Inter/14 Semi Bold"), reuses the
   * local style of that name if present, creates it otherwise, and applies
   * it. This is what keeps rendered text attached to shared styles instead
   * of leaving raw fontSize/fontName everywhere.
   */
  generateTextStyleHelperCode() {
    return `
        if (!globalThis.__textStylesCache || Date.now() - (globalThis.__textStylesTime || 0) > 30000) {
          globalThis.__textStylesCache = await figma.getLocalTextStylesAsync();
          globalThis.__textStylesTime = Date.now();
        }
        const __setStyleId = async (node, styleId) => {
          try { await node.setTextStyleIdAsync(styleId); }
          catch (e) { try { node.textStyleId = styleId; } catch (e2) {} }
        };
        const __applyTextStyle = async (node, name) => {
          const styles = globalThis.__textStylesCache || [];
          const ln = String(name).toLowerCase();
          let s = styles.find(st => st.name.toLowerCase() === ln)
            || styles.find(st => st.name.toLowerCase().endsWith('/' + ln))
            || styles.find(st => st.name.toLowerCase().includes(ln));
          if (!s) {
            // Create the named style from this text's typography so the name
            // the caller asked for exists (and is reused) from now on.
            s = figma.createTextStyle();
            s.name = String(name);
            try { s.fontName = node.fontName; } catch (e) {}
            try { s.fontSize = node.fontSize; } catch (e) {}
            globalThis.__textStylesCache.push(s);
          }
          try { await figma.loadFontAsync(s.fontName); } catch (e) {}
          await __setStyleId(node, s.id);
        };
        const __ensureTextStyle = async (node, family, style, size) => {
          const styles = globalThis.__textStylesCache || [];
          // Reuse ANY existing style with this exact typography, whatever it
          // is called — a file whose system calls 13px/Regular "Body/SM"
          // must not get a parallel "Inter/13 Regular" next to it. Only when
          // nothing matches do we create one, under a descriptive name.
          let s = styles.find(st => st.fontSize === Number(size)
            && st.fontName && st.fontName.family === family && st.fontName.style === style);
          if (!s) {
            const name = family + '/' + size + ' ' + style;
            s = styles.find(st => st.name === name);
            if (!s) {
              s = figma.createTextStyle();
              s.name = name;
              try { s.fontName = node.fontName; } catch (e) {}
              try { s.fontSize = Number(size); } catch (e) {}
              globalThis.__textStylesCache.push(s);
            }
          }
          await __setStyleId(node, s.id);
        };
    `;
  }

  /**
   * Helper preamble for spacing/radius tokens. __space(node, fields, value,
   * kind) binds gap / padding / corner radius to a FLOAT variable instead of
   * leaving a hard-coded number on the node:
   *
   *   - value "var:space/4"  → binds that variable (explicit opt-in)
   *   - value 16 + kind      → REUSES a local FLOAT variable of the matching
   *                            namespace (space / gap / padding for kind
   *                            "space", radius / corner for kind "radius")
   *                            whose resolved value is 16, and CREATES
   *                            "space/16px" or "radius/16px" if none exists.
   *
   * Matching is namespace-scoped on purpose: a padding of 40 must not latch
   * onto `size/control-md` just because that also happens to be 40.
   * The raw number is always assigned first, so a failed bind degrades to
   * exactly the old behaviour.
   */
  generateSpacingHelperCode() {
    return `
        if (!globalThis.__spaceCache || Date.now() - (globalThis.__spaceCacheTime || 0) > 30000) {
          const [__cols, __allVars] = await Promise.all([
            figma.variables.getLocalVariableCollectionsAsync(),
            figma.variables.getLocalVariablesAsync(),
          ]);
          globalThis.__spaceCache = { cols: __cols, vars: __allVars.filter(v => v.resolvedType === 'FLOAT') };
          globalThis.__spaceCacheTime = Date.now();
        }
        const __spaceNum = (v) => {
          /* Resolve a FLOAT variable's first-mode value, following aliases. */
          let val = Object.values(v.valuesByMode)[0];
          let guard = 10;
          while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && guard-- > 0) {
            const t = (globalThis.__spaceCache.vars || []).find(x => x.id === val.id);
            if (!t) return null;
            val = Object.values(t.valuesByMode)[0];
          }
          return typeof val === 'number' ? val : null;
        };
        const __spaceNs = (name, kind) => {
          const n = String(name).toLowerCase();
          const head = n.split('/')[0];
          return kind === 'radius'
            ? (head.includes('radius') || head.includes('corner') || head.includes('rounded'))
            : (head.includes('space') || head.includes('spacing') || head.includes('gap') || head.includes('padding'));
        };
        const __spaceCollection = (kind) => {
          const c = globalThis.__spaceCache;
          const sibling = (c.vars || []).find(v => __spaceNs(v.name, kind));
          if (sibling) {
            const col = (c.cols || []).find(x => x.id === sibling.variableCollectionId);
            if (col) return col;
          }
          if (c.cols && c.cols.length) return c.cols[0];
          const created = figma.variables.createVariableCollection('Tokens');
          c.cols.push(created);
          return created;
        };
        const __findOrCreateSpaceVar = (value, kind) => {
          const c = globalThis.__spaceCache;
          const hit = (c.vars || []).find(v => __spaceNs(v.name, kind) && __spaceNum(v) === value);
          if (hit) return hit;
          const col = __spaceCollection(kind);
          if (!col) return null;
          const base = (kind === 'radius' ? 'radius/' : 'space/') + value + 'px';
          let name = base, i = 2;
          while ((c.vars || []).some(v => v.name === name)) name = base + '-' + (i++);
          let v;
          try { v = figma.variables.createVariable(name, col, 'FLOAT'); }
          catch (e) { return null; }
          for (const m of col.modes) {
            try { v.setValueForMode(m.modeId, value); } catch (e) {}
          }
          c.vars.push(v);
          return v;
        };
        const __space = (node, fields, value, kind) => {
          let variable = null;
          if (typeof value === 'string' && value.startsWith('var:')) {
            const key = value.slice(4);
            variable = typeof lookupVar === 'function' ? lookupVar(key) : null;
            if (!variable) {
              globalThis.__unresolvedVars = globalThis.__unresolvedVars || new Set();
              globalThis.__unresolvedVars.add(key);
              return;
            }
          } else {
            const num = Number(value);
            if (!isFinite(num) || num <= 0) return; /* 0 needs no token */
            variable = __findOrCreateSpaceVar(num, kind);
          }
          if (!variable) return;
          for (const f of fields) {
            try { node.setBoundVariable(f, variable); }
            catch (e) { try { node.setBoundVariable(f, variable.id); } catch (e2) {} }
          }
        };
    `;
  }

  /**
   * Helper preamble for <Instance>: component resolution that works across
   * pages and component sets, plus variant/property/text overrides. This is
   * what lets a render REUSE an existing design system instead of rebuilding
   * every card from raw frames.
   */
  generateInstanceHelperCode() {
    return `
        const __variantPairs = (s) => {
          const out = {};
          String(s).split(',').forEach(p => {
            const i = p.indexOf('=');
            if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
          });
          return out;
        };
        const __resolveComponent = async (id, name, variantStr) => {
          let node = null;
          if (id) {
            try { node = await figma.getNodeByIdAsync(id); } catch (e) {}
          } else if (name) {
            const match = n => (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') && n.name === name;
            node = figma.currentPage.findOne(match);
            if (!node) {
              // Components usually live on a dedicated page — search them all.
              try { await figma.loadAllPagesAsync(); } catch (e) {}
              for (const page of figma.root.children) {
                if (page === figma.currentPage) continue;
                try { node = page.findOne(match); } catch (e) { node = null; }
                if (node) break;
              }
            }
          }
          if (!node) return null;
          if (node.type === 'COMPONENT_SET') {
            let variant = null;
            if (variantStr) {
              const want = __variantPairs(variantStr);
              variant = node.children.find(c => {
                const have = __variantPairs(c.name);
                return Object.keys(want).every(k => have[k] === want[k]);
              }) || null;
            }
            return variant || node.defaultVariant || node.children[0] || null;
          }
          return node.type === 'COMPONENT' ? node : null;
        };
        // Map user-facing property names onto the instance's real keys.
        // Non-variant component properties carry a "#node:id" suffix in their
        // key ("Label#12:3") that callers shouldn't have to know about.
        // INSTANCE_SWAP values are resolved by COMPONENT NAME too, so callers
        // write prop:Icon="Icon=leaf" instead of hunting down a node id.
        const __mapProps = async (inst, raw) => {
          const defs = inst.componentProperties || {};
          const keys = Object.keys(defs);
          const out = {};
          for (const k of Object.keys(raw)) {
            const full = keys.find(dk => dk === k || dk.split('#')[0] === k);
            const key = full || k;
            const def = full ? defs[full] : null;
            let v = raw[k];
            if (def && def.type === 'BOOLEAN') {
              v = (v === true || v === 'true');
            } else if (def && def.type === 'INSTANCE_SWAP' && typeof v === 'string'
                       && !/^\\d+:\\d+$/.test(v) && !/^[0-9a-f]{20,}$/i.test(v)) {
              const target = await __resolveComponent(null, v, null);
              if (target) v = target.id;
              else {
                globalThis.__unresolvedVars = globalThis.__unresolvedVars || new Set();
                globalThis.__unresolvedVars.add('swap:' + v);
                continue;
              }
            }
            out[key] = v;
          }
          return out;
        };
        const __setInstanceText = async (inst, layerName, value) => {
          /* Prop keys can't contain spaces, layer names usually do
             ("Monstera Deliciosa"). Match space-insensitively so
             text:MonsteraDeliciosa="…" finds that layer. */
          const __norm = s => String(s).toLowerCase().replace(/\\s+/g, '');
          const t = inst.findOne(n => n.type === 'TEXT' && n.name === layerName)
            || inst.findOne(n => n.type === 'TEXT' && __norm(n.name) === __norm(layerName));
          if (!t) {
            globalThis.__unresolvedVars = globalThis.__unresolvedVars || new Set();
            globalThis.__unresolvedVars.add('text:' + layerName);
            return;
          }
          try {
            if (t.fontName !== figma.mixed) {
              await figma.loadFontAsync(t.fontName);
            } else {
              const fonts = t.getRangeAllFontNames(0, t.characters.length);
              for (const f of fonts) await figma.loadFontAsync(f);
            }
            t.characters = String(value);
          } catch (e) {}
        };
    `;
  }

  /**
   * Generate Plugin API code for a list of parsed child elements.
   * Shared by the single-render path (generateCode) and the batch path
   * (parseJSXBatch) so both support the same child types and props.
   * ctx: { counter: {value}, prefix: string (el-name prefix, e.g. '0_'),
   *        iconSvgMap: {name: svg} }
   */
  generateChildrenCode(items, parentVar, parentFlex, ctx) {
      return items.map(item => {
        const idx = ctx.prefix + (ctx.counter.value++);
        if (item._type === 'text') {
          const family = item.font || 'Inter';
          const style = this.weightToStyle(item.weight, item.italic);
          // size="var:text/md" binds fontSize to a FLOAT variable instead of
          // interpolating the raw string into `fontSize = var:text/md` (JS error).
          const sizeIsVar = this.isVarRef(item.size);
          const size = sizeIsVar ? 14 : numOr(item.size, 14);
          const sizeVarName = sizeIsVar ? String(item.size).slice(4) : null;
          const textStyleName = item.style || null;
          const color = item.color || '#000000';
          const fillWidth = item.w === 'fill';
          const textFillCode = this.generateFillCode(color, `el${idx}`);

          // Typography props that used to be in the known-prop list but were
          // never applied (silent footguns): lineHeight, letterSpacing, align.
          // Plus truncation (ellipsis / line-clamp), which Primer leans on.
          // lineHeight/letterSpacing accept a number (px), a "NN%" string, or
          // "auto" (lineHeight only). align maps to textAlignHorizontal.
          const dimUnit = (v) => {
            if (v === 'auto' || v === 'AUTO') return `{ unit: 'AUTO' }`;
            if (typeof v === 'string' && v.trim().endsWith('%')) return `{ value: ${parseFloat(v)}, unit: 'PERCENT' }`;
            return `{ value: ${Number(v)}, unit: 'PIXELS' }`;
          };
          const alignMapT = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED', start: 'LEFT', end: 'RIGHT' };
          const tAlign = item.align ? alignMapT[String(item.align).toLowerCase()] : null;
          const tLineHeight = item.lineHeight !== undefined ? dimUnit(item.lineHeight) : null;
          const tLetterSpacing = item.letterSpacing !== undefined ? dimUnit(item.letterSpacing) : null;
          const tTruncate = item.truncate === true || item.truncate === 'true';
          const tMaxLines = item.maxLines !== undefined ? parseInt(item.maxLines) : null;

          // Auto-FILL text in column layouts so Safe Mode wraps text correctly.
          const isCol = parentFlex === 'col' || parentFlex === 'column';
          const parentNone = parentFlex === 'none' || parentFlex === 'stack' || parentFlex === 'free';
          const autoFill = isCol && !fillWidth;

          // Auto text styles: every plain <Text> gets attached to a shared
          // local style ("Inter/14 Semi Bold") — reused when it exists,
          // created when it doesn't. Skipped when the caller already chose a
          // style, binds size to a variable, or overrides style-bound props
          // (lineHeight/letterSpacing would detach the style again).
          const autoStyle = !textStyleName && !sizeIsVar && !tLineHeight && !tLetterSpacing;
          return `
        __currentNode = ${JSON.stringify('Text: ' + String(item.content || '').substring(0, 30))};
        const el${idx} = figma.createText();
        el${idx}.fontName = __font(${JSON.stringify(family)}, ${JSON.stringify(style)});
        el${idx}.fontSize = ${size};
        ${tLineHeight ? `try { el${idx}.lineHeight = ${tLineHeight}; } catch(e) {}` : ''}
        ${tLetterSpacing ? `try { el${idx}.letterSpacing = ${tLetterSpacing}; } catch(e) {}` : ''}
        ${tAlign ? `el${idx}.textAlignHorizontal = '${tAlign}';` : ''}
        el${idx}.characters = ${JSON.stringify(item.content)};
        ${textFillCode.code}
        ${sizeVarName ? `{ const __v = lookupVar(${JSON.stringify(sizeVarName)}); if (__v) { try { el${idx}.setBoundVariable('fontSize', __v); } catch (e) {} } else { globalThis.__unresolvedVars.add(${JSON.stringify(sizeVarName)}); } }` : ''}
        ${textStyleName ? `await __applyTextStyle(el${idx}, ${JSON.stringify(textStyleName)});` : ''}
        ${autoStyle ? `await __ensureTextStyle(el${idx}, ${JSON.stringify(family)}, ${JSON.stringify(style)}, ${size});` : ''}
        ${parentVar}.appendChild(el${idx});
        ${fillWidth && !parentNone ? `el${idx}.layoutSizingHorizontal = 'FILL'; el${idx}.textAutoResize = 'HEIGHT';` : ''}
        ${autoFill ? `// Auto-FILL: text in col layout needs FILL for Safe Mode wrapping
        if (${parentVar}.layoutMode === 'VERTICAL' && (${parentVar}.counterAxisSizingMode === 'FIXED' || ${parentVar}.primaryAxisSizingMode === 'FIXED')) {
          try { el${idx}.layoutSizingHorizontal = 'FILL'; el${idx}.textAutoResize = 'HEIGHT'; } catch(e) {}
        }` : ''}
        ${tTruncate || tMaxLines !== null ? `try { el${idx}.textTruncation = 'ENDING'; } catch(e) {}` : ''}
        ${tMaxLines !== null ? `try { el${idx}.maxLines = ${tMaxLines}; } catch(e) {}` : ''}`;
        } else if (item._type === 'frame') {
          // Nested frame (button, etc.)
          const fName = item.name || 'Nested Frame';
          const fBg = item.bg || item.fill || null;
          const fStroke = item.stroke || null;
          const fStrokeWidth = item.strokeWidth || 1;
          const fStrokeAlign = item.strokeAlign || null;
          const fRounded = item.rounded || item.radius || 0;
          const fFlex = item.flex || 'row';
          const fGap = item.gap || 0;
          // Default padding is 0 (only set padding when explicitly specified)
          const fP = item.p !== undefined ? item.p : (item.padding !== undefined ? item.padding : null);
          const fPx = item.px !== undefined ? item.px : (fP !== null ? fP : 0);
          const fPy = item.py !== undefined ? item.py : (fP !== null ? fP : 0);
          // Individual padding overrides (pt, pr, pb, pl)
          const fPt = item.pt !== undefined ? Number(item.pt) : Number(fPy);
          const fPr = item.pr !== undefined ? Number(item.pr) : Number(fPx);
          const fPb = item.pb !== undefined ? Number(item.pb) : Number(fPy);
          const fPl = item.pl !== undefined ? Number(item.pl) : Number(fPx);
          // Sensible alignment defaults (match the root-frame paths, which
          // already default to start): content reads top-left, not centered.
          // EXCEPTION: a row's cross axis stays centered, because vertically
          // centering icon+text in a row/cell is almost always what's wanted.
          // Explicit justify=/items= always win. This fixes the recurring
          // "title/cell content is centered / avatars are staggered" papercut.
          const isColFrame = fFlex === 'col' || fFlex === 'column';
          // Read `items` too (not just `align`) — the root paths accept both,
          // nested previously ignored `items` (it only worked by coincidence
          // when the default matched).
          const fAlign = item.items || item.align || (isColFrame ? 'start' : 'center');
          const fJustify = item.justify || 'start';
          // Clip defaults to false for nested frames (overflow="hidden" also sets clip)
          const fClip = item.clip === 'true' || item.clip === true || item.overflow === 'hidden';

          // NEW: wrap, wrapGap, grow, position props
          const fWrap = item.wrap === true || item.wrap === 'true';
          const fWrapGap = Number(item.wrapGap || item.rowGap || item.counterAxisSpacing || 0);
          const fGrow = item.grow !== undefined ? Number(item.grow) : null;
          const fPosition = item.position || 'auto';
          const fAbsoluteX = item.x !== undefined ? Number(item.x) : 0;
          const fAbsoluteY = item.y !== undefined ? Number(item.y) : 0;
          // Generic node-level visuals (same as top-level)
          const fOpacity = item.opacity !== undefined ? Number(item.opacity) : null;
          const fVisible = item.visible === false || item.visible === 'false' ? false : null;
          const fLocked = item.locked === true || item.locked === 'true' ? true : null;
          // Edge-anchored absolute positioning (per directededges Absolute
          // Positioning spec). top/right/bottom/left are edge-relative. If
          // both opposite edges are given → STRETCH (and width/height are
          // ignored, derived from parent). centerOffsetX/Y → CENTER constraint.
          // Strings ending in "%" → SCALE constraint.
          const fTop    = item.top    !== undefined ? item.top    : null;
          const fRight  = item.right  !== undefined ? item.right  : null;
          const fBottom = item.bottom !== undefined ? item.bottom : null;
          const fLeft   = item.left   !== undefined ? item.left   : null;
          const fCenterOffsetX = item.centerOffsetX !== undefined ? Number(item.centerOffsetX) : null;
          const fCenterOffsetY = item.centerOffsetY !== undefined ? Number(item.centerOffsetY) : null;
          const hasEdgeAttrs = fTop !== null || fRight !== null || fBottom !== null || fLeft !== null
                              || fCenterOffsetX !== null || fCenterOffsetY !== null;
          // If any edge attr is set, position defaults to absolute.
          const effectivePosition = hasEdgeAttrs ? 'absolute' : fPosition;

          // Support w="fill" / "hug" keywords on nested frames. fill = stretch
          // to fill the auto-layout cross-axis; hug = size to children.
          // These are NOT numeric — never interpolate into resize() directly.
          const fillWidth = item.w === 'fill';
          const fillHeight = item.h === 'fill';
          const hugWidth = item.w === 'hug';
          const hugHeight = item.h === 'hug';

          // Percentage sizing: w="60%" / h="50%" resolves to a FIXED px size =
          // that fraction of the PARENT's resolved dimension at append time
          // (auto-layout has no native %, so we compute it). Without this the
          // "60%" string used to leak into resize() and produce broken JS.
          const pctOf = v => (typeof v === 'string' && /^\d+(\.\d+)?%$/.test(v)) ? parseFloat(v) / 100 : null;
          const pctW = pctOf(item.w) !== null ? pctOf(item.w) : pctOf(item.width);
          const pctH = pctOf(item.h) !== null ? pctOf(item.h) : pctOf(item.height);

          // HUG by default, FIXED only if explicit numeric size given.
          // Percentages and the fill/hug keywords are NOT numeric — never let
          // them reach resize() as raw strings.
          const isNumeric = v => v !== undefined && v !== 'fill' && v !== 'hug' && pctOf(v) === null;
          const numericW = isNumeric(item.w) ? item.w : isNumeric(item.width) ? item.width : undefined;
          const numericH = isNumeric(item.h) ? item.h : isNumeric(item.height) ? item.height : undefined;
          const hasWidth = numericW !== undefined;
          const hasHeight = numericH !== undefined;
          const fWidth = numericW !== undefined ? numOr(numericW, 100) : 100;
          const fHeight = numericH !== undefined ? numOr(numericH, 40) : 40;

          // Map align/justify to Figma values
          const alignMap = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
          const justifyMap = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };
          const fAlignVal = alignMap[fAlign] || 'CENTER';
          const fJustifyVal = justifyMap[fJustify] || alignMap[fJustify] || 'CENTER';

          const nestedChildren = item._children ? this.generateChildrenCode(item._children, `el${idx}`, fFlex, ctx) : '';
          const frameFillCode = fBg ? this.generateFillCode(fBg, `el${idx}`) : { code: `el${idx}.fills = [];`, usesVars: false };
          const frameStrokeCode = fStroke ? this.generateStrokeCode(fStroke, `el${idx}`, fStrokeWidth, fStrokeAlign) : { code: '' };
          const frameEffectsCode = this.generateEffectsCode(item, `el${idx}`);

          // `stretch={true}` fills the CROSS axis of the parent (vertical when
          // the parent is a row, horizontal when it's a col). This was a known
          // prop that previously did nothing — a silent footgun where dividers
          // never filled their parent's height.
          const isStretch = item.stretch === true || item.stretch === 'true';
          const crossIsV = parentFlex === 'row';   // cross axis of a row = vertical
          const crossIsH = parentFlex === 'col';   // cross axis of a col = horizontal

          // Thin-divider auto-fill guard: a 1–2px-thin child (a divider/rule)
          // whose long (cross) axis is left UNSET would otherwise default to a
          // 100px frame and inflate the whole parent ("looks zu hoch"). When the
          // short axis is a small fixed number and the cross axis is unspecified,
          // auto-fill the cross axis so the rule spans the parent instead.
          const thinW = hasWidth && Number(numericW) <= 2 && !hasHeight && !fillHeight && !hugHeight;
          const thinH = hasHeight && Number(numericH) <= 2 && !hasWidth && !fillWidth && !hugWidth;
          const autoFillV = thinW && crossIsV;
          const autoFillH = thinH && crossIsH;

          // Determine sizing: FILL, FIXED, or HUG for each axis. An explicit
          // `hug` keyword forces HUG regardless of whether a number was given.
          // A percentage forces FIXED (px resolved from the parent at runtime).
          const wantFillH = fillWidth || (fGrow !== null && parentFlex === 'row') || (isStretch && crossIsH) || autoFillH;
          const wantFillV = fillHeight || (fGrow !== null && parentFlex === 'col') || (isStretch && crossIsV) || autoFillV;
          const hSizing = pctW !== null ? 'FIXED' : wantFillH ? 'FILL' : hugWidth ? 'HUG' : (hasWidth ? 'FIXED' : 'HUG');
          const vSizing = pctH !== null ? 'FIXED' : wantFillV ? 'FILL' : hugHeight ? 'HUG' : (hasHeight ? 'FIXED' : 'HUG');

          // Initial resize: for an axis that will FILL, seed it at 1px (not the
          // 100px default) so the parent hugs to its REAL content before FILL is
          // applied. Otherwise a divider's 100px default determines the hug and
          // FILL can't shrink it back (the "zu hoch" footgun).
          const resizeW = hasWidth ? fWidth : (wantFillH ? 1 : 100);
          const resizeH = hasHeight ? fHeight : (wantFillV ? 1 : 100);

          // flex="none" (aliases: stack/free) → no auto-layout. Children keep
          // their own x/y, so they OVERLAP (z-stack): spinners (ring+arc),
          // badges on avatars, layered graphics. Auto-layout-only props (gap,
          // padding, align, sizing) must be skipped or Figma throws on NONE.
          const isNone = fFlex === 'none' || fFlex === 'stack' || fFlex === 'free';
          const parentIsNone = parentFlex === 'none' || parentFlex === 'stack' || parentFlex === 'free';
          return `
        __currentNode = ${JSON.stringify('Frame: ' + String(fName))};
        const el${idx} = figma.createFrame();
        el${idx}.name = ${JSON.stringify(fName)};
        el${idx}.layoutMode = '${isNone ? 'NONE' : (fFlex === 'row' ? 'HORIZONTAL' : 'VERTICAL')}';
        ${!isNone && fWrap && fFlex === 'row' ? `el${idx}.layoutWrap = 'WRAP';` : ''}
        ${hasWidth || hasHeight || (!isNone && (wantFillH || wantFillV)) ? `el${idx}.resize(${resizeW}, ${resizeH});` : ''}
        ${isNone ? '' : `el${idx}.itemSpacing = ${this.spacingRaw(fGap)};
        el${idx}.paddingTop = ${this.spacingRaw(fPt)};
        el${idx}.paddingBottom = ${this.spacingRaw(fPb)};
        el${idx}.paddingLeft = ${this.spacingRaw(fPl)};
        el${idx}.paddingRight = ${this.spacingRaw(fPr)};
        ${this.spacingBind(`el${idx}`, ['itemSpacing'], fGap, 'space')}
        ${this.spacingBind(`el${idx}`, ['paddingTop'], fPt, 'space')}
        ${this.spacingBind(`el${idx}`, ['paddingBottom'], fPb, 'space')}
        ${this.spacingBind(`el${idx}`, ['paddingLeft'], fPl, 'space')}
        ${this.spacingBind(`el${idx}`, ['paddingRight'], fPr, 'space')}`}
        el${idx}.cornerRadius = ${this.spacingRaw(fRounded)};
        ${this.spacingBind(`el${idx}`, ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'], fRounded, 'radius')}
        ${frameFillCode.code}
        ${frameStrokeCode.code}
        ${frameEffectsCode}
        ${isNone ? '' : `el${idx}.primaryAxisAlignItems = '${fJustifyVal}';
        el${idx}.counterAxisAlignItems = '${fAlignVal}';`}
        el${idx}.clipsContent = ${fClip};
        ${fOpacity !== null ? `el${idx}.opacity = ${fOpacity};` : ''}
        ${fVisible === false ? `el${idx}.visible = false;` : ''}
        ${fLocked === true ? `el${idx}.locked = true;` : ''}
        ${parentVar}.appendChild(el${idx});
        ${parentIsNone ? '' : `el${idx}.layoutSizingHorizontal = '${hSizing}';
        el${idx}.layoutSizingVertical = '${vSizing}';`}
        ${pctW !== null || pctH !== null ? `try {
          const _pp = el${idx}.parent;
          if (_pp && 'width' in _pp) {
            ${pctW !== null ? `el${idx}.resize(Math.max(1, Math.round(_pp.width * ${pctW})), el${idx}.height);` : ''}
            ${pctH !== null ? `el${idx}.resize(el${idx}.width, Math.max(1, Math.round(_pp.height * ${pctH})));` : ''}
          }
        } catch (e) {}` : ''}
        ${nestedChildren}
        ${fWrap && fFlex === 'row' && fWrapGap > 0 ? `el${idx}.counterAxisSpacing = ${fWrapGap};
        ${this.spacingBind(`el${idx}`, ['counterAxisSpacing'], fWrapGap, 'space')}` : ''}
        ${parentIsNone ? `
          ${item.x !== undefined ? `el${idx}.x = ${fAbsoluteX};` : ''}
          ${item.y !== undefined ? `el${idx}.y = ${fAbsoluteY};` : ''}
        ` : effectivePosition === 'absolute' ? `
          el${idx}.layoutPositioning = 'ABSOLUTE';
          (function applyEdges() {
            const pp = el${idx}.parent;
            if (!pp || !('width' in pp)) {
              el${idx}.x = ${fAbsoluteX}; el${idx}.y = ${fAbsoluteY};
              return;
            }
            const pw = pp.width, ph = pp.height;
            // Resolve edge values: numbers are px, strings ending in "%" are proportional
            const resolve = (v, total) => {
              if (v == null) return null;
              if (typeof v === 'string' && v.endsWith('%')) return parseFloat(v) / 100 * total;
              return Number(v);
            };
            const top    = ${JSON.stringify(fTop)};
            const right  = ${JSON.stringify(fRight)};
            const bottom = ${JSON.stringify(fBottom)};
            const left   = ${JSON.stringify(fLeft)};
            const coX    = ${JSON.stringify(fCenterOffsetX)};
            const coY    = ${JSON.stringify(fCenterOffsetY)};
            const c = { horizontal: el${idx}.constraints.horizontal, vertical: el${idx}.constraints.vertical };
            const isScale = (v) => typeof v === 'string' && v.endsWith('%');
            // Horizontal axis
            if (left != null && right != null) {
              const l = resolve(left, pw), r = resolve(right, pw);
              el${idx}.x = l;
              el${idx}.resize(Math.max(1, pw - l - r), el${idx}.height);
              c.horizontal = (isScale(left) || isScale(right)) ? 'SCALE' : 'STRETCH';
            } else if (right != null) {
              const r = resolve(right, pw);
              el${idx}.x = pw - el${idx}.width - r;
              c.horizontal = 'MAX';
            } else if (left != null) {
              el${idx}.x = resolve(left, pw);
              c.horizontal = 'MIN';
            } else if (coX != null) {
              el${idx}.x = (pw - el${idx}.width) / 2 + coX;
              c.horizontal = 'CENTER';
            } else if (${fAbsoluteX} !== 0 || ${fAbsoluteX === 0 && fTop === null && fBottom === null && fLeft === null && fRight === null && fCenterOffsetX === null}) {
              el${idx}.x = ${fAbsoluteX};
            }
            // Vertical axis (same patterns)
            if (top != null && bottom != null) {
              const t = resolve(top, ph), b = resolve(bottom, ph);
              el${idx}.y = t;
              el${idx}.resize(el${idx}.width, Math.max(1, ph - t - b));
              c.vertical = (isScale(top) || isScale(bottom)) ? 'SCALE' : 'STRETCH';
            } else if (bottom != null) {
              const b = resolve(bottom, ph);
              el${idx}.y = ph - el${idx}.height - b;
              c.vertical = 'MAX';
            } else if (top != null) {
              el${idx}.y = resolve(top, ph);
              c.vertical = 'MIN';
            } else if (coY != null) {
              el${idx}.y = (ph - el${idx}.height) / 2 + coY;
              c.vertical = 'CENTER';
            } else if (${fAbsoluteY} !== 0 || ${fAbsoluteY === 0 && fTop === null && fBottom === null && fLeft === null && fRight === null && fCenterOffsetY === null}) {
              el${idx}.y = ${fAbsoluteY};
            }
            el${idx}.constraints = c;
          })();` : ''}`;
        } else if (item._type === 'rect') {
          // Rectangle element
          const rWidth = numOr(item.w ?? item.width, 100);
          const rHeight = numOr(item.h ?? item.height, 100);
          const rBg = item.bg || item.fill || '#e4e4e7';
          const rRounded = item.rounded || item.radius || 0;
          const rName = item.name || 'Rectangle';
          const rectFillCode = this.generateFillCode(rBg, `el${idx}`);

          return `
        const el${idx} = figma.createRectangle();
        el${idx}.name = ${JSON.stringify(rName)};
        el${idx}.resize(${rWidth}, ${rHeight});
        el${idx}.cornerRadius = ${this.spacingRaw(rRounded)};
        ${this.spacingBind(`el${idx}`, ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'], rRounded, 'radius')}
        ${rectFillCode.code}
        ${parentVar}.appendChild(el${idx});
        ${this.genCommonNodeProps(item, `el${idx}`, parentFlex === 'none' || parentFlex === 'stack' || parentFlex === 'free')}`;
        } else if (item._type === 'ellipse') {
          // Ellipse / Circle. arc (sweep degrees) + arcStart (start degrees,
          // 0 = 3 o'clock, clockwise) + innerRadius (0–1) make rings, spinners,
          // donut and pie slices. No arc/innerRadius = a plain filled ellipse.
          const eW = numOr(item.w ?? item.width, 100);
          const eH = numOr(item.h ?? item.height, eW);
          const eName = item.name || 'Ellipse';
          const eBg = item.bg || item.fill || null;
          const eStroke = item.stroke || null;
          const eStrokeWidth = item.strokeWidth || 1;
          const eStrokeAlign = item.strokeAlign || null;
          const inner = item.innerRadius !== undefined ? Math.max(0, Math.min(1, Number(item.innerRadius))) : 0;
          const hasArc = item.arc !== undefined || item.arcStart !== undefined || inner > 0;
          const startDeg = item.arcStart !== undefined ? Number(item.arcStart) : 0;
          const sweepDeg = item.arc !== undefined ? Number(item.arc) : 360;
          const startRad = startDeg * Math.PI / 180;
          const endRad = (startDeg + sweepDeg) * Math.PI / 180;
          const ellFillCode = eBg ? this.generateFillCode(eBg, `el${idx}`) : { code: '' };
          const ellStrokeCode = eStroke ? this.generateStrokeCode(eStroke, `el${idx}`, eStrokeWidth, eStrokeAlign) : { code: '' };
          return `
        const el${idx} = figma.createEllipse();
        el${idx}.name = ${JSON.stringify(eName)};
        el${idx}.resize(${eW}, ${eH});
        ${ellFillCode.code}
        ${ellStrokeCode.code}
        ${hasArc ? `try { el${idx}.arcData = { startingAngle: ${startRad}, endingAngle: ${endRad}, innerRadius: ${inner} }; } catch(e) {}` : ''}
        ${parentVar}.appendChild(el${idx});
        ${this.genCommonNodeProps(item, `el${idx}`, parentFlex === 'none' || parentFlex === 'stack' || parentFlex === 'free')}`;
        } else if (item._type === 'image') {
          // Image placeholder (gray rectangle with image icon concept)
          const iWidth = numOr(item.w ?? item.width, 200);
          const iHeight = numOr(item.h ?? item.height, 150);
          const iBg = item.bg || '#f4f4f5';
          const iRounded = item.rounded || item.radius || 8;
          const iName = item.name || 'Image';
          const imgFillCode = this.generateFillCode(iBg, `el${idx}`);

          return `
        const el${idx} = figma.createRectangle();
        el${idx}.name = ${JSON.stringify(iName)};
        el${idx}.resize(${iWidth}, ${iHeight});
        el${idx}.cornerRadius = ${this.spacingRaw(iRounded)};
        ${this.spacingBind(`el${idx}`, ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'], iRounded, 'radius')}
        ${imgFillCode.code}
        ${parentVar}.appendChild(el${idx});
        ${this.genCommonNodeProps(item, `el${idx}`, parentFlex === 'none' || parentFlex === 'stack' || parentFlex === 'free')}`;
        } else if (item._type === 'icon') {
          const icSize = numOr(item.size ?? item.s, 24);
          const icBg = item.color || item.c || '#71717a';
          const icName = item.name || 'Icon';
          const svgData = ctx.iconSvgMap[icName];

          if (svgData) {
            // Real SVG icon from Iconify
            // IMPORTANT: createNodeFromSvg creates a Frame wrapper. We must:
            // 1. Clear fills on the wrapper frame (otherwise it shows as a filled square)
            // 2. Only colorize the vector children inside, not the wrapper
            const colorCode = icBg.startsWith('var:') ? '' : (() => {
              const rgb = this.hexToRgb(icBg);
              return rgb ? `
            function colorize${idx}(n) {
              if (n.fills && n.fills.length > 0) n.fills = [{type:'SOLID',color:{r:${rgb.r},g:${rgb.g},b:${rgb.b}}}];
              if (n.strokes && n.strokes.length > 0) n.strokes = [{type:'SOLID',color:{r:${rgb.r},g:${rgb.g},b:${rgb.b}}}];
              if (n.children) n.children.forEach(colorize${idx});
            }
            if (el${idx}.children) el${idx}.children.forEach(colorize${idx});` : '';
            })();

            // Variable color binding for icons
            const varColorCode = icBg.startsWith('var:') ? (() => {
              const varName = icBg.slice(4);
              return `
            { const __v = lookupVar(${JSON.stringify(varName)}); if (__v) {
              function colorizeVar${idx}(n) {
                if (n.fills && n.fills.length > 0) n.fills = [boundFill(__v)];
                if (n.strokes && n.strokes.length > 0) n.strokes = [figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:0.5,g:0.5,b:0.5}},'color',__v)];
                if (n.children) n.children.forEach(colorizeVar${idx});
              }
              if (el${idx}.children) el${idx}.children.forEach(colorizeVar${idx});
            } }`;
            })() : '';

            return `
        const el${idx} = figma.createNodeFromSvg(${JSON.stringify(svgData)});
        el${idx}.name = ${JSON.stringify(icName)};
        el${idx}.fills = [];
        el${idx}.resize(${icSize}, ${icSize});
        ${colorCode}${varColorCode}
        ${parentVar}.appendChild(el${idx});`;
          } else {
            // Fallback: placeholder rectangle
            const iconFillCode = this.generateFillCode(icBg, `el${idx}`);
            return `
        const el${idx} = figma.createRectangle();
        el${idx}.name = ${JSON.stringify(icName)};
        el${idx}.resize(${icSize}, ${icSize});
        el${idx}.cornerRadius = ${Math.round(icSize / 4)};
        ${iconFillCode.code}
        ${parentVar}.appendChild(el${idx});`;
          }
        } else if (item._type === 'instance') {
          // Component instance. `id` (or an id-shaped `component` value, kept
          // for backwards compatibility) resolves by node id; `component` /
          // `name` resolve by exact name — current page first, then every
          // other page. Component SETS resolve to a variant, picked via
          // variant="Axis=Value[, Axis2=Value2]" or the set's default.
          // Overrides: prop:Name="…" → setProperties (BOOLEAN coerced),
          // text:Layer="…" → characters of the named TEXT descendant.
          const idLike = v => typeof v === 'string' && /^\d+:\d+$/.test(v);
          const compId = item.id || (idLike(item.component) ? item.component : null);
          const compName = !compId ? (item.component || item.name) : null;
          if (!compId && !compName) return '';
          const variantStr = item.variant || null;
          const textOverrides = {};
          const propOverrides = {};
          for (const k of Object.keys(item)) {
            if (k.startsWith('text:')) textOverrides[k.slice(5)] = item[k];
            else if (k.startsWith('prop:')) propOverrides[k.slice(5)] = item[k];
          }
          const isNum = v => v !== undefined && v !== 'fill' && v !== 'hug' && !isNaN(parseFloat(v));
          const instW = isNum(item.w) ? numOr(item.w, null) : isNum(item.width) ? numOr(item.width, null) : null;
          const instH = isNum(item.h) ? numOr(item.h, null) : isNum(item.height) ? numOr(item.height, null) : null;
          const fillW = item.w === 'fill' || item.width === 'fill';
          const fillH = item.h === 'fill' || item.height === 'fill';
          const textCode = Object.entries(textOverrides).map(([k, v]) =>
            `await __setInstanceText(el${idx}, ${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n          ');
          return `
        __currentNode = ${JSON.stringify('Instance: ' + String(compName || compId))};
        const comp${idx} = await __resolveComponent(${JSON.stringify(compId)}, ${JSON.stringify(compName)}, ${JSON.stringify(variantStr)});
        if (comp${idx}) {
          const el${idx} = comp${idx}.createInstance();
          ${item.name && item.component ? `el${idx}.name = ${JSON.stringify(item.name)};` : ''}
          ${parentVar}.appendChild(el${idx});
          ${variantStr ? `try { el${idx}.setProperties(__variantPairs(${JSON.stringify(variantStr)})); } catch (e) {}` : ''}
          ${Object.keys(propOverrides).length ? `try { el${idx}.setProperties(await __mapProps(el${idx}, ${JSON.stringify(propOverrides)})); } catch (e) {}` : ''}
          ${textCode}
          ${instW !== null && instH !== null ? `try { el${idx}.resize(${instW}, ${instH}); } catch (e) {}` : ''}
          ${fillW ? `try { el${idx}.layoutSizingHorizontal = 'FILL'; } catch (e) {}` : ''}
          ${fillH ? `try { el${idx}.layoutSizingVertical = 'FILL'; } catch (e) {}` : ''}
        } else {
          globalThis.__unresolvedVars = globalThis.__unresolvedVars || new Set();
          globalThis.__unresolvedVars.add('component:' + ${JSON.stringify(compName || compId)});
        }`;
        } else if (item._type === 'slot') {
          // Slot element - creates slot inside component
          // NOTE: createSlot only works when parent is a component
          const slotName = item.name || 'Slot';
          const slotFlex = item.flex || 'col';
          const slotGap = item.gap || 0;
          const slotP = item.p !== undefined ? item.p : (item.padding !== undefined ? item.padding : null);
          const slotPx = item.px !== undefined ? item.px : (slotP !== null ? slotP : 0);
          const slotPy = item.py !== undefined ? item.py : (slotP !== null ? slotP : 0);
          const slotBg = item.bg || item.fill || null;
          const slotWidth = (item.w ?? item.width) !== undefined ? numOr(item.w ?? item.width, 100) : undefined;
          const slotHeight = (item.h ?? item.height) !== undefined ? numOr(item.h ?? item.height, 100) : undefined;
          const fillWidth = item.w === 'fill';
          const fillHeight = item.h === 'fill';

          const nestedChildren = item._children ? this.generateChildrenCode(item._children, `slot${idx}`, slotFlex, ctx) : '';
          const slotFillCode = slotBg ? this.generateFillCode(slotBg, `slot${idx}`) : { code: '' };

          return `
        // Create slot (only works if parent is a component)
        let slot${idx} = null;
        if (${parentVar}.type === 'COMPONENT' || ${parentVar}.type === 'COMPONENT_SET') {
          slot${idx} = ${parentVar}.createSlot(${JSON.stringify(slotName)});
        } else {
          // Fall back to regular frame if parent is not a component
          slot${idx} = figma.createFrame();
          slot${idx}.name = ${JSON.stringify(slotName)};
          ${parentVar}.appendChild(slot${idx});
        }
        slot${idx}.layoutMode = '${slotFlex === 'row' ? 'HORIZONTAL' : 'VERTICAL'}';
        slot${idx}.itemSpacing = ${this.spacingRaw(slotGap)};
        slot${idx}.paddingTop = ${this.spacingRaw(slotPy)};
        slot${idx}.paddingBottom = ${this.spacingRaw(slotPy)};
        slot${idx}.paddingLeft = ${this.spacingRaw(slotPx)};
        slot${idx}.paddingRight = ${this.spacingRaw(slotPx)};
        ${this.spacingBind(`slot${idx}`, ['itemSpacing'], slotGap, 'space')}
        ${this.spacingBind(`slot${idx}`, ['paddingTop', 'paddingBottom'], slotPy, 'space')}
        ${this.spacingBind(`slot${idx}`, ['paddingLeft', 'paddingRight'], slotPx, 'space')}
        ${slotWidth && !fillWidth ? `slot${idx}.resize(${slotWidth}, ${slotHeight || 100});` : ''}
        ${fillWidth ? `slot${idx}.layoutSizingHorizontal = 'FILL';` : ''}
        ${fillHeight ? `slot${idx}.layoutSizingVertical = 'FILL';` : ''}
        ${slotFillCode.code}
        ${nestedChildren}`;
        }
        return '';
      }).join('\n');
  }

  generateCode(props, children, iconSvgMap = {}) {
    const name = props.name || 'Frame';
    const rawWidth = props.w || props.width;
    const rawHeight = props.h || props.height;
    // Support w="fill" / w="hug" (and same for h) on the root frame. Both
    // are sizing keywords — never interpolate raw into resize() or you get
    // ReferenceError: 'fill' / 'hug' is not defined. (NB: don't shadow the
    // existing `hugWidth/Height` from the `hug` prop below — that one is set
    // via `hug="w"` / `hug="h"` / `hug="both"` and resolves the same flag.)
    const fillWidth = rawWidth === 'fill';
    const fillHeight = rawHeight === 'fill';
    const wHug = rawWidth === 'hug';
    const hHug = rawHeight === 'hug';
    const isNumeric = v => v !== undefined && v !== 'fill' && v !== 'hug';
    const numericWidth = isNumeric(rawWidth) ? rawWidth : undefined;
    const numericHeight = isNumeric(rawHeight) ? rawHeight : undefined;
    const hasExplicitWidth = numericWidth !== undefined;
    const hasExplicitHeight = numericHeight !== undefined;
    const width = numericWidth !== undefined ? numOr(numericWidth, 320) : 320;
    const height = numericHeight !== undefined ? numOr(numericHeight, 200) : 200;
    const bg = props.bg || props.fill || null;
    const stroke = props.stroke || null;
    const strokeWidth = props.strokeWidth || 1;
    const strokeAlignProp = props.strokeAlign || null;
    const rounded = props.rounded || props.radius || 0;
    const flex = props.flex || 'col';
    const gap = props.gap || 0;
    const p = props.p || props.padding || 0;
    const px = props.px || p;
    const py = props.py || p;
    const align = props.items || props.align || 'MIN';
    const justify = props.justify || 'MIN';
    const useSmartPos = props.x === undefined;
    const explicitX = props.x || 0;
    const y = numOr(props.y, 0);
    // New: clip defaults to false (don't clip auto-layout overflow). overflow="hidden" also sets clip.
    const clip = props.clip === 'true' || props.clip === true || props.overflow === 'hidden';
    // Generic node-level visuals — apply on the root frame too (single-render path)
    const opacity = props.opacity !== undefined ? Number(props.opacity) : null;
    const visible = props.visible === false || props.visible === 'false' ? false : null;
    const locked = props.locked === true || props.locked === 'true' ? true : null;
    // New: hug for auto-sizing (hug="both" | "w" | "h" | "width" | "height")
    // OR the keyword form w="hug" / h="hug" set wHug/hHug above.
    const hug = props.hug || '';
    const hugWidth = wHug || hug === 'both' || hug === 'w' || hug === 'width';
    const hugHeight = hHug || hug === 'both' || hug === 'h' || hug === 'height';
    // New: wrap and wrapGap for horizontal layouts
    const wrap = props.wrap === true || props.wrap === 'true';
    const wrapGap = Number(props.wrapGap || props.rowGap || props.counterAxisSpacing || 0);

    // Track variable usage for fast binding
    let usesVars = false;
    const checkVarUsage = (value) => {
      if (this.isVarRef(value)) usesVars = true;
    };

    // Check root frame for var usage (including spacing/radius refs, which
    // need the var cache just as much as a fill does)
    checkVarUsage(bg);
    if (stroke) checkVarUsage(stroke);
    for (const k of ['gap', 'rowGap', 'wrapGap', 'counterAxisSpacing', 'p', 'padding',
      'px', 'py', 'pt', 'pr', 'pb', 'pl', 'rounded', 'radius']) checkVarUsage(props[k]);

    // Collect all fonts and check variable usage recursively
    const collected = this.collectFontsAndVarUsage(children);
    if (collected.usesVars) usesVars = true;

    const childCode = this.generateChildrenCode(children, 'frame', flex, { counter: { value: 0 }, prefix: '', iconSvgMap });

    // Map align/justify to Figma values for root frame
    const alignMap = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
    const justifyMap = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };
    const alignVal = alignMap[align] || 'MIN';
    const justifyVal = justifyMap[justify] || alignMap[justify] || 'MIN';

    // Smart positioning code
    const smartPosCode = useSmartPos ? `
        let smartX = 0;
        const children = figma.currentPage.children;
        if (children.length > 0) {
          let maxRight = 0;
          children.forEach(n => {
            const right = n.x + (n.width || 0);
            if (right > maxRight) maxRight = right;
          });
          smartX = Math.round(maxRight + 100);
        }
    ` : `const smartX = ${explicitX};`;

    // Generate fill/stroke code for root frame
    const rootFillCode = this.generateFillCode(bg, 'frame');
    const rootStrokeCode = stroke ? this.generateStrokeCode(stroke, 'frame', strokeWidth, strokeAlignProp) : { code: '', usesVars: false };
    const rootEffectsCode = this.generateEffectsCode(props, 'frame');
    const rootImageCode = props.image ? this.generateImageFillCode(props.image, 'frame', props.imageScale) : '';

    // Variable loading code with caching (only if any vars used)
    const colFilter2 = this.collectionFilter;
    const varLoadCode = usesVars ? this.varPreambleCode(colFilter2) : '';

    // Font loading with caching (shared emitter, includes __font helper)
    const fontLoadCode = this.generateFontLoadCode(collected.fonts);

    return `
      (async function() {
        ${fontLoadCode}
        ${varLoadCode}
        ${collected.usesTextStyles || collected.hasText ? this.generateTextStyleHelperCode() : ''}
        ${collected.hasSpacing || this.hasSpacingProps(props) ? this.generateSpacingHelperCode() : ''}
        ${collected.usesInstances ? this.generateInstanceHelperCode() : ''}
        ${smartPosCode}

        let __currentNode = 'root';
        try {
        const frame = figma.createFrame();
        __currentNode = ${JSON.stringify(name)};
        frame.name = ${JSON.stringify(name)};
        frame.resize(${width}, ${height});
        frame.x = smartX;
        frame.y = ${y};
        frame.cornerRadius = ${this.spacingRaw(rounded)};
        ${this.spacingBind('frame', ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'], rounded, 'radius')}
        ${rootFillCode.code}
        ${rootStrokeCode.code}
        ${rootEffectsCode}
        ${rootImageCode}
        frame.layoutMode = '${flex === 'none' || flex === 'stack' || flex === 'free' ? 'NONE' : (flex === 'row' ? 'HORIZONTAL' : 'VERTICAL')}';
        ${flex === 'none' || flex === 'stack' || flex === 'free' ? '' : `${wrap && flex === 'row' ? `frame.layoutWrap = 'WRAP';` : ''}
        frame.itemSpacing = ${this.spacingRaw(gap)};
        frame.paddingTop = ${this.spacingRaw(py)};
        frame.paddingBottom = ${this.spacingRaw(py)};
        frame.paddingLeft = ${this.spacingRaw(px)};
        frame.paddingRight = ${this.spacingRaw(px)};
        ${this.spacingBind('frame', ['itemSpacing'], gap, 'space')}
        ${this.spacingBind('frame', ['paddingTop', 'paddingBottom'], py, 'space')}
        ${this.spacingBind('frame', ['paddingLeft', 'paddingRight'], px, 'space')}
        frame.primaryAxisAlignItems = '${justifyVal}';
        frame.counterAxisAlignItems = '${alignVal}';
        frame.primaryAxisSizingMode = '${flex === 'col' ? (hugHeight || fillHeight || !hasExplicitHeight ? 'AUTO' : 'FIXED') : (hugWidth || fillWidth || !hasExplicitWidth ? 'AUTO' : 'FIXED')}';
        frame.counterAxisSizingMode = '${flex === 'col' ? (hugWidth || fillWidth || !hasExplicitWidth ? 'AUTO' : 'FIXED') : (hugHeight || fillHeight || !hasExplicitHeight ? 'AUTO' : 'FIXED')}';
        ${fillWidth ? `frame.layoutSizingHorizontal = 'FILL';` : ''}
        ${fillHeight ? `frame.layoutSizingVertical = 'FILL';` : ''}
        ${wrap && flex === 'row' && wrapGap > 0 ? `frame.counterAxisSpacing = ${wrapGap};` : ''}`}
        frame.clipsContent = ${clip};
        ${opacity !== null ? `frame.opacity = ${opacity};` : ''}
        ${visible === false ? `frame.visible = false;` : ''}
        ${locked === true ? `frame.locked = true;` : ''}

        ${childCode}

        // Surface unresolved var: references like the batch path does, so a
        // themed render that fell back to grey is visible to the caller.
        const __unresolved = globalThis.__unresolvedVars
          ? [...globalThis.__unresolvedVars].sort() : [];
        if (globalThis.__unresolvedVars) globalThis.__unresolvedVars = new Set();
        return __unresolved.length > 0
          ? { id: frame.id, name: frame.name, unresolved: __unresolved }
          : { id: frame.id, name: frame.name };
        } catch(e) {
          // frame may be undeclared if createFrame() itself threw — a bare
          // frame.remove() there raises a ReferenceError that masks the real
          // error.
          try { if (typeof frame !== 'undefined' && frame) frame.remove(); } catch (e2) {}
          throw new Error('[Node: ' + __currentNode + '] ' + e.message);
        }
      })()
    `;
  }

  hexToRgb(hex) {
    if (!hex || !hex.startsWith('#')) return null;
    // Valid: #rgb, #rrggbb, #rrggbbaa (alpha handled by callers)
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
    let r, g, b;
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16) / 255;
      g = parseInt(hex[2] + hex[2], 16) / 255;
      b = parseInt(hex[3] + hex[3], 16) / 255;
    } else {
      r = parseInt(hex.slice(1, 3), 16) / 255;
      g = parseInt(hex.slice(3, 5), 16) / 255;
      b = parseInt(hex.slice(5, 7), 16) / 255;
    }
    return { r, g, b };
  }

  hexToRgbCode(hex) {
    // Validate like hexToRgb does — an unparsable value (`bg="red"`) used to
    // emit {r:NaN,...} into the generated code, surfacing as an opaque Figma
    // error far from its cause. Fall back to neutral grey instead.
    const s = String(hex || '').trim();
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (!m) return `{r:0.5,g:0.5,b:0.5}`;
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return `{r:${r},g:${g},b:${b}}`;
  }

  /**
   * Check if a value is a variable reference (var:name)
   */
  isVarRef(value) {
    return typeof value === 'string' && value.startsWith('var:');
  }

  /**
   * Raw numeric value for a spacing/radius prop. A "var:name" reference has
   * no number to assign, so it falls back (the __space bind sets the real
   * value from the variable a moment later).
   */
  spacingRaw(value, fallback = 0) {
    if (value === undefined || value === null || this.isVarRef(value)) return fallback;
    const n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  /**
   * Emit the __space() call that binds one spacing/radius value to a FLOAT
   * variable (reusing or creating it). Returns '' when there is nothing worth
   * tokenising — no value, or a plain 0.
   */
  spacingBind(nodeVar, fields, value, kind) {
    if (value === undefined || value === null) return '';
    if (!this.isVarRef(value) && !(Number(value) > 0)) return '';
    const payload = this.isVarRef(value) ? value : Number(value);
    return `__space(${nodeVar}, ${JSON.stringify(fields)}, ${JSON.stringify(payload)}, ${JSON.stringify(kind)});`;
  }

  /** True if any spacing/radius prop on this props object is worth tokenising. */
  hasSpacingProps(props) {
    const keys = ['gap', 'rowGap', 'wrapGap', 'counterAxisSpacing', 'p', 'padding',
      'px', 'py', 'pt', 'pr', 'pb', 'pl', 'rounded', 'radius'];
    return keys.some(k => {
      const v = props[k];
      if (v === undefined || v === null) return false;
      return this.isVarRef(v) || Number(v) > 0;
    });
  }

  /**
   * Extract variable name from var:name syntax
   */
  getVarName(value) {
    return value.slice(4); // Remove 'var:' prefix
  }

  /**
   * Generate fill code - either hex color or bound variable
   * Returns { code: string, usesVars: boolean }
   */
  generateFillCode(value, elementVar, property = 'fills') {
    // No fill at all → transparent. Lets callers default `bg` to null when
    // the user didn't ask for one, instead of forcing white.
    if (value === null || value === undefined) {
      return { code: `${elementVar}.${property} = [];`, usesVars: false };
    }
    if (this.isVarRef(value)) {
      const varName = this.getVarName(value);
      return {
        // Use lookupVar so the per-attr `var:collection:name` syntax resolves
        // even with a global --collection scope active. Falls back to vars[name].
        // Pass the requested key so unresolved names get reported instead of
        // silently rendering grey.
        code: `${elementVar}.${property} = [boundFill(lookupVar(${JSON.stringify(varName)}), ${JSON.stringify(varName)})];`,
        usesVars: true
      };
    }
    // Gradient: bg="linear-gradient(180deg, #FF0000, #00FF00)"
    if (typeof value === 'string' && /^(linear|radial|angular|diamond)-gradient\s*\(/i.test(value.trim())) {
      const paint = this.parseGradient(value);
      if (paint) {
        return { code: `${elementVar}.${property} = [${paint}];`, usesVars: false };
      }
    }
    return {
      code: `${elementVar}.${property} = [{type:'SOLID',color:${this.hexToRgbCode(value)}}];`,
      usesVars: false
    };
  }

  /**
   * Generate code that creates an image fill from a URL.
   * Uses figma.createImageAsync for remote URLs.
   * Returns code that prepends an image paint to fills.
   * scaleMode: FILL (default), FIT, CROP, TILE
   */
  generateImageFillCode(url, elementVar, scaleMode = 'FILL') {
    if (!url || typeof url !== 'string') return '';
    const mode = String(scaleMode).toUpperCase();
    const validModes = ['FILL', 'FIT', 'CROP', 'TILE'];
    const finalMode = validModes.includes(mode) ? mode : 'FILL';
    const safeName = elementVar.replace(/[^a-zA-Z0-9]/g, '');
    // Image REPLACES fills (not appends) — user expects bg-style behavior
    return `
      const __img${safeName} = await figma.createImageAsync(${JSON.stringify(url)});
      ${elementVar}.fills = [{ type: 'IMAGE', imageHash: __img${safeName}.hash, scaleMode: '${finalMode}' }];`;
  }

  /**
   * Parse a CSS-like gradient string into a Figma GradientPaint code expression.
   * Supports:
   *   linear-gradient(180deg, #FF0000, #00FF00)
   *   linear-gradient(180deg, #FF0000 0%, #00FF00 100%)
   *   radial-gradient(#FF0000, #00FF00)
   *   angular-gradient(#FF0000, #00FF00, #0000FF)
   *   diamond-gradient(#FF0000, #00FF00)
   */
  parseGradient(str) {
    const m = str.trim().match(/^(linear|radial|angular|diamond)-gradient\s*\(([\s\S]*)\)\s*$/i);
    if (!m) return null;
    const kind = m[1].toLowerCase();
    const typeMap = {
      linear: 'GRADIENT_LINEAR',
      radial: 'GRADIENT_RADIAL',
      angular: 'GRADIENT_ANGULAR',
      diamond: 'GRADIENT_DIAMOND',
    };
    const type = typeMap[kind];
    // Split top-level by commas (but not inside rgba(...))
    const parts = [];
    let depth = 0, buf = '';
    for (const ch of m[2]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; }
      else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    if (parts.length < 2) return null;

    let angleDeg = 180; // CSS default: top to bottom
    let stopParts = parts;
    const angleMatch = parts[0].match(/^(-?\d+(?:\.\d+)?)deg$/i);
    if (angleMatch) {
      angleDeg = parseFloat(angleMatch[1]);
      stopParts = parts.slice(1);
    }
    if (stopParts.length < 2) return null;

    // Parse each stop: "#FF0000" or "#FF0000 50%" or "rgba(...) 50%"
    const stops = [];
    stopParts.forEach((sp, i) => {
      const posMatch = sp.match(/(-?\d+(?:\.\d+)?)%\s*$/);
      let pos = posMatch ? parseFloat(posMatch[1]) / 100 : i / (stopParts.length - 1);
      const colorStr = posMatch ? sp.slice(0, posMatch.index).trim() : sp.trim();
      let color;
      const rgbaMatch = colorStr.match(/^rgba?\(([^)]+)\)$/);
      if (rgbaMatch) {
        const ps = rgbaMatch[1].split(',').map(p => p.trim());
        color = {
          r: parseInt(ps[0]) / 255,
          g: parseInt(ps[1]) / 255,
          b: parseInt(ps[2]) / 255,
          a: ps.length > 3 ? parseFloat(ps[3]) : 1,
        };
      } else {
        const c = this.hexToRgb(colorStr);
        if (!c) return;
        let a = 1;
        if (colorStr.length === 9 && colorStr.startsWith('#')) {
          a = parseInt(colorStr.slice(7, 9), 16) / 255;
        }
        color = { ...c, a };
      }
      stops.push({ position: pos, color });
    });
    if (stops.length < 2) return null;

    // Compute gradientTransform from angle.
    // CSS 0deg = bottom-to-top (going up), 180deg = top-to-bottom.
    // Figma's gradientTransform's gradient line goes (0,0)->(1,0) in transformed coords.
    // For 180deg (top->bottom): want line direction = (0,1). Use rotation 90deg.
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Center the gradient at (0.5, 0.5) before rotating
    const tx = 0.5 - 0.5 * cos + 0.5 * sin;
    const ty = 0.5 - 0.5 * sin - 0.5 * cos;
    const transform = `[[${cos.toFixed(4)},${(-sin).toFixed(4)},${tx.toFixed(4)}],[${sin.toFixed(4)},${cos.toFixed(4)},${ty.toFixed(4)}]]`;

    const stopsCode = stops.map(s =>
      `{position:${s.position},color:{r:${s.color.r.toFixed(4)},g:${s.color.g.toFixed(4)},b:${s.color.b.toFixed(4)},a:${s.color.a}}}`
    ).join(',');
    return `{type:'${type}',gradientStops:[${stopsCode}],gradientTransform:${transform}}`;
  }

  /**
   * Parse a CSS-like shadow string into a Figma effect descriptor.
   * Accepts: "0 4px 12px rgba(0,0,0,0.1)" / "0 2px 4px #00000040" / "0 4 12 #00000019"
   * Returns: { x, y, blur, color: {r,g,b,a} } or null
   */
  parseShadowString(s) {
    if (typeof s !== 'string') return null;
    let str = s.trim();
    // Tailwind-style keyword shortcuts. Designers expect shadow="lg" to work.
    const tailwind = {
      // Tailwind sizes
      sm:   '0 1px 2px rgba(0,0,0,0.05)',
      md:   '0 4px 6px rgba(0,0,0,0.1)',
      lg:   '0 10px 15px rgba(0,0,0,0.1)',
      xl:   '0 20px 25px rgba(0,0,0,0.1)',
      '2xl':'0 25px 50px rgba(0,0,0,0.25)',
      // Descriptive aliases (designers say "soft" not "md")
      soft: '0 4px 12px rgba(0,0,0,0.08)',
      subtle: '0 2px 4px rgba(0,0,0,0.06)',
      strong: '0 16px 32px rgba(0,0,0,0.2)',
      hard: '0 8px 0 rgba(0,0,0,1)',  // brutalist offset
      glow: '0 0 24px rgba(59,130,246,0.5)',  // colored glow
      none: null,
    };
    const lookup = tailwind[str.toLowerCase()];
    if (lookup === null) return null;
    if (lookup !== undefined) str = lookup;
    // Extract color (last hex or rgba(...))
    let color = null;
    const rgbaMatch = str.match(/rgba?\(([^)]+)\)\s*$/);
    if (rgbaMatch) {
      const parts = rgbaMatch[1].split(',').map(p => p.trim());
      color = {
        r: parseInt(parts[0]) / 255,
        g: parseInt(parts[1]) / 255,
        b: parseInt(parts[2]) / 255,
        a: parts.length > 3 ? parseFloat(parts[3]) : 1,
      };
      str = str.slice(0, rgbaMatch.index).trim();
    } else {
      const hexMatch = str.match(/#[0-9a-fA-F]{3,8}\s*$/);
      if (hexMatch) {
        const hex = hexMatch[0].trim();
        const c = this.hexToRgb(hex);
        if (c) {
          let a = 1;
          if (hex.length === 9) a = parseInt(hex.slice(7, 9), 16) / 255;
          color = { ...c, a };
        }
        str = str.slice(0, hexMatch.index).trim();
      }
    }
    if (!color) color = { r: 0, g: 0, b: 0, a: 0.1 };
    const nums = str.split(/\s+/).filter(Boolean).map(n => parseFloat(n));
    if (nums.length < 2) return null;
    return { x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, color };
  }

  /**
   * Generate code that sets `effects` on an element from JSX props.
   * Supported props:
   *   shadow="0 4px 12px rgba(0,0,0,0.1)"   — DROP_SHADOW
   *   innerShadow="0 2px 4px #00000040"     — INNER_SHADOW
   *   blur={4}                               — LAYER_BLUR
   *   bgBlur={8}                             — BACKGROUND_BLUR
   *   noise="mono|duo|multi"                 — NOISE grain (noiseDensity/noiseSize/noiseColor/noiseColor2/noiseOpacity)
   *   texture={true}                         — TEXTURE grain (textureSize/textureRadius/textureClip)
   *   progressiveBlur={40}                   — PROGRESSIVE blur (progressiveBlurDir=down|up|left|right)
   *   glass={true}                           — liquid GLASS (glassRefraction/glassDepth/glassRadius/glassDispersion/glassLight/glassLightAngle)
   * Multiple effects accumulate.
   */
  /**
   * Generic node-level props shared by ALL child node types (Ellipse, Rect,
   * Image — Frames handle these inline). Emits opacity, visible, rotation,
   * effects (blur/shadow/noise/…), and positioning. MUST be appended AFTER
   * appendChild (positioning needs a parent).
   *
   * Positioning: in a flex="none" (z-stack) parent, children are positioned by
   * plain x/y — setting layoutPositioning='ABSOLUTE' there THROWS (only valid in
   * auto-layout), so we set x/y directly. In an auto-layout parent, position=
   * "absolute" maps to layoutPositioning='ABSOLUTE' + x/y.
   */
  genCommonNodeProps(item, varName, parentIsNone) {
    const parts = [];
    if (item.opacity !== undefined && item.opacity !== null) parts.push(`${varName}.opacity = ${Number(item.opacity)};`);
    if (item.visible === false || item.visible === 'false') parts.push(`${varName}.visible = false;`);
    if (item.rotate !== undefined) parts.push(`${varName}.rotation = ${Number(item.rotate)};`);
    const eff = this.generateEffectsCode(item, varName);
    if (eff && eff.trim()) parts.push(eff);
    const hasX = item.x !== undefined, hasY = item.y !== undefined;
    if (parentIsNone) {
      if (hasX) parts.push(`${varName}.x = ${Number(item.x)};`);
      if (hasY) parts.push(`${varName}.y = ${Number(item.y)};`);
    } else if (item.position === 'absolute' && (hasX || hasY)) {
      parts.push(`try { ${varName}.layoutPositioning = 'ABSOLUTE'; } catch (e) {}`);
      if (hasX) parts.push(`${varName}.x = ${Number(item.x)};`);
      if (hasY) parts.push(`${varName}.y = ${Number(item.y)};`);
    }
    return parts.join('\n        ');
  }

  generateEffectsCode(props, elementVar) {
    const effects = [];
    if (props.shadow) {
      const arr = Array.isArray(props.shadow) ? props.shadow : [props.shadow];
      for (const s of arr) {
        const e = this.parseShadowString(s);
        if (e) effects.push({ type: 'DROP_SHADOW', x: e.x, y: e.y, blur: e.blur, color: e.color });
      }
    }
    if (props.innerShadow) {
      const arr = Array.isArray(props.innerShadow) ? props.innerShadow : [props.innerShadow];
      for (const s of arr) {
        const e = this.parseShadowString(s);
        if (e) effects.push({ type: 'INNER_SHADOW', x: e.x, y: e.y, blur: e.blur, color: e.color });
      }
    }
    if (props.blur !== undefined && props.blur !== null) {
      const r = Number(props.blur);
      if (Number.isFinite(r) && r > 0) effects.push({ type: 'LAYER_BLUR', radius: r });
    }
    if (props.bgBlur !== undefined && props.bgBlur !== null) {
      const r = Number(props.bgBlur);
      if (Number.isFinite(r) && r > 0) effects.push({ type: 'BACKGROUND_BLUR', radius: r });
    }
    // Grain/noise overlay (NOISE effect). noise="mono|duo|multi" (mono default).
    //   noiseDensity={0..1} noiseSize={n} noiseColor="#hex" noiseColor2="#hex"(duo) noiseOpacity={0..1}(multi)
    if (props.noise !== undefined && props.noise !== null && props.noise !== 'false' && props.noise !== false) {
      const nv = String(props.noise).toLowerCase();
      let noiseType = 'MONOTONE';
      if (nv.startsWith('duo')) noiseType = 'DUOTONE';
      else if (nv.startsWith('multi')) noiseType = 'MULTITONE';
      const c = this.hexToRgb(props.noiseColor || '#000000') || { r: 0, g: 0, b: 0 };
      const eff = {
        type: 'NOISE', noiseType,
        density: props.noiseDensity !== undefined ? Number(props.noiseDensity) : 0.4,
        noiseSize: props.noiseSize !== undefined ? Number(props.noiseSize) : 1.5,
        color: { r: c.r, g: c.g, b: c.b, a: 1 }, visible: true,
      };
      if (noiseType === 'DUOTONE') {
        const c2 = this.hexToRgb(props.noiseColor2 || '#ffffff') || { r: 1, g: 1, b: 1 };
        eff.secondaryColor = { r: c2.r, g: c2.g, b: c2.b, a: 1 };
      } else if (noiseType === 'MULTITONE') {
        eff.opacity = props.noiseOpacity !== undefined ? Number(props.noiseOpacity) : 0.5;
      }
      effects.push({ _raw: eff });
    }
    // Paper/grain TEXTURE effect. texture={true} textureSize={n} textureRadius={n} textureClip={bool}
    if (props.texture !== undefined && props.texture !== null && props.texture !== 'false' && props.texture !== false) {
      effects.push({ _raw: {
        type: 'TEXTURE',
        noiseSize: props.textureSize !== undefined ? Number(props.textureSize) : 12,
        radius: props.textureRadius !== undefined ? Number(props.textureRadius) : 30,
        clipToShape: !(props.textureClip === 'false' || props.textureClip === false),
        visible: true,
      } });
    }
    // Progressive (gradient) blur. progressiveBlur={endRadius} progressiveBlurDir="down|up|left|right"
    if (props.progressiveBlur !== undefined && props.progressiveBlur !== null) {
      const r = Number(props.progressiveBlur);
      if (Number.isFinite(r) && r > 0) {
        const dir = String(props.progressiveBlurDir || 'down').toLowerCase();
        const O = {
          down:  { s: { x: 0.5, y: 0 }, e: { x: 0.5, y: 1 } },
          up:    { s: { x: 0.5, y: 1 }, e: { x: 0.5, y: 0 } },
          right: { s: { x: 0, y: 0.5 }, e: { x: 1, y: 0.5 } },
          left:  { s: { x: 1, y: 0.5 }, e: { x: 0, y: 0.5 } },
        };
        const o = O[dir] || O.down;
        effects.push({ _raw: {
          type: 'LAYER_BLUR', blurType: 'PROGRESSIVE', radius: r,
          startRadius: props.progressiveBlurStart !== undefined ? Number(props.progressiveBlurStart) : 0,
          startOffset: o.s, endOffset: o.e, visible: true,
        } });
      }
    }
    // Liquid GLASS effect. glass={true} glassRefraction/glassDepth/glassRadius/glassDispersion/glassLight/glassLightAngle
    if (props.glass !== undefined && props.glass !== null && props.glass !== 'false' && props.glass !== false) {
      // Defaults tuned for Apple-style "Liquid Glass": clear (low radius) with
      // strong edge lensing (high depth) + chromatic dispersion. For a frosted
      // look instead, pass a high glassRadius (e.g. 30) and lower glassDepth.
      effects.push({ _raw: {
        type: 'GLASS', visible: true,
        refraction: props.glassRefraction !== undefined ? Number(props.glassRefraction) : 0.95,
        depth: props.glassDepth !== undefined ? Number(props.glassDepth) : 50,
        radius: props.glassRadius !== undefined ? Number(props.glassRadius) : 6,
        dispersion: props.glassDispersion !== undefined ? Number(props.glassDispersion) : 0.4,
        lightIntensity: props.glassLight !== undefined ? Number(props.glassLight) : 0.7,
        lightAngle: props.glassLightAngle !== undefined ? Number(props.glassLightAngle) : 130,
      } });
    }
    if (effects.length === 0) return '';
    const figmaEffects = effects.map(e => {
      if (e._raw) return JSON.stringify(e._raw);
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        return `{type:'${e.type}',color:{r:${e.color.r},g:${e.color.g},b:${e.color.b},a:${e.color.a}},offset:{x:${e.x},y:${e.y}},radius:${e.blur},spread:0,visible:true,blendMode:'NORMAL'}`;
      }
      return `{type:'${e.type}',radius:${e.radius},visible:true}`;
    });
    return `${elementVar}.effects = [${figmaEffects.join(',')}];`;
  }

  /**
   * Generate stroke code - either hex color or bound variable
   */
  generateStrokeCode(value, elementVar, strokeWidth = 1, strokeAlign = null) {
    const alignCode = strokeAlign ? ` ${elementVar}.strokeAlign = ${JSON.stringify(strokeAlign.toUpperCase())};` : '';
    if (this.isVarRef(value)) {
      const varName = this.getVarName(value);
      return {
        code: `${elementVar}.strokes = [boundFill(lookupVar(${JSON.stringify(varName)}), ${JSON.stringify(varName)})]; ${elementVar}.strokeWeight = ${strokeWidth};${alignCode}`,
        usesVars: true
      };
    } else {
      return {
        code: `${elementVar}.strokes = [{type:'SOLID',color:${this.hexToRgbCode(value)}}]; ${elementVar}.strokeWeight = ${strokeWidth};${alignCode}`,
        usesVars: false
      };
    }
  }

  // (The CDP-era convenience API — ~100 `this.eval()` methods for node ops,
  // creation, variables, exports, library access, linting … — was removed.
  // It required the Chrome DevTools transport this build does not have;
  // every one of them was unreachable. Commands talk to the plugin through
  // the daemon instead. What remains here is the JSX → plugin-code compiler.)

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default FigmaClient;
