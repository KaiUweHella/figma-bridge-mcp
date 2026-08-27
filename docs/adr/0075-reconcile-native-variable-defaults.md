# Reconcile native Variable defaults during creation

Figma materializes one native value per Collection mode immediately when a
Variable is created. Absence of requested initial intent therefore does not
imply absence from `valuesByMode`. `var create` and `var create-batch` must not
roll back a correctly created Variable merely because Figma supplied defaults.

Creation still performs a fresh Variable and Collection read after the factory
call. It validates exact identity, Collection membership, type, metadata and
known mode ids. When an initial value was requested, the selected mode must be
present and equivalent to that request. Without initial intent, the selected
mode may be present or absent. The result reports a compact `modeValue` with
source `requested-initial`, `native-default`, or `absent`, plus the total
observed mode count. This keeps native behavior visible without making large
multi-mode batches return an unbounded value matrix.

Numeric leaves retain float32 equivalence. A named EASING request containing
only `type` may read back the same type with Figma's valid canonical cubic or
spring parameters. Requests that provide custom parameters remain field-exact.
All cleanup, membership and stale-catalog failure paths remain unchanged and
non-retrying.
