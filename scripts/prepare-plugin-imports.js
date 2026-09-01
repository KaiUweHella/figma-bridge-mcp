#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "plugin");
const DESTINATION_ROOT = process.env.PLUGIN_IMPORT_ROOT || PLUGIN_DIR;
const bundles = [
  {
    destination: join(DESTINATION_ROOT, "local"),
    manifest: join(PLUGIN_DIR, "manifests", "local-development.json"),
  },
  {
    destination: join(DESTINATION_ROOT, "dev-mode"),
    manifest: join(PLUGIN_DIR, "manifests", "dev-mode.json"),
  },
];

for (const bundle of bundles) {
  mkdirSync(bundle.destination, { recursive: true });
  copyFileSync(bundle.manifest, join(bundle.destination, "manifest.json"));
  for (const file of ["code.js", "ui.html"]) {
    copyFileSync(join(PLUGIN_DIR, file), join(bundle.destination, file));
  }
}

process.stdout.write(
  "Prepared plugin/local/manifest.json and plugin/dev-mode/manifest.json.\n"
);
