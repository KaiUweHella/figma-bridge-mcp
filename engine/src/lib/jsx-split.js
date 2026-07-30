// JSX pre-processing helpers used by the render commands: shell unescaping and
// the "N similar frames in a row" wrapper split.
// (Extracted from cli-core.js — pure string logic, no I/O.)

// Fix zsh shell escaping: zsh escapes ! to \! even in single quotes
function unescapeShell(str) {
  if (!str) return str;
  return str.replace(/\\!/g, '!');
}

/**
 * If the JSX is a Frame whose role is "lay out N similar items in a row/col",
 * extract the children as independent JSX strings + the direction.
 *
 * Rationale: LLM callers regularly wrap "5 buttons" / "3 cards" in an outer
 * `<Frame flex="row">` which then becomes a single rendered Frame in Figma
 * instead of N standalone canvas items the user can move/use individually.
 * `render-batch` is the right primitive for this. This function lets `render`
 * detect the pattern at the CLI surface and reroute, so every caller (any LLM,
 * shell, IDE) benefits without each one needing its own rewriter.
 *
 * Returns `{ direction, children }` if a split is appropriate, `null` otherwise.
 *
 * Split conditions:
 *  - outer is a single <Frame ...> with a flex direction
 *  - outer contains ≥ 2 direct <Frame> children (depth-aware)
 *  - all direct children are <Frame>s (no orphan <Text>, <Icon>, etc.)
 *  - bg/fill on the outer is fine; the wrapper visual is dropped on purpose
 *    because the canonical pattern is "N standalone items", not "N items in a
 *    bag". Callers who really want the wrapper can pass --keep-wrapper.
 */
function detectWrapperSplit(jsx) {
  const text = jsx.trim();
  const outerMatch = text.match(/^<Frame\b([^>]*)>([\s\S]*)<\/Frame>\s*$/);
  if (!outerMatch) return null;
  const outerAttrs = outerMatch[1];
  const inner = outerMatch[2];
  const flexMatch = outerAttrs.match(/flex\s*=\s*["']?(row|col|column|vertical|horizontal)["']?/);
  if (!flexMatch) return null;
  // CRITICAL: only split when the outer is PURE layout. If the outer carries
  // any visual property (bg, fill, stroke, rounded, shadow, blur, image), it's
  // a real composite component (Card, Modal, Banner…) and splitting destroys
  // the design. Layout-only attrs like gap, padding, justify, items are fine.
  const visualAttrs = /\b(bg|fill|stroke|rounded|radius|shadow|innerShadow|blur|bgBlur|image)\s*=/;
  if (visualAttrs.test(outerAttrs)) return null;
  const direction = /col|vertical|column/.test(flexMatch[1]) ? 'col' : 'row';
  // Walk inner with depth tracking, capture every depth-1 element
  const children = [];
  let depth = 0;
  let chunkStart = -1;
  let i = 0;
  let nonFrameChildSeen = false;
  while (i < inner.length) {
    if (inner[i] === '<' && inner[i + 1] !== '/') {
      // Identify tag name
      const tagMatch = inner.slice(i).match(/^<([A-Za-z][A-Za-z0-9]*)\b/);
      if (!tagMatch) { i++; continue; }
      const tagName = tagMatch[1];
      if (depth === 0) {
        if (tagName !== 'Frame') { nonFrameChildSeen = true; return null; }
        chunkStart = i;
      }
      // Self-closing tag like <Icon ... />
      const selfClose = inner.slice(i).match(/^<[A-Za-z][^>]*\/>/);
      if (selfClose) {
        if (depth === 0) {
          // Self-closing direct child — only allowed if it's a Frame
          if (tagName !== 'Frame') { nonFrameChildSeen = true; return null; }
          children.push(selfClose[0]);
          chunkStart = -1;
        }
        i += selfClose[0].length;
        continue;
      }
      // Regular opening tag
      const open = inner.slice(i).match(/^<[A-Za-z][^>]*>/);
      if (!open) { i++; continue; }
      depth++;
      i += open[0].length;
      continue;
    }
    if (inner[i] === '<' && inner[i + 1] === '/') {
      const close = inner.slice(i).match(/^<\/[A-Za-z]+>/);
      if (!close) { i++; continue; }
      depth--;
      i += close[0].length;
      if (depth === 0 && chunkStart !== -1) {
        children.push(inner.slice(chunkStart, i));
        chunkStart = -1;
      }
      continue;
    }
    i++;
  }
  if (nonFrameChildSeen) return null;
  if (children.length < 2) return null;
  // Don't split distinct-child composites. A real "N items in a row" pattern
  // has children that share a base name (Button 1/2/3, Card A/B/C) or are
  // structurally interchangeable. A composite has children with unrelated
  // names (TabBar + Panel, Header + Body + Footer, Body + Close) — splitting
  // would scatter the pieces. Heuristic: extract a base from each child's
  // name=, strip trailing numbers/letters/slashes. If <50% share the same
  // base, it's a composite — bail out.
  const childNames = children.map(c => {
    const m = c.match(/\bname\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : '';
  });
  // Strip a trailing differentiator that's clearly a sibling-index: requires
  // a separator (space, dash, slash, underscore) before the suffix so that
  // distinct names like "TabBar" / "Panel" stay distinct.
  const bases = childNames.map(n => {
    let b = n.replace(/[\s\-/_][A-Za-z0-9]+$/, ''); // "Button 1" → "Button", "Btn/Primary" → "Btn"
    return (b || n).toLowerCase().trim();
  });
  // If children have more than one distinct base, this is a composite
  // (TabBar + Panel, Header + Body + Footer, Body + Close) and splitting
  // would scatter the design. Only allow split when EVERY child shares the
  // same base name (the "N items" pattern).
  const distinctBases = new Set(bases);
  if (distinctBases.size > 1) return null;
  return { direction, children };
}

// Patterns that aren't worth running as --query because they match Figma's
export { unescapeShell, detectWrapperSplit };
