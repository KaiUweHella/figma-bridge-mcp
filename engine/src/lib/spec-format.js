// Structured design-spec serialization adapters.
//
// The canonical model lives in code-spec.js. These adapters may alter syntax
// and whitespace only; parse(serialize(model)) must reproduce the model
// exactly. Keeping that invariant in one Module makes format changes cheap to
// test and prevents an output-specific projection from dropping design facts.
import { fromYaml, toYaml } from './yaml.js';

export const STRUCTURED_SPEC_FORMATS = ['yaml', 'json'];
// A real Sonnet 5 rebuild showed that minifying an otherwise lossless model
// made it materially harder for the consumer to act on hierarchy and fidelity
// constraints. The agent-facing default therefore remains the readable tree;
// YAML and formatted JSON are the only structured adapters.
export const DEFAULT_SPEC_FORMAT = 'tree';

function assertFormat(format) {
  if (!STRUCTURED_SPEC_FORMATS.includes(format)) {
    throw new Error(
      `Unknown structured spec format "${format}" — use ${STRUCTURED_SPEC_FORMATS.join(', ')}.`,
    );
  }
}

/** Serialize the canonical spec model without changing its information. */
export function serializeSpecModel(model, format) {
  assertFormat(format);
  if (format === 'yaml') return toYaml(model);
  return JSON.stringify(model, null, 2);
}

/** Parse a structured spec back into the canonical model. */
export function parseSpecModel(text, format) {
  assertFormat(format);
  return format === 'yaml' ? fromYaml(text) : JSON.parse(text);
}
