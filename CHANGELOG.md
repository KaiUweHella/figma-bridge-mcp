# Changelog

Notable changes per release. Dates are release dates; the project follows
semantic versioning loosely while pre-1.0 (breaking changes bump the minor).

## Unreleased

### Fixed

- Every Slides mutation now reaches a slide the canvas grid has not listed
  yet. `slides delete`, `duplicate`, `move`, `transition` and `skip` walked
  only `figma.getCanvasGrid()`, which lags the page tree by minutes, so such a
  slide could not be addressed at all — and a focus resting on one made every
  one of them, `create` included, refuse with "invalid focused Slide". Each
  snapshot now splices the same page-tree walk the deck readers use
  (`slidePageSlidesFragment`): the grid stays authoritative for coordinates,
  the page tree for existence, and the snapshot carries the unlisted ids so
  the strict before/after comparison covers them too. `delete` verifies an
  unlisted slide by node existence, since the grid cannot change. `move`
  resolves such a slide but refuses it with the reason: without a grid
  coordinate there is no origin to restore if the move must be reversed.
  `slides media` and `slides focus` resolve `name:`/`label:` references over
  the page tree as well, not only over the grid.
- A refused Slides command now says why. `slides view sideways` reported
  "Command not allowed: slides view", as if the verb were disallowed when the
  mode was the problem; the same held for every Slides verb with invalid
  arguments. Fixed once at the Capability Catalog's rejection projection: each
  Slides action maps to its own request parser, and the parser's reason is
  shown when it carries no caller payload (option names, closed value sets,
  bounds, Union Reference codes), so `figma_run` reports "Malformed request
  for slides view: view mode must be one of grid, single-slide". A reason that
  would echo an argument stays generic. The in-process Command Application
  appends the same projection to its "Command not allowed" error, so the CLI
  explains the refusal the same way.
- The 8 MB `IMAGE_HARD_LIMIT` that `render`, `render-batch` (`<Image src=…>`)
  and `node set-image` advertised was unreachable: inbound image bytes ride
  inside the plugin payload as base64 (the asset stream is export-only), which
  inflates them by 4/3 against a 5 MB protocol limit, so a file between ~3.7
  and 8 MB failed at the transport with a protocol error instead of the
  command's own guidance. The ceiling is now 3.5 MB, stated once in
  `image-file.js` with a test that proves it fits the protocol after base64
  inflation; `slides media` re-exports the same constant instead of restating
  the arithmetic. Every refusal names the file's size, the ceiling and the
  reason. A render additionally measures its whole plan payload before Plugin
  readiness — the same value the protocol validator measures — because several
  images that each pass the per-file ceiling still share one protocol value.

### Added

- Figma Slides content can be authored through the native render pipeline
  (ADR 0130): `render --slide <nodeId>` renders one Semantic Render Plan into
  the named slide. Previously `render-plan` was refused outside Figma Design,
  so a deck could only be filled by accident — through the legacy compatibility
  executor, which is not editor-gated — and it landed in whichever slide
  happened to be focused, because `figma.currentPage` in the Slides editor is
  the focused slide.
  The Dispatch Receipt guard now admits exactly one exception: action
  `render-plan`, editor `slides`, and a well-formed slide id carried by the
  same request payload the plugin executes. `render-plan-batch` stays refused
  in Slides, and FigJam and Dev Mode stay closed even with a slide-shaped
  target. The executor resolves the target before any mutation and refuses a
  missing or wrong-typed node with `no-mutation`, then places the root in the
  slide's own coordinate space. `--slide` takes a node id from
  `slides inspect`; `name:`/`label:` references are not accepted, because
  resolving one needs a read and an ambiguous reference must never let a render
  pick its own target. Plugin build 3.3.41 — relaunch the development plugin
  before rendering into a slide.
- `slides media <slide> <file>` inserts a still image, an animated GIF or a
  video into one named slide, reusing the WorkspaceIO authorization the Design
  image commands already use. A GIF becomes a playable `MEDIA` node via
  `createGif` — the API the typings mark FigJam-only and which a live Slides
  runtime accepts — a still becomes an `IMAGE` paint at its natural size fitted
  to the slide, and a video a `VIDEO` paint. The file is authorized and read
  before any Figma call, and a created node is removed again when the insert
  cannot be verified. The ceiling is ~3.5 MB of file bytes: inbound media rides
  in the eval payload (the asset stream is export-only) and base64 inflates it
  by 4/3 against a 5 MB protocol limit, which also makes the 8 MB
  `IMAGE_HARD_LIMIT` other image commands advertise unreachable.
- **Fixed: every Slides reader under-reported the deck.**
  `figma.getCanvasGrid()` can lag the page tree by minutes — a live slide whose
  parent was a slide row in the same page was absent from the grid across
  daemon restarts and dozens of commands before it eventually appeared, so
  `slides lint` reported "no findings across 8 slide(s)" on a nine-slide deck
  whose hidden slide was empty and had no transition. The shared deck-facts
  fragment now reconciles the grid against the page tree: the grid stays
  authoritative for coordinates, the page tree for existence. Such a slide is
  reported with `row`/`col` `null`, listed under `unlisted` by
  `slides manifest`, and flagged by a new `unlisted-slide` lint kind.
  `slides inspect`, `lint`, `manifest` and the `batch` preflight all gained
  this first; the mutation commands followed (see "Fixed" above), so no
  Slides command walks the grid alone any more.
