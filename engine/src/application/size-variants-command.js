// Plan-bound, rollback-verified Command Application for `sizes`.

import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import { NODE_REFERENCE_PATTERN } from "./node-reference.js";
import {
  parseSizeVariantsRequest,
  sizeVariantsArgvFromRequest,
  sizeVariantsPlanningArgvFromRequest,
} from "./size-variants-request.js";

export {
  sizeVariantsArgvFromRequest,
  sizeVariantsPlanningArgvFromRequest,
} from "./size-variants-request.js";

const APPLICATION_ID = "sizes";
export const MAX_SIZE_VARIANTS_CHILDREN = 50_000;
export const MAX_SIZE_VARIANTS_DESCENDANTS = 50_000;
export const MAX_SIZE_VARIANTS_FONTS = 256;
export const MAX_SIZE_VARIANTS_NAME_CODE_UNITS = 1_024;
export const MAX_SIZE_VARIANTS_RESULT_CODE_UNITS = 65_536;
export const MAX_SIZE_VARIANTS_GEOMETRY = 10_000_000;
export const SIZE_VARIANTS_VERIFY_EPSILON = 0.01;

const SIZE_CONFIG = Object.freeze({
  small: Object.freeze({
    scale: 0.85,
    fontSize: 0.85,
    padding: 0.75,
    radius: 0.85,
  }),
  medium: Object.freeze({ scale: 1, fontSize: 1, padding: 1, radius: 1 }),
  large: Object.freeze({
    scale: 1.2,
    fontSize: 1.15,
    padding: 1.25,
    radius: 1.1,
  }),
});
const SIZE_ORDER = Object.freeze(["small", "medium", "large"]);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

