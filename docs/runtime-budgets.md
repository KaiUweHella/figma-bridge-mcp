# Runtime workload budgets

Figma Bridge measures both the Command Application seam and the complete MCP
STDIO path. The complete report starts a real server process per workload,
keeps process startup and the first call separate from warm calls, and records
MCP ingress/serialization remainder, Audit lifecycle count, exact final
envelope bytes, process RSS, Daemon transport and content-free Plugin timing.
Every sample names its dominant measured segment.

Run the maintainer-only live corpus against an explicitly connected file:

```sh
npm run measure:runtime -- --file-key FILE_KEY --node-id 1:2 --style Body/Caption
```

Run the complete private acceptance corpus with a stable existing target:

```sh
npm run measure:runtime:mcp -- \
  --file-key FILE_KEY \
  --node-id 1:2 \
  --node-name "Exact current name" \
  --iterations 3 \
  --output /absolute/workspace/private-runtime-report.json
```

The complete corpus repeats Inspect, an idempotent confirmed rename, native
Semantic Render, Screenshot and tracked Asset Export. It enables write-confirm
mode, uses a private temporary Audit Trail, requires the client and server to
agree on the exact serialized envelope size, and records peak RSS where the
platform exposes a process sampler. The content-free trace is opt-in for the
child server only and never affects ordinary users.

Legacy Commander work remains visible as `compatibility-child`. Its
MCP-outside-Daemon segment includes process startup and Adapter overhead. That
budget is retained while any measured Figma Command still uses a child; it is
retired only after those Command Applications move in-process. The first call
of a long-lived MCP process is not mislabeled as a fresh compatibility child.

`npm run check:runtime-budgets` starts three real offline MCP processes and
gates stable Tool Discovery with both a warm/startup ratio and deliberately
generous absolute ceilings: 5 seconds startup p95, 1 second warm `tools/list`
p95, 512 KiB response and 512 MiB RSS when RSS sampling is available. Shared
runner scheduling, antivirus, Figma document size and desktop load make live
Figma timings acceptance evidence and regression baselines rather than hard
compatibility limits for every user machine.

The corpus does not infer a traversal budget for Figma's non-interruptible
`getStyleConsumersAsync()` API.
