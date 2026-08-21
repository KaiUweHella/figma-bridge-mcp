# Figma Plugin API coverage

The installed `@figma/plugin-typings` package is the executable source of truth;
`api gap` compares it with the command surface and its explicit, test-verified
structured-type claims. Prose documentation is useful
for limits and examples but does not override the declarations used by tests.

| Area                          | CLI-first coverage                                                                                                                                                                                                                                                                                                                              | Important boundary                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core canvas editing           | clone and reparent; create Frame/Rectangle/Ellipse/Polygon/Star/Vector/Text/Line/Slice/Auto Layout primitives; explicit group/ungroup/flatten/union/subtract/intersect/exclude; broad typed geometry, paint, stroke, effect, corner, constraint, mask and Auto Layout edits; create/instantiate/swap/detach/reset instances; editable gradients | Raw `eval` stays blocked; legacy selection/network-backed `create` subcommands are not Capability-gated; Auto Layout owns child position after reparenting |
| Local styles                  | list/show/create/update/apply/consumers/publish/delete; TextStyle variable bind/unbind                                                                                                                                                                                                                                                          | Remote styles are read-only; known keys import through Plugin API                                                                                          |
| Variables                     | metadata, scopes, values/aliases, code syntax, resolve, modes, publish state, scoped collection deletion and extension; all 1.133 resolved types including EASING and TIMING; Design Capture keeps collection identity, explicit/resolved mode, WEB syntax and resolved value                                                                   | `inferredVariables` is suggestion-only; extensions are Enterprise; libraries must already be enabled                                                       |
| Typography                    | range facts, OpenType readback, bindable variables, explicit axis-intent metadata                                                                                                                                                                                                                                                               | Exact variable-font axes and OpenType writes are not exposed by Plugin API                                                                                 |
| Prototypes                    | inspect/add/set/clear with raw Reaction JSON                                                                                                                                                                                                                                                                                                    | Raw JSON is the lossless path for conditions and multiple actions                                                                                          |
| Measurements                  | list/add/edit/delete                                                                                                                                                                                                                                                                                                                            | Writes require Figma Dev Mode                                                                                                                              |
| Annotations                   | categories plus add/edit/remove/clear with properties; native labels and Code-to-Figma fallback metadata survive into Code-Spec with separate provenance                                                                                                                                                                                        | Indexes are zero-based                                                                                                                                     |
| Video                         | MP4/GIF/WebM export                                                                                                                                                                                                                                                                                                                             | Only animated top-level frames; format-specific FPS enums                                                                                                  |
| Shaders                       | list/import/apply to fill/stroke/effect                                                                                                                                                                                                                                                                                                         | Import required; properties use definition IDs                                                                                                             |
| Auto-layout grid              | tracks, gaps, placement, auto rows/flow, row/column reorder; Design Capture precedence is authored Auto Layout/Grid → marked `inferredAutoLayout` heuristic → geometry                                                                                                                                                                          | Inferred layout is evidence, not proof that a frame is authored with Auto Layout; layout grids are separate                                                |
| Slots and component contracts | create/edit/inspect/validate/reset; JSX support; capture SLOT/INSTANCE_SWAP properties, references, preferred values, direct overrides, exposed instances and limit violations                                                                                                                                                                  | Component-only slot creation; limits report violations rather than blocking edits                                                                          |
| Dev Mode inspection           | separate connected `manifest.dev.json` reuses the authenticated Bridge for selection, specs, exports and other reads                                                                                                                                                                                                                            | Dev Mode is read-only; canvas writes require the Design editor adapter, and `dev` cannot share one manifest with the existing FigJam target                |
| Figma Draw                    | inspect, text path, transform repeats, complex strokes, width profiles, patterns                                                                                                                                                                                                                                                                | Custom brushes cannot be set; patterns require async setters                                                                                               |
| FigJam                        | board readback including table cells; sticky/shape/connector/table/section/code creation; selection/id-scoped arrange; live-accepted 2026-08-10                                                                                                                                                                                                 | Whole-page arrange requires explicit `--all`; detailed acceptance evidence is maintainer-local                                                             |
| Figma Slides (beta)           | grid/slide inspect; durable Bridge labels; create, duplicate, move, transition, skip and explicit delete; live-accepted 2026-08-10                                                                                                                                                                                                              | Native names are renumbered by Figma; no speaker-notes API or native interactive-element creation; see `slides-roadmap.md`                                 |
| Token files                   | broad one-shot import from Tailwind, CSS, DTCG-compatible Style Dictionary/Tokens Studio JSON; three-way sync for DTCG JSON and CSS custom properties                                                                                                                                                                                           | Import may normalize/bucket values; sync stays narrow to avoid lossy round-trips; Sass variables are unsupported                                           |

## Operation-level guardrail

The broad type-name report remains useful as a discovery heuristic, but it is
not treated as proof that a concrete edit exists. The executable operation
audit is pinned to `@figma/plugin-typings` 1.133.0 and classifies every
`PluginAPI.create*` method plus every structural combine method. It currently
records 35 direct commands, 5 safe alternatives, and 4 explicit boundaries.
Tests also compare the complete engine command list with the Safe Mode
Capability Catalog and compare Figma's complete variable/easing unions with
the accepted parsers. Any new upstream operation or local command is therefore
unclassified by default and fails CI.

The four current creator boundaries are deliberate: video/media creation,
network-backed link previews, raw GIF `MediaNode` creation, and Figma Buzz
canvas rows. Local image fills remain supported through `node set-image`,
remote images only through the validated renderer, and video export as a read.

## Round-trip fidelity guardrail

The operation audit answers whether Bridge can invoke a concrete Figma API
operation. It does not prove that the same fact survives Design Capture,
agent-facing projections, Semantic Render Plans and verification in both
directions. The separate executable Round-trip Fidelity Contract classifies 11
core fact families independently for Code → Figma and Figma → code. CI checks
that both directions are classified, their official Figma type names still
exist, executable mappings name an implementation and verification seam, and
every intentional stop has a reason.

The first contract slice closes previously one-sided projections for native
masks, node blend modes, corner smoothing, strokes included in Auto Layout,
full Noise/Texture/Glass/progressive-blur parameters and prototype reactions.
Agents can inspect the current projection without a Figma connection through
`figma_reference {name:"fidelity"}`; `api gap` prints its aggregate status next
to the operation audit.

REST is reserved for capabilities the live plugin cannot structurally provide:
version history and version-pinned contents, comments, and file-wide published
component metadata. The client implements this as a closed method/path
allowlist. Current document content, nodes, CSS, exports, variables, styles,
Dev Resources, and known-key imports are explicitly plugin-only.
