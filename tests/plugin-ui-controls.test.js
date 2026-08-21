import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8');
const PLUGIN_CODE = readFileSync(join(ROOT, 'plugin', 'code.js'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

function attributes() {
  const values = new Map();
  return {
    values,
    setAttribute(name, value) { values.set(name, String(value)); },
  };
}

test('the standalone panel declares UTF-8 before rendering status copy', () => {
  assert.match(UI, /<head>\s*<meta charset="utf-8" \/>/);
});

test('the default plugin shell is compact without hiding status or safety controls', () => {
  assert.match(PLUGIN_CODE, /const COMPACT_UI_SIZE = \{ width: 320, height: 132 \}/);
  assert.equal(
    PLUGIN_CODE.match(/figma\.showUI\(__html__, COMPACT_UI_SIZE\)/g)?.length,
    2,
    'initial launch and authenticated UI reload must use the same compact size',
  );
  assert.match(UI, /const PANEL_WIDTH = 320/);
  assert.match(UI, /<header class="topbar">[\s\S]*?id="logBtn" class="top-action"/);
  assert.match(UI, /<div class="toolbar" aria-label="Bridge controls">[\s\S]*?id="pauseBtn"[\s\S]*?id="saveVersionBtn"[\s\S]*?id="setupBtn"/);
  assert.match(UI, /id="setupPanel"[\s\S]*?id="keyInput"[\s\S]*?id="restInput"/);
  assert.match(UI, /function setSetupOpen\(open\)[\s\S]*?logEl\.classList\.remove\('show'\)/);
  assert.match(UI, /function setLogOpen\(open\)[\s\S]*?setupPanel\.classList\.remove\('show'\)/);
});

test('the stored access key is masked by default and has an accessible reveal control', () => {
  assert.match(UI, /<input id="keyInput" type="password"[^>]*>/);
  assert.match(
    UI,
    /<button id="keyVisibilityBtn"[^>]*aria-controls="keyInput"[^>]*aria-pressed="false"[^>]*>Show<\/button>/,
  );

  const start = UI.indexOf('function setKeyVisible(');
  const end = UI.indexOf('// ============ Activity log', start);
  assert.ok(start > 0 && end > start, 'key visibility controller must stay in the setup block');
  const source = UI.slice(start, end);
  const keyInput = { type: 'password' };
  const keyVisibilityBtn = { textContent: '', onclick: null, ...attributes() };
  const setKeyVisible = new Function(
    'keyInput',
    'keyVisibilityBtn',
    `${source}; return setKeyVisible;`,
  )(keyInput, keyVisibilityBtn);

  setKeyVisible(true);
  assert.equal(keyInput.type, 'text');
  assert.equal(keyVisibilityBtn.textContent, 'Hide');
  assert.equal(keyVisibilityBtn.values.get('aria-pressed'), 'true');
  assert.equal(keyVisibilityBtn.values.get('aria-label'), 'Hide access key');

  keyVisibilityBtn.onclick();
  assert.equal(keyInput.type, 'password');
  assert.equal(keyVisibilityBtn.textContent, 'Show');
  assert.equal(keyVisibilityBtn.values.get('aria-pressed'), 'false');
});

test('Save history outranks Activity but stays unavailable until REST is configured', () => {
  assert.match(
    UI,
    /<button id="saveVersionBtn" type="button" disabled[^>]*>Save history<\/button>/,
  );
  assert.doesNotMatch(
    UI,
    /\.toolbar \.history/,
    'Save history uses the same neutral toolbar button colors as its siblings',
  );
  assert.ok(
    UI.indexOf('id="logBtn"') < UI.indexOf('<div class="toolbar"'),
    'Activity belongs in the secondary header action, outside the primary toolbar',
  );

  const start = UI.indexOf('function renderRestStatus()');
  const end = UI.indexOf('function sendRestToken(', start);
  assert.ok(start > 0 && end > start, 'REST status renderer must stay next to token controls');
  const source = UI.slice(start, end);
  const build = new Function(
    'restConfigured',
    'restStatusEl',
    'restTag',
    'saveVersionBtn',
    `${source}; renderRestStatus();`,
  );
  const restStatusEl = { textContent: '' };
  const restTag = {
    textContent: '',
    classList: { toggle() {} },
  };
  const saveVersionBtn = { disabled: false, title: '' };

  build(false, restStatusEl, restTag, saveVersionBtn);
  assert.equal(saveVersionBtn.disabled, true);
  assert.match(saveVersionBtn.title, /REST token/i);

  build(true, restStatusEl, restTag, saveVersionBtn);
  assert.equal(saveVersionBtn.disabled, false);
  assert.match(saveVersionBtn.title, /checkpoint/i);
});

test('named Figma checkpoints use a stable human-readable local timestamp', () => {
  const start = PLUGIN_CODE.indexOf('function formatVersionHistoryLabel(');
  const end = PLUGIN_CODE.indexOf('// Save checkpoint', start);
  assert.ok(start > 0 && end > start, 'version label formatter must stay beside the save handler');
  const source = PLUGIN_CODE.slice(start, end);
  const formatVersionHistoryLabel = new Function(`${source}; return formatVersionHistoryLabel;`)();

  assert.equal(
    formatVersionHistoryLabel(new Date(2026, 7, 21, 14, 5)),
    'Figma Bridge checkpoint · 21 Aug 2026, 14:05',
  );
  assert.doesNotMatch(source, /toISOString/);
  assert.match(PLUGIN_CODE, /saveVersionHistoryAsync\(formatVersionHistoryLabel\(new Date\(\)\)\)/);
});

test('README puts optional REST setup near onboarding and gives Dev Mode its own manifest heading', () => {
  const restHeading = README.indexOf('## REST add-on (optional)');
  const architectureHeading = README.indexOf('## How it works');
  assert.ok(restHeading > 0 && restHeading < architectureHeading,
    'optional REST setup should be visible before the architecture reference');
  assert.equal(README.match(/^## REST add-on \(optional\)$/gm)?.length, 1);
  assert.match(README, /^### Figma Dev Mode requires its own manifest$/m);
  assert.match(README, /normal[^\n]*`manifest\.json`[^\n]*does not work in Dev Mode/i);
  assert.match(README, /manifest\.dev\.json/);
});
