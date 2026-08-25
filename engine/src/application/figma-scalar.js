// Versioned JSON representation for Figma runtime scalars that JSON cannot
// preserve directly. Keep this vocabulary closed: new values require an
// explicit compatibility decision and contract tests.

export const FIGMA_SCALAR_KEY = '$figmaScalar';
export const FIGMA_POSITIVE_INFINITY = Object.freeze({
  [FIGMA_SCALAR_KEY]: 'Infinity',
});

export function isFigmaPositiveInfinity(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === 1
    && value[FIGMA_SCALAR_KEY] === 'Infinity';
}
