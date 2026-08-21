// Operation-level coverage for Figma APIs that create or structurally combine
// document content. Unlike `api gap`'s broad type-name heuristic, this table
// is intentionally exhaustive and version-pinned: tests compare its keys with
// the installed official PluginAPI declaration so a new Figma creator cannot
// arrive unnoticed.

const FIGMA_TYPINGS_AUDITED_VERSION = '1.133.0';

const supported = (command, note = '') => Object.freeze({ status: 'supported', command: Object.freeze(command), note });
const alternative = (command, note) => Object.freeze({ status: 'alternative', command: Object.freeze(command), note });
const boundary = (note) => Object.freeze({ status: 'boundary', command: null, note });

const PLUGIN_API_CREATION_OPERATIONS = Object.freeze({
  createRectangle: supported(['create', 'rect', 'Rectangle']),
  createLine: supported(['create', 'line']),
  createEllipse: supported(['create', 'ellipse', 'Ellipse']),
  createPolygon: supported(['create', 'polygon', 'Polygon']),
  createStar: supported(['create', 'star', 'Star']),
  createVector: supported(['create', 'vector', 'Vector'], 'Accepts an optional validated VectorNetwork JSON value.'),
  createText: supported(['create', 'text', 'Text']),
  createFrame: supported(['create', 'frame', 'Frame']),
  createComponent: supported(['component', 'create', 'Component']),
  createComponentFromNode: supported(['node', 'to-component', '1:2']),
  createPage: supported(['canvas', 'page-create', 'Page']),
  createPageDivider: supported(['canvas', 'page-divider']),
  createSlice: supported(['create', 'slice', 'Slice']),
  createSlide: supported(['slides', 'create', 'Slide']),
  createSlideRow: alternative(['slides', 'create', 'Slide', '--row', '0'], 'Slides rows are created implicitly by coordinate-aware slide creation.'),
  createSticky: supported(['jam', 'sticky', 'Text']),
  createConnector: supported(['jam', 'connector', '1:2', '1:3']),
  createShapeWithText: supported(['jam', 'shape', 'Text']),
  createCodeBlock: supported(['jam', 'code', 'const x = 1']),
  createSection: supported(['section', 'create', 'Section']),
  createTable: supported(['jam', 'table', '2', '2']),
  createTextPath: supported(['draw', 'text-path', '1:2', '--text', 'Text']),
  createNodeFromJSXAsync: supported(['render', '<Frame />']),
  createBooleanOperation: alternative(['node', 'boolean', 'union', '1:2', '1:3'], 'The deprecated empty creator is replaced by Figma union/subtract/intersect/exclude.'),
  createPaintStyle: supported(['style', 'create', 'PAINT', 'Paint']),
  createTextStyle: supported(['style', 'create', 'TEXT', 'Text']),
  createEffectStyle: supported(['style', 'create', 'EFFECT', 'Effect']),
  createGridStyle: supported(['style', 'create', 'GRID', 'Grid']),
  createNodeFromSvg: alternative(['render', '<svg />'], 'SVG is created through the validated renderer rather than a raw SVG command.'),
  createImage: alternative(['node', 'set-image', '1:2', 'image.png'], 'Local image bytes become an editable image fill on an explicit target node.'),
  createImageAsync: alternative(['render', '<Image src="https://example.com/image.png" />'], 'Remote images are fetched only through the validated renderer; the legacy standalone URL creator stays blocked.'),
  createVideoAsync: boundary('Figma media creation has no stable cross-editor typed workflow yet; video export is read-only.'),
  createLinkPreviewAsync: boundary('Network-backed link previews are intentionally outside the Safe Mode write surface.'),
  createGif: boundary('Raw MediaNode/GIF creation is editor-specific and has no explicit local-asset workflow yet.'),
  createCanvasRow: boundary('Figma Buzz canvas authoring is not an advertised Bridge editor target.'),
});

const PLUGIN_API_STRUCTURAL_OPERATIONS = Object.freeze({
  combineAsVariants: supported(['component', 'combine', '1:2,1:3']),
  group: supported(['node', 'group', '1:2', '1:3']),
  transformGroup: supported(['draw', 'transform-group', '1:2,1:3', '--modifiers', '[]']),
  flatten: supported(['node', 'flatten', '1:2', '1:3']),
  union: supported(['node', 'boolean', 'union', '1:2', '1:3']),
  subtract: supported(['node', 'boolean', 'subtract', '1:2', '1:3']),
  intersect: supported(['node', 'boolean', 'intersect', '1:2', '1:3']),
  exclude: supported(['node', 'boolean', 'exclude', '1:2', '1:3']),
  ungroup: supported(['node', 'ungroup', '1:2']),
});

function operationCoverageSummary() {
  const entries = [...Object.entries(PLUGIN_API_CREATION_OPERATIONS), ...Object.entries(PLUGIN_API_STRUCTURAL_OPERATIONS)];
  const counts = { supported: 0, alternative: 0, boundary: 0 };
  for (const [, entry] of entries) counts[entry.status] += 1;
  return Object.freeze({ auditedVersion: FIGMA_TYPINGS_AUDITED_VERSION, total: entries.length, ...counts });
}

export {
  FIGMA_TYPINGS_AUDITED_VERSION,
  PLUGIN_API_CREATION_OPERATIONS,
  PLUGIN_API_STRUCTURAL_OPERATIONS,
  operationCoverageSummary,
};
