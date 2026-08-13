# Figma Plugin API coverage

The installed `@figma/plugin-typings` package is the executable source of truth;
`api gap` compares it with the command surface and its explicit, test-verified
structured-type claims. Prose documentation is useful
for limits and examples but does not override the declarations used by tests.

| Area | CLI-first coverage | Important boundary |
|---|---|---|
| Local styles | list/show/create/update/apply/consumers/publish/delete; TextStyle variable bind/unbind | Remote styles are read-only; known keys import through Plugin API |
| Variables | metadata, scopes, values/aliases, code syntax, resolve, modes, publish state, collection extension; Design Capture keeps collection identity, explicit/resolved mode, WEB syntax and resolved value | `inferredVariables` is suggestion-only; extensions are Enterprise; libraries must already be enabled |
| Typography | range facts, OpenType readback, bindable variables, explicit axis-intent metadata | Exact variable-font axes and OpenType writes are not exposed by Plugin API |
| Prototypes | inspect/add/set/clear with raw Reaction JSON | Raw JSON is the lossless path for conditions and multiple actions |
| Measurements | list/add/edit/delete | Writes require Figma Dev Mode |
| Annotations | categories plus add/edit/remove/clear with properties; native labels and Code-to-Figma fallback metadata survive into Code-Spec with separate provenance | Indexes are zero-based |
| Video | MP4/GIF/WebM export | Only animated top-level frames; format-specific FPS enums |
| Shaders | list/import/apply to fill/stroke/effect | Import required; properties use definition IDs |
| Auto-layout grid | tracks, gaps, placement, auto rows/flow, row/column reorder; Design Capture precedence is authored Auto Layout/Grid → marked `inferredAutoLayout` heuristic → geometry | Inferred layout is evidence, not proof that a frame is authored with Auto Layout; layout grids are separate |
| Slots and component contracts | create/edit/inspect/validate/reset; JSX support; capture SLOT/INSTANCE_SWAP properties, references, preferred values, direct overrides, exposed instances and limit violations | Component-only slot creation; limits report violations rather than blocking edits |
| Dev Mode inspection | separate connected `manifest.dev.json` reuses the authenticated Bridge for selection, specs, exports and other reads | Dev Mode is read-only; canvas writes require the Design editor adapter, and `dev` cannot share one manifest with the existing FigJam target |
| Figma Draw | inspect, text path, transform repeats, complex strokes, width profiles, patterns | Custom brushes cannot be set; patterns require async setters |
| FigJam | board readback including table cells; sticky/shape/connector/table/section/code creation; selection/id-scoped arrange; live-accepted 2026-08-10 | Whole-page arrange requires explicit `--all`; see `live-acceptance.md` |
| Figma Slides (beta) | grid/slide inspect; durable Bridge labels; create, duplicate, move, transition, skip and explicit delete; live-accepted 2026-08-10 | Native names are renumbered by Figma; no speaker-notes API or native interactive-element creation; see `slides-roadmap.md` |
| Token files | broad one-shot import from Tailwind, CSS, DTCG-compatible Style Dictionary/Tokens Studio JSON; three-way sync for DTCG JSON and CSS custom properties | Import may normalize/bucket values; sync stays narrow to avoid lossy round-trips; Sass variables are unsupported |

REST is reserved for capabilities the live plugin cannot structurally provide:
version history and version-pinned contents, comments, and file-wide published
component metadata. The client implements this as a closed method/path
allowlist. Current document content, nodes, CSS, exports, variables, styles,
Dev Resources, and known-key imports are explicitly plugin-only.
