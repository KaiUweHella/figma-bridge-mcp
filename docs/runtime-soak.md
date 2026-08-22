# Runtime Soak acceptance

The Runtime Soak is an explicit maintainer acceptance for long-running Bridge
sessions. It exercises two open Figma Design files through the authenticated
Bridge Daemon and produces one private, redacted Runtime Soak Report.

This is not a normal user workflow or an MCP tool. It deliberately creates a
small number of temporary rectangles, reloads both Plugin iframes, restarts the
Bridge Daemon, and asks the maintainer to exercise editor sleep/wake. Use two
disposable scratch files, not active production documents.

## Before running

1. Open two different Figma Design files in Figma Desktop.
2. Start Figma Bridge in both windows with the same saved access key.
3. Keep both Plugin windows open throughout the run.
4. Choose a new report path under ignored `docs-local/`; the harness refuses to
   overwrite an existing report.

Prefer environment variables so file keys or URLs do not enter shell history:

```bash
export FIGMA_SOAK_FILE_A='<first Figma key or URL>'
export FIGMA_SOAK_FILE_B='<second Figma key or URL>'
npm run accept:runtime-soak -- \
  --confirm-disposable-writes \
  --cycles 100 \
  --output docs-local/evidence/runtime-soak.json
```

The output is created with mode `0600`, and the harness rejects report paths
outside the launch workspace's ignored `docs-local/` directory. Direct
`--file-a` and `--file-b` arguments are supported for local convenience, but
environment variables leave less identity-bearing shell history.

## What the harness proves

- Every request names target A or B. A sustained alternating read stops all
  later test writes on the first cross-file identity mismatch and proceeds only
  to run-scoped cleanup.
- Plugin reload is targeted independently for both files and followed by a
  verified marker read.
- The manual checkpoint asks the maintainer to background or sleep Figma/the
  computer, wake it, and acknowledge that both Plugin windows recovered.
- A temporary Bridge Daemon uses a 1–2 second idle window, deliberately below
  the Plugin keepalive interval. It is allowed to exit, then a read recovers
  once through the normal Daemon Client path. The final daemon is restarted
  with the maintainer's normal timeout.
- A controlled disconnect during a read may retry exactly once after readiness.
- A controlled disconnect after a disposable write is dispatched never retries
  the write. Readback must find exactly one marker; zero is unresolved residue
  and more than one is a duplicate mutation failure.
- Cleanup removes only nodes carrying the current opaque run marker and then
  reads both files back. Cleanup itself is never retried after an uncertain
  result.

Passing `--skip-editor-sleep-wake` is useful for unattended harness checks, but
the resulting report is `incomplete`, never `passed`.

## Report privacy and cleanup

The report is a closed schema. It contains aliases `A` and `B`, aggregate
latency, stable Bridge Daemon Error facts, retry counts, residue counts and the
opaque run id. It never contains file keys, document names, node names, raw
arguments or error messages.

On a clean pass, residue is zero in both targets and no manual cleanup is
required. If cleanup is unknown or nonzero, the report lists only the affected
target alias. In that file, remove layers whose name starts with
`Figma Bridge Soak <runId>` and preserve everything else.
