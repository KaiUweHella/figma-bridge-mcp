#!/usr/bin/env node
// figma-bridge-mcp — MCP stdio server. Small, token-efficient tool surface over
// figma-cli running in Safe Mode.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli, ensureSafeConnect, health, getSelection, ALLOWED_COMMANDS, withAbsoluteOutputDir, normalizeOutputArgs } from "./figma-cli.js";
import { buildHistory } from "./history.js";
import { annotationFor, storybookTrailer } from "./figma-map.js";
import { ensureKey, readKey, rotateKey, keyPath } from "./pairing.js";
import { readRestToken, getRestHealth, resolveFileKey, getVersions, getComments, postComment, getFileComponents, NOT_CONFIGURED_MSG } from "./figma-rest.js";
import { WRITE_CONFIRM } from "./config.js";

// Subcommands that mutate the design; gated behind confirm when
// FIGMA_WRITE_CONFIRM=1. Read commands always run.
// Write gate, per command group. Verified against the engine's real
// subcommands (node/component/... --help):
// - Commands in ALWAYS_WRITE mutate the file regardless of arguments
//   (combos/sizes generate variant grids — they even have --dry-run).
// - For gated GROUPS, only the listed subcommands are reads; everything
//   else in the group (create/set/delete/add/clear/prop/combine/link/...)
//   counts as a write. Unknown future subcommands therefore default to
//   WRITE — the safe direction for a confirm gate.
// - `tokens` is special: the bare command exports (read); of its
//   subcommands only `overlap` is a read.
// - `map` is deliberately NOT gated: it writes a repo file (figma-map.json),
//   never the Figma document — same class as `extract` (writes DESIGN.md).
//   FIGMA_WRITE_CONFIRM protects the design file, not the filesystem.
const ALWAYS_WRITE = new Set([
  "render",
  "render-batch",
  "import",
  "pin",
  "gradient",
  "combos",
  "sizes",
]);

const READ_SUBCOMMANDS = {
  node: new Set(["tree", "bindings"]),
  component: new Set(["list", "main"]),
  dev: new Set(["list"]),
  annotate: new Set(["list"]),
  section: new Set(["list"]),
  grid: new Set(["list"]),
  col: new Set(["list"]),
  var: new Set(["list", "find"]),
  // `canvas` was ungated while it only measured and switched pages;
  // page-create mutates the document, so the group is gated now with the
  // pre-existing subcommands enumerated as reads (page = switch only).
  canvas: new Set(["info", "pages", "page", "next"]),
};

// Commands that never touch the Figma document (exports/analysis write repo
// files at most — FIGMA_WRITE_CONFIRM protects the design, not the
// filesystem). Everything NOT enumerated here, in READ_SUBCOMMANDS or in
// ALWAYS_WRITE defaults to WRITE: an unlisted future command group must not
// ship ungated — that is exactly how `canvas page-create` slipped through.
const READ_ONLY_COMMANDS = new Set([
  "a11y",
  "analyze",
  "api",
  "export",
  "extract",
  "find",
  "inspect",
  "map",
  "spec",
  "verify",
  "verify-build",
]);

