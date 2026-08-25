# Own Single-Collection Token Import

`tokens import` uses one closed Single-Collection Token Import Command
Application from Commander and `figma_run`. Both adapters create the same
authoritative Command Plan and normalize the same workspace source before
Plugin readiness. Commander no longer owns file parsing, Collection selection,
generated eval, Variable factories, error swallowing or result formatting.

The first owned slice deliberately covers JSON import into one Collection. A
separate Application will own multi-Collection Variable snapshots because
mode topology, merge semantics and cross-Collection aliases require a wider
transaction and identity model. Simple DESIGN.md fallback can reuse this
Application after its parser produces the same prepared plan; repository-only
`--print-context` does not require a Figma target.

The closed request accepts one bounded file and Collection name. A slash in the
Collection remains an explicit `--force-slash` decision because Figma
Collections are flat. Workspace I/O authorizes and reads the file exactly once;
bounded JSON normalization then preserves false, zero and empty-string values,
legacy `{value,type}` leaves, DTCG `$value`/`$type` inheritance, pixel
dimensions, structured sRGB colors with alpha, all six Figma Variable types,
internal aliases, explicit compatible scopes and code syntax. Duplicate names,
missing or cyclic aliases, type mismatches and unsupported composites fail
before readiness.

EASING and TIMING Variables retain Figma's native `ALL_SCOPES` behavior without
calling the scope setter that those types reject. Named EASING postconditions
accept Figma's semantically equivalent canonical readback function while still
requiring the exact easing discriminator; authored custom curve or spring
parameters remain exact.

The Plugin resolves an exact local Collection name and rejects ambiguity. An
existing Collection uses `defaultModeId` and only its declared `variableIds`;
a new Collection is journaled immediately. Existing same-name Variables must
match type, default-mode value or alias, scopes and requested code syntax. Any
difference stops before the first mutation. Missing Variables are created and
journaled in one pass so a second pass can initialize internal aliases.

Success requires fresh targeted reads proving Collection identity, default
mode, membership, Variable identity, type, scopes, code syntax and type-aware
value equivalence. Any factory, metadata setter, value setter or postcondition
failure removes the complete command-created journal in reverse and freshly
checks absence. The result distinguishes rolled back, partial residue and
unavailable verification; no per-token error is swallowed and no partial state
is printed as a successful import.
