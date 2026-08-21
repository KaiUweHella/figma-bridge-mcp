# Changelog

Notable changes per release. Dates are release dates; the project follows
semantic versioning loosely while pre-1.0 (breaking changes bump the minor).

## Unreleased

### Added

- Added Safe-Mode Commands for duplicating cloneable canvas nodes (including
  Sections), reparenting nodes with explicit child order, setting instance
  component properties, and applying editable gradients directly to fills or
  strokes.
- Capability-gated validated `create` primitives can now create Frames,
  Rectangles, Ellipses, Text, Lines, and Auto Layout frames inside an existing
  parent. Selection-based and network-backed legacy creators remain blocked.
- Added validated Polygon, Star, Vector and Slice creation; ID-scoped
  group/ungroup/flatten/Boolean operations; empty Component creation;
  instance creation, swapping, detaching and override management; and native
  page-divider creation.
- Expanded `node set` to cover common Figma property-panel edits including
  locking, rotation, constraints, masks, blend/effects, individual corners,
  advanced strokes and Auto Layout container/child settings.
- Added Figma 1.133 EASING and TIMING variable creation plus scoped local
  collection deletion.
- Added an operation-level API audit pinned to the official Figma typings. New
  PluginAPI creators/structural operations, engine commands and variable or
  easing types now fail tests until explicitly supported or classified as a
  documented boundary.
- Added a versioned, fail-closed Round-trip Fidelity Contract for 11 core Figma
  fact families. `figma_reference {name:"fidelity"}` projects both directions,
  their implementation seams and verification requirements without requiring
  a Figma connection.
- Added Asset Manifest v2 with separate source identity, canonical content
  digest, semantic label, physical filename and root-scoped placements. Export
  collisions now receive stable digest filenames, identical content is reused
  across runs, and v1 manifests remain readable.
- Design Capture now reports a depth-independent hidden-content census with
  visible/hidden/hidden-text counts and bounded layer previews. Code-Spec keeps
  hidden layers non-rendering by default while making incomplete hidden-state
  inspection explicit in tree, YAML and JSON output.
- Component Set capture now uses Design Entity, publish key, or local set id
  instead of display name, normalizes common state/Boolean conventions, and
  exposes a `defined | noneDefined | notCaptured` coverage lattice. Missing
  set facts block style projection with one bounded batch-read recipe.
- CSS and DTCG export now preserve complete collection modes and resolve alias
  chains per mode. DTCG stores the lossless mode table in its Bridge extension;
  CSS emits `:root` plus named `data-figma-mode` scopes and never invents
  unauthored `clamp()` semantics.

### Fixed

- `figma_spec` no longer requires one Manual Mode approval per structure/style
  section. A bounded `nodeIds[]` batch now carries up to eight complete reads
  inside one MCP call, and the design-to-code workflow prefers one shallow
  `phase: "all"` read before batching only genuinely missing section facts.
- Native variant rendering now resolves component-property definitions from
  the owning Component Set before touching Figma's throwing variant accessor.
- `figma_connect` is now idempotent: a new AI session reuses a healthy daemon
  and authenticated Figma socket instead of forcibly restarting both. Explicit
  pairing-key rotation still performs the required controlled restart.
- Replaced the plugin's unbounded five-port WebSocket retry loop with three
  fast attempts plus a quiet CORS-scoped `/plugin-ready` discovery probe. A
  daemon that starts later is detected within about three seconds without
  Chromium retry throttling; no-key and timeout states self-heal automatically.
- `figma_connect` now verifies the one connected plugin with a read-only round
  trip. If the socket is open but the iframe relay is wedged, the long-lived
  Figma plugin thread reloads only that iframe and immediately reruns discovery;
  an unresponsive relay falls back to a socket reset.
- Daemon stop/restart now verifies that the PID file process owns the published
  listening socket before sending any signal. Forced cleanup targets only that
  PID, never other processes connected to the same port such as Figma Desktop.
- Failed daemon startup now makes `figma_connect` fail instead of returning a
  misleading success response with only setup instructions.
- Design Capture and Code-Spec now preserve native prototype reactions, masks,
  blend modes, corner smoothing, strokes included in Auto Layout and full
  Noise/Texture/Glass/progressive-blur parameters.
