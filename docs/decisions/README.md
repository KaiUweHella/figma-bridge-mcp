# Design decisions

The decisions that shape how Figma Bridge behaves, grouped by area and written
as the current state rather than as history. Each entry says what the Bridge
does or refuses, why, and what that means when you use it or build on it.
The underlying decision records, with their full context and the evidence
behind each choice, are maintained privately by the maintainer; these pages
carry the decisions themselves.

| Area                                                | What it covers                                                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Security and transport](security-and-transport.md) | One authenticated plugin transport, the daemon and its handshake, dispatch receipts and write lanes, the REST boundary, workspace I/O confinement, private state and the local-development profile |
| [Command model](command-model.md)                   | The Capability Catalog, Command Plans and Applications, typed operations versus legacy gates, confirmation and preview, file and node targeting, bounded outcomes and the MCP interface shape      |
| [Code to Figma](code-to-figma.md)                   | The Semantic Render Plan and its executors, the structural gate, sizing and text decisions, images and design entities in renders, verification and motion                                         |
| [Design to code](design-to-code.md)                 | Design capture and specs, asset and media export, `verify-build`, fidelity evidence, the browser fidelity ledger and the fidelity corpus                                                           |
| [Variables and tokens](variables-and-tokens.md)     | Reading, mutating, importing, exporting and syncing variables, collections, styles and tokens, including the composed-opacity boundary                                                             |
| [Components and library](components-and-library.md) | Design links and the registry, Storybook origins, component inventory, property authoring, creation and combination, instance editing                                                              |
| [Editors](editors.md)                               | Figma Slides, FigJam and Dev Mode: what each editor allows and how the Bridge keeps a request on the editor it named                                                                               |
| [Release and evidence](release-and-evidence.md)     | Packaging and provenance, typings pinning and the API reference, runtime budgets, soak acceptance, release scoring and plugin compatibility                                                        |

How to read an entry:

- **Decision** is the rule, in the present tense.
- **Why** is the reason it holds, in one or two sentences.
- **What it means for you** names the commands, flags, messages or limits you
  will meet because of it.

The project vocabulary these pages use is defined in [`CONTEXT.md`](../../CONTEXT.md);
user-facing behaviour is documented in the [README](../../README.md).
