const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Coupled Render verification follows a mutation immediately. Figma can expose
 * final node dimensions before native Grid/image rendering has crossed a paint
 * boundary, so wait for two consecutive stable geometry samples. The loop is
 * deliberately bounded to five 20ms intervals and never runs for standalone
 * screenshot reads.
 */
export function verificationLayoutSettleCode(nodeIdentifier = 'node') {
  if (!IDENTIFIER.test(nodeIdentifier)) throw new TypeError('Verification settle node must be an identifier');
  return `
    let figmaBridgePreviousLayout = '';
    let figmaBridgeStableLayoutSamples = 0;
    for (let figmaBridgeSettleAttempt = 0; figmaBridgeSettleAttempt < 5; figmaBridgeSettleAttempt++) {
      const figmaBridgeChildren = 'children' in ${nodeIdentifier} ? ${nodeIdentifier}.children : [];
      const figmaBridgeLayout = [${nodeIdentifier}.width, ${nodeIdentifier}.height, figmaBridgeChildren.length]
        .concat(Array.from(figmaBridgeChildren).slice(0, 64).flatMap((child) => [child.width, child.height]))
        .join('|');
      if (figmaBridgeLayout === figmaBridgePreviousLayout) figmaBridgeStableLayoutSamples++;
      else figmaBridgeStableLayoutSamples = 0;
      figmaBridgePreviousLayout = figmaBridgeLayout;
      if (figmaBridgeStableLayoutSamples >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }`;
}

/** Export a bounded series after the layout settle and retain the richest PNG.
 * A freshly mutated Figma node can briefly export a valid same-size PNG that
 * contains only its root background. Byte length is used only to select among
 * exports of the same node, dimensions and scale; it is not a fidelity score. */
export function verificationPngExportCode(nodeIdentifier = 'node', scaleIdentifier = 'appliedScale') {
  if (!IDENTIFIER.test(scaleIdentifier)) throw new TypeError('Verification export scale must be an identifier');
  return `${verificationLayoutSettleCode(nodeIdentifier)}
    let bytes = null;
    let figmaBridgeBestPngBytes = -1;
    let figmaBridgeStablePngSamples = 0;
    for (let figmaBridgeExportAttempt = 0; figmaBridgeExportAttempt < 5; figmaBridgeExportAttempt++) {
      const figmaBridgeCandidatePng = await ${nodeIdentifier}.exportAsync({
        format: 'PNG', constraint: { type: 'SCALE', value: ${scaleIdentifier} },
      });
      if (figmaBridgeCandidatePng.length > figmaBridgeBestPngBytes) {
        bytes = figmaBridgeCandidatePng;
        figmaBridgeBestPngBytes = figmaBridgeCandidatePng.length;
        figmaBridgeStablePngSamples = 0;
      } else if (figmaBridgeCandidatePng.length === figmaBridgeBestPngBytes) {
        figmaBridgeStablePngSamples++;
      }
      if (figmaBridgeExportAttempt >= 2 && figmaBridgeStablePngSamples >= 1) break;
      if (figmaBridgeExportAttempt < 4) await new Promise((resolve) => setTimeout(resolve, 50));
    }`;
}
