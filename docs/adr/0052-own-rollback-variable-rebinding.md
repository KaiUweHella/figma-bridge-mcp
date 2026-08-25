# Own rollback-safe Variable Rebinding

`tokens rebind` uses one closed Variable Rebinding Command Application from
Commander and `figma_run`. Both adapters create the same authoritative Command
Plan; Commander owns no readiness, resolution, traversal, mutation, rollback or
formatting branch.

The request accepts one bounded Collection query and exactly one of an explicit
node root or the current page. Dry-run is a long safe-retrying read. Apply is a
long, confirmed, non-retrying write and is limited to one explicit SceneNode
subtree. Whole-page apply remains gated under ADR 0022, and PAGE or DOCUMENT
passed through `--node` cannot bypass that product boundary.

Collection resolution prefers exact local id, then case-insensitive exact name,
then one unique case-insensitive partial name. The Application follows only the
target Collection's declared `variableIds`, rejects duplicate target names, and
loads source Variables only by binding alias id. It iteratively walks at most
20,000 nodes and accepts at most 100,000 binding candidates; every result list
and serialized result is bounded.

The target remains one local Collection because Figma can mutate only local
Variable membership. Existing source aliases may be local or remote: a bound
library Variable is loaded by its exact alias id and can switch to the
same-named compatible local target without a global import scan.

The first owned topology preserves the useful legacy surface: SOLID fill and
stroke color aliases plus direct scalar aliases. Same-named compatible target
Variables form the operation plan. Already-target bindings are ignored;
missing, incompatible and unsupported bindings remain untouched and are
reported separately instead of being guessed or mislabeled.

Apply journals scalar inverses before each setter and complete paint arrays
before each grouped property assignment. Fresh node reads prove every new alias.
Any setter, assignment or postcondition failure reverses the complete journal,
then freshly checks every original alias. Outcomes distinguish applied,
rolled-back and failed residue; a failed apply never appears as a partial theme
switch success. Host validation rejects malformed counts, lists, mutation
reports and unrecognized result fields before projection.
