---
name: figma-bridge-code-to-figma
description: Use when creating or updating a Figma screen, page, modal, panel, or other composed view from an existing codebase or running UI with the Figma Bridge MCP, including requests such as "code to Figma", "push this screen to Figma", "make Figma match the app", or "create this page in Figma". Preserve semantic Auto Layout/Grid, source assets, project tokens, existing Figma components, and Design Entity identity. Do not use when the primary deliverable is a new reusable component library; use figma-bridge-component-library instead.
---

# Build Figma from Code

Treat the rendered application as the visual contract, the source repository as
the semantic contract, and the existing Figma file as the design-system
contract. Preserve all three instead of drawing a flattened approximation.

## Choose the source path

1. Inspect the source route, component tree, styles, tokens, assets, fonts,
   interactive states, viewport, and current working-tree changes.
2. For an existing browser-rendered UI, use the Bridge DOM-capture workflow:
   `render --print-browser-capture`, capture at the reference viewport, then
   `render --dom-capture ... --verify`. Do not manually translate the same UI
   into simplified JSX.
3. Use hand-authored Bridge JSX only for new views or components that do not yet
   have a renderable DOM source.
4. Call `figma_reference` with `name: "workflow:code-to-figma"` once and follow
   the returned version-specific command sequence.

## Reconcile before writing

- If `figma-bridge.json` or a Design Entity exists, start with `link context`.
  Stop on a code/Figma conflict and present both sides; never pick a winner.
- Inspect the target Figma page, component inventory, variables, styles, linked
  entities, and existing screens before creating anything.
- Build a compact reuse map from each source component to one of: exact linked
  Figma component, compatible existing component, or new local component.
  Design Entity and Storybook links outrank names; names alone never authorize
  replacement.
- Resolve only genuine ambiguities with the user. Proceed when the source and
  existing design system identify one clear answer.

## Build in dependency order

1. Match the real viewport or reference-frame dimensions before rendering.
2. Import or sync tokens first. Reuse variables and styles, preserve authored
   CSS variable names, and handle every `SCOPE DECISION REQUIRED` result before
   continuing. Bind supported properties instead of freezing raw values.
3. Reuse existing component instances. When a missing reusable component must
   be created, follow `figma-bridge-component-library` before composing it into
   the screen.
4. Create the screen wrapper first, then add one substantial section at a time
   directly inside it. Preserve Flexbox as Auto Layout, representable Grid as
   native Grid, and genuine overlays as absolute children.
5. Import actual raster files and SVG source from the repository. Never replace
   icons with emoji, Unicode glyphs, rotated primitives, or guessed artwork.
6. Componentize repeated source structures on the first pass: create one local
   component and place instances instead of emitting a flat repeated tree.
7. Map only representable interactions to native prototype reactions with
   `prototype add` or lossless `prototype set`, then verify them with
   `prototype inspect`. Keep routing, application state, async work and other
   runtime-owned behavior in code and record the boundary instead of inventing
   a Figma substitute.

## Keep writes recoverable

- Execute mutations against the same Figma file sequentially. Never let
  parallel agents or tool calls mutate the same canvas concurrently.
- Retain every returned node id and use exact ids or Design Entities for later
  changes. Do not delete or replace nodes through broad name matching.
- Validate each major section before building on it. On error, inspect the
  message and current structure before retrying; do not blindly replay writes.
- Update existing views with targeted node, instance, or section edits rather
  than recreating the entire screen.

## Verify and link

1. Run the render verification and inspect the returned screenshot after each
   major section and for the completed view.
2. Compare the final Figma screenshot with the browser reference at the same
   viewport. Check fonts, images, clipping, component variants, responsive
   sizing, overlays, masks, blend modes, effects and prototype reactions
   explicitly.
3. Create or repair the Design Entity link with `link set`, then record a
   visually verified baseline with `link accept --compare --max-diff`.
4. Report the entity id, reused and created components, token bindings, checks,
   pixel result, and any explicit semantic boundary decision.

Use an existing browser tool or project harness for capture. Do not install
Playwright or another browser dependency solely for this workflow without the
user's approval.
