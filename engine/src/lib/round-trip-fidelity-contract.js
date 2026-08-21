// Executable Round-trip Fidelity Contract.
//
// This Module classifies core Figma fact families across both directions. It
// does not replace Design Capture, Semantic Render Plans or their Adapters;
// it makes their relationship explicit and fail-closed. A writer existing in
// one direction is never evidence that the reverse projection is complete.

export const ROUND_TRIP_FIDELITY_VERSION = 2;

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
const VERIFICATION_EVIDENCE_ID = /^verification\.[a-z][a-z0-9-]*$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const evidenceRegistry = deepFreeze({
  'verification.structural-report': {
    kind: 'gate',
    label: 'Structural Report',
    source: 'engine/src/lib/structured-render-executor.js',
  },
  'verification.layer-coverage': {
    kind: 'check',
    label: 'layer coverage',
    source: 'engine/src/lib/code-spec.js',
  },
  'verification.pixel-comparison': {
    kind: 'probe',
    label: 'pixel comparison',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.structural-gate': {
    kind: 'gate',
    label: 'Structural Gate',
    source: 'engine/src/lib/structured-render-executor.js',
  },
  'verification.responsive-probes': {
    kind: 'probe',
    label: 'resize and pixel probes',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.layout-provenance': {
    kind: 'check',
    label: 'layout provenance checks',
    source: 'engine/src/design-extract.js',
  },
  'verification.variable-report': {
    kind: 'check',
    label: 'Variable Report',
    source: 'engine/src/lib/structured-render-executor.js',
  },
  'verification.variable-scope-gate': {
    kind: 'gate',
    label: 'scope decision gate',
    source: 'engine/src/lib/variable-management.js',
  },
  'verification.selected-mode-value-check': {
    kind: 'test',
    label: 'selected mode/value checks',
    source: 'engine/tests/scoped-tokens.test.js',
  },
  'verification.build-token-reference-check': {
    kind: 'check',
    label: 'build token reference check',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.mode-write-readback': {
    kind: 'test',
    label: 'mode write/readback checks',
    source: 'engine/tests/variable-management.test.js',
  },
  'verification.multi-mode-token-projection': {
    kind: 'test',
    label: 'per-mode alias/value preservation and named CSS mode scopes',
    source: 'engine/tests/scoped-tokens.test.js',
  },
  'verification.component-contract-inspection': {
    kind: 'check',
    label: 'component contract inspection',
    source: 'engine/src/lib/code-spec.js',
  },
  'verification.component-state-lattice': {
    kind: 'gate',
    label: 'defined, noneDefined, or notCaptured component-state gate',
    source: 'engine/src/application/code-spec-command.js',
  },
  'verification.design-contract': {
    kind: 'check',
    label: 'Design Contract',
    source: 'engine/src/lib/design-contract.js',
  },
  'verification.design-contract-axes-properties': {
    kind: 'test',
    label: 'Design Contract axes/properties',
    source: 'engine/tests/component-sets.test.js',
  },
  'verification.rendered-state-comparison': {
    kind: 'probe',
    label: 'rendered state comparison',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.image-vector-readback': {
    kind: 'test',
    label: 'image/vector readback',
    source: 'engine/tests/assets.test.js',
  },
  'verification.asset-manifest-coverage': {
    kind: 'check',
    label: 'asset manifest coverage',
    source: 'engine/src/lib/asset-manifest.js',
  },
  'verification.asset-manifest-v2': {
    kind: 'gate',
    label: 'Manifest v2 identity and filename reservation plan',
    source: 'engine/src/lib/asset-manifest.js',
  },
  'verification.asset-digest-integrity': {
    kind: 'check',
    label: 'physical asset digest verification',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.font-preflight': {
    kind: 'gate',
    label: 'font preflight',
    source: 'engine/src/lib/structured-render-executor.js',
  },
  'verification.rich-text-range-readback': {
    kind: 'test',
    label: 'range readback',
    source: 'engine/tests/code-spec.test.js',
  },
  'verification.browser-font-check': {
    kind: 'probe',
    label: 'computed browser font check',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.visibility-readback': {
    kind: 'test',
    label: 'visibility readback',
    source: 'engine/tests/structured-render-executor.test.js',
  },
  'verification.hidden-content-census': {
    kind: 'check',
    label: 'hidden-content census and exact-content completeness check',
    source: 'engine/src/lib/code-spec.js',
  },
  'verification.mask-type-readback': {
    kind: 'test',
    label: 'mask type readback',
    source: 'engine/tests/code-spec.test.js',
  },
  'verification.mask-fact-coverage': {
    kind: 'check',
    label: 'mask fact coverage',
    source: 'engine/src/lib/code-spec.js',
  },
  'verification.blend-mode-readback': {
    kind: 'test',
    label: 'blend mode readback',
    source: 'engine/tests/code-spec.test.js',
  },
  'verification.browser-blend-check': {
    kind: 'probe',
    label: 'computed blend check',
    source: 'engine/src/lib/verify-build.js',
  },
  'verification.property-readback': {
    kind: 'check',
    label: 'property readback',
    source: 'engine/src/design-extract.js',
  },
  'verification.fact-coverage': {
    kind: 'check',
    label: 'fact coverage',
    source: 'engine/src/lib/code-spec.js',
  },
  'verification.effect-readback': {
    kind: 'test',
    label: 'effect readback',
    source: 'engine/tests/code-spec.test.js',
  },
  'verification.unconsumed-effect-check': {
    kind: 'check',
    label: 'no-unconsumed-effect check',
    source: 'engine/src/lib/code-spec.js',
  },
  'verification.prototype-inspection': {
    kind: 'check',
    label: 'prototype inspect',
    source: 'engine/src/lib/prototype-management.js',
  },
  'verification.design-contract-transition-rules': {
    kind: 'check',
    label: 'Design Contract transition rules',
    source: 'engine/src/lib/design-contract.js',
  },
  'verification.implemented-behaviour-test': {
    kind: 'test',
    label: 'implemented behaviour tests',
    source: 'engine/tests/prototype-management.test.js',
  },
});

