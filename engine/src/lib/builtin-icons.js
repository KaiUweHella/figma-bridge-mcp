/**
 * Built-in geometry icons for <Icon name="...">.
 *
 * A small, design-system-neutral set of stroke-based 24×24 paths (Feather
 * icons, MIT license) so common UI icons render as real vectors instead of
 * grey placeholder squares. No network involved — this is static path data.
 * Unknown names still fall back to the named placeholder rectangle, and real
 * project icons keep coming from the file via `export assets`.
 *
 * Color is applied AFTER createNodeFromSvg by the existing colorize pass in
 * jsx-render (it rewrites child fills/strokes), so the raw data stays black.
 */

const S = 'stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"';

const ICONS = {
  'check': `<path d="M20 6L9 17l-5-5" ${S}/>`,
  'x': `<path d="M18 6L6 18M6 6l12 12" ${S}/>`,
  'plus': `<path d="M12 5v14M5 12h14" ${S}/>`,
  'minus': `<path d="M5 12h14" ${S}/>`,
  'search': `<circle cx="11" cy="11" r="7" ${S}/><path d="M21 21l-4.35-4.35" ${S}/>`,
  'chevron-up': `<path d="M18 15l-6-6-6 6" ${S}/>`,
  'chevron-down': `<path d="M6 9l6 6 6-6" ${S}/>`,
  'chevron-left': `<path d="M15 18l-6-6 6-6" ${S}/>`,
  'chevron-right': `<path d="M9 18l6-6-6-6" ${S}/>`,
  'arrow-up': `<path d="M12 19V5M5 12l7-7 7 7" ${S}/>`,
  'arrow-down': `<path d="M12 5v14M19 12l-7 7-7-7" ${S}/>`,
  'arrow-left': `<path d="M19 12H5M12 19l-7-7 7-7" ${S}/>`,
  'arrow-right': `<path d="M5 12h14M12 5l7 7-7 7" ${S}/>`,
  'dot': `<circle cx="12" cy="12" r="4" fill="#000"/>`,
  'circle': `<circle cx="12" cy="12" r="9" ${S}/>`,
  'square': `<rect x="4" y="4" width="16" height="16" rx="2" ${S}/>`,
  'star': `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" ${S}/>`,
  'heart': `<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" ${S}/>`,
  'bell': `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" ${S}/><path d="M13.73 21a2 2 0 0 1-3.46 0" ${S}/>`,
  'sun': `<circle cx="12" cy="12" r="5" ${S}/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" ${S}/>`,
  'moon': `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" ${S}/>`,
  'droplet': `<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" ${S}/>`,
  'home': `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" ${S}/><path d="M9 22V12h6v10" ${S}/>`,
  'user': `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" ${S}/><circle cx="12" cy="7" r="4" ${S}/>`,
  'calendar': `<rect x="3" y="4" width="18" height="18" rx="2" ${S}/><path d="M16 2v4M8 2v4M3 10h18" ${S}/>`,
  'clock': `<circle cx="12" cy="12" r="9" ${S}/><path d="M12 7v5l3 3" ${S}/>`,
  'eye': `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" ${S}/><circle cx="12" cy="12" r="3" ${S}/>`,
  'trash': `<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" ${S}/>`,
  'edit': `<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" ${S}/>`,
  'menu': `<path d="M3 6h18M3 12h18M3 18h18" ${S}/>`,
  'more-horizontal': `<circle cx="5" cy="12" r="1.5" fill="#000"/><circle cx="12" cy="12" r="1.5" fill="#000"/><circle cx="19" cy="12" r="1.5" fill="#000"/>`,
  'more-vertical': `<circle cx="12" cy="5" r="1.5" fill="#000"/><circle cx="12" cy="12" r="1.5" fill="#000"/><circle cx="12" cy="19" r="1.5" fill="#000"/>`,
  'info': `<circle cx="12" cy="12" r="9" ${S}/><path d="M12 16v-4M12 8h.01" ${S}/>`,
  'alert-triangle': `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" ${S}/><path d="M12 9v4M12 17h.01" ${S}/>`,
  'settings': `<circle cx="12" cy="12" r="3" ${S}/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" ${S}/>`,
  'upload': `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" ${S}/>`,
  'download': `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" ${S}/>`,
  'thermometer': `<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" ${S}/>`,
  'mail': `<rect x="2" y="4" width="20" height="16" rx="2" ${S}/><path d="M22 6l-10 7L2 6" ${S}/>`,
  'lock': `<rect x="3" y="11" width="18" height="11" rx="2" ${S}/><path d="M7 11V7a5 5 0 0 1 10 0v4" ${S}/>`,
  'filter': `<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" ${S}/>`,
  'bookmark': `<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" ${S}/>`,
};

// Common synonyms agents reach for. Values must exist in ICONS.
const ALIASES = {
  'close': 'x', 'cross': 'x',
  'add': 'plus', 'remove': 'minus',
  'delete': 'trash', 'bin': 'trash',
  'gear': 'settings', 'cog': 'settings',
  'notification': 'bell', 'notifications': 'bell',
  'water': 'droplet', 'drop': 'droplet',
  'favorite': 'heart', 'like': 'heart',
  'profile': 'user', 'account': 'user', 'person': 'user',
  'warning': 'alert-triangle', 'alert': 'alert-triangle',
  'pencil': 'edit',
  'magnifier': 'search',
  'hamburger': 'menu',
  'dots': 'more-horizontal', 'ellipsis': 'more-horizontal', 'kebab': 'more-vertical',
  'back': 'arrow-left', 'forward': 'arrow-right',
  'caret-up': 'chevron-up', 'caret-down': 'chevron-down',
  'caret-left': 'chevron-left', 'caret-right': 'chevron-right',
  'time': 'clock', 'date': 'calendar',
  'temperature': 'thermometer',
};

/**
 * Return a full SVG string for a built-in icon name, or null when the name
 * is not covered (caller falls back to the placeholder rectangle).
 */
export function getBuiltinIconSvg(name) {
  const key = String(name || '').toLowerCase().trim();
  const inner = ICONS[key] || ICONS[ALIASES[key]];
  if (!inner) return null;
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/** All resolvable names (for docs/tests). */
export function builtinIconNames() {
  return [...Object.keys(ICONS), ...Object.keys(ALIASES)].sort();
}
