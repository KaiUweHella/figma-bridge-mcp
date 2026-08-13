# Link Design Entities through repository and Figma anchors

A Design Entity has one repository-owned id. `figma-bridge.json` records its code, Storybook and Figma links in version control; the linked Figma node stores only the minimal entity id and schema version in Bridge plugin data. Published component keys remain the strongest Figma lookup handle, while node ids are current-file locators rather than identity.

Neither anchor is sufficient alone. A repository-only record becomes stale after a node is recreated, while Figma-only plugin data is unavailable before the document connects and cannot point an agent at code without scanning the repository. The Design Link Registry reconciles both adapters and refuses duplicate ids or conflicting handles instead of choosing one silently.

Link writes cross the repository and the authenticated plugin transport, so they cannot be transactional. They are idempotent and convergence-based: repeating the same link operation repairs either side after a partial failure. No credential, absolute user path or source content belongs in either anchor.

Legacy `figma-map.json` remains a read adapter for Storybook mappings. New durable links are written only to `figma-bridge.json`; there is no second writable source of truth.
