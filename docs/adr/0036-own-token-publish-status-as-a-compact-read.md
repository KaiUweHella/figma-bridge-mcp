# Own Token Publish Status as a compact read

`var publish-status` and `col publish-status` use one closed Token Publish
Status Command Application from Commander and `figma_run`. Both resolve an
authentic safe-read Command Plan before readiness and execute with the same
target, decreasing deadline, retry and accepted-outcome policy without
re-entering Commander.

The request owns Variable versus Collection intent, one bounded query and the
Variable command's optional Collection scope. Query and scope are payload and
never derive Figma Target Context. Literal dash-prefixed names survive the `--`
boundary; unknown, duplicate, missing and excess input fails before readiness.

The Application preserves the established resolution order. Variables resolve
by id, exact name, path-tail name and then one unique partial name, optionally
within one resolved Collection. Collections resolve by id, exact name and then
one unique partial name. Ambiguity reports a bounded match count rather than
selecting an item. Candidate, label and serialized-size limits fail explicitly.

Figma's official `getPublishStatusAsync()` result crosses the Plugin boundary
in a versioned contract together with resolution and Collection identity.
The host independently validates those relationships and accepts only
UNPUBLISHED, CURRENT or CHANGED. The public stdout projection deliberately
retains the prior `{id, name, publishStatus}` JSON shape so this migration does
not restrict existing scripts. Full Variable and Collection metadata and every
token mutation remain separate Commands.