function normalizedRequest(request) {
  return parseSizeVariantsRequest(sizeVariantsArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function sizeVariantMultipliers(baseSize) {
  const base = SIZE_CONFIG[baseSize];
  if (!base) throw new Error("Unknown Size Variants base.");
  return Object.fromEntries(
    SIZE_ORDER.map((size) => [
      size,
      Object.freeze({
        scale: SIZE_CONFIG[size].scale / base.scale,
        fontSize: SIZE_CONFIG[size].fontSize / base.fontSize,
        padding: SIZE_CONFIG[size].padding / base.padding,
        radius: SIZE_CONFIG[size].radius / base.radius,
      }),
    ])
  );
}

export function sizeVariantsCode(request) {
  const input = normalizedRequest(request);
  const multipliers = sizeVariantMultipliers(input.baseSize);
  return `(async () => {
    const requestedNodeId = ${jsValue(input.nodeId)};
    const baseSize = ${jsValue(input.baseSize)};
    const gap = ${input.gap};
    const multipliers = ${jsValue(multipliers)};
    const sizes = ${jsValue(SIZE_ORDER)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SIZE_VARIANTS_RESULT_CODE_UNITS}) {
        throw new Error('Size Variants result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const childrenOf = (node, label) => {
      if (!node || !Array.isArray(node.children)) {
        throw new Error(label + ' returned invalid child membership.');
      }
      if (node.children.length > ${MAX_SIZE_VARIANTS_CHILDREN}) {
        throw new Error(label + ' exceeds the bounded child count.');
      }
      const ids = node.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw new Error(label + ' returned invalid child membership.');
      }
      return ids;
    };
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const finiteGeometry = (value) => Number.isFinite(value)
      && Math.abs(value) <= ${MAX_SIZE_VARIANTS_GEOMETRY};
    const scaled = (value, multiplier) => Math.round(value * multiplier);
    const refusal = (error) => bounded({
      schemaVersion: 1,
      status: 'refused',
      outcome: 'no-mutation',
      attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let source;
    let template;
    let sourceParent;
    let beforePageIds;
    let beforeSourceParentIds;
    let beforeSelectionIds;
    let baseName;
    let startX;
    let startY;
    const fontNames = [];
    try {
      source = requestedNodeId === null
        ? figma.currentPage.selection[0]
        : await figma.getNodeByIdAsync(requestedNodeId);
      if (!source) throw new Error('No component selected. Select a component or frame.');
      if (source.type === 'COMPONENT') template = source;
      else if (source.type === 'INSTANCE' && typeof source.getMainComponentAsync === 'function') {
        template = await source.getMainComponentAsync();
      } else if (source.type === 'FRAME') template = source;
      if (!template || !['COMPONENT', 'FRAME'].includes(template.type)
        || typeof template.clone !== 'function') {
        throw new Error('Size Variants requires a Component, Instance, or Frame source.');
      }
      if (typeof source.id !== 'string' || typeof source.name !== 'string'
        || source.name.length > ${MAX_SIZE_VARIANTS_NAME_CODE_UNITS}
        || typeof template.id !== 'string' || typeof template.name !== 'string'
        || template.name.length > ${MAX_SIZE_VARIANTS_NAME_CODE_UNITS}
        || !finiteGeometry(template.width) || template.width <= 0
        || !finiteGeometry(template.height) || template.height <= 0
        || !finiteGeometry(template.y)) {
        throw new Error('Size Variants source has invalid bounded identity or geometry.');
      }
      sourceParent = template.parent;
      if (!sourceParent || typeof sourceParent.id !== 'string'
        || !Array.isArray(sourceParent.children)) {
        throw new Error('Size Variants source has no bounded clone parent.');
      }
      beforePageIds = childrenOf(figma.currentPage, 'Current page');
      beforeSourceParentIds = sourceParent.id === figma.currentPage.id
        ? [...beforePageIds]
        : childrenOf(sourceParent, 'Source parent');
      beforeSelectionIds = figma.currentPage.selection.map((node) => node && node.id);
      if (beforeSelectionIds.length > ${MAX_SIZE_VARIANTS_CHILDREN}
        || beforeSelectionIds.some((id) => typeof id !== 'string')
        || new Set(beforeSelectionIds).size !== beforeSelectionIds.length) {
        throw new Error('Current selection exceeds the bounded identity contract.');
      }
      baseName = template.name
        .replace(/\\/(Small|Medium|Large)/gi, '')
        .replace(/\\s*(Small|Medium|Large)\\s*/gi, '').trim() || 'Component';
      if (baseName.length + '/Medium'.length > ${MAX_SIZE_VARIANTS_NAME_CODE_UNITS}) {
        throw new Error('Size Variants base name exceeds the bounded name limit.');
      }
      startX = 0;
      for (const node of figma.currentPage.children) {
        if (!finiteGeometry(node.x) || !finiteGeometry(node.width)) {
          throw new Error('Current page contains invalid placement geometry.');
        }
        startX = Math.max(startX, node.x + node.width);
      }
      startX += 200;
      startY = template.y;
      if (!finiteGeometry(startX) || !finiteGeometry(startY)) {
        throw new Error('Size Variants placement exceeds the bounded geometry limit.');
      }

      const stack = [template];
      const visited = new Set();
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node.id !== 'string' || visited.has(node.id)) {
          throw new Error('Size Variants source contains invalid or duplicate node identity.');
        }
        visited.add(node.id);
        if (visited.size > ${MAX_SIZE_VARIANTS_DESCENDANTS}) {
          throw new Error('Size Variants source exceeds the bounded descendant count.');
        }
        for (const multiplier of Object.values(multipliers)) {
          if (typeof node.resize === 'function') {
            if (!finiteGeometry(node.width) || !finiteGeometry(node.height)
              || scaled(node.width, multiplier.scale) < 1
              || scaled(node.height, multiplier.scale) < 1) {
              throw new Error('Size Variants cannot produce valid scaled node geometry.');
            }
          }
          for (const field of ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing']) {
            if (node[field] !== undefined && !Number.isFinite(node[field])) {
              throw new Error('Size Variants found invalid Auto Layout geometry.');
            }
          }
          if (node.type === 'TEXT') {
            if (typeof node.fontSize === 'number') {
              if (!Number.isFinite(node.fontSize)
                || scaled(node.fontSize, multiplier.fontSize) < 1) {
                throw new Error('Size Variants cannot produce valid text geometry.');
              }
            } else if (typeof node.getStyledTextSegments !== 'function'
              || typeof node.setRangeFontSize !== 'function') {
              throw new Error('Size Variants cannot safely scale mixed-size text.');
            }
          }
        }
        if (node.type === 'TEXT' && typeof node.characters === 'string' && node.characters.length) {
          const names = node.fontName === figma.mixed
            ? (typeof node.getRangeAllFontNames === 'function'
              ? node.getRangeAllFontNames(0, node.characters.length) : [])
            : [node.fontName];
          if (!Array.isArray(names) || names.some((font) => !font
            || typeof font.family !== 'string' || typeof font.style !== 'string')) {
            throw new Error('Size Variants could not preflight every text font.');
          }
          for (const font of names) {
            const key = font.family + '\\u0000' + font.style;
            if (!fontNames.some((entry) => entry.key === key)) fontNames.push({ key, font });
            if (fontNames.length > ${MAX_SIZE_VARIANTS_FONTS}) {
              throw new Error('Size Variants exceeds the bounded font count.');
            }
          }
        }
        if (Array.isArray(node.children)) {
          for (let index = node.children.length - 1; index >= 0; index--) {
            stack.push(node.children[index]);
          }
        }
      }
      for (const entry of fontNames) await figma.loadFontAsync(entry.font);
    } catch (error) {
      return refusal(error);
    }

    const ownedIds = [];
    const createdIds = [];
    let attempted = 0;
    const scaleNode = (root, multiplier) => {
      const stack = [root];
      let visited = 0;
      while (stack.length) {
        const node = stack.pop();
        visited++;
        if (visited > ${MAX_SIZE_VARIANTS_DESCENDANTS}) {
          throw new Error('Size Variants clone exceeds the bounded descendant count.');
        }
        if (typeof node.resize === 'function' && typeof node.width === 'number') {
          node.resize(scaled(node.width, multiplier.scale), scaled(node.height, multiplier.scale));
        }
        if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
          node.cornerRadius = scaled(node.cornerRadius, multiplier.radius);
        }
        if (node.paddingLeft !== undefined) {
          node.paddingLeft = scaled(node.paddingLeft, multiplier.padding);
          node.paddingRight = scaled(node.paddingRight, multiplier.padding);
          node.paddingTop = scaled(node.paddingTop, multiplier.padding);
          node.paddingBottom = scaled(node.paddingBottom, multiplier.padding);
        }
        if (node.itemSpacing !== undefined && node.itemSpacing > 0) {
          node.itemSpacing = scaled(node.itemSpacing, multiplier.padding);
        }
        if (node.type === 'TEXT') {
          if (typeof node.fontSize === 'number') {
            node.fontSize = scaled(node.fontSize, multiplier.fontSize);
          } else {
            const segments = node.getStyledTextSegments(['fontSize']);
            if (!Array.isArray(segments) || segments.length > ${MAX_SIZE_VARIANTS_DESCENDANTS}) {
              throw new Error('Size Variants returned invalid mixed-size text segments.');
            }
            for (const segment of segments) {
              if (!segment || !Number.isSafeInteger(segment.start)
                || !Number.isSafeInteger(segment.end) || segment.start < 0
                || segment.end <= segment.start || segment.end > node.characters.length
                || !Number.isFinite(segment.fontSize)
                || scaled(segment.fontSize, multiplier.fontSize) < 1) {
                throw new Error('Size Variants returned invalid mixed-size text segments.');
              }
              node.setRangeFontSize(
                segment.start, segment.end, scaled(segment.fontSize, multiplier.fontSize),
              );
            }
          }
        }
        if (Array.isArray(node.children)) {
          for (let index = node.children.length - 1; index >= 0; index--) {
            stack.push(node.children[index]);
          }
        }
      }
    };

    try {
      let x = startX;
      for (const size of sizes) {
        attempted++;
        const multiplier = multipliers[size];
        const clone = template.clone();
        if (!clone || typeof clone.id !== 'string' || clone.id === template.id
          || typeof clone.remove !== 'function') {
          throw new Error('Size Variants source did not return a distinct removable clone.');
        }
        ownedIds.push(clone.id);
        figma.currentPage.appendChild(clone);
        scaleNode(clone, multiplier);
        let component = clone;
        if (clone.type === 'FRAME') {
          component = figma.createComponentFromNode(clone);
          if (!component || typeof component.id !== 'string'
            || typeof component.remove !== 'function') {
            throw new Error('Size Variants could not attribute the converted Component.');
          }
          if (!ownedIds.includes(component.id)) ownedIds.push(component.id);
        }
        if (component.type !== 'COMPONENT') {
          throw new Error('Size Variants clone did not become a Component.');
        }
        const label = size.charAt(0).toUpperCase() + size.slice(1);
        component.name = baseName + '/' + label;
        component.x = x;
        component.y = startY;
        createdIds.push(component.id);
        x += component.width + gap;
        if (!finiteGeometry(x)) throw new Error('Size Variants placement exceeded its geometry limit.');
      }

      const freshSource = await figma.getNodeByIdAsync(source.id);
      const freshTemplate = await figma.getNodeByIdAsync(template.id);
      const freshPage = await figma.getNodeByIdAsync(figma.currentPage.id);
      const freshSourceParent = sourceParent.id === figma.currentPage.id
        ? freshPage : await figma.getNodeByIdAsync(sourceParent.id);
      const afterPageIds = childrenOf(freshPage, 'Fresh current page');
      const afterSourceParentIds = sourceParent.id === figma.currentPage.id
        ? afterPageIds : childrenOf(freshSourceParent, 'Fresh source parent');
      const expectedPageIds = [...beforePageIds, ...createdIds];
      if (!freshSource || freshSource.id !== source.id
        || !freshTemplate || freshTemplate.id !== template.id
        || !sameIds(afterPageIds, expectedPageIds)
        || (sourceParent.id !== figma.currentPage.id
          && !sameIds(afterSourceParentIds, beforeSourceParentIds))) {
        throw new Error('Size Variants could not verify source and page membership.');
      }
      const variants = [];
      const verifiedNodes = [];
      let expectedX = startX;
      for (let index = 0; index < createdIds.length; index++) {
        const size = sizes[index];
        const node = await figma.getNodeByIdAsync(createdIds[index]);
        const multiplier = multipliers[size];
        const expectedWidth = scaled(template.width, multiplier.scale);
        const expectedHeight = scaled(template.height, multiplier.scale);
        const expectedName = baseName + '/' + size.charAt(0).toUpperCase() + size.slice(1);
        if (!node || node.type !== 'COMPONENT' || !node.parent
          || node.parent.id !== figma.currentPage.id
          || afterPageIds[beforePageIds.length + index] !== node.id
          || node.name !== expectedName
          || !finiteGeometry(node.width) || !finiteGeometry(node.height)
          || Math.abs(node.width - expectedWidth) > ${SIZE_VARIANTS_VERIFY_EPSILON}
          || Math.abs(node.height - expectedHeight) > ${SIZE_VARIANTS_VERIFY_EPSILON}
          || !finiteGeometry(node.x) || !finiteGeometry(node.y)
          || Math.abs(node.x - expectedX) > ${SIZE_VARIANTS_VERIFY_EPSILON}
          || Math.abs(node.y - startY) > ${SIZE_VARIANTS_VERIFY_EPSILON}) {
          throw new Error('Size Variants could not freshly verify every generated Component.');
        }
        variants.push({
          id: clean(node.id, 512),
          name: clean(node.name, ${MAX_SIZE_VARIANTS_NAME_CODE_UNITS}),
          size,
          parentId: clean(node.parent.id, 512),
          index: beforePageIds.length + index,
          width: node.width,
          height: node.height,
          x: node.x,
          y: node.y,
        });
        verifiedNodes.push(node);
        expectedX += node.width + gap;
      }

      const warnings = [];
      try {
        figma.currentPage.selection = verifiedNodes;
        const selectedIds = figma.currentPage.selection.map((node) => node.id);
        if (!sameIds(selectedIds, createdIds)) {
          warnings.push('Generated Components were verified, but selection could not be updated exactly.');
        }
      } catch {
        warnings.push('Generated Components were verified, but selection could not be updated.');
      }
      try {
        figma.viewport.scrollAndZoomIntoView(verifiedNodes);
      } catch {
        warnings.push('Generated Components were verified, but viewport focus could not be updated.');
      }
      delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1,
        status: 'created',
        source: {
          id: clean(source.id, 512),
          name: clean(source.name, ${MAX_SIZE_VARIANTS_NAME_CODE_UNITS}),
          type: clean(source.type, 64),
          templateId: clean(template.id, 512),
          templateType: clean(template.type, 64),
          baseName: clean(baseName, ${MAX_SIZE_VARIANTS_NAME_CODE_UNITS}),
          templateWidth: template.width,
          templateHeight: template.height,
          templateY: template.y,
        },
        pageId: clean(figma.currentPage.id, 512),
        baseSize,
        gap,
        variants,
        warnings,
        attempted,
        residue: [],
      });
    } catch (error) {
      const failure = clean(error && error.message ? error.message : String(error), 1024);
      for (let index = ownedIds.length - 1; index >= 0; index--) {
        try {
          const owned = await figma.getNodeByIdAsync(ownedIds[index]);
          if (owned && typeof owned.remove === 'function') owned.remove();
        } catch {}
      }
      try {
        const selection = [];
        for (const id of beforeSelectionIds) {
          const node = await figma.getNodeByIdAsync(id);
          if (node && node.parent && node.parent.id === figma.currentPage.id) selection.push(node);
        }
        figma.currentPage.selection = selection;
      } catch {}
      try {
        const freshPage = await figma.getNodeByIdAsync(figma.currentPage.id);
        const freshSourceParent = sourceParent.id === figma.currentPage.id
          ? freshPage : await figma.getNodeByIdAsync(sourceParent.id);
        const restoredPageIds = childrenOf(freshPage, 'Restored current page');
        const restoredSourceParentIds = sourceParent.id === figma.currentPage.id
          ? restoredPageIds : childrenOf(freshSourceParent, 'Restored source parent');
        const selectedIds = figma.currentPage.selection.map((node) => node && node.id);
        const residueIds = [];
        for (const id of new Set(ownedIds)) {
          let attached = false;
          try {
            const node = await figma.getNodeByIdAsync(id);
            attached = Boolean(node && node.parent);
          } catch {}
          if (attached || restoredPageIds.includes(id) || restoredSourceParentIds.includes(id)) {
            residueIds.push(clean(id, 512));
          }
        }
        const pageChanged = !sameIds(restoredPageIds, beforePageIds);
        const sourceParentChanged = sourceParent.id !== figma.currentPage.id
          && !sameIds(restoredSourceParentIds, beforeSourceParentIds);
        const selectionChanged = !sameIds(selectedIds, beforeSelectionIds);
        const restored = residueIds.length === 0 && !pageChanged
          && !sourceParentChanged && !selectionChanged;
        if (restored) delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: restored ? 'rolled-back' : 'partial-residue',
          attempted,
          restored: restored ? attempted : 0,
          residue: { residueIds, pageChanged, sourceParentChanged, selectionChanged },
          failure,
        });
      } catch {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: 'verification-unavailable',
          attempted,
          restored: 0,
          residue: {
            residueIds: [], pageChanged: false, sourceParentChanged: false, selectionChanged: false,
          },
          failure,
        });
      }
    }
  })()`;
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function validString(value, maximum, empty = true) {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (empty || value.length > 0) &&
    !UNSAFE_TEXT.test(value)
  );
}

function validId(value) {
  return validString(value, 512, false) && NODE_REFERENCE_PATTERN.test(value);
}

function validGeometry(value, positive = false) {
  return (
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_SIZE_VARIANTS_GEOMETRY &&
    (!positive || value > 0)
  );
}

function validSource(value, input) {
  return (
    exactKeys(value, [
      "id",
      "name",
      "type",
      "templateId",
      "templateType",
      "baseName",
      "templateWidth",
      "templateHeight",
      "templateY",
    ]) &&
    validId(value.id) &&
    validString(value.name, MAX_SIZE_VARIANTS_NAME_CODE_UNITS) &&
    ["COMPONENT", "INSTANCE", "FRAME"].includes(value.type) &&
    validId(value.templateId) &&
    ["COMPONENT", "FRAME"].includes(value.templateType) &&
    validString(value.baseName, MAX_SIZE_VARIANTS_NAME_CODE_UNITS, false) &&
    validGeometry(value.templateWidth, true) &&
    validGeometry(value.templateHeight, true) &&
    validGeometry(value.templateY) &&
    (input.nodeId === null || value.id === input.nodeId) &&
    (value.type !== "COMPONENT" || value.templateId === value.id) &&
    (value.type !== "FRAME" ||
      (value.templateId === value.id && value.templateType === "FRAME"))
  );
}

function validWarnings(value) {
  return (
    Array.isArray(value) &&
    value.length <= 2 &&
    value.every((warning) => validString(warning, 256, false))
  );
}

function validSuccess(value, input) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "status",
      "source",
      "pageId",
      "baseSize",
      "gap",
      "variants",
      "warnings",
      "attempted",
      "residue",
    ]) ||
    value.schemaVersion !== 1 ||
    value.status !== "created" ||
    !validSource(value.source, input) ||
    !validId(value.pageId) ||
    value.baseSize !== input.baseSize ||
    value.gap !== input.gap ||
    !Array.isArray(value.variants) ||
    value.variants.length !== 3 ||
    !validWarnings(value.warnings) ||
    value.attempted !== 3 ||
    !Array.isArray(value.residue) ||
    value.residue.length !== 0
  )
    return false;
  const multipliers = sizeVariantMultipliers(input.baseSize);
  const ids = new Set();
  let previous = null;
  for (let index = 0; index < value.variants.length; index++) {
    const variant = value.variants[index];
    const size = SIZE_ORDER[index];
    const label = size.charAt(0).toUpperCase() + size.slice(1);
    if (
      !exactKeys(variant, [
        "id",
        "name",
        "size",
        "parentId",
        "index",
        "width",
        "height",
        "x",
        "y",
      ]) ||
      !validId(variant.id) ||
      ids.has(variant.id) ||
      variant.name !== `${value.source.baseName}/${label}` ||
      variant.size !== size ||
      variant.parentId !== value.pageId ||
      !Number.isSafeInteger(variant.index) ||
      variant.index < 0 ||
      !validGeometry(variant.width, true) ||
      !validGeometry(variant.height, true) ||
      !validGeometry(variant.x) ||
      !validGeometry(variant.y) ||
      Math.abs(
        variant.width -
          Math.round(value.source.templateWidth * multipliers[size].scale)
      ) > SIZE_VARIANTS_VERIFY_EPSILON ||
      Math.abs(
        variant.height -
          Math.round(value.source.templateHeight * multipliers[size].scale)
      ) > SIZE_VARIANTS_VERIFY_EPSILON ||
      Math.abs(variant.y - value.source.templateY) >
        SIZE_VARIANTS_VERIFY_EPSILON ||
      (previous &&
        (variant.index !== previous.index + 1 ||
          Math.abs(variant.x - (previous.x + previous.width + input.gap)) >
            SIZE_VARIANTS_VERIFY_EPSILON))
    )
      return false;
    ids.add(variant.id);
    previous = variant;
  }
  return true;
}

