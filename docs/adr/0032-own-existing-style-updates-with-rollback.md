# Own existing Style updates with rollback

`style update` owns one closed non-retrying Command Application shared by
Commander and MCP. Its request accepts one bounded Style id or name, optional
PAINT, TEXT, EFFECT or GRID narrowing, optional name and description changes,
and a non-empty type-specific property object. Properties require an explicit
family. Unknown, duplicate, valueless or excess input fails before confirmation
or Plugin readiness.

Style Creation and Style Update share one exact mutation-value contract. PAINT
and EFFECT union discriminants, TEXT fields and the Layout Guide union receive
the same structural and size checks. The explicit
`{"$figmaScalar":"Infinity"}` value is accepted only for a ROWS/COLUMNS Layout
Guide count and decoded inside the Plugin immediately before assignment. This
does not affect Auto Layout Grid properties.

The Plugin resolves an id, exact local name or one unique case-insensitive
partial name within at most 10,000 candidates. Remote Styles cannot be changed.
Fallible resource preflight, currently Text Style font loading, completes
before the first write. Every requested field is then snapshotted before any
mutation and assigned sequentially.

After an assignment error, rollback begins with the failing field because a
setter may mutate before throwing, then restores confirmed prior fields in
reverse order. A complete restoration reports `rolled-back`; a failed restore
reports bounded possible Style residue and never claims atomicity. A dispatched
failure is marked failed and remains non-retryable.

Success and failure project compact Style identity and requested field names.
Raw paints, typography, effects and Layout Guides never cross this mutation
seam, so valid non-JSON values cannot be silently coerced in an incidental
update result.
