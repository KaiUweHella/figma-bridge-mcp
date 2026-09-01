import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ApiReferenceStoreError,
  createApiReferenceStore,
  projectOfficialReference,
} from '../engine/src/lib/api-reference-store.js';
import {
  API_REFERENCE_LIMITS,
  API_REFERENCE_POLICY,
  OFFICIAL_TYPINGS_PATH,
} from '../engine/src/lib/api-reference-policy.js';
import { assertPosixMode } from '../test-support/posix-permissions.js';

const SOURCE = `/** Official root API. */
interface PluginAPI {
  /** Create a frame. */
  createFrame(): FrameNode
  readonly currentPage: PageNode
}
/** A frame node. */
interface FrameNode extends SceneNodeMixin {
  resize(width: number, height: number): void
}
type SceneNode = FrameNode
`;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'figma-api-reference-'));
  const sourceDirectory = join(root, 'package');
  const stateRoot = join(root, 'state');
  mkdirSync(sourceDirectory, { mode: 0o700 });
  const packagePath = join(sourceDirectory, 'package.json');
  const sourcePath = join(sourceDirectory, 'plugin-api.d.ts');
  writeFileSync(packagePath, JSON.stringify({ name: '@figma/plugin-typings', version: '1.0.0' }));
  writeFileSync(sourcePath, SOURCE);
  const sourceSha256 = digest(SOURCE);
  const policy = {
    packageName: '@figma/plugin-typings',
    packageVersion: '1.0.0',
    sourceSha256,
    materialVersion: `figma-plugin-typings-1.0.0-${sourceSha256.slice(0, 12)}`,
    sourceDirectory,
    sourcePath,
    packagePath,
    limits: { ...API_REFERENCE_LIMITS },
  };
  return { root, stateRoot, sourceDirectory, packagePath, sourcePath, policy };
}

test('reviewed official typings project into a complete bounded declaration model', () => {
  const source = readFileSync(OFFICIAL_TYPINGS_PATH, 'utf8');
  const model = projectOfficialReference(source, API_REFERENCE_POLICY);
  assert.equal(model.entries.length, 372);
  assert.equal(model.provenance.sourceSha256, API_REFERENCE_POLICY.sourceSha256);
  const plugin = model.entries.find((entry) => entry.name === 'PluginAPI');
  const frame = model.entries.find((entry) => entry.name === 'FrameNode');
  assert.ok(plugin.members.some((member) => member.name === 'createFrame'));
  assert.match(frame.source, /interface FrameNode extends DefaultFrameMixin/);
  assert.ok(Buffer.byteLength(JSON.stringify(model), 'utf8') < API_REFERENCE_LIMITS.storeBytes);
});

test('setup reads a read-only package and atomically publishes private material', () => {
  const value = fixture();
  const before = readdirSync(value.sourceDirectory).sort();
  chmodSync(value.packagePath, 0o444);
  chmodSync(value.sourcePath, 0o444);
  chmodSync(value.sourceDirectory, 0o555);
  const store = createApiReferenceStore({ root: value.stateRoot, policy: value.policy });

  const installed = store.install();
  assert.equal(installed.reused, false);
  assert.equal(installed.materialVersion, value.policy.materialVersion);
  assert.equal(installed.entries, 3);
  assert.deepEqual(readdirSync(value.sourceDirectory).sort(), before);
  assertPosixMode(value.stateRoot, 0o700);
  const referenceDir = join(value.stateRoot, 'api-reference');
  assertPosixMode(referenceDir, 0o700);
  const files = readdirSync(referenceDir);
  assert.equal(files.length, 1);
  assertPosixMode(join(referenceDir, files[0]), 0o600);
  assert.equal(store.load().entries[0].name, 'PluginAPI');
  assert.ok(store.ageInDays() < 1);
  assert.equal(store.install().reused, true);
});

test('failed provenance update leaves the previous known-good material readable', () => {
  const value = fixture();
  const store = createApiReferenceStore({ root: value.stateRoot, policy: value.policy });
  store.install();
  writeFileSync(value.sourcePath, `${SOURCE}\ninterface Tampered {}`);

  assert.throws(
    () => store.install(),
    (error) => error instanceof ApiReferenceStoreError && error.code === 'API_REFERENCE_PROVENANCE',
  );
  const retained = store.load();
  assert.equal(retained.materialVersion, value.policy.materialVersion);
  assert.equal(retained.entries.some((entry) => entry.name === 'Tampered'), false);
});

test('concurrent setup processes publish one complete material without temporary residue', async () => {
  const value = fixture();
  const moduleUrl = new URL('../engine/src/lib/api-reference-store.js', import.meta.url).href;
  const script = `
    const { createApiReferenceStore } = await import(process.env.API_REFERENCE_STORE_MODULE);
    const policy = JSON.parse(process.env.API_REFERENCE_POLICY_JSON);
    const result = createApiReferenceStore({
      root: process.env.API_REFERENCE_STATE_ROOT,
      policy,
    }).install();
    process.stdout.write(JSON.stringify(result));
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        API_REFERENCE_STORE_MODULE: moduleUrl,
        API_REFERENCE_POLICY_JSON: JSON.stringify(value.policy),
        API_REFERENCE_STATE_ROOT: value.stateRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
      try { return resolve(JSON.parse(stdout)); }
      catch (error) { return reject(error); }
    });
  });
  const results = await Promise.all(Array.from({ length: 12 }, run));

  assert.equal(results.filter((result) => result.reused === false).length, 1);
  assert.equal(results.filter((result) => result.reused === true).length, 11);

  const store = createApiReferenceStore({ root: value.stateRoot, policy: value.policy });
  assert.equal(store.load().entries.length, 3);
  const files = readdirSync(join(value.stateRoot, 'api-reference'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^official-1\.0\.0-[a-f0-9]{64}\.json$/);
});

test('private state rejects links and unexpected entries before lookup', () => {
  const value = fixture();
  const store = createApiReferenceStore({ root: value.stateRoot, policy: value.policy });
  store.install();
  symlinkSync(value.sourcePath, join(value.stateRoot, 'api-reference', 'unexpected'));
  assert.throws(
    () => store.load(),
    (error) => error instanceof ApiReferenceStoreError && error.code === 'API_REFERENCE_PATH_UNSAFE',
  );
});

test('missing material gives a clear local re-setup path', () => {
  const value = fixture();
  const store = createApiReferenceStore({ root: value.stateRoot, policy: value.policy });
  assert.throws(
    () => store.load(),
    (error) => error instanceof ApiReferenceStoreError
      && error.code === 'API_REFERENCE_NOT_INSTALLED'
      && /api.*setup/i.test(error.message),
  );
});

test('agent context uses the activated official material and stays byte bounded', async () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'figma-api-reference-home-'));
  const moduleUrl = new URL('../engine/src/api-docs.js', import.meta.url).href;
  const script = `
    const docs = await import(process.env.API_DOCS_MODULE);
    console.log = () => {};
    await docs.setup();
    const context = docs.getContext('resize');
    process.stdout.write(JSON.stringify({
      bytes: Buffer.byteLength(context, 'utf8'),
      official: context.includes('figma-plugin-typings-1.133.0-010eadcbbd27'),
      relevant: context.includes('LayoutMixin'),
    }));
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: isolatedHome, API_DOCS_MODULE: moduleUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(stderr || `child exited ${code}`)));
  });
  assert.ok(result.bytes <= API_REFERENCE_LIMITS.contextBytes);
  assert.equal(result.official, true);
  assert.equal(result.relevant, true);
});
