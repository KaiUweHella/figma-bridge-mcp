// Repository-only, bounded DESIGN.md context Application.

import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import { parseDesignMd, summarizeForLLM } from "../design-md.js";
import {
  designMdArgvFromRequest,
  designMdPlanningArgvFromRequest,
  parseDesignMdRequest,
} from "./design-md-request.js";

export {
  designMdArgvFromRequest,
  designMdPlanningArgvFromRequest,
} from "./design-md-request.js";

const APPLICATION_ID = "tokens.import-design-md";

export function designMdContextPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan) || plan.id !== APPLICATION_ID)
    return "not-design-md-context";
  const request = parseDesignMdRequest(plan.argv);
  return request.printContext
    ? "command-application"
    : "legacy-design-md-import";
}

export function executeDesignMdContextPlan(plan, { workspaceIO } = {}) {
  if (designMdContextPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by DESIGN.md Context.`
    );
  }
  if (!workspaceIO || typeof workspaceIO.readText !== "function") {
    throw new TypeError(
      "DESIGN.md Context requires an authorized WorkspaceIO capability."
    );
  }
  const request = parseDesignMdRequest(plan.argv);
  const parsed = parseDesignMd(request.file, { workspaceIO });
  return Object.freeze({
    stdout: summarizeForLLM(parsed),
    stderr: "",
    code: 0,
  });
}
