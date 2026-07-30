// Back-compat shim: the JSX → plugin-code compiler moved to lib/jsx-render.js
// when the Chrome-DevTools client it used to be was removed. Kept so the
// daemon, commands and the existing test files keep importing one stable path.
export { FigmaClient, numOr } from './lib/jsx-render.js';
export { FigmaClient as default } from './lib/jsx-render.js';
