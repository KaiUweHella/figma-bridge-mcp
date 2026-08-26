# Journal neutral Token presets

`tokens spacing` and `tokens radii` use one closed Token Preset Command
Application from Commander and `figma_run`. Each authentic Command Plan is a
confirmation-configured, target-bound and non-retrying Figma write. The
Adapters do not own readiness, Plugin code, factories, mode selection, cleanup
or result formatting.

The presets intentionally remain the two small neutral utility scales already
shipped by Figma Bridge. They are not Tailwind output, a branded starter kit or
the default representation for Code-to-Figma. Project-owned systems continue
to enter through explicit import and sync workflows.

The Plugin bounds the local Collection catalog and resolves the requested
Collection by exact name. Duplicate Collection names or duplicate preset
Variable names inside that Collection fail before mutation. The Application
follows the Collection's bounded `variableIds` through targeted async reads
rather than scanning every Variable in a large document. Variables
with the same name in another Collection do not suppress creation. An absent
Collection is created and journaled immediately; an existing Collection is
never silently replaced. Its declared `defaultModeId` is used instead of mode
array position.

Every missing preset Variable is journaled immediately, receives its FLOAT
value in the default mode and is narrowly scoped to GAP or CORNER_RADIUS.
Existing Variables retain authored type, value and scopes. Matching values with
compatible GAP/CORNER_RADIUS or ALL_SCOPES metadata are reused; missing values,
different values, incompatible types and incompatible narrow scopes remain
unchanged and appear as explicit conflicts rather than being overwritten or
hidden.

Fresh targeted reads verify the Collection, default mode, every existing and
created identity, exact value and scope before success. A later failure removes
created Variables and any command-created Collection in reverse order. It
refuses to remove a command-created Collection that has gained a non-journaled
member, then uses fresh bounded Collection membership as the authoritative
Variable-removal proof and the fresh local Collection catalog as the
Collection-removal proof. This avoids false residue from Figma's short-lived
tombstoned direct id readback while keeping ids still present in authoritative
topology explicit residue. Successful stdout retains the
established `Created N spacing variables` or `Created N radius variables`
contract; preserved conflicts are additionally exposed on stderr and in the
structured result.
