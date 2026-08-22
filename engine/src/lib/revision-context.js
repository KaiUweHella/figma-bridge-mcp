// Stable Figma document revision Interface for multi-roundtrip read Commands.
//
// Metadata is supplied by the authenticated daemon, not by evaluated code.
// A Command pins the first connection/file/revision and rejects any drift
// before local publication can combine facts from different document states.

export function stableDocumentRevision(metadata) {
  return Boolean(
    metadata
    && typeof metadata.connectionId === 'string'
    && metadata.connectionId
    && Number.isSafeInteger(metadata.documentRevisionBefore)
    && metadata.documentRevisionBefore >= 0
    && metadata.documentRevisionBefore === metadata.documentRevisionAfter
  );
}

export function sameDocumentRevision(left, right) {
  return stableDocumentRevision(left)
    && stableDocumentRevision(right)
    && left.connectionId === right.connectionId
    && (left.fileKey || null) === (right.fileKey || null)
    && left.documentRevisionAfter === right.documentRevisionAfter;
}

function contextError(message) {
  return Object.assign(new Error(message), {
    kind: 'document-drift',
    phase: 'plugin-response',
    outcome: 'unknown-after-dispatch',
  });
}

function compareVersions(value, minimum) {
  const left = typeof value === 'string'
    ? value.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
    : null;
  const right = typeof minimum === 'string'
    ? minimum.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
    : null;
  if (!left || !right || left.some((part) => !Number.isSafeInteger(part))
    || right.some((part) => !Number.isSafeInteger(part))) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function stableConnection(metadata) {
  return Boolean(metadata && typeof metadata.connectionId === 'string' && metadata.connectionId);
}

function sameConnection(left, right) {
  return stableConnection(left) && stableConnection(right)
    && left.connectionId === right.connectionId
    && (left.fileKey || null) === (right.fileKey || null);
}

/** Pin and validate the source of a sequence of authenticated read evals. */
export function createRevisionContext({
  expectedFileKey = null,
  revisionRequiredFromPluginVersion = '3.3.6',
} = {}) {
  let pinned = null;

  return Object.freeze({
    accept(metadata, role = 'Figma read') {
      const changed = Number.isSafeInteger(metadata?.documentRevisionBefore)
        && Number.isSafeInteger(metadata?.documentRevisionAfter)
        && metadata.documentRevisionBefore !== metadata.documentRevisionAfter;
      if (changed) {
        throw contextError(
          `Figma document changed during ${role}; the existing workspace output was left unchanged. Retry from the new revision.`,
        );
      }
      if (!stableConnection(metadata)) {
        throw contextError(
          `Figma Bridge could not prove a stable connection during ${role}; reconnect the plugin, then retry.`,
        );
      }
      if (expectedFileKey && metadata.fileKey !== expectedFileKey) {
        throw contextError(
          `Figma target changed during ${role}: expected file ${expectedFileKey}, received ${metadata.fileKey || '(unidentified)'}.`,
        );
      }
      const revisionStable = stableDocumentRevision(metadata);
      const versionComparison = compareVersions(
        metadata.pluginVersion,
        revisionRequiredFromPluginVersion,
      );
      // Compatibility is intentionally closed: only a syntactically valid,
      // provably older plugin may use the bounded connection-only proof.
      if (!revisionStable && !(versionComparison !== null && versionComparison < 0)) {
        throw contextError(
          `Figma Bridge plugin ${metadata.pluginVersion || '(unknown)'} did not provide the required document revision during ${role}; reconnect or re-import the plugin, then retry.`,
        );
      }
      if (pinned && (!sameConnection(pinned, metadata)
        || (pinned.proof === 'document-revision' && !sameDocumentRevision(pinned, metadata)))) {
        throw contextError(
          `Figma connection or document revision changed during ${role}; the existing workspace output was left unchanged. Retry the export.`,
        );
      }
      if (!pinned) {
        pinned = Object.freeze({
          connectionId: metadata.connectionId,
          fileKey: metadata.fileKey || null,
          pluginVersion: metadata.pluginVersion || null,
          proof: revisionStable ? 'document-revision' : 'connection-only',
          documentRevisionBefore: revisionStable ? metadata.documentRevisionBefore : null,
          documentRevisionAfter: revisionStable ? metadata.documentRevisionAfter : null,
        });
      }
      return pinned;
    },

    targetFileKey() {
      return pinned?.fileKey || expectedFileKey || null;
    },

    source() {
      return pinned;
    },
  });
}
