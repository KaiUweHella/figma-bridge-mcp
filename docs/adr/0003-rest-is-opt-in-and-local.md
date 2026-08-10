# Keep REST opt-in and credentials local

The plugin bridge remains useful without a Figma personal access token. REST-only features are explicit add-ons; their token enters through the authenticated plugin, is stored locally with mode 0600, and never appears in MCP configuration, chat or audit output.