- Structured Noise writes omit the default `NORMAL` blend mode that current
  Figma Desktop rejects despite exposing it in readback typings. Any later
  property-write rejection now rolls back all canvas nodes created by that
  render instead of leaving partial test or production objects behind.
- Asset export now stages all writes, refuses to overwrite different existing
  bytes, and publishes the manifest last. `verify-build` validates physical
  files against Manifest v2 digests and fails on missing or tampered assets.
- Public command failures now pass through one stable error projection that
  preserves actionable engine output without exposing internal executable
  paths or argv. Safe-read retry, readiness wait and CLI fallback share one
  decreasing deadline; a missing daemon token skips readiness waiting.

## [0.5.2] — 2026-08-19

### Added

- Added an always-visible reload action in the Figma plugin status card. It
  cancels stale sockets and scans, restores the fast retry state, and probes
  every local bridge port immediately while the background reconnect remains
  active.
- Added a Figma-plugin build handshake. `figma_status` now distinguishes an
  outdated Figma application cache from daemon, key, and port failures and
  tells the user to re-import the stable local manifest path.

### Changed

- Replaced the terminal-looking "Daemon not reachable" state with an honest
  animated "Waiting for MCP" state that says automatic retries are continuing.

## [0.5.1] — 2026-08-18

### Added

- Added layered public-release guards: staged-file scanning before commits,
  outgoing-commit scanning before pushes, complete-history checks in CI and
  releases, and a gitignored local denylist for private client/project names.
  Findings redact the matched value and real Figma file URLs are rejected in
  favor of explicit placeholders.

### Fixed

- Return `figma_connect` setup instructions and the access key as soon as the
  daemon is ready instead of waiting 12 seconds for a plugin that cannot pair
  until the MCP client displays that key. The detached daemon continues
  listening and the plugin reconnects automatically after **Save & connect**.

## [0.5.0] — 2026-08-18

Pairing note: development-plugin ids now use the `figma-bridge-mcp` product
name. Re-import the chosen manifest and paste the existing access key once;
the daemon/state directory and key themselves remain unchanged.

### Added

- Added DTCG 2025 token import/export with structured sRGB colors and
  dimensions. Figma variable ids, collections, scopes, and platform code
  syntax now round-trip through a namespaced extension; stable ids preserve
  bindings across otherwise ambiguous renames, and collection metadata keeps
  multi-collection exports scoped to the intended sync target.
- Added persistent **Design Contracts** with `contract capture` and
  `contract check`. Contracts canonicalize complete Design Captures, reject
  depth-limited evidence, and gate exact or semantic drift in root geometry,
  component-set variants, token bindings, and prototype transitions.
- Added editable native Rich Text rendering for nested inline emphasis,
  decoration, spans, and links. Semantic Render Plans carry validated UTF-16
  ranges, preload every requested font before mutation, and apply native Figma
  range styles instead of flattening formatted copy into separate layers.
- Added production dependency auditing to CI and the npm release workflow,
  plus grouped Dependabot maintenance for compatible minor and patch updates.
  Automated npm major updates are excluded so supported Node versions and
  toolchain migrations remain explicit maintainer decisions.
- Added one cross-client plugin bundle for Codex, Claude Code, and Cursor with
  focused Design-to-Code, Code-to-Figma, and Component-Library skills plus
  equivalent MCP prompts for clients that do not load Agent Skills.
- Added GitHub-hosted Codex and Claude marketplace manifests. Release entries
  pin the exact `v<version>` Git tag and matching npm runtime instead of
  following `main` or `@latest`; a release-sync command and CI check keep every
  package, engine, plugin, marketplace, lockfile, and MCP version aligned.
- Added conservative MCP safety annotations for every tool and a bilingual
  workflow-routing eval suite with six positive and three negative cases.
- Added a versioned **Semantic Render Plan** shared by JSX and measured browser
  DOM capture, with a native Figma executor, pre-write Structural Gate, live
  subtree audit and reversible resize probe. Flexbox and Grid stay editable as
  Auto Layout and native Grid rather than being replayed as measured pixels.
