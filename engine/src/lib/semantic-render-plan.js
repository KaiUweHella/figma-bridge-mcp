/**
 * Canonical, versioned creation contract shared by render adapters, the
 * Structural Gate and Figma execution. Arrays preserve authored node order;
 * object-key order is deliberately irrelevant and normalized for fixtures.
 */

export const SEMANTIC_RENDER_PLAN_KIND = 'figma-bridge/semantic-render-plan';
export const SEMANTIC_RENDER_PLAN_VERSION = 1;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ADAPTER = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMANTIC_FONT_WEIGHTS = Object.freeze({
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
});

function fontWeightError(location, value) {
  return new Error(`Semantic Render Plan ${location} has unsupported font weight "${String(value)}"`);
}

function normalizedFontWeight(value, location) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 1 && value <= 1000) return value;
    throw fontWeightError(location, value);
  }
  if (typeof value !== 'string') throw fontWeightError(location, value);
  const source = value.trim();
  if (source.startsWith('var:')) {
    const separator = source.indexOf('|');
    if (separator < 0) return source;
    const reference = source.slice(0, separator).trim();
    const fallback = source.slice(separator + 1).trim();
    if (!reference.slice(4).trim()) throw fontWeightError(location, value);
    return fallback ? `${reference}|${normalizedFontWeight(fallback, `${location} fallback`)}` : reference;
  }
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(source)) {
    return normalizedFontWeight(Number(source), location);
  }
  const semantic = source.toLowerCase().replace(/[\s_-]+/g, '');
  const numeric = SEMANTIC_FONT_WEIGHTS[semantic];
  if (numeric !== undefined) return numeric;
  throw fontWeightError(location, value);
}

function lineHeightError(location, value) {
  return new Error(`Semantic Render Plan ${location} has invalid lineHeight "${String(value)}"`);
}

export function semanticLineHeightFromAuthorValue(value, {
  quoted = false,
  location = 'lineHeight',
} = {}) {
  if (typeof value === 'string' && value.trim().startsWith('var:')) return value.trim();
  if (isRecord(value)) {
    const keys = Object.keys(value).sort().join(',');
    const unit = String(value.unit || '').toUpperCase();
    if (unit === 'AUTO' && keys === 'unit') return { unit: 'AUTO' };
    if (!['PERCENT', 'PIXELS'].includes(unit) || keys !== 'unit,value'
      || typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0) {
      throw lineHeightError(location, JSON.stringify(value));
    }
    return { unit, value: value.value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw lineHeightError(location, value);
    return { unit: 'PIXELS', value };
  }
  if (typeof value !== 'string') throw lineHeightError(location, value);
  const source = value.trim();
  if (/^auto$/i.test(source)) return { unit: 'AUTO' };
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%|px)?$/i.exec(source);
  if (!match) throw lineHeightError(location, value);
  const number = Number(match[1]);
  const unit = String(match[2] || '').toLowerCase();
  const multiplierPercent = Number((number * 100).toPrecision(15));
  const result = unit === '%' || (quoted && !unit)
    ? { unit: 'PERCENT', value: unit === '%' ? number : multiplierPercent }
    : { unit: 'PIXELS', value: number };
  if (!Number.isFinite(result.value)) throw lineHeightError(location, value);
  return result;
}

function normalizePlanTypography(node, location = 'root') {
  const source = { ...node.source, props: { ...node.source.props } };
  if (source.type === 'text') {
    if (source.props.weight !== undefined) {
      source.props.weight = normalizedFontWeight(source.props.weight, `${location}.source.props.weight`);
    }
    if (Array.isArray(source.props.runs)) {
      source.props.runs = source.props.runs.map((run, index) => {
        const style = { ...run.style };
        if (style.weight !== undefined) {
          style.weight = normalizedFontWeight(
            style.weight,
            `${location}.source.props.runs[${index}].style.weight`,
          );
        }
        return { ...run, style };
      });
    }
    if (source.props.lineHeight !== undefined) {
      source.props.lineHeight = semanticLineHeightFromAuthorValue(source.props.lineHeight, {
        location: `${location}.source.props.lineHeight`,
      });
    }
  }
  return {
    ...node,
    source,
    children: node.children.map((child, index) =>
      normalizePlanTypography(child, `${location}.children[${index}]`)),
  };
}

