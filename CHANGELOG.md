# Changelog

Notable changes per release. Dates are release dates; the project follows
semantic versioning loosely while pre-1.0 (breaking changes bump the minor).

## [0.4.0] — unreleased

Breaking for existing pairings: after upgrading, run `figma_connect` and reopen
the plugin window. The panel will tell you if you forget.

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