function validRefusal(value) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "status",
      "outcome",
      "attempted",
      "failure",
    ]) &&
    value.schemaVersion === 1 &&
    value.status === "refused" &&
    value.outcome === "no-mutation" &&
    value.attempted === 0 &&
    validString(value.failure, 1_024, false)
  );
}

function validFailure(value) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "status",
      "outcome",
      "attempted",
      "restored",
      "residue",
      "failure",
    ]) &&
    value.schemaVersion === 1 &&
    value.status === "failed" &&
    ["rolled-back", "partial-residue", "verification-unavailable"].includes(
      value.outcome
    ) &&
    Number.isSafeInteger(value.attempted) &&
    value.attempted >= 1 &&
    value.attempted <= 3 &&
    Number.isSafeInteger(value.restored) &&
    value.restored >= 0 &&
    value.restored <= value.attempted &&
    exactKeys(value.residue, [
      "residueIds",
      "pageChanged",
      "sourceParentChanged",
      "selectionChanged",
    ]) &&
    Array.isArray(value.residue.residueIds) &&
    value.residue.residueIds.length <= 6 &&
    value.residue.residueIds.every(validId) &&
    new Set(value.residue.residueIds).size ===
      value.residue.residueIds.length &&
    typeof value.residue.pageChanged === "boolean" &&
    typeof value.residue.sourceParentChanged === "boolean" &&
    typeof value.residue.selectionChanged === "boolean" &&
    validString(value.failure, 1_024, false) &&
    (value.outcome !== "rolled-back" ||
      (value.restored === value.attempted &&
        value.residue.residueIds.length === 0 &&
        !value.residue.pageChanged &&
        !value.residue.sourceParentChanged &&
        !value.residue.selectionChanged)) &&
    (value.outcome !== "partial-residue" ||
      (value.restored === 0 &&
        (value.residue.residueIds.length > 0 ||
          value.residue.pageChanged ||
          value.residue.sourceParentChanged ||
          value.residue.selectionChanged))) &&
    (value.outcome !== "verification-unavailable" || value.restored === 0)
  );
}