export function isWrite(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  // A help flag anywhere makes commander print usage and exit — never a write.
  if (args.includes("--help") || args.includes("-h")) return false;
  const [cmd, sub] = args;
  if (ALWAYS_WRITE.has(cmd)) return true;
  if (READ_ONLY_COMMANDS.has(cmd)) return false;
  // Bare group command or a leading flag → usage output, not an action.
  const subIsAction = sub !== undefined && !sub.startsWith("-");
  if (cmd === "tokens") return subIsAction && sub !== "overlap";
  if (cmd in READ_SUBCOMMANDS) return subIsAction && !READ_SUBCOMMANDS[cmd].has(sub);
  // Unknown command: WRITE — the safe direction for a confirm gate.
  return true;
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

const TOOLS = [
  {
    name: "figma_connect",
    description:
      "Connect to Figma in Safe Mode (never Yolo). Generates the plugin access key if needed and returns it with plugin import instructions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_status",
    description:
      "Show whether the Figma plugin is connected and authenticated, plus access-key state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_pairing",
    description:
      "Show the Figma plugin access key (paste it into the FigCli plugin). Pass rotate:true to generate a fresh key (requires reconnect).",
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
      `Run an allowlisted figma-cli command. Allowed: ${[...ALLOWED_COMMANDS].sort().join(", ")}. ` +
      "Append --help to any command for its syntax. " +
      "Note: node tree defaults to depth 3 — pass -d <n> for deeper trees.",
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "figma-cli subcommand and flags, e.g. [\"canvas\",\"info\"].",
        },
        confirm: {
          type: "boolean",
          description: "Required for write commands when write-confirm mode is on.",
        },
        label: {
          type: "string",
          description: "Optional short intent note stored in the local history/audit log (see figma_history).",
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_render",
    description: "Render JSX into the open Figma design.",
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
          description: "Optional short intent note stored in the local history/audit log (see figma_history).",
        },
      },
      required: ["jsx"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_selection",
    description:
      "The nodes the user currently has selected in Figma — pushed automatically by the FigCli plugin on every selection change. Use this instead of asking the user to copy node ids: they select in Figma, you read the ids here and feed them to figma_inspect/figma_spec/figma_screenshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_history",
    description:
      "Local change history of this machine's Figma sessions, from the audit log every figma_run/figma_render is recorded in. Filter by nodeId to see everything that touched a node. Optionally merges git history of generated code files for a combined design+code changelog. Note: node-id matching is text-based, so numbers like \"12:30\" in free text can match too.",
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
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_comments",
    description:
      "Read or post Figma comments via the optional REST layer (design review feedback lives here — read it, act on it, reply with what you changed). action:'list' returns all comments with ids, authors, node anchors and resolved state. action:'post' needs message (+ optional nodeId anchor or replyTo thread id) and ALWAYS requires confirm:true after a preview — comments are visible to other people. Without a configured REST token this tool only explains the setup.",
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
      "Inspect a node by id: geometry, positioning, fills/strokes/effects, clipsContent, opacity, component context, text style (YAML output). For full design-to-code detail use figma_spec instead.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id (\"1:2\"), URL form (\"1-2\"), or a full Figma URL." },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_reference",
    description:
      "Offline Figma Plugin API reference (one-time 'api setup' needed). Omit name to list. Special topic: name \"workflow\" returns the FULL design-to-code workflow guide (the server instructions are a truncation-safe summary of it).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Command name to look up, or \"workflow\" for the full design-to-code guide." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_screenshot",
    description:
      "Save a PNG of a node (or the current selection) to a temp file and return its path + dimensions. MANDATORY first step of any design-to-code task: Read the PNG afterwards — it is the visual ground truth to compare your build against.",
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
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_spec",
    description:
      "Design-to-code spec of a node: real text content, resolved icon/component names, variants, layout, paints with design-token bindings. Use phase 'structure' to build the markup first (hierarchy + content only), then 'style' for the visual detail. Never invent texts or icons — copy them from this spec. Works on ANY sub-node and takes a depth limit — for large screens pull a shallow structure map first, then style per section instead of one giant spec.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Figma node id of the frame to spec (\"1:2\"), URL form (\"1-2\"), or a full Figma URL.",
        },
        phase: {
          type: "string",
          enum: ["structure", "style", "all"],
          description: "structure = hierarchy + real content; style = layout/paint/typography detail; all (default) = both.",
        },
        depth: {
          type: "number",
          description: "Max tree depth (default 12).",
        },
        section: {
          type: "string",
          description:
            "Layer name of a child section to spec instead of the node itself (exact name from the structure map; case-insensitive). Saves copying long instance ids: pass the ROOT nodeId + the section's name to get that section in full depth.",
        },
        format: {
          type: "string",
          enum: ["tree", "yaml", "json"],
          description:
            "tree (default) = compact text with S<n> style-bundle refs; yaml/json = structured model with a styles map.",
        },
        includeHidden: {
          type: "boolean",
          description:
            "Also list invisible nodes, marked hidden (default false). Useful to understand what a variant toggle would reveal.",
        },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
];

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
export const INSTRUCTIONS = `Design-to-code (Figma -> code). The design is the complete spec — copy it,
never interpret. Full guide: figma_reference {name:"workflow"}.

1. figma_screenshot, then Read the PNG — the visual ground truth.
2. figma_spec phase "structure" — skeleton; texts/icon names verbatim, never
   invented.
3. figma_run ["export","css","<nodeId>"] — tokens SCOPED to the frame, wired
   as CSS variables. Load the listed font families from their named sources
   (or ask the user for files) — a system-font fallback is not done.
4. figma_run ["export","assets","<nodeId>","-o","/abs/path/src/assets"] —
   real files + assets.json (absolute path!). Never substitute CSS
   placeholders. If it returns "still RUNNING", re-run the same call to poll.
5. figma_spec phase "style" — exact sizes/paints/typography; place every
   "vector art -> assets/..." SVG at its stated place/abs offsets; keep
   overlays that overhang their parent.
6. Implement every flagged interactive state from the "Component sets" spec
   trailer (hover/active/focus/disabled).
7. VERIFY before declaring done:
   - figma_run ["verify-build","/abs/project/dir"] — mechanically finds
     assets.json files missing from the build (+ border-image lint);
   - every abs/place/inset overlay exists in the build (file OR styled div)
     — the spec footer counts them;
   - no invented values; "w:fill" stays fluid (flex, no fixed px);
     "grid RxC" is CSS grid, never a flex column;
   - gradient stroke + radius: wrapper/mask pattern, NEVER border-image.

Large frames: never pull one giant spec — structure at depth 3-4 first, then
style PER SECTION. NEVER estimate values from a screenshot.

Node ids: "12:34", "12-34", full Figma URLs. Safe Mode reaches only the
file open in Figma Desktop.

More figma_run commands: ["extract"], ["analyze","colors"], ["verify","<id>"],
["map","storybook","<url|dir>"] (Figma<->Storybook mapping). --help for syntax.
REST opt-in (token in plugin UI): figma_comments, history includeVersions.`;

