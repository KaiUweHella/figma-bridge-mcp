#!/usr/bin/env node
// figma-bridge-mcp — MCP stdio server. Small, token-efficient tool surface
// over the vendored engine, which reaches Figma through the plugin bridge.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli, runInProcessCommand, evaluateFigma, captureFigmaDesign, ensureSafeConnect, health, probePluginResponsiveness, getSelection, resolveFileTarget } from "./engine.js";
import {
  listFigmaCapabilities,
  planFigmaCommand,
} from "./capability-catalog.js";
import { buildHistory } from "./history.js";
import {
  annotationFor,
  designEntityAnnotationFor,
  designEntityMappingsForSpecModel,
  designEntityTrailer,
  storybookTrailer,
  storybookMappingsForSpecModel,
} from "./figma-map.js";
import { ensureKey, readKey, rotateKey, keyPath } from "./pairing.js";
import { readRestToken, getRestHealth, resolveFileKey, getVersions, getFileAtVersion, getComments, postComment, getFileComponents, NOT_CONFIGURED_MSG } from "./figma-rest.js";
import { normalizeRestDocument } from "../engine/src/lib/doc-snapshot.js";
import { diffSnapshots, formatDiff, formatChangelog } from "../engine/src/lib/doc-diff.js";
import { DEFAULT_SPEC_FORMAT, parseSpecModel, serializeSpecModel } from "../engine/src/lib/spec-format.js";
import { executeCodeSpec } from "../engine/src/application/code-spec-command.js";
import { executeInspect } from "../engine/src/application/inspect-command.js";
import { executeScreenshot } from "../engine/src/application/screenshot-command.js";
import {
  designLinkFileKeyFromArgv,
  designLinkRequestFromArgv,
  executeDesignLink,
  formatDesignLinkResult,
} from "../engine/src/application/design-link-command.js";
import { designContractFileKeyFromArgv } from "../engine/src/application/design-contract-command.js";
import { WRITE_CONFIRM } from "./config.js";

export function isWrite(args) {
  return Array.isArray(args) && args.length > 0 && planFigmaCommand(args).effects.figma === "write";
}

// Server version for figma_status: package version + short git SHA. A status
// report that names its build makes stale server processes (running code from
// before a fix) immediately visible instead of masquerading as feature gaps.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_VERSION = (() => {
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "unknown";
  } catch {}
  let sha = "";
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT, timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {}
  return sha ? `${version} (${sha})` : version;
})();

function toolAnnotations({
  readOnlyHint,
  destructiveHint = false,
  openWorldHint = true,
}) {
  return { readOnlyHint, destructiveHint, openWorldHint };
}

