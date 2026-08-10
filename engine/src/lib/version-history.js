// Plugin-first version creation. Reading prior versions remains REST-only;
// saving a named version is available directly in the open Figma document.

export function normalizeVersionRequest({ title, description = null } = {}) {
  const normalizedTitle = String(title ?? '').trim();
  if (!normalizedTitle) throw new Error('Version title must not be empty.');
  const normalizedDescription = description == null ? null : String(description).trim();
  return { title: normalizedTitle, description: normalizedDescription || null };
}

export function saveVersionCode(request) {
  const { title, description } = normalizeVersionRequest(request);
  return `(async () => {
    const saved = await figma.saveVersionHistoryAsync(${JSON.stringify(title)}, ${JSON.stringify(description)});
    return { id: saved && saved.id ? saved.id : null, title: ${JSON.stringify(title)}, description: ${JSON.stringify(description)} };
  })()`;
}
