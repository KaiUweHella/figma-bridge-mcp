// The three-way sync decision table.
//
// This is the part of the feature that can destroy someone's work: pick the
// wrong direction and an afternoon of design edits is overwritten by a stale
// code file, silently. Every branch of planSync() is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalValue, canonicalColor, hexToFigmaRgb,
  parseDtcgFlat, parseCssFlat, parseTokenFile,
  parseLock, buildLock, emptyLock,
  planSync, planTouchesFigma, formatPlan, resolveConflicts,
} from '../src/lib/token-sync.js';

const code = (obj) => new Map(Object.entries(obj));
const figma = (obj) => new Map(Object.entries(obj));
const lock = (tokens) => ({ version: 1, collection: 'C', fileKey: null, syncedAt: null, tokens });

// ------------------------------------------------------------ value forms

test('colours compare equal across the forms Figma and code use', () => {
  assert.equal(canonicalColor('#0D7C74'), '#0d7c74');
  assert.equal(canonicalColor('#0d7c74ff'), '#0d7c74', 'opaque alpha is not a difference');
  assert.equal(canonicalColor('#abc'), '#aabbcc');
  assert.equal(
    canonicalColor({ r: 13 / 255, g: 124 / 255, b: 116 / 255, a: 1 }),
    '#0d7c74',
    'Figma float triples must match the hex a designer typed',
  );
  assert.equal(canonicalColor({ r: 0, g: 0, b: 0, a: 0.5 }), '#00000080');
});

test('float noise from Figma is not treated as a change', () => {
  assert.equal(canonicalValue('FLOAT', 0.30000000000000004), 0.3);
  assert.equal(canonicalValue('FLOAT', '16px'), 16);
});

test('hexToFigmaRgb round-trips and rejects non-colours', () => {
  const rgb = hexToFigmaRgb('#0d7c74');
  assert.equal(canonicalColor(rgb), '#0d7c74');
  assert.equal(hexToFigmaRgb('not-a-colour'), null);
  assert.equal(hexToFigmaRgb('rgb(1,2,3)'), null);
});

// ------------------------------------------------------------ parsing

test('DTCG parsing keeps every token and its full path', () => {
  const tokens = parseDtcgFlat(JSON.stringify({
    brand: {
      primary: { $type: 'color', $value: '#0D7C74' },
      accent: { $type: 'color', $value: '{brand.primary}' },
    },
    space: { $type: 'dimension', md: { $value: '16px' } },
    flags: { beta: { $type: 'boolean', $value: true } },
    label: { $type: 'string', $value: 'Hello' },
  }));
  assert.equal(tokens.get('brand/primary').value, '#0D7C74');
  assert.equal(tokens.get('brand/accent').value, '#0D7C74', 'aliases are resolved, not stored literally');
  assert.deepEqual(tokens.get('space/md'), { type: 'FLOAT', value: 16 });
  assert.equal(tokens.get('flags/beta').type, 'BOOLEAN');
  assert.equal(tokens.get('label').type, 'STRING');
  // Group-level $type must be inherited — the bucketing parser ignores this.
  assert.equal(tokens.get('space/md').type, 'FLOAT');
});

test('DTCG parsing refuses circular and unresolved aliases loudly', () => {
  assert.throws(
    () => parseDtcgFlat('{"a":{"$value":"{b}"},"b":{"$value":"{a}"}}'),
    /Circular alias/,
  );
  assert.throws(() => parseDtcgFlat('{"a":{"$value":"{nope}"}}'), /Unresolved alias/);
  assert.throws(() => parseDtcgFlat('not json'), /Not valid JSON/);
});

test('composite tokens are skipped rather than mangled into a variable', () => {
  const tokens = parseDtcgFlat(JSON.stringify({
    heading: { $type: 'typography', $value: { fontFamily: 'Inter', fontSize: '24px' } },
    brand: { $value: '#fff' },
  }));
  assert.equal(tokens.has('heading'), false);
  assert.equal(tokens.has('brand'), true);
});