export function formatSizeVariantsResult(result) {
  return (
    `Created ${result.variants.length} size variants\n` +
    result.variants
      .map(
        (variant) =>
          `  ${variant.name} ` + `(${variant.width}×${variant.height})`
      )
      .join("\n")
  );
}

function mutationError(message, outcome, report) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */
  const error = new Error(message);
  error.kind = "execution";
  error.phase = "plugin-execution";
  error.outcome = "unknown-after-dispatch";
  error.dispatchState = "failed";
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}

function pluginResultError(message) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
  const error = new Error(message);
  error.kind = "plugin-result";
  error.phase = "plugin-response";
  error.outcome = "unknown-after-dispatch";
  return error;
}

export async function executeSizeVariants(request, adapters = {}) {
  if (typeof adapters.evaluate !== "function") {
    throw new TypeError("Size Variants requires a Figma evaluate adapter.");
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(sizeVariantsCode(input));
  if (
    typeof serialized !== "string" ||
    serialized.length > MAX_SIZE_VARIANTS_RESULT_CODE_UNITS
  ) {
    throw pluginResultError(
      "Size Variants returned an invalid bounded result."
    );
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginResultError("Size Variants returned invalid JSON.");
  }
  if (payload?.status === "refused") {
    if (!validRefusal(payload))
      throw pluginResultError(
        "Size Variants returned an invalid bounded result."
      );
    throw mutationError(
      `Size Variants made no mutation: ${payload.failure}`,
      "no-mutation",
      {
        version: 1,
        outcome: "no-mutation",
        attempted: 0,
        restored: 0,
        residueCount: 0,
      }
    );
  }
  if (payload?.status === "failed") {
    if (!validFailure(payload))
      throw pluginResultError(
        "Size Variants returned an invalid bounded result."
      );
    const residueCount =
      payload.residue.residueIds.length +
      Number(payload.residue.pageChanged) +
      Number(payload.residue.sourceParentChanged) +
      Number(payload.residue.selectionChanged);
    const message =
      payload.outcome === "rolled-back"
        ? `Size Variants failed and removed every generated node: ${payload.failure}`
        : `Size Variants failed; generated-node cleanup could not be fully proven: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1,
      outcome: payload.outcome,
      attempted: payload.attempted,
      restored: payload.restored,
      residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError(
      "Size Variants returned an invalid bounded result."
    );
  }
  return {
    stdout: formatSizeVariantsResult(payload),
    stderr: payload.warnings.join("\n"),
    result: payload,
  };
}

export function sizeVariantsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      "Size Variants routing requires a Command Plan created by the Capability Catalog."
    );
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? "command-application"
    : "not-size-variants";
}

export async function executeSizeVariantsPlan(plan, adapters = {}) {
  if (sizeVariantsPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by Size Variants.`
    );
  }
  return executeSizeVariants(parseSizeVariantsRequest(plan.argv), adapters);
}