function validatePlanProvenance(plan) {
  if (plan.provenance === undefined) return;
  if (!isRecord(plan.provenance)) {
    throw new Error('Semantic Render Plan provenance must be an object');
  }
  const serialized = JSON.stringify(plan.provenance);
  if (!serialized || serialized.length > 1024) {
    throw new Error('Semantic Render Plan provenance must fit within 1,024 code units');
  }
  if (plan.adapter !== 'dom-capture') return;
  const provenance = plan.provenance;
  if (!Number.isInteger(provenance.captureVersion) || provenance.captureVersion < 1) {
    throw new Error('DOM-capture provenance requires a positive captureVersion');
  }
  if (provenance.captureHash !== undefined && !SHA256.test(provenance.captureHash)) {
    throw new Error('DOM-capture provenance captureHash must be SHA-256');
  }
  if (provenance.viewport !== undefined && (!isRecord(provenance.viewport)
    || !Number.isFinite(provenance.viewport.width) || provenance.viewport.width <= 0
    || !Number.isFinite(provenance.viewport.height) || provenance.viewport.height <= 0)) {
    throw new Error('DOM-capture provenance viewport must contain positive width and height');
  }
}

export function createSemanticRenderPlan(semanticModel, {
  adapter = 'unknown',
  provenance = null,
  variableCollection = null,
  designEntityBindings = null,
} = {}) {
  if (!isRecord(semanticModel) || !isRecord(semanticModel.root)) {
    throw new Error('Cannot create Semantic Render Plan: semantic model root is missing');
  }
  if (semanticModel.version !== 1) {
    throw new Error(`Cannot create Semantic Render Plan from semantic model version ${semanticModel.version ?? 'missing'}`);
  }
  const plan = {
    kind: SEMANTIC_RENDER_PLAN_KIND,
    version: SEMANTIC_RENDER_PLAN_VERSION,
    adapter,
    ...(provenance === null ? {} : { provenance }),
    ...(variableCollection ? { variableCollection } : {}),
    ...(designEntityBindings ? { designEntityBindings } : {}),
    root: normalizePlanTypography(semanticModel.root),
    diagnostics: semanticModel.diagnostics || {},
  };
  return assertSemanticRenderPlan(plan);
}

export function assertSemanticRenderPlan(plan, { executable = false } = {}) {
  if (!isRecord(plan)) throw new Error('Semantic Render Plan must be an object');
  if (plan.kind !== SEMANTIC_RENDER_PLAN_KIND) {
    throw new Error(`Unsupported Semantic Render Plan kind: ${plan.kind ?? 'missing'}`);
  }
  if (plan.version !== SEMANTIC_RENDER_PLAN_VERSION) {
    throw new Error(`Unsupported Semantic Render Plan version: ${plan.version ?? 'missing'}`);
  }
  if (typeof plan.adapter !== 'string' || !ADAPTER.test(plan.adapter)) {
    throw new Error('Semantic Render Plan adapter must be a bounded lowercase identifier');
  }
  validatePlanProvenance(plan);
  if (plan.variableCollection !== undefined
    && (typeof plan.variableCollection !== 'string' || !plan.variableCollection.trim())) {
    throw new Error('Semantic Render Plan variableCollection must be a non-empty string');
  }
  if (plan.componentLinks !== undefined) {
    throw new Error('Semantic Render Plan legacy componentLinks are not executable');
  }
  if (plan.designEntityBindings !== undefined) validateDesignEntityBindings(plan.designEntityBindings);
  const validationState = { nodes: 0 };
  validateNode(plan.root, 'root', executable, 0, validationState);
  if (!isRecord(plan.diagnostics)) {
    throw new Error('Semantic Render Plan diagnostics must be an object');
  }
  return plan;
}

const ANNOTATION_PROPERTIES = new Set([
  'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'fills',
  'strokes', 'effects', 'strokeWeight', 'cornerRadius', 'textStyleId',
  'textAlignHorizontal', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight',
  'lineHeight', 'letterSpacing', 'itemSpacing', 'padding', 'layoutMode',
  'alignItems', 'opacity', 'mainComponent', 'gridRowGap', 'gridColumnGap',
  'gridRowCount', 'gridColumnCount', 'gridRowAnchorIndex',
  'gridColumnAnchorIndex', 'gridRowSpan', 'gridColumnSpan',
]);