- Added the repository-owned **Design Link Registry**, Accepted Design
  Baselines, report-only Round-trip Plans and projected Project Design Context
  so agents can resolve and continue editing the same code/Figma component
  without guessing from display names or geometry.
- Added reviewed CSS ↔ Figma boundary policies for `minmax()`, `space-around`,
  mixed per-side border paints, sticky positioning, filter chains, masks,
  variable fonts and native Figma effects. Unsupported or undecided facts stop
  before canvas mutation.
- Added automatic, property-scoped native Figma annotations for opted-in lossy
  boundary policies. `border.single-paint-native` now explains the lost
  per-side paint distinction directly on the affected node, preserves all
  native side weights, and stores versioned machine-readable fallback metadata
  for future agents.
- Added deterministic variable scope handling and Named Text Style
  reconciliation. Newly created `space|spacing/*` and `radius|radii/*` FLOAT
  variables receive narrow compatible scopes; other scopes remain an explicit
  user decision, and conflicting same-name Text Styles stop preflight.
- Closed the semantic feedback loop from Code-to-Figma back into Design
  Capture and Code-Spec. Bridge semantic paths, render/fallback provenance,
  native annotations, complete component contracts and mode/scope-aware
  variable bindings now survive as structured facts. Authored Auto Layout/Grid
  wins over marked Figma `inferredAutoLayout`; geometry remains the last,
  explicit fallback.
- Added semantic-subtree delta navigation to report-only Round-trip Plans.
  Changed semantic paths resolve to their current Figma node ids without
  turning report-only reconciliation into an automatic write.

### Fixed

- Updated the MCP SDK and safe runtime transitive dependencies while pinning
  `@hono/node-server` to the maintained Node 18-compatible line. This prevents
  a transitive major from silently raising the package's declared runtime
  baseline.
- Made token metadata conflict resolution lossless: explicit scopes and code
  syntax now survive `--ours`, removed platform syntax is actually cleared in
  Figma, and metadata-only changes are visible in sync plans.
- Fixed the npm-installed executable silently exiting when launched through a
  POSIX `.bin` symlink. The tarball CI now proves `initialize` and `tools/list`
  against the installed executable instead of only checking its exit code.
- Made the shipped-runtime synchronization test independent of Windows CRLF
  checkouts, and split the architecture latency gate into strict median and
  tail ceilings so isolated shared-runner pauses no longer fail an otherwise
  healthy release.
- Add a separate connected Dev Mode Inspect manifest, keep the normal Bridge
  available for read-only MCP inspection in Dev Mode, and report the Design
  mode boundary explicitly for canvas writes.
- Restored the readable `tree` design-spec default after a Sonnet 5 regression
  test showed that the lossless compact-JSON default expanded a 6.5k/83-line
  structure map into a 45k one-line response, pushed a central style response
  beyond the client's tool limit, and led the agent to invent artwork.
- Restored the mandatory screenshot → structure → tokens → assets → style →
  verify sequence to the initial MCP instructions. The 0.4.0 on-demand guide
  accidentally made asset export and verification optional in practice; the
  observed build shipped zero of 34 Figma assets and never ran `verify-build`.
- Removed minified JSON from the public and internal design-spec formats after
  agent tests showed its one-line presentation harmed implementation fidelity.
  Tree remains the default; YAML and formatted JSON preserve the full model.
- Added an exact per-layer implementation contract: MCP specs inline native
  Figma Inspect CSS and existing layout/paint/token facts by default, expose
  every layer id, retain complete copy and mixed rich-text range styles, and
  no longer collapse identical siblings when deduplication is disabled.
- Added visible-layer accounting. Style projections now fail instead of asking
  an agent to guess when depth limits or an unexplained capture gap leave a
  Figma layer unaccounted; SVG/component internals and non-rendering helpers
  are classified explicitly.
- Added complete node-only style capture with `depth:0`, including an output-
  budget retry recipe that pulls container styles before bounded child calls
  and uses lossless deduplication for repeated lists/cards.
- Return `verify-build` findings through MCP when the verifier exits 1, keep
  exported CSS token names identical to native Figma `var(...)` references,
  and expose explicit prototype scrolling/fixed-child facts without inferring
  sticky behavior from geometry.
