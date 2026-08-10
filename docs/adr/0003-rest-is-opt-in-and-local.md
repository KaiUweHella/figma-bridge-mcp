# Keep REST opt-in, credentials local, and endpoints closed

The plugin bridge remains useful without a Figma personal access token. REST-only features are explicit add-ons; their token enters through the authenticated plugin, is stored locally with mode 0600, and never appears in MCP configuration, chat or audit output.

`src/figma-rest.js` owns a closed method-and-path allowlist. The allowed calls are token health, version lists, version-pinned document contents, comments, and file-wide published component metadata. A current file fetch without `version=` is forbidden. Node contents, CSS, exports, images, variables, styles, Dev Resources, known-key imports, and all current-document mutations use the authenticated local Plugin API instead.

There is no generic REST passthrough. Adding an endpoint requires a named capability, a structural reason the Plugin API cannot provide it, and a denial regression test for the nearest plugin-first alternative. Denied calls fail before token lookup or network access.
