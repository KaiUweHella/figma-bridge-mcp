// The `tokens sync` command end to end, with the plugin bridge faked.
//
// The decision table is covered in token-sync.test.js; what is proven here is
// the wiring around it — that a dry run really writes nothing, that a lockfile
// only advances after every write succeeded, and that the refusals (empty file,
// conflicts, contradictory flags) actually stop the command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'index.js');

// A stub daemon: answers /health as connected and /exec by running the eval
// against a tiny in-memory Figma. Small enough to keep honest, real enough that
// the command's own eval source is what gets exercised.
import { createServer } from 'node:http';

function startFakeDaemon(state) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', mode: 'safe', plugin: true }));
        return;
      }
      if (req.url === '/exec') {
        let payload = {};
        try { payload = JSON.parse(body); } catch {}
        // The command's eval source is an async IIFE, so the fake has to await
        // it exactly like the plugin does.
        runFakeFigma(payload.code || '', state).then(
          (result) => res.end(JSON.stringify({ success: true, result })),
          (e) => res.end(JSON.stringify({ success: false, error: e.message })),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Minimal Figma variables API, enough for readFigmaTokens/applyPlan.
// `new Function` here compiles the command's OWN generated eval source — the
// point of the stub is to run the real thing rather than a paraphrase of it.
async function runFakeFigma(code, state) {
  const figma = {
    variables: {
      async getLocalVariableCollectionsAsync() { return state.collections; },
      async getLocalVariablesAsync() { return state.variables; },
      createVariableCollection(name) {
        const col = { id: `C${state.collections.length + 1}`, name, modes: [{ modeId: 'M1' }] };
        state.collections.push(col);
        return col;
      },
      createVariable(name, col, type) {
        const v = {
          id: `V${++state.seq}`, name, variableCollectionId: col.id,
          resolvedType: type, valuesByMode: {},
          setValueForMode(modeId, value) { this.valuesByMode[modeId] = value; },
          remove() { state.variables = state.variables.filter((x) => x.id !== v.id); },
        };
        state.variables.push(v);
        return v;
      },
    },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('figma', `return ${code}`);
  return fn(figma);
}

function makeVar(state, name, type, value) {
  const v = {
    id: `V${++state.seq}`, name, variableCollectionId: 'C1',
    resolvedType: type, valuesByMode: { M1: value },
    setValueForMode(modeId, val) { this.valuesByMode[modeId] = val; },
    remove() { state.variables = state.variables.filter((x) => x.id !== v.id); },
  };
  state.variables.push(v);
  return v;
}

function freshState() {
  return {
    seq: 0,
    collections: [{ id: 'C1', name: 'Design Tokens', modes: [{ modeId: 'M1' }] }],
    variables: [],
  };
}

/** A second collection, so cross-collection cases can be exercised. */
function addCollection(state, name) {
  const col = { id: `C${state.collections.length + 1}`, name, modes: [{ modeId: 'M1' }] };
  state.collections.push(col);
  return col;
}

async function runSync(args, { port, cwd }) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [CLI, 'tokens', 'sync', ...args],
      { cwd, env: { ...process.env, DAEMON_PORT: String(port), FIGMA_SKIP_DAEMON_SPAWN: '1' } },
    );
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const DTCG = (color) => JSON.stringify({
  brand: { primary: { $type: 'color', $value: color } },
  space: { $type: 'dimension', md: { $value: '16px' } },
});

test('a dry run reports the plan and writes nothing to Figma', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  const res = await runSync(['tokens.json'], { port, cwd: dir });

  assert.match(res.out, /would create \(2\)/);
  assert.match(res.out, /brand\/primary/);
  assert.match(res.out, /Re-run with --apply/);
  assert.equal(state.variables.length, 0, 'a dry run must not create anything');
  assert.equal(existsSync(join(dir, 'figma-tokens.lock.json')), false, 'and must not write a lockfile');
  assert.equal(res.code, 1, 'pending changes exit nonzero so CI can gate on it');
});

test('--apply creates the variables and records them in the lockfile', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  const res = await runSync(['tokens.json', '--apply'], { port, cwd: dir });

  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /2 created/);
  assert.equal(state.variables.length, 2);

  const colour = state.variables.find((v) => v.name === 'brand/primary');
  assert.equal(colour.resolvedType, 'COLOR');
  // Written as Figma's float triple, not as the hex string from the file.
  assert.ok(Math.abs(colour.valuesByMode.M1.r - 13 / 255) < 1e-6);

  const lock = JSON.parse(readFileSync(join(dir, 'figma-tokens.lock.json'), 'utf8'));
  assert.equal(lock.version, 1);
  assert.equal(lock.tokens['brand/primary'].value, '#0d7c74');
  assert.equal(lock.tokens['space/md'].value, 16);
});