- Downsample oversized PNGs by default to 2× their largest Figma usage, only
  when this reduces bytes and never by upscaling. `--raster-scale 0` retains
  originals; the manifest records source/output dimensions.
- Export compact vector-only icon instances at their component-frame bounds,
  preserving optical padding and the 16/20/24px icon-size contract. IMAGE
  filenames are now hash-stable across isolated specs and full asset exports.
- Mark prototype scrolling on `h:hug` frames as incidental document scroll,
  and include exact omitted child IDs/depth-0 calls in depth-limit errors.

## [0.4.0] — 2026-08-10

Breaking for existing pairings: after upgrading, run `figma_connect` and reopen
the plugin window. The panel will tell you if you forget.

### Efficient, lossless design-to-code output

- **In-process command applications.** `figma_spec`, `figma_inspect` and
  `figma_screenshot` now share value-returning Command Application Modules with
  their CLI counterparts instead of keeping behaviour inside Commander actions.
  MCP skips process startup and Commander registration; five paired spec runs
  on a 285-node screen averaged 607 ms direct versus 778 ms through the legacy
  child-process adapter, with identical SHA-256 output. The generic `figma_run`
  tool deliberately remains the broad CLI Adapter. A shared Daemon Client
  Module concentrates signing, timeouts and transport errors.
- **One Capability Catalog for command policy.** MCP and the execution wrapper
  now consume the same immutable CommandPlan instead of maintaining separate
  allowlists, write matrices, targeting branches, path rewrites, retry rules,
  timeouts, accepted exit codes and asset-job keys. Unknown commands resolve to
  denied/write/no-retry; write plans can never opt into automatic replay.
  `figma_reference {name:"capabilities"}` exposes the generated command index
  on demand without an engine round-trip, so the full list no longer consumes
  tokens in every MCP tool handshake.
- **Design Capture once, project many times.** Repeated explicit-node
  `figma_spec` calls can now reuse one information-rich walker Capture across
  structure/style phases, dedup modes and tree/YAML/JSON projections. The
  plugin supplies monotonic document revisions and the Bridge Daemon binds
  them to a daemon-owned connection identity. Every hit probes freshness;
  changes, reconnects, unstable revisions and old plugins invalidate or bypass
  the bounded in-memory cache immediately. Selection and named-section calls
  deliberately remain uncached in this first Slice.
- **One canonical spec model, two lossless structured adapters.** YAML and
  formatted JSON roundtrip every design field exactly. The versioned model
  carries capture completeness and dynamic fidelity checks; Storybook
  enrichment uses component-key fields instead of parsing rendered tree text.
  Tree is the agent-facing default.
- **No silent partial specs.** Results above the output budget now return an
  explicit `complete:false` refusal plus a section-by-section retry recipe,
  never a truncated prefix that could be mistaken for the whole design.
- **Smaller MCP context.** Server instructions are an on-demand workflow index
  instead of a repeated long guide; tree legends were compressed while their
  existing fidelity contracts remain tested. Focused guides are available as
  `workflow:design-to-code` and `workflow:code-to-figma`.
- **Consistent file targeting.** Dedicated render, selection, inspect,
  screenshot and spec tools accept `fileKey`; pasted Figma URLs infer it.
  One immutable Figma Target Context resolves that choice once and carries it
  through command policy, audit, job identity and daemon execution. Asset-job
  identity includes the file, preventing cross-file collisions.
- **One Asset Policy.** Design Capture projections and asset export now share
  the same classification implementation for image fills, vector artwork and
  vector clusters; plugin-side and captured-node adapters only translate their
  input shapes.
- **Executable architecture contracts.** TypeScript checks the JavaScript
  module seams and Figma plugin globals; runtime validators gate both HTTP exec
  payloads and WebSocket plugin frames. Deterministic tests track MCP metadata,
  compact-spec, injected plugin-code and local p50/p95 latency budgets.
- **Durable domain decisions.** `CONTEXT.md` defines the project vocabulary,
  six ADRs record the security, command, targeting, MCP and capture-cache
  decisions, and `docu/README.md` indexes the historical evidence archive.
- **Fast local status.** `figma_status` no longer performs a cold REST request
  unless `validateRest:true` is requested.
