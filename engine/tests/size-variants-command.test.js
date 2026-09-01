import assert from "node:assert/strict";
import test from "node:test";
import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  executeSizeVariants,
  executeSizeVariantsPlan,
  sizeVariantsArgvFromRequest,
  sizeVariantsCode,
  sizeVariantsPlanRoute,
  sizeVariantsPlanningArgvFromRequest,
} from "../src/application/size-variants-command.js";
import { parseSizeVariantsRequest } from "../src/application/size-variants-request.js";

function fixture({
  sourceType = "COMPONENT",
  wrongClone = 0,
  removeNoEffect = false,
  retainRemovedHandles = false,
  selectionError = false,
  viewportError = false,
} = {}) {
  const registry = new Map();
  let cloneCount = 0;
  let conversions = 0;
  let viewportCalls = 0;
  const detach = (node) => {
    if (!node.parent?.children) return;
    const index = node.parent.children.indexOf(node);
    if (index !== -1) node.parent.children.splice(index, 1);
    node.parent = null;
  };
  const page = {
    id: "0:1",
    type: "PAGE",
    name: "Size Variants Test",
    children: [],
    _selection: [],
    get selection() {
      return this._selection;
    },
    set selection(value) {
      if (selectionError) throw new Error("injected selection failure");
      this._selection = [...value];
    },
    appendChild(node) {
      detach(node);
      this.children.push(node);
      node.parent = this;
    },
  };
  registry.set(page.id, page);

  const makeNode = ({
    id,
    type,
    name,
    width,
    height,
    x,
    y,
    corruptResize = false,
  }) => ({
    id,
    type,
    name,
    width,
    height,
    x,
    y,
    parent: null,
    children: [],
    resize(nextWidth, nextHeight) {
      this.width = corruptResize ? nextWidth + 1 : nextWidth;
      this.height = nextHeight;
    },
    clone() {
      cloneCount += 1;
      const copy = makeNode({
        id: `9:${cloneCount}`,
        type: this.type,
        name: this.name,
        width: this.width,
        height: this.height,
        x: this.x,
        y: this.y,
        corruptResize: cloneCount === wrongClone,
      });
      registry.set(copy.id, copy);
      this.parent.appendChild(copy);
      return copy;
    },
    remove() {
      if (removeNoEffect && this.id.startsWith("9:")) return;
      detach(this);
      if (!retainRemovedHandles) registry.delete(this.id);
    },
  });

  const source = makeNode({
    id: "1:1",
    type: sourceType,
    name: "Button/Medium",
    width: 100,
    height: 40,
    x: 10,
    y: 20,
  });
  registry.set(source.id, source);
  page.appendChild(source);
  page._selection = [source];
  const figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    loadFontAsync: async () => {},
    createComponentFromNode(node) {
      conversions += 1;
      node.type = "COMPONENT";
      return node;
    },
    viewport: {
      scrollAndZoomIntoView() {
        viewportCalls += 1;
        if (viewportError) throw new Error("injected viewport failure");
      },
    },
  };
  return {
    figma,
    page,
    registry,
    source,
    cloneCount: () => cloneCount,
    conversions: () => conversions,
    viewportCalls: () => viewportCalls,
  };
}

const evaluate = (figma) => async (code) =>
  new Function("figma", `return ${code};`)(figma);

