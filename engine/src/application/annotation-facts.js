// Shared bounds and official closed vocabulary for native Annotation facts.

export const MAX_ANNOTATION_READ_ITEMS = 4_096;
export const MAX_ANNOTATION_READ_PROPERTIES = 64;
export const MAX_ANNOTATION_LABEL_CODE_UNITS = 65_536;
export const ANNOTATION_PROPERTY_TYPES = Object.freeze([
  'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight',
  'fills', 'strokes', 'effects', 'strokeWeight', 'cornerRadius', 'textStyleId',
  'textAlignHorizontal', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight',
  'lineHeight', 'letterSpacing', 'itemSpacing', 'padding', 'layoutMode', 'alignItems',
  'opacity', 'mainComponent', 'gridRowGap', 'gridColumnGap', 'gridRowCount',
  'gridColumnCount', 'gridRowAnchorIndex', 'gridColumnAnchorIndex', 'gridRowSpan',
  'gridColumnSpan',
]);
