export const MAX_ABSOLUTE_NODE_COORDINATE = Number.MAX_SAFE_INTEGER;

/** Parse one finite, safely serializable Figma coordinate. */
export function finiteNodeCoordinate(value, field = 'coordinate') {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`${field} must be a finite number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_ABSOLUTE_NODE_COORDINATE) {
    throw new Error(`${field} must be a finite number between -${MAX_ABSOLUTE_NODE_COORDINATE} and ${MAX_ABSOLUTE_NODE_COORDINATE}`);
  }
  return Object.is(number, -0) ? 0 : number;
}
