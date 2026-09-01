// Compatibility facade. Named-version execution is owned by the History
// Command Application; older imports retain the established helper names.

import { versionHistorySaveCode } from '../application/history-command.js';
import { normalizeVersionSaveRequest } from '../application/history-request.js';

export function normalizeVersionRequest(request = {}) {
  return normalizeVersionSaveRequest({
    title: String(request?.title ?? ''),
    description: request?.description == null ? null : String(request.description),
  });
}

export function saveVersionCode(request) {
  return `(async () => JSON.parse(await ${versionHistorySaveCode({
    ...normalizeVersionRequest(request), action: 'save',
  })}))()`;
}
