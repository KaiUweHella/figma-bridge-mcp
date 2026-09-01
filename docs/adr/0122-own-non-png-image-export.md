# ADR 0122: Own non-PNG image export behind one Command Application

ADR 0116 deliberately left JPG, SVG and PDF behind one explicit compatibility
branch because they are not PNG Verification Artifacts. That branch still
duplicated readiness, generated Plugin evaluation, trusted arbitrary Base64,
used a fixed timeout and wrote directly from Commander. MCP reached the same
public commands through Commander fallback, so the already allowlisted
Command Capability did not own one execution policy.

Keep PNG with the Screenshot Command Application and its stricter verification
evidence contract. Route JPG, SVG and PDF through a separate Image Export
Command Application shared by Commander and `figma_run`. The existing closed
Raster Export Compatibility request and Command Plan continue to own action,
node or selection target, scale, format and the exact workspace output before
readiness. Both Adapters use the Plan target and decreasing deadline, with
compatibility fallback disabled.

The Image Export Application accepts one bounded canonical Base64 response and
validates the requested container before publication. Its raw-byte ceiling is
derived below the authenticated 5 MiB Plugin message so oversized exports fail
with one small result instead of breaking transport. JPEG needs a signature and
bounded intrinsic dimensions, SVG needs valid UTF-8 and one complete root, and
PDF needs its header and bounded end marker. Workspace I/O receives bytes only
after all Plugin evidence and format checks pass. Logical node geometry,
projected scale geometry and JPEG pixel dimensions remain separate facts;
legacy human-readable success output stays compatible.

This does not turn SVG or PDF into screenshot evidence, remove any documented
format, add retries, or change Figma's export settings. A live Figma test is not
required for the ownership change because the stable `exportAsync` formats and
host-side container contracts are covered by the official Plugin typings and
deterministic runtime fixtures.
