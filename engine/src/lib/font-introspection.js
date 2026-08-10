// Truthful typography inspection and variable-axis intent metadata.
//
// Figma exposes family/style, a numeric read-only fontWeight, OpenType feature
// state and typography-variable bindings. It does NOT expose the general
// variation-axis tuple behind a text range. The metadata helpers below keep a
// caller-supplied tuple round-trippable without pretending to apply it.

export const FONT_AXIS_METADATA_KEY = 'figmaBridge.variableFontAxes';

const AXIS_TAG = /^[A-Za-z0-9]{4}$/;

export function parseAxisSpec(value) {
  const input = String(value ?? '').trim();
  if (!input) throw new Error('Expected at least one axis, for example wght=357,wdth=82.');
  const axes = {};
  for (const rawPart of input.split(',')) {
    const part = rawPart.trim();
    const split = part.indexOf('=');
    if (split === -1) throw new Error(`Axis "${part}" must use tag=value.`);
    const tag = part.slice(0, split).trim();
    const rawValue = part.slice(split + 1).trim();
    if (!AXIS_TAG.test(tag)) throw new Error(`Axis tag "${tag}" must be exactly four characters (letters or digits).`);
    if (Object.prototype.hasOwnProperty.call(axes, tag)) throw new Error(`duplicate axis "${tag}".`);
    const number = Number(rawValue);
    if (!rawValue || !Number.isFinite(number)) throw new Error(`Axis "${tag}" must have a finite number.`);
    axes[tag] = number;
  }
  return axes;
}

export function parseOptionalIndex(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer.`);
  return number;
}

function assertAxes(axes) {
  if (!axes || typeof axes !== 'object' || Array.isArray(axes) || !Object.keys(axes).length) {
    throw new Error('Expected at least one variable-font axis.');
  }
  for (const [tag, value] of Object.entries(axes)) {
    if (!AXIS_TAG.test(tag)) throw new Error(`Axis tag "${tag}" must be exactly four characters (letters or digits).`);
    if (!Number.isFinite(value)) throw new Error(`Axis "${tag}" must have a finite number.`);
  }
}

const metadataHelpers = () => `
  const AXIS_METADATA_KEY = ${JSON.stringify(FONT_AXIS_METADATA_KEY)};
  const axisTag = /^[A-Za-z0-9]{4}$/;
  const readAxisMetadata = (raw) => {
    if (!raw) return { schemaVersion: 1, ranges: [] };
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) { return { schemaVersion: 1, ranges: [], error: 'Axis metadata is not valid JSON.' }; }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.ranges)) {
      return { schemaVersion: 1, ranges: [], error: 'Axis metadata has an unsupported schema.' };
    }
    const ranges = [];
    for (const range of parsed.ranges) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)
          || range.start < 0 || range.end < range.start
          || !range.axes || typeof range.axes !== 'object' || Array.isArray(range.axes)) {
        return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an invalid range.' };
      }
      const axes = {};
      for (const [tag, value] of Object.entries(range.axes)) {
        if (!axisTag.test(tag) || !Number.isFinite(value)) {
          return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an invalid axis.' };
        }
        axes[tag] = value;
      }
      if (!Object.keys(axes).length) {
        return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an empty axis tuple.' };
      }
      ranges.push({ start: range.start, end: range.end, axes });
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    return { schemaVersion: 1, ranges };
  };
  const textNode = async (id) => {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error('Node not found: ' + id);
    if (node.type !== 'TEXT') throw new Error('Expected a TEXT node, got ' + node.type + ': ' + id);
    return node;
  };
  const textRange = (node, rawStart, rawEnd) => {
    const start = rawStart == null ? 0 : rawStart;
    const end = rawEnd == null ? node.characters.length : rawEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > node.characters.length) {
      throw new Error('Range [' + start + ',' + end + ') is outside text length ' + node.characters.length + '.');
    }
    return { start, end };
  };
