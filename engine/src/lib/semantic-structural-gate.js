import { DEFAULT_APPROVED_FALLBACKS } from './css-figma-boundary-policy.js';

const walk = (node, visit) => {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
};

const approved = (finding, approvals) => approvals.some((value) =>
  value === finding.fallback || value === finding.path || value === `${finding.path}:${finding.fallback}`);

/** Acceptance-oriented audit of the canonical semantic UI model.
 *
 * This is deliberately stricter than rendering: a classified fallback may be
 * rendered for review, but it does not pass acceptance unless its exact
 * fallback class/path was approved by the caller. */
export function auditSemanticStructure(model, {
  approvedFallbacks = [],
  allowedFreePaths = [],
} = {}) {
  if (!model?.root || !model?.diagnostics) throw new Error('Invalid semantic model');
  const diagnostics = model.diagnostics;
  const unsupportedLayouts = [];
  const unapprovedFree = [];
  const absoluteMismatches = [];
  const tokenWithoutValue = [];
  let nodes = 0, containers = 0, grids = 0, flex = 0, free = 0, absolute = 0, tokens = 0;

  walk(model.root, (node) => {
    nodes++;
    const kind = node.layout?.kind || 'unsupported';
    if (kind !== 'leaf') containers++;
    if (kind === 'grid') grids++;
    else if (kind === 'flex' || kind === 'flow') flex++;
    else if (kind === 'free') {
      free++;
      if (!allowedFreePaths.includes(node.path)) unapprovedFree.push(node.path);
    } else if (!['leaf'].includes(kind)) unsupportedLayouts.push({ path: node.path, kind });

    if (node.positioning?.kind === 'absolute') {
      absolute++;
      const sourceAbsolute = node.source?.kind === 'jsx'
        ? node.source.props?.position === 'absolute'
        : ['absolute', 'fixed'].includes(node.source?.style?.position);
      if (!sourceAbsolute) absoluteMismatches.push(node.path);
    }
    if (node.paint?.background?.token) {
      tokens++;
      if (!node.paint.background.value) tokenWithoutValue.push(node.path);
    }
  });

  const unclassified = diagnostics.unclassifiedFallbacks || [];
  const unresolvedIcons = diagnostics.unresolvedIcons || [];
  const effectiveApprovals = [...DEFAULT_APPROVED_FALLBACKS, ...approvedFallbacks];
  const unapprovedFallbacks = (diagnostics.classifiedFallbacks || [])
    .filter((finding) => !approved(finding, effectiveApprovals));
  const checks = [
    { id: 'semantic-model', passed: unclassified.length === 0, count: unclassified.length, findings: unclassified },
    { id: 'native-layout', passed: unsupportedLayouts.length === 0, count: unsupportedLayouts.length, findings: unsupportedLayouts },
    { id: 'free-layout', passed: unapprovedFree.length === 0, count: unapprovedFree.length, findings: unapprovedFree },
    { id: 'absolute-intent', passed: absoluteMismatches.length === 0, count: absoluteMismatches.length, findings: absoluteMismatches },
    { id: 'token-provenance', passed: tokenWithoutValue.length === 0, count: tokenWithoutValue.length, findings: tokenWithoutValue },
    { id: 'resolved-icons', passed: unresolvedIcons.length === 0, count: unresolvedIcons.length, findings: unresolvedIcons },
    { id: 'approved-fallbacks', passed: unapprovedFallbacks.length === 0, count: unapprovedFallbacks.length, findings: unapprovedFallbacks },
  ];
  return {
    version: 1,
    passed: checks.every((check) => check.passed),
    summary: { nodes, containers, grids, autoLayouts: flex, freeLayouts: free, absoluteNodes: absolute, tokenReferences: tokens },
    checks,
  };
}

export function formatStructuralGate(report) {
  const lines = [`Structural gate: ${report.passed ? 'PASS' : 'FAIL'}`];
  const labels = {
    'semantic-model': 'no unclassified semantic facts',
    'native-layout': 'all containers have a supported native layout',
    'free-layout': 'all free-layout containers are explicitly approved',
    'absolute-intent': 'all absolute nodes originate from source intent',
    'token-provenance': 'all authored tokens carry a resolvable source value',
    'resolved-icons': 'all icon roles resolve to vector/component assets',
    'approved-fallbacks': 'all structural fallbacks are explicitly approved',
  };
  for (const check of report.checks) {
    lines.push(`${check.passed ? '✓' : '✗'} ${labels[check.id]}${check.passed ? '' : ` (${check.count})`}`);
    if (!check.passed) {
      for (const finding of check.findings.slice(0, 5)) {
        lines.push(`  - ${typeof finding === 'string' ? finding : `${finding.path}: ${finding.fact || finding.kind || finding.fallback}`}`);
      }
    }
  }
  const s = report.summary;
  const fontFindings = report.checks
    .flatMap((check) => check.findings || [])
    .filter((finding) => finding?.fallback === 'font.named-faces');
  if (fontFindings.length) {
    lines.push('Decision required before render: install the requested variable font, or approve a currently available named face. Exact variation-axis values cannot be written through the current Figma Plugin API.');
  }
  lines.push(`Summary: ${s.nodes} nodes, ${s.grids} Grid, ${s.autoLayouts} Auto Layout, ${s.freeLayouts} free, ${s.absoluteNodes} absolute, ${s.tokenReferences} authored tokens`);
  return lines.join('\n');
}
