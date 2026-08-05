# Changelog

Notable changes per release. Dates are release dates; the project follows
semantic versioning loosely while pre-1.0 (breaking changes bump the minor).

## [0.4.0] — unreleased

Breaking for existing pairings: after upgrading, run `figma_connect` and reopen
the plugin window. The panel will tell you if you forget.

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
  changes what a token *is worth*, this changes *which collection a design
  follows*.
- **`kit init`** — one command that makes an existing design system
  agent-ready: DESIGN.md, DTCG tokens, a component inventory with stable
  publish keys, and the Figma↔Storybook mapping. It orchestrates commands that
  already existed; what was missing was knowing which four to run and what the
  result means. The report ends with what is still missing, because a setup
  that quietly lacks the Storybook mapping looks finished until an agent needs
  it. This is the project's answer to bundled design systems — it stays neutral
  and makes *your* system legible instead.
- **Several Figma windows at once.** The daemon now keeps one connection per
  window in which the plugin was started, instead of letting the newest
  displace all others. With one window nothing changes; with several, a command
  must name its file (`--file <key>`, or `fileKey` on `figma_run`) and gets the
  list of connected files if it does not. There is no "all files" option —
  every write names one file, so a mistaken command cannot fan out across a
  library. Two windows on the *same* file still supersede each other. Audit
  entries carry the file key.
- **FigJam is back**, as the `jam` command group — stickies (single and
  batched), shapes, connectors, tables, sections, code blocks, a board readout
  and a grid arrange. It runs over the existing plugin bridge; the manifest
  gains `figjam` as an editor type and nothing else. Every snippet checks
  `figma.editorType` first, so running a board command in a design file says so
  instead of failing on an undefined API, and `figma_status` now reports the
  editor. Figma Slides remains unsupported.
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
  design does *not* protect against.
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