export function roundTripFidelityEvidenceRegistry() {
  return evidenceRegistry;
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
      ['verification.structural-report', 'verification.pixel-comparison'],
    ),
    figmaToCode: direction(
      'EXACT',
      ['Design Capture hierarchy and geometry', 'Code-Spec tree/structured projection'],
      ['verification.layer-coverage', 'verification.pixel-comparison'],
    ),
  },
  {
    id: 'layout-sizing',
    area: 'layout',
    figmaTypes: ['AutoLayoutMixin', 'FrameNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan Auto Layout/Grid intent', 'Figma Render Executor sizing bindings'],
      ['verification.structural-gate', 'verification.responsive-probes'],
      'Browser intrinsic sizing exceeds Figma HUG/FILL semantics.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture authored/inferred/geometry provenance', 'Code-Spec layout projection'],
      ['verification.layout-provenance', 'verification.responsive-probes'],
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
      ['verification.variable-report', 'verification.variable-scope-gate'],
      'Existing scopes and authored identities must not be guessed or rewritten.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture binding provenance', 'scoped CSS/DTCG export'],
      ['verification.multi-mode-token-projection', 'verification.build-token-reference-check'],
      'Every collection mode is preserved; target code must still activate the intended named mode scope.',
    ),
  },
  {
    id: 'variable-modes',
    area: 'design-system',
    figmaTypes: ['Variable', 'VariableCollection'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['token import/sync collection modes'],
      ['verification.mode-write-readback'],
      'Mode identities and aliases must be explicit in the source contract.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['lossless valuesByMode projection', 'DTCG mode extension', 'named CSS mode scopes'],
      ['verification.multi-mode-token-projection'],
      'DTCG retains every mode and per-mode alias; CSS emits explicit scopes and never infers fluid clamp semantics.',
    ),
  },
  {
    id: 'component-contracts',
    area: 'design-system',
    figmaTypes: ['ComponentNode', 'ComponentSetNode', 'InstanceNode', 'SlotNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Registry-backed instances', 'variant/property/slot Figma Commands'],
      ['verification.component-contract-inspection', 'verification.design-contract'],
      'Design Entity identity must exist before reuse or swapping.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture definitions, overrides and slots', 'Code-Spec component facts'],
      ['verification.design-contract-axes-properties', 'verification.rendered-state-comparison'],
      'Finite Figma state axes do not imply arbitrary runtime behaviour.',
    ),
  },
  {
    id: 'component-state-coverage',
    area: 'design-system',
    figmaTypes: ['ComponentSetNode', 'InstanceNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['variant/property Figma Commands', 'Registry-backed component-set identity'],
      ['verification.component-contract-inspection'],
      'State axes require an explicit component-set identity and a finite variant contract.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture identity-keyed component-set facts', 'Code-Spec component-state coverage lattice'],
      ['verification.component-state-lattice'],
      'State, Status, Interaction and Boolean conventions are normalized; unavailable set facts block style projection and require a set-id batch capture.',
    ),
  },
  {
    id: 'source-assets',
    area: 'assets',
    figmaTypes: ['ImagePaint', 'VectorNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['local image/SVG adapters', 'Figma Render Executor asset intent'],
      ['verification.image-vector-readback', 'verification.pixel-comparison'],
      'Crop, filter and external SVG semantics must remain representable.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Asset Policy', 'asset export plus placement manifest'],
      ['verification.asset-manifest-coverage', 'verification.pixel-comparison'],
      'Figma-only media or shaders require an explicit web strategy.',
    ),
  },
  {
    id: 'asset-identity',
    area: 'assets',
    figmaTypes: ['ImagePaint', 'VectorNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['explicit source asset intent', 'Figma Render Executor prepared resources'],
      ['verification.image-vector-readback'],
      'Stable reuse requires an explicit Design Entity, source key or content identity rather than a semantic label.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Asset Export Plan', 'Manifest v2 identity, digest, filename and placements'],
      ['verification.asset-manifest-v2', 'verification.asset-digest-integrity'],
      'Image hashes and explicit Design Entities are durable source identities; unlinked vectors fall back to content identity, never node-id identity.',
    ),
  },
  {
    id: 'rich-text',
    area: 'typography',
    figmaTypes: ['TextNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan rich-text runs', 'Figma Render Executor range setters'],
      ['verification.font-preflight', 'verification.rich-text-range-readback'],
      'The requested font faces must exist in Figma.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture text and styled runs', 'Code-Spec typography projection'],
      ['verification.browser-font-check', 'verification.pixel-comparison'],
      'Browser shaping and Figma shaping can differ.',
    ),
  },
  {
    id: 'hidden-content-and-alternate-states',
    area: 'content',
    figmaTypes: ['SceneNode', 'TextNode'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan visibility intent', 'Figma Render Executor native visibility'],
      ['verification.visibility-readback'],
      'Hidden authored content must remain intentional and must not become visible application output.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture hidden-content census', 'Code-Spec hidden-content completeness check', 'Design Capture includeHidden option'],
      ['verification.hidden-content-census'],
      'Visible output stays phantom-free by default; exact hidden content and alternate states require an explicit includeHidden inspection.',
    ),
  },
  {
    id: 'masks',
    area: 'compositing',
    figmaTypes: ['MaskType', 'SceneNodeMixin'],
    codeToFigma: direction(
      'CONDITIONAL',
      ['Semantic Render Plan mask intent', 'Figma Render Executor native mask'],
      ['verification.structural-gate', 'verification.mask-type-readback'],
      'The real mask geometry must be materialized before writing.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture mask fact', 'Code-Spec mask projection'],
      ['verification.mask-fact-coverage', 'verification.pixel-comparison'],
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
      ['verification.blend-mode-readback', 'verification.pixel-comparison'],
      'Stacking and isolation semantics must remain equivalent.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture blend mode', 'Code-Spec compositing projection'],
      ['verification.browser-blend-check', 'verification.pixel-comparison'],
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
      ['verification.property-readback', 'verification.pixel-comparison'],
      'CSS has no exact superellipse smoothing primitive.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture smoothing/stroke-layout facts', 'Code-Spec geometry projection'],
      ['verification.fact-coverage', 'verification.pixel-comparison'],
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
      ['verification.effect-readback', 'verification.pixel-comparison'],
      'Noise, Texture, Glass and Shader are Figma-native intents rather than ordinary CSS primitives.',
    ),
    figmaToCode: direction(
      'STRUCTURAL',
      ['Design Capture full effect records', 'Code-Spec lossless effect projection'],
      ['verification.unconsumed-effect-check', 'verification.pixel-comparison'],
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
      ['verification.prototype-inspection', 'verification.design-contract-transition-rules'],
      'Routing, application state and async handlers exceed Figma prototype actions.',
    ),
    figmaToCode: direction(
      'CONDITIONAL',
      ['Design Capture reaction records', 'Code-Spec reaction projection'],
      ['verification.design-contract-transition-rules', 'verification.implemented-behaviour-test'],
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
      for (const evidenceId of entry.verification || []) {
        if (!VERIFICATION_EVIDENCE_ID.test(evidenceId)) {
          errors.push(`${directionLabel}: verification must use stable Evidence IDs, received ${String(evidenceId)}`);
        } else if (!evidenceRegistry[evidenceId]) {
          errors.push(`${directionLabel}: unknown verification Evidence ID ${evidenceId}`);
        }
      }
      if (EXECUTABLE_CLASSES.has(entry.classification)) {
        if (!entry.implementation?.length) errors.push(`${directionLabel}: executable mapping needs an implementation`);
        if (!entry.verification?.length) errors.push(`${directionLabel}: executable mapping needs verification`);
      }
      if (entry.classification === 'EXACT'
        && !entry.verification?.every((evidenceId) => VERIFICATION_EVIDENCE_ID.test(evidenceId) && evidenceRegistry[evidenceId])) {
        errors.push(`${directionLabel}: EXACT mapping needs registered verification Evidence IDs`);
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
    lines.push(`    verify: ${formatVerification(fact.codeToFigma.verification)}`);
    if (fact.codeToFigma.note) lines.push(`    boundary: ${fact.codeToFigma.note}`);
    lines.push(`  Figma -> code: ${fact.figmaToCode.classification} · ${fact.figmaToCode.implementation.join('; ')}`);
    lines.push(`    verify: ${formatVerification(fact.figmaToCode.verification)}`);
    if (fact.figmaToCode.note) lines.push(`    boundary: ${fact.figmaToCode.note}`);
  }
  if (!audit.ok) {
    lines.push('', 'CONTRACT INVALID:');
    for (const error of audit.errors) lines.push(`- ${error}`);
  }
  return lines.join('\n');
}

function formatVerification(ids) {
  return ids.map((id) => {
    const evidence = evidenceRegistry[id];
    return evidence ? `${evidence.label} [${id}]` : id;
  }).join('; ');
}