- **Hermetic cross-platform CI.** CLI integration tests now isolate daemon
  token/PID files, socket tests use OS-assigned ports, and Node discovers test
  files without shell-expanded globs. The workflow covers the declared Node 18
  minimum plus active Node 22/24 LTS lines without a redundant OS/runtime
  Cartesian product, and uses current `checkout`/`setup-node` v6 actions.
- **Truthful variable-font inspection.** `figma_run ["font","inspect",…]`
  reads range-level `fontName`, Figma's numeric read-only `fontWeight`, enabled
  OpenType features and typography-variable bindings. Because the Plugin API
  has no general variation-axis tuple, `font remember-axes` stores caller-known
  axes as explicitly metadata-only range records; `font axes` reads them and
  `font forget-axes` removes them. Design specs carry the reported weight,
  enabled features and `axes-meta[…]` records losslessly without claiming that
  metadata changed Figma's glyph rendering.
- **Plugin-first native facts.** `node css` exposes Figma's own
  `getCSSAsync()` result, and `export node-json` emits `JSON_REST_V1` directly
  from the live document. Both avoid a REST token and network request;
  `export node-json -o` is separately classified as a workspace write.
- **Typography-variable bindings.** `font bind` and `font unbind` cover all
  Plugin-API bindable typography fields on a whole TextNode or character
  range, with local-name disambiguation, STRING/FLOAT validation and font
  loading. The output continues to state that numeric weight bindings are not
  a general variable-axis setter.
- **Named versions from the command line.** `history save` calls
  `saveVersionHistoryAsync()` through the authenticated plugin transport;
  reading native historical versions remains an explicit REST-only feature.
- **Official API coverage input.** `api gap` now scans the installed
  `@figma/plugin-typings` declarations. The optional Markdown clone is retained
  for prose lookup but is no longer the canonical coverage inventory.
- **Plugin-first local style management.** `style list/show/create/update/apply`
  plus `consumers`, `publish-status` and `delete` cover local PAINT, TEXT,
  EFFECT and GRID styles. Lookups reject ambiguity, property JSON is
  type-allowlisted, and application uses Figma's async style setters.
- **Variable and collection authoring.** `var show/update/set-value/code-syntax`
  plus consumer-aware `resolve` and publish status expose values, aliases,
  scopes and Dev Mode names. `col show/update/mode-*` manages collection
  metadata and modes through the Plugin API; REST is not involved.
- **Enabled team-library access.** `library collections` and `variables`
  discover published variables from libraries enabled in the current file.
  Key-based imports cover variables, styles, components and component sets;
  every operation uses the Plugin API and the shipped `teamlibrary` permission.
