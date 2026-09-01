// One authority for untrusted workspace filesystem access.
//
// The MCP launch directory is available automatically. Additional project
// roots are explicit. Every accepted path is checked after symlink resolution;
// reads and writes then validate the opened inode before any bytes cross the
// boundary. This keeps containment at the I/O seam instead of scattering
// lexical path checks across Command Adapters.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';

export const DEFAULT_WORKSPACE_LIMITS = Object.freeze({
  textBytes: 8 * 1024 * 1024,
  jsonBytes: 8 * 1024 * 1024,
  binaryBytes: 64 * 1024 * 1024,
  nestingDepth: 64,
  collectionEntries: 100_000,
  yamlAliases: 50,
});

const SAFE_ROLE = /^[a-z][a-z0-9-]{0,63}$/;

export class WorkspaceIOError extends Error {
  constructor(role, reason, code = 'WORKSPACE_PATH_REJECTED') {
    const safeRole = SAFE_ROLE.test(role) ? role : 'workspace-path';
    super(`Workspace ${safeRole} rejected: ${reason}.`);
    this.name = 'WorkspaceIOError';
    this.code = code;
    this.kind = 'workspace-policy';
    this.role = safeRole;
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function inodeMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizeRole(role) {
  return SAFE_ROLE.test(role || '') ? role : 'workspace-path';
}

function resolveRoot(input, launchRoot) {
  const absolute = path.resolve(launchRoot, input);
  let canonical;
  let metadata;
  try {
    canonical = realpathSync.native(absolute);
    metadata = statSync(canonical);
  } catch {
    throw new WorkspaceIOError('allowed-root', 'configured root is unavailable');
  }
  if (!metadata.isDirectory()) {
    throw new WorkspaceIOError('allowed-root', 'configured root is not a directory');
  }
  return Object.freeze({ lexical: absolute, canonical });
}

function countJsonStructure(text, limits, role) {
  let depth = 0;
  let entries = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') {
      depth++;
      entries++;
      if (depth > limits.nestingDepth) {
        throw new WorkspaceIOError(role, `nesting exceeds ${limits.nestingDepth}`, 'WORKSPACE_PARSE_LIMIT');
      }
    } else if (char === '}' || char === ']') {
      depth--;
    } else if (char === ',' || char === ':') {
      entries++;
    }
    if (entries > limits.collectionEntries) {
      throw new WorkspaceIOError(role, `collection exceeds ${limits.collectionEntries} entries`, 'WORKSPACE_PARSE_LIMIT');
    }
  }
}

function assertObjectGraph(value, limits, role) {
  const stack = [{ value, depth: 0 }];
  let entries = 0;
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > limits.nestingDepth) {
      throw new WorkspaceIOError(role, `nesting exceeds ${limits.nestingDepth}`, 'WORKSPACE_PARSE_LIMIT');
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    entries += children.length;
    if (entries > limits.collectionEntries) {
      throw new WorkspaceIOError(role, `collection exceeds ${limits.collectionEntries} entries`, 'WORKSPACE_PARSE_LIMIT');
    }
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return value;
}

function assertYamlDocument(doc, limits, role) {
  if (doc.errors.length) throw doc.errors[0];
  const stack = [{ node: doc.contents, depth: 0 }];
  let entries = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > limits.nestingDepth) {
      throw new WorkspaceIOError(role, `nesting exceeds ${limits.nestingDepth}`, 'WORKSPACE_PARSE_LIMIT');
    }
    const children = [];
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        if (item?.key) children.push(item.key);
        if (item?.value) children.push(item.value);
        else if (item && !item.key) children.push(item);
      }
    }
    entries += children.length;
    if (entries > limits.collectionEntries) {
      throw new WorkspaceIOError(role, `collection exceeds ${limits.collectionEntries} entries`, 'WORKSPACE_PARSE_LIMIT');
    }
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }
}

export function parseBoundedJson(text, {
  role = 'json-input',
  limits = DEFAULT_WORKSPACE_LIMITS,
} = {}) {
  if (Buffer.byteLength(text, 'utf8') > limits.jsonBytes) {
    throw new WorkspaceIOError(role, `file exceeds ${limits.jsonBytes} bytes`, 'WORKSPACE_BYTE_LIMIT');
  }
  countJsonStructure(text, limits, normalizeRole(role));
  return assertObjectGraph(JSON.parse(text), limits, normalizeRole(role));
}

