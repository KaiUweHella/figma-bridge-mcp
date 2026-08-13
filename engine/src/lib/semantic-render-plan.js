/**
 * Canonical, versioned creation contract shared by render adapters, the
 * Structural Gate and Figma execution. Arrays preserve authored node order;
 * object-key order is deliberately irrelevant and normalized for fixtures.
 */

export const SEMANTIC_RENDER_PLAN_KIND = 'figma-bridge/semantic-render-plan';
export const SEMANTIC_RENDER_PLAN_VERSION = 1;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createSemanticRenderPlan(semanticModel, {
  adapter = 'unknown',
  provenance = null,
  variableCollection = null,
  componentLinks = null,
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
    ...(componentLinks && Object.keys(componentLinks).length ? { componentLinks } : {}),
    root: semanticModel.root,
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
  if (typeof plan.adapter !== 'string' || !plan.adapter) {
    throw new Error('Semantic Render Plan adapter must be a non-empty string');
  }
  if (plan.variableCollection !== undefined
    && (typeof plan.variableCollection !== 'string' || !plan.variableCollection.trim())) {
    throw new Error('Semantic Render Plan variableCollection must be a non-empty string');
  }
  if (plan.componentLinks !== undefined) validateComponentLinks(plan.componentLinks);
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

function validateComponentLinks(componentLinks) {
  if (!isRecord(componentLinks)) {
    throw new Error('Semantic Render Plan componentLinks must be an object');
  }
  for (const [entityId, link] of Object.entries(componentLinks)) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(entityId)) {
      throw new Error(`Semantic Render Plan component link id "${entityId}" is invalid`);
    }
    if (!isRecord(link)) {
      throw new Error(`Semantic Render Plan component link "${entityId}" must be an object`);
    }
    if (link.entityId !== undefined && link.entityId !== entityId) {
      throw new Error(`Semantic Render Plan component link "${entityId}" has a mismatched entityId`);
    }
    if (!link.key && !link.id) {
      throw new Error(`Semantic Render Plan component link "${entityId}" needs a published key or local node id`);
    }
    if (link.key !== undefined && (typeof link.key !== 'string' || !link.key.trim())) {
      throw new Error(`Semantic Render Plan component link "${entityId}" key must be a non-empty string`);
    }
    if (link.id !== undefined && (typeof link.id !== 'string' || !/^\d+:\d+$/.test(link.id))) {
      throw new Error(`Semantic Render Plan component link "${entityId}" id must use Figma node-id syntax`);
    }
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
    if (!['project-icon', 'builtin-icon', 'captured-svg', 'embedded-raster', 'remote-raster'].includes(node.asset.kind)) {
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
    } else if (typeof node.asset.src !== 'string' || !/^https?:\/\//i.test(node.asset.src)) {
      throw new Error(`Semantic Render Plan ${location}.asset.src must be an HTTP(S) URL`);
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
  }
  node.children.forEach((child, index) => validateNode(child, `${location}.children[${index}]`, executable, depth + 1, state));
}

/** Convert an executable plan to the temporary tree expected by the current
 * plugin-code generator. This is the only compatibility seam; adapters do not
 * have to emit or reparse JSX once they can create executable plan sources. */
export function semanticRenderPlanToJsxTree(plan) {
  assertSemanticRenderPlan(plan, { executable: true });
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
