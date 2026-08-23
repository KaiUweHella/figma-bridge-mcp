// Capability Catalog for every Figma Command exposed through figma_run.
//
// Callers ask behavioural questions through the exported Interface; the
// descriptor Implementation stays private. This concentrates allowlisting,
// mutation safety, targeting, retry, timeout, path and background-job policy
// without making every Adapter understand the catalog schema.
import path from 'node:path';
import { homedir } from 'node:os';
import {
  acceptsAssetExportArgv,
  assetExportArgvFromRequest,
  parseAssetExportRequest,
} from '../engine/src/application/asset-export-request.js';
import { acceptsDesignContractArgv } from '../engine/src/application/design-contract-request.js';
import { acceptsDesignLinkArgv } from '../engine/src/application/design-link-request.js';
import {
  acceptsNodeTextArgv,
  nodeTextFigmaUrlFileKeyFromArgv,
  nodeTextArgvFromRequest,
  parseNodeTextRequest,
} from '../engine/src/application/node-text-request.js';
import {
  acceptsSemanticRenderArgv,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderPolicyFromArgv,
  semanticRenderRequestFromArgv,
} from '../engine/src/application/semantic-render-request.js';
import { resolveFigmaTarget } from './figma-target.js';
import { resolveFigmaCommandAction } from './figma-command-grammar.js';

const readGroup = (summary, readSubcommands, extra = {}) => ({
  summary, mutation: 'group', readSubcommands: new Set(readSubcommands), ...extra,
});

const COMMANDS = Object.freeze({
  render: { summary: 'Render JSX into Figma or print a semantic browser capture expression', mutation: 'render', timeout: 'long', target: 'conditional', path: 'render-inputs' },
  'render-batch': { summary: 'Render several JSX frames into Figma', mutation: 'write', timeout: 'long', path: 'render-inputs' },
  create: {
    summary: 'Create typed Figma primitives, optionally inside an existing parent',
    mutation: 'write',
  },
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
  contract: { summary: 'Capture or check canonical Design Contracts for linked entities', mutation: 'read', path: 'design-contract' },
  'verify-build': { summary: 'Verify code against exported design facts', mutation: 'read', target: 'conditional', path: 'verify-build' },
  history: readGroup('Create or compare structural snapshots and save named Figma versions', ['snapshot', 'list', 'diff'], { path: 'history-output' }),
  jam: readGroup('Inspect or author FigJam boards', ['board']),
  slides: readGroup('Inspect or author Figma Slides decks (beta)', ['inspect']),
  kit: { summary: 'Prepare a design system for agent use', mutation: 'read', timeout: 'long', path: 'kit-files' },
});

const HELP_TOKENS = new Set(['--help', '-h']);
const COMMAND_PLANS = new WeakSet();
const CLI_COMMAND_APPLICATIONS = new Set([
  'contract.capture', 'contract.check', 'export.assets', 'link.inspect', 'link.set', 'node.set-text', 'render',
]);
const VALUE_FLAGS = new Set(['--sections', '--pages', '-s', '--scale', '-f', '--format', '-d', '--depth']);
const UNKNOWN = Object.freeze({
  name: 'unknown',
  actionId: 'unknown',
  help: false,
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
  actionId: 'help',
  help: true,
  available: true,
  mutatesDesign: false,
  target: 'none',
  retry: 'never',
  timeoutClass: 'default',
  execution: 'foreground',
  pathPolicy: 'none',
  summary: 'List available Figma Commands',
});

