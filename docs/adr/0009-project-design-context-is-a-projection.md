# Keep Project Design Context progressive and derived

Project Design Context is an on-demand projection for one Design Entity, exposed through the existing bounded `figma_run ["link","context",…]` command surface. It combines Design Link Registry facts, the current Round-trip Plan, discoverable project design files and exact next reads. It is not another persisted memory file.

The Design Link Command Application owns this projection and runs in-process for MCP while Commander remains a second Adapter. Both invoke the same Interface. This preserves the bounded MCP interface from ADR-0005, concentrates workflow knowledge in one Module and prevents Claude Code, Codex or another MCP client from receiving divergent instructions.

Live Figma facts are still collected through the authenticated plugin transport and normalized before fingerprinting. Context is therefore computed per request; it does not weaken the revision-evidence requirement of ADR-0006 or introduce an independently stale cache.
