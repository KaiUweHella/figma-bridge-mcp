# Runtime workload budgets

Figma Bridge measures runtime work at the Command Application seam. A report
separates planning from execution, retains the first in-process sample apart
from warm repetitions, and records Command Application outcome bytes plus heap
delta. When the
current Plugin runtime supports it, execution is further split into Plugin
queue and Figma-main-thread execution time.

Run the maintainer-only live corpus against an explicitly connected file:

```sh
npm run measure:runtime -- --file-key FILE_KEY --node-id 1:2 --style Body/Caption
```

The report does not yet claim the complete MCP path: MCP ingress, Audit,
confirmation and the final MCP envelope remain named as pending coverage. It
also never calls the first sample “process cold”: Node startup and legacy
Commander child startup are outside the current harness. It does not infer a traversal budget for
Figma's non-interruptible `getStyleConsumersAsync()` API.

CI should gate only deterministic local work or deliberately generous
absolute ceilings. Live Figma timings are acceptance evidence and regression
baselines, not hard compatibility limits for user machines. The corpus will
grow through separate read, write, render, capture and background-job slices.
