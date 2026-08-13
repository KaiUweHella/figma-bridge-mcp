// Capability Catalog for every Figma Command exposed through figma_run.
//
// Callers ask behavioural questions through the exported Interface; the
// descriptor Implementation stays private. This concentrates allowlisting,
// mutation safety, targeting, retry, timeout, path and background-job policy
// without making every Adapter understand the catalog schema.
import path from 'node:path';
import { homedir } from 'node:os';

const readGroup = (summary, readSubcommands, extra = {}) => ({
  summary, mutation: 'group', readSubcommands: new Set(readSubcommands), ...extra,
});

const COMMANDS = Object.freeze({
  render: { summary: 'Render JSX into Figma or print a semantic browser capture expression', mutation: 'render', timeout: 'long', target: 'conditional', path: 'render-inputs' },
  'render-batch': { summary: 'Render several JSX frames into Figma', mutation: 'write', timeout: 'long', path: 'render-inputs' },
  combos: { summary: 'Generate component variant combinations', mutation: 'write' },
  sizes: { summary: 'Generate component size variants', mutation: 'write' },
  node: readGroup('Inspect or mutate nodes', ['tree', 'bindings', 'css'], { path: 'node-inputs' }),
  component: readGroup('Manage component properties and variants', ['list', 'main']),
  tokens: { summary: 'Read, generate or sync design tokens', mutation: 'tokens', path: 'token-files' },
  var: readGroup('Manage local variables', ['list', 'find', 'show', 'resolve', 'publish-status']),
  col: readGroup('Manage variable collections', ['list', 'show', 'publish-status']),
  style: readGroup('Manage local paint, text, effect, and grid styles', ['list', 'show', 'consumers', 'publish-status']),
  library: readGroup('Discover enabled libraries and import published assets', ['collections', 'variables']),
  prototype: readGroup('Inspect or manage native prototype reactions', ['inspect']),
  measure: readGroup('Inspect or manage Dev Mode measurements', ['list']),
  shader: readGroup('Discover, import, and apply native shaders', ['list']),
  layout: { summary: 'Inspect or manage native auto-layout features', mutation: 'layout' },
  slot: readGroup('Create, configure, validate, or reset component slots', ['inspect', 'validate']),
  draw: readGroup('Inspect or manage native Figma Draw features', ['inspect']),
  section: readGroup('Inspect or manage Figma sections', ['list']),
  grid: readGroup('Inspect or manage layout grids', ['list']),
  dev: readGroup('Inspect or manage dev-resource links', ['list']),
  annotate: readGroup('Inspect or manage annotations and categories', ['list', 'categories']),
  a11y: { summary: 'Run accessibility checks', mutation: 'read' },
  canvas: readGroup('Inspect pages or mutate the canvas', ['info', 'pages', 'page', 'next']),
  find: { summary: 'Find nodes by name', mutation: 'read' },
  verify: { summary: 'Capture a verification screenshot', mutation: 'read', path: 'verify-image', retry: 'safe-read' },
  inspect: { summary: 'Inspect one node as structured facts', mutation: 'read', retry: 'safe-read' },
  export: { summary: 'Export design facts, images and assets', mutation: 'read' },
  gradient: { summary: 'Extract and apply gradients', mutation: 'gradient', target: 'conditional', path: 'gradient-input' },
  pin: { summary: 'Pin nodes to parent edges', mutation: 'write' },
  api: { summary: 'Read the offline Figma Plugin reference', mutation: 'read', target: 'none' },
  import: { summary: 'Import a design source into Figma', mutation: 'write', path: 'import-files' },
  motion: readGroup('Inspect or manage motion data', ['styles', 'inspect'], { path: 'motion-inputs' }),
  extract: { summary: 'Extract the open file into DESIGN.md', mutation: 'read', path: 'design-doc' },
  spec: { summary: 'Read or enforce an extracted component spec', mutation: 'read', target: 'conditional', path: 'spec-file' },
  analyze: { summary: 'Analyze colors, typography and spacing', mutation: 'read' },
  font: readGroup('Inspect typography, bind variables, or preserve variable-axis metadata', ['inspect', 'axes'], { retry: 'safe-read' }),
  map: { summary: 'Map Figma components to code', mutation: 'read', path: 'map-file' },
  link: readGroup('Link durable Design Entities across code and Figma', ['inspect', 'list', 'configure', 'status', 'accept', 'context'], {
    target: 'conditional', path: 'design-link-registry',
  }),
  'verify-build': { summary: 'Verify code against exported design facts', mutation: 'read', target: 'conditional', path: 'verify-build' },
  history: readGroup('Create or compare structural snapshots and save named Figma versions', ['snapshot', 'list', 'diff'], { path: 'history-output' }),
  jam: readGroup('Inspect or author FigJam boards', ['board']),
  slides: readGroup('Inspect or author Figma Slides decks (beta)', ['inspect']),
  kit: { summary: 'Prepare a design system for agent use', mutation: 'read', timeout: 'long', path: 'kit-files' },
});

