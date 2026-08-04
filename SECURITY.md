# Security

figma-bridge-mcp gives an AI agent write access to a live Figma document. This
document says what that means, what protects it, and — just as importantly —
what it does *not* protect against.

Everything here is checkable against the source: the daemon is
`engine/src/daemon.js`, the handshake is `engine/src/lib/plugin-handshake.js`,
the request signing is `engine/src/lib/daemon-auth.js`, the command allowlist is
`src/engine.js`, and the write gate is `src/server.js`.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/KaiUweHella/figma-cli-mcp/security/advisories/new)
on GitHub. Please do not open a public issue for a vulnerability. Include steps
to reproduce and what an attacker gains.

This is a single-maintainer project — treat response times accordingly, and say
in the report if you have a disclosure deadline in mind.

## Threat model

The assumed attacker is **another process on the same machine**: an npm
postinstall script, a malicious editor extension, a second AI agent, a
compromised dependency. Not a remote network attacker — nothing here listens off
loopback — and not a malicious Figma itself.

That framing matters because "it only listens on localhost" is not an access
control on a developer machine. Every one of those processes runs as you.

### What the design guarantees

**The Figma application is never modified.** No binary patching, no `app.asar`
rewrite, no re-signing, no Chrome DevTools Protocol. The upstream project's Yolo
mode was removed from the fork rather than disabled — there is no code path to
it, and `connect` is absent from the command allowlist so Safe Mode cannot be
switched off through the MCP layer.

**No secret is ever transmitted.** Two separate credentials protect two separate
channels, and neither crosses the wire:

| Channel | Credential | How it is used |
|---------|-----------|----------------|
| HTTP (`/health`, `/exec`, …) | session token, 0600 | per-request HMAC over timestamp, nonce, method, path and body-hash; the daemon keeps a nonce cache, so captured headers cannot be replayed |
| WebSocket (`/plugin`) | plugin access key, 0600 | mutual challenge-response; both sides prove possession by HMAC over both nonces, the bound port and the plugin version |

A process that binds a port in 3456–3460 before the daemon and records
everything learns no reusable secret. Because the bound **port** is inside the
handshake transcript, it cannot relay to the real daemon either: the plugin
signs the port it reached, the daemon verifies the port it bound, and a relay
across two ports fails to verify.

**The daemon must prove itself too.** The plugin panel rejects every command —
`eval`, batches, even a keepalive reply — until the daemon's ack verifies under
the access key. Without this, anything answering on a local port could drive
your document without knowing the key at all.

**The plugin cannot reach the network.** `plugin/manifest.json` restricts
`networkAccess.allowedDomains` to `ws://localhost:3456–3460`. Figma enforces
this; the plugin has no route to any external host, so nothing in your document
can be exfiltrated through it. `tests/plugin-sync.test.js` fails the build if a
non-loopback entry is ever added.

**Only files you opened yourself are reachable.** The bridge holds one
connection per Figma window in which *you* started the plugin — the consent is
physical, not configured. With several connected, a command must name its
target; there is no "all files" switch and no fan-out, so one mistaken command
cannot sweep a library. A file you have not opened is unreachable: Figma's REST
API cannot write document content, so no code path exists to it.

**No shell, and a fixed command surface.** The engine is spawned with
`execFile` (`shell: false`). `figma_run` accepts only allowlisted first tokens.

**Everything is logged and interruptible.** Every executed command is appended
to `~/.figma-bridge-mcp/audit.log` with the node ids it touched and its outcome.
The plugin panel shows commands live, **Pause** rejects every incoming agent
command until resumed, and **Save version** writes a named restore point into
Figma's own version history.

**Optional REST is genuinely optional.** Without a token the code path is inert.
With one, the token is pasted into the plugin window (never into chat, never
into MCP client config), travels over the authenticated socket, and is stored
0600. It is never echoed back by any tool and never written to the audit log —
REST calls are logged as method and path only.

### What it does not protect against

Stated plainly, because a security document that only lists strengths is
marketing:

- **Arbitrary code still reaches your document.** `figma_render` and several
  `figma_run` commands evaluate code in Figma's plugin sandbox. That is the
  product. The sandbox protects your filesystem and network; it does not protect
  the *document*. What the allowlist, the audit log and Pause buy you is that
  the writes are bounded, visible and stoppable — not that they are impossible.
- **An agent that has been prompt-injected can still act.** If untrusted content
  reaches your agent's context, it can ask for destructive edits, and they will
  be logged as ordinary commands. Set `FIGMA_WRITE_CONFIRM=1` to require an
  explicit `confirm:true` on every mutation, and use **Save version** before
  long unattended runs.
- **A local attacker with your file permissions has already won.** The 0600
  files are readable by any process running as you. The handshake defends
  against a process that *cannot* read them (a port squatter); it cannot defend
  against one that can.
- **Figma's undo is not a rollback.** Plugins cannot restore versions. Recovery
  goes through Figma's version-history panel — which is why the panel offers a
  one-click restore point.
- **A Figma personal access token is coarse.** If you opt into the REST add-on,
  the token can read every file its account can access, not just the open one.
  Grant the minimum scopes: File content (read), File versions (read), Comments
  (read/write).

## Data handling

No telemetry, no analytics, no crash reporting, no accounts. Nothing is sent
anywhere except: `api.figma.com` if and only if you enable the REST add-on, a
one-time `git clone` of the Figma Plugin API docs mirror when you run
`api setup`, and the Storybook index URL you pass to `map storybook`.

Local state lives under `~/.figma-bridge-mcp/`: session token, plugin access
key, optional REST token (all 0600), daemon pid and port, and the audit log
(rotated at 5 MB, one previous generation kept).

## Verifying a build

```bash
npm test    # includes the handshake, daemon auth, write gate and manifest checks
```

The security-relevant suites are `tests/daemon-auth.test.js` (signing, replay,
handshake forgery, relay defence), `tests/plugin-handshake.test.js` (the panel's
own crypto is run against Node's and must agree), `tests/plugin-sync.test.js`
(the manifest cannot silently widen), `tests/write-gate.test.js` (an unlisted
command group defaults to *write*, never to ungated) and
`tests/rest-token-daemon.test.js` (an unauthenticated socket cannot plant a
token; the token never reaches the log).
