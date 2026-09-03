---
name: figma-bridge-code-to-figma
description: Use when creating or updating a Figma screen, page, modal, panel, or other composed view from an existing codebase or running UI with the Figma Bridge MCP, including requests such as "code to Figma", "push this screen to Figma", "make Figma match the app", or "create this page in Figma". Preserve semantic Auto Layout/Grid, source assets, project tokens, existing Figma components, and Design Entity identity. Do not use when the primary deliverable is a new reusable component library; use figma-bridge-component-library instead.
---

# Build Figma from Code

Treat the rendered application as the visual contract, the source repository as
the semantic contract, and the existing Figma file as the design-system
contract. Preserve all three instead of drawing a flattened approximation.

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

## Choose the source path

1. Inspect the source route, component tree, styles, tokens, assets, fonts,
   interactive states, viewport, and current working-tree changes.
2. For an existing browser-rendered UI, use the Bridge DOM-capture workflow:
   `render --print-browser-capture`, capture at the reference viewport, then
   `render --dom-capture ... --verify`. Do not manually translate the same UI
   into simplified JSX. Acceptance evidence must identify the `dom-capture`
   adapter; hand-authored JSX cannot substitute for that provenance.
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

0. Keep CSS animations in the captured DOM: the browser capture expression
   reads `animation-*` facts and `@keyframes` and pauses playback so the
   resting geometry is captured. `render --dom-capture` then writes them as
   native Figma Motion tracks on the created layers (and on Component layers
   created from that DOM); read the `Motion:` line of the render result and
   verify with `figma_run ["motion","inspect","<layerId>"]`. Loops and springs
   are reported limitations, never silently dropped.
1. Match the real viewport or reference-frame dimensions before rendering.
2. Import or sync tokens first. Reuse variables and styles, preserve authored
   CSS variable names, and handle every `SCOPE DECISION REQUIRED` result before
   continuing. When metadata edits are known for several Variables, collect
   them into one `var update-batch` call instead of emitting repeated `var
update` calls. When several explicit Variable/mode values are already
   known, use one `var set-value-batch` call; previously empty modes are valid
   and its best-effort rollback Outcome must be checked for exact residue.
   Preserve explicit source-token references as native Variable Aliases. For
   several new Variables, use one `var create-batch` request with `alias` and,
   when needed, `aliasCollection`; do not replace the reference with its
   currently resolved literal. Equal literals alone are not Alias intent. If
   the user explicitly requests same-value linking, inspect every compatible
   primitive candidate and write an Alias only when one exact target is
   uniquely provable; otherwise report the ambiguity and keep the literal.
   Bind supported properties instead of freezing raw values. Semantic Render
   reuses exact generated Variables and Text Styles but keeps unmatched
   implicit candidates literal by default. Set `materializeResources:true`
   only when the code or user explicitly intends the render to create those
   generated Figma resources; explicit `var:` and named-style intent remains
   available without that opt-in. Check the preview policy and the returned
   `reused`, `created`, `bound`, and `literal` counts.
3. Reuse existing component instances. When a missing reusable component must
   be created, follow `figma-bridge-component-library` before composing it into
   the screen.
4. Create the screen wrapper first, then add one substantial section at a time
   directly inside it. Preserve Flexbox as Auto Layout, representable Grid as
   native Grid, and genuine overlays as absolute children.
5. Import actual raster files and SVG source from the repository. Never replace
   icons with emoji, Unicode glyphs, rotated primitives, or guessed artwork.
   A raster `<Image>` with `src` is host-materialized and native. An intentional
   `<Image name="…" />` placeholder remains available, but its Outcome is
   `completed-with-findings` through the generated compatibility executor; it
   must never be accepted as pixel-exact image fidelity.
6. Componentize repeated source structures on the first pass: create one local
   component and place instances instead of emitting a flat repeated tree.
   For multi-root `figma_render`/`render-batch`, inspect the pre-write reuse
   finding and replace raw repetition with linked `<Instance entity="…" />`
   nodes. Approve `approvedFlatRepetitions`/`--approve-flat-repetition` only
   for an intentional one-off exception using the exact current `flat-…`
   finding id; never use it as a workflow-wide bypass. Keep the default smart
   row placement so new screens appear to the right of occupied canvas content;
   request column placement only when the review layout intentionally needs it.
7. Preserve text sizing intent. Use HUG for intrinsic content that cannot
   overrun its surrounding container; use FILL when copy must follow and wrap
   with a narrower container. Center or end-align FILL copy with the native
   Text alignment property, not a frozen text width or position.
8. Map only representable interactions to native prototype reactions with
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
   For an existing UI, confirm the render result came from the `dom-capture`
   adapter before interpreting the screenshot comparison.
3. Create or repair the Design Entity link with `link set`, then record a
   visually verified baseline with `link accept --compare --max-diff`.
4. Report the entity id, reused and created components, token bindings, checks,
   pixel result, approved flat repetitions, and any explicit semantic boundary
   decision. For a multi-screen render, use the returned component-reuse
   summary instead of estimating those counts from the screenshot.

Use an existing browser tool or project harness for capture. Do not install
Playwright or another browser dependency solely for this workflow without the
user's approval.
