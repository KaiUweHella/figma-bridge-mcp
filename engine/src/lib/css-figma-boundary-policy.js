/** Project-wide, reviewed CSS <-> Figma boundary decisions.
 *
 * These values are deliberately stable identifiers: they are emitted in
 * diagnostics, stored in round-trip provenance and may be approved by the
 * structural gate. Renaming one is a migration, not a copy edit.
 */
export const CSS_FIGMA_BOUNDARY_STRATEGIES = Object.freeze({
  minmax: 'minmax.native-grid',
  spaceAround: 'space-around.equal-slots',
  perSideBorderPaints: 'border.single-paint-native',
  sticky: 'sticky.metadata-only',
  filterChains: 'filters.layer-stack',
  complexMasks: 'masks.vector-mask',
  variableFontAxes: 'font.named-faces',
  figmaOnlyEffects: 'figma-effects.native',
});

/** Reviewed deterministic conversions that may pass without a per-render
 * prompt. Font axes and masks are intentionally absent: both require source-
 * specific evidence or a user choice before a write. */
export const DEFAULT_APPROVED_FALLBACKS = Object.freeze([
  CSS_FIGMA_BOUNDARY_STRATEGIES.minmax,
  CSS_FIGMA_BOUNDARY_STRATEGIES.spaceAround,
  CSS_FIGMA_BOUNDARY_STRATEGIES.perSideBorderPaints,
  CSS_FIGMA_BOUNDARY_STRATEGIES.sticky,
  CSS_FIGMA_BOUNDARY_STRATEGIES.filterChains,
]);

/** Visible, opt-in notes for reviewed conversions that intentionally lose
 * authored CSS information. Equivalent native mappings (for example
 * space-around.equal-slots) stay out of this catalog to avoid annotation
 * noise in otherwise faithful Figma output. */
export const CSS_FIGMA_FALLBACK_ANNOTATIONS = Object.freeze({
  [CSS_FIGMA_BOUNDARY_STRATEGIES.perSideBorderPaints]: Object.freeze({
    labelMarkdown: '**CSS → Figma Fallback**\n\nFigma unterstützt unterschiedliche Border-Farben je Seite nicht als einen einzelnen nativen Stroke. Deshalb wird die erste gesetzte CSS-Seitenfarbe für alle Seiten verwendet; die individuellen Border-Breiten bleiben erhalten.\n\n`border.single-paint-native`',
    properties: Object.freeze(['strokes', 'strokeWeight']),
  }),
});

export function cssFigmaFallbackAnnotationIntent(finding) {
  const policy = CSS_FIGMA_FALLBACK_ANNOTATIONS[finding?.fallback];
  if (!policy) return null;
  return {
    policy: String(finding.fallback),
    fact: String(finding.fact || finding.fallback),
    labelMarkdown: policy.labelMarkdown,
    properties: [...policy.properties],
  };
}

export function cssFigmaFallbackAnnotationIntents(diagnostics) {
  const intents = [];
  const seen = new Set();
  for (const finding of diagnostics?.classifiedFallbacks || []) {
    const annotation = cssFigmaFallbackAnnotationIntent(finding);
    if (!annotation || !finding?.path) continue;
    const key = `${finding.path}\0${finding.fallback}`;
    if (seen.has(key)) continue;
    seen.add(key);
    intents.push({
      path: String(finding.path),
      ...annotation,
    });
  }
  return intents;
}
