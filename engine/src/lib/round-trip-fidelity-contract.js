// Executable Round-trip Fidelity Contract.
//
// This Module classifies core Figma fact families across both directions. It
// does not replace Design Capture, Semantic Render Plans or their Adapters;
// it makes their relationship explicit and fail-closed. A writer existing in
// one direction is never evidence that the reverse projection is complete.

export const ROUND_TRIP_FIDELITY_VERSION = 1;

export const ROUND_TRIP_MAPPING_CLASSES = Object.freeze([
  'EXACT',
  'CONDITIONAL',
  'STRUCTURAL',
  'VISUAL',
  'FIGMA_ONLY',
  'CODE_ONLY',
  'STOP',
]);

const EXECUTABLE_CLASSES = new Set(['EXACT', 'CONDITIONAL', 'STRUCTURAL', 'VISUAL']);
const EXPLICIT_SEAM_CLASSES = new Set(['FIGMA_ONLY', 'CODE_ONLY', 'STOP']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const direction = (classification, implementation, verification, note = '') => ({
  classification,
  implementation,
  verification,
  note,
});

const facts = [
  {
    id: 'hierarchy-geometry',
    area: 'structure',
    figmaTypes: ['SceneNode'],
    codeToFigma: direction(
      'EXACT',
      ['Semantic Render Plan ordered nodes', 'Figma Render Executor native tree'],
      ['Structural Report', 'pixel comparison'],
    ),
    figmaToCode: direction(
      'EXACT',
      ['Design Capture hierarchy and geometry', 'Code-Spec tree/structured projection'],
      ['layer coverage', 'pixel comparison'],
    ),
  },
  {
    id: 'layout-sizing',
    area: 'layout',
    figmaTypes: ['AutoLayoutMixin', 'FrameNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan Auto Layout/Grid intent', 'Figma Render Executor sizing bindings'],
      ['Structural Gate', 'resize and pixel probes'],
      'Browser intrinsic sizing exceeds Figma HUG/FILL semantics.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture authored/inferred/geometry provenance', 'Code-Spec layout projection'],
      ['layout provenance checks', 'resize and pixel probes'],
      'Figma sizing modes require a compatible target layout model.',
    ),
  },
  {
    id: 'variables-styles',
    area: 'design-system',
    figmaTypes: ['Variable', 'VariableCollection', 'BaseStyleMixin'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['token import/sync', 'Figma Render Executor variable/style binding'],
      ['Variable Report', 'scope decision gate'],
      'Existing scopes and authored identities must not be guessed or rewritten.',
    ),
    figmaToCode: direction(
      'EXACT',
      ['Design Capture binding provenance', 'scoped CSS/DTCG export'],
      ['resolved mode/value checks', 'build token reference check'],
    ),
  },
  {
    id: 'component-contracts',
    area: 'design-system',
    figmaTypes: ['ComponentNode', 'ComponentSetNode', 'InstanceNode', 'SlotNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Registry-backed instances', 'variant/property/slot Figma Commands'],
      ['component contract inspection', 'Design Contract'],
      'Design Entity identity must exist before reuse or swapping.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture definitions, overrides and slots', 'Code-Spec component facts'],
      ['Design Contract axes/properties', 'rendered state comparison'],
      'Finite Figma state axes do not imply arbitrary runtime behaviour.',
    ),
  },
  {
    id: 'source-assets',
    area: 'assets',
    figmaTypes: ['ImagePaint', 'VectorNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['local image/SVG adapters', 'Figma Render Executor asset intent'],
      ['image/vector readback', 'pixel comparison'],
      'Crop, filter and external SVG semantics must remain representable.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Asset Policy', 'asset export plus placement manifest'],
      ['assets.json coverage', 'pixel comparison'],
      'Figma-only media or shaders require an explicit web strategy.',
    ),
  },
  {
    id: 'rich-text',
    area: 'typography',
    figmaTypes: ['TextNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan rich-text runs', 'Figma Render Executor range setters'],
      ['font preflight', 'range readback'],
      'The requested font faces must exist in Figma.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture text and styled runs', 'Code-Spec typography projection'],
      ['computed browser font check', 'pixel comparison'],
      'Browser shaping and Figma shaping can differ.',
    ),
  },
  {
    id: 'masks',
    area: 'compositing',
    figmaTypes: ['MaskType', 'SceneNodeMixin'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan mask intent', 'Figma Render Executor native mask'],
      ['Structural Gate', 'mask type readback'],
      'The real mask geometry must be materialized before writing.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture mask fact', 'Code-Spec mask projection'],
      ['mask fact coverage', 'pixel comparison'],
      'CSS mask or clip-path support depends on target geometry and units.',
    ),
  },
  {
    id: 'blend-modes',
    area: 'compositing',
    figmaTypes: ['BlendMode', 'SceneNodeMixin'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan blendMode', 'Figma Render Executor native blend mode'],
      ['blend mode readback', 'pixel comparison'],
      'Stacking and isolation semantics must remain equivalent.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture blend mode', 'Code-Spec compositing projection'],
      ['computed blend check', 'pixel comparison'],
      'Figma PASS_THROUGH has no direct CSS property.',
    ),
  },
  {
    id: 'corner-and-stroke-sizing',
    area: 'geometry',
    figmaTypes: ['CornerMixin', 'AutoLayoutMixin'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan cornerSmoothing and strokes', 'Figma Render Executor native properties'],
      ['property readback', 'pixel comparison'],
      'CSS has no exact superellipse smoothing primitive.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture smoothing/stroke-layout facts', 'Code-Spec geometry projection'],
      ['fact coverage', 'pixel comparison'],
      'Corner smoothing needs an explicit web implementation strategy.',
    ),
  },
  {
    id: 'native-effects',
    area: 'effects',
    figmaTypes: ['Effect', 'NoiseEffectBase', 'TextureEffect', 'GlassEffect', 'ShaderEffect'],
    codeToFigma: direction(
      'FIGMA_ONLY',
      ['explicit Bridge JSX effect intent', 'Figma Render Executor native effects'],
      ['effect readback', 'pixel comparison'],
      'Noise, Texture, Glass and Shader are Figma-native intents rather than ordinary CSS primitives.',
    ),
    figmaToCode: direction(
      'STRUCTURAL',
      ['Design Capture full effect records', 'Code-Spec lossless effect projection'],
      ['no-unconsumed-effect check', 'pixel comparison'],
      'The target must choose a CSS structure, asset, Canvas/WebGL implementation or stop.',
    ),
  },
  {
    id: 'prototype-reactions',
    area: 'interaction',
    figmaTypes: ['Reaction', 'Trigger', 'Action'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['prototype add/set Figma Commands'],
      ['prototype inspect', 'Design Contract transition rules'],
      'Routing, application state and async handlers exceed Figma prototype actions.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture reaction records', 'Code-Spec reaction projection'],
      ['Design Contract transition rules', 'implemented behaviour tests'],
      'A prototype reaction is interaction evidence, not executable application logic.',
    ),
  },
];

