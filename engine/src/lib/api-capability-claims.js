// Structured Plugin API types often never appear by name in generated eval
// JavaScript. Keep explicit, command-backed claims so `api gap` does not call
// an implemented object shape missing. Tests verify every name still exists in
// the installed official declarations.
const API_CAPABILITY_CLAIMS = Object.freeze({
  'var create': ['VariableResolvedDataType', 'VariableValue', 'MotionEasing'],
  'col extend': ['VariableCollection', 'ExtendedVariableCollection'],
  'style bind-font': ['TextStyle', 'VariableBindableTextField'],
  prototype: ['Reaction', 'Action', 'Trigger', 'ConditionalBlock', 'VariableData'],
  measure: ['Measurement', 'MeasurementSide', 'MeasurementOffset'],
  annotate: ['AnnotationsAPI', 'Annotation', 'AnnotationProperty', 'AnnotationPropertyType', 'AnnotationCategoryColor', 'AnnotationCategory'],
  'export video': ['ExportSettingsMP4', 'ExportSettingsGIF', 'ExportSettingsWEBM', 'VideoExportConstraint'],
  shader: ['Shader', 'ShaderPaint', 'ShaderEffect', 'ShaderPropertyValue', 'ShaderPropertyDefinition'],
  'layout grid': ['GridTrackSize', 'GridTrackReorderOptions', 'GridTrackReorderEntry'],
  slot: ['SlotSettings', 'SlotNode', 'ComponentPropertyOptions', 'ComponentPropertyDefinitions'],
  draw: [
    'TextPathNode', 'TextPathStartData', 'TransformGroupNode', 'TransformModifier',
    'RepeatModifier', 'LinearRepeatModifier', 'RadialRepeatModifier',
    'ComplexStrokeProperties', 'BrushStrokeProperties', 'DynamicStrokeProperties',
    'VariableWidthStrokeProperties', 'VariableWidthPoint', 'PatternPaint',
  ],
});

const coveredApiTypeNames = () => new Set(Object.values(API_CAPABILITY_CLAIMS).flat());

export { API_CAPABILITY_CLAIMS, coveredApiTypeNames };