test("Size Variants request closes options, legacy zero-gap semantics, and URL targeting", () => {
  const url = "https://www.figma.com/design/FILEA/Test?node-id=1-1";
  assert.deepEqual(
    parseSizeVariantsRequest(["sizes", "--gap", "-12", url, "--base=large"]),
    { nodeId: "1:1", baseSize: "large", gap: -12 }
  );
  assert.deepEqual(parseSizeVariantsRequest(["sizes", "1:1", "--gap", "0"]), {
    nodeId: "1:1",
    baseSize: "medium",
    gap: 40,
  });
  assert.deepEqual(
    sizeVariantsArgvFromRequest({
      nodeId: "1-1",
      baseSize: "large",
      gap: -12,
    }),
    ["sizes", "1:1", "--base", "large", "--gap", "-12"]
  );
  assert.deepEqual(
    sizeVariantsPlanningArgvFromRequest({
      nodeId: url,
      baseSize: "large",
      gap: -12,
    }),
    ["sizes", url, "--base", "large", "--gap", "-12"]
  );

  const plan = planFigmaCommand(
    ["sizes", "--gap", "-12", url, "--base=large"],
    {
      adapter: "mcp",
    }
  );
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, "sizes");
  assert.equal(plan.target.fileKey, "FILEA");
  assert.deepEqual(plan.argv, [
    "sizes",
    "1:1",
    "--base",
    "large",
    "--gap",
    "-12",
  ]);
  assert.deepEqual(plan.effects, {
    figma: "write",
    editor: "write",
    workspace: "none",
    network: "none",
    shared: "none",
  });
  assert.equal(plan.execution.retry, "never");
  const cliPlan = planFigmaCommand(
    ["sizes", "--gap", "-12", url, "--base=large"],
    {
      adapter: "cli",
    }
  );
  assert.equal(cliPlan.allowed, true);
  assert.deepEqual(
    {
      argv: cliPlan.argv,
      target: cliPlan.target,
      effects: cliPlan.effects,
      confirmation: cliPlan.confirmation,
      execution: cliPlan.execution,
      availability: cliPlan.availability,
    },
    {
      argv: plan.argv,
      target: plan.target,
      effects: plan.effects,
      confirmation: plan.confirmation,
      execution: plan.execution,
      availability: plan.availability,
    }
  );

  for (const argv of [
    ["sizes", "bad"],
    ["sizes", "1:1", "2:2"],
    ["sizes", "--base", "huge"],
    ["sizes", "--gap", "1.5"],
    ["sizes", "--gap", "100001"],
    ["sizes", "--base", "small", "--base", "large"],
    ["sizes", "--future"],
  ])
    assert.throws(
      () => parseSizeVariantsRequest(argv),
      /Invalid sizes command/
    );
});

test("component source creates and freshly verifies exactly three scaled Components", async () => {
  const live = fixture();
  const output = await executeSizeVariants(
    { nodeId: "1:1", baseSize: "medium", gap: 20 },
    {
      evaluate: evaluate(live.figma),
    }
  );
  assert.equal(output.result.status, "created");
  assert.deepEqual(
    output.result.variants.map(({ name, width, height, x, y }) => ({
      name,
      width,
      height,
      x,
      y,
    })),
    [
      { name: "Button/Small", width: 85, height: 34, x: 310, y: 20 },
      { name: "Button/Medium", width: 100, height: 40, x: 415, y: 20 },
      { name: "Button/Large", width: 120, height: 48, x: 535, y: 20 },
    ]
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1", "9:1", "9:2", "9:3"]
  );
  assert.deepEqual(
    live.page.selection.map((node) => node.id),
    ["9:1", "9:2", "9:3"]
  );
  assert.equal(live.cloneCount(), 3);
  assert.equal(live.conversions(), 0);
  assert.equal(live.viewportCalls(), 1);
  assert.match(
    output.stdout,
    /^Created 3 size variants\n  Button\/Small \(85×34\)/
  );
  assert.equal(output.stderr, "");
});

test("frame source converts only the three owned clones and leaves no temporary source Component", async () => {
  const live = fixture({ sourceType: "FRAME" });
  const output = await executeSizeVariants(
    { nodeId: "1:1" },
    {
      evaluate: evaluate(live.figma),
    }
  );
  assert.equal(output.result.status, "created");
  assert.equal(live.source.type, "FRAME");
  assert.equal(live.cloneCount(), 3);
  assert.equal(live.conversions(), 3);
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1", "9:1", "9:2", "9:3"]
  );
});

