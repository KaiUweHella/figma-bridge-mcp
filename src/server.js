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
import { join, dirname } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli, runCliPlan, runInProcessCommand, runInProcessCommandPlan, evaluateFigma, evaluateFigmaWithMetadata, typedReadFigma, renderFigmaPlan, renderFigmaPlans, captureFigmaDesign, ensurePluginReadiness, ensureSafeConnect, health, probePluginResponsiveness, recoverPluginConnection, getSelection } from "./engine.js";
import { formatPublicError } from "./error-projection.js";
import {
  legacyCommandRiskGateReason,
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
import {
  codeSpecPlanRoute,
  codeSpecPlanningArgvFromRequest,
  executeCodeSpecPlan,
} from "../engine/src/application/code-spec-command.js";
import {
  executeInspectPlan,
  inspectPlanningArgvFromRequest,
  inspectPlanRoute,
} from "../engine/src/application/inspect-command.js";
import {
  executeScreenshotPlan,
  screenshotPlanRoute,
  screenshotPlanningArgvFromRequest,
} from "../engine/src/application/screenshot-command.js";
import {
  executeHistoryPlan,
  historyPlanRoute,
  historyPlanningArgvFromRequest,
} from "../engine/src/application/history-command.js";
import {
  designLinkFileKeyFromArgv,
  designLinkPlanRoute,
  designLinkRequestFromArgv,
  executeDesignLink,
  executeDesignLinkPlan,
  formatDesignLinkResult,
} from "../engine/src/application/design-link-command.js";
import {
  designContractFileKeyFromArgv,
  designContractPlanRoute,
  executeDesignContractPlan,
  formatDesignContractAdapterResult,
} from "../engine/src/application/design-contract-command.js";
import {
  executeAssetExportPlan,
  formatAssetExportResult,
} from "../engine/src/application/asset-export-command.js";
import {
  executeNodeTextPlan,
  formatNodeTextResult,
  nodeTextPlanRoute,
} from "../engine/src/application/node-text-command.js";
import {
  executeNodeCssPlan,
  nodeCssPlanRoute,
} from "../engine/src/application/node-css-command.js";
import {
  executeNodeBindingsPlan,
  nodeBindingsPlanRoute,
} from "../engine/src/application/node-bindings-command.js";
import {
  executeNodeTreePlan,
  nodeTreePlanRoute,
} from "../engine/src/application/node-tree-command.js";
import {
  executeNodeDiscoveryPlan,
  nodeDiscoveryPlanRoute,
} from "../engine/src/application/node-discovery-command.js";
import {
  executePrototypeInspectionPlan,
  prototypeInspectionPlanRoute,
} from "../engine/src/application/prototype-inspection-command.js";
import {
  collectionCatalogPlanRoute,
  executeCollectionCatalogPlan,
} from "../engine/src/application/collection-catalog-command.js";
import {
  collectionFactsPlanRoute,
  executeCollectionFactsPlan,
} from "../engine/src/application/collection-facts-command.js";
import {
  collectionCreatePlanRoute,
  executeCollectionCreatePlan,
} from "../engine/src/application/collection-create-command.js";
import {
  executeTokenPublishStatusPlan,
  tokenPublishStatusPlanRoute,
} from "../engine/src/application/token-publish-status-command.js";
import {
  executeVariableDiscoveryPlan,
  variableDiscoveryPlanRoute,
} from "../engine/src/application/variable-discovery-command.js";
import {
  executeVariableFactsPlan,
  variableFactsPlanRoute,
} from "../engine/src/application/variable-facts-command.js";
import {
  executeVariableResolutionPlan,
  variableResolutionPlanRoute,
} from "../engine/src/application/variable-resolution-command.js";
import {
  executeFontInspectionPlan,
  fontInspectionPlanRoute,
} from "../engine/src/application/font-inspection-command.js";
import {
  componentMainPlanRoute,
  executeComponentMainPlan,
} from "../engine/src/application/component-main-command.js";
import {
  executeStyleFactsPlan,
  styleFactsPlanRoute,
} from "../engine/src/application/style-facts-command.js";
import {
  executeStyleCatalogPlan,
  styleCatalogPlanRoute,
} from "../engine/src/application/style-catalog-command.js";
import {
  executeStyleConsumerPlan,
  styleConsumerPlanRoute,
} from "../engine/src/application/style-consumer-command.js";
import {
  executeStylePublishStatusPlan,
  stylePublishStatusPlanRoute,
} from "../engine/src/application/style-publish-status-command.js";
import {
  executeStyleApplyPlan,
  styleApplyPlanRoute,
} from "../engine/src/application/style-apply-command.js";
import {
  executeStyleCreatePlan,
  styleCreatePlanRoute,
} from "../engine/src/application/style-create-command.js";
import {
  executeStyleUpdatePlan,
  styleUpdatePlanRoute,
} from "../engine/src/application/style-update-command.js";
import {
  executeStyleDeletePlan,
  styleDeletePlanRoute,
} from "../engine/src/application/style-delete-command.js";
import {
  executeTextStyleVariableBindingPlan,
  textStyleVariableBindingPlanRoute,
} from "../engine/src/application/text-style-variable-binding-command.js";
import {
  executeLayoutGridFactsPlan,
  layoutGridFactsPlanRoute,
} from "../engine/src/application/layout-grid-facts-command.js";
import {
  canvasAwarenessPlanRoute,
  executeCanvasAwarenessPlan,
} from "../engine/src/application/canvas-awareness-command.js";
import {
  executePageNavigationPlan,
  pageNavigationPlanRoute,
} from "../engine/src/application/page-navigation-command.js";
import {
  executePageStructurePlan,
  pageStructurePlanRoute,
} from "../engine/src/application/page-structure-command.js";
import {
  executePreparedCompoundSemanticRender,
  executePreparedSemanticRender,
  formatSemanticRenderResult,
  prepareCompoundSemanticRenderPlan,
  prepareSemanticRenderPlan,
  semanticRenderArgvFromRequest,
  semanticRenderOutcomeCode,
  semanticRenderPlanRoute,
} from "../engine/src/application/semantic-render-command.js";
import {
  MAX_COMPOUND_RENDER_ROOTS,
  MAX_SEMANTIC_RENDER_LIST_ITEMS,
  SEMANTIC_RENDER_DEVICE_PRESETS,
  semanticRenderArgvRoute,
  semanticRenderRequestFromArgv,
} from "../engine/src/application/semantic-render-request.js";
import { formatRoundTripFidelityContract } from "../engine/src/lib/round-trip-fidelity-contract.js";
import { isSemanticRenderOutcome } from "../engine/src/lib/semantic-render-outcome.js";
import { parseBoundedJson } from "../engine/src/lib/workspace-io.js";
import {
  createVerificationArtifactWriter,
  VERIFICATION_ARTIFACT_ROLE,
} from "../engine/src/application/verification-artifact.js";
import { WRITE_CONFIRM, WORKSPACE_IO } from "./config.js";
import { getAuditStatus } from "./audit-trail.js";
import { createTrackedJobRegistry } from "./tracked-job-registry.js";

export const MCP_SERVER_ID = "figma-bridge-mcp";
export const MCP_TOOL_NAMESPACE = "figma-bridge";

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

const SPEC_REQUEST_PROPERTIES = {
  nodeId: {
    type: "string",
    description: "Node id or Figma URL.",
  },
  phase: {
    type: "string",
    enum: ["structure", "style", "all"],
    description: "all (default), structure, or style.",
  },
  depth: {
    type: "number",
    description: "Tree depth; 0 = node only, default 12, max 30.",
  },
  section: {
    type: "string",
    description: "Optional child layer name.",
  },
  format: {
    type: "string",
    enum: ["tree", "yaml", "json"],
    default: DEFAULT_SPEC_FORMAT,
    description: "tree (default), yaml, or json.",
  },
  includeHidden: {
    type: "boolean",
    description: "Include invisible nodes (default false).",
  },
  dedup: {
    type: "boolean",
    default: false,
    description: "false: inline every layer; true: compact repeats.",
  },
};

// Exported so tests can assert on the surface itself: "12 tools" is a claim the
// project makes, and a schema regression should fail the build, not the README.
export const TOOLS = [
  {
    name: "figma_connect",
    description:
      "Connect Figma Bridge in Safe Mode; recover its plugin, create its key, or return import steps.",
    annotations: toolAnnotations({
      readOnlyHint: false,
    }),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_status",
    description:
      "Status for this Figma Bridge only. Real round-trip by default; REST validation opt-in.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        validateRest: { type: "boolean", description: "Validate the optional REST token." },
        probePlugin: { type: "boolean", default: true, description: "Probe plugin eval; false checks only its socket." },
        fileKey: { type: "string", description: "Figma key/URL for REST validation." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_pairing",
    description:
      "Show the Figma plugin access key. Pass rotate:true to generate a fresh key and restart the daemon with it.",
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
            "Replace the key and restart the daemon.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_run",
    description:
      'Run an approved engine command. See figma_reference {name:"capabilities"}; use --help for syntax.',
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
          description: "Command argv, e.g. [\"canvas\",\"info\"].",
        },
        confirm: {
          type: "boolean",
          description: "Required in write-confirm mode.",
        },
        label: {
          type: "string",
        },
        fileKey: {
          type: "string",
          description: "Figma key/URL.",
        },
        force: {
          type: "boolean",
          description: "Asset Export: bypass completed retry cache.",
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_render",
    description: "Render one JSX value or a mutually exclusive roots[] batch into the open Figma design.",
    annotations: toolAnnotations({
      readOnlyHint: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        jsx: { type: "string" },
        roots: {
          type: "array", minItems: 1, maxItems: MAX_COMPOUND_RENDER_ROOTS,
          items: { type: "string", minLength: 1 },
        },
        keepWrapper: { type: "boolean" },
        gap: { type: "number", minimum: 0, maximum: 10000 },
        direction: { type: "string", enum: ["row", "col"] },
        x: { type: "number" },
        y: { type: "number" },
        smartPosition: { type: "boolean" },
        asComponent: { type: "boolean" },
        verify: { type: "boolean" },
        resizeProbe: { type: "number", minimum: 1, maximum: 2000 },
        collection: { type: "string", minLength: 1 },
        preset: {
          type: "string",
          enum: Object.keys(SEMANTIC_RENDER_DEVICE_PRESETS),
        },
        manifest: { type: "string", minLength: 1 },
        icons: { type: "string", minLength: 1 },
        approvedFallbacks: {
          type: "array",
          maxItems: MAX_SEMANTIC_RENDER_LIST_ITEMS,
          items: { type: "string", minLength: 1 },
        },
        allowedFreePaths: {
          type: "array",
          maxItems: MAX_SEMANTIC_RENDER_LIST_ITEMS,
          items: { type: "string", minLength: 1 },
        },
        confirm: {
          type: "boolean",
          description: "Required in write-confirm mode.",
        },
        label: {
          type: "string",
          description: "Optional intent stored only as non-reversible audit metadata.",
        },
        fileKey: { type: "string", description: "Figma key/URL." },
      },
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
        fileKey: { type: "string", description: "Figma key/URL." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_history",
    description:
      "Private local command history, git/Figma version merge, and snapshot diff; new records omit raw or sensitive payloads.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Node-id filter.",
        },
        limit: {
          type: "number",
          description: "Default 20; max 200.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Default markdown.",
        },
        gitPaths: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths for git history.",
        },
        repoPath: {
          type: "string",
          description: "Repo root for gitPaths.",
        },
        includeVersions: {
          type: "boolean",
          description:
            "Merge Figma versions via optional REST.",
        },
        fileKey: {
          type: "string",
          description:
            "Figma key/URL for versions.",
        },
        diff: {
          type: "object",
          description:
            "Diff live/latest/previous, an index, or a Figma version.",
          properties: {
            from: { type: "string", description: "Older ref; default previous." },
            to: { type: "string", description: "Newer ref; default latest." },
            nodeId: { type: "string", description: "Live subtree root." },
            changelog: { type: "boolean", description: "Return markdown changelog." },
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
      "Read or post Figma comments through optional REST. list returns ids, authors, node anchors and resolved state. post needs message plus optional nodeId/replyTo; it always previews and requires confirm:true because comments are public. Without a REST token, returns setup guidance.",
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
      "Offline Plugin API reference. Special topics: capabilities, fidelity, variable-scopes, workflow, workflow:design-to-code, workflow:code-to-figma.",
    annotations: toolAnnotations({
      readOnlyHint: true,
      openWorldHint: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "API name, capabilities, fidelity or workflow topic; omit to list API names." },
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
          description: "Requested scale (default 0.5; 2000px cap). Returns exact PNG pixelWidth/pixelHeight, logical nodeWidth/nodeHeight, and requested/applied scales.",
        },
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_spec",
    description:
      "Exact per-layer design facts. Copy; never invent. Use nodeIds[] for up to 8 same-scope reads behind one approval.",
    annotations: toolAnnotations({
      readOnlyHint: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        ...SPEC_REQUEST_PROPERTIES,
        nodeIds: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string" },
          description:
            "Node ids for one bounded batch; phase/depth/format options apply to every id.",
        },
        fileKey: { type: "string", description: "Target connected file: bare key or Figma URL." },
      },
      anyOf: [
        { required: ["nodeId"] },
        { required: ["nodeIds"] },
      ],
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
          `componentize repeated structures, preserve source SVGs/images, map only ` +
          `representable prototype reactions, and execute ` +
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
export const INSTRUCTIONS = `Server figma-bridge-mcp: its failure does not prove Figma unavailable; never switch MCPs for writes.

Design-to-code: Figma is the spec. Never invent or drop text, assets,
tokens, layout or states. Follow this order:
1. figma_screenshot, then read the PNG as visual ground truth.
2. Use one figma_spec call with phase "all", format "tree", depth 3-4. Copy
   hierarchy, text, ids and exact styles; use structure for a very large frame.
3. figma_run ["export","css","<nodeId>"] and wire up the scoped tokens/fonts.
4. figma_run ["export","assets","<nodeId>","-o","/abs/project/src/assets"]
   for images/SVGs plus assets.json. Never substitute CSS placeholders or
   inline SVGs. If still RUNNING, poll the same call.
5. If deeper style facts are missing, use one figma_spec nodeIds[] batch for
   all section ids. Use depth 0 and dedup for repeats. Do not call each
   section separately; one batch needs one manual approval.
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
2. Prefer one figma_spec with phase "all", format "tree" and depth 3-4 — build
   the markup/component skeleton and its bounded exact styles from it. For a
   very large screen use phase "structure" here, then batch styles in step 5.
   Use real text characters, real icon/component names and hierarchy.
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
5. If deeper facts are still missing, make ONE figma_spec call with nodeIds[]
   containing every same-scope section read, for example
   {nodeIds:["12:34","12:56"],phase:"style",depth:0,dedup:true}.
   This keeps multiple reads behind one manual approval. Do not call each
   section separately. Depth 0 gets a container's own background/border/
   radius/layout; add only child ids whose facts are still missing and use
   dedup true for repeated cards/lists. Apply sizes, gaps, padding, alignment,
   fills/strokes (prefer the var(...) token names), radii, shadows,
   typography, opacity, clip (overflow hidden), masks, blend modes, corner
   smoothing, strokes-in-layout, full modern effect parameters, and abs
   positioning. Every
   "vector art -> assets/..." line is real artwork (waves, glyphs, bubbles):
   place the exported SVG at its "place left/top" offsets with its stated
   W x H — these are rendered values that match the file exactly. Keep
   overlays marked "overhangs parent" even when they stick out; never
   approximate artwork with CSS.
6. Interactive states: the spec ends with "Component sets used on this
   screen". Add the listed SET node ids to the same nodeIds[] batch when
   possible; one bounded set read captures every variant and its exact styles.
   Implement flagged axes as CSS :hover/:active/:focus-visible/
   [disabled]. Treat every "Prototype reaction:" record as interaction
   evidence: implement it only when its app behavior is clear, and never map
   Figma navigation/overlay/back actions blindly onto routing. A screen with
   only default states is incomplete.
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
phase "structure", format "tree" and depth 3-4 — a map of the screen with the
node id of every section. Then send all needed phase "style" depth-0 section
reads together through nodeIds[] in one figma_spec call/manual approval. Add
bounded child ids to that batch only when their facts are missing; use dedup
true for repeated rows/cards. Do not issue one tool call per section.

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
5. Interactions: map only representable source handlers to native prototype
   reactions with ["prototype","add",...] or lossless
   ["prototype","set","<id>","--json",...], then verify with
   ["prototype","inspect","<id>"]. Routing, application state, async work and
   other runtime behavior stay code-owned and must be reported as a boundary.
6. Images: <Image src="/abs/or/relative.png" imageScale="FILL|FIT|CROP|TILE">
   imports the actual file (CLI reads it, no plugin network). Without src=
   you get a named grey placeholder carrying an "Image placeholder"
   annotation; fill it later with ["node","set-image","<id>","photo.png"].
   Files > 8 MB are refused — downscale first (Figma caps images at 4096px).
7. Icons: <Icon name="check"> renders ~40 built-in geometry vectors
   (check/x/plus/chevrons/arrows/search/bell/droplet/sun/home/settings/...,
   aliases like close/back/gear). Project icons: ["render","--icons","<dir>"]
   loads every *.svg (name = file basename) and overrides built-ins.
   Unknown names stay grey placeholder boxes.
8. Responsive by construction: size every container deliberately — w="fill"
   (stretch), w="hug" (wrap content) or a fixed number; leaf elements
   (Image/Rect/Ellipse) take w="fill" too. Add minW/maxW/minH/maxH where a
   fluid element has real limits (cards in a grid: w="fill" minW="140"
   maxW="240"). A fixed-size element inside a fluid parent is usually a
   bug — the PlantCard photo overhang came from exactly that.
9. Fix-ups without re-rendering: ["node","move","<id>","<x>","<y>"]
   (--page reparents across pages), ["node","resize","<id>","<w|keep|fill|hug>","<h|keep|fill|hug>"],
   ["node","rename"], ["node","set-text"], ["node","set-fill","<id>","#hex|var:name"],
   ["node","set-image"]. Find ids via ["node","tree","<id>","--ids"] or
   ["find","<name>"]. A fixed-height render prints an overflow warning with
   the measured spill — fix it right then.
10. Organize: ["canvas","page-create","<name>"] for a fresh page,
   ["section","create","<name>","<ids>"] to group,
   ["section","arrange","<id>","--cols","4"] to tidy,
   ["section","fit","<id>"] after manual moves. ["render","--verify"]
   returns a screenshot in the same call — always look at it. For a linked
   screen, compare that PNG to the browser screenshot and only then accept via
   ["link","accept","<entity.id>","--compare","/abs/browser.png",
   "--max-diff","5"].

=== Optional REST add-on (Figma personal access token) ===

Opt-in extras the local plugin bridge cannot reach. Setup: the user pastes a
Figma personal access token into Setup → "Figma REST token" in the Figma Bridge
plugin (stored 0600 on this machine; FIGMA_REST_TOKEN env for headless runs).
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

function identifiedResult(result, auditStatus = getAuditStatus()) {
  return {
    ...result,
    _mcp: MCP_SERVER_ID,
    _meta: {
      ...(result._meta || {}),
      [MCP_SERVER_ID]: {
        serverId: MCP_SERVER_ID,
        toolNamespace: MCP_TOOL_NAMESPACE,
        failureScope: "this-server-only",
        ...(auditStatus?.status === "degraded"
          ? {
              auditTrail: {
                status: "degraded",
                code: auditStatus.code,
                since: auditStatus.since,
              },
            }
          : {}),
      },
    },
  };
}

function auditWarning(status) {
  if (status?.status !== "degraded") return "";
  return (
    "[audit warning] This operation was not blocked, but its private local " +
    `Audit Trail is incomplete (${status.code}). Fix local state permissions or disk availability; ` +
    "the warning clears after a fully recorded operation."
  );
}

function textResult(text, { audit = getAuditStatus() } = {}) {
  const warning = auditWarning(audit);
  const body = [text || "", warning].filter(Boolean).join("\n\n");
  return identifiedResult({ content: [{ type: "text", text: body }] }, audit);
}

function errorResult(text, { audit = getAuditStatus(), structuredContent = null } = {}) {
  let body = String(text || "The Figma Bridge request failed.");
  if (!body.startsWith(`[${MCP_SERVER_ID}]`)) {
    body = `[${MCP_SERVER_ID}] ${body}`;
  }
  const scope = "Only this Figma Bridge transport failed; this does not mean Figma or another Figma MCP is unavailable.";
  if (!body.includes(scope)) body += `\n\n${scope}`;
  const warning = auditWarning(audit);
  if (warning && !body.includes(warning)) body += `\n\n${warning}`;
  return identifiedResult({
    content: [{ type: "text", text: body }],
    isError: true,
    ...(isSemanticRenderOutcome(structuredContent) ? { structuredContent } : {}),
  }, audit);
}

export async function executeSpecBatch(requests, executeOne, options = {}) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 8) {
    return errorResult("nodeIds must contain between 1 and 8 bounded figma_spec reads.");
  }
  if (typeof executeOne !== "function") {
    return errorResult("figma_spec batch executor is unavailable.");
  }

  const allowed = new Set(Object.keys(SPEC_REQUEST_PROPERTIES));
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return errorResult(`requests[${index}] must be an object.`);
    }
    const unknown = Object.keys(request).filter((key) => !allowed.has(key));
    if (unknown.length) {
      return errorResult(`requests[${index}] has unknown parameter(s): ${unknown.join(", ")}.`);
    }
    if (typeof request.nodeId !== "string" || request.nodeId.length === 0) {
      return errorResult(`requests[${index}].nodeId must be a non-empty string.`);
    }
  }

  const parts = [];
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    const result = await executeOne(request, index);
    const text = (result?.content || [])
      .filter((item) => item?.type === "text")
      .map((item) => item.text || "")
      .join("\n");
    const label = `${request.nodeId} · ${request.phase || "all"} · depth ${request.depth ?? 12}`;
    if (result?.isError) {
      return errorResult(
        `figma_spec batch stopped at request ${index + 1}/${requests.length} (${label}).\n\n${text}`,
      );
    }
    parts.push(`## ${index + 1}/${requests.length} — ${label}\n\n${text}`);
  }

  const output = `# Figma Spec Batch — ${requests.length} complete reads\n\n${parts.join("\n\n")}`;
  const limit = Number(options.limit) || SPEC_OUTPUT_LIMIT_CHARS;
  if (output.length > limit) {
    return errorResult(
      `spec_batch_result:\n  complete: false\n  reason: output_budget\n` +
      `  measured_chars: ${output.length}\n  limit_chars: ${limit}\n  requested_reads: ${requests.length}\n\n` +
      `No partial batch data was returned. Retry once with fewer nodeIds in each batch; ` +
      `keep style reads at depth 0 and use dedup true for repeated lists/cards.`,
    );
  }
  return textResult(output);
}

function resultFromCli({ stdout, stderr, audit }) {
  // stdout AND stderr both reach the agent: the CLI puts warnings and
  // per-asset failure reasons on stderr, and dropping them produced summaries
  // like "1 asset(s) failed (listed above)" with nothing listed above.
  const out = (stdout || "").trimEnd();
  const err = (stderr || "").trim();
  if (out && err) return textResult(out + "\n\n[warnings]\n" + err, { audit });
  return textResult(out || err, { audit });
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
const assetJobs = createTrackedJobRegistry({ resultCacheMs: ASSET_RESULT_CACHE_MS });

export function assetExportJobKey(args, fileKey) {
  return planFigmaCommand(args, { fileKey }).execution.jobKey;
}

async function runAssetExport(plan, label, { force = false } = {}) {
  const outDir = plan.outputs[0]?.path || null;
  const key = plan.execution.jobKey;
  if (!key) return errorResult("Command is not configured as a background job.");
  const operation = () => runInProcessCommandPlan(
    plan,
    { label, compatibilityFallback: false },
    async ({ fileKey, expectedEditor, deadline }) => {
      const remainingMs = () => Math.max(0, deadline - Date.now());
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      const result = await executeAssetExportPlan(plan, {
        workspaceIO: WORKSPACE_IO,
        remainingMs,
        yieldControl: () => new Promise((resolveYield) => setImmediate(resolveYield)),
        evaluate: (code, context = {}) => evaluateFigmaWithMetadata(code, {
          fileKey: context.fileKey || fileKey,
          expectedEditor,
          timeoutMs: Math.max(1, context.remainingMs ?? remainingMs()),
        }),
      });
      return { stdout: formatAssetExportResult(result), stderr: "", code: 0 };
    },
  );
  let attached = assetJobs.attach(key, operation);
  if (force && !attached.started && attached.job.done) {
    assetJobs.discard(key, attached.job);
    attached = assetJobs.attach(key, operation);
  }
  const { job } = attached;
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
    assetJobs.discard(key, job);
    const out = String(job.error.stdout || "").trim();
    const err = String(job.error.stderr || "").trim();
    const fallback = formatPublicError(job.error);
    return errorResult(
      [out, err || (!out ? fallback : "")].filter(Boolean).join("\n\n"),
      { audit: job.error.audit || getAuditStatus() },
    );
  }
  assetJobs.cacheSuccess(key, job);
  return resultFromCli(job.result);
}

async function runSemanticRenderApplication(plan, label, prepared) {
  let outcome = null;
  const compound = semanticRenderPlanRoute(plan) === "compound-command-application";
  const verificationWriter = compound && prepared.request.stages.verification
    ? createVerificationArtifactWriter(
      plan.outputs.filter((output) => output.role === VERIFICATION_ARTIFACT_ROLE),
      { workspaceIO: WORKSPACE_IO },
    )
    : null;
  const res = await runInProcessCommandPlan(plan, {
    label,
    compatibilityFallback: false,
  }, async ({ fileKey, expectedEditor, deadline }) => {
    const remainingMs = () => Math.max(1, deadline - Date.now());
    await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
    const evaluate = (code) => evaluateFigma(code, {
      fileKey,
      expectedEditor,
      timeoutMs: remainingMs(),
    });
    const adapters = {
      renderPlan: (renderPlan) => renderFigmaPlan(renderPlan, {
        fileKey,
        expectedEditor,
        timeoutMs: remainingMs(),
      }),
      renderPlanBatch: (renderPlans, options) => renderFigmaPlans(renderPlans, options, {
        fileKey,
        expectedEditor,
        timeoutMs: remainingMs(),
      }),
      evaluate,
      inspectInventory: evaluate,
      writeVerification: ({ index, bytes }) => verificationWriter.write(index, bytes),
    };
    outcome = compound
      ? await executePreparedCompoundSemanticRender(prepared, adapters)
      : await executePreparedSemanticRender(prepared, adapters);
    return {
      stdout: formatSemanticRenderResult(outcome),
      stderr: "",
      code: semanticRenderOutcomeCode(outcome),
    };
  });
  return {
    ...resultFromCli(res),
    structuredContent: outcome,
  };
}

/**
 * Resolve one figma_run Command Plan after path normalization. Registry lookup
 * stays lazy behind the Figma Target Context precedence rules.
 */
export function planFigmaRunCommand(args, {
  fileKey = null,
  workspaceDir = process.cwd(),
  workspaceIO = null,
} = {}) {
  return planFigmaCommand(args, {
    fileKey,
    workspaceDir,
    workspaceIO,
    registryFileKey: (argv) => argv[0] === "link"
      ? designLinkFileKeyFromArgv([...argv], { io: workspaceIO })
      : argv[0] === "contract"
        ? designContractFileKeyFromArgv([...argv], { io: workspaceIO })
        : null,
  });
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
    const doc = parseBoundedJson(
      WORKSPACE_IO.readText(file, { role: "component-map-output" }),
      { role: "component-map-output", limits: WORKSPACE_IO.limits },
    );
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
    WORKSPACE_IO.write(file, JSON.stringify(doc, null, 2), {
      role: "component-map-output",
      createParents: true,
    });
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

function semanticRenderToolArgv(input) {
  const hasJsx = typeof input.jsx === "string" && input.jsx.length > 0;
  const hasRoots = Array.isArray(input.roots);
  if (hasJsx === hasRoots) {
    throw new Error("Pass exactly one of jsx or roots.");
  }
  if (hasRoots && (input.roots.length < 1 || input.roots.length > MAX_COMPOUND_RENDER_ROOTS
    || input.roots.some((root) => typeof root !== "string" || root.length === 0))) {
    throw new Error(`roots must contain 1 to ${MAX_COMPOUND_RENDER_ROOTS} non-empty JSX strings.`);
  }
  if (input.keepWrapper !== undefined && typeof input.keepWrapper !== "boolean") {
    throw new Error("keepWrapper must be a boolean.");
  }
  if (hasRoots && input.keepWrapper !== undefined) throw new Error("keepWrapper is available only with jsx.");
  for (const key of ["collection", "preset", "manifest", "icons"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length === 0)) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
  for (const key of ["approvedFallbacks", "allowedFreePaths"]) {
    if (input[key] !== undefined && (!Array.isArray(input[key])
      || input[key].length > MAX_SEMANTIC_RENDER_LIST_ITEMS
      || input[key].some((value) => typeof value !== "string" || value.length === 0))) {
      throw new Error(`${key} must contain at most ${MAX_SEMANTIC_RENDER_LIST_ITEMS} non-empty strings.`);
    }
  }
  for (const key of ["smartPosition", "asComponent", "verify"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
  for (const key of ["gap", "x", "y", "resizeProbe"]) {
    if (input[key] !== undefined && (typeof input[key] !== "number" || !Number.isFinite(input[key]))) {
      throw new Error(`${key} must be a finite number.`);
    }
  }
  if (input.direction !== undefined && !["row", "col"].includes(input.direction)) {
    throw new Error("direction must be row or col.");
  }
  const args = hasRoots ? ["render-batch", JSON.stringify(input.roots)] : ["render"];
  if (input.keepWrapper === true) args.push("--keep-wrapper");
  if (input.gap !== undefined) args.push(`--gap=${input.gap}`);
  if (input.direction !== undefined) args.push(`--direction=${input.direction}`);
  if (input.x !== undefined) args.push(`-x${input.x}`);
  if (input.y !== undefined) args.push(`-y${input.y}`);
  if (input.smartPosition === false) args.push("--no-smart-position");
  if (input.asComponent === true) args.push("--as-component");
  if (input.verify === true) args.push("--verify");
  if (input.resizeProbe !== undefined) args.push(`--resize-probe=${input.resizeProbe}`);
  if (input.collection !== undefined) args.push(`--collection=${input.collection}`);
  if (input.preset !== undefined) args.push(`--preset=${input.preset}`);
  if (input.manifest !== undefined) args.push(`--manifest=${input.manifest}`);
  if (input.icons !== undefined) args.push(`--icons=${input.icons}`);
  if (input.approvedFallbacks?.length) args.push(`--approve-fallback=${input.approvedFallbacks.join(",")}`);
  if (input.allowedFreePaths?.length) args.push(`--allow-free-layout=${input.allowedFreePaths.join(",")}`);
  // Typed JSX is always data, even when it happens to equal a CLI flag.
  if (hasJsx) args.push("--", input.jsx);
  const route = semanticRenderArgvRoute(args);
  return route.kind === "simple"
    ? semanticRenderArgvFromRequest(semanticRenderRequestFromArgv(args))
    : args;
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
      let recoveryNote = "";
      // A new AI session must preserve a healthy socket. Only attempt the
      // iframe self-heal when exactly one socket exists, no command is active,
      // and a real read-only round-trip proves that socket is wedged.
      const current = await health();
      const connections = Array.isArray(current.raw?.connections) ? current.raw.connections : [];
      if (current.plugin && connections.length === 1 && Number(current.raw?.inFlightExecs || 0) === 0) {
        const probe = await probePluginResponsiveness(
          connections[0].fileKey,
          3000,
          connections[0].editorType || 'figma',
        );
        if (!probe.responsive) {
          try {
            const recovery = await recoverPluginConnection(connections[0].fileKey, 6500);
            recoveryNote = recovery.reloaded > 0
              ? "\nPlugin socket was open but unresponsive; its UI was reloaded and is reconnecting automatically.\n"
              : recovery.forcedClosed > 0
                ? "\nPlugin UI did not answer; its stale socket was reset and quiet discovery is reconnecting it automatically.\n"
                : "";
          } catch (error) {
            recoveryNote = `\nAutomatic plugin recovery could not complete: ${error.message}\n`;
          }
        }
      }
      const keyBlock =
        "\n────────────────────────────────────────\n" +
        `  Plugin access key${created ? " (newly generated)" : ""}:\n\n` +
        `    ${key}\n\n` +
        "  Paste this into the Figma Bridge plugin's access-key field in Figma\n" +
        "  the first time you launch it. It is stored in the plugin and\n" +
        "  reused across sessions.\n" +
        "────────────────────────────────────────\n";
      return textResult(`[${MCP_SERVER_ID}]\n` + (res.stdout || res.stderr || "") + recoveryNote + keyBlock);
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
          "Run figma_connect to ensure the daemon is available; the open Figma Bridge " +
          "plugin discovers it automatically without replacing a healthy connection.";
      }
      const lines = [
        `[${MCP_SERVER_ID}] ${headline}`,
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
              probe: await probePluginResponsiveness(
                connection.fileKey,
                4000,
                connection.editorType || 'figma',
              ),
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
          const targetConnection = input.fileKey
            ? conns.find((connection) => connection.fileKey === input.fileKey)
            : conns.length === 1 ? conns[0] : null;
          const probe = await probePluginResponsiveness(
            input.fileKey,
            4000,
            targetConnection?.editorType || 'figma',
          );
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
        await ensureSafeConnect({ forceRestart: true });
        return textResult(
          `New plugin access key generated:\n\n    ${key}\n\n` +
            `Stored at: ${keyPath()}\n\n` +
            "The daemon was restarted with the new key and the old key is invalid.\n" +
            "Paste the new key into the Figma Bridge plugin once.",
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
      if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string")) {
        return errorResult("args must be a non-empty array of strings.");
      }
      const plan = planFigmaRunCommand(args, {
        fileKey: input.fileKey,
        workspaceIO: WORKSPACE_IO,
      });
      if (!plan.allowed) {
        const riskGate = legacyCommandRiskGateReason(args);
        return errorResult(
          riskGate
            || 'Unknown or unsupported Figma Command. Run figma_run with args ["--help"] to list the supported grammar.',
        );
      }
      if (input.force === true && plan.execution.mode !== "tracked-job") {
        return errorResult("force is only available for tracked Asset Export commands.");
      }
      const semanticRenderRoute = semanticRenderPlanRoute(plan);
      const semanticRenderApplication = semanticRenderRoute === "command-application"
        || semanticRenderRoute === "compound-command-application";
      let preparedSemanticRender = null;
      if (semanticRenderApplication) {
        try {
          preparedSemanticRender = semanticRenderRoute === "compound-command-application"
            ? prepareCompoundSemanticRenderPlan(plan, { workspaceIO: WORKSPACE_IO })
            : prepareSemanticRenderPlan(plan, { workspaceIO: WORKSPACE_IO });
        } catch (error) {
          return errorResult(error?.message || String(error));
        }
      }
      if (WRITE_CONFIRM && plan.confirmation === "configured" && input.confirm !== true) {
        return previewResult(args);
      }
      if (plan.execution.mode === "tracked-job") {
        return await runAssetExport(plan, input.label, { force: input.force === true });
      }
      // Command-specific path rules are owned by the Capability Catalog.
      const normalized = [...plan.argv];
      const designLinkRoute = designLinkPlanRoute(plan);
      if (designLinkRoute !== "not-design-link") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: designLinkRoute === "command-application" ? false : undefined,
        },
          async ({ fileKey, expectedEditor, timeoutMs }) => {
            const adapters = {
              evaluate: (code) => evaluateFigma(code, { fileKey, expectedEditor, timeoutMs }),
              workspaceIO: WORKSPACE_IO,
            };
            const result = designLinkRoute === "command-application"
              ? await executeDesignLinkPlan(plan, adapters)
              : await executeDesignLink(designLinkRequestFromArgv(normalized), adapters);
            return { stdout: formatDesignLinkResult(result), stderr: "" };
          });
        return resultFromCli(res);
      }
      const designContractRoute = designContractPlanRoute(plan);
      if (designContractRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, timeoutMs }) => {
          const result = await executeDesignContractPlan(plan, {
            evaluate: (code) => evaluateFigma(code, { fileKey, expectedEditor, timeoutMs }),
            workspaceIO: WORKSPACE_IO,
          });
          return {
            stdout: formatDesignContractAdapterResult(result),
            stderr: "",
            code: result.action === "check" && !result.check.ok ? 1 : 0,
          };
        });
        return resultFromCli(res);
      }
      const nodeTextRoute = nodeTextPlanRoute(plan);
      if (nodeTextRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          const result = await executeNodeTextPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
          return {
            stdout: formatNodeTextResult(result),
            stderr: "",
            code: 0,
          };
        });
        return resultFromCli(res);
      }
      const nodeBindingsRoute = nodeBindingsPlanRoute(plan);
      if (nodeBindingsRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeBindingsPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const nodeCssRoute = nodeCssPlanRoute(plan);
      if (nodeCssRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeCssPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const nodeTreeRoute = nodeTreePlanRoute(plan);
      if (nodeTreeRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeTreePlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const nodeDiscoveryRoute = nodeDiscoveryPlanRoute(plan);
      if (nodeDiscoveryRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeDiscoveryPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const prototypeInspectionRoute = prototypeInspectionPlanRoute(plan);
      if (prototypeInspectionRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executePrototypeInspectionPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const collectionCreateRoute = collectionCreatePlanRoute(plan);
      if (collectionCreateRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionCreatePlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const collectionCatalogRoute = collectionCatalogPlanRoute(plan);
      if (collectionCatalogRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionCatalogPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const collectionFactsRoute = collectionFactsPlanRoute(plan);
      if (collectionFactsRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionFactsPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const variableDiscoveryRoute = variableDiscoveryPlanRoute(plan);
      if (variableDiscoveryRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableDiscoveryPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const tokenPublishStatusRoute = tokenPublishStatusPlanRoute(plan);
      if (tokenPublishStatusRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenPublishStatusPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const variableFactsRoute = variableFactsPlanRoute(plan);
      if (variableFactsRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableFactsPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const variableResolutionRoute = variableResolutionPlanRoute(plan);
      if (variableResolutionRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableResolutionPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const fontInspectionRoute = fontInspectionPlanRoute(plan);
      if (fontInspectionRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeFontInspectionPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const componentMainRoute = componentMainPlanRoute(plan);
      if (componentMainRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeComponentMainPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const styleCatalogRoute = styleCatalogPlanRoute(plan);
      if (styleCatalogRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleCatalogPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const styleConsumerRoute = styleConsumerPlanRoute(plan);
      if (styleConsumerRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleConsumerPlan(plan, {
            typedRead: (operation, request, fallbackCode) => typedReadFigma(
              operation, request, fallbackCode, {
                fileKey,
                expectedEditor,
                timeoutMs: Math.max(1, deadline - Date.now()),
              },
            ),
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const styleFactsRoute = styleFactsPlanRoute(plan);
      if (styleFactsRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleFactsPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const stylePublishStatusRoute = stylePublishStatusPlanRoute(plan);
      if (stylePublishStatusRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStylePublishStatusPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const styleApplyRoute = styleApplyPlanRoute(plan);
      const styleCreateRoute = styleCreatePlanRoute(plan);
      const styleUpdateRoute = styleUpdatePlanRoute(plan);
      const styleDeleteRoute = styleDeletePlanRoute(plan);
      const textStyleBindingRoute = textStyleVariableBindingPlanRoute(plan);
      if (styleCreateRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleCreatePlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      if (styleUpdateRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleUpdatePlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      if (styleDeleteRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleDeletePlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey, expectedEditor, timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      if (textStyleBindingRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, { label: input.label, compatibilityFallback: false },
          async ({ fileKey, expectedEditor, deadline }) => {
            await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
            return executeTextStyleVariableBindingPlan(plan, { evaluate: (code) => evaluateFigma(code, {
              fileKey, expectedEditor, timeoutMs: Math.max(1, deadline - Date.now()),
            }) });
          });
        return resultFromCli(res);
      }
      if (styleApplyRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleApplyPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const layoutGridFactsRoute = layoutGridFactsPlanRoute(plan);
      if (layoutGridFactsRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeLayoutGridFactsPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const pageStructureRoute = pageStructurePlanRoute(plan);
      if (pageStructureRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executePageStructurePlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const pageNavigationRoute = pageNavigationPlanRoute(plan);
      if (pageNavigationRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executePageNavigationPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const canvasAwarenessRoute = canvasAwarenessPlanRoute(plan);
      if (canvasAwarenessRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCanvasAwarenessPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const inspectRoute = inspectPlanRoute(plan);
      if (inspectRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeInspectPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const codeSpecRoute = codeSpecPlanRoute(plan);
      if (codeSpecRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCodeSpecPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
            captureDesign: (request) => captureFigmaDesign(request, {
              fileKey,
              expectedEditor,
              deadline,
            }),
          });
        });
        return resultFromCli(res);
      }
      const screenshotRoute = screenshotPlanRoute(plan);
      if (screenshotRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeScreenshotPlan(plan, {
            workspaceIO: WORKSPACE_IO,
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      const historyRoute = historyPlanRoute(plan);
      if (historyRoute === "command-application") {
        const res = await runInProcessCommandPlan(plan, {
          label: input.label,
          compatibilityFallback: false,
        }, async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeHistoryPlan(plan, {
            workspaceIO: WORKSPACE_IO,
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
          });
        });
        return resultFromCli(res);
      }
      if (semanticRenderApplication) {
        return await runSemanticRenderApplication(plan, input.label, preparedSemanticRender);
      }
      const res = await runCliPlan(plan, { label: input.label });
      // Library-metadata enrichment (opt-in REST layer): after a successful
      // `map storybook` run, upgrade the written figma-map.json with the
      // published components' description/documentation links — a stronger
      // mapping signal than name matching. Silent no-op without a token.
      if (args[0] === "map" && readRestToken()) {
        const note = await enrichFigmaMap(normalized, plan.target.fileKey);
        if (note) res.stdout = (res.stdout || "") + "\n" + note;
      }
      return resultFromCli(res);
    }

    case "figma_render": {
      let args;
      try {
        args = semanticRenderToolArgv(input);
      } catch (error) {
        return errorResult(error?.message || String(error));
      }
      const plan = planFigmaRunCommand(args, {
        fileKey: input.fileKey,
        workspaceIO: WORKSPACE_IO,
      });
      if (!plan.allowed) return errorResult("Invalid Semantic Render request.");
      const route = semanticRenderPlanRoute(plan);
      const semanticRenderApplication = route === "command-application"
        || route === "compound-command-application";
      let prepared = null;
      if (semanticRenderApplication) {
        try {
          prepared = route === "compound-command-application"
            ? prepareCompoundSemanticRenderPlan(plan, { workspaceIO: WORKSPACE_IO })
            : prepareSemanticRenderPlan(plan, { workspaceIO: WORKSPACE_IO });
        } catch (error) {
          return errorResult(error?.message || String(error));
        }
      }
      if (WRITE_CONFIRM && plan.confirmation === "configured" && input.confirm !== true) {
        return previewResult(args);
      }
      if (semanticRenderApplication) {
        return await runSemanticRenderApplication(plan, input.label, prepared);
      }
      const res = await runCliPlan(plan, { label: input.label });
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

        // Local snapshots and live capture share the same value-returning
        // History Application as Commander; MCP does not respawn Commander.
        const request = {
          action: "diff", from, to,
          nodeId: typeof d.nodeId === "string" ? d.nodeId : "",
          format: d.changelog === true ? "changelog" : "text",
        };
        const plan = planFigmaCommand(historyPlanningArgvFromRequest(request), {
          fileKey: input.fileKey,
          workspaceDir: WORKSPACE_IO.roots[0],
          workspaceIO: WORKSPACE_IO,
        });
        const res = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
          async ({ fileKey, expectedEditor, deadline }) => {
            await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
            return executeHistoryPlan(plan, {
              workspaceIO: WORKSPACE_IO,
              evaluate: (code) => evaluateFigma(code, {
                fileKey,
                expectedEditor,
                timeoutMs: Math.max(1, deadline - Date.now()),
              }),
            });
          });
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
      let args;
      try {
        args = inspectPlanningArgvFromRequest({ nodeId, format: "yaml" });
      } catch (error) {
        return errorResult(error?.message || String(error));
      }
      const res = await runInProcessCommand(args, {
        fileKey: input.fileKey,
        compatibilityFallback: false,
      }, async ({ plan, fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeInspectPlan(plan, {
          evaluate: (code) => evaluateFigma(code, {
            fileKey,
            expectedEditor,
            timeoutMs: Math.max(1, deadline - Date.now()),
          }),
        });
      });
      return resultFromCli(res);
    }

    case "figma_reference": {
      // "workflow" is served straight from this process: the full design-to-
      // code guide whose short form lives in the (client-truncated) server
      // instructions. No engine round-trip, works before any setup.
      if (typeof input.name === "string" && /^capabilities$/i.test(input.name.trim())) {
        return textResult(listFigmaCapabilities({ formatted: true }));
      }
      if (typeof input.name === "string" && /^fidelity$/i.test(input.name.trim())) {
        return textResult(formatRoundTripFidelityContract());
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
      let args;
      try {
        args = screenshotPlanningArgvFromRequest({
          nodeId: input.nodeId,
          scale: input.scale,
        });
      } catch (error) {
        return errorResult(error?.message || String(error));
      }
      const res = await runInProcessCommand(args, {
        fileKey: input.fileKey,
        compatibilityFallback: false,
      }, async ({ plan, fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeScreenshotPlan(plan, {
          workspaceIO: WORKSPACE_IO,
          evaluate: (code) => evaluateFigma(code, {
            fileKey,
            expectedEditor,
            timeoutMs: Math.max(1, deadline - Date.now()),
          }),
        });
      });
      const savePath = res.result?.saved || (res.stdout ? JSON.parse(res.stdout).saved : null);
      return textResult(
        (res.stdout || res.stderr || "") +
          `\n\nNow Read the PNG at ${savePath} to see the design.` +
          `\n(pixelWidth/pixelHeight and compatibility width/height are exact PNG raster pixels; nodeWidth/nodeHeight are logical Figma geometry.)`,
      );
    }

    case "figma_spec": {
      if (input.nodeIds != null) {
        if (input.nodeId != null) {
          return errorResult("Use either nodeId or nodeIds[], not both.");
        }
        const { nodeIds, fileKey, ...shared } = input;
        const requests = Array.isArray(nodeIds)
          ? nodeIds.map((nodeId) => ({ ...shared, nodeId }))
          : nodeIds;
        return executeSpecBatch(requests, (request) => handleTool("figma_spec", {
          ...request,
          ...(fileKey != null ? { fileKey } : {}),
        }));
      }
      const nodeId = input.nodeId;
      if (typeof nodeId !== "string" || nodeId.length === 0) {
        return errorResult("nodeId must be a non-empty string.");
      }
      const dedup = input.dedup === true;
      const format = input.format == null ? DEFAULT_SPEC_FORMAT : String(input.format);
      const requestFor = (useDedup) => ({
        nodeId,
        phase: input.phase,
        depth: input.depth,
        section: input.section,
        includeHidden: input.includeHidden,
        format,
        dedup: useDedup,
      });
      try {
        codeSpecPlanningArgvFromRequest(requestFor(dedup));
      } catch (error) {
        return errorResult(error?.message || String(error));
      }
      const runSpec = (useDedup) => runInProcessCommand(
        codeSpecPlanningArgvFromRequest(requestFor(useDedup)),
        { fileKey: input.fileKey, compatibilityFallback: false },
        async ({ plan, fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCodeSpecPlan(plan, {
            evaluate: (code) => evaluateFigma(code, {
              fileKey,
              expectedEditor,
              timeoutMs: Math.max(1, deadline - Date.now()),
            }),
            captureDesign: (request) => captureFigmaDesign(request, {
              fileKey,
              expectedEditor,
              deadline,
            }),
          });
        },
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
    { name: MCP_SERVER_ID, version: SERVER_VERSION.split(" ")[0] },
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
      return errorResult(formatPublicError(err), {
        audit: err?.audit || getAuditStatus(),
        structuredContent: err?.semanticRenderOutcome,
      });
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
