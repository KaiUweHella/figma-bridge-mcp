# Own Variable Collection mode mutations

`col mode-add`, `col mode-rename` and `col mode-remove` use one closed
Collection Mode Command Application from Commander and `figma_run`. Each
authentic Command Plan is a confirmation-configured, non-retrying Figma write
with one target and decreasing deadline. Neither Adapter owns mode resolution,
Plugin code, recovery or output formatting.

Collection and mode queries plus new mode names are bounded before readiness.
Collection resolution retains id, exact-name and unique partial-name utility;
mode resolution retains id, exact-name and unique partial-name utility. Every
ambiguity fails before mutation. Complete Collection Facts validate before and
after every operation.

Recovery follows the actual Figma API rather than claiming one generic
transaction:

- Add journals the returned mode id immediately. Guarded projection or
  postcondition failure removes that exact mode and verifies its absence;
  removal failure reports one possible residue.
- Rename snapshots the selected mode name. Guarded failure restores the old
  name and verifies it; restore failure reports the exact mode residue.
- Remove preflights local Variables and counts authored values on the selected
  mode. Success verifies the mode and those values are absent. Figma exposes no
  API that restores a removed mode with its original id and values, so a failure
  after removal is reported as `irreversible-applied`; a setter failure that
  leaves the mode present is reported as unchanged.

All three operations use the shared generated Collection mutation runtime and
retain complete legacy Collection Facts JSON on success. The Application never
retries a dispatched mutation. Collection metadata, deletion and extension
remain separate Commands.
