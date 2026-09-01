# Own live node JSON export behind one bounded Command Application

`export node-json` already planned an optional Workspace output and used the
authenticated Plugin rather than REST, but Commander still owned readiness,
generated evaluation, arbitrary result trust, JSON formatting and direct file
publication. `figma_run` reached the command through Commander fallback. The
Capability Catalog therefore described a read without owning its execution or
proving that the value published as JSON was the requested live node.

Keep `exportAsync({ format: 'JSON_REST_V1' })` as the source and keep the
feature independent of a REST token or network request. Introduce one closed
Node JSON Export request and one Plan-bound Command Application shared by CLI
and `figma_run`, with compatibility fallback disabled. The request owns the
exact node or URL target and optional output path. The Catalog canonicalizes
that path, declares it as the sole `node-json-output`, and classifies the
document-only operation as a safe read before readiness.

The Plugin serializes the result envelope and refuses it below the generic
authenticated result ceiling. The host accepts only the requested node id and
a bounded REST-shaped JSON object with a canonical node id and type. It rejects
accessors, exotic prototypes, cycles, sparse arrays, non-finite values,
oversized keys or names, excessive depth or entry counts, and results above the
transport budget. Pretty JSON is produced only after validation; directional
controls and JavaScript separators are escaped textually without changing the
parsed value. Workspace I/O receives bytes only after the complete graph and
formatted output pass their bounds.

This does not add REST access, alter Figma's `JSON_REST_V1` projection, select
or mutate document resources, or change the optional file/stdout interface. A
live Figma test is not required for this ownership change because the stable
Plugin export setting is already covered by the official typings and existing
runtime fixture, while the new trust and publication boundary is deterministic
host behavior.