function validateFallbackAnnotations(annotations, location) {
  if (!Array.isArray(annotations)) {
    throw new Error('Semantic Render Plan fallbackAnnotations must be an array');
  }
  if (annotations.length > 500) {
    throw new Error('Semantic Render Plan exceeds 500 fallback annotations');
  }
  const seen = new Set();
  for (let index = 0; index < annotations.length; index++) {
    const annotation = annotations[index];
    const annotationLocation = `${location}.fallbackAnnotations[${index}]`;
    if (!isRecord(annotation)) throw new Error(`Semantic Render Plan ${annotationLocation} must be an object`);
    if (typeof annotation.policy !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(annotation.policy)) {
      throw new Error(`Semantic Render Plan ${annotationLocation}.policy is invalid`);
    }
    if (typeof annotation.labelMarkdown !== 'string' || !annotation.labelMarkdown.trim() || annotation.labelMarkdown.length > 1000) {
      throw new Error(`Semantic Render Plan ${annotationLocation}.labelMarkdown must contain at most 1000 characters`);
    }
    if (!Array.isArray(annotation.properties)
      || annotation.properties.some((property) => !ANNOTATION_PROPERTIES.has(property))) {
      throw new Error(`Semantic Render Plan ${annotationLocation}.properties contains an unsupported Figma annotation property`);
    }
    const key = annotation.policy;
    if (seen.has(key)) throw new Error(`Semantic Render Plan ${annotationLocation} duplicates policy ${annotation.policy}`);
    seen.add(key);
  }
}

function validateDesignEntityBindings(table) {
  if (!isRecord(table) || table.version !== 1 || !isRecord(table.registry)
    || !isRecord(table.targetConstraint) || !isRecord(table.bindings)) {
    throw new Error('Semantic Render Plan Design Entity bindings must use schema 1');
  }
  if (table.registry.schemaVersion !== 1 || !SHA256.test(table.registry.sourceFingerprint)) {
    throw new Error('Semantic Render Plan Design Entity Registry identity is invalid');
  }
  if (!['file-key', 'authenticated-session'].includes(table.targetConstraint.kind)
    || (table.targetConstraint.kind === 'file-key'
      && (typeof table.targetConstraint.fileKey !== 'string'
        || !table.targetConstraint.fileKey || table.targetConstraint.fileKey.length > 256
        || /[\u0000-\u001f\u007f]/.test(table.targetConstraint.fileKey)))) {
    throw new Error('Semantic Render Plan Design Entity target constraint is invalid');
  }
  const entries = Object.entries(table.bindings);
  if (!entries.length || entries.length > 2_000) {
    throw new Error('Semantic Render Plan Design Entity bindings must contain 1-2,000 entries');
  }
  for (const [entityId, binding] of entries) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(entityId)) {
      throw new Error(`Semantic Render Plan Design Entity binding id "${entityId}" is invalid`);
    }
    if (!isRecord(binding) || binding.entityId !== entityId
      || !['component', 'screen', 'frame'].includes(binding.entityKind)) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" is invalid`);
    }
    if (!Array.isArray(binding.purposes) || !binding.purposes.length
      || binding.purposes.length > 3
      || new Set(binding.purposes).size !== binding.purposes.length
      || binding.purposes.some((purpose) => !['instance', 'instance-swap', 'render-root'].includes(purpose))) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" purposes are invalid`);
    }
    if (!['published-key', 'local-node', 'created-root'].includes(binding.handleKind)
      || typeof binding.handle !== 'string' || !binding.handle || binding.handle.length > 256
      || /[\u0000-\u001f\u007f]/.test(binding.handle)) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" handle is invalid`);
    }
    if (binding.handleKind === 'local-node' && !/^\d+:\d+$/.test(binding.handle)) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" local handle is invalid`);
    }
    if (binding.handleKind === 'created-root'
      && (binding.handle !== 'created-root' || binding.entityKind === 'component'
        || !binding.purposes.includes('render-root'))) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" root handle is invalid`);
    }
    if (binding.handleKind !== 'created-root'
      && (binding.entityKind !== 'component' || binding.purposes.includes('render-root'))) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" component handle is invalid`);
    }
    if (binding.localFallback !== undefined
      && (!isRecord(binding.localFallback)
        || binding.handleKind !== 'published-key'
        || binding.localFallback.handleKind !== 'local-node'
        || !/^\d+:\d+$/.test(binding.localFallback.handle)
        || typeof binding.localFallback.fileKey !== 'string'
        || !binding.localFallback.fileKey || binding.localFallback.fileKey.length > 256
        || /[\u0000-\u001f\u007f]/.test(binding.localFallback.fileKey))) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" fallback is invalid`);
    }
    if (!Array.isArray(binding.variantIntents) || binding.variantIntents.length > 100
      || new Set(binding.variantIntents).size !== binding.variantIntents.length
      || binding.variantIntents.some((variant) => typeof variant !== 'string' || !variant
        || variant.length > 512 || /[\u0000-\u001f\u007f]/.test(variant))) {
      throw new Error(`Semantic Render Plan Design Entity binding "${entityId}" variants are invalid`);
    }
  }
}

