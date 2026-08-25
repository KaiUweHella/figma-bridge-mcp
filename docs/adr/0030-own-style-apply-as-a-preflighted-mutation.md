# Own Style Apply as a preflighted mutation

`style apply` owns one closed non-retrying Command Application shared by
Commander and MCP. Its request accepts one bounded Style id or name, one closed
target field and an explicit ordered set of at most 500 unique semantic Node
References. URL-derived file targeting comes only from those node fields;
conflicting files, malformed ids, duplicate targets, unknown options and excess
arguments fail before confirmation or Plugin readiness.

The Plugin resolves only the Style family required by the field. Direct ids,
exact names and one unique case-insensitive partial name are accepted; ambiguous
or missing references fail without guessing. Every target node is loaded and
checked for the official async Style setter before the first mutation. Writes
then run sequentially and are never retried automatically.

If a later setter fails, the Application restores every confirmed prior target
in reverse order when its previous Style id is a recoverable string. The failing
target and any target that cannot be restored remain bounded possible residue.
The terminal Plugin response is marked failed, so it does not quarantine the
Plugin Write Lane, while its unknown post-dispatch outcome still forbids an
automatic retry.

Success and failure evidence contains compact Style and node identity only. Raw
PAINT, TEXT, EFFECT and GRID values do not cross this mutation seam, preventing
automatic Layout Guide counts from becoming lossy JSON `null`. The canonical
field remains `grid` for compatibility; the readable `layout-guide` alias means
a Grid Style applied through `setGridStyleIdAsync`. Neither spelling changes
`layoutMode`, Auto Layout Grid tracks, row counts or column counts.
