// Version of the Figma-side plugin bundle, independent from the npm package.
// Server-only releases do not require a Figma re-import, so this value changes
// only when plugin/code.js, plugin/ui.html or their manifest contract changes.
export const PLUGIN_BUILD_VERSION = '3.1.0';

function semverParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  return match ? match.slice(1).map(Number) : null;
}

/** Return true only when the imported Figma plugin is older than our bundle. */
export function pluginUpdateAvailable(currentVersion, bundledVersion = PLUGIN_BUILD_VERSION) {
  const current = semverParts(currentVersion);
  const bundled = semverParts(bundledVersion);
  if (!current || !bundled) return String(currentVersion || '') !== String(bundledVersion || '');
  for (let i = 0; i < 3; i++) {
    if (current[i] < bundled[i]) return true;
    if (current[i] > bundled[i]) return false;
  }
  return false;
}