const RICH_TEXT_STYLE_KEYS = new Set([
  'font', 'fontStyle', 'weight', 'italic', 'color', 'size', 'letterSpacing',
  'underline', 'decoration', 'href',
]);

function validateRichTextRuns(runs, props, location) {
  if (!Array.isArray(runs)) throw new Error(`Semantic Render Plan ${location}.runs must be an array`);
  if (runs.length > 5000) throw new Error(`Semantic Render Plan ${location}.runs exceeds 5,000 ranges`);
  const length = String(props.content || '').length;
  let previousEnd = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    const runLocation = `${location}.runs[${index}]`;
    if (!isRecord(run) || !Number.isInteger(run.start) || !Number.isInteger(run.end)) {
      throw new Error(`Semantic Render Plan ${runLocation} needs integer start/end offsets`);
    }
    if (run.start < previousEnd || run.start < 0 || run.end <= run.start || run.end > length) {
      throw new Error(`Semantic Render Plan ${runLocation} has an invalid or overlapping range`);
    }
    if (!isRecord(run.style)) throw new Error(`Semantic Render Plan ${runLocation}.style must be an object`);
    for (const key of Object.keys(run.style)) {
      if (!RICH_TEXT_STYLE_KEYS.has(key)) throw new Error(`Semantic Render Plan ${runLocation}.style.${key} is unsupported`);
    }
    previousEnd = run.end;
  }
}

