# Security and transport — design decisions

Figma Bridge talks to Figma through one authenticated channel and treats every
other route, the filesystem, REST, remote origins, other processes, as a
boundary to defend rather than a convenience. The decisions below protect the
plugin connection, the workspace, and the operator's local state from being
widened, spoofed, or read by anything other than the Bridge itself.

## One authenticated transport

### Use a single plugin transport for every write

**Decision.** All Figma Commands run through the Bridge Daemon to the Figma
plugin over one authenticated transport operating in Safe Mode. The Bridge
does not add CDP, binary patching, or any second execution path.
**Why.** One transport keeps security, targeting, audit, and behavior in a
single implementation instead of scattered across parallel paths that could
each be attacked or drift independently.
**What it means for you.**

- Every command, from a read to a canvas mutation, crosses the same
  authenticated socket.
- There is no alternate low-level execution mode to fall back to when the
  plugin is unavailable.

<!-- source: 0001 -->

### Resolve a target before any legacy eval runs

**Decision.** Raw `eval` and its `run` file alias resolve the CLI target once,
before the daemon's readiness probe, and reuse the remaining deadline for the
following evaluation. Only the resolved file key and expected editor cross to
plugin dispatch.
**Why.** With several plugin windows open, a generic presence check could
accept an unrelated socket instead of proving that the intended Figma window
is responsive.
**What it means for you.**

- Raw evaluation is a CLI-only maintainer tool; it stays outside the MCP
  Capability Catalog and `figma_run`.
- With one window connected, an omitted target still works as before; with
  several, the Bridge refuses ambiguity instead of guessing.

<!-- source: 0113 -->

### Remove the dormant generic eval-batch protocol

**Decision.** The Bridge removes the unused `eval-batch` / `batch-result`
message pair from the plugin UI, plugin main thread, and daemon. An incoming
`batch-result` is now an unknown message instead of a dormant accepted one.
**Why.** No supported command could ever reach that protocol pair, so keeping
it made the authenticated surface look broader than the product and left an
unbounded generated-code execution shape without an owner.
**What it means for you.**

- Compound Semantic Render still runs through its own supported
  `render-plan-batch` operation with its own capability and Dispatch Receipt.
- Generated render compatibility remains available as one bounded `eval`
  request, never as the removed batch shape.

<!-- source: 0115 -->

## Dispatch receipts and write lanes

### Bind every plugin action to a signed Dispatch Receipt

**Decision.** Every authenticated plugin action carries one closed Dispatch
Receipt built by the daemon from the exact connection selected for the
target. The receipt binds a random request id, the handshake-signed
connection epoch, the file or draft identity, expected editor, and advertised
operation capability. The plugin validates it immediately before the
operation runs.
**Why.** Binding identity to the live connection, not just the file name,
stops a stale or reconnected session from settling work it never actually
performed.
**What it means for you.**

- A target, editor, capability, or stale-connection mismatch returns
  `not-dispatched`, never a false success.
- A reconnect creates a new epoch; a stale response cannot settle work owned
  by the new connection.

<!-- source: 0015 -->

### Serialize writes per target, keep an honest queue

**Decision.** Every mutation and compatibility eval enters one bounded,
in-memory lane keyed by its resolved Figma file. Writes for one target run in
order; other targets progress independently. A completed, refused, or
known-failed receipt releases the lane; a timeout, disconnect, or malformed
response quarantines it instead.
**Why.** An uncertain outcome must never be treated as safe to overwrite with
a second write, so the lane stays locked until independent proof shows the
earlier runtime actually stopped.
**What it means for you.**

- Reconnecting alone never clears a quarantined lane; a plugin restart is
  required before recovery.
- Queue summaries expose only aggregate active, queued, and quarantined
  counts, never file keys or receipt identities.

<!-- source: 0016 -->

### Never guess a mutation's outcome after dispatch

**Decision.** Every failed daemon execution returns one bounded, versioned
Bridge Daemon Error with a stable kind, phase, and outcome. `not-dispatched`
means the command never reached the plugin; `unknown-after-dispatch` covers a
timeout, disconnect, invalid response, or plugin-reported error that cannot
prove no document change occurred.
**Why.** A timeout is not proof of failure and a stale error string is not
proof of success, so retry policy must consume these facts rather than parse
user-facing prose.
**What it means for you.**

- A write with an unknown outcome is never retried automatically.
- Older clients still see a compatible `error` string alongside the new
  structured envelope.

<!-- source: 0014 -->

### Move safe reads off the mutation lane

**Decision.** An immutable Command Plan must classify an operation as
`typed-read` before it can bypass serialized plugin dispatch. The allowlist
covers Style Consumer, Node Binding Facts, Token Overlap Facts, and a
connection health probe; every other read, including compatibility eval,
stays on the conservative serialized path.
**Why.** Long native reads should not delay unrelated writes to the same file
merely because the legacy transport treated every read as an opaque write.
**What it means for you.**

- Typed reads run on a separately bounded read lane with its own queue limits
  and deadline.
- Commander and MCP prefer the typed read and fall back to the older eval
  only once, and only after a proven non-dispatch.

<!-- source: 0035 -->

### Tell plugin suspension apart from a dead daemon

**Decision.** The plugin keepalive measures daemon liveness only while its
own event loop is demonstrably running. When the interval itself resumes
late, the plugin grants exactly one fresh reply window and one new ping
before returning to the normal deadline, instead of declaring the socket
dead on wall-clock age alone.
**Why.** Figma can suspend plugin iframes during document work, and the
operating system can suspend both sides during sleep; a timer that ignores
its own drift would misreport a merely sleeping connection as lost.
**What it means for you.**