test('a second run with no edits reports "already in sync" and exits 0', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  await runSync(['tokens.json', '--apply'], { port, cwd: dir });
  const second = await runSync(['tokens.json'], { port, cwd: dir });

  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /already in sync/);
});

test('an edit in Figma is reported, never overwritten by the unchanged code file', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  await runSync(['tokens.json', '--apply'], { port, cwd: dir });

  // The designer changes the colour in Figma; the code file is untouched.
  const colour = state.variables.find((v) => v.name === 'brand/primary');
  colour.valuesByMode.M1 = { r: 1, g: 0, b: 0, a: 1 };

  const res = await runSync(['tokens.json', '--apply'], { port, cwd: dir });
  assert.match(res.out, /changed in Figma — update your code file/);
  assert.deepEqual(colour.valuesByMode.M1, { r: 1, g: 0, b: 0, a: 1 }, 'the designer edit must survive');
});

test('both sides edited → conflict, nothing applied, nonzero exit', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  await runSync(['tokens.json', '--apply'], { port, cwd: dir });

  const colour = state.variables.find((v) => v.name === 'brand/primary');
  colour.valuesByMode.M1 = { r: 1, g: 0, b: 0, a: 1 };       // Figma moved
  writeFileSync(join(dir, 'tokens.json'), DTCG('#123456'));   // code moved too

  const res = await runSync(['tokens.json', '--apply'], { port, cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.out, /CONFLICTS \(1\)/);
  assert.match(res.out, /nothing was applied/);
  assert.deepEqual(colour.valuesByMode.M1, { r: 1, g: 0, b: 0, a: 1 }, 'Figma untouched while a conflict stands');

  // --ours resolves it in the code file's favour.
  const ours = await runSync(['tokens.json', '--apply', '--ours'], { port, cwd: dir });
  assert.equal(ours.code, 0, ours.out);
  assert.ok(Math.abs(colour.valuesByMode.M1.r - 0x12 / 255) < 1e-6, 'the code value won');
});

test('a removed token is only deleted with --prune', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  await runSync(['tokens.json', '--apply'], { port, cwd: dir });
  assert.equal(state.variables.length, 2);

  writeFileSync(join(dir, 'tokens.json'), JSON.stringify({
    brand: { primary: { $type: 'color', $value: '#0D7C74' } },
  }));

  const noPrune = await runSync(['tokens.json', '--apply'], { port, cwd: dir });
  assert.match(noPrune.out, /pass --prune to delete/);
  assert.equal(state.variables.length, 2, 'nothing deleted without --prune');

  await runSync(['tokens.json', '--apply', '--prune'], { port, cwd: dir });
  assert.equal(state.variables.length, 1);
  assert.equal(state.variables[0].name, 'brand/primary');
});