test('CSS custom properties map onto Figma-style names', () => {
  const tokens = parseCssFlat(`:root {
    --brand-primary: #0D7C74;
    --space-md: 16px;
    --alias: var(--brand-primary);
  }`);
  assert.equal(tokens.get('brand/primary').value, '#0D7C74');
  assert.deepEqual(tokens.get('space/md'), { type: 'FLOAT', value: 16 });
  assert.equal(tokens.has('alias'), false, 'var() indirection must not be written into Figma verbatim');
});

test('an unsupported source names what IS supported, and why', () => {
  assert.throws(
    () => parseTokenFile('tailwind.config.js', 'module.exports = {}'),
    /Tailwind configs are an import source/,
  );
  assert.throws(
    () => parseTokenFile('tokens.scss', '$brand-primary: #0d7c74;'),
    /safe three-way sync/,
    'a Sass file must not be silently accepted as if $variables were CSS custom properties',
  );
});

// ------------------------------------------------------------ decisions

test('nothing changed anywhere → unchanged, and Figma is not touched', () => {
  const plan = planSync(
    code({ 'brand/primary': { type: 'COLOR', value: '#0d7c74' } }),
    figma({ 'brand/primary': { type: 'COLOR', value: '#0d7c74', id: 'V1' } }),
    lock({ 'brand/primary': { type: 'COLOR', value: '#0d7c74', id: 'V1' } }),
  );
  assert.equal(plan.unchanged, 1);
  assert.equal(planTouchesFigma(plan), false);
});

test('the code changed and Figma did not → update Figma', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#111111' } }),
    figma({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
    lock({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
  );
  assert.equal(plan.update.length, 1);
  assert.equal(plan.conflict.length, 0);
  assert.deepEqual(
    [plan.update[0].from, plan.update[0].value],
    ['#000000', '#111111'],
  );
});

test('Figma changed and the code did not → reported, NEVER overwritten', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#000000' } }),
    figma({ a: { type: 'COLOR', value: '#222222', id: 'V1' } }),
    lock({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
  );
  assert.equal(plan.pull.length, 1, 'the designer edit must surface');
  assert.equal(plan.update.length, 0, 'and must not be clobbered by the stale code value');
  assert.equal(planTouchesFigma(plan), false);
});

test('both sides changed → conflict, and nothing is applied', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#111111' } }),
    figma({ a: { type: 'COLOR', value: '#222222', id: 'V1' } }),
    lock({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
  );
  assert.equal(plan.conflict.length, 1);
  assert.equal(plan.conflict[0].reason, 'both-changed');
  assert.equal(plan.update.length, 0);
});

test('a first sync with no lockfile treats divergence as a conflict, not a guess', () => {
  // Without memory there is no way to know who moved; picking a side here is
  // exactly how a sync tool eats someone's afternoon.
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#111111' } }),
    figma({ a: { type: 'COLOR', value: '#222222', id: 'V1' } }),
    null,
  );
  assert.equal(plan.conflict.length, 1);
  assert.equal(plan.conflict[0].reason, 'untracked-divergence');
});

test('a first sync where both sides already agree just adopts them', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#0D7C74' } }),
    figma({ a: { type: 'COLOR', value: { r: 13 / 255, g: 124 / 255, b: 116 / 255, a: 1 }, id: 'V1' } }),
    null,
  );
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.conflict.length, 0);
});

test('new in code → create; deleted in Figma while tracked → conflict', () => {
  const created = planSync(code({ a: { type: 'FLOAT', value: 4 } }), figma({}), null);
  assert.equal(created.create.length, 1);

  const vanished = planSync(
    code({ a: { type: 'FLOAT', value: 4 } }),
    figma({}),
    lock({ a: { type: 'FLOAT', value: 4, id: 'V1' } }),
  );
  assert.equal(vanished.create.length, 0);
  assert.equal(vanished.conflict[0].reason, 'deleted-in-figma');
});