const contract = deepFreeze({
  version: ROUND_TRIP_FIDELITY_VERSION,
  mappingClasses: [...ROUND_TRIP_MAPPING_CLASSES],
  facts,
});

export function roundTripFidelityContract() {
  return contract;
}

export function auditRoundTripFidelityContract(value = contract) {
  const errors = [];
  if (!Number.isInteger(value?.version) || value.version < 1) errors.push('contract version must be a positive integer');
  if (!Array.isArray(value?.facts) || !value.facts.length) errors.push('contract needs at least one fact');
  const ids = new Set();
  for (const [index, fact] of (value?.facts || []).entries()) {
    const label = fact?.id || `facts[${index}]`;
    if (!/^[a-z][a-z0-9-]*$/.test(String(fact?.id || ''))) errors.push(`${label}: id must be kebab-case`);
    if (ids.has(fact?.id)) errors.push(`${label}: duplicate fact id`);
    ids.add(fact?.id);
    if (!fact?.area) errors.push(`${label}: area is required`);
    if (!Array.isArray(fact?.figmaTypes) || !fact.figmaTypes.length) errors.push(`${label}: at least one official Figma type is required`);
    for (const side of ['codeToFigma', 'figmaToCode']) {
      const entry = fact?.[side];
      const directionLabel = `${label}.${side}`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${directionLabel}: direction is unclassified`);
        continue;
      }
      if (!ROUND_TRIP_MAPPING_CLASSES.includes(entry.classification)) {
        errors.push(`${directionLabel}: unknown mapping class ${entry.classification || '(missing)'}`);
      }
      if (!Array.isArray(entry.implementation)) errors.push(`${directionLabel}: implementation must be an array`);
      if (!Array.isArray(entry.verification)) errors.push(`${directionLabel}: verification must be an array`);
      if (EXECUTABLE_CLASSES.has(entry.classification)) {
        if (!entry.implementation?.length) errors.push(`${directionLabel}: executable mapping needs an implementation`);
        if (!entry.verification?.length) errors.push(`${directionLabel}: executable mapping needs verification`);
      }
      if (EXPLICIT_SEAM_CLASSES.has(entry.classification) && !String(entry.note || '').trim()) {
        errors.push(`${directionLabel}: explicit seam needs a reason`);
      }
    }
  }
  return deepFreeze({ ok: errors.length === 0, errors, summary: roundTripFidelitySummary(value) });
}

export function roundTripFidelitySummary(value = contract) {
  const summary = {
    version: value?.version || null,
    total: 0,
    exactBothWays: 0,
    classifiedBothWays: 0,
    explicitSeams: 0,
  };
  for (const fact of value?.facts || []) {
    summary.total++;
    const directions = [fact.codeToFigma, fact.figmaToCode];
    if (directions.every((entry) => ROUND_TRIP_MAPPING_CLASSES.includes(entry?.classification))) {
      summary.classifiedBothWays++;
    }
    if (directions.every((entry) => entry?.classification === 'EXACT')) summary.exactBothWays++;
    if (directions.some((entry) => EXPLICIT_SEAM_CLASSES.has(entry?.classification))) summary.explicitSeams++;
  }
  return deepFreeze(summary);
}

/** Agent-facing projection of the executable contract. */
export function formatRoundTripFidelityContract(value = contract) {
  const audit = auditRoundTripFidelityContract(value);
  const lines = [
    `Round-trip Fidelity Contract v${audit.summary.version}`,
    `${audit.summary.classifiedBothWays}/${audit.summary.total} core fact families classified in both directions`,
    `exact pairs: ${audit.summary.exactBothWays} · explicit seams: ${audit.summary.explicitSeams}`,
    '',
  ];
  for (const fact of value?.facts || []) {
    lines.push(`${fact.id} [${fact.area}]`);
    lines.push(`  code -> Figma: ${fact.codeToFigma.classification} · ${fact.codeToFigma.implementation.join('; ')}`);
    lines.push(`    verify: ${fact.codeToFigma.verification.join('; ')}`);
    if (fact.codeToFigma.note) lines.push(`    boundary: ${fact.codeToFigma.note}`);
    lines.push(`  Figma -> code: ${fact.figmaToCode.classification} · ${fact.figmaToCode.implementation.join('; ')}`);
    lines.push(`    verify: ${fact.figmaToCode.verification.join('; ')}`);
    if (fact.figmaToCode.note) lines.push(`    boundary: ${fact.figmaToCode.note}`);
  }
  if (!audit.ok) {
    lines.push('', 'CONTRACT INVALID:');
    for (const error of audit.errors) lines.push(`- ${error}`);
  }
  return lines.join('\n');
}
