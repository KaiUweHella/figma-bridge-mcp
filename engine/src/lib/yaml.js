/**
 * YAML serialization policy for all machine-readable engine output.
 *
 * One wrapper instead of scattered YAML.stringify calls, because two default
 * behaviors of the `yaml` package would corrupt our outputs for agents:
 *  - line folding (lineWidth) wraps long strings — a folded node id or text
 *    literal no longer greps;
 *  - anchor/alias emission (&a / *a) for shared object references — our spec
 *    model shares style objects between the styles map and nodes, which would
 *    otherwise serialize as opaque aliases.
 *
 * Quoting/escaping is the library's problem (that is why we use it rather
 * than hand-rolling an emitter); the tests pin the contract via parse
 * roundtrips.
 */
import YAML from 'yaml';

export function toYaml(value) {
  return YAML.stringify(value, {
    lineWidth: 0,               // never fold long lines
    aliasDuplicateObjects: false, // repeat shared objects instead of *aliases
  }).trimEnd();
}

/** Parse counterpart — only re-exported so tests and callers share one config. */
export function fromYaml(text) {
  return YAML.parse(text);
}
