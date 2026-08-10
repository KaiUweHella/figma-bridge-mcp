// Structured design-spec serialization adapters.
//
// The canonical model lives in code-spec.js. These adapters may alter syntax
// and whitespace only; parse(serialize(model)) must reproduce the model
// exactly. Keeping that invariant in one Module makes format changes cheap to
// test and prevents an output-specific projection from dropping design facts.
import { fromYaml, toYaml } from './yaml.js';

export const STRUCTURED_SPEC_FORMATS = ['yaml', 'json', 'json-compact'];
export const DEFAULT_SPEC_FORMAT = 'json-compact';

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
  if (format === 'json-compact') return JSON.stringify(model);
  return JSON.stringify(model, null, 2);
}

/** Parse a structured spec back into the canonical model. */
export function parseSpecModel(text, format) {
  assertFormat(format);
  return format === 'yaml' ? fromYaml(text) : JSON.parse(text);
}