function validateNode(node, location, executable, depth, state) {
  if (depth > 200) throw new Error('Semantic Render Plan nesting exceeds 200 levels');
  state.nodes++;
  if (state.nodes > 20_000) throw new Error('Semantic Render Plan exceeds 20,000 nodes');
  if (!isRecord(node)) throw new Error(`Semantic Render Plan ${location} must be an object`);
  if (typeof node.path !== 'string' || !node.path) throw new Error(`Semantic Render Plan ${location}.path must be a non-empty string`);
  if (typeof node.name !== 'string') throw new Error(`Semantic Render Plan ${location}.name must be a string`);
  if (!isRecord(node.source)) throw new Error(`Semantic Render Plan ${location}.source must be an object`);
  if (!Array.isArray(node.children)) throw new Error(`Semantic Render Plan ${location}.children must be an array`);
  if (node.fallbackAnnotations !== undefined) validateFallbackAnnotations(node.fallbackAnnotations, location);
  if (node.asset !== undefined) {
    if (!isRecord(node.asset)) throw new Error(`Semantic Render Plan ${location}.asset must be an object`);
    if (!['project-icon', 'builtin-icon', 'captured-svg', 'embedded-raster'].includes(node.asset.kind)) {
      throw new Error(`Semantic Render Plan ${location}.asset kind "${node.asset.kind ?? 'missing'}" is unsupported`);
    }
    if (typeof node.asset.name !== 'string' || !node.asset.name) {
      throw new Error(`Semantic Render Plan ${location}.asset.name must be a non-empty string`);
    }
    if (['project-icon', 'builtin-icon', 'captured-svg'].includes(node.asset.kind)) {
      if (typeof node.asset.svg !== 'string' || !/^\s*<svg\b/i.test(node.asset.svg)) {
        throw new Error(`Semantic Render Plan ${location}.asset.svg must contain SVG markup`);
      }
      if (Buffer.byteLength(node.asset.svg, 'utf8') > 100 * 1024) {
        throw new Error(`Semantic Render Plan ${location}.asset.svg exceeds 100 KB`);
      }
    } else if (node.asset.kind === 'embedded-raster') {
      if (typeof node.asset.base64 !== 'string' || !/^[a-z0-9+/]+=*$/i.test(node.asset.base64)) {
        throw new Error(`Semantic Render Plan ${location}.asset.base64 must contain encoded image bytes`);
      }
      if (node.asset.base64.length > 28 * 1024 * 1024) {
        throw new Error(`Semantic Render Plan ${location}.asset.base64 exceeds 20 MB decoded`);
      }
      const hasWidth = node.asset.width !== undefined;
      const hasHeight = node.asset.height !== undefined;
      if (hasWidth !== hasHeight
        || (hasWidth && (!Number.isInteger(node.asset.width) || node.asset.width < 1 || node.asset.width > 100_000
          || !Number.isInteger(node.asset.height) || node.asset.height < 1 || node.asset.height > 100_000))) {
        throw new Error(`Semantic Render Plan ${location}.asset dimensions must be paired positive bounded integers`);
      }
      if (node.asset.sha256 !== undefined
        && (typeof node.asset.sha256 !== 'string' || !SHA256.test(node.asset.sha256))) {
        throw new Error(`Semantic Render Plan ${location}.asset.sha256 must be SHA-256`);
      }
      if (node.asset.source !== undefined) {
        if (!isRecord(node.asset.source)
          || !['workspace', 'remote-http'].includes(node.asset.source.kind)
          || typeof node.asset.source.label !== 'string'
          || !node.asset.source.label
          || node.asset.source.label.length > 2048
          || /[\u0000-\u001f\u007f]/.test(node.asset.source.label)) {
          throw new Error(`Semantic Render Plan ${location}.asset.source is invalid`);
        }
        if (node.asset.source.kind === 'remote-http' && /[?#]/.test(node.asset.source.label)) {
          throw new Error(`Semantic Render Plan ${location}.asset.source must not retain URL query or fragment data`);
        }
      }
    }
  }
  if (executable && node.source.kind !== 'jsx') {
    throw new Error(`Semantic Render Plan ${location} source kind "${node.source.kind ?? 'missing'}" cannot be executed by the JSX compiler`);
  }
  if (node.source.kind === 'jsx') {
    if (typeof node.source.type !== 'string' || !node.source.type) {
      throw new Error(`Semantic Render Plan ${location}.source.type must be a non-empty string`);
    }
    if (!isRecord(node.source.props)) {
      throw new Error(`Semantic Render Plan ${location}.source.props must be an object`);
    }
    if (node.source.type === 'instance'
      && ['key', 'id', 'component'].some((field) => node.source.props[field] != null)) {
      throw new Error(`Semantic Render Plan ${location} component handles must exist only in Design Entity bindings`);
    }
    if (node.source.type === 'text' && node.source.props.weight !== undefined
      && !Object.is(normalizedFontWeight(
        node.source.props.weight,
        `${location}.source.props.weight`,
      ), node.source.props.weight)) {
      throw new Error(`Semantic Render Plan ${location}.source.props.weight must be canonical`);
    }
    if (node.source.type === 'text' && node.source.props.lineHeight !== undefined) {
      const lineHeight = semanticLineHeightFromAuthorValue(node.source.props.lineHeight, {
        location: `${location}.source.props.lineHeight`,
      });
      if (JSON.stringify(lineHeight) !== JSON.stringify(node.source.props.lineHeight)) {
        throw new Error(`Semantic Render Plan ${location}.source.props.lineHeight must be canonical`);
      }
    }
    if (node.source.props.runs !== undefined) {
      if (node.source.type !== 'text') throw new Error(`Semantic Render Plan ${location}.source.props.runs is only valid on text`);
      validateRichTextRuns(node.source.props.runs, node.source.props, `${location}.source.props`);
      for (let index = 0; index < node.source.props.runs.length; index++) {
        const weight = node.source.props.runs[index].style.weight;
        if (weight !== undefined && !Object.is(normalizedFontWeight(
          weight,
          `${location}.source.props.runs[${index}].style.weight`,
        ), weight)) {
          throw new Error(`Semantic Render Plan ${location}.source.props.runs[${index}].style.weight must be canonical`);
        }
      }
    }
  }
  node.children.forEach((child, index) => validateNode(child, `${location}.children[${index}]`, executable, depth + 1, state));
}

/** Convert an executable plan to the temporary tree expected by the current
 * plugin-code generator. This is the only compatibility seam; adapters do not
 * have to emit or reparse JSX once they can create executable plan sources. */
export function semanticRenderPlanToJsxTree(plan, { compatibilityMaterialized = false } = {}) {
  if (!compatibilityMaterialized) assertSemanticRenderPlan(plan, { executable: true });
  const visit = (node, root = false) => {
    const props = { ...node.source.props };
    const children = node.children.map((child) => visit(child));
    if (root) return { props, children, content: '' };
    return { ...props, _type: node.source.type, ...(children.length ? { _children: children } : isContainer(node.source.type) ? { _children: [] } : {}) };
  };
  return visit(plan.root, true);
}

function isContainer(type) {
  return type === 'frame' || type === 'slot';
}

export function stableStringifySemanticRenderPlan(plan) {
  assertSemanticRenderPlan(plan);
  return `${JSON.stringify(sortObjectKeys(plan), null, 2)}\n`;
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
}
