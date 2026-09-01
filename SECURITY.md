# Security

figma-bridge-mcp gives an AI agent write access to a live Figma document. This
document says what that means, what protects it, and — just as importantly —
what it does _not_ protect against.

Everything here is checkable against the source: the daemon is
`engine/src/daemon.js`, the handshake is `engine/src/lib/plugin-handshake.js`,
the request signing is `engine/src/lib/daemon-auth.js`, the command allowlist is
`src/engine.js`, and the write gate is `src/server.js`.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/KaiUweHella/figma-bridge-mcp/security/advisories/new)
on GitHub. Please do not open a public issue for a vulnerability. Include steps
to reproduce and what an attacker gains.

This is a single-maintainer project — treat response times accordingly, and say
in the report if you have a disclosure deadline in mind.

## Threat model

The primary runtime attacker is a process or browser origin that can reach
loopback but **cannot** read Figma Bridge's private state: for example a port
squatter, an untrusted local web page, a different OS user, or a sandboxed
extension. MCP arguments, agent-generated commands, workspace files, imported
design data, Figma-authored strings, and stale Plugins are also untrusted input.

Arbitrary code already running as the same OS user with permission to read and
replace Bridge files is a full host compromise, not a boundary HMAC or `0600`
permissions can contain. Compromised dependencies are therefore addressed at
the install/release boundary; after malicious dependency code runs as you, it
has the same power as that host compromise. A malicious Figma application,
account, or service is also outside this model.

That framing matters because "it only listens on localhost" is not an access
control on a developer machine. Every one of those processes runs as you.

### What the design guarantees

**The Figma application is never modified.** No binary patching, no `app.asar`
rewrite, no re-signing, no Chrome DevTools Protocol. The upstream project's Yolo
mode was removed from the fork rather than disabled — there is no code path to
it, and `connect` is absent from the command allowlist so Safe Mode cannot be
switched off through the MCP layer.

**Bridge authentication secrets are never transmitted.** Two separate
credentials protect two separate channels, and neither crosses the wire:

| Channel                      | Credential              | How it is used                                                                                                                              |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP (`/health`, `/exec`, …) | session token, 0600     | per-request HMAC over timestamp, nonce, method, path and body-hash; the daemon keeps a nonce cache, so captured headers cannot be replayed  |
| WebSocket (`/plugin`)        | plugin access key, 0600 | mutual challenge-response; both sides prove possession by HMAC over both nonces, the bound port, plugin version and daemon connection epoch |

A process that binds a port in 3456–3460 before the daemon and records
everything learns no reusable secret. Because the bound **port** is inside the
handshake transcript, it cannot relay to the real daemon either: the plugin
signs the port it reached, the daemon verifies the port it bound, and a relay
across two ports fails to verify.

**The daemon must prove itself too.** The plugin panel rejects every command —
`eval`, batches, even a keepalive reply — until the daemon's ack verifies under
the access key. Without this, anything answering on a local port could drive
your document without knowing the key at all. The ack also signs a new random
connection epoch used by every Dispatch Receipt.

