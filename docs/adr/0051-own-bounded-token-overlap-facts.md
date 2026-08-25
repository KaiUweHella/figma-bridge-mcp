# Own bounded Token Overlap Facts

`tokens overlap` uses one closed Token Overlap Facts Command Application from
Commander and `figma_run`. One safe-retrying, long, target-bound Plugin read
owns Collection resolution, exact membership reads, set arithmetic, result
validation and both human and JSON formatting. Adapters no longer choose a
first partial match or build an unbounded comparison themselves.

The request accepts 2–32 bounded Collection queries, a per-list limit and JSON
projection. It rejects duplicate case-folded queries before readiness and uses
canonical `--` payload. Resolution prefers exact Collection id, then
case-insensitive exact name, then one unique case-insensitive partial name. A
missing or ambiguous query, or two queries resolving to one id, fails the whole
snapshot.

The Plugin validates and bounds the Collection catalog, then loads only the
selected `variableIds` in bounded batches. It rejects cross-Collection identity
reuse and owner drift. Per-Collection name occurrence counts preserve duplicate
truth: the common core contains only names occurring exactly once in every
Collection, while duplicate names appear in `ambiguous_here` and never masquerade
as cleanly switchable tokens.

Common, only-here, missing-here and ambiguous-here lists are deterministic,
independently limited and carry total/returned/omitted/complete facts. The host
validates exact keys, order, identity uniqueness, count arithmetic, sorting,
list disjointness and overall completeness before output. JSON retains the
recognizable legacy comparison fields without exposing native ids.
