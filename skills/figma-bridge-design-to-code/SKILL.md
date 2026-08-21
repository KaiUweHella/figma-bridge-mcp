---
name: figma-bridge-design-to-code
description: Use when implementing a Figma frame, screen, or component as code with the Figma Bridge MCP, including requests such as "implement this Figma design", "build this screen", "design to code", or a figma.com node URL alongside a codebase. Enforce source-asset fidelity, the target project's existing stack, scoped and token-efficient reads, optional section-level parallel agents, and build plus pixel-diff verification. Do not use for the reverse code-to-Figma direction.
---

# Implement Figma as Code

Treat the Figma node as the visual contract and the target repository as the
engineering contract. Match both: preserve the design exactly without replacing
the project's framework, styling system, components, or conventions.

## Pin the Figma Bridge transport

- Use the tools from the server bundled with this skill: namespace
  `figma-bridge`, server id `figma-bridge-mcp`. Do not select a similarly named
  Figma MCP by name alone.
- Start with this server's `figma_status`. Its result and every later result must
  identify `_mcp: "figma-bridge-mcp"`.
- A failed probe proves only that Figma Bridge transport is unavailable. It does
  not prove that Figma or another Figma MCP is unavailable.
- Do not silently switch to another Figma MCP for a write. Name the unavailable
  transport and ask the user before changing tools or write semantics.

## Establish the contracts

1. Inspect the target repository before writing code. Identify its framework,
   styling approach, reusable components, tokens, asset conventions, scripts,
   and current working-tree changes.
2. Resolve the exact Figma node and connected file. Ask for a node-specific URL
   only when neither the URL nor the current selection identifies one.
3. If the repository contains `figma-bridge.json` or the target exposes a
   Design Entity, run `figma_run ["link","context","<entity.id>"]` before
   implementation. Stop on a reported conflict; never choose code or Figma as
   the winner implicitly.
4. Call `figma_reference` with `name: "workflow:design-to-code"` once and follow
   the returned workflow. It is the canonical detailed guide for the installed
   Bridge version.

Use evidence in this order: an exact Design Entity or Storybook mapping,
component documentation and Figma annotations, compatible project components
and tokens, then raw node facts. A name-only component match is evidence, not
identity.

## Build one reference package

Before implementation, collect and retain:

- one `figma_screenshot` PNG as visual ground truth;
- one bounded `figma_spec` `phase: "all"` map with section node ids (use
  `structure` only when the screen is too large);
- one scoped CSS or DTCG token export for the target node;
- one asset export into the target project, including `assets.json`;
- bounded style specs for the sections being implemented, grouped into one
  `figma_spec` `nodeIds[]` batch so Manual Mode needs one approval, not one
  approval per section.

Do not repeat whole-screen reads. Reuse this package and pull style facts only
for sections whose facts are still missing; put all known same-scope section
reads into one `nodeIds[]` batch. If Figma changes during the task, invalidate the
affected evidence and recapture it.

## Preserve source fidelity

- Reuse an existing project component only when its rendered design and states
  match. Otherwise build an exact local component with the project's existing
  primitives and styling system.
- Do not add Tailwind, a UI kit, or an icon library solely for the implementation.
  Do not replace an exported icon, logo, illustration, or image with a library
  approximation. Prefer the exported Figma asset; use a project asset only when
  it is demonstrably the same source artwork.
- Copy text, hierarchy, tokens, typography, layout behavior, clipping, paints,
  effects, artwork placement, and component states from the evidence. Do not
  invent values from the screenshot.
- Preserve native masks, blend modes, corner smoothing, stroke inclusion and
  every parameter of modern Figma effects from the Spec. Do not replace these
  facts with a screenshot-derived approximation.
- Treat each `Prototype reaction:` record as interaction evidence. Implement
  corresponding application behavior only when the mapping is clear; do not
  translate Figma navigation, overlays or back actions blindly into app routes.
- Preserve fill, hug, grid, and responsive relationships. Do not turn the whole
  design into a fixed-size canvas merely to match one screenshot.

## Parallelize only independent sections

Use parallel agents as an optional wall-clock optimization, not as the default
or as a token-saving technique.

1. Keep the coordinator responsible for repository discovery, the reference
   package, shared shell/layout, tokens, asset manifest, integration, and final
   verification.
2. Parallelize only when the design has at least three substantial independent
   sections and the target structure permits disjoint files. Use the smallest
   useful group, normally two to four workers.
3. Give each worker exactly one section node id, its style evidence, the shared
   screenshot/token/asset paths, project constraints, owned files, and completion
   criteria. Workers must not repeat global Figma reads.
4. Never let workers edit the same global stylesheet, route shell, token file, or
   asset manifest. Use a sequential implementation when ownership overlaps or
   the screen is small.
5. Integrate once, then optionally assign a separate parity reviewer to inspect
   the rendered screenshot and diff. The coordinator owns all resulting fixes.

Prefer sequential work when total tokens matter more than elapsed time: parallel
workers duplicate project context even when their Figma reads are disjoint.

## Verify before completion

1. Run the repository's build, lint, and relevant tests.
2. Run `figma_run` with `verify-build` and fix every missing or unreferenced
   exported asset and every reported fidelity lint.
3. Capture the running build at the design width and full rendered height with
   an already available browser tool or project test harness. Wait for fonts,
   images, and stable animation state.
4. Do not install Playwright or another browser dependency solely to capture the
   screenshot. Use it when it is already available; otherwise request approval
   before adding or downloading a standalone browser tool.
5. Run `verify-build --compare`, inspect the generated diff image and worst
   regions, and iterate until the agreed pixel threshold passes.
6. Report the final diff, asset coverage, checks run, and any explicit deviation.
   Do not declare parity without the visual comparison.