test('removed from code → delete only with --prune', () => {
  const inputs = [
    code({}),
    figma({ a: { type: 'FLOAT', value: 4, id: 'V1' } }),
    lock({ a: { type: 'FLOAT', value: 4, id: 'V1' } }),
  ];
  const dry = planSync(...inputs);
  assert.equal(dry.delete.length, 1);
  assert.equal(dry.delete[0].willDelete, false);
  assert.equal(planTouchesFigma(dry), false, 'without --prune, a removal changes nothing');

  const pruning = planSync(...inputs, { prune: true });
  assert.equal(pruning.delete[0].willDelete, true);
  assert.equal(planTouchesFigma(pruning), true);
});

test('removed from code but ALSO changed in Figma → conflict, never a silent delete', () => {
  const plan = planSync(
    code({}),
    figma({ a: { type: 'FLOAT', value: 8, id: 'V1' } }),
    lock({ a: { type: 'FLOAT', value: 4, id: 'V1' } }),
    { prune: true },
  );
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.conflict[0].reason, 'deleted-in-code-changed-in-figma');
});

test('variables sync never touched are reported as orphans, not pruned', () => {
  const plan = planSync(
    code({}),
    figma({ someoneElse: { type: 'COLOR', value: '#fff', id: 'V9' } }),
    lock({}),
    { prune: true },
  );
  assert.equal(plan.orphan.length, 1);
  assert.equal(plan.delete.length, 0, 'pruning an untracked variable would be vandalism');
});

test('a rename is one rename, not a delete plus a create', () => {
  // A rename is a request from the CODE side: the file now says brand/primary
  // where it used to say colors/primary. Figma still holds the old name — that
  // is what sync is about to change. Recreating instead of renaming would drop
  // every layer binding pointing at that variable.
  const plan = planSync(
    code({ 'brand/primary': { type: 'COLOR', value: '#0d7c74' } }),
    figma({ 'colors/primary': { type: 'COLOR', value: '#0d7c74', id: 'V1' } }),
    lock({ 'colors/primary': { type: 'COLOR', value: '#0d7c74', id: 'V1' } }),
  );
  assert.equal(plan.rename.length, 1);
  assert.deepEqual([plan.rename[0].from, plan.rename[0].name], ['colors/primary', 'brand/primary']);
  assert.equal(plan.rename[0].id, 'V1', 'the same variable, kept alive');
  assert.equal(plan.create.length, 0);
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.unchanged, 0, 'a rename is a change, not an unchanged token');
});

test('two same-valued renames at once stay a delete plus a create', () => {
  // With identical values there is no way to tell which token became which.
  // Guessing would move bindings to the WRONG token — silently. Falling back
  // to create+delete only loses the bindings, which is visible and fixable.
  const plan = planSync(
    code({ 'a/new': { type: 'COLOR', value: '#000000' }, 'b/new': { type: 'COLOR', value: '#000000' } }),
    figma({ 'a/old': { type: 'COLOR', value: '#000000', id: 'V1' }, 'b/old': { type: 'COLOR', value: '#000000', id: 'V2' } }),
    lock({ 'a/old': { type: 'COLOR', value: '#000000', id: 'V1' }, 'b/old': { type: 'COLOR', value: '#000000', id: 'V2' } }),
  );
  assert.equal(plan.rename.length, 0);
  assert.equal(plan.create.length, 2);
  assert.equal(plan.delete.length, 2);
});

test('a rename combined with a value edit is not detected as a rename', () => {
  // Documented limitation: pairing is by value, so renaming and re-valuing a
  // token in the same commit degrades to create + delete. Split the two steps
  // to keep the bindings.
  const plan = planSync(
    code({ 'brand/primary': { type: 'COLOR', value: '#111111' } }),
    figma({ 'colors/primary': { type: 'COLOR', value: '#0d7c74', id: 'V1' } }),
    lock({ 'colors/primary': { type: 'COLOR', value: '#0d7c74', id: 'V1' } }),
  );
  assert.equal(plan.rename.length, 0);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].value, '#111111');
  assert.equal(plan.delete.length, 1);
});

