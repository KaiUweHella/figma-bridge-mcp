# Separate host and Plugin static contracts

The original JavaScript contract gate loaded both Node and Figma Plugin type
packages into one TypeScript program. That allowed accidental `figma` globals
in host modules and accidental Node globals in the Plugin to type-check. It
also made failures report one undifferentiated contract task.

Run two explicit static programs instead. The host contract receives only Node
types; the Plugin contract receives only official Figma Plugin types. DOM
library declarations remain in both because the host uses standard Fetch and
Abort APIs while the Plugin UI bridge uses browser timers and messages. Files
must not cross between the two programs.

Host coverage remains incremental. Every accepted seam is listed explicitly,
and a source-level contract test snapshots that list so coverage cannot shrink
silently. The final release migrations add Raster Export Compatibility and
Node-to-Component to the existing Command Application set. This deliberately
does not opt every inherited Commander module into `checkJs` at once.

The static source contract owns the accepted execution, pre-authentication and
authenticated-message discriminant inventories. It requires one explicit
validation branch for every execution action and requires the authenticated
switch cases to equal that inventory. Keeping this inventory outside the
runtime protocol module avoids changing its compatibility fingerprint merely
to inspect it. Adding, removing or implementing only one side of a protocol
message still fails at the owning seam.
