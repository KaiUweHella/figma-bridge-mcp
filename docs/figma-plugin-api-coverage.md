# Figma Plugin API coverage

The installed `@figma/plugin-typings` package is the executable source of truth;
`api gap` compares it with the command surface and its explicit, test-verified
structured-type claims. Prose documentation is useful
for limits and examples but does not override the declarations used by tests.

| Area | CLI-first coverage | Important boundary |
|---|---|---|
| Local styles | list/show/create/update/apply/consumers/publish/delete; TextStyle variable bind/unbind | Remote styles are read-only; known keys import through Plugin API |
| Variables | metadata, scopes, values/aliases, code syntax, resolve, modes, publish state, collection extension | Extensions are Enterprise; libraries must already be enabled |
| Typography | range facts, OpenType readback, bindable variables, explicit axis-intent metadata | Exact variable-font axes and OpenType writes are not exposed by Plugin API |
| Prototypes | inspect/add/set/clear with raw Reaction JSON | Raw JSON is the lossless path for conditions and multiple actions |
| Measurements | list/add/edit/delete | Writes require Figma Dev Mode |
| Annotations | categories plus add/edit/remove/clear with properties | Indexes are zero-based |
| Video | MP4/GIF/WebM export | Only animated top-level frames; format-specific FPS enums |
| Shaders | list/import/apply to fill/stroke/effect | Import required; properties use definition IDs |
| Auto-layout grid | tracks, gaps, placement, auto rows/flow, row/column reorder | Separate from layout guides |
| Slots | create/edit/inspect/validate/reset; JSX support | Component-only creation; limits report violations rather than blocking edits |
| Figma Draw | inspect, text path, transform repeats, complex strokes, width profiles, patterns | Custom brushes cannot be set; patterns require async setters |

REST is reserved for capabilities the live plugin cannot structurally provide:
version history and version-pinned contents, comments, and file-wide published
component metadata. The client implements this as a closed method/path
allowlist. Current document content, nodes, CSS, exports, variables, styles,
Dev Resources, and known-key imports are explicitly plugin-only.
