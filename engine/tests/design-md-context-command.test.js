import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  designMdContextPlanRoute,
  designMdPlanningArgvFromRequest,
  executeDesignMdContextPlan,
} from "../src/application/design-md-context-command.js";
import {
  acceptsDesignMdArgv,
  parseDesignMdRequest,
} from "../src/application/design-md-request.js";
import {
  MAX_DESIGN_MD_CONTEXT_CODE_UNITS,
  parseDesignMd,
  parseDesignMdText,
  summarizeForLLM,
} from "../src/design-md.js";
import { createWorkspaceIO } from "../src/lib/workspace-io.js";

function fixture({ source = "Acme", identity = "Calm", extra = "" } = {}) {
  return `# ${source}\n\n**In one line:** ${identity}\n\n## Machine-readable tokens\n\`\`\`json design-tokens\n${JSON.stringify(
    {
      color: { primary: "#123456" },
      radius: { sm: 4 },
      typography: {},
      shadow: {},
      meta: { source },
    }
  )}\n\`\`\`\n${extra}`;
}

test("DESIGN.md request is closed and option-terminator aware", () => {
  assert.deepEqual(
    parseDesignMdRequest([
      "tokens",
      "import-design-md",
      "--print-context",
      "--collection=Theme",
      "--",
      "-DESIGN.md",
    ]),
    { file: "-DESIGN.md", collection: "Theme", printContext: true }
  );
  for (const args of [
    ["tokens", "import-design-md"],
    ["tokens", "import-design-md", "a.md", "b.md"],
    ["tokens", "import-design-md", "--unknown", "a.md"],
    [
      "tokens",
      "import-design-md",
      "--print-context",
      "--print-context",
      "a.md",
    ],
    ["tokens", "import-design-md", "--collection", "--print-context", "a.md"],
  ])
    assert.equal(acceptsDesignMdArgv(args), false, args.join(" "));
});

test("repository-only context Plan has no Figma target, confirmation, or dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-context-plan-"));
  const file = join(dir, "DESIGN.md");
  writeFileSync(file, fixture());
  const io = createWorkspaceIO({ root: dir });
  const plan = planFigmaCommand(
    designMdPlanningArgvFromRequest({
      file,
      printContext: true,
    }),
    { adapter: "cli", workspaceDir: dir, workspaceIO: io }
  );
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.effects, {
    figma: "none",
    workspace: "read",
    network: "none",
    shared: "none",
  });
  assert.equal(plan.target.kind, "none");
  assert.equal(plan.confirmation, "none");
  assert.equal(plan.execution.pluginDispatch, "none");
  assert.equal(designMdContextPlanRoute(plan), "command-application");
  assert.match(
    executeDesignMdContextPlan(plan, { workspaceIO: io }).stdout,
    /Design system loaded: Acme/
  );

  const mcpPlan = planFigmaCommand(plan.argv, {
    adapter: "mcp",
    workspaceDir: dir,
    workspaceIO: io,
  });
  assert.equal(mcpPlan.allowed, true);
  assert.deepEqual(mcpPlan.effects, plan.effects);
  assert.deepEqual(mcpPlan.target, plan.target);
  assert.deepEqual(mcpPlan.execution, plan.execution);
});

test("context Application rejects forged and mutation Plans", () => {
  assert.equal(
    designMdContextPlanRoute({ id: "tokens.import-design-md" }),
    "not-design-md-context"
  );
  assert.throws(
    () => executeDesignMdContextPlan({ id: "tokens.import-design-md" }, {}),
    /not owned/
  );

  const dir = mkdtempSync(join(tmpdir(), "design-context-mutation-"));
  const file = join(dir, "DESIGN.md");
  writeFileSync(file, fixture());
  const plan = planFigmaCommand(designMdPlanningArgvFromRequest({ file }), {
    adapter: "cli",
    workspaceDir: dir,
    workspaceIO: createWorkspaceIO({ root: dir }),
  });
  assert.equal(designMdContextPlanRoute(plan), "legacy-design-md-import");
  assert.equal(plan.effects.figma, "write");
});

test("DESIGN.md cannot authorize its own parent directory", () => {
  const allowed = mkdtempSync(join(tmpdir(), "design-context-allowed-"));
  const outside = mkdtempSync(join(tmpdir(), "design-context-outside-"));
  const file = join(outside, "secret-DESIGN.md");
  writeFileSync(file, fixture());
  assert.throws(
    () =>
      parseDesignMd(file, {
        workspaceIO: createWorkspaceIO({ root: allowed }),
      }),
    (error) => {
      assert.match(error.message, /outside allowed roots/);
      assert.doesNotMatch(
        error.message,
        /secret-DESIGN|design-context-outside/
      );
      return true;
    }
  );
});

test("bounded text parser remains independently testable", () => {
  const parsed = parseDesignMdText(fixture({ source: "Pure Parser" }));
  assert.equal(parsed.meta.source, "Pure Parser");
  assert.equal(parsed.tokens.color.primary, "#123456");
});

test("parse errors do not echo document content", () => {
  for (const source of [
    "---\nprivate-marker: [\n---\n",
    "## Machine-readable tokens\n```json design-tokens\n{private-marker}\n```",
  ]) {
    assert.throws(() => parseDesignMdText(source), (error) => {
      assert.doesNotMatch(error.message, /private-marker/);
      return true;
    });
  }
});

test("scalar token categories fail before entry amplification", () => {
  const large = "x".repeat(1_000_000);
  assert.throws(
    () =>
      summarizeForLLM({
        tokens: { color: large },
        meta: { source: "Invalid", components: [] },
      }),
    /colors must be an object/
  );
  assert.throws(
    () => parseDesignMdText(`---\ncolors: ${large}\n---\n`),
    /colors must be an object/
  );
});

test("context projection samples large categories and escapes terminal controls", () => {
  const radii = Object.fromEntries(
    Array.from({ length: 100 }, (_value, index) => [`radius-${index}`, index])
  );
  const result = summarizeForLLM({
    tokens: {
      color: { "danger\u001b[31m": "#ff0000" },
      typography: {},
      radius: radii,
      shadow: {},
    },
    meta: {
      source: "Theme\u202e\u061c\u200e\u200f",
      identity: "Quiet\u0007",
      components: [],
    },
  });
  assert.match(result, /Theme\\u202e/);
  assert.match(result, /\\u061c\\u200e\\u200f/);
  assert.match(result, /danger\\u001b\[31m/);
  assert.match(result, /…and 60 more/);
  assert.doesNotMatch(result, /[\u001b\u061c\u200e\u200f\u202e\u0007]/u);
  assert.ok(result.length <= MAX_DESIGN_MD_CONTEXT_CODE_UNITS);
});
