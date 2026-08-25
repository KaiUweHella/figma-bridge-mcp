// Exact host-side contract for the pinned Figma LayoutGrid union.

import { isFigmaPositiveInfinity } from './figma-scalar.js';
import { isStyleFactsDiscriminant } from './style-facts-contract.js';

const GRID_ALIGNMENTS = new Set(['MIN', 'MAX', 'STRETCH', 'CENTER']);
const GRID_BINDING_FIELDS = new Set(['sectionSize', 'count', 'offset', 'gutterSize']);

function exactOptionalKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validRgba(value) {
  return exactOptionalKeys(value, ['r', 'g', 'b', 'a'])
    && ['r', 'g', 'b', 'a'].every((field) => finiteNumber(value[field]));
}

function validAlias(value, maxLabelCodeUnits) {
  return exactOptionalKeys(value, ['type', 'id'])
    && value.type === 'VARIABLE_ALIAS'
    && typeof value.id === 'string'
    && value.id.length > 0
    && value.id.length <= maxLabelCodeUnits;
}

function validAliasMap(value, allowedFields, maxEntries, maxLabelCodeUnits) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= maxEntries
    && entries.every(([field, alias]) => allowedFields.has(field)
      && validAlias(alias, maxLabelCodeUnits));
}

export function isExactLayoutGridList(value, {
  maxEntries = 1024,
  maxLabelCodeUnits = 1024,
} = {}) {
  return Array.isArray(value)
    && value.length <= maxEntries
    && value.every((grid) => {
      if (!grid || typeof grid !== 'object' || Array.isArray(grid)
        || !isStyleFactsDiscriminant('LayoutGrid', grid.pattern)) return false;
      if (grid.pattern === 'GRID') {
        return exactOptionalKeys(grid, ['pattern', 'sectionSize'], [
          'visible', 'color', 'boundVariables',
        ])
          && finiteNumber(grid.sectionSize)
          && (grid.visible === undefined || typeof grid.visible === 'boolean')
          && (grid.color === undefined || validRgba(grid.color))
          && (grid.boundVariables === undefined || validAliasMap(
            grid.boundVariables,
            new Set(['sectionSize']),
            maxEntries,
            maxLabelCodeUnits,
          ));
      }
      return exactOptionalKeys(grid, ['pattern', 'alignment', 'gutterSize', 'count'], [
        'sectionSize', 'offset', 'visible', 'color', 'boundVariables',
      ])
        && GRID_ALIGNMENTS.has(grid.alignment)
        && finiteNumber(grid.gutterSize)
        && (finiteNumber(grid.count) || isFigmaPositiveInfinity(grid.count))
        && (grid.sectionSize === undefined || finiteNumber(grid.sectionSize))
        && (grid.offset === undefined || finiteNumber(grid.offset))
        && (grid.visible === undefined || typeof grid.visible === 'boolean')
        && (grid.color === undefined || validRgba(grid.color))
        && (grid.boundVariables === undefined || validAliasMap(
          grid.boundVariables,
          GRID_BINDING_FIELDS,
          maxEntries,
          maxLabelCodeUnits,
        ));
    });
}
