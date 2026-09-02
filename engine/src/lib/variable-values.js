// Closed helpers for native VariableValue shapes that are newer than the
// public Plugin API typings. Keep this deliberately narrow: Figma currently
// emits COMPOSE_COLOR(alias, opacityPercent) for color aliases with opacity.

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function isVariableAliasValue(value) {
  return exactKeys(value, ['type', 'id'])
    && value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string' && value.id.length > 0;
}

export function isOpacityPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function composedColorValueParts(value) {
  if (!exactKeys(value, ['type', 'expressionFunction', 'expressionArguments'])
    || value.type !== 'VARIABLE_EXPRESSION'
    || value.expressionFunction !== 'COMPOSE_COLOR'
    || !Array.isArray(value.expressionArguments)
    || value.expressionArguments.length !== 2
    || !isVariableAliasValue(value.expressionArguments[0])
    || !isOpacityPercent(value.expressionArguments[1])) return null;
  return { alias: value.expressionArguments[0], opacity: value.expressionArguments[1] };
}

export function isComposedColorValue(value) {
  return composedColorValueParts(value) !== null;
}

export function applyOpacityToHex(value, opacity) {
  const match = typeof value === 'string'
    ? value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i)
    : null;
  if (!match || !isOpacityPercent(opacity)) return null;
  const existingAlpha = match[2] ? parseInt(match[2], 16) / 255 : 1;
  const alpha = Math.round(existingAlpha * (opacity / 100) * 255);
  return `#${match[1].toLowerCase()}${alpha.toString(16).padStart(2, '0')}`;
}