// Exported so tests can assert on the surface itself: "12 tools" is a claim the
// project makes, and a schema regression should fail the build, not the README.
export const TOOLS = [
  {
    name: "figma_connect",
    description:
      "Connect to Figma in Safe Mode (never Yolo). Generates the plugin access key if needed and returns it with plugin import instructions.",
    annotations: toolAnnotations({
      readOnlyHint: false,
    }),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_status",
    description:
      "Show bridge/plugin/file/key state. Performs a real plugin round-trip by default; REST validation is opt-in.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        validateRest: { type: "boolean", description: "Also validate the optional REST token remotely." },
        probePlugin: { type: "boolean", default: true, description: "Plugin eval probe (default true); false = socket only." },
        fileKey: { type: "string", description: "File key/URL for REST file-access validation fallback." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_pairing",
    description:
      "Show the Figma plugin access key (paste it into the Figma Bridge plugin). Pass rotate:true to generate a fresh key (requires reconnect).",
    annotations: toolAnnotations({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        rotate: {
          type: "boolean",
          description:
            "Generate a NEW key, invalidating the old one. Run figma_connect afterwards to restart the daemon.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_run",
    description:
      "Run a Capability Catalog-approved engine command. Discover commands with " +
      'figma_reference {name:"capabilities"}. ' +
      "Append --help to any command for its syntax. " +
      "Note: node tree defaults to depth 3 — pass -d <n> for deeper trees.",
    annotations: toolAnnotations({
      readOnlyHint: false,
      destructiveHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "Engine subcommand and flags, e.g. [\"canvas\",\"info\"].",
        },
        confirm: {
          type: "boolean",
          description: "Required for write commands when write-confirm mode is on.",
        },
        label: {
          type: "string",
          description: "Optional audit-log intent note.",
        },
        fileKey: {
          type: "string",
          description: "Target connected file: bare key or Figma URL.",
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_render",
    description: "Render JSX into the open Figma design.",
    annotations: toolAnnotations({
      readOnlyHint: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        jsx: { type: "string", description: "JSX markup to render." },
        confirm: {
          type: "boolean",
          description: "Required when write-confirm mode is on.",
        },
        label: {
          type: "string",
          description: "Optional audit-log intent note.",
        },
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      required: ["jsx"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_selection",
    description:
      "Read the current Figma selection and reuse its id.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_history",
    description:
      "Local change history of this machine's Figma sessions, from the audit log every figma_run/figma_render is recorded in. Filter by nodeId to see everything that touched a node. Optionally merges git history of generated code files for a combined design+code changelog. Note: node-id matching is text-based, so numbers like \"12:30\" in free text can match too.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Only entries touching this node id (\"1:2\" or URL form \"1-2\").",
        },
        limit: {
          type: "number",
          description: "Max entries (default 20, max 200).",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format (default markdown table).",
        },
        gitPaths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative file paths whose git log to merge in (generated code files).",
        },
        repoPath: {
          type: "string",
          description: "Repo root for gitPaths (default: server working directory).",
        },
        includeVersions: {
          type: "boolean",
          description:
            "Also merge the file's Figma version history (what designers saved, by whom) via the optional REST layer. Needs a configured REST token; without one a note is appended instead.",
        },
        fileKey: {
          type: "string",
          description:
            "File for includeVersions: bare key or full Figma URL. Default: the file open in Figma Desktop.",
        },
        diff: {
          type: "object",
          description:
            "Structural diff instead of the log: what nodes were added, removed, recreated, moved or changed between two states. Refs are \"live\" (the document right now), \"latest\"/\"previous\", an index, or a Figma version id (needs the REST layer). Record comparison points with figma_run [\"history\",\"snapshot\"].",
          properties: {
            from: { type: "string", description: "Older side. Default \"previous\"." },
            to: { type: "string", description: "Newer side. Default \"latest\". Use \"live\" for the current document." },
            nodeId: { type: "string", description: "Subtree root when a side is \"live\" (default: current page)." },
            changelog: { type: "boolean", description: "Emit a markdown changelog instead of the terse report." },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_comments",
    description:
      "Read or post Figma comments via the optional REST layer (design review feedback lives here — read it, act on it, reply with what you changed). action:'list' returns all comments with ids, authors, node anchors and resolved state. action:'post' needs message (+ optional nodeId anchor or replyTo thread id) and ALWAYS requires confirm:true after a preview — comments are visible to other people. Without a configured REST token this tool only explains the setup.",
    annotations: toolAnnotations({
      readOnlyHint: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "post"], description: "list (default) or post." },
        fileKey: {
          type: "string",
          description: "Bare file key or full Figma URL. Default: the file open in Figma Desktop.",
        },
        message: { type: "string", description: "post: the comment text." },
        nodeId: {
          type: "string",
          description: "post: anchor the comment to this node (\"1:2\", URL form, or full URL).",
        },
        x: { type: "number", description: "post: canvas x (with y, when no nodeId) or node offset x." },
        y: { type: "number", description: "post: canvas y / node offset y." },
        replyTo: { type: "string", description: "post: comment id to reply to (threads under it)." },
        confirm: {
          type: "boolean",
          description: "Required true to actually post — first call without it returns a preview.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_inspect",
    description:
      "Inspect one node's geometry, paint, effects, component context and text style as YAML.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id (\"1:2\"), URL form (\"1-2\"), or a full Figma URL." },
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_reference",
    description:
      "Offline Plugin API reference. Special topics: capabilities, variable-scopes, workflow, workflow:design-to-code, workflow:code-to-figma.",
    annotations: toolAnnotations({
      readOnlyHint: true,
      openWorldHint: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "API name, capabilities or workflow topic; omit to list API names." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_screenshot",
    description:
      "MANDATORY first step: save/read the node PNG, then compare the finished build to it.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Figma node id (\"1:2\"), URL form (\"1-2\"), or a full Figma URL. Omit to use the current selection.",
        },
        scale: {
          type: "number",
          description: "Export scale (default 0.5, capped at 2000px max dimension). The result reports the applied scale — rendered pixels = node size × scale.",
        },
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_spec",
    description:
      "Exact per-layer text, identity, layout, native CSS, paint, token and asset facts. Copy; never invent. Map structure, then pull style by node id.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Frame node id, URL-form id, or full Figma URL.",
        },
        phase: {
          type: "string",
          enum: ["structure", "style", "all"],
          description: "structure = hierarchy + real content; style = layout/paint/typography detail; all (default) = both.",
        },
        depth: {
          type: "number",
          description: "Max tree depth (default 12). Use 0 for the requested node itself, complete and without descendants.",
        },
        section: {
          type: "string",
          description:
            "Optional child layer name from the structure map. Prefer its node id when names repeat.",
        },
        format: {
          type: "string",
          enum: ["tree", "yaml", "json"],
          default: DEFAULT_SPEC_FORMAT,
          description:
            "tree (default) is readable; yaml/json are lossless canonical adapters.",
        },
        includeHidden: {
          type: "boolean",
          description:
            "Also list invisible nodes, marked hidden (default false). Useful to understand what a variant toggle would reveal.",
        },
        dedup: {
          type: "boolean",
          default: false,
          description:
            "false (default): inline every layer; true: compact S<n>/repeat refs.",
        },
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
];

// MCP-native, user-invoked fallback for clients that do not load bundled
// Codex skills. The plugin skill can trigger automatically; MCP prompts are
// intentionally discoverable/user-controlled per the protocol.
export const PROMPTS = [
  {
    name: "design-to-code",
    description: "Implement a Figma node faithfully in the current project with scoped reads, source assets and pixel verification.",
    arguments: [
      { name: "nodeId", description: "Figma node id or node-specific Figma URL; omit to use the current selection.", required: false },
      { name: "projectPath", description: "Absolute path to the target code project; omit to use the current workspace.", required: false },
    ],
  },
  {
    name: "code-to-figma",
    description: "Create or update a componentized Figma view from code with semantic capture, token bindings and visual verification.",
    arguments: [
      { name: "sourcePath", description: "Route, component, or project path to translate; omit to use the current workspace.", required: false },
      { name: "target", description: "Existing Figma node, Design Entity, or target view name; omit to create beside the current selection.", required: false },
    ],
  },
  {
    name: "create-figma-component",
    description: "Create or update a reusable Figma component set from code with variants, properties, tokens and durable identity.",
    arguments: [
      { name: "componentName", description: "Code/Figma component name.", required: true },
      { name: "sourcePath", description: "Source component or Storybook path; omit to discover it in the current workspace.", required: false },
    ],
  },
];

export function designToCodePrompt(args = {}) {
  const node = typeof args.nodeId === "string" && args.nodeId.trim()
    ? args.nodeId.trim()
    : "the current Figma selection";
  const project = typeof args.projectPath === "string" && args.projectPath.trim()
    ? args.projectPath.trim()
    : "the current workspace";
  return {
    description: "Source-faithful Figma Bridge design-to-code workflow",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Implement ${node} in ${project}. Use Figma Bridge and follow ` +
          `figma_reference {name:"workflow:design-to-code"}. Preserve the project's ` +
          `existing stack; use exported source assets instead of UI/icon-library ` +
          `approximations. Prefer exact Design Entity and Storybook links over name-only ` +
          `matches. Read global structure, tokens and assets once, scope style ` +
          `reads per section, and parallelize only substantial sections with disjoint ` +
          `files. Run the project checks and verify-build pixel comparison before ` +
          `declaring parity. Do not install Playwright solely for capture without approval.`,
      },
    }],
  };
}

export function codeToFigmaPrompt(args = {}) {
  const source = typeof args.sourcePath === "string" && args.sourcePath.trim()
    ? args.sourcePath.trim()
    : "the current workspace";
  const target = typeof args.target === "string" && args.target.trim()
    ? args.target.trim()
    : "a new view beside the current Figma selection";
  return {
    description: "Semantic Figma Bridge code-to-Figma workflow",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Build or update ${target} from ${source}. Use Figma Bridge and follow ` +
          `figma_reference {name:"workflow:code-to-figma"}. For an existing rendered ` +
          `UI, use the semantic DOM-capture path rather than rewriting it as simplified ` +
          `JSX. Inspect Design Entity links, existing Figma components, variables and ` +
          `styles before writing. Sync tokens first, reuse exact linked components, ` +
          `componentize repeated structures, preserve source SVGs/images and execute ` +
          `Figma mutations sequentially. Verify screenshots at the reference viewport ` +
          `and record a link accept pixel baseline before declaring parity. Do not ` +
          `install Playwright solely for capture without approval.`,
      },
    }],
  };
}

export function createFigmaComponentPrompt(args = {}) {
  const component = typeof args.componentName === "string" && args.componentName.trim()
    ? args.componentName.trim()
    : "the requested component";
  const source = typeof args.sourcePath === "string" && args.sourcePath.trim()
    ? args.sourcePath.trim()
    : "the matching source and Storybook files in the current workspace";
  return {
    description: "Identity-safe Figma Bridge component-library workflow",
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Create or update the reusable Figma component ${component} from ${source}. ` +
          `Use Figma Bridge and follow figma_reference ` +
          `{name:"workflow:code-to-figma"}. Inspect code props/defaults, Storybook, ` +
          `the Design Link Registry, existing Figma components, variables and styles ` +
          `before writing. Resolve code/Figma conflicts explicitly. Establish token ` +
          `foundations first, build and validate one variant at a time, use TEXT, ` +
          `BOOLEAN and INSTANCE_SWAP properties, never create an icon-name variant ` +
          `axis, keep writes sequential, then inspect the component contract and ` +
          `screenshots before linking the final component to its code identity.`,
      },
    }],
  };
}

// Design-to-code workflow, surfaced to MCP clients via server instructions.
//
// HARD BUDGET: MCP clients (Claude Code among them) truncate server
// instructions at 2,048 characters — everything beyond that limit silently
// never reaches the model (acceptance evidence: 62% of the guidance was cut off, and
// exactly the cut-off checklist items were the fidelity bugs that shipped).
// INSTRUCTIONS must stay under 2,000 characters — enforced by a test in
// tests/mcp-layer.test.js. Put details into WORKFLOW_GUIDE (served via
// figma_reference name "workflow") or into tool OUTPUTS, which are never
// truncated this way.
export const INSTRUCTIONS = `Design-to-code: Figma is the spec. Never invent or drop text, assets,
tokens, layout or states. Follow this order:
1. figma_screenshot, then read the PNG as visual ground truth.
2. figma_spec phase "structure", format "tree", depth 3-4. Copy hierarchy,
   text, ids and icon/component names verbatim; use dedup for a large frame.
3. figma_run ["export","css","<nodeId>"] and wire up the scoped tokens/fonts.
4. figma_run ["export","assets","<nodeId>","-o","/abs/project/src/assets"]
   for images/SVGs plus assets.json. Never substitute CSS placeholders or
   inline SVGs. If still RUNNING, poll the same call.
5. figma_spec phase "style", format "tree" per section/node id. Use depth 0
   for its container and dedup for repeats. Copy native css{} and exact facts.
6. Implement every interactive state flagged by component sets.
7. Before declaring done, run figma_run ["verify-build","/abs/project"] and
   fix every missing asset/lint. Screenshot the build at the design width and
   compare it to Figma (verify-build --compare/--design).

Preserve the target project's stack. Never add Tailwind, a UI kit or an icon
library solely for this build, and never replace exported artwork with an
approximation.
Do not finish until assets.json is covered and the visual diff is inspected.
Never estimate values from the screenshot.
Full guide: figma_reference {name:"workflow"}. Use fileKey with multiple open
Figma windows. figma_run accepts --help.`;

// Long-form workflow guide, served in
// full through figma_reference {name:"workflow"} (tool results are not subject
// to the client's 2,048-character instructions cap).
export const WORKFLOW_GUIDE = `Design-to-code workflow (Figma -> code). The design is the complete
specification — copy it, never interpret it. Follow these steps in order:

1. figma_screenshot on the target frame, then Read the saved PNG — the visual
   ground truth. Do not build from a node tree alone.
2. figma_spec with phase "structure" and format "tree" — build the markup/component skeleton
   from it: real text characters, real icon/component names, hierarchy.
   Texts and icons come verbatim from the spec; NEVER invent or paraphrase.
3. Export the design tokens SCOPED TO YOUR FRAME (figma_run:
   ["export","css","<nodeId>"] or ["export","dtcg","<nodeId>"]) and wire them
   up as CSS variables / theme. The scoped form returns exactly the variables
   bound in that subtree — library tokens included. Without a node id you get
   the open file's LOCAL variables, which can belong to a different design
   entirely; the output names its SOURCE file — verify it either way.
   Fonts: the export names each font family and where to get it (Fontshare/
   Google/Vercel/...). Load those exact families (download if freely
   available, otherwise ask the user for the files) — a system-font fallback
   distorts metrics and does not count as done.
   Project contract: inspect the target repository first and keep its framework,
   styling system and conventions. Reuse an existing component only when its
   rendered design and states match. Never add Tailwind, a UI kit or an icon
   library solely for this screen, and never substitute a library glyph for
   exported source artwork.
4. Export the real assets (figma_run: ["export","assets","<nodeId>","-o","/abs/path/to/project/src/assets"])
   — every "-> assets/..." reference in the spec points at a file this writes.
   Pass an ABSOLUTE output path (relative paths resolve against the MCP
   server, not your project). Large exports keep running after this call
   returns "still RUNNING" — re-run the same call to poll; assets.json is
   written last and marks completion. Use the exported images and SVGs;
   never substitute CSS placeholders. Oversized PNGs default to 2x their
   largest Figma usage (retina); pass "--raster-scale","0" only when original
   PNG bytes are explicitly required.
5. figma_spec with phase "style" — for each section, first request depth 0
   to get that container's own background/border/radius/layout without its
   descendants. Then pull its child ids in bounded calls; use dedup true for
   repeated cards/lists. Apply sizes, gaps, padding, alignment,
   fills/strokes (prefer the var(...) token names), radii, shadows,
   typography, opacity, clip (overflow hidden), and abs positioning. Every
   "vector art -> assets/..." line is real artwork (waves, glyphs, bubbles):
   place the exported SVG at its "place left/top" offsets with its stated
   W x H — these are rendered values that match the file exactly. Keep
   overlays marked "overhangs parent" even when they stick out; never
   approximate artwork with CSS.
6. Interactive states: the spec ends with "Component sets used on this
   screen". One figma_spec call on the listed SET node id captures every
   variant and its exact styles; use sufficient depth or its frontier calls.
   Implement flagged axes as CSS :hover/:active/:focus-visible/
   [disabled]. A screen with only default states is incomplete.
7. Verify: screenshot your build and compare it against the Figma PNG from
   step 1. Then walk this checklist before declaring done:
   - run figma_run ["verify-build","/abs/path/to/project"] — it greps the
     project against assets.json and lists every unreferenced asset (the
     absolutely-positioned/overhanging SVGs are the ones that get lost) and
     flags border-image use near border-radius;
   - then the VISUAL pass: screenshot your running build (an already available
     browser tool or project harness, full page, at the design's width; wait
     for fonts and images) and re-run verify-build with
     ["verify-build","/abs/project","--compare","/abs/build.png"] — it diffs
     build vs design (reference fetched live from Figma, or pass
     "--design","/abs/figma.png" to reuse the step-1 PNG offline), reports
     the worst differing regions in node pixels and writes a diff PNG —
     Read it. "--max-diff","<pct>" turns it into a hard gate;
   - do not install Playwright or another browser dependency solely for this
     capture. Use it when already available; otherwise ask the user before
     adding or downloading a standalone browser tool;
   - every "abs"/"place"/"inset" overlay line from the spec exists in the
     build (as file OR styled div) — decorative gradient rectangles and
     background shapes included; the spec footer tells you how many;
   - no invented values: every size, opacity and offset exists in the spec
     or the manifest;
   - "w:fill" children stayed fluid (flex stretch) — no fixed px widths, no
     space-between substitute; "grid RxC" containers are CSS grids, never
     flex columns;
   - borders match stroke width/alignment AND paint: a gradient stroke stays
     a gradient (solid is a silent downgrade); gradient stroke + radius is
     built with the mask pattern, never border-image — the style-spec footer
     ships ready-made CSS for exactly this; use it verbatim.

NEVER estimate colors, fonts, sizes or radii from a screenshot — every exact
value is in the phase "style" spec. If you only pulled "structure", pull
"style" too before styling anything.

Large screens: do NOT pull one giant style spec. First run figma_spec with
phase "structure", format "tree" and depth 3-4 — a map of the screen with the node id of
every section. Then pull phase "style" PER SECTION: depth 0 gives the section
container itself as a complete contract; request its child ids separately and
use dedup true for repeated rows/cards. Either pass the section's node id, or
keep the ROOT nodeId and pass section: "<layer name from the structure map>".

Parallel implementation is an OPTIONAL wall-clock optimization, not a default
and not a token optimization. The coordinator owns the screenshot, structure
map, scoped tokens, assets.json, shared shell/layout and final verification.
Use the smallest useful group (normally 2-4 workers) only when there are at
least three substantial independent sections and each worker can own disjoint
component/style files. Give each worker one section node id, its bounded style
facts, shared token/asset paths and explicit file ownership.
Workers must not repeat global Figma reads or edit the same route shell, global
stylesheet, token file or asset manifest. If ownership overlaps or the screen is small,
build sequentially. Integrate once, then run one build and one visual parity
pass; an independent reviewer may inspect the final diff after integration.

Only hand-drawn vector shapes export as SVG files. Rectangles/ellipses with
solid or gradient fills are CSS elements — build them as styled divs exactly
as the spec lists them, never as images.

Node ids: "12:34", the URL form "12-34", and full Figma URLs are all
accepted. Safe Mode only reaches the file open in Figma Desktop — a URL for
another file cannot be resolved. Instance-path ids ("I12:34;56:78") from spec
output may not resolve in follow-up calls; prefer the top-level instance id.

figma_run gives access to further read commands: ["node","tree","<id>"],
["analyze","colors"], ["extract"] (writes DESIGN.md), ["verify","<id>"].
Append --help to any command for syntax.

Design memory: ["link","set","<nodeId>","<entity.id>","--source",
"src/Component.tsx","--export","Component"] gives the Figma node and code one
durable identity in figma-bridge.json. Pass confirm:true. Then figma_selection
and figma_spec resolve that exact entity/code; reuse it instead of creating a
look-alike. For a screen, acceptance requires its browser screenshot and a
passing pixel gate: ["link","accept","<entity.id>","--compare",
"/abs/browser.png","--max-diff","5"]. The baseline records the diff and image
hashes; fingerprints alone can no longer accept a visually wrong screen. Start later work with
["link","context","<entity.id>"]: it reports unchanged/code-only/figma-only/
conflict/untracked plus exact next reads. A conflict never picks a winner.
["link","inspect","<nodeId>"] resolves a link; ["link","list"] reads the
repository Registry. Existing figma-map.json mappings remain a legacy adapter.

When you BUILD components + stories from a Figma design: name each component
and its story title after the Figma component/set name from the spec (the
"Component sets used" trailer, or the main/set fields on instances) — e.g.
Figma set "Button" → story title "Components/Button". Matching is name-based;
matching names give high-confidence automatic links. Run map storybook as the
LAST step, once the stories exist.

=== Code-to-Figma workflow (code -> Figma) ===

The reverse direction: build designs IN Figma from code. Order matters —
tokens first, then components, then screens:

0. Existing rendered UI: do NOT manually simplify React/CSS into a second JSX
   screen. Run ["render","--print-browser-capture",".screen"] without a Figma
   connection, evaluate the printed expression in the page at the reference
   viewport, and save its returned JSON string. Then run
   ["render","--dom-capture","/abs/capture.json","--verify"]. The semantic
   capture preserves Flexbox, Grid, sizing, authored CSS-variable provenance,
   true absolute overlays, direct text, ::before/::after, assets and SVGs.
   Flex becomes Auto Layout and representable Grid becomes native Figma Grid;
   unclassified layout fallbacks stop the render instead of silently flattening
   it. Unresolved icon roles are reported and must receive SVG or Design Entity
   mappings before acceptance. Hand-authored JSX remains the path for new
   components that do not yet have a rendered DOM.
   Reviewed boundary defaults are: minmax.native-grid,
   space-around.equal-slots, border.single-paint-native, sticky.metadata-only and
   filters.layer-stack. CSS masks only proceed when a real Figma mask shape can
   be materialized. Variable-font axes stop before render and require an
   install-font vs available-named-face decision. Native Figma Glass is kept as
   an editable effect; never claim its reverse CSS is exact because Figma omits
   Glass-specific parameters from CSS export.

1. Format first: read the reference frame's dimensions from figma_selection
   before rendering anything. figma_run ["render","--preset","macbook-14",...]
   (or iphone-15, ipad-11, ...) sets the root frame size when the JSX has no
   w/h — never guess mobile vs desktop.
2. Tokens: figma_run ["tokens","import","<file.json>","-c","<Collection>"]
   creates the collection + variables in one call (nested JSON flattens to
   a/b/c names). Reference them in JSX as var:<name>; pass
   ["render","-c","<Collection>"] to pin resolution.
   Inspect every scopeQuestions / SCOPE DECISION REQUIRED result. Explicit
   spacing/* and space/* FLOAT names auto-scope to GAP; radius/* and radii/*
   auto-scope to CORNER_RADIUS. For every other newly created variable with
   specialized options, ASK THE USER whether it should remain ALL_SCOPES or
   use one or more compatible scopes. Never guess from a vague name. Read
   figma_reference {name:"variable-scopes"} for the complete typed catalog.
3. Components: render each variant as "axis=value" named frames with
   --as-component, then ["component","combine","<ids>","-n","Name"] into a
   variant set. Give EVERY <Text> a name= (name="label") — text: overrides
   key on layer names; content-derived names make overrides brittle (a
   warning fires on --as-component renders without them).
4. Screens: compose <Instance component="Name" variant="axis=value"> with
   overrides — text:<layer>, prop:<property>, fill:<layer> (hex or var:),
   swap:<layer> ("Other Component"). Layer matching is case-, space- and
   hyphen-insensitive (text:plantphoto matches "plant-photo").
   REUSE before rebuild: run ["component","list"] first and instantiate what
   exists — a render that draws a frame named like an existing component
   prints a reuse warning with the ready <Instance> line. A variant= that
   does not exist FAILS with the existing axes/values and the exact
   ["component","add-variant","<set>","Axis=Value"] command; add-variant
   clones the nearest variant (--from picks the source) so the new state
   inherits the set's structure — then edit only what differs. Rendering
   3+ structurally identical siblings prints a componentize hint: render
   ONE, ["node","to-component","<id>"], place <Instance> copies.
5. Images: <Image src="/abs/or/relative.png" imageScale="FILL|FIT|CROP|TILE">
   imports the actual file (CLI reads it, no plugin network). Without src=
   you get a named grey placeholder carrying an "Image placeholder"
   annotation; fill it later with ["node","set-image","<id>","photo.png"].
   Files > 8 MB are refused — downscale first (Figma caps images at 4096px).
6. Icons: <Icon name="check"> renders ~40 built-in geometry vectors
   (check/x/plus/chevrons/arrows/search/bell/droplet/sun/home/settings/...,
   aliases like close/back/gear). Project icons: ["render","--icons","<dir>"]
   loads every *.svg (name = file basename) and overrides built-ins.
   Unknown names stay grey placeholder boxes.
7. Responsive by construction: size every container deliberately — w="fill"
   (stretch), w="hug" (wrap content) or a fixed number; leaf elements
   (Image/Rect/Ellipse) take w="fill" too. Add minW/maxW/minH/maxH where a
   fluid element has real limits (cards in a grid: w="fill" minW="140"
   maxW="240"). A fixed-size element inside a fluid parent is usually a
   bug — the PlantCard photo overhang came from exactly that.
8. Fix-ups without re-rendering: ["node","move","<id>","<x>","<y>"]
   (--page reparents across pages), ["node","resize","<id>","<w|keep|fill|hug>","<h|keep|fill|hug>"],
   ["node","rename"], ["node","set-text"], ["node","set-fill","<id>","#hex|var:name"],
   ["node","set-image"]. Find ids via ["node","tree","<id>","--ids"] or
   ["find","<name>"]. A fixed-height render prints an overflow warning with
   the measured spill — fix it right then.
9. Organize: ["canvas","page-create","<name>"] for a fresh page,
   ["section","create","<name>","<ids>"] to group,
   ["section","arrange","<id>","--cols","4"] to tidy,
   ["section","fit","<id>"] after manual moves. ["render","--verify"]
   returns a screenshot in the same call — always look at it. For a linked
   screen, compare that PNG to the browser screenshot and only then accept via
   ["link","accept","<entity.id>","--compare","/abs/browser.png",
   "--max-diff","5"].

=== Optional REST add-on (Figma personal access token) ===

Opt-in extras the local plugin bridge cannot reach. Setup: the user pastes a
Figma personal access token into the Figma Bridge plugin's "REST token (optional)"
field (stored 0600 on this machine; FIGMA_REST_TOKEN env for headless runs).
figma_status reports local configuration immediately; pass validateRest:true
when an explicit remote validity check is needed.

- figma_comments {action:"list"} — design review feedback with node anchors
  and thread ids. Read it, act on it, then reply with what you changed:
  {action:"post", replyTo:"<id>", message:"..."} — posting ALWAYS previews
  first and requires confirm:true (visible to other humans).
- figma_history {includeVersions:true} — merges the file's real version
  history (designer saves, by whom) into the local audit+git timeline.
- ["map","storybook",...] automatically enriches figma-map.json with the
  published components' description/documentation links when a token is set.

Default file scope is the file open in Figma Desktop; other files only via an
explicit fileKey (bare key or Figma URL). Every REST call is audit-logged
(method+path only). Without a token these tools explain the setup and nothing
else changes.`;

export const VARIABLE_SCOPE_GUIDE = `Figma variable scopes — agent decision guide

ALL_SCOPES means the variable is unrestricted. It does not mean "select every
specialized scope". A variable may use one or more compatible specialized
scopes. Scope only newly created local variables; never silently rewrite an
existing local/library variable.

Compatible scopes by resolved type:
- COLOR: ALL_SCOPES, ALL_FILLS, FRAME_FILL, SHAPE_FILL, TEXT_FILL,
  STROKE_COLOR, EFFECT_COLOR
- FLOAT: ALL_SCOPES, CORNER_RADIUS, WIDTH_HEIGHT, GAP, STROKE_FLOAT,
  EFFECT_FLOAT, OPACITY, FONT_WEIGHT, FONT_SIZE, LINE_HEIGHT, LETTER_SPACING,
  PARAGRAPH_SPACING, PARAGRAPH_INDENT
- STRING: ALL_SCOPES, TEXT_CONTENT, FONT_FAMILY, FONT_STYLE
- BOOLEAN: ALL_SCOPES (Figma has no specialized Boolean scope)

Required behavior:
1. Auto-scope only explicit FLOAT namespaces: spacing/* or space/* -> GAP;
   radius/* or radii/* -> CORNER_RADIUS. Names containing those words without
   the namespace do not qualify.
2. If a command returns scopeQuestions or SCOPE DECISION REQUIRED, present the
   variable name, type and compatible scopes to the user. Ask whether it should
   stay ALL_SCOPES or which compatible scope(s) they want. Do not choose for
   them from an ambiguous name.
3. Apply the answer with figma_run:
   ["var","update","<variable>","--collection","<collection>",
    "--scopes","TEXT_FILL,STROKE_COLOR"]
   Multiple comma-separated scopes are valid. Use ALL_SCOPES alone to remove a
   restriction.
4. If a name strongly suggests a different scope (for example opacity/*,
   font-size/*, text/*, stroke/* or effect/*), mention that compatible candidate
   in the question, but still ask unless a project policy explicitly decided it.
`;

const CODE_TO_FIGMA_MARKER = "=== Code-to-Figma workflow (code -> Figma) ===";

/** Return the smallest workflow guide that satisfies the requested topic. */
export function workflowGuideFor(name) {
  const topic = String(name || "").trim().toLowerCase();
  if (topic === "workflow") return WORKFLOW_GUIDE;
  const split = WORKFLOW_GUIDE.indexOf(CODE_TO_FIGMA_MARKER);
  if (topic === "workflow:design-to-code") {
    return (split === -1 ? WORKFLOW_GUIDE : WORKFLOW_GUIDE.slice(0, split)).trimEnd();
  }
  if (topic === "workflow:code-to-figma") {
    return (split === -1 ? WORKFLOW_GUIDE : WORKFLOW_GUIDE.slice(split)).trim();
  }
  return null;
}

const configuredSpecLimit = Number(process.env.FIGMA_SPEC_MAX_CHARS);
export const SPEC_OUTPUT_LIMIT_CHARS =
  Number.isFinite(configuredSpecLimit) && configuredSpecLimit >= 10_000
    ? configuredSpecLimit
    : 60_000;

/**
 * Enforce a hard MCP result budget without ever returning partial design data.
 * The caller gets an explicit incomplete response and a lossless retry path.
 */
export function budgetSpecOutput(text, options = {}) {
  const value = String(text || "");
  const limit = Number(options.limit) || SPEC_OUTPUT_LIMIT_CHARS;
  if (value.length <= limit) {
    return { complete: true, originalChars: value.length, text: value };
  }
  const phase = options.phase || "all";
  const depth = options.depth || 12;
  const section = options.section ? `\nrequested_section: ${JSON.stringify(options.section)}` : "";
  return {
    complete: false,
    originalChars: value.length,
    text:
      `spec_result:\n  complete: false\n  reason: output_budget\n` +
      `  measured_chars: ${value.length}\n  limit_chars: ${limit}\n` +
      `  requested_node: ${JSON.stringify(options.nodeId || "selection")}\n` +
      `  requested_phase: ${JSON.stringify(phase)}\n  requested_depth: ${depth}${section}\n\n` +
      `No partial design data was returned; partial output could be mistaken for a complete design.\n` +
      `Retry losslessly: call figma_spec for the same node with phase "structure" and depth 3-4. ` +
      `For each section id, first request phase "style" at depth 0 (the exact container itself), ` +
      `then request its child ids in bounded calls; use dedup true for repeated lists/cards. ` +
      `Each response remains complete for its requested scope.`,
  };
}

/** Try the exact inline projection first, then one lossless deduplicated
 * projection when repetition alone overflows the MCP result budget. */
export async function fitSpecOutput(render, { dedup = false, ...budgetOptions } = {}) {
  let result = await render(dedup);
  let budgeted = budgetSpecOutput(result.stdout || "", budgetOptions);
  const exactChars = budgeted.originalChars;
  if (!budgeted.complete && !dedup) {
    result = await render(true);
    budgeted = budgetSpecOutput(result.stdout || "", budgetOptions);
    if (budgeted.complete) {
      return { result, budgeted, automaticDedup: true, exactChars };
    }
  }
  return { result, budgeted, automaticDedup: false, exactChars };
}

function enrichStructuredSpec(text, format) {
  const model = parseSpecModel(text, format);
  const storybook = storybookMappingsForSpecModel(model);
  if (storybook.length) model.storybook = storybook;
  const designEntities = designEntityMappingsForSpecModel(model);
  if (designEntities.length) model.designEntities = designEntities;
  return serializeSpecModel(model, format);
}

function textResult(text) {
  return { content: [{ type: "text", text: text || "" }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text: text || "" }], isError: true };
}

function resultFromCli({ stdout, stderr }) {
  // stdout AND stderr both reach the agent: the CLI puts warnings and
  // per-asset failure reasons on stderr, and dropping them produced summaries
  // like "1 asset(s) failed (listed above)" with nothing listed above.
  const out = (stdout || "").trimEnd();
  const err = (stderr || "").trim();
  if (out && err) return textResult(out + "\n\n[warnings]\n" + err);
  return textResult(out || err);
}

function previewResult(args) {
  return textResult(
    "Write-confirm mode is on. Planned command:\n" +
      "  figma_run " +
      JSON.stringify(args) +
      "\n\nRe-run with confirm:true to execute.",
  );
}

// ============ export-assets job handling ============
//
// `export assets` on a large frame takes minutes — long past any MCP client
// timeout. The naive sync call produced "-32001 Request timed out" while the
// engine kept writing files, so the agent never learned the export succeeded.
// Instead: run the export as a tracked background job, wait a bounded window,
// and on timeout return a poll instruction. Re-invoking the SAME call attaches
// to the running job (double-start protection) or returns its final result.
const ASSET_EXPORT_WAIT_MS = Number(process.env.ASSET_EXPORT_WAIT_MS) || 45000;
// Finished results linger briefly: an agent (or transport) retry of the SAME
// call right after completion used to find the job already deleted and kicked
// off a FULL duplicate export. Errors are not cached — a retry after a failure
// should genuinely try again.
const ASSET_RESULT_CACHE_MS = 60 * 1000;
const assetJobs = new Map(); // canonical-args key → job

export function assetExportJobKey(args, fileKey) {
  const target = resolveFileTarget(fileKey, args);
  return planFigmaCommand(args, { fileKey: target }).execution.jobKey;
}

async function runAssetExport(rawArgs, label, fileKey) {
  const target = resolveFileTarget(fileKey, rawArgs);
  const plan = planFigmaCommand(rawArgs, { fileKey: target });
  const args = [...plan.argv];
  const outDir = plan.outputs[0]?.path || null;
  const key = plan.execution.jobKey;
  if (!key) return errorResult("Command is not configured as a background job.");
  let job = assetJobs.get(key);
  if (!job) {
    job = { startedAt: Date.now(), done: false, result: null, error: null };
    job.promise = runCli(args, { label, fileKey })
      .then((res) => { job.done = true; job.result = res; })
      .catch((err) => { job.done = true; job.error = err; });
    assetJobs.set(key, job);
  }
  let timer;
  await Promise.race([
    job.promise,
    new Promise((r) => { timer = setTimeout(r, ASSET_EXPORT_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (!job.done) {
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return textResult(
      `Asset export still RUNNING (${secs}s — large frames take minutes; this call returns early instead of timing out).\n` +
        `Output dir: ${outDir}\n` +
        `assets.json is written LAST — once it exists there, the export is complete.\n` +
        `Poll by re-running this exact figma_run call: it attaches to the running job (never starts a duplicate) and returns the final summary when done.`,
    );
  }
  if (job.error) {
    assetJobs.delete(key);
    return errorResult(job.error.stderr || job.error.message || String(job.error));
  }
  if (!job.evictAt) {
    job.evictAt = Date.now() + ASSET_RESULT_CACHE_MS;
    const evict = setTimeout(() => {
      if (assetJobs.get(key) === job) assetJobs.delete(key);
    }, ASSET_RESULT_CACHE_MS);
    if (typeof evict.unref === "function") evict.unref();
  }
  return resultFromCli(job.result);
}

/**
 * Library-metadata enrichment (opt-in REST layer). After a successful
 * `map storybook` run, read the figma-map.json the engine wrote, fetch the
 * published components of the open file and add description/documentation
 * links per mapping — matched over the same stable component keys the map
 * already carries. Returns a status note (or null when there is nothing to
 * say). Never throws: enrichment is a bonus, never a failure mode.
 * @param {string[]} normalizedArgs - map argv after normalizeOutputArgs
 * @returns {Promise<string|null>}
 */
async function enrichFigmaMap(normalizedArgs, fileKey) {
  // Locate the -o path (normalizeOutputArgs guarantees one of these forms).
  let file = null;
  const idx = normalizedArgs.findIndex((a) => a === "-o" || a === "--output");
  if (idx !== -1 && typeof normalizedArgs[idx + 1] === "string") {
    file = normalizedArgs[idx + 1];
  } else {
    const eq = normalizedArgs.find((a) => /^(--output|-o)=/.test(a));
    if (eq) file = eq.split("=").slice(1).join("=");
  }
  if (!file) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(doc.mappings) || !doc.mappings.length) return null;
    const resolved = await resolveFileKey(fileKey);
    if (!resolved.key) return `Library metadata skipped: ${resolved.error}`;
    const byKey = await getFileComponents(resolved.key);
    if (!byKey.size) {
      return "Library metadata: file has no published components (not a published library) — map left as-is.";
    }
    let enriched = 0;
    for (const m of doc.mappings) {
      const meta = byKey.get(m.figmaVariantKey) || byKey.get(m.figmaKey);
      if (!meta) continue;
      if (meta.description) {
        m.description = meta.description;
        enriched++;
      }
      if (meta.documentationLinks.length) m.documentationLinks = meta.documentationLinks;
    }
    doc.fileKey = resolved.key;
    writeFileSync(file, JSON.stringify(doc, null, 2));
    return `Library metadata (REST): ${enriched} mapping(s) enriched with published descriptions/doc links.`;
  } catch (err) {
    return `Library metadata enrichment failed: ${err.message}`;
  }
}

/**
 * Known-parameter guard. Clients that guess parameter names before loading
 * the schema (`node_id`, `url` instead of `nodeId`) used to be silently
 * ignored — the call fell back to "Nothing selected in Figma", which reads
 * like a missing value, not a wrong name. Say what is actually wrong.
 */
export function unknownParamError(toolName, input, tools = TOOLS) {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return null; // unknown tool errors elsewhere
  const known = Object.keys(tool.inputSchema?.properties || {});
  const unknown = Object.keys(input || {}).filter((k) => !known.includes(k));
  if (!unknown.length) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  // Common guesses that are not just casing variants of a real parameter.
  const ALIASES = { url: "nodeId", link: "nodeId", node: "nodeId", id: "nodeId", frame: "nodeId" };
  const hints = unknown.map((k) => {
    const match = known.find((p) => norm(p) === norm(k))
      || (ALIASES[norm(k)] && known.includes(ALIASES[norm(k)]) ? ALIASES[norm(k)] : null);
    return match ? `Unknown parameter "${k}" — did you mean "${match}"?` : `Unknown parameter "${k}".`;
  });
  return `${hints.join(" ")} ${known.length ? `Accepted parameters: ${known.join(", ")}.` : "This tool takes no parameters."}`;
}

export async function handleTool(name, rawArgs) {
  const input = rawArgs || {};
  const paramError = unknownParamError(name, input);
  if (paramError) return errorResult(paramError);

  switch (name) {
    case "figma_connect": {
      // Ensure an access key exists BEFORE starting the daemon — the daemon
      // reads the key file at startup and rejects the plugin without it.
      const { key, created } = ensureKey();
      const res = await ensureSafeConnect();
      const keyBlock =
        "\n────────────────────────────────────────\n" +
        `  Plugin access key${created ? " (newly generated)" : ""}:\n\n` +
        `    ${key}\n\n` +
        "  Paste this into the Figma Bridge plugin's access-key field in Figma\n" +
        "  the first time you launch it. It is stored in the plugin and\n" +
        "  reused across sessions.\n" +
        "────────────────────────────────────────\n";
      return textResult((res.stdout || res.stderr || "") + keyBlock);
    }

    case "figma_status": {
      const h = await health();
      const key = readKey();
      const raw = h.raw || {};
      // Differentiate the failure mode: "no key" and "key fine, plugin just
      // not running" need different next steps — the generic "run
      // figma_connect" hint sent users back through setup they had already
      // completed.
      let headline = h.message;
      if (!h.ok && key) {
        headline =
          "Access key is configured — only the daemon/plugin link is down. " +
          "Run figma_connect (restarts the daemon), then in Figma Desktop launch " +
          "Plugins → Development → Figma Bridge; it reconnects with the stored key.";
      }
      const lines = [
        headline,
        `access key: ${key ? "configured" : "NOT set — run figma_connect to generate one"}`,
        `server version: ${SERVER_VERSION}`,
      ];
      if (h.raw) {
        lines.push(
          `plugin authenticated: ${raw.pluginAuthenticated === true ? "yes" : "no"}`,
        );
        if (raw.keyConfigured === false) {
          lines.push("daemon has NO key loaded — reconnect after figma_connect");
        }
      }
      // Which editor the bridge is attached to. Design commands and `jam`
      // target different editors, and "it just failed" is much easier to act
      // on when the agent can see which kind of file it is talking to.
      const conns = Array.isArray(raw.connections) ? raw.connections : [];
      const stalePlugins = conns.filter((connection) => connection.pluginUpdateAvailable === true);
      for (const connection of stalePlugins) {
        lines.push(
          `plugin update required: Figma is running cached build ${connection.pluginVersion || "unknown"}. `
          + "Re-import ~/.figma-bridge-mcp/plugin/manifest.json in Figma Desktop, then reopen Figma Bridge.",
        );
      }
      if (conns.length > 1) {
        lines.push(`${conns.length} Figma windows connected — pass fileKey to figma_run to pick one:`);
        for (const c of conns) {
          lines.push(`  ${c.fileKey || "(unidentified)"}  ${[c.fileName, c.editorType].filter(Boolean).join("  ")}`);
        }
      } else if (conns.length === 1) {
        const c = conns[0];
        const editor = c.editorType;
        lines.push(
          `file: ${c.fileName || "(unnamed)"}${c.fileKey ? ` (${c.fileKey})` : ""}`
          + (editor ? `, ${editor}` : ""),
        );
        if (editor === "figjam") {
          lines.push("  FigJam board — use figma_run [\"jam\", …]; design commands need a Figma file.");
        } else if (editor === "slides") {
          lines.push("  Slides deck — use figma_run [\"slides\", …] for the beta command surface.");
        } else if (editor === "dev") {
          lines.push("  Dev Mode — connected for inspection only; switch to Design mode and open Figma Bridge there before any canvas write.");
        }
      }
      if (h.plugin && input.probePlugin !== false) {
        if (conns.length > 1 && !input.fileKey) {
          // Status is read-only, so probing every identified socket is safe
          // and much more useful after a disconnect than asking the caller to
          // make one status call per window. Run the probes concurrently so
          // several sleeping windows still cost only one timeout interval.
          const targets = [...new Map(conns.filter((c) => c.fileKey).map((c) => [c.fileKey, c])).values()];
          if (!targets.length) {
            lines.push("plugin responsive: not probed — connected windows have no fileKey yet; bring Figma Desktop to the foreground and retry");
          } else {
            const results = await Promise.all(targets.map(async (connection) => ({
              connection,
              probe: await probePluginResponsiveness(connection.fileKey),
            })));
            for (const { connection, probe } of results) {
              const label = `${connection.fileName || "(unnamed)"} (${connection.fileKey})`;
              if (probe.responsive) {
                lines.push(`plugin responsive: yes — ${label} (${probe.latencyMs}ms round-trip)`);
              } else {
                lines.push(`plugin responsive: NO — ${label} (${probe.latencyMs}ms)`);
                if (probe.error) lines.push(`  probe error: ${probe.error.split("\n")[0]}`);
              }
            }
            if (results.some(({ probe }) => !probe.responsive)) {
              lines.push("  Bring the unresponsive Figma window and its Figma Bridge plugin tab to the foreground, then retry; run figma_connect if it persists.");
            }
          }
        } else {
          const probe = await probePluginResponsiveness(input.fileKey);
          if (probe.responsive) {
            lines.push(`plugin responsive: yes (${probe.latencyMs}ms round-trip)`);
          } else {
            lines.push(`plugin responsive: NO (${probe.latencyMs}ms) — socket is connected but Figma did not answer`);
            lines.push("  Bring Figma Desktop and the Figma Bridge plugin tab to the foreground, then retry; run figma_connect if it persists.");
            if (probe.error) lines.push(`  probe error: ${probe.error.split("\n")[0]}`);
          }
        }
      } else if (h.plugin) {
        const recent = conns.map((connection) => connection.lastResponseAt).filter(Boolean).sort().at(-1);
        lines.push(`plugin responsive: not probed (socket only)${recent ? `; last successful response ${recent}` : "; no successful response recorded"}`);
      }
      // Optional REST layer: local status stays local/fast by default. Remote
      // validation is explicit because a cold Figma REST probe can take
      // seconds; REST-backed tools validate when they are actually used.
      if (readRestToken()) {
        if (input.validateRest === true) {
          const target = await resolveFileKey(input.fileKey);
          const restHealth = await getRestHealth({ fileKey: target.key || undefined });
          lines.push(
            restHealth.ok
              ? restHealth.noUserScope
                ? "REST token: configured and working (file access verified). No 'current_user:read' scope — that scope is not needed here."
                : `REST token: configured (${restHealth.handle})`
              : `REST token: configured but NOT working — ${restHealth.error}`,
          );
        } else {
          lines.push("REST token: configured (remote validation deferred; pass validateRest:true to check now).");
        }
      } else {
        lines.push(
          "REST token: not set (optional) — paste a Figma personal access token into the Figma Bridge plugin's 'REST token' field, or set FIGMA_REST_TOKEN. Unlocks figma_comments and figma_history {includeVersions:true}.",
        );
      }
      return textResult(lines.join("\n"));
    }

    case "figma_pairing": {
      if (input.rotate === true) {
        const key = rotateKey();
        return textResult(
          `New plugin access key generated:\n\n    ${key}\n\n` +
            `Stored at: ${keyPath()}\n\n` +
            "The old key is now invalid. Run figma_connect to restart the daemon\n" +
            "with the new key, then paste it into the Figma Bridge plugin.",
        );
      }
      const { key, created } = ensureKey();
      return textResult(
        `Plugin access key${created ? " (newly generated)" : ""}:\n\n    ${key}\n\n` +
          `Stored at: ${keyPath()}\n\n` +
          "Paste it into the Figma Bridge plugin's access-key field in Figma.",
      );
    }

    case "figma_run": {
      const args = input.args;
      if (!Array.isArray(args) || args.length === 0) {
        return errorResult("args must be a non-empty array of strings.");
      }
      const prepared = planFigmaCommand(args);
      const inferredLinkFile = prepared.argv[0] === "link"
        ? designLinkFileKeyFromArgv([...prepared.argv])
        : prepared.argv[0] === "contract"
          ? designContractFileKeyFromArgv([...prepared.argv])
          : null;
      const target = resolveFileTarget(input.fileKey || inferredLinkFile, args);
      const plan = planFigmaCommand(args, { fileKey: target });
      if (WRITE_CONFIRM && plan.effects.figma === "write" && input.confirm !== true) {
        return previewResult(args);
      }
      if (plan.execution.mode === "tracked-job") {
        return await runAssetExport(args, input.label, input.fileKey);
      }
      // Command-specific path rules are owned by the Capability Catalog.
      const normalized = [...plan.argv];
      if (normalized[0] === "link") {
        const res = await runInProcessCommand(normalized, { label: input.label, fileKey: input.fileKey },
          async ({ fileKey, timeoutMs }) => {
            const result = await executeDesignLink(designLinkRequestFromArgv(normalized), {
              evaluate: (code) => evaluateFigma(code, { fileKey, timeoutMs }),
            });
            return { stdout: formatDesignLinkResult(result), stderr: "" };
          });
        return resultFromCli(res);
      }
      const res = await runCli(normalized, { label: input.label, fileKey: input.fileKey });
      // Library-metadata enrichment (opt-in REST layer): after a successful
      // `map storybook` run, upgrade the written figma-map.json with the
      // published components' description/documentation links — a stronger
      // mapping signal than name matching. Silent no-op without a token.
      if (args[0] === "map" && readRestToken()) {
        const note = await enrichFigmaMap(normalized, input.fileKey);
        if (note) res.stdout = (res.stdout || "") + "\n" + note;
      }
      return resultFromCli(res);
    }

    case "figma_render": {
      const jsx = input.jsx;
      if (typeof jsx !== "string" || jsx.length === 0) {
        return errorResult("jsx must be a non-empty string.");
      }
      const args = ["render", jsx];
      if (WRITE_CONFIRM && input.confirm !== true) {
        return previewResult(args);
      }
      const res = await runCli(args, { label: input.label, fileKey: input.fileKey });
      return resultFromCli(res);
    }

    case "figma_selection": {
      const sel = await getSelection(input.fileKey);
      if (!sel.ok) return errorResult(sel.message);
      // Several windows connected and none named: reporting one of them would
      // be arbitrary, so say which files are open and let the caller pick.
      if (sel.ambiguous) {
        const list = (sel.connections || [])
          .map((c) => `  ${c.fileKey || "(unidentified)"}  ${c.fileName || ""}`.trimEnd())
          .join("\n");
        return textResult(
          `${(sel.connections || []).length} Figma windows are connected, so "the selection" is ambiguous:\n${list}\n\n`
          + "Ask the user which file they mean, then pass fileKey to this tool or figma_run.",
        );
      }
      if (!sel.selection) {
        return textResult(
          sel.pluginConnected
            ? "No selection pushed yet. Ask the user to select something in Figma — the plugin pushes every selection change automatically. If selecting changes nothing here, the plugin needs a reload (Plugins → Development → Figma Bridge)."
            : "Plugin not connected — launch Plugins → Development → Figma Bridge in Figma first.",
        );
      }
      const s = sel.selection;
      if (!s.nodes.length) {
        return textResult(`Selection on page "${s.page}" is empty (as of ${s.receivedAt}).`);
      }
      const lines = s.nodes.map((n) => {
        const size = n.width !== undefined ? ` — ${n.width}×${n.height}` : "";
        // Component identity: resolved main component (instances) or own key.
        const comp = n.mainName ? ` → ${n.setName ? n.setName + " / " : ""}${n.mainName}` : "";
        const key = n.setKey || n.componentKey;
        const keyPart = key ? `  key \`${key}\`` : "";
        const entity = designEntityAnnotationFor({
          id: n.entityId,
          componentKey: key,
          nodeId: n.id,
          fileKey: s.fileKey,
        });
        // Legacy Storybook-only maps remain readable until they are migrated.
        const legacyStory = !entity && key ? annotationFor(key) : null;
        const link = entity || legacyStory;
        return `- ${n.id}  ${n.type}  "${n.name}"${size}${comp}${keyPart}${link ? `  ${link}` : ""}`;
      });
      const more = s.total > s.nodes.length ? `\n(+${s.total - s.nodes.length} more selected)` : "";
      return textResult(
        `User selection on page "${s.page}" (${s.total} node${s.total !== 1 ? "s" : ""}, as of ${s.receivedAt}):\n${lines.join("\n")}${more}`,
      );
    }

    case "figma_history": {
      // The `diff` mode answers a different question from the log — "what does
      // the document look like now vs then" rather than "what did this machine
      // run" — so it short-circuits before any audit-log work.
      if (input.diff !== undefined) {
        const d = input.diff;
        if (d === null || typeof d !== "object" || Array.isArray(d)) {
          return errorResult("diff must be an object, e.g. {from:\"latest\", to:\"live\"}.");
        }
        const from = d.from === undefined ? "previous" : String(d.from);
        const to = d.to === undefined ? "latest" : String(d.to);
        const isVersion = (ref) => ref.startsWith("version:");

        // A REST document and a plugin snapshot carry different property sets
        // by design (see normalizeRestDocument), so a mixed diff would be a
        // wall of false positives rather than an answer.
        if (isVersion(from) !== isVersion(to)) {
          return errorResult(
            "A Figma version cannot be diffed against a local snapshot: the two sources expose different "
            + "properties, so every node would look changed. Compare version:<id> with version:<id>, or "
            + "local refs with each other (\"latest\", \"previous\", an index, or \"live\").",
          );
        }

        if (isVersion(from)) {
          if (!readRestToken()) return textResult(NOT_CONFIGURED_MSG);
          const resolved = await resolveFileKey(input.fileKey || d.nodeId);
          if (!resolved.key) return errorResult(resolved.error);
          const load = async (ref) => {
            const version = ref.slice("version:".length);
            const file = await getFileAtVersion(resolved.key, { version });
            if (!file.document) throw new Error(`Figma returned no document for version ${version}.`);
            return normalizeRestDocument(file.document, {
              fileKey: resolved.key, fileName: file.name, version,
            });
          };
          try {
            const before = await load(from);
            const after = await load(to);
            const diff = diffSnapshots(before, after);
            const render = d.changelog === true ? formatChangelog : formatDiff;
            return textResult(render(diff, { before, after }));
          } catch (err) {
            return errorResult(`Version diff failed: ${err.message}`);
          }
        }

        // Local snapshots and the live document go through the engine, which
        // owns the plugin bridge.
        const args = ["history", "diff", from, to];
        if (typeof d.nodeId === "string" && d.nodeId) args.push("--node", d.nodeId);
        if (d.changelog === true) args.push("--changelog");
        // Exit 1 means "the design differs", which is the answer, not an error.
        const res = await runCli(args, { okExitCodes: [0, 1], fileKey: input.fileKey });
        return textResult(res.stdout || res.stderr || "No output.");
      }

      // Entirely MCP-side: reads the local audit log (and optionally git),
      // never spawns the engine and is itself not audited.
      let limit = 20;
      if (input.limit !== undefined) {
        limit = Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          return errorResult("limit must be an integer between 1 and 200.");
        }
      }
      let nodeId = input.nodeId;
      if (nodeId !== undefined) {
        if (typeof nodeId !== "string" || !nodeId.length) {
          return errorResult("nodeId must be a non-empty string.");
        }
        // Accept URL forms: "node-id=1-2" inside a URL, or a bare "1-2".
        const urlMatch = nodeId.match(/node-id=(\d+)-(\d+)/);
        if (urlMatch) nodeId = `${urlMatch[1]}:${urlMatch[2]}`;
        else if (/^\d+-\d+$/.test(nodeId)) nodeId = nodeId.replace("-", ":");
      }
      // Opt-in REST merge: the file's real Figma version history (designer
      // saves). Fetched here — buildHistory stays sync/pure. Failures become
      // a note, never an error: the local history must always be delivered.
      let versionEntries;
      const notes = [];
      if (input.includeVersions === true) {
        if (!readRestToken()) {
          notes.push(NOT_CONFIGURED_MSG);
        } else {
          const resolved = await resolveFileKey(input.fileKey || input.nodeId);
          if (!resolved.key) {
            notes.push(`Figma versions skipped: ${resolved.error}`);
          } else {
            try {
              versionEntries = (await getVersions(resolved.key)).map((v) => ({
                ts: v.created_at,
                label: `version: ${v.label || v.description || "autosave"} (${(v.user && v.user.handle) || "unknown"})`,
                source: "figma",
                ref: v.id,
              }));
            } catch (err) {
              notes.push(`Figma versions unavailable: ${err.message}`);
            }
          }
        }
      }
      return textResult(
        buildHistory({
          nodeId,
          limit,
          format: input.format === "json" ? "json" : "markdown",
          gitPaths: input.gitPaths,
          repoPath: input.repoPath,
          versionEntries,
          notes,
        }),
      );
    }

    case "figma_comments": {
      if (!readRestToken()) return textResult(NOT_CONFIGURED_MSG);
      const action = input.action === "post" ? "post" : "list";
      const resolved = await resolveFileKey(input.fileKey || input.nodeId);
      if (!resolved.key) return errorResult(resolved.error);

      if (action === "list") {
        const comments = await getComments(resolved.key);
        if (!comments.length) return textResult(`No comments in file ${resolved.key}.`);
        // Order threads root-first, replies indented under their parent.
        const roots = comments.filter((c) => !c.parent_id);
        const replies = new Map();
        for (const c of comments) {
          if (!c.parent_id) continue;
          if (!replies.has(c.parent_id)) replies.set(c.parent_id, []);
          replies.get(c.parent_id).push(c);
        }
        const line = (c, indent = "") => {
          const anchor = c.client_meta && c.client_meta.node_id ? `  @node ${c.client_meta.node_id}` : "";
          const state = c.resolved_at ? "  [resolved]" : "";
          const when = (c.created_at || "").slice(0, 16).replace("T", " ");
          const text = String(c.message || "").replace(/\s+/g, " ").slice(0, 300);
          return `${indent}- [${c.id}] ${(c.user && c.user.handle) || "?"} (${when})${anchor}${state}: ${text}`;
        };
        const lines = [];
        for (const r of roots) {
          lines.push(line(r));
          for (const rep of replies.get(r.id) || []) lines.push(line(rep, "  "));
        }
        return textResult(
          `${comments.length} comment${comments.length !== 1 ? "s" : ""} in file ${resolved.key}` +
            `${resolved.source === "open-file" ? " (open file)" : ""}:\n${lines.join("\n")}\n\n` +
            "Reply with {action:'post', replyTo:'<id>', message:'…'} (needs confirm:true).",
        );
      }

      // action === "post"
      const message = input.message;
      if (typeof message !== "string" || !message.trim()) {
        return errorResult("post needs a non-empty message.");
      }
      let nodeId = input.nodeId;
      if (nodeId !== undefined) {
        if (typeof nodeId !== "string" || !nodeId.length) {
          return errorResult("nodeId must be a non-empty string.");
        }
        const urlMatch = nodeId.match(/node-id=(\d+)-(\d+)/);
        if (urlMatch) nodeId = `${urlMatch[1]}:${urlMatch[2]}`;
        else if (/^\d+-\d+$/.test(nodeId)) nodeId = nodeId.replace("-", ":");
      }
      // UNCONDITIONAL confirm gate — independent of FIGMA_WRITE_CONFIRM.
      // Posting a comment is visible to other humans in a shared cloud file;
      // local canvas writes are undoable, this is not.
      if (input.confirm !== true) {
        return textResult(
          "PREVIEW — nothing was posted.\n" +
            `  File:    ${resolved.key}${resolved.source === "open-file" ? " (the file open in Figma)" : ""}\n` +
            `  Anchor:  ${input.replyTo ? `reply to comment ${input.replyTo}` : nodeId ? `node ${nodeId}` : Number.isFinite(input.x) && Number.isFinite(input.y) ? `canvas (${input.x}, ${input.y})` : "file (unanchored)"}\n` +
            `  Message: ${message}\n\n` +
            "This comment will be visible to everyone with access to the file.\n" +
            "Re-run with confirm:true to post it.",
        );
      }
      const posted = await postComment(resolved.key, {
        message,
        nodeId,
        x: Number.isFinite(input.x) ? input.x : undefined,
        y: Number.isFinite(input.y) ? input.y : undefined,
        replyTo: typeof input.replyTo === "string" && input.replyTo ? input.replyTo : undefined,
      });
      return textResult(
        `Comment posted (id ${posted.id || "?"}) in file ${resolved.key}` +
          `${nodeId ? ` at node ${nodeId}` : ""}${input.replyTo ? ` as reply to ${input.replyTo}` : ""}.`,
      );
    }

    case "figma_inspect": {
      const nodeId = input.nodeId;
      if (typeof nodeId !== "string" || nodeId.length === 0) {
        return errorResult("nodeId must be a non-empty string.");
      }
      const args = ["inspect", nodeId, "--format", "yaml"];
      const res = await runInProcessCommand(args, { fileKey: input.fileKey },
        ({ fileKey, timeoutMs }) => executeInspect({ nodeId, format: "yaml" }, {
          evaluate: (code) => evaluateFigma(code, { fileKey, timeoutMs }),
        }));
      return resultFromCli(res);
    }

    case "figma_reference": {
      // "workflow" is served straight from this process: the full design-to-
      // code guide whose short form lives in the (client-truncated) server
      // instructions. No engine round-trip, works before any setup.
      if (typeof input.name === "string" && /^capabilities$/i.test(input.name.trim())) {
        return textResult(listFigmaCapabilities({ formatted: true }));
      }
      if (typeof input.name === "string" && /^variable-scopes$/i.test(input.name.trim())) {
        return textResult(VARIABLE_SCOPE_GUIDE);
      }
      if (typeof input.name === "string" && /^workflow(?::.*)?$/i.test(input.name.trim())) {
        const guide = workflowGuideFor(input.name);
        return guide
          ? textResult(guide)
          : errorResult('Unknown workflow topic. Use "workflow", "workflow:design-to-code", or "workflow:code-to-figma".');
      }
      // `api` is figma-cli's offline Figma Plugin API reference.
      // - No name: `api list` enumerates every interface/type.
      // - With a name: `api show <name>` forces a lookup. A bare `api <name>`
      //   would dispatch names like "setup"/"list"/"context" to those
      //   subcommands (side effects), so route through `show`.
      const args = input.name ? ["api", "show", input.name] : ["api", "list"];
      try {
        const res = await runCli(args);
        return resultFromCli(res);
      } catch (err) {
        const msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
        if (msg.includes("docs not installed")) {
          // The engine already names the right call; this adds the one thing
          // it cannot know — that the download is a bounded, one-time cost.
          return errorResult(
            "The offline API docs are not installed yet (one-time download, ~5 MB).\n" +
              'Run: figma_run with args ["api", "setup"] — then retry figma_reference.',
          );
        }
        throw err;
      }
    }

    case "figma_screenshot": {
      const args = ["verify"];
      if (typeof input.nodeId === "string" && input.nodeId.length) {
        args.push(input.nodeId);
      }
      if (input.scale != null) {
        const scale = Number(input.scale);
        if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
          return errorResult("scale must be a number between 0 and 4.");
        }
        args.push("-s", String(scale));
      }
      const savePath = join(
        tmpdir(),
        `figma-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
      );
      args.push("--save", savePath);
      const res = await runInProcessCommand(args, { fileKey: input.fileKey },
        ({ fileKey, timeoutMs }) => executeScreenshot({
          nodeId: input.nodeId,
          scale: input.scale,
          savePath,
        }, {
          evaluate: (code) => evaluateFigma(code, { fileKey, timeoutMs }),
          save: (file, bytes) => writeFileSync(file, bytes),
        }));
      return textResult(
        (res.stdout || res.stderr || "") +
          `\n\nNow Read the PNG at ${savePath} to see the design.` +
          `\n(width/height above are the RENDERED pixels; multiply by 1/scale for node dimensions.)`,
      );
    }

    case "figma_spec": {
      const nodeId = input.nodeId;
      if (typeof nodeId !== "string" || nodeId.length === 0) {
        return errorResult("nodeId must be a non-empty string.");
      }
      const args = ["export", "code-spec", nodeId];
      if (input.includeHidden === true) args.push("--include-hidden");
      if (input.section != null) {
        if (typeof input.section !== "string" || input.section.length === 0) {
          return errorResult("section must be a non-empty string (a layer name from the structure map).");
        }
        args.push("--section", input.section);
      }
      if (input.phase != null) args.push("-p", String(input.phase));
      const dedup = input.dedup === true;
      if (!dedup) args.push("--no-dedup");
      const format = input.format == null ? DEFAULT_SPEC_FORMAT : String(input.format);
      if (!["tree", "yaml", "json"].includes(format)) {
        return errorResult("format must be tree, yaml or json.");
      }
      // Pass the Interface default explicitly so the MCP contract cannot
      // silently drift if the lower-level CLI ever chooses another default.
      args.push("-f", format);
      if (input.depth != null) {
        const depth = Number(input.depth);
        if (!Number.isInteger(depth) || depth < 0 || depth > 30) {
          return errorResult("depth must be an integer between 0 and 30.");
        }
        args.push("-d", String(depth));
      }
      const runSpec = (useDedup) => runInProcessCommand(
        useDedup ? args.filter((arg) => arg !== "--no-dedup") : args,
        { fileKey: input.fileKey },
        async ({ fileKey, deadline }) => executeCodeSpec({
            nodeId,
            phase: input.phase,
            depth: input.depth,
            section: input.section,
            includeHidden: input.includeHidden,
            format,
            dedup: useDedup,
          }, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
            captureDesign: (request) => captureFigmaDesign(request, {
              fileKey,
              deadline,
            }),
          }),
      );
      const project = (result) => {
        if (format === "tree") {
        // Tree mapping remains a presentation trailer. Structured formats
        // enrich the canonical model and are then re-serialized losslessly.
          const trailer = storybookTrailer(result.stdout || "");
          if (trailer) result.stdout = (result.stdout || "") + trailer;
          const entityLinks = designEntityTrailer(result.stdout || "");
          if (entityLinks) result.stdout = (result.stdout || "") + entityLinks;
        } else {
          result.stdout = enrichStructuredSpec(result.stdout || "", format);
        }
        return result;
      };
      const budgetOptions = {
        nodeId,
        phase: input.phase || "all",
        depth: input.depth ?? 12,
        section: input.section,
      };
      // Exact inline output is the safest default. When only repetition makes
      // it exceed the budget, retry once with lossless S<n>/instance refs.
      const fitted = await fitSpecOutput(
        async (useDedup) => project(await runSpec(useDedup)),
        { dedup, ...budgetOptions },
      );
      const { result: res, budgeted } = fitted;
      if (fitted.automaticDedup) {
        res.stdout = budgeted.text;
        res.stderr = [
          res.stderr,
          `⚠ exact inline spec was ${fitted.exactChars} chars; returned lossless dedup references to stay within ${SPEC_OUTPUT_LIMIT_CHARS}`,
        ].filter(Boolean).join('\n');
        return resultFromCli(res);
      }
      if (!budgeted.complete) {
        const warning = String(res.stderr || "").trim();
        return errorResult(budgeted.text + (warning ? `\n\nCapture warning: ${warning}` : ""));
      }
      res.stdout = budgeted.text;
      return resultFromCli(res);
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    // Single source of truth: package.json (SERVER_VERSION also carries the
    // git SHA for figma_status; the MCP handshake wants the bare semver).
    { name: "figma-bridge-mcp", version: SERVER_VERSION.split(" ")[0] },
    { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    switch (request.params.name) {
      case "design-to-code":
        return designToCodePrompt(request.params.arguments || {});
      case "code-to-figma":
        return codeToFigmaPrompt(request.params.arguments || {});
      case "create-figma-component":
        return createFigmaComponentPrompt(request.params.arguments || {});
      default:
        throw new Error(`Unknown prompt: ${request.params.name}`);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args);
    } catch (err) {
      return errorResult(err.stderr || err.message || String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Start only when run as the entry point — tests import this module for the
// pure helpers (unknownParamError) without booting a stdio server.
export function isServerEntryPoint(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    // npm exposes executables through a symlink on POSIX. Resolve both sides so
    // the packaged .bin launcher starts the server instead of exiting silently.
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isServerEntryPoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`figma-bridge-mcp failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