export function parseBoundedYaml(text, {
  role = 'yaml-input',
  limits = DEFAULT_WORKSPACE_LIMITS,
} = {}) {
  if (Buffer.byteLength(text, 'utf8') > limits.textBytes) {
    throw new WorkspaceIOError(role, `file exceeds ${limits.textBytes} bytes`, 'WORKSPACE_BYTE_LIMIT');
  }
  const doc = YAML.parseDocument(text, { prettyErrors: false });
  assertYamlDocument(doc, limits, normalizeRole(role));
  const value = doc.toJS({ maxAliasCount: limits.yamlAliases });
  return assertObjectGraph(value, limits, normalizeRole(role));
}

export function parseWorkspaceRoots(value, { delimiter = path.delimiter } = {}) {
  if (!value) return [];
  return String(value).split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export function createWorkspaceIO({
  root = process.cwd(),
  extraRoots = [],
  limits = {},
  testHooks = /** @type {{beforeReadOpen?:(path:string)=>void, beforeWriteOpen?:(path:string)=>void, beforeReplaceOpen?:(staged:string,target:string)=>void, beforeReplaceCommit?:(staged:string,target:string)=>void}} */ ({}),
} = {}) {
  const launchRoot = path.resolve(root);
  const configured = [root, ...extraRoots];
  const deduped = new Map();
  for (const input of configured) {
    const descriptor = resolveRoot(input, launchRoot);
    if (!deduped.has(descriptor.canonical)) deduped.set(descriptor.canonical, descriptor);
  }
  const roots = Object.freeze([...deduped.values()].sort((a, b) => b.lexical.length - a.lexical.length));
  const effectiveLimits = Object.freeze({ ...DEFAULT_WORKSPACE_LIMITS, ...limits });

  function acceptedCanonical(candidate) {
    return roots.some((entry) => within(entry.canonical, candidate));
  }

  function rootForLexical(candidate) {
    return roots.find((entry) => within(entry.lexical, candidate) || within(entry.canonical, candidate));
  }

  function canonicalRead(input, { role = 'workspace-input', kind = 'any' } = {}) {
    const safeRole = normalizeRole(role);
    const absolute = path.resolve(input);
    let canonical;
    let metadata;
    try {
      canonical = realpathSync.native(absolute);
      metadata = statSync(canonical);
    } catch {
      throw new WorkspaceIOError(safeRole, 'path is unavailable');
    }
    if (!acceptedCanonical(canonical)) throw new WorkspaceIOError(safeRole, 'path is outside allowed roots');
    if (kind === 'file' && !metadata.isFile()) throw new WorkspaceIOError(safeRole, 'path is not a regular file');
    if (kind === 'directory' && !metadata.isDirectory()) throw new WorkspaceIOError(safeRole, 'path is not a directory');
    return { absolute, canonical, metadata };
  }

  function secureOpenRead(input, { role, maxBytes, kind = 'file' }) {
    const safeRole = normalizeRole(role);
    const first = canonicalRead(input, { role: safeRole, kind });
    let fd;
    try {
      testHooks.beforeReadOpen?.(first.canonical);
      fd = openSync(first.canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = fstatSync(fd);
      const actual = canonicalRead(first.canonical, { role: safeRole, kind });
      const actualLink = lstatSync(actual.canonical);
      if (!inodeMatches(opened, actualLink)) throw new WorkspaceIOError(safeRole, 'path changed while it was opened');
      if (opened.size > maxBytes) {
        throw new WorkspaceIOError(safeRole, `file exceeds ${maxBytes} bytes`, 'WORKSPACE_BYTE_LIMIT');
      }
      return { fd, path: actual.canonical, size: opened.size };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (error instanceof WorkspaceIOError) throw error;
      throw new WorkspaceIOError(safeRole, 'path could not be opened safely');
    }
  }

  function ensureDirectory(input, { role = 'workspace-output' } = {}) {
    const safeRole = normalizeRole(role);
    const absolute = path.resolve(input);
    const rootEntry = rootForLexical(absolute);
    if (!rootEntry) throw new WorkspaceIOError(safeRole, 'path is outside allowed roots');
    const relative = within(rootEntry.lexical, absolute)
      ? path.relative(rootEntry.lexical, absolute)
      : path.relative(rootEntry.canonical, absolute);
    let current = rootEntry.canonical;
    if (!relative) return current;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      if (part === '..') throw new WorkspaceIOError(safeRole, 'path traverses outside an allowed root');
      const candidate = path.join(current, part);
      try {
        mkdirSync(candidate, { mode: 0o755 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new WorkspaceIOError(safeRole, 'parent directory could not be created safely');
      }
      let canonical;
      let metadata;
      try {
        canonical = realpathSync.native(candidate);
        metadata = statSync(canonical);
      } catch {
        throw new WorkspaceIOError(safeRole, 'parent directory changed during creation');
      }
      if (!metadata.isDirectory() || !acceptedCanonical(canonical)) {
        throw new WorkspaceIOError(safeRole, 'parent directory resolves outside allowed roots');
      }
      current = canonical;
    }
    return current;
  }

  function canonicalWrite(input, { role = 'workspace-output', createParents = false, kind = 'any' } = {}) {
    const safeRole = normalizeRole(role);
    const absolute = path.resolve(input);
    const rootEntry = rootForLexical(absolute);
    if (!rootEntry) throw new WorkspaceIOError(safeRole, 'path is outside allowed roots');
    const parentInput = path.dirname(absolute);
    let parent;
    if (createParents) {
      parent = ensureDirectory(parentInput, { role: safeRole });
    } else {
      let existing = parentInput;
      while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
      parent = canonicalRead(existing, { role: safeRole, kind: 'directory' }).canonical;
      // Planning is side-effect free. Missing descendants will be constructed
      // later by ensureDirectory, which repeats containment per component.
      if (existing !== parentInput) return { absolute, canonical: absolute, exists: false };
    }
    if (!acceptedCanonical(parent)) throw new WorkspaceIOError(safeRole, 'parent directory resolves outside allowed roots');
    const candidate = path.join(parent, path.basename(absolute));
    if (!existsSync(candidate)) return { absolute, canonical: candidate, exists: false };
    const canonical = canonicalRead(candidate, { role: safeRole, kind }).canonical;
    return { absolute, canonical, exists: true };
  }

  function authorizePath(input, { access = 'read', role = 'workspace-path', kind = 'any' } = {}) {
    if (access === 'write') return canonicalWrite(input, { role, createParents: false, kind });
    if (access === 'read-optional') {
      try { return canonicalRead(input, { role, kind }); }
      catch { return canonicalWrite(input, { role, createParents: false, kind }); }
    }
    return canonicalRead(input, { role, kind });
  }

  /**
   * Probe existence without escaping the WorkspaceIO authority. Missing paths
   * return false; symlinks, type mismatches and paths outside an allowed root
   * remain policy errors instead of being mistaken for free destinations.
   */
  function exists(input, { role = 'workspace-input', kind = 'any' } = {}) {
    const safeRole = normalizeRole(role);
    const absolute = path.resolve(input);
    if (!rootForLexical(absolute)) {
      throw new WorkspaceIOError(safeRole, 'path is outside allowed roots');
    }
    try {
      canonicalRead(absolute, { role: safeRole, kind });
      return true;
    } catch (error) {
      try {
        lstatSync(absolute);
      } catch (probeError) {
        if (probeError?.code === 'ENOENT') {
          // ENOENT only proves that the leaf is missing. Resolve the deepest
          // existing parent as well so an escaping symlink cannot turn a
          // policy failure into an apparently free destination.
          canonicalWrite(absolute, { role: safeRole, createParents: false, kind });
          return false;
        }
      }
      throw error;
    }
  }

  function read(input, { role = 'workspace-input', maxBytes = effectiveLimits.binaryBytes, encoding = null } = {}) {
    const opened = secureOpenRead(input, { role, maxBytes, kind: 'file' });
    try {
      return readFileSync(opened.fd, encoding || undefined);
    } finally {
      closeSync(opened.fd);
    }
  }

  function readText(input, { role = 'text-input', maxBytes = effectiveLimits.textBytes } = {}) {
    return read(input, { role, maxBytes, encoding: 'utf8' });
  }

  function readJson(input, { role = 'json-input', maxBytes = effectiveLimits.jsonBytes } = {}) {
    const text = readText(input, { role, maxBytes });
    return parseBoundedJson(text, { role, limits: { ...effectiveLimits, jsonBytes: maxBytes } });
  }

  function write(input, data, {
    role = 'workspace-output',
    mode = 0o644,
    createParents = false,
    encoding = null,
    exclusive = false,
  } = {}) {
    const safeRole = normalizeRole(role);
    let target = canonicalWrite(input, { role: safeRole, createParents });
    let fd;
    try {
      testHooks.beforeWriteOpen?.(target.canonical);
      const noFollow = constants.O_NOFOLLOW || 0;
      if (target.exists) {
        if (exclusive) throw new WorkspaceIOError(safeRole, 'output already exists');
        fd = openSync(target.canonical, constants.O_WRONLY | noFollow);
      } else {
        try {
          fd = openSync(target.canonical, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
        } catch (error) {
          if (error?.code !== 'EEXIST' || exclusive) throw error;
          target = canonicalWrite(input, { role: safeRole, createParents });
          fd = openSync(target.canonical, constants.O_WRONLY | noFollow);
        }
      }
      const opened = fstatSync(fd);
      const actual = canonicalRead(target.canonical, { role: safeRole, kind: 'file' });
      if (!inodeMatches(opened, lstatSync(actual.canonical))) {
        throw new WorkspaceIOError(safeRole, 'path changed while it was opened');
      }
      ftruncateSync(fd, 0);
      writeFileSync(fd, data, encoding ? { encoding } : undefined);
      return actual.canonical;
    } catch (error) {
      if (error instanceof WorkspaceIOError) throw error;
      throw new WorkspaceIOError(safeRole, 'path could not be opened safely');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Replace one regular Workspace file atomically. Every byte reaches a new,
   * fsynced sibling before rename is the sole commit point; failures before
   * that point leave the previous target untouched and remove the stage.
   */
  function replace(input, data, {
    role = 'workspace-output',
    mode = 0o644,
    createParents = false,
    encoding = null,
  } = {}) {
    const safeRole = normalizeRole(role);
    const target = canonicalWrite(input, { role: safeRole, createParents, kind: 'file' });
    const parent = path.dirname(target.canonical);
    const staged = path.join(parent,
      `.${path.basename(target.canonical)}.${process.pid}.${randomUUID()}.tmp`);
    const original = target.exists ? lstatSync(target.canonical) : null;
    let fd;
    let ownsStage = false;
    try {
      testHooks.beforeReplaceOpen?.(staged, target.canonical);
      fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW || 0), mode);
      ownsStage = true;
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new WorkspaceIOError(safeRole, 'atomic stage is not a regular file');
      const actualStage = canonicalRead(staged, { role: safeRole, kind: 'file' });
      if (!inodeMatches(opened, lstatSync(actualStage.canonical))) {
        throw new WorkspaceIOError(safeRole, 'atomic stage changed while it was opened');
      }
      writeFileSync(fd, data, encoding ? { encoding } : undefined);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      testHooks.beforeReplaceCommit?.(staged, target.canonical);
      const current = canonicalWrite(input, { role: safeRole, createParents: false, kind: 'file' });
      if (current.canonical !== target.canonical || current.exists !== target.exists) {
        throw new WorkspaceIOError(safeRole, 'target changed before atomic commit');
      }
      if (original && !inodeMatches(original, lstatSync(current.canonical))) {
        throw new WorkspaceIOError(safeRole, 'target changed before atomic commit');
      }
      const stagedMetadata = lstatSync(staged);
      if (!stagedMetadata.isFile() || stagedMetadata.isSymbolicLink()
        || !inodeMatches(opened, stagedMetadata)) {
        throw new WorkspaceIOError(safeRole, 'atomic stage changed before commit');
      }
      renameSync(staged, target.canonical);
      ownsStage = false;
      // renameSync is the commit point. No fallible work follows it.
      return target.canonical;
    } catch (error) {
      if (error instanceof WorkspaceIOError) throw error;
      throw new WorkspaceIOError(safeRole, 'atomic replacement failed');
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (ownsStage) {
        try { unlinkSync(staged); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
  }

  return Object.freeze({
    roots: Object.freeze(roots.map(({ canonical }) => canonical)),
    limits: effectiveLimits,
    authorizePath,
    exists,
    ensureDirectory,
    read,
    readText,
    readJson,
    write,
    replace,
  });
}

export function createWorkspaceIOFromEnvironment(env = process.env, { fallbackRoot = process.cwd() } = {}) {
  const configured = parseWorkspaceRoots(env.FIGMA_BRIDGE_WORKSPACE_ROOTS);
  const [root = fallbackRoot, ...extraRoots] = configured;
  return createWorkspaceIO({ root, extraRoots });
}

let defaultWorkspaceIO = null;

/** Shared engine-side authority, initialized lazily after the Adapter has set
 * its environment. Direct CLI use falls back to the CLI launch directory. */
export function workspaceIO() {
  if (!defaultWorkspaceIO) defaultWorkspaceIO = createWorkspaceIOFromEnvironment();
  return defaultWorkspaceIO;
}