// Long-form workflow guide — the pre-truncation INSTRUCTIONS text, served in
// full through figma_reference {name:"workflow"} (tool results are not subject
// to the client's 2,048-character instructions cap).
export const WORKFLOW_GUIDE = `Design-to-code workflow (Figma -> code). The design is the complete
specification — copy it, never interpret it. Follow these steps in order:

1. figma_screenshot on the target frame, then Read the saved PNG — the visual
   ground truth. Do not build from a node tree alone.
2. figma_spec with phase "structure" — build the markup/component skeleton
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
4. Export the real assets (figma_run: ["export","assets","<nodeId>","-o","/abs/path/to/project/src/assets"])
   — every "-> assets/..." reference in the spec points at a file this writes.
   Pass an ABSOLUTE output path (relative paths resolve against the MCP
   server, not your project). Large exports keep running after this call
   returns "still RUNNING" — re-run the same call to poll; assets.json is
   written last and marks completion. Use the original images and SVGs;
   never substitute CSS placeholders.
5. figma_spec with phase "style" — apply sizes, gaps, padding, alignment,
   fills/strokes (prefer the var(...) token names), radii, shadows,
   typography, opacity, clip (overflow hidden), and abs positioning. Every
   "vector art -> assets/..." line is real artwork (waves, glyphs, bubbles):
   place the exported SVG at its "place left/top" offsets with its stated
   W x H — these are rendered values that match the file exactly. Keep
   overlays marked "overhangs parent" even when they stick out; never
   approximate artwork with CSS.
6. Interactive states: the spec ends with "Component sets used on this
   screen". For every axis flagged with a state marker (hover/active/focus/
   disabled), pull that variant's exact styles (figma_spec on the set's node
   id listed there) and implement it as CSS :hover/:active/:focus-visible/
   [disabled]. A screen with only default states is incomplete.
7. Verify: screenshot your build and compare it against the Figma PNG from
   step 1. Then walk this checklist before declaring done:
   - run figma_run ["verify-build","/abs/path/to/project"] — it greps the
     project against assets.json and lists every unreferenced asset (the
     absolutely-positioned/overhanging SVGs are the ones that get lost) and
     flags border-image use near border-radius;
   - then the VISUAL pass: screenshot your running build (your own browser
     tools, full page, at the design's width) and re-run verify-build with
     ["verify-build","/abs/project","--compare","/abs/build.png"] — it diffs
     build vs design (reference fetched live from Figma, or pass
     "--design","/abs/figma.png" to reuse the step-1 PNG offline), reports
     the worst differing regions in node pixels and writes a diff PNG —
     Read it. "--max-diff","<pct>" turns it into a hard gate;
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
phase "structure" and depth 3-4 — a map of the screen with the node id of
every section. Then pull phase "style" PER SECTION and build section by
section. Either pass the section's node id, or keep the ROOT nodeId and pass
section: "<layer name from the structure map>" — that specs the named child
in full depth without copying long instance ids.

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

Storybook mirroring: ["map","storybook","<url|dir>"] matches the Figma file's
components (stable publish keys) against a running/built Storybook and writes
figma-map.json into your project. When that file exists, figma_selection and
figma_spec annotate components with their story (↔ story <id>). Edit entries
by hand and set "matchedBy": "manual" to pin them across re-runs.

When you BUILD components + stories from a Figma design: name each component
and its story title after the Figma component/set name from the spec (the
"Component sets used" trailer, or the main/set fields on instances) — e.g.
Figma set "Button" → story title "Components/Button". Matching is name-based;
matching names give high-confidence automatic links. Run map storybook as the
LAST step, once the stories exist.

=== Code-to-Figma workflow (code -> Figma) ===

The reverse direction: build designs IN Figma from code. Order matters —
tokens first, then components, then screens:

1. Format first: read the reference frame's dimensions from figma_selection
   before rendering anything. figma_run ["render","--preset","macbook-14",...]
   (or iphone-15, ipad-11, ...) sets the root frame size when the JSX has no
   w/h — never guess mobile vs desktop.
2. Tokens: figma_run ["tokens","import","<file.json>","-c","<Collection>"]
   creates the collection + variables in one call (nested JSON flattens to
   a/b/c names). Reference them in JSX as var:<name>; pass
   ["render","-c","<Collection>"] to pin resolution.
3. Components: render each variant as "axis=value" named frames with
   --as-component, then ["component","combine","<ids>","-n","Name"] into a
   variant set. Give EVERY <Text> a name= (name="label") — text: overrides
   key on layer names; content-derived names make overrides brittle (a
   warning fires on --as-component renders without them).
4. Screens: compose <Instance component="Name" variant="axis=value"> with
   overrides — text:<layer>, prop:<property>, fill:<layer> (hex or var:),
   swap:<layer> ("Other Component"). Layer matching is case-, space- and
   hyphen-insensitive (text:plantphoto matches "plant-photo").
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
   returns a screenshot in the same call — always look at it.

=== Optional REST add-on (Figma personal access token) ===

Opt-in extras the local plugin bridge cannot reach. Setup: the user pastes a
Figma personal access token into the FigCli plugin's "REST token (optional)"
field (stored 0600 on this machine; FIGMA_REST_TOKEN env for headless runs).
figma_status reports whether a token is configured and working.

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
      "  figma-cli " +
      args.join(" ") +
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
const ASSET_EXPORT_TIMEOUT_MS =
  Number(process.env.ASSET_EXPORT_TIMEOUT_MS) || 10 * 60 * 1000;
// Finished results linger briefly: an agent (or transport) retry of the SAME
// call right after completion used to find the job already deleted and kicked
// off a FULL duplicate export. Errors are not cached — a retry after a failure
// should genuinely try again.
const ASSET_RESULT_CACHE_MS = 60 * 1000;
const assetJobs = new Map(); // canonical-args key → job

async function runAssetExport(rawArgs, label) {
  const { args, outDir } = withAbsoluteOutputDir(rawArgs);
  const key = JSON.stringify(args);
  let job = assetJobs.get(key);
  if (!job) {
    job = { startedAt: Date.now(), done: false, result: null, error: null };
    job.promise = runCli(args, { timeoutMs: ASSET_EXPORT_TIMEOUT_MS, label })
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
async function enrichFigmaMap(normalizedArgs) {
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
    const resolved = await resolveFileKey(undefined);
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
        "  Paste this into the FigCli plugin's access-key field in Figma\n" +
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
          "Plugins → Development → FigCli; it reconnects with the stored key.";
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
      // Optional REST layer: report presence and validity (lazy, 5-min cached)
      // without ever echoing the token. The open file lets the check fall back
      // to a real file probe when the token lacks the /v1/me scope.
      if (readRestToken()) {
        const target = await resolveFileKey();
        const health = await getRestHealth({ fileKey: target.key || undefined });
        lines.push(
          health.ok
            ? health.noUserScope
              ? "REST token: configured and working (file access verified). No 'current_user:read' scope — that scope is not needed here."
              : `REST token: configured (${health.handle})`
            : `REST token: configured but NOT working — ${health.error}`,
        );
      } else {
        lines.push(
          "REST token: not set (optional) — paste a Figma personal access token into the FigCli plugin's 'REST token' field, or set FIGMA_REST_TOKEN. Unlocks figma_comments and figma_history {includeVersions:true}.",
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
            "with the new key, then paste it into the FigCli plugin.",
        );
      }
      const { key, created } = ensureKey();
      return textResult(
        `Plugin access key${created ? " (newly generated)" : ""}:\n\n    ${key}\n\n` +
          `Stored at: ${keyPath()}\n\n` +
          "Paste it into the FigCli plugin's access-key field in Figma.",
      );
    }

    case "figma_run": {
      const args = input.args;
      if (!Array.isArray(args) || args.length === 0) {
        return errorResult("args must be a non-empty array of strings.");
      }
      if (WRITE_CONFIRM && isWrite(args) && input.confirm !== true) {
        return previewResult(args);
      }
      if (args[0] === "export" && args[1] === "assets") {
        return await runAssetExport(args, input.label);
      }
      // extract / export node|screenshot write files — resolve their output
      // paths against the client workspace, not the engine's repo cwd.
      const normalized = normalizeOutputArgs(args);
      const res = await runCli(normalized, { label: input.label });
      // Library-metadata enrichment (opt-in REST layer): after a successful
      // `map storybook` run, upgrade the written figma-map.json with the
      // published components' description/documentation links — a stronger
      // mapping signal than name matching. Silent no-op without a token.
      if (args[0] === "map" && readRestToken()) {
        const note = await enrichFigmaMap(normalized);
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
      const res = await runCli(args, { label: input.label });
      return resultFromCli(res);
    }

    case "figma_selection": {
      const sel = await getSelection();
      if (!sel.ok) return errorResult(sel.message);
      if (!sel.selection) {
        return textResult(
          sel.pluginConnected
            ? "No selection pushed yet. Ask the user to select something in Figma — the plugin pushes every selection change automatically. If selecting changes nothing here, the plugin needs a reload (Plugins → Development → FigCli)."
            : "Plugin not connected — launch Plugins → Development → FigCli in Figma first.",
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
        // Storybook mirror from figma-map.json, when one exists.
        const story = key ? annotationFor(key) : null;
        return `- ${n.id}  ${n.type}  "${n.name}"${size}${comp}${keyPart}${story ? `  ${story}` : ""}`;
      });
      const more = s.total > s.nodes.length ? `\n(+${s.total - s.nodes.length} more selected)` : "";
      return textResult(
        `User selection on page "${s.page}" (${s.total} node${s.total !== 1 ? "s" : ""}, as of ${s.receivedAt}):\n${lines.join("\n")}${more}`,
      );
    }

    case "figma_history": {
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
          const resolved = await resolveFileKey(input.fileKey);
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
      const resolved = await resolveFileKey(input.fileKey);
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
      // YAML: same information as --json at a fraction of the tokens.
      const res = await runCli(["inspect", nodeId, "--format", "yaml"]);
      return resultFromCli(res);
    }

    case "figma_reference": {
      // "workflow" is served straight from this process: the full design-to-
      // code guide whose short form lives in the (client-truncated) server
      // instructions. No engine round-trip, works before any setup.
      if (typeof input.name === "string" && /^workflow$/i.test(input.name.trim())) {
        return textResult(WORKFLOW_GUIDE);
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
          // The engine's hint says `figma-cli api setup`, which an MCP agent
          // cannot type. Translate it into the tool call that actually works.
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
      let res;
      try {
        res = await runCli(args);
      } catch (err) {
        // One transparent retry — but ONLY for transient failures: the first
        // verify after an idle stretch occasionally dies while the daemon
        // self-heals (observed as a bare "exited with code 1" with no cause);
        // the identical second call reliably succeeds. Deterministic errors
        // ("Node not found", bad arguments) used to be retried too, doubling
        // latency and audit entries for an outcome that cannot change.
        const detail = String(err.stderr || "").trim();
        const transient =
          !detail ||
          /timeout|timed out|ECONNREFUSED|ECONNRESET|not reachable|Empty response from daemon/i.test(detail);
        if (!transient) throw err;
        res = await runCli(args);
      }
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
      if (input.format != null) {
        const fmt = String(input.format);
        if (!["tree", "yaml", "json"].includes(fmt)) {
          return errorResult("format must be tree, yaml or json.");
        }
        args.push("-f", fmt);
      }
      if (input.depth != null) {
        const depth = Number(input.depth);
        if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
          return errorResult("depth must be an integer between 1 and 30.");
        }
        args.push("-d", String(depth));
      }
      const res = await runCli(args);
      // Append the Storybook mirror for every component key in the spec —
      // purely additive, no-op without a figma-map.json in the project.
      const trailer = storybookTrailer(res.stdout || "");
      if (trailer) res.stdout = (res.stdout || "") + trailer;
      // Oversized specs blow the client's tool-result token limit; the
      // client's own fallback ("read the file in chunks") sends agents down
      // the wrong path — the intended workflow for large frames is
      // per-section pulling. PREPEND the redirect so it survives whatever
      // truncation or file-dump the client applies (heads survive, tails
      // don't — the instructions-truncation lesson).
      const SPEC_SIZE_HINT_CHARS = 60_000;
      if ((res.stdout || "").length > SPEC_SIZE_HINT_CHARS) {
        res.stdout =
          `⚠ This spec is ${res.stdout.length.toLocaleString("en-US")} characters — likely beyond your tool-result limit. ` +
          `Do NOT read a dumped file in chunks. Instead re-run figma_spec with phase "structure" and depth 3-4 ` +
          `to map the sections, then pull phase "style" PER SECTION (each section's node id is in the structure map) — ` +
          `that is the intended workflow for large frames.\n\n` + res.stdout;
      }
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
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`figma-bridge-mcp failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
