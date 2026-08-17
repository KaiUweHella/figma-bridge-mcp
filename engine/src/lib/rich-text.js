const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
});

/** Decode the safe HTML entity subset plus decimal/hex Unicode references. */
export function decodeTextEntities(value) {
  return String(value ?? '').replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (full, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? full;
    const hex = body[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(codePoint);
  });
}

function sameStyle(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Parse inline rich-text markup used inside <Text>.
 * Supported tags: b/strong, i/em, u, span/Span and a. Offsets are half-open
 * UTF-16 indexes, matching Figma's setRange* APIs and JavaScript string length.
 */
export function parseRichTextContent(inner, parseProps = () => ({})) {
  const source = String(inner ?? '');
  const stack = [];
  const runs = [];
  let text = '';
  const style = () => Object.assign({}, ...stack.map((entry) => entry.style));
  const append = (raw) => {
    if (!raw) return;
    const decoded = decodeTextEntities(raw.replace(/\s+/g, ' '));
    if (!decoded) return;
    const start = text.length;
    text += decoded;
    const next = { start, end: text.length, style: style() };
    const previous = runs.at(-1);
    if (previous && previous.end === next.start && sameStyle(previous.style, next.style)) previous.end = next.end;
    else runs.push(next);
  };
  const tagPattern = /<(\/?)\s*(b|strong|em|i|u|span|a)((?:\s+[^>]*)?)>/gi;
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(source)) !== null) {
    append(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (closing) {
      const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (index < 0) throw new Error(`Rich Text has an unmatched closing <${tag}> tag`);
      stack.splice(index);
      continue;
    }
    const props = parseProps(String(match[3] || '').trim());
    const nextStyle = {};
    if (tag === 'b' || tag === 'strong') nextStyle.weight = 'bold';
    if (tag === 'em' || tag === 'i') nextStyle.italic = true;
    if (tag === 'u') nextStyle.underline = true;
    for (const key of ['font', 'fontStyle', 'weight', 'color', 'size', 'letterSpacing']) {
      if (props[key] !== undefined) nextStyle[key] = props[key];
    }
    if (props.italic !== undefined) nextStyle.italic = props.italic;
    if (props.underline !== undefined) nextStyle.underline = props.underline;
    if (props.decoration !== undefined) nextStyle.decoration = props.decoration;
    if (tag === 'a' && props.href !== undefined) nextStyle.href = props.href;
    stack.push({ tag, style: nextStyle });
  }
  append(source.slice(cursor));
  if (stack.length) throw new Error(`Rich Text has an unclosed <${stack.at(-1).tag}> tag`);

  // Formatting indentation around the Text boundary is not authored copy.
  const leading = text.match(/^\s+/)?.[0].length || 0;
  const trailing = text.match(/\s+$/)?.[0].length || 0;
  if (leading || trailing) {
    const end = text.length - trailing;
    text = text.slice(leading, end);
    const remapped = [];
    for (const run of runs) {
      const start = Math.max(run.start, leading) - leading;
      const runEnd = Math.min(run.end, end) - leading;
      if (runEnd > start) remapped.push({ start, end: runEnd, style: run.style });
    }
    runs.length = 0;
    runs.push(...remapped);
  }
  return { text, runs };
}
