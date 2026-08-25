# Bound Component Inventory at one shared seam

`component list`, `map storybook` and post-Render reuse advice previously
shared only a generated traversal. Each caller trusted the returned object,
while the Plugin could visit and return unlimited pages, nodes, Component
Sets, Variants, standalone Components, axis values and strings. A large or
hostile file could therefore exceed the authenticated protocol limit or place
control/Bidi text into terminal and JSON projections. Silently truncating the
catalog would be worse: callers could treat a partial library as complete.

One Component Inventory Module now owns the traversal Implementation and the
validation Interface at both sides of the Plugin seam. Current-page and
all-page scans have explicit page and node-visit ceilings. Component Sets,
Variants, standalone Components, per-set Variant counts, axis maps and axis
values have independent collection limits. File, page, Component, axis and
publish-key strings are bounded and reject control/Bidi characters. The final
UTF-8 JSON representation is limited to 2 MB, below the authenticated 5 MB
Plugin protocol value limit.

Every limit failure is explicit and recommends current-page narrowing where
that can preserve normal use. No limit produces a partial success result. The
host revalidates the exact versioned shape, counts, identity uniqueness,
strings, nested axis facts and serialized bytes before any caller lists,
maps or lints the Inventory. Advisory Render reuse checks may still ignore a
failed Inventory because they must not turn a completed canvas write into an
ambiguous failure; they also cannot consume unvalidated facts.

This deepens the existing compatibility Module without claiming that
`component list` is already a migrated Command Application. Its current
Commander and opaque-eval routing remains tracked by STAB-06. A later typed
read may replace the Adapter, but it must preserve this Component Inventory
Interface and its truthful completeness contract.