function mutatesDesign(entry, args) {
  if (!args.length) return false;
  const sub = args[1];
  if (entry.mutation === 'write') return true;
  if (entry.mutation === 'render') return semanticRenderPolicyFromArgv(args).mutatesDesign;
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
  if (entry.target !== 'conditional') return entry.target || 'figma';
  if (name === 'spec') return args.includes('--check') ? 'figma' : 'none';
  if (name === 'verify-build') return args.includes('--node') ? 'figma' : 'none';
  if (name === 'gradient') return args[1] === 'extract' && !args.includes('--apply-to') ? 'none' : 'figma';
  if (name === 'link') return ['list', 'configure'].includes(args[1]) ? 'none' : 'figma';
  if (name === 'render') return semanticRenderPolicyFromArgv(args).target;
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
  if (name === 'link' && sub === 'inspect') retry = 'safe-read';
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
  const action = resolveFigmaCommandAction(args);
  if (!action.accepted) {
    return action.reason === 'unknown-option'
      ? Object.freeze({ ...UNKNOWN, name, mutatesDesign: false, target: 'none' })
      : Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'link' && !action.help && !acceptsDesignLinkArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'contract' && !action.help && !acceptsDesignContractArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'export' && args[1] === 'assets' && !action.help && !acceptsAssetExportArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'set-text' && !action.help && !acceptsNodeTextArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'render' && !acceptsSemanticRenderArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  const specialized = action.help
    ? { execution: 'foreground', timeoutClass: 'default', pathPolicy: 'none', retry: 'never' }
    : specializedPolicy(name, entry, args);
  return Object.freeze({
    name,
    actionId: action.actionId,
    help: action.help,
    available: true,
    mutatesDesign: action.help ? false : mutatesDesign(entry, args),
    target: action.help ? 'none' : targetPolicy(name, entry, args),
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
  if (args?.[0] === 'contract' && args?.[1] === 'check') return [0, 1];
  // Exit 1 is a valid verify report containing findings, not a transport
  // failure. MCP callers need the report in order to fix those findings.
  if (args?.[0] === 'verify-build') return [0, 1];
  if (args?.[0] === 'render' && acceptsSemanticRenderArgv(args)) {
    const route = semanticRenderArgvRoute(args);
    if (route.kind === 'simple' || route.reason === 'structural-gate') return [0, 1];
  }
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
    if (arg === '--') break;
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

function normalizeVerifyBuild(args, baseDir, notePath) {
  const pathFlags = new Set(['--assets', '--compare', '--design', '--diff-out']);
  const skipValue = new Set(['--node', '--max-diff']);
  let positionalDone = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    const combined = arg.match(/^(--[a-z-]+)=(.*)$/);
    if (combined) {
      if (pathFlags.has(combined[1])) {
        const value = absolute(baseDir, combined[2]);
        args[index] = `${combined[1]}=${value}`;
        notePath(value, combined[1] === '--diff-out' ? 'write' : 'read', `verify-build-${combined[1].slice(2)}`, combined[1] === '--assets' ? 'any' : 'file');
      }
      continue;
    }
    if (pathFlags.has(arg)) {
      if (typeof args[index + 1] === 'string') {
        args[index + 1] = absolute(baseDir, args[index + 1]);
        notePath(args[index + 1], arg === '--diff-out' ? 'write' : 'read', `verify-build-${arg.slice(2)}`, arg === '--assets' ? 'any' : 'file');
      }
      index++;
      continue;
    }
    if (skipValue.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    if (!positionalDone) {
      args[index] = absolute(baseDir, arg);
      notePath(args[index], 'read', 'verify-build-project', 'directory');
      positionalDone = true;
    }
  }
}

/** Normalize all project-relative paths named by the command policy. */
function prepareCommandArgs(rawArgs, baseDir = process.cwd()) {
  const args = [...rawArgs];
  const capability = commandCapability(args);
  let figmaUrlArgs = rawArgs;
  let figmaUrlFileKey = null;
  let outputPath = null;
  let workspace = 'none';
  const paths = [];
  const notePath = (value, access, role, kind = access === 'read' ? 'file' : 'any') => {
    if (typeof value !== 'string' || isUrl(value)) return;
    paths.push(Object.freeze({ path: value, access, role, kind }));
  };
  const markRead = (value = null, role = 'workspace-input', kind = 'file') => {
    if (workspace === 'none') workspace = 'read';
    if (value) notePath(value, 'read', role, kind);
  };
  const markOptionalRead = (value, role = 'workspace-input', kind = 'file') => {
    if (workspace === 'none') workspace = 'read';
    if (value) notePath(value, 'read-optional', role, kind);
  };
  const markWrite = (value = null, role = 'workspace-output', kind = 'any') => {
    workspace = 'write';
    if (value) {
      outputPath = value;
      notePath(value, 'write', role, kind);
    }
  };
  switch (capability.pathPolicy) {
    case 'assets-dir':
      outputPath = outputFlag(args, baseDir, 'assets');
      // Canonical semantic argv gives equivalent default spellings and option
      // order one background identity. The output is already absolute here.
      args.splice(0, args.length, ...assetExportArgvFromRequest(parseAssetExportRequest(args)));
      markWrite(outputPath, 'asset-export-directory', 'directory');
      break;
    case 'export-image':
      outputPath = outputFlag(args, baseDir, args[1] === 'node' ? 'node-export.png' : 'screenshot.png');
      markWrite(outputPath, 'export-image-output');
      break;
    case 'video-output': {
      let format = 'mp4';
      for (let index = 2; index < args.length; index++) {
        const combined = args[index].match(/^(?:--format|-f)=(.+)$/);
        if (combined) format = combined[1].toLowerCase();
        if ((args[index] === '--format' || args[index] === '-f') && args[index + 1]) format = args[index + 1].toLowerCase();
      }
      outputPath = outputFlag(args, baseDir, `video.${format}`);
      markWrite(outputPath, 'video-output');
      break;
    }
    case 'dtcg-output': {
      const value = args[2];
      const nodeReference = typeof value === 'string' && /^(\d+[:-]\d+$|I\d|https?:\/\/)/.test(value);
      if (typeof value === 'string' && !nodeReference) {
        args[2] = absolute(baseDir, value);
        markWrite(args[2], 'dtcg-output');
      }
      break;
    }
    case 'node-json-output': {
      const output = optionalOutputFlag(args, baseDir);
      if (output) markWrite(output, 'node-json-output');
      break;
    }
    case 'design-doc': {
      for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (VALUE_FLAGS.has(arg)) { index++; continue; }
        if (arg.startsWith('-')) continue;
        args[index] = absolute(baseDir, arg);
        outputPath = args[index];
        markWrite(outputPath, 'design-document-output');
        break;
      }
      if (!outputPath) {
        outputPath = absolute(baseDir, 'DESIGN.md');
        args.push(outputPath);
        markWrite(outputPath, 'design-document-output');
      }
      break;
    }
    case 'map-file':
      if (args[1] === 'storybook' && typeof args[2] === 'string' && !isUrl(args[2])) {
        args[2] = absolute(baseDir, args[2]);
        markRead(args[2], 'storybook-source', 'any');
      }
      outputPath = outputFlag(args, baseDir, 'figma-map.json');
      markWrite(outputPath, 'component-map-output');
      break;
    case 'design-link-registry': {
      const supplied = pathFlag(args, ['--manifest'], baseDir);
      const manifest = supplied?.value || absolute(baseDir, 'figma-bridge.json');
      if (!supplied) args.push('--manifest', manifest);
      outputPath = manifest;
      if (['set', 'accept', 'configure'].includes(args[1])) markWrite(manifest, 'design-link-manifest');
      else if (['inspect', 'list'].includes(args[1])) markOptionalRead(manifest, 'design-link-manifest');
      else markRead(manifest, 'design-link-manifest');
      if (args[1] === 'accept') {
        const compare = pathFlag(args, ['--compare'], baseDir);
        if (compare) markRead(compare.value, 'design-link-comparison');
      }
      break;
    }
    case 'design-contract': {
      const suppliedManifest = pathFlag(args, ['--manifest'], baseDir);
      const manifest = suppliedManifest?.value || absolute(baseDir, 'figma-bridge.json');
      if (!suppliedManifest) args.push('--manifest', manifest);
      markRead(manifest, 'design-contract-manifest');
      let file = pathFlag(args, ['--file'], baseDir)?.value;
      if (!file) {
        const slug = String(args[2] || 'entity').replace(/[^a-zA-Z0-9._-]+/g, '_');
        file = absolute(baseDir, path.join('design-contracts', `${slug}.json`));
        args.push('--file', file);
      }
      if (args[1] === 'capture') markWrite(file, 'design-contract-file');
      else markRead(file, 'design-contract-file');
      break;
    }
    case 'verify-build':
      normalizeVerifyBuild(args, baseDir, notePath);
      markRead();
      break;
    case 'verify-image': {
      const index = args.findIndex((arg) => arg === '--save');
      if (index !== -1 && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('-')) {
        args[index + 1] = absolute(baseDir, args[index + 1]);
        outputPath = args[index + 1];
        markWrite(outputPath, 'verification-image-output');
      }
      break;
    }
    case 'render-inputs': {
      if (args[0] === 'render') {
        figmaUrlArgs = [];
        const initialRoute = semanticRenderArgvRoute(args);
        // Browser-capture expression generation returns before every project
        // input in Commander. Keep its Plan honest: unused paths are neither
        // authorized nor reported as effects.
        if (initialRoute.reason === 'browser-capture-expression') break;
        const icons = pathFlag(args, ['--icons'], baseDir);
        if (icons) markRead(icons.value, 'render-icons', 'directory');
        const capture = pathFlag(args, ['--dom-capture'], baseDir);
        if (capture) markRead(capture.value, 'dom-capture');
        if (initialRoute.kind === 'simple') {
          const request = semanticRenderRequestFromArgv(args);
          const manifest = request.manifest
            ? localPath(baseDir, request.manifest)
            : absolute(baseDir, 'figma-bridge.json');
          markOptionalRead(manifest, 'render-manifest');
          markOptionalRead(path.join(path.dirname(manifest), 'figma-map.json'), 'legacy-component-map');
          args.splice(0, args.length, ...semanticRenderArgvFromRequest({ ...request, manifest }));
        } else {
          const suppliedManifest = pathFlag(args, ['--manifest'], baseDir);
          const manifest = suppliedManifest?.value || absolute(baseDir, 'figma-bridge.json');
          if (!suppliedManifest) {
            const terminator = args.indexOf('--');
            args.splice(terminator === -1 ? args.length : terminator, 0, '--manifest', manifest);
          }
          markOptionalRead(manifest, 'render-manifest');
          markOptionalRead(path.join(path.dirname(manifest), 'figma-map.json'), 'legacy-component-map');
        }
        semanticRenderArgvRoute(args);
      } else {
        const icons = pathFlag(args, ['--icons'], baseDir);
        if (icons) markRead(icons.value, 'render-icons', 'directory');
        const capture = pathFlag(args, ['--dom-capture'], baseDir);
        if (capture) markRead(capture.value, 'dom-capture');
      }
      break;
    }
    case 'node-inputs': {
      if (args[1] === 'set-text') {
        // Equivalent node spellings and optional literal delimiters become
        // one semantic argv. The original input remains available separately
        // to Figma Target Context resolution for URL-derived file identity.
        figmaUrlFileKey = nodeTextFigmaUrlFileKeyFromArgv(args);
        figmaUrlArgs = [];
        args.splice(0, args.length, ...nodeTextArgvFromRequest(parseNodeTextRequest(args)));
      } else if (args[1] === 'set-image' && typeof args[3] === 'string') {
        args[3] = absolute(baseDir, args[3]);
        markRead(args[3], 'node-image');
      }
      break;
    }
    case 'gradient-input': {
      if (args[1] === 'extract' && typeof args[2] === 'string') {
        args[2] = absolute(baseDir, args[2]);
        markRead(args[2], 'gradient-image');
      }
      break;
    }
    case 'token-files': {
      if (['import', 'sync', 'import-design-md'].includes(args[1]) && typeof args[2] === 'string') {
        args[2] = absolute(baseDir, args[2]);
        markRead(args[2], 'token-file');
      }
      const lockfile = pathFlag(args, ['--lockfile'], baseDir);
      if (lockfile) {
        // A missing lockfile is valid on first sync, so authorize it as a
        // write target. Existing files are reopened securely by WorkspaceIO.
        if (args[1] === 'sync') markWrite(lockfile.value, 'token-lockfile');
        else markRead(lockfile.value, 'token-lockfile');
      } else if (args[1] === 'sync') {
        // Sync persists its default lockfile beside the token file.
        const defaultLock = absolute(baseDir, path.join(path.dirname(args[2]), 'figma-tokens.lock.json'));
        markWrite(defaultLock, 'token-lockfile');
      }
      break;
    }
    case 'import-files': {
      if (typeof args[1] === 'string' && !isUrl(args[1])) {
        args[1] = absolute(baseDir, args[1]);
        markRead(args[1], 'import-source', 'any');
      }
      const saved = pathFlag(args, ['--save'], baseDir);
      if (saved) markWrite(saved.value, 'import-output');
      else markWrite(absolute(baseDir, 'DESIGN-storybook.md'), 'import-output');
      break;
    }
    case 'motion-inputs': {
      if (args[1] === 'apply' && typeof args[2] === 'string' && !args[2].trimStart().startsWith('{')) {
        args[2] = absolute(baseDir, args[2]);
        markRead(args[2], 'motion-file');
      }
      break;
    }
    case 'spec-file': {
      const supplied = pathFlag(args, ['-f', '--file'], baseDir);
      if (supplied) markRead(supplied.value, 'design-spec-file');
      else markRead(absolute(baseDir, '.'), 'design-spec-search', 'directory');
      break;
    }
    case 'history-output': {
      if (args[1] === 'diff') {
        const changelog = pathFlag(args, ['--changelog'], baseDir);
        if (changelog) markWrite(changelog.value, 'history-changelog');
      }
      break;
    }
    case 'kit-files': {
      if (args[1] === 'init') {
        if (typeof args[2] === 'string' && !args[2].startsWith('-')) args[2] = absolute(baseDir, args[2]);
        const projectRoot = args[2] || absolute(baseDir, '.');
        let out = 'design';
        for (let index = 2; index < args.length; index++) {
          const combined = args[index].match(/^--out=(.*)$/);
          if (combined) out = combined[1];
          if (args[index] === '--out' && typeof args[index + 1] === 'string') out = args[index + 1];
        }
        const storybook = pathFlag(args, ['--storybook'], baseDir);
        if (storybook && isUrl(storybook.value)) {
          // URLs are external inputs, not workspace reads.
        } else if (storybook) markRead(storybook.value, 'storybook-source', 'any');
        markWrite(projectRoot, 'kit-project-directory', 'directory');
        notePath(path.resolve(projectRoot, out), 'write', 'kit-output-directory', 'directory');
      }
      break;
    }
    default:
      break;
  }
  return {
    args,
    outputPath,
    capability,
    workspace,
    paths: Object.freeze(paths),
    figmaUrlArgs,
    figmaUrlFileKey,
  };
}

function backgroundJobIdentity(args, fileKey) {
  if (!isBackgroundCommand(args)) return null;
  return JSON.stringify({ fileKey: fileKey || null, args });
}

function flagValue(args, flag) {
  for (let index = 1; index < args.length; index++) {
    const value = args[index];
    if (value === flag) return args[index + 1] || null;
    if (typeof value === 'string' && value.startsWith(`${flag}=`)) return value.slice(flag.length + 1) || null;
  }
  return null;
}

/** External outbound access only; authenticated localhost transport is separate. */
function networkEffect(args) {
  if (args[0] === 'api' && args[1] === 'setup') return 'read';
  if (args[0] === 'map' && args[1] === 'storybook' && isUrl(args[2] || '')) return 'read';
  if (args[0] === 'import' && isUrl(args[1] || '')) return 'read';
  if (args[0] === 'kit' && args[1] === 'init' && isUrl(flagValue(args, '--storybook') || '')) return 'read';
  return 'none';
}

function sharedEffect(args) {
  if (args[0] === 'api') {
    if (args[1] === 'setup' || args[1] === 'index' || args[1] === 'context') return 'write';
    return 'read';
  }
  if (args[0] === 'history') {
    if (args[1] === 'snapshot') return 'write';
    if (args[1] === 'list' || args[1] === 'diff') return 'read';
  }
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
    editor: args[0] === 'jam' ? 'figjam'
      : args[0] === 'slides' ? 'slides'
        : args[0] === 'measure' ? 'dev'
          : 'figma',
    feature: args[0] === 'motion' ? 'motion-beta'
      : args[0] === 'slides' ? 'slides-beta'
        : args[0] === 'map' ? 'storybook'
          : args[0] === 'link' ? 'design-links'
            : args[0] === 'contract' ? 'design-contracts' : null,
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
  registryFileKey = null,
  workspaceIO = null,
} = {}) {
  const input = Array.isArray(rawArgs) ? rawArgs : [];
  const prepared = prepareCommandArgs(input, workspaceDir);
  const argv = Object.freeze(prepared.args);
  const capability = prepared.capability;
  if (workspaceIO) {
    for (const intent of prepared.paths) {
      workspaceIO.authorizePath(intent.path, {
        access: intent.access,
        role: intent.role,
        kind: intent.kind,
      });
    }
  }
  const effects = Object.freeze({
    figma: capability.mutatesDesign ? 'write' : capability.target === 'none' ? 'none' : 'read',
    workspace: capability.help ? 'none' : prepared.workspace,
    network: capability.help ? 'none' : networkEffect(prepared.args),
    shared: capability.help ? 'none' : sharedEffect(prepared.args),
  });
  const target = capability.target === 'none'
    ? Object.freeze({ kind: 'none', fileKey: null, source: 'not-applicable' })
    : resolveFigmaTarget({
      explicitFileKey: fileKey,
      args: argv,
      figmaUrlFileKey: prepared.figmaUrlFileKey,
      figmaUrlArgs: prepared.figmaUrlArgs,
      registryFileKey: capability.available ? registryFileKey : null,
    });
  const outputs = Object.freeze(prepared.outputPath
    ? [Object.freeze({ role: capability.pathPolicy, path: prepared.outputPath })]
    : []);
  const operation = Object.values(effects).includes('write')
    ? 'write'
    : Object.values(effects).includes('read')
      ? 'read'
      : 'none';
  const jobKey = backgroundJobIdentity(argv, target.fileKey);
  const retry = capability.mutatesDesign ? 'never' : capability.retry;
  const plan = {
    id: capability.actionId || 'unknown',
    adapter,
    allowed: capability.available
      && (adapter === 'mcp' || (adapter === 'cli' && CLI_COMMAND_APPLICATIONS.has(capability.actionId))),
    argv,
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
    outputs,
    // Closed semantic projection for the Audit Trail. It deliberately omits
    // argv, file keys, paths, labels, and payloads; the writer stores only
    // non-reversible summaries for those values.
    audit: Object.freeze({
      capability: capability.actionId || 'unknown',
      operation,
      effects,
      targetKind: target.kind,
      outputRoles: Object.freeze(outputs.map(({ role }) => role)),
    }),
    summary: capability.summary,
  };
  const frozen = Object.freeze(plan);
  COMMAND_PLANS.add(frozen);
  return frozen;
}

/** Only plans created by this Module may cross the execution seam. */
export function isFigmaCommandPlan(value) {
  return value !== null && typeof value === 'object' && COMMAND_PLANS.has(value);
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
