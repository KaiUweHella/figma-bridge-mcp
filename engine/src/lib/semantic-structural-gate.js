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
  const check = (id, findings, { deferred = false } = {}) => {
    const status = findings.length === 0 ? 'PASS' : deferred ? 'DEFERRED' : 'FAIL';
    return { id, status, passed: status !== 'FAIL', count: findings.length, findings };
  };
  const checks = [
    check('semantic-model', unclassified),
    check('native-layout', unsupportedLayouts),
    check('free-layout', unapprovedFree),
    check('absolute-intent', absoluteMismatches),
    // This audit is deliberately offline. A var: reference without a literal
    // fallback is neither resolved nor failed here; the native executor owns
    // exact live Collection/Variable resolution before its first canvas write.
    check('token-provenance', tokenWithoutValue, { deferred: true }),
    check('resolved-icons', unresolvedIcons),
    check('approved-fallbacks', unapprovedFallbacks),
  ];
  const status = checks.some((entry) => entry.status === 'FAIL')
    ? 'FAIL'
    : checks.some((entry) => entry.status === 'DEFERRED') ? 'DEFERRED' : 'PASS';
  return {
    version: 1,
    status,
    passed: status !== 'FAIL',
    summary: { nodes, containers, grids, autoLayouts: flex, freeLayouts: free, absoluteNodes: absolute, tokenReferences: tokens },
    checks,
  };
}

export function formatStructuralGate(report) {
  const status = report.status || (report.passed ? 'PASS' : 'FAIL');
  const lines = [`Structural gate: ${status}`];
  const labels = {
    'semantic-model': 'no unclassified semantic facts',
    'native-layout': 'all containers have a supported native layout',
    'free-layout': 'all free-layout containers are explicitly approved',
    'absolute-intent': 'all absolute nodes originate from source intent',
    'token-provenance': 'authored tokens have a literal value or defer to live resolution',
    'resolved-icons': 'all icon roles resolve to vector/component assets',
    'approved-fallbacks': 'all structural fallbacks are explicitly approved',
  };
  for (const check of report.checks) {
    const checkStatus = check.status || (check.passed ? 'PASS' : 'FAIL');
    const marker = checkStatus === 'PASS' ? '✓' : checkStatus === 'DEFERRED' ? '…' : '✗';
    lines.push(`${marker} ${labels[check.id]}${checkStatus === 'PASS' ? '' : ` (${check.count}; ${checkStatus})`}`);
    if (checkStatus !== 'PASS') {
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
  if (report.checks.some((check) => check.status === 'DEFERRED')) {
    lines.push('Live Figma Variable preflight required before render; unresolved explicit token intent still fails before the first canvas write.');
  }
  lines.push(`Summary: ${s.nodes} nodes, ${s.grids} Grid, ${s.autoLayouts} Auto Layout, ${s.freeLayouts} free, ${s.absoluteNodes} absolute, ${s.tokenReferences} authored tokens`);
  return lines.join('\n');
}
