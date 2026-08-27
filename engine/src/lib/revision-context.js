// Stable Figma Revision Observation Interface for multi-roundtrip read Commands.
//
// Metadata is supplied by the authenticated daemon, not by evaluated code.
// A Command pins the first connection/file/revision and rejects any drift
// before local publication can combine facts from different observed states.

/** @typedef {{scope:'document'}|{scope:'page', nodeId:string}} RevisionObservationRequest */
/** @typedef {{expectedFileKey?:string|null, revisionObservation?:RevisionObservationRequest, revisionRequiredFromPluginVersion?:string, pageRevisionRequiredFromPluginVersion?:string}} RevisionContextOptions */
/** @type {Readonly<RevisionObservationRequest>} */
const DEFAULT_REVISION_OBSERVATION = Object.freeze({ scope: 'document' });

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

export function stablePageRevision(metadata) {
  const observation = metadata?.revisionObservation;
  return Boolean(
    observation
    && observation.scope === 'page'
    && typeof observation.pageId === 'string'
    && observation.pageId
    && Number.isSafeInteger(observation.revisionBefore)
    && observation.revisionBefore >= 0
    && observation.revisionBefore === observation.revisionAfter
  );
}

export function stableObservedRevision(metadata) {
  return stablePageRevision(metadata) || stableDocumentRevision(metadata);
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

export function sameObservedRevision(left, right) {
  if (!sameConnection(left, right)) return false;
  if (stablePageRevision(left) || stablePageRevision(right)) {
    return stablePageRevision(left) && stablePageRevision(right)
      && left.revisionObservation.pageId === right.revisionObservation.pageId
      && left.revisionObservation.revisionAfter === right.revisionObservation.revisionAfter;
  }
  return sameDocumentRevision(left, right);
}

/** Pin and validate the source of a sequence of authenticated read evals. */
/** @param {RevisionContextOptions} [options] */
export function createRevisionContext({
  expectedFileKey = null,
  revisionObservation = DEFAULT_REVISION_OBSERVATION,
  revisionRequiredFromPluginVersion = '3.3.6',
  pageRevisionRequiredFromPluginVersion = '3.3.26',
} = {}) {
  if (!revisionObservation || typeof revisionObservation !== 'object'
    || !['document', 'page'].includes(revisionObservation.scope)
    || (revisionObservation.scope === 'page'
      && (typeof revisionObservation.nodeId !== 'string' || !revisionObservation.nodeId))) {
    throw new TypeError('Revision Context requires a document scope or page scope with an explicit nodeId.');
  }
  const requestedObservation = Object.freeze(revisionObservation.scope === 'page'
    ? { scope: 'page', nodeId: revisionObservation.nodeId }
    : { scope: 'document' });
  let pinned = null;

  return Object.freeze({
    accept(metadata, role = 'Figma read') {
      const documentChanged = Number.isSafeInteger(metadata?.documentRevisionBefore)
        && Number.isSafeInteger(metadata?.documentRevisionAfter)
        && metadata.documentRevisionBefore !== metadata.documentRevisionAfter;
      const pageChanged = metadata?.revisionObservation?.scope === 'page'
        && Number.isSafeInteger(metadata.revisionObservation.revisionBefore)
        && Number.isSafeInteger(metadata.revisionObservation.revisionAfter)
        && metadata.revisionObservation.revisionBefore
          !== metadata.revisionObservation.revisionAfter;
      if (documentChanged || pageChanged) {
        throw contextError(
          `The observed Figma ${pageChanged ? 'page' : 'document'} changed during ${role}; the existing workspace output was left unchanged. Retry from the new revision.`,
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
      const pageRevisionStable = stablePageRevision(metadata);
      const versionComparison = compareVersions(
        metadata.pluginVersion,
        revisionRequiredFromPluginVersion,
      );
      const pageVersionComparison = compareVersions(
        metadata.pluginVersion,
        pageRevisionRequiredFromPluginVersion,
      );
      const pageRequested = requestedObservation.scope === 'page';
      const pageProofRequired = pageRequested
        && (pageVersionComparison === null || pageVersionComparison >= 0);
      const acceptedRevision = pageRequested
        ? (pageRevisionStable || (!pageProofRequired && revisionStable))
        : revisionStable;
      // Compatibility is intentionally closed: only a syntactically valid,
      // provably older plugin may use the document or connection-only proof.
      if (!acceptedRevision && !(versionComparison !== null && versionComparison < 0)) {
        throw contextError(
          `Figma Bridge plugin ${metadata.pluginVersion || '(unknown)'} did not provide the required ${pageRequested ? 'page' : 'document'} revision during ${role}; reconnect or re-import the plugin, then retry.`,
        );
      }
      const currentProof = pageRevisionStable
        ? 'page-revision'
        : revisionStable ? 'document-revision' : 'connection-only';
      if (pinned && (!sameConnection(pinned, metadata)
        || (pinned.proof !== 'connection-only'
          && (pinned.proof !== currentProof || !sameObservedRevision(pinned, metadata))))) {
        throw contextError(
          `Figma connection or observed revision changed during ${role}; the existing workspace output was left unchanged. Retry the export.`,
        );
      }
      if (!pinned) {
        pinned = Object.freeze({
          connectionId: metadata.connectionId,
          fileKey: metadata.fileKey || null,
          pluginVersion: metadata.pluginVersion || null,
          proof: currentProof,
          documentRevisionBefore: revisionStable ? metadata.documentRevisionBefore : null,
          documentRevisionAfter: revisionStable ? metadata.documentRevisionAfter : null,
          ...(pageRevisionStable ? {
            revisionObservation: Object.freeze({ ...metadata.revisionObservation }),
          } : {}),
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

    observation() {
      return requestedObservation;
    },
  });
}
