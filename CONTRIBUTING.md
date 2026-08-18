# Contributing

## Getting set up

```bash
git clone https://github.com/KaiUweHella/figma-bridge-mcp.git
cd figma-bridge-mcp
npm install
npm test
```

Point your MCP client at the checkout:

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/figma-bridge-mcp/src/server.js"]
    }
  }
}
```

Then run `figma_connect` and import `~/.figma-bridge-mcp/plugin/manifest.json`
in Figma Desktop. `figma_connect` re-copies the plugin files on every run, so
after editing `plugin/*` you only need to close and reopen the plugin window.

Bug and feature issue forms ask for the workflow, editor, environment and
redacted evidence needed to reproduce a report. Pull requests use the same
test/live-check/security checklist as this guide. Support is best effort; see
`SUPPORT.md` for channels and response expectations.

## The lines this project holds

These are not style preferences — they are the reason the project exists, and a
change that crosses one will not be merged without a very good argument:

- **One transport.** Everything reaches Figma as engine → daemon → plugin eval.
  No CDP, no binary patching, no second path that could bypass the bridge.
- **No secret on the wire.** HTTP requests are HMAC-signed; the plugin socket
  runs a mutual challenge-response. Adding a credential to a frame, a header or
  a URL is a regression.
- **The manifest stays loopback-only.** `networkAccess.allowedDomains` must
  never gain a non-localhost entry. `tests/plugin-sync.test.js` enforces this.
- **New command groups default to gated.** `src/server.js` treats an unlisted
  group as a *write*. If you add one, enumerate its read subcommands explicitly
  rather than widening the read side.
- **No bundled design systems.** No shadcn, Tailwind, Radix or icon-pack
  generators. Importing from the *user's* own files is the supported path.
- **Nothing new talks to the network.** The permitted exceptions are listed in
  the README and in `SECURITY.md`.

## Tests

`npm run check:contracts` type-checks the JavaScript module seams and the Figma
plugin without turning the project into a TypeScript build. `npm run
measure:architecture` prints the current MCP-context, compact-spec, injected
payload and local latency measurements. `npm run check:architecture-latency`
checks warmed median and tail latency ceilings in an otherwise idle process;
CI deliberately runs it separately from the parallel test runner. `npm test`
runs both the static contract and the vendored engine, MCP, daemon-auth, REST,
gate, protocol and deterministic architecture budget suites. Anything
security-relevant needs a test that fails without the fix — the existing negative cases in
`tests/daemon-auth.test.js` (forged proof,
replayed nonce, wrong port, proto downgrade) are the pattern to follow.

Use the nouns in `CONTEXT.md` when a change crosses a Module or Interface. A
durable architectural choice belongs in `docs/adr/`; experiments and completed
plans belong in the ignored maintainer workspace under `docs-local/`.

`plugin/ui.html` and `plugin/code.js` are only ever parsed by Figma, so
`tests/plugin-handshake.test.js` parses them and runs the panel's crypto against
Node's. If you touch the handshake, both sides and that test move together.

## Changes that need a live check

Some things cannot be proven by unit tests. If your change touches the plugin
panel, the handshake, or anything that writes to a document, verify it against
a real Figma Desktop and say so in the PR — what you ran and what you saw.

## Attribution

`engine/` began as a fork of figma-ds-cli v2.1.0 (MIT, © Sil Bormüller). Four
files are still byte-identical to upstream; the rest has been rewritten. Two
things must stay regardless of how far the fork travels:

- `engine/LICENSE` — the upstream MIT text, verbatim.
- `NOTICE` — what was derived and what changed. If you delete or rewrite a
  file that `NOTICE` names, update `NOTICE` in the same commit.

`tests/packaging.test.js` asserts both ship in the npm tarball. That test is
the guard; do not relax it.

Third-party material embedded in source (currently Feather icon paths in
`engine/src/lib/builtin-icons.js`) belongs in `NOTICE` too — add it when you
add the code, not later.
