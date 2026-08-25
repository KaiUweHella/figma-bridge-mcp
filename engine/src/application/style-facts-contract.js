// Data-only discriminant contract for every official Figma union that the
// exact Style Facts projection switches on. The typings drift gate compares
// these values through TypeScript's TypeChecker, while runtime validators use
// the same data instead of maintaining parallel literal lists.

export const STYLE_FACTS_DISCRIMINANTS = Object.freeze({
  BaseStyle: Object.freeze({ property: 'type', values: Object.freeze([
    'PAINT', 'TEXT', 'EFFECT', 'GRID',
  ]) }),
  Paint: Object.freeze({ property: 'type', values: Object.freeze([
    'SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR',
    'GRADIENT_DIAMOND', 'IMAGE', 'VIDEO', 'PATTERN', 'SHADER',
  ]) }),
  Effect: Object.freeze({ property: 'type', values: Object.freeze([
    'DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR',
    'NOISE', 'TEXTURE', 'GLASS', 'SHADER',
  ]) }),
  LayoutGrid: Object.freeze({ property: 'pattern', values: Object.freeze([
    'ROWS', 'COLUMNS', 'GRID',
  ]) }),
  BlurEffect: Object.freeze({ property: 'blurType', values: Object.freeze([
    'NORMAL', 'PROGRESSIVE',
  ]) }),
  NoiseEffect: Object.freeze({ property: 'noiseType', values: Object.freeze([
    'MONOTONE', 'DUOTONE', 'MULTITONE',
  ]) }),
});

export function isStyleFactsDiscriminant(unionName, value) {
  return typeof value === 'string'
    && STYLE_FACTS_DISCRIMINANTS[unionName]?.values.includes(value) === true;
}