- This never marks a request completed, retries an operation, or releases a
  quarantined lane by itself.
- A genuine socket close still reports the existing unknown-outcome result
  for in-flight work.

<!-- source: 0082 -->

## Workspace and shared-state confinement

### Confine every path read or write to declared roots

**Decision.** The MCP launch directory is the automatic workspace root;
additional roots are explicitly additive through `FIGMA_BRIDGE_EXTRA_ROOTS`.
Security-sensitive reads and writes reopen paths through one Workspace I/O
module, validate the opened inode after symlink resolution, and only then
transfer bytes.
**Why.** Making paths absolute stopped a working-directory mismatch but not
traversal, absolute escapes, or a symlink that resolves outside the project;
a blanket ban on other projects would also break legitimate monorepo work.
**What it means for you.**

- Whole-file text and JSON default to an 8 MiB limit, binary to 64 MiB, with
  matching nesting and collection-entry bounds.
- Errors name a stable path role, never the rejected path itself; raw paths
  never reach the audit trail.

<!-- source: 0011 -->

### Parse Tailwind config as data, never as code

**Decision.** A static adapter parses Tailwind's `theme` and `theme.extend`
fields as literal objects, arrays, strings, numbers, booleans, or null, from
JS, CJS, MJS, or TS source. It never resolves imports or executes the file;
parsing runs in a worker with a one-second deadline and explicit memory
limits.
**Why.** Dynamically importing the whole config module ran arbitrary code in
the engine process; workspace confinement can limit which file is read, but
not what a running script can do once started.
**What it means for you.**

- Functions, references, calls, spreads, and template interpolation in token
  fields fail with a migration path toward Tailwind v4 CSS or W3C JSON.
- Unrelated fields such as `content` and `plugins` stay compatible because
  they are discarded unread.

<!-- source: 0012 -->

### Own structural history as private, not project, state

**Decision.** One Structural Snapshot Store owns a private shared-state root
and exposes only save, list, resolve, read, and directory operations. Reads
require an opaque descriptor created by that same store; a caller cannot
supply a host path or forge authority by copying descriptor fields.
**Why.** Local structural history carries Figma-authored names, text,
geometry, and component identities; treating it as a workspace artifact
would mix private design facts with project output and let old code follow
filesystem links into it.
**What it means for you.**

- New directories are created `0700` and new files `0600`, and an existing
  snapshot timestamp is never overwritten.
- `latest`, `previous`, bounded numeric indices, and unique filename prefixes
  remain the supported ways to select a snapshot.

<!-- source: 0021 -->

### Enforce real file permissions on every platform

**Decision.** One Private State Permissions module repairs and verifies
`0700` directories and `0600` files on macOS and Linux, and on Windows runs a
packaged PowerShell adapter that disables inheritance and grants Full
Control only to the current account, LocalSystem, and built-in
Administrators.
**Why.** POSIX mode bits already proved local privacy, but Node reports
synthesized Unix bits on Windows that do not reflect the actual inherited
permissions from the user profile.
**What it means for you.**

- Startup repairs legacy permissive state automatically before any
  credential is read.
- A timeout, bad exit code, or malformed report on Windows fails closed
  rather than trying a second host.

<!-- source: 0114 -->

## Remote access boundaries

### Keep REST optional, local, and narrowly allowlisted

**Decision.** REST-only features are explicit add-ons; a personal access
token enters through the authenticated plugin, is stored locally at mode
`0600`, and never appears in MCP configuration, chat, or audit output.
`src/figma-rest.js` allows only token health, version lists, version-pinned
document contents, comments, and published component metadata.
**Why.** The Bridge stays fully useful without a token, and a generic REST
passthrough would turn the Bridge into an open proxy for whatever endpoint a
caller names.
**What it means for you.**

- A current-file fetch without `version=` is refused; node contents,
  exports, images, variables, and all current-document mutations always use
  the plugin instead.
- Adding an endpoint needs a named capability, a structural reason the
  Plugin API cannot provide it, and a denial regression test.

<!-- source: 0003 -->

### Authorize and pin every remote Storybook origin

**Decision.** A Remote Storybook Policy authorizes exact origins before any
network access. `localhost`, `127.0.0.1`, and `[::1]` on port 6006 work
without configuration; other origins are added through
`FIGMA_BRIDGE_STORYBOOK_ORIGINS` or `FIGMA_BRIDGE_STORYBOOK_PRIVATE_ORIGINS`.
Every redirect is reauthorized and the connection is pinned to a validated,
scope-checked address.
**Why.** Bounding response size and JSON parsing still let a caller pick an
arbitrary HTTP(S) destination; without origin pinning the Bridge itself
becomes a host-network discovery tool.
**What it means for you.**

- Public origins must resolve to public addresses; link-local, metadata, and
  other reserved ranges are never accepted even for a configured private
  origin.
- Local directory Storybook imports are unaffected and keep going through
  Workspace I/O.

<!-- source: 0013 -->

## Local-development isolation

### Give the contributor build its own profile

**Decision.** `FIGMA_BRIDGE_PROFILE=local-development` stores all Bridge
state under a distinct profile directory, pins daemon discovery to port
3460, and pairs with a generated, gitignored local plugin manifest carrying
its own plugin id and name.
**Why.** A released MCP server and a source checkout previously shared PID,
port, session token, and plugin paths, so the Figma plugin's parallel port
scan could let the wrong daemon capture a connection.
**What it means for you.**

- Run `figma_connect` with the profile, or `npm run prepare:plugin-imports`,
  then import `plugin/local/manifest.json` once from the active checkout.
- The tracked `plugin/manifest.json` always stays Figma's directly
  importable released identity; the local profile never reuses its pairing
  key.

<!-- source: 0121 -->