- `slides manifest` no longer refuses a deck whose focused slide the grid has
  not listed, and reports that state instead. A media insert that Figma rejects
  without an Error message now reports what it can recover from the rejection
  rather than the word "unknown" — which is how a video refusal ("Unable to
  generate a thumbnail for video") was diagnosed at all.
- `slides inspect` now uses the shared deck-facts eval fragment instead of its
  own inlined copy of the grid walk, the label reader, the transition reader
  and the fact projection (403 to 316 lines, same output). `slides duplicate`
  and `slides move` keep their own walks on purpose: theirs are mutation
  verification snapshots that also capture the page id, the selection and a
  node map, with per-command bounds and error messages their tests pin — the
  leaf facts coincide, the purpose does not.
- Corrected an availability claim in `docs/slides-roadmap.md` that had been
  taken from a typings doc comment rather than measured. `createGif` is
  documented as FigJam-only but is callable in Figma Slides — a live call there
  fails with `Invalid SHA1 hash`, an argument complaint rather than an editor
  refusal — so GIF insertion was never blocked by the platform, only by our own
  reading. `createVideoAsync` likewise fails on file type, not on the editor.
  `createLinkPreviewAsync` really is `undefined` in the Slides runtime, and
  speaker notes really have no member of any name on a live slide node.
- The two implementable Figma Slides P3 items. `slides manifest` now
  inventories each slide's `INTERACTIVE_SLIDE_ELEMENT` nodes with their native
  type (`POLL`, `EMBED`, `FACEPILE`, `ALIGNMENT`, `YOUTUBE`), walking the
  subtree under a node and per-slide budget and reporting
  `interactiveTruncated` when one is hit; an undeclared type is reported as
  `UNKNOWN` rather than passed through. Reading is the whole capability — the
  typings declare `clone()` and no create factory for these nodes.
  `slides focus <slide>` and `slides view <grid | single-slide>` move the
  editor's own context using the setters the typings declare
  (`PageNode.focusedSlide`, `ViewportAPI.slidesView`), verifying by readback so
  a silently refused change is reported as a refusal. Neither changes the
  document: both report `effects.figma: 'read'` with `effects.editor: 'write'`
  and are not gated by write confirmation.
- Bounded Figma Slides batch operations (roadmap P2):
  `slides batch '<json>' [--apply]` plans up to 64 heterogeneous `create`,
  `duplicate` and `move` items and performs them only when asked. The plan is
  the default, so the Capability Catalog classifies it as a read and only
  `--apply` as a write. Every reference is resolved and every coordinate
  validated against one grid snapshot before anything is written; a coordinate
  that would only become valid because of an earlier item in the same batch is
  refused rather than simulated, and two items targeting the same slide are
  refused. Application is sequential with a fresh readback per item, and the
  first failure reverses everything already applied — `verified`,
  `rolled-back` or `partial-residue`, never partial success. A reversal looks
  before it acts, so a move whose call threw without moving anything is
  restored by observation rather than by re-calling the API that just failed.
  Because Figma's canvas grid does not always list a slide in the same eval
  that created or moved it, an unobserved position is reported as
  `gridObserved: false` instead of failing a correct write; an observed
  position that disagrees with the request still fails and reverses.
- Two deck-wide Figma Slides reads (roadmap P2): `slides manifest` exports a
  compact per-slide projection in grid order, shaped for review and version
  control, with a header count that must reconcile with its body; and
  `slides lint` reports four structural findings — `duplicate-name`,
  `skipped-placement`, `missing-transition`, `empty-slide` — with `--kinds`,
  `--limit` and `--fail-on-issues`. Both are reads by construction
  (`effects.figma: read`, `effects.workspace: none`), retryable safe reads, and
  reachable from the CLI and `figma_run`. The deck's first slide is exempt from
  `missing-transition`: it has nothing to transition from, so flagging it would
  make every deck report a false positive.
  Both splice one shared deck-facts eval fragment
  (`slideDeckFactsFragment`) validated host-side by `slides-facts.js`, so a new
  deck-wide reader cannot drift from the fact shape the others report. The
  three pre-existing inline copies in `slides inspect`/`duplicate`/`move` are
  untouched and remain a separate cleanup.
- `docs/slides-roadmap.md` records a fresh audit of `@figma/plugin-typings`
  1.133.0 for the remaining Slides items: interactive slide elements are
  readable but have no create factory, `createGif` and
  `createLinkPreviewAsync` carry a FigJam-only note in the typings (a note
  the live runtime later contradicted for `createGif`; see the correction
  above), `createVideoAsync` carries only a paid-team restriction, focus and
  `slidesView` are settable, and speaker notes have no declared surface at all.

## [0.7.4] — 2026-09-01

### Added

- Motion round trip (ADR 0129): Design Capture keeps native Motion keyframe
  tracks and Code Spec projects them to `@keyframes` plus `animation` CSS with
  Figma's own easing curves (`## Motion` section, `motion` model field);
  Browser DOM Capture reads CSS animation facts and `@keyframes`, pauses
  playback while capturing resting geometry, and `render --dom-capture` writes
  them as native Figma Motion tracks on the created layers (`motionReport`).
  A Figma frame has one timeline, so an endless CSS loop whose period is
  shorter than the longest animation on the frame is repeated to fill that
  timeline, with the mid-cycle cut interpolated on its own easing curve;
  a period that cannot be repeated (finite iteration count, positive delay,
  mixed cycles) keeps its length and says so instead of freezing silently.
  `render --dom-capture` now reports both the captured animations with their
  limitations and the tracks Figma accepted; the motion outcome used to be
  written without a single line of output.
  Motion writes no longer roll back on Figma's canonicalized readback.
- Complete bounded Design Capture: the plugin walker now stops descending
  once a wall-clock or serialized-size budget is reached and reports the
  remaining subtrees as a `budgetCut` frontier; the host Design Capture completes every cut in
  further bounded plugin evals, verifies that each eval observed the same
  revision, and stitches one canonical capture. An 800-layer screen no longer
  outlives the plugin transport window or forces screenshot-derived guesses.
  `figma_spec` accepts `outFile` and `export code-spec` accepts `-o/--output`
  to persist the complete projection in the workspace and return summary
  facts instead of hitting the inline result budget. Code Spec runs in the
  long timeout class (ADR 0128). The live 826-layer Northern screen, whose
  single-eval capture exceeded the 5 MB plugin message limit, now captures
  completely.
- Canvas and Node authoring now has first-party Command Applications for Frame,
  Shape, Vector/Slice, Line, Text, Auto Layout and remote-image creation plus
  rename, resize, reparent, group/ungroup, flatten, Boolean operations, fills,
  image fills and Variable bindings. Each mutation closes over one validated
  target and reports verified rollback residue instead of retrying an unknown
  write.
- Native Auto Layout Grid workflows now cover configuration, inspection,
  auto-flow, child placement and track reordering. Layout Guide mutation,
  Figma Section creation/batching/arrangement/fitting and native Annotation
  inventory/editing/clearing are available through the same bounded plan
  model.
- Design handoff workflows now include Component Specs, Design Links, Dev
  Resources, Storybook maps, edge pins, Font Axis metadata, Measurements,
  Named Version history, Slot reads/configuration/reset, Prototype mutations,
  native Draw operations and guarded Library/Shader reads and mutations.
- Page census and lint diagnostics plus Accessibility audit, contrast, touch,
  text, focus and vision-simulation reads are exposed as bounded structured
  results.
- FigJam now has owned board inspection, Sections, Stickies and sticky batches,
  Shapes, Connectors, Tables, Code Blocks and bounded arrangement. The public
  workflows preserve editor identity and verify the useful native structure
  they create.
- Figma Slides beta now supports deck inspection and the complete safe
  structural lifecycle: create, duplicate, move, transition/skip properties
  and explicit deletion through durable labels. Slide content authoring is not
  part of this beta surface.
- Native Motion now includes bounded reads, timeline control, clear/style/add,
  presets, stagger and spec application. Prototype/Motion behavior that does
  not map losslessly remains an explicit runtime boundary.
- Gradient workflows now cover image extraction, editable paint application
  and mesh generation. Build verification accepts browser capture and fidelity
  ledger evidence for bounded Figma-to-browser acceptance.
- Export now includes owned Node JSON plus JPG, SVG, PDF, MP4, GIF and WebM
  publication, and remote image creation materializes one validated asset
  through the authenticated Plugin boundary.
- Size Variant generation now runs through one bounded, non-retrying Command
  Application for CLI and MCP. It creates exactly the requested Small, Medium
  and Large Components, verifies their hierarchy and geometry, and removes
  attributable clones when a postcondition fails.
- Component Combination generation now bounds the Cartesian product before
  mutation, supports a non-confirming dry run, verifies every requested
  property combination, and reports rollback residue instead of accepting a
  partial grid.
- Color Variable aliases with authored opacity now survive Variable Facts,
  portable Variable Snapshot capture and CSS/DTCG export as Figma's native
  `COMPOSE_COLOR(alias, opacityPercent)` value. DTCG retains Alias identity and
  opacity in the Bridge extension while standard consumers receive the
  alpha-composed color.
- The bundled Component Library workflow now starts with a leaf-to-root
  decomposition pass. It maps reusable primitives and descendant intent to
  nested Components plus TEXT, BOOLEAN, INSTANCE_SWAP, VARIANT and SLOT
  contracts before any top-level shell is accepted as complete.

### Changed

- CLI and MCP now converge on capability-gated immutable Command Plans for the
  new Design, FigJam and Slides workflows. Editor context, filesystem effects,
  confirmation, dispatch state and structured failure facts remain explicit at
  every boundary.
- MP4, GIF and WebM export now shares one long-running CLI/MCP Command
  Application. Requested settings, canonical Base64 and the matching media
  container are validated before the exact Workspace output is published.
- Three-way Token Sync now resolves one exact Collection, source and lockfile
  through the same closed Plan in CLI and MCP. Apply revalidates immediately
  before mutation, never retries after dispatch, freshly reports bounded
  residue and advances the lock only after complete verified success.
- Value replacement refuses before mutation when the prior mode contains a
  composed color Alias that Figma's public Plugin setter cannot restore.
  Snapshot import reports the same platform boundary instead of flattening or
  silently dropping Alias opacity.
- Scoped CSS/DTCG export resolves nested composed-Alias chains cumulatively,
  preserves deterministic alpha at 0 % and 100 %, and keeps authored opacity
  metadata on the Variable that actually declares it. Legacy DESIGN.md import
  now refuses this lossless-only value shape and points to Snapshot v2.

### Fixed

- Straight FigJam Connectors accept any valid native endpoint magnet after
  Figma canonicalizes the requested `AUTO` (observed as `CENTER`) while
  retaining exact endpoint node and shape verification.
- Slides Create waits for asynchronous publication into the native canvas
  grid, Duplicate treats two `NONE` transitions as semantically equivalent
  even when Figma rewrites irrelevant curve defaults, and Delete waits for
  renumbered native Slide name getters to stabilize.
- Slot create/read/configure accepts Figma's sparse native SLOT definitions,
  normalizes nullable optional fields, and verifies the complete effective
  default settings when Figma materializes them after a partial edit.
- Live Node JSON export now accepts Figma's official REST nodes response
  envelope, preserves its `document` plus component/style catalogs, and
  validates the requested node identity through `document.id/type`. The prior
  direct-node test double remains compatible.

## [0.7.3] — 2026-09-01

### Fixed

- Concurrent offline API-reference setup now publishes one fully written
  material with an atomic no-clobber commit. Losing processes reuse the winner
  instead of replacing its inode while another process may be reading it.
- Daemon deadline tests now tolerate bounded wall-clock rollback while keeping
  the actual Plugin socket timeout exact, and route WebSocket assertion errors
  through cleanup so one timing failure cannot contaminate later tests.

## [0.7.2] — 2026-09-01

### Changed

- Figma-importable adapters now always use the exact filename
  `manifest.json`: the tracked `plugin/manifest.json` is the released Design,
  FigJam and Slides adapter; Dev Mode installs below
  `dev-mode/manifest.json`; and source development generates a fully isolated,
  gitignored `plugin/local/manifest.json` bundle pinned to port 3460.

### Fixed

- Local-development Plugin profile tests now resolve repository URLs and
  compare manifest paths portably, so the Node 24 Windows release gate no
  longer mistakes an invalid working directory for a missing Node executable.

## [0.7.1] — 2026-09-01

### Added

- Every MCP failure now exposes one closed recovery context with `layer`,
  `kind`, optional `dispatchState`, and a payload-free `suggestion` in the
  Figma Bridge metadata namespace. The same layer/kind/dispatch facts are
  visible in error text, so agents can distinguish whitelist, validation,
  execution, and transport failures without parsing five unrelated dialects.
- `col delete --only-if-empty` provides an atomic cleanup path that refuses a
  populated Variable Collection before native removal. Collection deletion now
  also always requires an explicit MCP confirmation preview regardless of the
  global write-confirm setting; intentional deletion with contents remains
  available after confirmation.
- Component authoring now includes rollback-verified sublayer bindings for
  TEXT, BOOLEAN and INSTANCE_SWAP properties, explicit exposure of primary
  nested Instance properties and preferred values for INSTANCE_SWAP controls.
  Component Property reads cover all five native types, wiring state, Slot
  settings and limit violations, and nested exposure. A new offline Component
  authoring guide gives agents executable recipes and treats definition-only
  scalar properties as incomplete.
- Source checkouts can use `FIGMA_BRIDGE_PROFILE=local-development` to run a
  separately identified, checkout-owned `plugin/manifest.json` and fully
  isolated local state pinned to `localhost:3460`, without competing with a
  released Bridge used by another MCP client.
- Plugin Setup now explains that Figma stores pairing separately in Design,
  FigJam and Slides, and offers an explicit `Copy access key` action that
  copies only the stored in-use key without displaying or logging it.

### Fixed

- Released installs now keep the stable `Figma Bridge` identity and normal
  `3456–3460` daemon range even when copying the Plugin into persistent state
  fails. Package smoke coverage explicitly clears contributor profile state
  and rejects an accidental `Local Development` manifest in release artifacts.
- Starting an already paired MCP now wakes a Daemon that exited after its idle
  timeout. First-run profiles and intentionally stopped Daemons remain off,
  while bounded recovery guidance keeps agents from diagnosing a normal idle
  shutdown as an unknown transport failure.
- `figma_connect {forceRecovery:true,fileKey}` can now recover one exact
  authenticated Plugin UI after a timed-out compatibility execution leaves its
  execution lane quarantined while the independent health lane still answers.
  It bypasses that misleading health probe, refuses unknown files and defers
  while any Figma operation remains active.
- Component Property binding now compares the native reference map by field
  value instead of JavaScript key order. A layer can therefore retain multiple
  valid references such as `characters` plus `visible`, or `visible` plus
  `mainComponent`, even when Figma canonicalizes their order during writeback.
- Component authoring guidance now treats native Slot layout as a required
  follow-up to `slot create`: normalize the returned 100×100 freeform node to
  intentional Auto Layout and Fill/Hug sizing before inserting children.
  Validation guidance also states that `slot validate` checks limits and
  preference rules, not visual overlap.
- Top-level `figma_run --help` now comes from the MCP Capability Catalog and
  no longer advertises engine-only commands such as `connect`, `daemon`,
  `eval`, or `run`. Rejected `find`, `style consumers`, and `style apply`
  requests now project their typed parser errors into bounded, payload-free
  guidance, including the fact that MCP results are already structured JSON.
- `component add-variant --from` now restores and freshly verifies TEXT,
  BOOLEAN, INSTANCE_SWAP and SLOT sublayer references plus nested Instance
  exposure after Figma's native clone drops those fields. Component Property
  Facts also accept Figma's real SLOT definition shape when `defaultValue` is
  absent and normalize it to `null` instead of rejecting the entire read.
- Component Property Facts now use the typed read lane instead of the
  serialized eval/write lane, so an unknown prior write cannot quarantine the
  read needed to reconcile it. Semantic Render also bounds its foundation
  catalog preflight before any canvas mutation, preventing a stalled Variable
  or Text Style read from wedging later Bridge operations indefinitely.
- Component instances placed into Auto Layout parents now verify the native
  parent-owned position instead of rolling back a valid insertion for not
  retaining explicit `x`/`y`. MCP readiness probes are also bound to the exact
  planned Figma file and editor, and a bounded connect retry replaces a stale
  released Daemon that wins an upgrade race.
- Claude Code plugin installs and updates now fetch the pinned public release
  through an explicit HTTPS Git URL instead of allowing GitHub shorthand to
  select SSH and require machine-specific host-key setup. Startup guidance now
  distinguishes broken `asdf`/`nvm` Node resolution from an MCP handshake
  failure before the Bridge process begins.

## [0.7.0] — 2026-08-30

### Added

- Added bounded first-party Component workflows for creation, inventory,
  instantiation, variant creation and combination, Component Property
  discovery and mutation, instance swapping, detaching and override removal.
  Mutations preflight complete requests, verify native outcomes and report
  rollback residue instead of claiming atomic success after partial failure.
- Added batch Variable creation, metadata updates and per-mode value updates.
  Batches can intentionally populate previously empty modes, preserve exact
  Variable Alias identity and retain the prior values required for honest
  rollback reporting.
- Added exact CSS and DTCG token export with complete Collection modes,
  per-mode alias resolution and native EASING preservation.
- Added verified Node movement, deletion, duplication and Frame/Group-to-
  Component conversion with explicit targeting and fresh structural readback.
- Added authenticated one-shot asset transfer and cooperative background
  publication, allowing large exports to leave the Plugin without embedding
  unbounded binary payloads in command responses.
- Added host-side materialization of bounded remote render images, reusable
  Design Entity identity and a pre-write multi-screen component-reuse plan.

### Changed

- Semantic Code-to-Figma rendering now distinguishes intrinsic HUG text from
  responsive FILL text, retains centered FILL alignment, preserves authored
  line-height units and font weights, and keeps local and remote image
  references on one validated projection path.
- Render guidance is derived from executable contracts. Live-only evidence is
  reported as unavailable instead of being invented offline, and compound
  renders reject ambiguous union references before choosing a target.
- Exact Node Binding and Token Overlap reads use bounded typed dispatch outside
  the serialized write lane. Multi-roundtrip capture observes the target Page
  instead of loading the complete Document when document scope is unnecessary.
- Oversized Variable snapshots degrade to bounded summaries, while asset
  export publication releases large in-memory candidates cooperatively.
- Documented compatibility aliases now adapt to the same owned Command
  Applications as their canonical forms. Unreachable generic eval batching and
  shell-based Daemon listener helpers were removed without reducing the public
  workflows.

### Security

- Bridge-owned credentials, audit data, snapshots and runtime state now enforce
  native private-state permissions: exact POSIX modes on Unix and repaired,
  verified owner-only DACLs on Windows. Canonical path and symlink checks remain
  fail-closed.
- Legacy eval readiness is bound to its explicit Figma target, preventing a
  connected file from authorizing a command intended for another file.

### Fixed

- Release publication now passes the verified tarball as an explicit local
  file spec (`./release-artifact/package.tgz`), preventing npm from
  interpreting the workspace-relative path as a GitHub dependency.
- Plugin suspension and reconnect handling now distinguishes a sleeping UI
  from Daemon loss, preserves font-binding work and verifies responsiveness
  before declaring the Bridge ready.
- Variable creation preserves native defaults, compatible final metadata and
  exact aliases; local binding catalogs are preferred before bounded remote
  lookup, and typography bindings are verified after mutation.
- Screenshot export rejects zero-area and otherwise degenerate native output
  instead of presenting it as a usable asset.
- Windows cold-start and nested-Worker release tests now use bounded native
  host discovery and serial test-file scheduling without skipping behavior.
  Linux and macOS retain normal parallel scheduling.
- Tracked-job retention tests use a deterministic clock, removing a real-time
  boundary flake without changing production retention behavior.

### Performance

- Added a cold Page-revision budget measured against large-document scope and
  retained the complete MCP runtime soak gate. Page observation stays well
  below the accepted absolute and relative release thresholds.

## [0.6.1] — 2026-08-27

### Fixed

- Release artifacts now derive their canonical executable modes from the
  reviewed package policy instead of the host checkout. Tar paths, types,
  checksums and raw permissions are verified before normalization; unexpected
  executable or writable bits still fail closed, while the MCP server and
  Engine entry points install as `0755` on Windows, macOS and Linux.
- The package builder now normalizes the host-specific gzip header, records
  integrity for the exact normalized tarball it copies to the release output,
  and proves equivalent Windows/POSIX inputs produce byte-identical candidates.
- Cross-platform release tests now own their Daemon state, preserve LF source
  bytes, use native path semantics, invoke npm shell-free on Windows and avoid
  interpreting synthesized Windows permission bits as POSIX security evidence.
- Snapshot replacement checks now bind size and modification/change times in
  addition to filesystem identity, closing in-place replacement races on
  filesystems that reuse an inode. Token Sync failures set a nonzero process
  result without terminating an active transport before it can drain.

## [0.6.0] — 2026-08-26

### Added

- The bundled Figma-to-code skill now loads focused Modern CSS & HTML guidance
  for web targets. Semantic markup, progressive enhancement, accessibility,
  responsive evidence and performance practices remain subordinate to exact
  Figma facts and the target project's existing stack, so modern-platform
  preferences cannot silently redesign the source or invent breakpoints.
- Tool Discovery now has an explicit 16 KiB metadata ceiling with 4 KiB kept
  in reserve, plus a conservative estimated-token ceiling with 1,024 tokens
  reserved. Shared node/file schema fragments keep the client-visible 12-tool
  surface byte-stable while future metadata growth fails the offline gate
  before consuming its expansion headroom.
- Added a published, machine-verifiable upstream provenance manifest for the
  original figma-cli v2.1.0 engine lineage. Offline release tests pin the exact
  tag object and commit, validate every retained modified-derived source hash,
  keep README/NOTICE/contributor attribution counts synchronized, and confirm
  the unchanged upstream MIT license ships with the npm artifact.
- Added an append-only Plugin compatibility fingerprint covering the shipped
  Plugin, UI, protocol and generated runtimes. CI and prepublish now reject
  behavior changes unless the daemon build and UI handshake versions advance
  together; server-only changes remain outside that reload boundary.
- Explicit single-root `x`, `y` and disabled smart positioning now stay on the
  typed `render-plan` path and are applied inside the creation journal instead
  of spawning a Commander compatibility process plus follow-up eval.
- Browser DOM rendering now resolves same-origin project assets host-side under
  explicit WorkspaceIO authority. Bounded SVGs remain editable vectors,
  verified rasters are embedded as bytes, and cross-origin, active, mismatched
  or escaping assets fail before Figma mutation without widening Plugin network
  access. Authored `<br>` line breaks and available-width wrapping copy also
  retain their native Figma text-flow intent. Direct DOM text stays literal,
  intrinsic labels remain HUG, and border-box content width no longer shrinks
  native Auto Layout/Grid children.
- Added independent Figma compatibility gates for official Style union drift
  and live Publishable metadata drift. TypeChecker-derived discriminants must
  exactly match the Bridge contract; the content-free live probe recognizes
  only the reviewed missing Text Style `descriptionMarkdown` runtime gap and
  leaves absent subject kinds explicitly unsampled.
- Added versioned, content-free execution timing evidence across Command
  planning, authenticated Daemon preparation, per-document write-lane wait,
  Plugin round trip and Figma-main-thread queue/execution. A maintainer runtime
  corpus keeps first and warm samples distinct, reports bounded Application
  outcome/resource facts, and names still-unmeasured MCP/process segments
  instead of presenting a partial stopwatch as end-to-end proof.
- Routed `style consumers` through a separate long-budget, paginated Style
  Consumer Application. Results distinguish Figmas complete but
  non-interruptible native scan from bounded page completeness, preserve exact
  node/field identities, and expose query/type-bound continuation without
  returning an unbounded document-wide array.
- Routed `style list` through one compact bounded Style Catalog Application
  shared by Commander and MCP. Family-scoped reads load only the requested
  native catalog; stable identity rows now expose explicit totals, omissions,
  completeness and versioned scope-bound continuation instead of returning an
  unbounded authored-style dump.
- Routed `grid list` through one exact, versioned and bounded Layout Grid Facts
  Application shared by Commander and MCP. Node/selection targeting,
  `gridStyleId`, exact ROWS/COLUMNS/GRID topology, colors and Variable Aliases
  now cross one safe-read Plan, while Auto counts use the shared
  `{ "$figmaScalar": "Infinity" }` contract instead of silently becoming
  `null`.
- Routed `style show` through one exact, versioned and deeply bounded Style
  Facts Application shared by Commander and MCP. PAINT, TEXT, EFFECT and GRID
  unions now preserve publishable Markdown/documentation metadata, nested
  Variable Alias topology and tagged non-JSON numeric semantics without
  Commander re-entry, implicit URL targeting or plausible truncation.
- Routed `style publish-status` through one compact, versioned and bounded
  safe-read Application shared by Commander and MCP. It retains only resolved
  Style identity and Figma's official status union, supports optional family
  narrowing and no longer embeds raw GRID values that could coerce Auto
  `Infinity` to JSON `null`.
- Routed `component main` through one exact, versioned and deeply bounded
  Component Identity Facts Application shared by Commander and MCP. Semantic
  URL targeting, safe-read retry and one decreasing deadline now preserve main
  component/set keys, variants and property facts without Commander re-entry
  or name-based identity guesses.

- Routed `var show` through one exact, versioned and deeply bounded Variable
  Facts Application shared by Commander and MCP. Mode values, aliases, scopes,
  code syntax, collection identity and publish status now retain their official
  value shapes; ambiguous names and malformed or oversized results fail without
  guessing or truncation.
- Routed `prototype inspect` through one exact, versioned and deeply bounded
  Prototype Inspection Application shared by Commander and MCP. Semantic node
  targeting, safe-read retry, deadlines and safe JSON projection now preserve
  complete reaction facts or fail explicitly before presenting partial data.
- Routed top-level `find` through one closed, bounded Node Discovery Application
  shared by Commander and MCP. The current page loads before traversal;
  case-insensitive name queries, optional type filters and limits stay inert,
  while result and 100,000-node traversal bounds are reported truthfully.
- Routed `canvas page-create` and `canvas page-divider` through one closed,
  non-retrying Page Structure Application shared by Commander and MCP. Divider
  indexes now preflight before creation, and later-stage failures clean up the
  Command-created object or report possible residue truthfully. Optional names
  must retain Figma's native divider grammar instead of silently creating a
  normal page.
- Routed `canvas pages` and `canvas page` through one closed Page Navigation
  Application shared by Commander and MCP. Listing is bounded and safely
  retryable; switching is explicit and non-retrying, with deterministic
  id/name resolution, bounded ambiguity, result validation and control-safe
  text output without changing document content.
- Routed read-only `canvas info` and `canvas next` through one closed Canvas
  Awareness Application shared by Commander and MCP. Dynamic page loading,
  target, safe-read retry, deadline, finite gap validation and closed geometry
  projection now come from the same authentic Command Plan.
- Routed direct `node bindings` reads through one closed, versioned and bounded
  Node Binding Facts Application shared by Commander and MCP. Scalar aliases,
  array positions, component-property names and variable/collection/type
  identity now survive text and JSON projection without claiming the broader
  provenance owned by Design Capture.
- Routed native Figma Inspect `node css` reads through one closed, bounded
  Command Application shared by Commander and MCP. URL targeting, safe-read
  retry, deadlines, output format and malformed-result handling now come from
  the same authentic Command Plan.
- Added versioned Dispatch Receipts for every authenticated Plugin execution.
  Requests now bind one handshake-signed connection epoch, file or draft
  session, expected editor and operation capability through the terminal
  response; Audit and public errors expose only the closed dispatch state.
- Added bounded, deadline-aware Plugin Write Lanes per resolved document
  session. Same-file writes no longer dispatch concurrently, different files
  remain independent, and unknown outcomes stay quarantined across UI
  reconnect until the exact settlement receipt is replayed.
- Added one ownership-aware mutation journal for native single and batch
  Semantic Render. Complete requests preflight before real resource creation,
  removable Command artifacts roll back in reverse order, and closed bounded
  mutation reports distinguish no mutation, completed rollback, partial
  residue and successful completion without weakening unknown-dispatch rules.
- Added one closed, versioned Semantic Render Outcome shared by Commander,
  `figma_run` and `figma_render`. Deep byte, nesting, collection, string,
  numeric and handle bounds now reject malformed post-dispatch Plugin results;
  MCP structured content, text, JSON/YAML, Audit and process codes derive from
  the same root, structural, resource and rollback facts.
- Added one Compound Semantic Render Application for wrapper auto-split and
  explicit batch requests across Commander, `figma_run` and `figma_render`.
  Shared options and assets are prepared before readiness, native rendering
  dispatches one journaled batch, and conversion, resize and verification
  stages report bounded exact partial progress without recursive parsing or
  post-dispatch retry.

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

### Security

- Disabled four unsafe Legacy bulk-write modes before Commander or MCP can
  reach Plugin readiness: `var delete-all`, page-wide `tokens rebind --apply`,
  and `node set|bind --batch`. Exact deletion, single-node mutation,
  page-wide rebind dry-run and node-scoped rebind apply remain available while
  typed bounded preflight and rollback/residue contracts are built.

### Fixed

- Browser DOM capture now distinguishes intrinsic text containers from
  responsive available-width copy. Intrinsic auto-sized flow containers use
  native HUG, wrapping/stretch text uses FILL, and centered FILL text retains
  native Text alignment. CSS `align-items:stretch` is projected through child
  FILL sizing instead of an invalid Figma container enum.
- Existing-UI acceptance can now require persisted DOM-capture provenance,
  including the capture SHA-256 and viewport, so a hand-authored JSX render
  cannot silently replace a browser-derived baseline. `verify-build` also
  supports a bounded browser fidelity ledger that gates rare source facts and
  computed typography roles as matched, explicitly approved, or missing.
- Browser DOM capture now preserves cross-axis CSS auto margins with editable
  fill-sized Auto Layout wrappers, so `margin-inline:auto` and block-axis
  equivalents retain start/center/end relationships instead of frozen geometry.
- Hidden or zero-sized DOM children no longer corrupt measured flow gaps, and
  empty visual primitives remain semantic leaves instead of requiring Free
  Layout approval. This prevents oversized Figma content bounds from a leading
  `display:none` child while keeping bars, orbs and dividers easy to render.
- Figma-to-code guidance now requires a per-section source-fact ledger,
  computed typography-role verification and user approval before design
  normalization. Existing rendered UIs require DOM-capture provenance for the
  Code-to-Figma acceptance path.
- `component prop list` now derives read effects, no confirmation, safe-read
  retry and Audit facts from its complete canonical action id; its nested
  mutating siblings remain non-retrying writes and unknown actions fail closed.
- Legacy Commander Actions no longer print caught Plugin or validation errors
  and then exit successfully. Every user-visible top-level catch now retains a
  nonzero process outcome, while the shared reporter avoids hard process
  termination so reusable cleanup and Adapter lifecycles can complete.
- `node tree` now shares one bounded, Plan-owned read path between CLI and MCP.
  Options before a Figma URL preserve its target, depth zero is honored, and
  invalid requests or Plugin failures no longer appear as successful output.
- Numeric spacing and radius literals no longer make native Code-to-Figma fail
  when duplicate collections contain the same generated convenience-token
  name. Exact values remain unbound and visible in the Variable Report;
  explicit ambiguous `var:` references still fail closed.
- Native Text Style assignment now stays on Figma's asynchronous API whenever
  that API is available, so dynamic-page Plugins no longer fall through to a
  prohibited synchronous setter after an async rejection.
- Structural history now persists through one private bounded Snapshot Store.
  Normal `latest`, `previous`, index, filename-prefix, list, diff and changelog
  flows remain available, while host paths, namespace collisions, symlinks,
  changed inodes, timestamp overwrites and oversized/deep gzip JSON fail closed.
- `history snapshot`, `history list` and `history diff` now share one closed
  request Interface and value-returning Command Application across Commander,
  `figma_run` and `figma_history`. Changelog paths, targets, shared-state
  effects, deadlines and accepted diff outcomes come from the same Command
  Plan; JSON-only snapshot previews correctly declare no shared-state write.
- Structural history results expose reusable snapshot refs instead of private
  host paths or file-key namespaces.
- Top-level `inspect` now carries one authentic Command Plan through Commander,
  `figma_run` and `figma_inspect`. All three preserve the existing text, YAML,
  JSON and Spec formats while sharing closed node parsing, exact URL targeting,
  bounded readiness, one decreasing deadline and the same safe-read retry path.
- `export code-spec`, `figma_run` and each bounded `figma_spec` read now share
  one Plan-bound Code Spec Application. Selection/node targeting, phase, depth,
  section, hidden layers, format and deduplication are canonicalized before
  capture without removing MCP batching or lossless output-budget recovery.
- `verify`, `figma_screenshot` and Render verification now declare every PNG
  as a Plan-owned Verification Artifact before Figma dispatch. Default output
  stays automatic and readable in a private temporary directory, explicit
  workspace saves still work through Workspace I/O, and inline Base64 plans no
  host file. One-root Render verification now shares the compound Application.
- Verification results now read exact `pixelWidth` and `pixelHeight` evidence
  from the bounded PNG IHDR instead of predicting pixels from node geometry.
  Logical `nodeWidth`/`nodeHeight` and requested/applied scale remain separate;
  compatibility `width`/`height`/`scale` fields stay available with exact values.
- Plugin execution now rejects stale connections, wrong files and wrong
  editors before mutation. Reconnected UI results cannot settle newer work,
  multi-window metadata stays pinned to the connection selected at dispatch,
  and Design-only Semantic Render Plans stop in FigJam, Slides and Dev Mode.
- Queue expiry and HTTP cancellation before Plugin dispatch now produce a
  proven non-dispatch without reordering other callers. Read-after-write
  selection can explicitly wait behind prior writes without slowing ordinary
  inspection or changing existing Code-to-Figma/Figma-to-Code time budgets.

- Mixed-Figma-MCP sessions no longer leave Bridge results ambiguous. Every
  result carries the stable `figma-bridge-mcp` identity, every error states
  that its failure is server-local, and bundled workflows pin their calls to
  the `figma-bridge` namespace without silently switching write semantics.
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
  runs a mutual challenge-response handshake (proto 3): the daemon challenges
  with a random nonce, the plugin verifies that the challenge names the socket
  it actually opened, and answers with an HMAC over both nonces, that port, its
  version and its canonical capability list. The daemon proves itself back
  before the panel will accept a single command. This retires the residual risk
  earlier versions documented, where a process squatting a range port could
  read the raw key out of the plugin's first frame or relay capability claims.
- **The daemon must now authenticate to the plugin.** Previously the panel ran
  any `eval` it was sent, so impersonating the daemon needed no key at all.
- **Relay defence.** The plugin checks the challenge port against its actual
  socket, and the bound port plus canonical capability claim are part of the
  signed transcript. A squatter cannot transparently forward or elevate an
  older plugin's safety capabilities.
- There is no older-protocol fallback. After upgrading, run `figma_connect` and reopen
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