const HELP_TOKENS = new Set(['--help', '-h']);
const VALUE_FLAGS = new Set(['--sections', '--pages', '-s', '--scale', '-f', '--format', '-d', '--depth']);
const UNKNOWN = Object.freeze({
  name: 'unknown',
  available: false,
  mutatesDesign: true,
  target: 'figma',
  retry: 'never',
  timeoutClass: 'default',
  execution: 'foreground',
  pathPolicy: 'none',
  summary: 'Unknown command',
});
const TOP_LEVEL_HELP = Object.freeze({
  name: '--help',
  available: true,
  mutatesDesign: false,
  target: 'none',
  retry: 'never',
  timeoutClass: 'default',
  execution: 'foreground',
  pathPolicy: 'none',
  summary: 'List available Figma Commands',
});

function hasHelp(args) {
  return args.some((arg) => HELP_TOKENS.has(arg));
}

function mutatesDesign(entry, args) {
  if (!args.length || hasHelp(args)) return false;
  const sub = args[1];
  if (entry.mutation === 'write') return true;
  if (entry.mutation === 'render') return !args.includes('--print-browser-capture') && !args.includes('--structural-gate');
  if (entry.mutation === 'read') return false;
  if (entry.mutation === 'gradient') {
    return sub !== 'extract' || args.includes('--apply-to');
  }
  if (entry.mutation === 'layout') return !(sub === 'grid' && args[2] === 'inspect');
  const subIsAction = sub !== undefined && !sub.startsWith('-');
  if (entry.mutation === 'tokens') {
    if (sub === 'sync' || sub === 'rebind') return args.includes('--apply');
    return subIsAction && sub !== 'overlap';
  }
  if (entry.mutation === 'group') {
    return subIsAction && !entry.readSubcommands.has(sub);
  }
  return true;
}

function targetPolicy(name, entry, args) {
  if (hasHelp(args)) return 'none';
  if (entry.target !== 'conditional') return entry.target || 'figma';
  if (name === 'spec') return args.includes('--check') ? 'figma' : 'none';
  if (name === 'verify-build') return args.includes('--node') ? 'figma' : 'none';
  if (name === 'gradient') return args[1] === 'extract' && !args.includes('--apply-to') ? 'none' : 'figma';
  if (name === 'link') return ['list', 'configure'].includes(args[1]) ? 'none' : 'figma';
  if (name === 'render') return args.includes('--print-browser-capture') || args.includes('--structural-gate') ? 'none' : 'figma';
  return 'figma';
}

function specializedPolicy(name, entry, args) {
  const sub = args[1];
  let execution = 'foreground';
  let timeoutClass = entry.timeout || 'default';
  let pathPolicy = entry.path || 'none';
  let retry = entry.retry || 'never';
  if (name === 'export') {
    if (sub === 'assets') {
      execution = 'background';
      timeoutClass = 'background';
      pathPolicy = 'assets-dir';
    } else if (sub === 'video') {
      pathPolicy = 'video-output';
    } else if (sub === 'node' || sub === 'screenshot') {
      pathPolicy = 'export-image';
    } else if (sub === 'code-spec') {
      retry = 'safe-read';
    } else if (sub === 'dtcg') {
      pathPolicy = 'dtcg-output';
    } else if (sub === 'node-json') {
      pathPolicy = 'node-json-output';
    }
  }
  return { execution, timeoutClass, pathPolicy, retry };
}

/** Resolve the private policy for one concrete argv. */
function commandCapability(args) {
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string') {
    return UNKNOWN;
  }
  const name = args[0];
  if (HELP_TOKENS.has(name)) return Object.freeze({ ...TOP_LEVEL_HELP, name });
  const entry = COMMANDS[name];
  if (!entry) return Object.freeze({ ...UNKNOWN, name });
  const specialized = specializedPolicy(name, entry, args);
  return Object.freeze({
    name,
    available: true,
    mutatesDesign: mutatesDesign(entry, args),
    target: targetPolicy(name, entry, args),
    retry: specialized.retry,
    timeoutClass: specialized.timeoutClass,
    execution: specialized.execution,
    pathPolicy: specialized.pathPolicy,
    summary: entry.summary,
  });
}

