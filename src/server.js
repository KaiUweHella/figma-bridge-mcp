#!/usr/bin/env node
// figma-safe-mcp — MCP stdio server. Small, token-efficient tool surface over
// figma-cli running in Safe Mode.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli, ensureSafeConnect, health, getSelection, ALLOWED_COMMANDS, withAbsoluteOutputDir, normalizeOutputArgs } from "./figma-cli.js";
import { buildHistory } from "./history.js";
import { annotationFor, storybookTrailer } from "./figma-map.js";
import { ensureKey, readKey, rotateKey, keyPath } from "./pairing.js";
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
};

export function isWrite(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  // A help flag anywhere makes commander print usage and exit — never a write.
  if (args.includes("--help") || args.includes("-h")) return false;
  const [cmd, sub] = args;
  if (ALWAYS_WRITE.has(cmd)) return true;
  // Bare group command or a leading flag → usage output, not an action.
  const subIsAction = sub !== undefined && !sub.startsWith("-");
  if (cmd === "tokens") return subIsAction && sub !== "overlap";
  if (cmd in READ_SUBCOMMANDS) return subIsAction && !READ_SUBCOMMANDS[cmd].has(sub);
  return false;
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
      "Offline Figma Plugin API reference (one-time 'api setup' needed). Omit name to list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Command name to look up." },
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
const INSTRUCTIONS = `Design-to-code workflow (Figma -> code). The design is the complete
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
   - every file in assets.json is referenced in the build (grep for each
     filename) — absolutely-positioned/overhanging SVGs are the ones that
     get lost;
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
     built with the wrapper/padding or mask pattern, never border-image.

NEVER estimate colors, fonts, sizes or radii from a screenshot — every exact
value is in the phase "style" spec. If you only pulled "structure", pull
"style" too before styling anything.

Large screens: do NOT pull one giant style spec. First run figma_spec with
phase "structure" and depth 3-4 — a map of the screen with the node id of
every section. Then pull phase "style" PER SECTION (nodeId-scoped) and build
section by section. figma_spec accepts any sub-node id and a depth limit.

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
LAST step, once the stories exist.`;

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

async function handleTool(name, rawArgs) {
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
      const res = await runCli(normalizeOutputArgs(args), { label: input.label });
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
      return textResult(
        buildHistory({
          nodeId,
          limit,
          format: input.format === "json" ? "json" : "markdown",
          gitPaths: input.gitPaths,
          repoPath: input.repoPath,
        }),
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
    { name: "figma-safe-mcp", version: SERVER_VERSION.split(" ")[0] },
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
    process.stderr.write(`figma-safe-mcp failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