**The plugin cannot reach external network domains.** `plugin/manifest.json`
restricts `networkAccess.allowedDomains` to the exact HTTP/WebSocket localhost
ports 3456–3460. Approved remote image sources are fetched and verified by the
host under the bounded image-origin policy; the plugin receives embedded bytes
and uses `createImage`, never the source URL or `createImageAsync`. Figma still
blocks Plugin-side remote URLs rather than letting them become an exfiltration
route. The manifest regression tests fail if a non-loopback entry is added. See
Figma's
[manifest network policy](https://developers.figma.com/docs/plugins/manifest/).

**Live document mutation reaches only files you opened yourself.** The bridge
holds one connection per Figma window in which _you_ started the plugin — the
consent is physical, not configured. With several connected, a command must
name its target; there is no "all files" switch and no fan-out, so one mistaken
command cannot sweep a library. Every authenticated action also carries a
Dispatch Receipt bound to the signed connection epoch, selected file or draft
session, expected editor and operation capability. The Plugin validates it
immediately before execution; stale connections and target/editor mismatches
return `not-dispatched` without mutation. The optional REST add-on can explicitly read
allowed metadata/history from another named file, but the REST API cannot write
its document content.

**Plugin writes do not interleave within one document session.** The Bridge
Daemon resolves one target before placing every current execution action in its
deadline-aware Plugin Write Lane. Different documents remain independent.
Queue expiry and cancellation before start cannot reach the Plugin. Timeout,
disconnect or malformed terminal evidence quarantines only the affected target
until an exact `lane-settled` Dispatch Receipt proves that the uncancellable
Plugin operation stopped. UI reconnect can replay that proof; reconnect alone
cannot clear quarantine. Health exposes only aggregate lane counts.

**No shell, and a fixed command surface.** The engine is spawned with
`execFile` (`shell: false`). `figma_run` accepts only allowlisted first tokens.

**Unsafe Legacy bulk mutations fail closed without removing scoped utility.**
`var delete-all`, page-wide `tokens rebind --apply`, and `node set|bind --batch`
stop before Bridge readiness or Plugin dispatch. Exact variable/collection
deletion, single-node set/bind, page-wide rebind dry-run and node-scoped rebind
apply remain available. A blocked mode returns only as a typed bounded Command
Application with complete preflight and truthful rollback/residue evidence.

**Execution failure policy is structured.** Every failed Daemon execution
returns a bounded, versioned Bridge Daemon Error naming its kind, phase and
whether it was not dispatched or has an unknown outcome after Plugin dispatch.
Retry and recovery consume those facts rather than matching user-facing text;
writes with an unknown outcome never retry. A legacy error string remains
alongside the envelope during upgrades, and new clients accept an older
string-only Daemon through one 16 KiB compatibility Adapter.

**Workspace reach is explicit and bounded.** The MCP launch directory is the
automatic root; additional repositories require `FIGMA_BRIDGE_EXTRA_ROOTS`.
Command Capability paths are checked after symlink resolution by one Workspace
I/O module. Critical reads and writes validate the opened inode before moving
bytes, so swapping an accepted output parent for an external symlink is detected
before content is written. Whole-file JSON/text defaults are limited to 8 MiB,
binary inputs to 64 MiB, structured nesting to 64 levels, collections to
100,000 entries and YAML aliases to 50. Format-specific image/icon limits are
smaller. One JPG, SVG or PDF compatibility export is bounded below the generic
5 MiB Plugin envelope and must have canonical Base64 plus the requested
container before any Workspace write. Rejections name only the path role;
absolute paths remain out of MCP errors and the Audit Trail.

**Large asset transport is closed, authenticated and one-shot.** Asset Export
does not raise the generic 5 MiB JSON limit. The Plugin hashes one bounded image
or SVG cooperatively and sends ordered 256 KiB chunks only after Daemon
acknowledgement. The Daemon verifies canonical encoding, sequence, declared
length and SHA-256 into a `0600` transfer under a `0700` directory. Exactly one
separately signed loopback GET may consume it, and the client verifies length
and digest again before its publication Worker stages the bytes. Disconnect,
timeout, malformed input, expiry, shutdown and restart remove recognized
residue. Chunks never enter the Audit Trail, and Plugin network permissions are
unchanged.

**Structural history is bounded private shared state.** Local snapshots remain
outside the project workspace so normal history needs no repository write.
Their exact store owns collision-resistant per-file namespaces, `0700`
directories and `0600` files. Only opaque refs produced by that store can be
read; absolute paths, traversal, separators, ambiguous prefixes, symlink
leaves and changed inodes fail closed. Listing, compressed bytes, expanded
JSON, nesting and collection size are bounded before a value reaches diffing.
Errors do not expose the store root or Figma file key.

**Tailwind configuration is data, never host code.** The Static Tailwind
Configuration Adapter reads at most 1 MiB and recognizes bounded static
JS/CJS/MJS/TS object forms without resolving imports or executing plugins,
functions or expressions. It materializes only token-bearing `theme` and
`theme.extend` facts; unrelated configuration remains compatible but is
discarded. Parsing runs in a worker limited to 1 second, 32 MiB old-generation
heap, 8 MiB young-generation heap, 16 MiB code range and 2 MiB stack, with a
64-level/20,000-entry structural policy. Dynamic theme values fail with an
actionable Tailwind CSS or W3C JSON migration path.

**Remote Storybook is an exact, DNS-pinned capability.** The conventional
localhost origins on port 6006 work without configuration. Every other public
or private origin must be configured explicitly; public origins require HTTPS.
Credentials, unapproved redirects, link-local and reserved destinations fail
before response data is retained. All resolved addresses are validated and the
connection is pinned to one of them while preserving the approved Host and TLS
identity. Connect, header, body and total deadlines plus header and body byte
limits bound the read. Local Storybook directories remain workspace reads.

**Commands are interruptible and have a private, redacted Audit Trail.** The
plugin panel shows commands live, **Pause** rejects incoming agent commands
until resumed, and **Save version** writes a named restore point into Figma's
own version history. Audit records use a closed, versioned schema and private
`0700` directory/`0600` file permissions. They retain capability, read/write
classification, redacted target/data summaries, outcome, and duration — never
raw argv, JSX, labels, paths, file keys, REST bodies, credentials, or error
messages. A terminal Dispatch Receipt contributes only its closed state, never
its request, connection or document identity. Logging remains availability-safe: a storage failure does not block
normal Figma work, but every MCP result carries a visible warning and structured
degraded state until a complete audit lifecycle succeeds.

**Private local state has platform-native access-control evidence.** On macOS
and Linux, every Bridge-owned directory is verified as `0700` and every file as
`0600`. On Windows, Figma Bridge does not treat Node's synthesized Unix mode
bits as proof: one bounded argument-array PowerShell Adapter protects and
repairs the exact `~/.figma-bridge-mcp` DACL recursively, then verifies Full
Control for only the current account, LocalSystem and built-in Administrators.
The Adapter prefers PowerShell 7 when installed and falls back to the built-in
Windows PowerShell only when PowerShell 7 is absent; a timeout or other possibly
dispatched failure is never replayed automatically.
The same policy covers Command-owned Verification Artifact directories.
Reparse points fail closed; no profile parent, general temporary directory or
Workspace output is rewritten. A correctly configured profile needs no prompt
or setup step. Administrators, LocalSystem and arbitrary code already running
as the current account remain host-compromise principals outside this boundary.

**Optional REST is genuinely optional.** Without a token the code path is inert.
With one, the token is pasted into the plugin window (never into chat, never
into MCP client config), travels over the authenticated socket, and is stored 0600. It is never echoed back by any tool and never written to the Audit Trail.
REST records name only the allowlisted endpoint capability and read/write class;
path, file key, query, headers, and body are not retained raw.

**REST is closed by method and path.** The internal client accepts only token
health, version lists, version-pinned document contents, comments, and
published-component metadata. It is not a generic fetch primitive. Current
file contents, node JSON, CSS, exports, variables, styles, Dev Resources and
known-key asset imports are rejected before token lookup and must use the
authenticated local Plugin API transport.

**The published package is built as a reviewed artifact, not an implicit
repack.** The release gate compares every packed path to an exact allowlist,
rejects unreviewed executable bits and symbolic links, and requires two clean
`npm pack` runs to produce byte-identical tarballs. It records the tarball's
SHA-256/npm SHA-512 plus a canonical inventory digest, then installs that exact
tarball into a fresh prefix and exercises MCP initialization, pairing,
authenticated daemon startup, status, and cleanup using generated scratch
credentials. The fresh install's exact production graph, registry origins, and
SHA-512 integrities are retained as sanitized dependency evidence; production
dependencies with install lifecycle scripts fail the gate. The release
workflow publishes those already-tested bytes. Third-party Actions are pinned
to commit hashes; CI installs dependencies with lifecycle scripts disabled.
The installed-package job runs with engine enforcement on the declared Node 18
floor, so a root-only override cannot hide a Node-incompatible consumer graph.
The default Public-Safety gate reads the same closed artifact policy as the
package verifier, so an allowlisted Runtime file is scanned even before it is
tracked by Git. Ignored private maintainer material remains outside that
projection, and unexpected tar paths fail without becoming filesystem reads.

The runtime dependency audit blocks CI and release. Development-only
advisories remain visible for triage but are not an automatic release failure:
they become blocking when they affect a tool actually executed by the build or
release path. This avoids treating non-shipped noise like user exposure while
still keeping supply-chain findings visible.

### What it does not protect against

Stated plainly, because a security document that only lists strengths is
marketing:

- **Arbitrary code still reaches your document.** `figma_render` and several
  `figma_run` commands evaluate code in Figma's plugin sandbox. That is the
  product. The sandbox protects your filesystem and network; it does not protect
  the _document_. What the allowlist, the Audit Trail and Pause buy you is that
  the writes are bounded, visible and stoppable — not that they are impossible.
- **An agent that has been prompt-injected can still act.** If untrusted content
  reaches your agent's context, it can ask for destructive edits, and they will
  appear as redacted capability events. Set `FIGMA_WRITE_CONFIRM=1` to require an
  explicit `confirm:true` on every mutation, and use **Save version** before
  long unattended runs.
- **A local attacker with your file permissions has already won.** The 0600
  files are readable by any process running as you. The handshake defends
  against a process that _cannot_ read them (a port squatter); it cannot defend
  against one that can.
- **Structured Render rollback is ownership-bounded, not a version restore.**
  The native executor removes Command-created nodes, variables, collections
  and Text Styles when their Figma APIs expose a safe inverse. Image hashes
  have no removal API, and any failed cleanup is reported as bounded
  `partial-residue`. Plugins still cannot restore a document version; recovery
  from unrelated or outcome-unknown writes goes through Figma's version-history
  panel, which is why the panel offers a one-click restore point.
- **Compound Render stages do not imply transactionality.** Auto-split and
  explicit batch share one closed request and one native mutation journal, but
  component conversion and verification use later Figma operations. Their
  bounded stage evidence reports exact known handles and residue; an uncertain
  or failed post-dispatch stage is never retried as another render.
- **A Figma personal access token is coarse.** If you opt into the REST add-on,
  the token can read every file its account can access, not just the open one.
  Grant the minimum scopes: File content (read), File versions (read), Comments
  (read/write).
- **An explicitly private Storybook origin is intentional network reach.** If
  you add an origin to `FIGMA_BRIDGE_STORYBOOK_PRIVATE_ORIGINS`, the Bridge may
  read that exact private or loopback service. Link-local, metadata, multicast,
  unspecified and reserved destinations remain blocked.

## Data handling

No telemetry, no analytics, no crash reporting, no accounts. Nothing is sent
anywhere except: `api.figma.com` if and only if you enable the REST add-on, and
an explicitly approved Storybook origin when you run `map storybook` or a
matching import. A local Storybook directory never becomes a network request.
`api setup` performs no network access: it validates the exact official
`@figma/plugin-typings` dependency and atomically projects it into private
Bridge state.

Local state lives under `~/.figma-bridge-mcp/`: session token, plugin access
key, optional REST token, daemon pid and port, the bounded official API
reference, and the private Audit Trail (rotated at 5 MB, one previous
generation kept). POSIX stores sensitive files as `0600` below `0700`
directories; Windows enforces the equivalent closed DACL described above.
Active Asset Export may also create short-lived private one-shot transfer files
there; verified consumption, failure, expiry, shutdown and startup remove them.
Existing legacy audit lines remain readable only inside those two bounded
generations.

## Verifying a build

```bash
npm test    # includes the handshake, daemon auth, write gate and manifest checks
npm run build:package-artifact -- --output-dir release-artifact
```

Public security claims map to the following executable evidence. The
`tests/security-doc.test.js` contract fails if an evidence name stops resolving
to the named regression test.

| Evidence               | Claim                                                                                                                                                                                                                                                                                                                                                                  | Regression test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-HTTP-AUTH`        | Request signatures bind freshness, nonce, method, path, and exact body; replay, malformed headers, and tampering fail.                                                                                                                                                                                                                                                 | `tests/daemon-auth.test.js` — `replayed signed headers are rejected`, `signature is bound to method and path`, `signature is bound to the exact body`, `request authentication rejects an adversarial header corpus without throwing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SEC-PLUGIN-AUTH`      | Plugin and daemon mutually prove the current key; role, version, nonce, and port relay changes fail.                                                                                                                                                                                                                                                                   | `tests/daemon-auth.test.js` — `WS challenge-response authenticates and the daemon proves itself back`, `a proof for a DIFFERENT port is rejected`; `tests/plugin-handshake.test.js` — `plugin HMAC matches on random inputs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SEC-LOOPBACK`         | Listeners, Host/Origin policy, and discovery remain local and non-sensitive.                                                                                                                                                                                                                                                                                           | `tests/daemon-auth.test.js` — `HTTP /plugin-ready exposes only a CORS-scoped, non-sensitive discovery beacon`, `WS with a disallowed browser Origin is rejected`; `tests/plugin-sync.test.js` — `the manifest permits every port in the range and nothing beyond loopback`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SEC-PAYLOAD`          | HTTP, WebSocket, handshake, results, errors, metadata, selections, and batches are bounded.                                                                                                                                                                                                                                                                            | `tests/daemon-auth.test.js` — `oversized chunked HTTP /exec is rejected`, `oversized WebSocket messages close`; `engine/tests/protocol-contract.test.js` — `plugin result, error, metadata, batch, token and selection payloads are bounded`; `engine/tests/daemon-client.test.js` — `legacy daemon error bodies are bounded before they become client messages`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SEC-ASSET-STREAM`     | Large Asset Export bytes use one authenticated bounded operation, ordered acknowledged chunks, independent length/digest verification, private one-shot temporary storage and deterministic success/failure/disconnect/restart cleanup without raising the generic JSON limit or widening Plugin network access.                                                       | `tests/daemon-auth.test.js` — `authenticated Asset Stream carries bytes above the JSON ceiling with backpressure and no residue`, `malformed Asset Stream order fails integrity and removes its private partial file`, `Plugin disconnect during Asset Stream removes its private partial file`; `engine/tests/asset-transfer-store.test.js` — `a completed asset transfer verifies sequence, length and digest before one-shot consumption`, `private permissions and restart cleanup retain no recognised transfer bytes`; `engine/tests/daemon-client.test.js` — `daemon client rejects a truncated or digest-mismatched Asset Stream`                                                                                                                                                                                                                                                               |
| `SEC-IMAGE-EXPORT`     | JPG, SVG and PDF compatibility exports share one Plan-bound Application, stay below the generic Plugin envelope, accept only bounded canonical Base64 with the requested complete container, and publish no Workspace bytes before validation.                                                                                                                             | `engine/tests/image-export-command.test.js` — `JPG, SVG and PDF use one Plan-bound Image Export Application for CLI and MCP`, `format bytes and Plugin evidence are validated before Workspace publication`, `SVG and PDF require complete bounded containers before publication`, `Image Export leaves bounded envelope room inside the Plugin transport`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SEC-NODE-JSON`        | Live JSON_REST_V1 export shares one Plan-bound safe-read Application, stays below the generic Plugin result envelope, accepts only the requested bounded plain JSON graph, and publishes no Workspace bytes before complete structural validation.                                                                                                                         | `engine/tests/node-json-export-command.test.js` — `CLI and MCP use one safe-read Plan-bound Node JSON Export Application`, `malformed or unbounded Plugin facts fail before Workspace publication`, `Node JSON Export leaves bounded room inside the generic Plugin result transport`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SEC-SIZE-VARIANTS`    | Size Variants shares one non-retrying Plan-bound Application across CLI and MCP, preflights before cloning, freshly verifies exactly three generated Components, and exposes proven rollback or bounded residue when a later write fails.                                                                                                                              | `engine/tests/size-variants-command.test.js` — `component source creates and freshly verifies exactly three scaled Components`, `failed postcondition removes every owned clone and reports rolled-back`, `failed cleanup reports bounded partial residue without retry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SEC-COMPONENT-COMBINATIONS` | Component Combinations shares one bounded non-retrying Application across CLI and MCP, refuses excessive Cartesian products before mutation, requires a complete freshly verified grid, and exposes proven rollback or bounded residue. | `engine/tests/component-combinations-command.test.js` — `dry run returns bounded facts without creating nodes`, `write creates every combination and freshly verifies the labeled grid`, `a failed combination removes labels and every intermediate node` |
| `SEC-TARGET`           | One Command Plan preserves one immutable Figma Target Context through confirmation, audit, job identity and execution; only closed semantic node fields may derive URL targets, payload URLs cannot retarget, conflicting node URLs stop, and ambiguous windows never fall back to an active file.                                                                     | `tests/daemon-auth.test.js` — `with several windows, /exec must name a file`; `tests/figma-target.test.js` — `Figma Target Context resolves precedence once and stays immutable`, `registry targeting is lazy and stays below explicit and URL-derived targets`; `tests/capability-catalog.test.js` — `one Command Plan resolves its Figma Target Context after path normalization`, `every exposed command root owns a closed URL target projection`, `only semantic node fields may derive a Figma URL target`, `conflicting semantic node URLs stop before one target is selected`; `tests/command-application.test.js` — `a pre-resolved Command Plan preserves its registry target through the Command Application`; `tests/mcp-layer.test.js` — `figma_run creates one registry-targeted plan for Link and Contract execution`, `asset background jobs include the target file in their identity` |
| `SEC-COMMAND`          | Unknown command groups are denied and all unknown actions receive conservative write policy.                                                                                                                                                                                                                                                                           | `tests/capability-catalog.test.js` — `catalog denies and gates unknown commands with safe defaults`; `tests/write-gate.test.js` — `unknown command GROUPS default to WRITE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SEC-BULK-GATES`       | Unsafe Legacy bulk mutations stop in both Capability admission and Commander before readiness or Plugin dispatch, while exact and scoped alternatives remain available.                                                                                                                                                                                                | `tests/high-risk-command-gates.test.js` — `high-risk legacy write modes are denied by policy with static alternatives`, `direct Commander gates fail before connection or Plugin dispatch`, `Source MCP returns the same actionable denial before readiness`, `safe adjacent utility remains available and literal payload cannot trigger a gate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SEC-NO-SHELL`         | Agent strings stay argv data and do not select a shell command.                                                                                                                                                                                                                                                                                                        | `tests/security-doc.test.js` — `engine execution stays argv-only without a shell`; `tests/error-projection.test.js` — `child-process projection never exposes the internal command line or argv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SEC-NO-WRITE-RETRY`   | Bridge Daemon Errors carry stable kind, phase and not-dispatched/unknown-after-dispatch outcomes; user-facing prose never authorizes retry, writes with unknown outcomes never retry, and only classified safe reads can retry inside one deadline.                                                                                                                    | `tests/daemon-auth.test.js` — `HTTP /exec reports a missing Plugin before dispatch`, `/exec reports Plugin timeout as outcome unknown after dispatch`, `/exec keeps domain token failures as execution errors after Plugin dispatch`; `engine/tests/daemon-client.test.js` — `daemon client trusts structured execution facts instead of domain prose`, `legacy string-only daemon errors stay compatible without token substring auth inference`; `engine/tests/daemon-error-envelope.test.js` — `compatibility redispatch requires a capability rejection before dispatch`; `tests/command-application.test.js` — `in-process mutation never repeats an outcome-unknown daemon failure`, `safe-read retries share one decreasing deadline budget`; `engine/tests/safe-read-retry.test.js` — `transient classifier recognizes normalized plugin and daemon failures`                                   |
| `SEC-REST`             | REST is opt-in, closed by canonical method/path before token lookup, and does not retain token, path, file key, or body in its Audit Trail projection.                                                                                                                                                                                                                 | `tests/rest.test.js` — `closed REST allowlist permits only named metadata/history endpoints`, `REST allowlist fails closed on URL canonicalization attacks before token lookup`, `REST audit uses endpoint capabilities and never retains token, path, file key, or body`; `tests/rest-token-daemon.test.js` — `unauthenticated socket cannot plant a REST token`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SEC-AUDIT`            | Audit records are private and redacted; bounded legacy history remains readable; storage failure is visible without blocking normal MCP utility.                                                                                                                                                                                                                       | `tests/audit-trail.test.js` — `Audit Trail stores a closed redacted schema with private permissions`, `Audit Trail failure is explicit and non-blocking, then clears after recovery`, `Audit Trail keeps one bounded private rotation`; `tests/audit-degraded-mcp.test.js` — `MCP command utility survives degraded audit storage and reports recovery`; `tests/history.test.js` — `versioned audit history filters by redacted node digest without storing the node id`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SEC-PRIVATE-STATE`    | Exact Bridge-owned Shared State and Verification Artifact trees are recursively repaired and verified with `0700`/`0600` on POSIX or a protected Windows DACL limited to the current account, LocalSystem and built-in Administrators. Traversal is bounded; links and broad non-owned roots fail before repair.                                                       | `engine/tests/private-state-permissions.test.js` — `Windows ACL Adapter uses a bounded argument array and returns direct evidence`, `Windows directly rejects a permissive DACL and repairs it idempotently`, `POSIX privacy repair is recursive, idempotent and directly verifiable`, `POSIX privacy preflight rejects links before changing the tree`, `private-state policy rejects broad roots and unowned artifact names`; `engine/tests/screenshot-command.test.js` — `default screenshot persistence is an exact private Plan artifact`                                                                                                                                                                                                                                                                                                                                                          |
| `SEC-PLUGIN-NETWORK`   | The Plugin manifest permits only the bounded localhost Bridge ports.                                                                                                                                                                                                                                                                                                   | `tests/plugin-sync.test.js` — `the manifest permits every port in the range and nothing beyond loopback`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SEC-LINK-PATH`        | Design Link source paths reject lexical project escapes, sibling-prefix tricks, null bytes, and non-text input; their actual reads also cross the shared Workspace I/O boundary.                                                                                                                                                                                       | `engine/tests/design-link-registry.test.js` — `repository path boundary rejects traversal, sibling-prefix and null-byte attacks`; `tests/workspace-io.test.js` — `workspace I/O rejects absolute and symlink escapes but permits contained symlinks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SEC-SNAPSHOT-STORE`   | Structural history stays in one private per-file namespace; only Store-owned refs can be read, while host paths, traversal, ambiguous prefixes, symlinks, inode changes, oversized gzip/JSON, deep structures and timestamp collisions fail closed without removing normal local history.                                                                              | `engine/tests/doc-diff.test.js` — `the store saves, lists, reads back and resolves refs`, `the store prunes to the keep limit but never the newest`, `a file key from Figma cannot escape the snapshot directory`, `the store rejects host paths, traversal, ambiguous refs and symlink leaves`, `the store rejects a symlinked snapshot namespace before publication`, `the store bounds compressed and expanded bytes before JSON parsing`, `snapshot publication never overwrites an existing timestamp collision`, `snapshot reads require an owned unchanged descriptor and redact host failures`; `engine/tests/cli-conventions.test.js` — `history delegates private structural persistence to the Snapshot Store`                                                                                                                                                                               |
| `SEC-WORKSPACE`        | Command file effects stay inside the launch workspace or explicit extra roots; symlink/traversal escapes, output-parent races and oversized/deep/alias-amplified inputs fail without exposing rejected paths.                                                                                                                                                          | `tests/workspace-io.test.js` — `workspace I/O accepts the launch project and explicit extra roots only`, `workspace I/O rejects absolute and symlink escapes but permits contained symlinks`, `secure output detects a parent swap before bytes can escape`, `whole-file reads enforce byte limits before retaining content`, `bounded structured parsers reject deep JSON and YAML alias amplification`, `Command Capabilities enforce roles without disclosing rejected absolute paths`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SEC-STATIC-TAILWIND`  | Tailwind JS/CJS/MJS/TS files are parsed as bounded static data; imports, plugins and expressions receive no host environment, filesystem, process or network execution, while ordinary static token configurations remain usable.                                                                                                                                      | `engine/tests/code-import.test.js` — `tailwind: static ESM and TypeScript configs import without resolving their imports`, `tailwind: semicolon-free imports and an exported typed const remain static data`, `tailwind: ignored plugin code never receives host environment, file, process, or network access`, `tailwind: executable theme values fail with a data-export migration path`, `tailwind: source, nesting, collection, time, and memory policies are explicit`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SEC-REMOTE-STORYBOOK` | Remote Storybook reads require an exact origin capability, validate and pin every resolved destination, revalidate redirects, ignore proxy environment configuration, enforce response and time limits, and expose no supplied URL through audit projections.                                                                                                          | `engine/tests/storybook-remote.test.js` — `remote Storybook policy keeps conventional localhost zero-config and canonicalizes numeric aliases`, `remote Storybook rejects public-origin DNS rebinding and always-forbidden network ranges`, `remote Storybook pins the validated address and ignores proxy environment variables`, `remote Storybook revalidates every redirect and never contacts an unapproved target`, `remote Storybook enforces connect, header, body, and total deadlines`, `local Storybook directory imports keep working through Workspace I/O`; `tests/capability-catalog.test.js` — `each capability supplies a closed audit projection without user payloads or identities`                                                                                                                                                                                                 |
| `SEC-API-REFERENCE`    | Offline Plugin API material comes only from the exact reviewed official typings dependency, is byte/entry/path/link bounded, and is atomically activated under private shared state without network or shell execution. Concurrent or failed setup leaves a complete known-good version; plans and audit expose only effects and a stable material version.            | `tests/api-reference-store.test.js` — `setup reads a read-only package and atomically publishes private material`, `failed provenance update leaves the previous known-good material readable`, `concurrent setup processes publish one complete material without temporary residue`, `private state rejects links and unexpected entries before lookup`; `tests/capability-catalog.test.js` — `API reference plans expose only private-state effects and stable material provenance`; `tests/audit-trail.test.js` — `Audit Trail retains only a safe API material version`                                                                                                                                                                                                                                                                                                                             |
| `SEC-DATA-AS-DATA`     | Representative generated-code, Markdown, and structured-plan inputs cannot break their data boundary.                                                                                                                                                                                                                                                                  | `engine/tests/component-add-variant-command.test.js` — `a quoted payload cannot break out of the eval`; `tests/history.test.js` — `formatHistory sanitizes hostile labels/refs`; `engine/tests/structured-render-executor.test.js` — `preflights the whole plan and rejects unsupported facts without writes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SEC-PUBLIC-SAFETY`    | Public source/history gates detect supported credential and private-data shapes without echoing them; the default prepublish scan also covers untracked Runtime files selected by the canonical package policy while ignored private documentation stays out of scope.                                                                                                 | `tests/public-safety.test.js` — `public-safety rejects provider tokens without printing their value`, `public-safety history parser scans additions with their real line`, `default prepublish safety fails on an untracked allowlisted Runtime secret`, `package projection does not scan ignored private documentation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SEC-PACKAGE`          | Published paths and executable bits are explicitly reviewed; two packs must be byte-identical before registry-style pairing and authenticated startup smoke. Unexpected tar paths fail without crossing the allowlisted source-tree read boundary. The fresh production graph has exact registry integrity, no install scripts, and satisfies the declared Node floor. | `tests/package-artifact.test.js` — `release artifact is allowlisted and byte-reproducible`, `artifact policy rejects an unreviewed executable even when it is regular`, `unexpected tar paths fail without becoming source-tree reads`; `tests/installed-dependency-evidence.test.js` — `installed dependency evidence is exact, deterministic, and path-sanitized`, `installed dependency evidence rejects executable lifecycle hooks`; `tests/packaging.test.js` — `published runtime keeps the declared Node floor after consumer resolution`; `tests/release-integrity.test.js` — `release workflows pin every third-party Action to an immutable commit`, `publish workflow releases the verified tarball and retains all evidence`; `scripts/smoke-mcp-server.js` — installed-package MCP, pairing, authenticated startup, status, and cleanup smoke                                              |
| `SEC-DISPATCH`         | Every Plugin execution is bound to one signed connection epoch, target/session, expected editor and capability; mismatches stop before mutation, and stale terminal responses cannot settle newer work.                                                                                                                                                                | `engine/tests/dispatch-receipt.test.js` — `Plugin preflight rejects stale connection, target, editor, and capability before execution`; `tests/plugin-sync.test.js` — `expired queued writes never begin and timed-out evals quarantine the Plugin lane`; `tests/daemon-auth.test.js` — `a terminal response from an old connection epoch cannot settle a newer execution`, `/exec treats a valid but target-mismatched terminal receipt as outcome unknown`; `tests/error-projection.test.js` — `public errors expose only the closed Dispatch Receipt state`                                                                                                                                                                                                                                                                                                                                          |
| `SEC-WRITE-LANE`       | Plugin writes serialize per resolved document session; queued expiry/cancellation is not dispatched, different files remain independent, and unknown outcomes stay quarantined across reconnect until the exact settlement receipt arrives.                                                                                                                            | `engine/tests/plugin-write-lane.test.js` — `same-session writes are ordered while different sessions progress independently`, `queued deadline and cancellation remove only their own command`, `unknown dispatch quarantines until the exact settlement token arrives`; `tests/daemon-auth.test.js` — `Plugin write lanes order one file while different files progress independently`, `queued deadline and HTTP cancellation never reach the Plugin write boundary`, `unknown write quarantine survives reconnect until the exact lane settlement replays`; `tests/plugin-sync.test.js` — `Plugin main replays exact lane settlement after an authenticated UI reconnect`                                                                                                                                                                                                                            |
| `SEC-RENDER-ROLLBACK`  | Native Structured Render preflights the complete request before mutation, journals only Command-created artifacts, removes safe inverses in reverse order, and exposes closed bounded residue without changing uncertain-dispatch semantics.                                                                                                                           | `engine/tests/structured-render-executor.test.js` — `preflights every batch resource before the first real mutation`, `rolls back batch-wide Command resources in reverse creation order without touching reused resources`, `fault-injects after every removable resource and tree mutation`, `reports bounded image residue and preserves the original execution failure`, `keeps rollback failure as a failed partial-residue result`; `tests/daemon-auth.test.js` — `/exec preserves a failed Structured Render mutation report without weakening dispatch uncertainty`; `engine/tests/daemon-error-envelope.test.js` — `Bridge Daemon errors preserve only closed bounded mutation residue facts`                                                                                                                                                                                                  |
| `SEC-RENDER-OUTCOME`   | One closed versioned Semantic Render Outcome rejects malformed, oversized, cyclic or drifting Plugin results after dispatch; adapters expose the same bounded root, structure, resource, outcome and rollback facts without raw source, file-key, secret or error payloads.                                                                                            | `engine/tests/semantic-render-command.test.js` — `malformed post-dispatch results remain unknown and never redispatch`, `known rollback residue is carried only as typed failure facts`, `a structural finding preserves the created root, returns code 1 and bounded deterministic output`; `tests/mcp-layer.test.js` — `figma_run and figma_render share simple and compound non-retrying Semantic Render Applications`; `tests/command-application.test.js` — `Semantic Render findings project the same Outcome into process and Audit codes`                                                                                                                                                                                                                                                                                                                                                       |

The model must be reviewed whenever a transport, remote domain/dependency,
credential, Plugin permission, Figma/workspace write surface, or public security
claim is added.
