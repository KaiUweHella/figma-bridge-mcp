// Report-only three-way planning for one Design Entity.
//
// The accepted baseline records independent code and Figma fingerprints. The
// planner never guesses semantic equivalence between those two representations;
// it only asks which side moved since the last state a human accepted.
import { createHash } from 'node:crypto';

export const ROUND_TRIP_BASELINE_VERSION = 1;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Exact file fingerprint. Export identity is included; source bytes are not persisted. */
export function fingerprintCodeSource({ path, exportName = null, content }) {
  if (typeof path !== 'string' || !path) throw new Error('Code fingerprint requires a source path.');
  if (typeof content !== 'string') throw new Error(`Code source could not be read: ${path}`);
  return {
    hash: sha256(JSON.stringify({ path, exportName: exportName || null, content })),
    bytes: Buffer.byteLength(content),
  };
}

/** Canonical subtree fingerprint from normalizeSnapshot(). */
export function fingerprintFigmaSnapshot(snapshot) {
  const root = snapshot?.nodes?.find((node) => node.id === snapshot.rootId)
    || snapshot?.nodes?.[0];
  if (!root?.subtreeHash) throw new Error('Figma fingerprint requires a complete normalized subtree.');
  return { hash: root.subtreeHash, nodeCount: snapshot.nodeCount };
}

export function acceptedRoundTripBaseline(code, figma, acceptedAt = new Date().toISOString()) {
  return {
    version: ROUND_TRIP_BASELINE_VERSION,
    acceptedAt,
    code: { hash: code.hash },
    figma: { hash: figma.hash },
  };
}

/**
 * Three-way decision table. This Module is deliberately report-only: no status
 * implies permission to mutate either adapter.
 */
export function planRoundTrip({ code, figma, baseline }) {
  if (!baseline?.code?.hash || !baseline?.figma?.hash) {
    return {
      status: 'untracked', codeChanged: null, figmaChanged: null,
      summary: 'No accepted baseline. Verify both sides, then accept their current state.',
    };
  }
  const codeChanged = code.hash !== baseline.code.hash;
  const figmaChanged = figma.hash !== baseline.figma.hash;
  if (!codeChanged && !figmaChanged) {
    return { status: 'unchanged', codeChanged, figmaChanged, summary: 'Code and Figma still match the accepted baseline.' };
  }
  if (codeChanged && !figmaChanged) {
    return { status: 'code-only', codeChanged, figmaChanged, summary: 'Only code changed since the accepted baseline.' };
  }
  if (!codeChanged && figmaChanged) {
    return { status: 'figma-only', codeChanged, figmaChanged, summary: 'Only Figma changed since the accepted baseline.' };
  }
  return {
    status: 'conflict', codeChanged, figmaChanged,
    summary: 'Code and Figma both changed since the accepted baseline. Do not overwrite either side.',
  };
}

export function nextReadsForRoundTrip(plan, entity) {
  const nodeId = entity?.figma?.nodeId || '<nodeId>';
  const source = entity?.code?.path || '<source>';
  switch (plan.status) {
    case 'figma-only':
      return [`figma_spec ${nodeId} (structure, then style)`, source, 'Implement the reviewed Figma delta in the existing code export.'];
    case 'code-only':
      return [source, `figma_screenshot ${nodeId}`, `figma_spec ${nodeId} only if Figma should receive the code delta.`];
    case 'conflict':
      return [source, `figma_spec ${nodeId} (structure and style)`, 'Resolve explicitly; do not push either side automatically.'];
    case 'untracked':
      return [
        source,
        `figma_spec ${nodeId}`,
        entity?.kind === 'screen'
          ? `After visual verification: link accept ${entity?.id || '<entityId>'} --compare <browser.png> --max-diff 5`
          : `After visual verification: link accept ${entity?.id || '<entityId>'}`,
      ];
    default:
      return [source, `figma_spec ${nodeId} on demand; no sync work is currently required.`];
  }
}

export function formatRoundTripPlan(entity, plan, { baseline = null } = {}) {
  const lines = [
    `${entity.id}  [${entity.kind}]`,
    `round-trip: ${plan.status}`,
    `code:  ${entity.code?.path || '(not linked)'}${entity.code?.export ? `#${entity.code.export}` : ''}`,
    `figma: ${entity.figma?.nodeId || '(not linked)'}`,
    `result: ${plan.summary}`,
  ];
  if (baseline?.acceptedAt) lines.push(`baseline accepted: ${baseline.acceptedAt}`);
  if (baseline?.visual && Number.isFinite(Number(baseline.visual.diffPct))) {
    lines.push(`visual proof: ${baseline.visual.diffPct}% diff (maximum ${baseline.visual.maxDiff}%)`);
  }
  lines.push('', 'Next reads:');
  for (const read of nextReadsForRoundTrip(plan, entity)) lines.push(`  - ${read}`);
  return lines.join('\n');
}

/** Small progressive projection; callers do not need to understand Registry shape. */
export function projectDesignContext({ entity, plan, projectFiles = {} }) {
  return {
    entity: {
      id: entity.id,
      kind: entity.kind,
      code: entity.code || {},
      storybook: entity.storybook || {},
      figma: entity.figma || {},
    },
    roundTrip: plan,
    projectFiles,
    nextReads: nextReadsForRoundTrip(plan, entity),
  };
}

export function formatProjectDesignContext(context) {
  const { entity, roundTrip, projectFiles, nextReads } = context;
  const lines = [
    `Project Design Context — ${entity.id} [${entity.kind}]`,
    `sync: ${roundTrip.status} — ${roundTrip.summary}`,
    '',
    'Links:',
    `  code: ${entity.code?.path || '(not linked)'}${entity.code?.export ? `#${entity.code.export}` : ''}`,
    `  figma: ${entity.figma?.nodeId || '(not linked)'}${entity.figma?.fileKey ? ` in ${entity.figma.fileKey}` : ''}`,
    `  story: ${entity.storybook?.storyId || '(not linked)'}`,
  ];
  if (Object.keys(projectFiles || {}).length) {
    lines.push('', 'Project design files:');
    for (const [role, path] of Object.entries(projectFiles)) lines.push(`  ${role}: ${path}`);
  }
  lines.push('', 'Exact next reads:');
  for (const read of nextReads) lines.push(`  - ${read}`);
  return lines.join('\n');
}