test("preflight refusal is a proven no-mutation outcome", async () => {
  const live = fixture({ sourceType: "RECTANGLE" });
  await assert.rejects(
    () =>
      executeSizeVariants(
        { nodeId: "1:1" },
        {
          evaluate: evaluate(live.figma),
        }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "no-mutation");
      assert.deepEqual(error.mutationReport, {
        version: 1,
        outcome: "no-mutation",
        attempted: 0,
        restored: 0,
        residueCount: 0,
      });
      return true;
    }
  );
  assert.equal(live.cloneCount(), 0);
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
});

test("failed postcondition removes every owned clone and reports rolled-back", async () => {
  const live = fixture({ wrongClone: 2 });
  await assert.rejects(
    () =>
      executeSizeVariants(
        { nodeId: "1:1", gap: 20 },
        {
          evaluate: evaluate(live.figma),
        }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "rolled-back");
      assert.deepEqual(error.mutationReport, {
        version: 1,
        outcome: "rolled-back",
        attempted: 3,
        restored: 3,
        residueCount: 0,
      });
      return true;
    }
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
  assert.deepEqual(
    live.page.selection.map((node) => node.id),
    ["1:1"]
  );
});

test("detached stale handles are not reported as rollback residue", async () => {
  const live = fixture({ wrongClone: 2, retainRemovedHandles: true });
  await assert.rejects(
    () =>
      executeSizeVariants(
        { nodeId: "1:1", gap: 20 },
        {
          evaluate: evaluate(live.figma),
        }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "rolled-back");
      assert.deepEqual(error.mutationReport, {
        version: 1,
        outcome: "rolled-back",
        attempted: 3,
        restored: 3,
        residueCount: 0,
      });
      return true;
    }
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
  assert.deepEqual(
    live.page.selection.map((node) => node.id),
    ["1:1"]
  );
});

test("failed cleanup reports bounded partial residue without retry", async () => {
  const live = fixture({ wrongClone: 2, removeNoEffect: true });
  await assert.rejects(
    () =>
      executeSizeVariants(
        { nodeId: "1:1" },
        {
          evaluate: evaluate(live.figma),
        }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "partial-residue");
      assert.equal(error.mutationReport.attempted, 3);
      assert.equal(error.mutationReport.restored, 0);
      assert.equal(error.mutationReport.residueCount, 4);
      return true;
    }
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1", "9:1", "9:2", "9:3"]
  );
});

test("selection and viewport failures are bounded warnings after document verification", async () => {
  const live = fixture({ selectionError: true, viewportError: true });
  const output = await executeSizeVariants(
    { nodeId: "1:1" },
    {
      evaluate: evaluate(live.figma),
    }
  );
  assert.equal(output.result.status, "created");
  assert.equal(output.result.warnings.length, 2);
  assert.match(output.stderr, /selection could not be updated/);
  assert.match(output.stderr, /viewport focus could not be updated/);
});

test("generated code keeps request data inert and Plugin results fail closed", async () => {
  const code = sizeVariantsCode({ nodeId: "1:1", baseSize: "large", gap: -12 });
  assert.doesNotThrow(() => new Function("figma", `return ${code};`));
  for (const value of [
    null,
    {},
    "not-json",
    JSON.stringify({ status: "created" }),
  ]) {
    await assert.rejects(
      () =>
        executeSizeVariants(
          { nodeId: "1:1" },
          {
            evaluate: async () => value,
          }
        ),
      /invalid bounded result|invalid JSON/
    );
  }
});

test("one authentic non-retrying sizes plan crosses the shared Application seam once", async () => {
  const plan = planFigmaCommand(
    ["sizes", "1:1", "--base", "small", "--gap", "-8"],
    {
      adapter: "mcp",
      fileKey: "FILEA",
    }
  );
  assert.equal(sizeVariantsPlanRoute(plan), "command-application");
  assert.throws(
    () => sizeVariantsPlanRoute({ ...plan }),
    /requires a Command Plan/
  );
  const live = fixture();
  let evaluations = 0;
  const output = await executeSizeVariantsPlan(plan, {
    evaluate: async (code) => {
      evaluations += 1;
      return evaluate(live.figma)(code);
    },
  });
  assert.equal(output.result.status, "created");
  assert.equal(evaluations, 1);
});