`;

export function axisMetadataExpression(nodeExpression = 'n') {
  return `(() => {
    try {
      const raw = typeof ${nodeExpression}.getPluginData === 'function'
        ? ${nodeExpression}.getPluginData(${JSON.stringify(FONT_AXIS_METADATA_KEY)}) : '';
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.ranges)) return { error: 'unsupported-schema' };
      const ranges = [];
      for (const range of parsed.ranges) {
        if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)
            || range.start < 0 || range.end < range.start
            || !range.axes || typeof range.axes !== 'object' || Array.isArray(range.axes)) return { error: 'invalid-range' };
        const axes = {};
        for (const [tag, value] of Object.entries(range.axes)) {
          if (!/^[A-Za-z0-9]{4}$/.test(tag) || !Number.isFinite(value)) return { error: 'invalid-axis' };
          axes[tag] = value;
        }
        if (!Object.keys(axes).length) return { error: 'empty-axis-tuple' };
        ranges.push({ start: range.start, end: range.end, axes });
      }
      return { ranges };
    } catch (error) { return { error: 'invalid-json' }; }
  })()`;
}

export function fontInspectCode({ nodeId, start = null, end = null, allOpenType = false }) {
  return `(async () => {${metadataHelpers()}
    const node = await textNode(${JSON.stringify(nodeId)});
    const range = textRange(node, ${JSON.stringify(start)}, ${JSON.stringify(end)});
    const fields = ['fontName', 'fontSize', 'fontWeight', 'openTypeFeatures', 'boundVariables'];
    const rawSegments = range.start === range.end ? [] : node.getStyledTextSegments(fields, range.start, range.end);
    const variableCache = new Map();
    const variableInfo = async (alias) => {
      if (!alias || typeof alias.id !== 'string') return null;
      if (variableCache.has(alias.id)) return variableCache.get(alias.id);
      let info = { id: alias.id, name: null };
      try {
        const variable = await figma.variables.getVariableByIdAsync(alias.id);
        if (variable) info = { id: alias.id, name: variable.name };
      } catch (error) {}
      variableCache.set(alias.id, info);
      return info;
    };
    const segments = [];
    for (const segment of rawSegments) {
      const boundVariables = {};
      for (const [field, alias] of Object.entries(segment.boundVariables || {})) {
        const info = await variableInfo(Array.isArray(alias) ? alias[0] : alias);
        if (info) boundVariables[field] = info;
      }
      const features = segment.openTypeFeatures && typeof segment.openTypeFeatures === 'object'
        ? segment.openTypeFeatures : {};
      const out = {
        start: segment.start,
        end: segment.end,
        characters: segment.characters,
        fontName: segment.fontName,
        fontSize: segment.fontSize,
        fontWeight: segment.fontWeight,
        enabledOpenTypeFeatures: Object.keys(features).filter((tag) => features[tag] === true).sort(),
        boundVariables,
      };
      if (${allOpenType ? 'true' : 'false'}) out.openTypeFeatures = features;
      segments.push(out);
    }
    const axisMetadata = readAxisMetadata(node.getPluginData(AXIS_METADATA_KEY));
    axisMetadata.source = 'plugin-data';
    axisMetadata.appliedToFont = false;
    return {
      id: node.id,
      name: node.name,
      characters: node.characters,
      range,
      segments,
      axisMetadata,
      apiLimits: {
        exactVariationAxes: false,
        fontWeight: 'read-only Figma value; not a general variation-axis tuple',
        openTypeFeatures: 'read-only',
      },
    };
  })()`;
}

export function fontAxesCode({ nodeId }) {
  return `(async () => {${metadataHelpers()}
    const node = await textNode(${JSON.stringify(nodeId)});
    const metadata = readAxisMetadata(node.getPluginData(AXIS_METADATA_KEY));
    return { id: node.id, name: node.name, source: 'plugin-data', appliedToFont: false, ...metadata };
  })()`;
}

export function rememberAxesCode({ nodeId, axes, start = null, end = null }) {
  assertAxes(axes);
  return `(async () => {${metadataHelpers()}
    const node = await textNode(${JSON.stringify(nodeId)});
    const range = textRange(node, ${JSON.stringify(start)}, ${JSON.stringify(end)});
    const metadata = readAxisMetadata(node.getPluginData(AXIS_METADATA_KEY));
    if (metadata.error) throw new Error(metadata.error + ' Clear it with font forget-axes before writing new metadata.');
    const axes = ${JSON.stringify(axes)};
    metadata.ranges = metadata.ranges.filter((item) => item.start !== range.start || item.end !== range.end);
    metadata.ranges.push({ ...range, axes });
    metadata.ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    node.setPluginData(AXIS_METADATA_KEY, JSON.stringify(metadata));
    return {
      id: node.id, name: node.name, range, axes,
      source: 'plugin-data', appliedToFont: false,
      note: 'Stored intent only; Figma glyph rendering was not changed.',
    };
  })()`;
}

export function forgetAxesCode({ nodeId, start = null, end = null }) {
  const clearAll = start == null && end == null;
  return `(async () => {${metadataHelpers()}
    const node = await textNode(${JSON.stringify(nodeId)});
    const raw = node.getPluginData(AXIS_METADATA_KEY);
    ${clearAll ? `
    const previous = readAxisMetadata(raw);
    const cleared = previous.error ? null : previous.ranges.length;
    node.setPluginData(AXIS_METADATA_KEY, '');
    return { id: node.id, name: node.name, cleared, all: true, source: 'plugin-data', appliedToFont: false };`
      : `
    const range = textRange(node, ${JSON.stringify(start)}, ${JSON.stringify(end)});
    const metadata = readAxisMetadata(raw);
    if (metadata.error) throw new Error(metadata.error + ' Omit --start/--end to clear all corrupted metadata.');
    const before = metadata.ranges.length;
    metadata.ranges = metadata.ranges.filter((item) => item.start !== range.start || item.end !== range.end);
    node.setPluginData(AXIS_METADATA_KEY, metadata.ranges.length ? JSON.stringify(metadata) : '');
    return { id: node.id, name: node.name, range, cleared: before - metadata.ranges.length, all: false, source: 'plugin-data', appliedToFont: false };`}
  })()`;
}