test('an untracked Figma variable is reported but never pruned', async (t) => {
  const state = freshState();
  makeVar(state, 'someone/else', 'COLOR', { r: 0, g: 0, b: 1, a: 1 });
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  const res = await runSync(['tokens.json', '--apply', '--prune'], { port, cwd: dir });

  assert.match(res.out, /untracked in Figma — never touched by sync/);
  assert.ok(state.variables.some((v) => v.name === 'someone/else'), 'someone else\'s variable survives --prune');
});

test('an empty token file is refused rather than read as "delete everything"', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'empty.json'), '{}');
  const res = await runSync(['empty.json', '--apply', '--prune'], { port, cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.out, /would look like "delete everything"/);
});

test('--ours and --theirs together are refused', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  const res = await runSync(['tokens.json', '--ours', '--theirs'], { port, cwd: dir });
  assert.equal(res.code, 1);
  assert.match(res.out, /mutually exclusive/);
});

test('renaming a token keeps the same Figma variable, bindings and all', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  await runSync(['tokens.json', '--apply'], { port, cwd: dir });
  const originalId = state.variables.find((v) => v.name === 'brand/primary').id;

  // brand.primary → colors.primary, same value.
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify({
    colors: { primary: { $type: 'color', $value: '#0D7C74' } },
    space: { $type: 'dimension', md: { $value: '16px' } },
  }));

  const res = await runSync(['tokens.json', '--apply', '--prune'], { port, cwd: dir });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /rename \(1\)/);
  assert.match(res.out, /brand\/primary → colors\/primary/);

  const renamed = state.variables.find((v) => v.name === 'colors/primary');
  assert.ok(renamed, 'the variable must exist under its new name');
  assert.equal(renamed.id, originalId, 'and be the SAME variable — a recreate would drop every binding');
  assert.equal(state.variables.length, 2, 'no stray leftover under the old name');

  // The lock must follow the rename, or the next run sees a tracked variable
  // that no longer exists and reports a phantom conflict.
  const lock = JSON.parse(readFileSync(join(dir, 'figma-tokens.lock.json'), 'utf8'));
  assert.ok(lock.tokens['colors/primary']);
  assert.equal(lock.tokens['brand/primary'], undefined);

  const third = await runSync(['tokens.json'], { port, cwd: dir });
  assert.match(third.out, /already in sync/);
});

test('syncing into the wrong collection is caught before it duplicates everything', async (t) => {
  // export dtcg flattens EVERY local variable into one file, while sync targets
  // a single collection. Found live: the obvious round-trip then reports
  // "create everything" and --apply would duplicate a whole design system into
  // the wrong collection.
  const state = freshState();
  const other = addCollection(state, 'Primitives');
  const v = makeVar(state, 'brand/primary', 'COLOR', { r: 0.05, g: 0.48, b: 0.45, a: 1 });
  v.variableCollectionId = other.id;
  const v2 = makeVar(state, 'space/md', 'FLOAT', 16);
  v2.variableCollectionId = other.id;

  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  const res = await runSync(['tokens.json'], { port, cwd: dir });

  assert.match(res.out, /already exist in "Primitives"/);
  assert.match(res.out, /would duplicate them/);
  assert.match(res.out, /--collection "Primitives"/);
});

test('a name that exists nowhere else does NOT trigger the warning', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.json'), DTCG('#0D7C74'));
  const res = await runSync(['tokens.json'], { port, cwd: dir });
  assert.doesNotMatch(res.out, /would duplicate them/);
});

test('CSS custom properties sync the same way as DTCG', async (t) => {
  const state = freshState();
  const { server, port } = await startFakeDaemon(state);
  const dir = mkdtempSync(join(tmpdir(), 'tokensync-'));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  writeFileSync(join(dir, 'tokens.css'), ':root { --brand-primary: #0D7C74; --space-md: 16px; }');
  const res = await runSync(['tokens.css', '--apply'], { port, cwd: dir });
  assert.equal(res.code, 0, res.out);
  assert.equal(state.variables.length, 2);
  assert.ok(state.variables.some((v) => v.name === 'brand/primary'));
});