test('a type change rides along with the update and is called out', () => {
  const plan = planSync(
    code({ a: { type: 'FLOAT', value: 4 } }),
    figma({ a: { type: 'STRING', value: '4px', id: 'V1' } }),
    lock({ a: { type: 'STRING', value: '4px', id: 'V1' } }),
  );
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].typeChange, 'STRING → FLOAT');
});

// ------------------------------------------------------------ resolution

test('--ours applies the code file to every conflict', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#111111' } }),
    figma({ a: { type: 'COLOR', value: '#222222', id: 'V1' } }),
    lock({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
  );
  const resolved = resolveConflicts(plan, 'ours');
  assert.equal(resolved.conflict.length, 0);
  assert.equal(resolved.update.length, 1);
  assert.equal(resolved.update[0].value, '#111111');
});

test('--theirs keeps Figma and never writes to it', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#111111' } }),
    figma({ a: { type: 'COLOR', value: '#222222', id: 'V1' } }),
    lock({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
  );
  const resolved = resolveConflicts(plan, 'theirs');
  assert.equal(resolved.conflict.length, 0);
  assert.equal(resolved.update.length, 0);
  assert.equal(resolved.pull.length, 1);
  assert.equal(planTouchesFigma(resolved), false);
});

test('an unknown strategy leaves the plan untouched', () => {
  const plan = planSync(code({}), figma({}), null);
  assert.equal(resolveConflicts(plan, 'whatever'), plan);
});

// ------------------------------------------------------------ lockfile

test('the lockfile stores canonical values and variable ids', () => {
  const built = buildLock({
    collection: 'Design Tokens',
    fileKey: 'K',
    syncedAt: '2026-08-04T10:00:00.000Z',
    tokens: new Map([['a', { type: 'COLOR', value: '#0D7C74', id: 'V1' }]]),
  });
  assert.equal(built.tokens.a.value, '#0d7c74');
  assert.equal(built.tokens.a.id, 'V1');
  assert.equal(built.version, 1);
});

test('an unreadable or future lockfile degrades to "no memory", not a crash', () => {
  assert.equal(parseLock(''), null);
  assert.equal(parseLock('not json'), null);
  assert.equal(parseLock('{"version":99,"tokens":{}}'), null, 'a newer format must not be misread');
  assert.equal(parseLock('{"version":1}'), null);
  assert.ok(parseLock(JSON.stringify(emptyLock('C'))));
});

// ------------------------------------------------------------ reporting

test('the plan report leads with conflicts and says nothing is applied', () => {
  const plan = planSync(
    code({ a: { type: 'COLOR', value: '#111111' }, b: { type: 'FLOAT', value: 8 } }),
    figma({ a: { type: 'COLOR', value: '#222222', id: 'V1' } }),
    lock({ a: { type: 'COLOR', value: '#000000', id: 'V1' } }),
  );
  const out = formatPlan(plan, { collection: 'C', file: 'tokens.json' });
  assert.match(out, /would create \(1\)/);
  assert.match(out, /CONFLICTS \(1\)/);
  assert.match(out, /nothing is applied while these stand/);
  assert.match(out, /--theirs/);
  assert.match(out, /--ours/);
});

test('without --prune the report says how to actually delete', () => {
  const plan = planSync(
    code({}),
    figma({ a: { type: 'FLOAT', value: 4, id: 'V1' } }),
    lock({ a: { type: 'FLOAT', value: 4, id: 'V1' } }),
  );
  const out = formatPlan(plan, { collection: 'C', file: 'f.json' });
  assert.match(out, /in Figma but not in code/);
  assert.match(out, /pass --prune to delete/);
});