- **Complete design-system authoring.** `col extend` covers local and published
  collection extensions (with Figma's Enterprise limit surfaced), while
  `style bind-font` / `unbind-font` bind the official TextStyle typography
  fields to local variables.
- **Native prototypes, measurements, and annotations.** Prototype reactions
  roundtrip through `setReactionsAsync()` including multiple, variable, and
  conditional actions. Dev Mode measurements use `PageNode` methods with an
  editor guard. Annotations now include categories, properties, and indexed
  edit/removal.
- **2026 Plugin API coverage.** Added animated MP4/GIF/WebM export, shader
  discovery/import/application, auto-layout GRID tracks/placement/flow/reorder,
  Slot GA settings/reset/limit validation, and Figma Draw text paths, transform
  repeats, brushes, variable-width strokes, and async patterns.
- **Closed REST boundary.** `figma-rest.js` now rejects every method/path not
  named in its metadata/history allowlist before token lookup or network I/O.
  Current file contents require the plugin; REST document reads require an
  explicit historical version ID.

### Component-aware rendering

- **`component add-variant <set> "Prop=Value"`** adds a missing variant to an
  existing component set by cloning the nearest existing variant (`--from`
  picks the source explicitly), so the new state inherits the set's structure
  instead of drifting. A pair naming a new axis backfills that axis onto every
  existing variant (with a warning) rather than leaving the set in Figma's
  missing-property error state.
- **A `variant=` that does not exist now fails the render** with the set's
  actual axes/values and the ready `add-variant` command — previously a typo
  silently rendered the default variant as if it were the design.
- **Reuse lint:** rendering a frame named like an existing component set or
  component prints a warning with the ready `<Instance>` line (file inventory
  is cached in the plugin sandbox for 60 s). Warn-only, never blocks.
- **Repeat lint:** three or more structurally identical siblings in one render
  print a componentize hint (render one, `node to-component`, place
  instances). Detected from the JSX alone.

### Security

- **The plugin access key no longer crosses the wire.** The plugin WebSocket now
  runs a mutual challenge-response handshake (proto 2): the daemon challenges
  with a random nonce, the plugin answers with an HMAC over both nonces, the
  bound port and its version, and the daemon proves itself back before the panel
  will accept a single command. This retires the residual risk earlier versions
  documented, where a process squatting a range port could read the raw key out
  of the plugin's first frame.
- **The daemon must now authenticate to the plugin.** Previously the panel ran
  any `eval` it was sent, so impersonating the daemon needed no key at all.
- **Relay defence.** The bound port is part of the signed transcript, so a
  squatter that forwards frames between the plugin and the real daemon on a
  different port fails verification.
- There is no proto-1 fallback. After upgrading, run `figma_connect` and reopen
  the plugin window; a stale panel says exactly that instead of silently
  negotiating something weaker.

### Added

- **`node bind`** — attach a variable to a property of an existing node
  (`fill`, `stroke`, `radius`, `gap`, `padding` and the rest), by node id, with
  a `--batch` form. The read counterpart `node bindings` already existed; there
  was no way to write one. An ambiguous variable name is refused with both
  candidates named rather than resolved by whichever came first, and the
  variable's type is checked against the property before the plugin sees it.
- **`node set`** — change properties on existing nodes (fill, stroke,
  strokeWidth, radius, opacity, x, y, width/height, name, visible), one node or
  many through `--batch`. The batch form is one round-trip, which is the point:
  renaming forty layers used to be forty daemon calls. Colours take a hex or
  `var:<name>`; a `var:` reference stays bound, so `tokens rebind` can still
  move it later.
- **`analyze lint`** — one pass for the four things a design-system review acts
  on: colours matching an existing variable but not bound to it, default layer
  names, text without a style, text under 12px. A colour is only reported when a
  variable already holds that value, so every finding is actionable — and
  arrives with the `node bind` call that fixes it. `--fail-on-issues` makes it a
  CI gate.
- **`tokens rebind <collection>`** — the theme switch: walk a subtree and
  repoint every variable binding at the same-named variable in a target
  collection. Plans by default, writes under `--apply`; tokens with no
  counterpart in the target are listed and left alone. Where `tokens sync`
  changes what a token _is worth_, this changes _which collection a design
  follows_.
- **`kit init`** — one command that makes an existing design system
  agent-ready: DESIGN.md, DTCG tokens, a component inventory with stable
  publish keys, and the Figma↔Storybook mapping. It orchestrates commands that
  already existed; what was missing was knowing which four to run and what the
  result means. The report ends with what is still missing, because a setup
  that quietly lacks the Storybook mapping looks finished until an agent needs
  it. This is the project's answer to bundled design systems — it stays neutral
  and makes _your_ system legible instead.
- **Several Figma windows at once.** The daemon now keeps one connection per
  window in which the plugin was started, instead of letting the newest
  displace all others. With one window nothing changes; with several, a command
  must name its file (`--file <key>`, or `fileKey` on `figma_run`) and gets the
  list of connected files if it does not. There is no "all files" option —
  every write names one file, so a mistaken command cannot fan out across a
  library. Two windows on the _same_ file still supersede each other. Audit
  entries carry the file key.
- **FigJam is back**, as the `jam` command group — stickies (single and
  batched), shapes, connectors, tables, sections, code blocks, a board readout
  and a grid arrange. It runs over the existing plugin bridge; the manifest
  gains `figjam` as an editor type and nothing else. Every snippet checks
  `figma.editorType` first, so running a board command in a design file says so
  instead of failing on an undefined API, and `figma_status` now reports the
  editor. `jam arrange` now defaults to the current selection, accepts an
  explicit `--ids` target, and requires `--all` before touching the whole page.
  Board readback includes table dimensions and cell values. The complete public
  surface passed a Figma Desktop live acceptance; that run also caught and fixed
  the required `Source Code Pro Medium` load before writing a code block.
- **Figma Slides beta.** A guarded `slides` command group inspects the native
  canvas grid and can create, duplicate, move, transition, skip and explicitly
  delete slides. Because Figma renumbers native slide names after grid changes,
  create/duplicate store optional durable Bridge labels in plugin data and
  inspection exposes both facts. Resolution by id/name/label refuses ambiguity;
  move and duplicate refuse missing target rows instead of accepting Figma's
  fallback placement. The entire beta surface passed a Figma Desktop live
  acceptance. Slides uses the same authenticated plugin transport and write
  gate; interactive elements and speaker notes remain documented API boundaries
  in `docs/slides-roadmap.md`.
- **Two-way token sync.** `tokens sync <file>` compares a DTCG/W3C JSON or CSS
  custom-property file against a Figma collection and applies the difference —
  in the right direction. A `figma-tokens.lock.json` records the last agreed
  state, so the command can tell "the code changed" from "Figma changed"
  instead of guessing and overwriting a designer's afternoon. Both changed is a
  conflict that stops the run; `--ours` / `--theirs` decide them in bulk.
  Deletion needs `--prune` and never touches a variable sync did not create.
  Renames keep the same Figma variable (and its bindings) where the pairing is
  unambiguous. Dry run by default; exits 1 with pending changes so it works as
  a CI check.
- **Truthful token-format contract.** One-shot import explicitly covers
  Tailwind/CSS, Storybook and DTCG-compatible Style Dictionary/Tokens Studio
  JSON, with a Tokens Studio fixture. Three-way sync remains limited to DTCG
  JSON and CSS custom properties; the false `.scss` acceptance was removed
  instead of pretending Sass `$variables` could round-trip.
- **Release and contribution runway.** The npm tarball now carries the support
  policy, issue/PR templates capture redacted reproduction and live-check
  evidence, and a manual GitHub workflow is ready for npm OIDC Trusted
  Publishing after the maintainer performs the first CLI publication. No npm
  write token is stored in the repository.
- **Structural version history.** `history snapshot` records a subtree,
  `history diff` compares two — locally, with no Figma credential. The report
  distinguishes added / removed / **replaced** / moved / changed; the replaced
  case is what keeps an agent's delete-and-re-render from reading as a hundred
  deletions. `--changelog` emits markdown, and the command exits 1 on any
  difference so it works as a CI gate.
- Via MCP: `figma_history {diff:{from,to}}` — a parameter, not a thirteenth
  tool. `version:<id>` refs diff real Figma versions through the REST layer
  using the same differ; mixing a REST version with a local snapshot is refused
  with the reason, since the two expose different properties.
- `runCli` gained `okExitCodes`, so a command can use its exit code as an
  answer without a blanket "ignore failures".
- `motion` is reachable through `figma_run`: Figma Motion keyframes, specs,
  presets, staggers, animation styles, timelines, readback and clearing. It runs
  over the same plugin bridge as everything else. `styles` and `inspect` are
  reads; the rest is gated by `FIGMA_WRITE_CONFIRM`.
- `SECURITY.md` — threat model, guarantees, and an explicit list of what the
  design does _not_ protect against.
- CI across macOS, Linux and Windows on Node 18/20/22, plus a job that verifies
  the published tarball actually contains the plugin and engine.
- `tests/plugin-handshake.test.js` runs the panel's own SHA-256/HMAC against
  Node's `crypto`, so the two implementations of the protocol cannot drift.
- `tests/plugin-sync.test.js` fails the build if the plugin manifest, the panel's
  port scan and the daemon's port range disagree, or if a non-loopback host is
  ever added to the manifest.

## [0.3.0] — 2026-08-04

### Added

- Opt-in REST layer: `figma_comments`, `figma_history {includeVersions:true}`
  and library metadata for `map storybook`. The token is pasted into the plugin
  window, stored 0600, and never appears in chat, MCP client config or the audit
  log.
- npx-installable; renamed to `figma-bridge-mcp`.
- Plugin panel rebuilt around connection state: live activity log, Pause as a
  kill switch, Save version as a restore point, and a selection readout showing
  what the agent sees.

### Changed

- Renamed from FigCli to Figma Bridge throughout.
