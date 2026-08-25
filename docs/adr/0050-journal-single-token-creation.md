# Journal single Token creation

`tokens add` uses one dedicated Token Add Command Application from Commander
and `figma_run`. Reusing `var create` is deliberately rejected: Token Add owns
useful auto-Collection creation, safe semantic scope assignment and unresolved
scope questions, all of which must share one mutation journal and verification
boundary.

The closed request bounds exactly one name and value, defaults to the `Tokens`
Collection, preserves the six official Variable types and retains legacy type
inference. Exact duplicate names in the target Collection fail by default;
`--allow-duplicate` keeps intentional duplicate workflows explicit. The
canonical argv places options before `--`, so names and values beginning with a
hyphen remain payload rather than policy syntax.

The Plugin resolves one exact local Collection or journals a newly created one,
then follows only that Collection's bounded Variable membership for duplicate
preflight. It uses `defaultModeId`, journals the Variable immediately, applies
only namespace-safe `GAP` or `CORNER_RADIUS` scopes and initializes the typed
value. Ambiguous COLOR, FLOAT and STRING scope intent remains `ALL_SCOPES` and
is returned as a host-generated user decision.

Success requires fresh targeted Collection and Variable reads proving identity,
membership, type, declared mode, scope and type-specific value equivalence.
COLOR verification treats Figma's opaque RGB-to-RGBA normalization (`a: 1`)
and Float32 channel readback as equivalent, while rejecting added fields,
non-opaque alpha changes and actual channel drift.
Failure cleans the Variable and optional Collection in reverse, refuses to
remove an auto-created Collection that gained a foreign member, and reports
verified rollback, partial residue or unavailable verification without retry.
Commander no longer generates Plugin JavaScript, so token names cannot become
executable source.