function allowedCommandNames() {
  return Object.freeze(Object.keys(COMMANDS));
}

function isBackgroundCommand(args) {
  return commandCapability(args).execution === 'background';
}

function acceptedExitCodes(args) {
  if (args?.[0] === 'history' && args?.[1] === 'diff') return [0, 1];
  // Exit 1 is a valid verify report containing findings, not a transport
  // failure. MCP callers need the report in order to fix those findings.
  if (args?.[0] === 'verify-build') return [0, 1];
  if (args?.[0] === 'render' && args.includes('--structural-gate')) return [0, 1];
  return [0];
}

function commandHelpIndex() {
  return [...allowedCommandNames()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${name} — ${COMMANDS[name].summary}`)
    .join('\n');
}

function absolute(baseDir, value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function localPath(baseDir, value) {
  return isUrl(value) ? value : absolute(baseDir, value);
}

function pathFlag(args, flags, baseDir) {
  const names = new Set(flags);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    const combined = arg.match(/^(--?[a-z-]+)=(.*)$/i);
    if (combined && names.has(combined[1]) && combined[2]) {
      const value = localPath(baseDir, combined[2]);
      args[index] = `${combined[1]}=${value}`;
      return { value };
    }
    if (names.has(arg) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('-')) {
      args[index + 1] = localPath(baseDir, args[index + 1]);
      return { value: args[index + 1] };
    }
  }
  return null;
}

function outputFlag(args, baseDir, defaultValue) {
  const index = args.findIndex((arg) => arg === '-o' || arg === '--output');
  if (index !== -1 && typeof args[index + 1] === 'string') {
    args[index + 1] = absolute(baseDir, args[index + 1]);
    return args[index + 1];
  }
  const combined = args.findIndex((arg) => /^(--output|-o)=/.test(arg));
  if (combined !== -1) {
    const [flag, ...rest] = args[combined].split('=');
    const value = absolute(baseDir, rest.join('='));
    args[combined] = `${flag}=${value}`;
    return value;
  }
  const value = absolute(baseDir, defaultValue);
  args.push('-o', value);
  return value;
}

function optionalOutputFlag(args, baseDir) {
  const index = args.findIndex((arg) => arg === '-o' || arg === '--output');
  if (index !== -1 && typeof args[index + 1] === 'string') {
    args[index + 1] = absolute(baseDir, args[index + 1]);
    return args[index + 1];
  }
  const combined = args.findIndex((arg) => /^(--output|-o)=/.test(arg));
  if (combined === -1) return null;
  const [flag, ...rest] = args[combined].split('=');
  const value = absolute(baseDir, rest.join('='));
  args[combined] = `${flag}=${value}`;
  return value;
}

function normalizeVerifyBuild(args, baseDir) {
  const pathFlags = new Set(['--assets', '--compare', '--design', '--diff-out']);
  const skipValue = new Set(['--node', '--max-diff']);
  let positionalDone = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    const combined = arg.match(/^(--[a-z-]+)=(.*)$/);
    if (combined) {
      if (pathFlags.has(combined[1])) args[index] = `${combined[1]}=${absolute(baseDir, combined[2])}`;
      continue;
    }
    if (pathFlags.has(arg)) {
      if (typeof args[index + 1] === 'string') args[index + 1] = absolute(baseDir, args[index + 1]);
      index++;
      continue;
    }
    if (skipValue.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    if (!positionalDone) { args[index] = absolute(baseDir, arg); positionalDone = true; }
  }
}

/** Normalize all project-relative paths named by the command policy. */
function prepareCommandArgs(rawArgs, baseDir = process.cwd()) {
  const args = [...rawArgs];
  const capability = commandCapability(args);
  let outputPath = null;
  let workspace = 'none';
  const markRead = () => { if (workspace === 'none') workspace = 'read'; };
  const markWrite = (value = null) => { workspace = 'write'; if (value) outputPath = value; };
  switch (capability.pathPolicy) {
    case 'assets-dir':
      outputPath = outputFlag(args, baseDir, 'assets');
      markWrite(outputPath);
      break;
    case 'export-image':
      outputPath = outputFlag(args, baseDir, args[1] === 'node' ? 'node-export.png' : 'screenshot.png');
      markWrite(outputPath);
      break;
    case 'video-output': {
      let format = 'mp4';
      for (let index = 2; index < args.length; index++) {
        const combined = args[index].match(/^(?:--format|-f)=(.+)$/);
        if (combined) format = combined[1].toLowerCase();
        if ((args[index] === '--format' || args[index] === '-f') && args[index + 1]) format = args[index + 1].toLowerCase();
      }
      outputPath = outputFlag(args, baseDir, `video.${format}`);
      markWrite(outputPath);
      break;
    }
    case 'dtcg-output': {
      const value = args[2];
      const nodeReference = typeof value === 'string' && /^(\d+[:-]\d+$|I\d|https?:\/\/)/.test(value);
      if (typeof value === 'string' && !nodeReference) {
        args[2] = absolute(baseDir, value);
        markWrite(args[2]);
      }
      break;
    }
    case 'node-json-output': {
      const output = optionalOutputFlag(args, baseDir);
      if (output) markWrite(output);
      break;
    }
    case 'design-doc': {
      for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (VALUE_FLAGS.has(arg)) { index++; continue; }
        if (arg.startsWith('-')) continue;
        args[index] = absolute(baseDir, arg);
        outputPath = args[index];
        markWrite(outputPath);
        break;
      }
      if (!outputPath) {
        outputPath = absolute(baseDir, 'DESIGN.md');
        args.push(outputPath);
        markWrite(outputPath);
      }
      break;
    }
    case 'map-file':
      outputPath = outputFlag(args, baseDir, 'figma-map.json');
      markWrite(outputPath);
      break;
    case 'design-link-registry': {
      const supplied = pathFlag(args, ['--manifest'], baseDir);
      const manifest = supplied?.value || absolute(baseDir, 'figma-bridge.json');
      if (!supplied) args.push('--manifest', manifest);
      outputPath = manifest;
      if (['set', 'accept', 'configure'].includes(args[1])) markWrite(manifest);
      else markRead();
      if (args[1] === 'accept' && pathFlag(args, ['--compare'], baseDir)) markRead();
      break;
    }
    case 'verify-build':
      normalizeVerifyBuild(args, baseDir);
      markRead();
      break;
    case 'verify-image': {
      const index = args.findIndex((arg) => arg === '--save');
      if (index !== -1 && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('-')) {
        args[index + 1] = absolute(baseDir, args[index + 1]);
        outputPath = args[index + 1];
        markWrite(outputPath);
      }
      break;
    }
    case 'render-inputs': {
      if (pathFlag(args, ['--icons'], baseDir)) markRead();
      if (pathFlag(args, ['--dom-capture'], baseDir)) markRead();
      break;
    }
    case 'node-inputs': {
      if (args[1] === 'set-image' && typeof args[3] === 'string') {
        args[3] = absolute(baseDir, args[3]);
        markRead();
      }
      break;
    }
    case 'gradient-input': {
      if (args[1] === 'extract' && typeof args[2] === 'string') {
        args[2] = absolute(baseDir, args[2]);
        markRead();
      }
      break;
    }
    case 'token-files': {
      if (['import', 'sync', 'import-design-md'].includes(args[1]) && typeof args[2] === 'string') {
        args[2] = absolute(baseDir, args[2]);
        markRead();
      }
      const lockfile = pathFlag(args, ['--lockfile'], baseDir);
      if (lockfile) {
        markRead();
        if (args[1] === 'sync') markWrite(lockfile.value);
      } else if (args[1] === 'sync') {
        // Sync persists its default lockfile beside the token file.
        markWrite();
      }
      break;
    }
    case 'import-files': {
      if (typeof args[1] === 'string' && !isUrl(args[1])) { args[1] = absolute(baseDir, args[1]); markRead(); }
      const saved = pathFlag(args, ['--save'], baseDir);
      if (saved) markWrite(saved.value);
      break;
    }
    case 'motion-inputs': {
      if (args[1] === 'apply' && typeof args[2] === 'string' && !args[2].trimStart().startsWith('{')) {
        args[2] = absolute(baseDir, args[2]);
        markRead();
      }
      break;
    }
    case 'spec-file': {
      markRead();
      if (pathFlag(args, ['-f', '--file'], baseDir)) markRead();
      break;
    }
    case 'history-output': {
      if (args[1] === 'diff') {
        const changelog = pathFlag(args, ['--changelog'], baseDir);
        if (changelog) markWrite(changelog.value);
      }
      break;
    }
    case 'kit-files': {
      if (args[1] === 'init') {
        if (typeof args[2] === 'string' && !args[2].startsWith('-')) args[2] = absolute(baseDir, args[2]);
        const storybook = pathFlag(args, ['--storybook'], baseDir);
        if (storybook && isUrl(storybook.value)) {
          // URLs are external inputs, not workspace reads.
        } else if (storybook) markRead();
        markWrite(args[2] || absolute(baseDir, '.'));
      }
      break;
    }
    default:
      break;
  }
  return { args, outputPath, capability, workspace };
}

function backgroundJobIdentity(args, fileKey) {
  if (!isBackgroundCommand(args)) return null;
  return JSON.stringify({ fileKey: fileKey || null, args });
}

function sharedEffect(args) {
  if (hasHelp(args) || args[0] !== 'history') return 'none';
  if (args[1] === 'snapshot') return 'write';
  if (args[1] === 'list' || args[1] === 'diff') return 'read';
  return 'none';
}

function availabilityFor(args, capability) {
  if (!capability.available) return { transport: 'none', editor: 'either', feature: null };
  if (capability.target === 'none') {
    return {
      transport: 'none',
      editor: 'either',
      feature: args[0] === 'api' ? 'offline-docs' : null,
    };
  }
  return {
    transport: 'plugin',
    editor: args[0] === 'jam' ? 'figjam' : args[0] === 'slides' ? 'slides' : 'figma',
    feature: args[0] === 'motion' ? 'motion-beta'
      : args[0] === 'slides' ? 'slides-beta'
        : args[0] === 'map' ? 'storybook'
          : args[0] === 'link' ? 'design-links' : null,
  };
}

/**
 * Resolve one Figma Command completely for an Adapter.
 *
 * This is the primary Interface: policy callers receive decisions, never the
 * catalog's matcher rules. Relative paths are anchored to workspaceDir.
 */
export function planFigmaCommand(rawArgs, {
  adapter = 'mcp',
  workspaceDir = process.cwd(),
  fileKey = null,
} = {}) {
  const input = Array.isArray(rawArgs) ? rawArgs : [];
  const prepared = prepareCommandArgs(input, workspaceDir);
  const capability = prepared.capability;
  const effects = Object.freeze({
    figma: capability.mutatesDesign ? 'write' : capability.target === 'none' ? 'none' : 'read',
    workspace: hasHelp(prepared.args) ? 'none' : prepared.workspace,
    shared: sharedEffect(prepared.args),
  });
  const target = Object.freeze(
    capability.target === 'none'
      ? { kind: 'none', fileKey: null }
      : { kind: 'plugin-file', fileKey: fileKey || null },
  );
  const jobKey = backgroundJobIdentity(prepared.args, target.fileKey);
  const retry = capability.mutatesDesign ? 'never' : capability.retry;
  const plan = {
    id: capability.name || 'unknown',
    adapter,
    allowed: capability.available && adapter === 'mcp',
    argv: Object.freeze(prepared.args),
    target,
    effects,
    confirmation: capability.mutatesDesign ? 'configured' : 'none',
    execution: Object.freeze({
      mode: capability.execution === 'background' ? 'tracked-job' : 'foreground',
      timeout: capability.timeoutClass,
      retry,
      idempotence: jobKey ? 'deduped' : retry === 'safe-read' ? 'read-only' : 'unknown',
      okExitCodes: Object.freeze(acceptedExitCodes(prepared.args)),
      jobKey,
    }),
    availability: Object.freeze(availabilityFor(prepared.args, capability)),
    outputs: Object.freeze(prepared.outputPath
      ? [Object.freeze({ role: capability.pathPolicy, path: prepared.outputPath })]
      : []),
    summary: capability.summary,
  };
  return Object.freeze(plan);
}

/** Secondary Interface for help, exposure and generated contract tests. */
export function listFigmaCapabilities({ adapter = 'mcp', formatted = false } = {}) {
  if (formatted) return commandHelpIndex();
  if (adapter !== 'mcp') return Object.freeze([]);
  return Object.freeze(
    [...allowedCommandNames()]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => Object.freeze({ name, summary: COMMANDS[name].summary })),
  );
}
