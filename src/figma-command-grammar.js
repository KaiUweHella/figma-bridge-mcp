// Closed recursive grammar for every Figma Command exposed through figma_run.
//
// The Capability Catalog resolves this grammar before confirmation, audit or
// dispatch. Positional values deliberately live outside it: a stable action id
// such as `node.set` may reach the Audit Trail, while node ids, names, JSX and
// paths never become action identity.

const HELP_TOKENS = new Set(['--help', '-h']);
const ACTION_VALUE_HELP_TOKENS = Object.freeze({
  // Commander already assigns -h to --height for this concrete action.
  // Treating it as help would erase a real write from Capability policy.
  'component.create': new Set(['-h']),
  'create.frame': new Set(['-h']),
  'create.image': new Set(['-h']),
  'create.rect': new Set(['-h']),
  'create.ellipse': new Set(['-h']),
  'create.polygon': new Set(['-h']),
  'create.star': new Set(['-h']),
  'create.slice': new Set(['-h']),
});

const EMPTY_OPTION_FACTS = Object.freeze({
  terminatorIndex: null,
  entries: Object.freeze([]),
});

function valueOption(...aliases) {
  return Object.freeze({
    name: aliases.find((alias) => alias.startsWith('--')) || aliases[0],
    aliases: Object.freeze(aliases),
    value: true,
  });
}

function signedValueOption(...aliases) {
  return Object.freeze({
    name: aliases.find((alias) => alias.startsWith('--')) || aliases[0],
    aliases: Object.freeze(aliases),
    value: true,
    allowLeadingDash: true,
  });
}

function flagOption(...aliases) {
  return Object.freeze({
    name: aliases.find((alias) => alias.startsWith('--')) || aliases[0],
    aliases: Object.freeze(aliases),
    value: false,
  });
}

function optionSchema(options = [], { conflicts = [] } = {}) {
  return Object.freeze({
    options: Object.freeze([
      valueOption('--figma-file'),
      ...options,
    ]),
    conflicts: Object.freeze(conflicts.map((names) => Object.freeze([...names]))),
  });
}

// Only Legacy Commands whose options affect Command Capability policy need a
// compatibility schema here. Migrated Command Applications validate through
// their own closed request Interfaces instead.
const POLICY_OPTION_SCHEMAS = Object.freeze({
  'export.screenshot': optionSchema([
    valueOption('-o', '--output'), valueOption('-s', '--scale'), valueOption('-f', '--format'),
  ]),
  'export.node': optionSchema([
    valueOption('-o', '--output'), valueOption('-s', '--scale'), valueOption('-f', '--format'),
  ]),
  'export.node-json': optionSchema([valueOption('-o', '--output')]),
  'export.dtcg': optionSchema([valueOption('--dialect')]),
  'gradient.extract': optionSchema([
    valueOption('--mode'), valueOption('--apply-to'), valueOption('--direction'),
    valueOption('--stops'), valueOption('--blur'), flagOption('--no-trim'), flagOption('--json'),
  ]),
  'tokens.spacing': optionSchema([valueOption('-c', '--collection')]),
  'tokens.radii': optionSchema([valueOption('-c', '--collection')]),
  'tokens.add': optionSchema([
    valueOption('-c', '--collection'), valueOption('-t', '--type'),
    flagOption('--allow-duplicate'),
  ]),
  'tokens.overlap': optionSchema([
    valueOption('-l', '--limit'), flagOption('--json'),
  ]),
  'tokens.import': optionSchema([
    valueOption('-c', '--collection'), flagOption('--force-slash'),
  ]),
  'tokens.sync': optionSchema([
    valueOption('-c', '--collection'), flagOption('--apply'), flagOption('--prune'),
    flagOption('--ours'), flagOption('--theirs'), valueOption('--lockfile'),
  ], { conflicts: [['--ours', '--theirs']] }),
  'tokens.import-design-md': optionSchema([
    valueOption('-c', '--collection'), flagOption('--print-context'),
    flagOption('--force-slash'),
  ]),
  'tokens.rebind': optionSchema([
    valueOption('-n', '--node'), flagOption('--page'), flagOption('--apply'),
  ], { conflicts: [['--node', '--page']] }),
  extract: optionSchema([
    valueOption('--sections'), valueOption('--pages'), flagOption('--selection'),
    flagOption('--split'), flagOption('--no-split'),
  ], { conflicts: [['--split', '--no-split']] }),
  spec: optionSchema([
    valueOption('-f', '--file'), valueOption('--check'), valueOption('--tolerance'),
  ]),
  'map.storybook': optionSchema([
    valueOption('-o', '--output'), flagOption('--json'), flagOption('--current-page'),
  ]),
  'verify-build': optionSchema([
    valueOption('--assets'), valueOption('--compare'), valueOption('--design'),
    valueOption('--node'), valueOption('--diff-out'), valueOption('--max-diff'),
    valueOption('--fidelity-ledger'), valueOption('--browser-capture'), flagOption('--json'),
  ]),
  import: optionSchema([
    valueOption('-c', '--collection'), flagOption('--print-context'),
    valueOption('--save'), valueOption('--type'),
  ]),
  'motion.add': optionSchema([
    valueOption('-f', '--field'), valueOption('-k', '--keys'),
    signedValueOption('--from'), signedValueOption('--to'), valueOption('-d', '--dur'),
    valueOption('--at'), valueOption('-e', '--ease'),
  ]),
  'motion.apply': optionSchema(),
  'motion.preset': optionSchema([
    valueOption('-d', '--dur'), valueOption('--at'), valueOption('-e', '--ease'),
  ]),
  'motion.stagger': optionSchema([
    valueOption('-p', '--preset'), valueOption('-f', '--field'),
    signedValueOption('--from'), signedValueOption('--to'), valueOption('-s', '--step'),
    valueOption('-d', '--dur'), valueOption('-e', '--ease'),
  ]),
  'motion.clear': optionSchema([valueOption('-f', '--field'), flagOption('--styles')]),
  'motion.style': optionSchema([
    valueOption('-d', '--dur'), valueOption('--at'), valueOption('-t', '--timing'),
  ]),
  'motion.timeline': optionSchema([valueOption('-d', '--duration')]),
  'kit.init': optionSchema([
    valueOption('--storybook'), valueOption('--out'), valueOption('--node'),
  ]),
});

function policyToken(schema, token) {
  if (!schema || typeof token !== 'string') return null;
  for (const option of schema.options) {
    for (const alias of option.aliases) {
      if (token === alias) return { option, name: alias, inline: false, value: null };
      if (alias.startsWith('--') && token.startsWith(`${alias}=`)) {
        return { option, name: alias, inline: true, value: token.slice(alias.length + 1) };
      }
      if (option.value && /^-[^-]$/.test(alias) && token.startsWith(alias)
        && token.length > alias.length) {
        return { option, name: alias, inline: true, value: token.slice(alias.length) };
      }
    }
  }
  return null;
}

function acceptsPolicyOptions(actionId, args) {
  const schema = POLICY_OPTION_SCHEMAS[actionId];
  let globalTargetSeen = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break;
    if (token === '--figma-file') {
      if (globalTargetSeen) return false;
      globalTargetSeen = true;
      const value = args[index + 1];
      if (typeof value !== 'string' || value === '--'
        || (value !== '-' && value.startsWith('-'))) return false;
      index++;
    } else if (typeof token === 'string' && token.startsWith('--figma-file=')) {
      if (globalTargetSeen || token.slice('--figma-file='.length).length === 0) return false;
      globalTargetSeen = true;
    }
  }
  if (!schema) return true;
  const seen = new Set();
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break;
    if (typeof token !== 'string' || token === '-' || !token.startsWith('-')) continue;
    const parsed = policyToken(schema, token);
    const option = parsed?.option;
    if (!option || seen.has(option.name)) return false;
    seen.add(option.name);
    if (option.value) {
      if (parsed.inline) {
        if (parsed.value.length === 0) return false;
      } else {
        const value = args[index + 1];
        if (typeof value !== 'string' || value === '--'
          || (!option.allowLeadingDash && value !== '-' && value.startsWith('-'))) return false;
        index++;
      }
    } else if (parsed.inline) {
      return false;
    }
  }
  return schema.conflicts.every((names) => names.filter((name) => seen.has(name)).length < 2);
}

function optionFacts(args, actionId = null) {
  if (!Array.isArray(args)) return EMPTY_OPTION_FACTS;
  const schema = POLICY_OPTION_SCHEMAS[actionId];
  const entries = [];
  let terminatorIndex = null;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === '--') {
      terminatorIndex = index;
      break;
    }
    if (typeof token !== 'string' || token === '-' || !token.startsWith('-')) continue;
    const policy = policyToken(schema, token);
    const equals = token.indexOf('=');
    entries.push(Object.freeze({
      name: policy?.name || (equals === -1 ? token : token.slice(0, equals)),
      index,
      inline: policy?.inline ?? equals !== -1,
    }));
  }
  return Object.freeze({ terminatorIndex, entries: Object.freeze(entries) });
}

function hasHelpBeforeOptionTerminator(args, startIndex, actionId = null) {
  const valueTokens = ACTION_VALUE_HELP_TOKENS[actionId] || new Set();
  for (let index = startIndex; index < args.length; index++) {
    if (args[index] === '--') return false;
    if (HELP_TOKENS.has(args[index]) && !valueTokens.has(args[index])) return true;
  }
  return false;
}

function action(aliases = [], { exposed = true } = {}) {
  return Object.freeze({
    aliases: Object.freeze([...aliases]),
    children: null,
    positionalAction: null,
    positionalOptions: null,
    exposed,
  });
}

function blockedAction(aliases = []) {
  return action(aliases, { exposed: false });
}

function group(children, {
  aliases = [],
  positionalAction = null,
  positionalOptions = [],
  exposed = true,
} = {}) {
  return Object.freeze({
    aliases: Object.freeze([...aliases]),
    children: Object.freeze(children),
    positionalAction,
    positionalOptions: positionalAction ? Object.freeze([...positionalOptions]) : null,
    exposed,
  });
}

function actionGroup(names, { aliases = {}, positionalAction = null, positionalOptions = [] } = {}) {
  return group(Object.fromEntries(
    names.trim().split(/\s+/).filter(Boolean).map((name) => [name, action(aliases[name] || [])]),
  ), { positionalAction, positionalOptions });
}

const COMMAND_GRAMMAR = Object.freeze({
  render: action(),
  'render-batch': action(),
  create: group({
    ...actionGroup('frame rect ellipse polygon star vector slice text line autolayout', {
      aliases: { rect: ['rectangle'], ellipse: ['circle'], autolayout: ['al'] },
    }).children,
    image: action(),
    // These inherited commands bypass the bounded Safe-Mode primitives. Keep
    // them in the grammar contract so Commander drift cannot expose them.
    component: blockedAction(),
    group: blockedAction(),
  }),
  combos: action(),
  sizes: action(),
  node: actionGroup('tree bindings css to-component group ungroup boolean flatten duplicate reparent move resize rename set-text set-fill set-image delete bind set'),
  component: group({
    ...actionGroup('create instantiate list main swap detach overrides combine add-variant').children,
    prop: actionGroup('add list set bind delete'),
    nested: actionGroup('expose'),
  }),
  tokens: actionGroup('spacing radii import sync overlap import-design-md add rebind'),
  var: group({
    ...actionGroup('list create find show update update-batch set-value set-value-batch code-syntax resolve publish-status visualize create-batch delete').children,
    // The legacy implementation can delete every local variable and
    // collection without an exact scope or complete preflight. Keep its real
    // Commander path in the drift contract, but make it unreachable through
    // the MCP grammar until SEC-15 supplies a safe replacement.
    'delete-all': blockedAction(),
  }, { aliases: ['variables'] }),
  col: group(actionGroup('list create show update mode-add mode-rename mode-remove publish-status delete extend').children, {
    aliases: ['collections'],
  }),
  style: actionGroup('list show create update apply consumers publish-status delete bind-font unbind-font'),
  library: actionGroup('collections variables import-variable import-style import-component import-component-set'),
  prototype: actionGroup('inspect add set clear'),
  measure: actionGroup('list add edit delete'),
  shader: actionGroup('list import apply'),
  layout: group({ grid: actionGroup('inspect set place auto-flow reorder-rows reorder-columns') }),
  slot: actionGroup('inspect create edit validate reset'),
  draw: actionGroup('inspect text-path transform-group brush stroke-profile pattern'),
  section: actionGroup('create fit arrange list add'),
  grid: actionGroup('set list clear'),
  dev: actionGroup('link list unlink edit'),
  annotate: actionGroup('add edit remove categories category-add category-edit category-remove list clear'),
  a11y: actionGroup('contrast vision touch text focus audit'),
  canvas: actionGroup('info pages page-create page-divider page next'),
  find: action(),
  verify: action(),
  inspect: action(),
  export: actionGroup('screenshot node video node-json css assets dtcg code-spec'),
  gradient: actionGroup('apply extract mesh'),
  pin: action(),
  // `api [name]` intentionally accepts an arbitrary offline Plugin API type
  // name in addition to its documented subcommands.
  api: actionGroup('show setup index context age list gap search', {
    positionalAction: 'lookup',
    positionalOptions: ['--full'],
  }),
  import: action(),
  motion: actionGroup('add apply preset stagger styles style timeline inspect clear'),
  extract: action(),
  spec: action(),
  analyze: actionGroup('colors typography spacing clusters lint', { aliases: { typography: ['type'] } }),
  font: actionGroup('bind unbind inspect axes remember-axes forget-axes'),
  map: actionGroup('storybook'),
  link: actionGroup('set inspect list configure status accept context'),
  contract: actionGroup('capture check'),
  'verify-build': action(),
  history: actionGroup('save snapshot list diff'),
  jam: actionGroup('sticky stickies shape connector table section code board arrange'),
  slides: actionGroup('inspect create duplicate move transition skip delete lint manifest batch focus view'),
  kit: actionGroup('init'),
});

function childNamed(node, token) {
  if (!node.children) return null;
  if (Object.hasOwn(node.children, token)) return { name: token, node: node.children[token] };
  for (const [name, child] of Object.entries(node.children)) {
    if (child.aliases.includes(token)) return { name, node: child };
  }
  return null;
}

function rootNamed(token) {
  if (Object.hasOwn(COMMAND_GRAMMAR, token)) {
    return { name: token, node: COMMAND_GRAMMAR[token] };
  }
  for (const [name, node] of Object.entries(COMMAND_GRAMMAR)) {
    if (node.aliases.includes(token)) return { name, node };
  }
  return null;
}

/** Resolve one public root spelling without inspecting payload fields. */
export function canonicalFigmaCommandRoot(token) {
  return typeof token === 'string' ? rootNamed(token)?.name || null : null;
}

function resolved(actionId, { help = false, args = [] } = {}) {
  if (!help && !acceptsPolicyOptions(actionId, args)) return REJECTED_OPTION;
  return Object.freeze({
    accepted: true,
    actionId: help ? `${actionId}.help` : actionId,
    help,
    reason: null,
    options: optionFacts(args, actionId),
  });
}

const REJECTED = Object.freeze({
  accepted: false,
  actionId: 'unknown',
  help: false,
  reason: 'unknown-action',
  options: EMPTY_OPTION_FACTS,
});
const REJECTED_OPTION = Object.freeze({ ...REJECTED, reason: 'unknown-option' });

/** Resolve argv to one stable safe action id, or reject an unknown command path. */
export function resolveFigmaCommandAction(args) {
  if (!Array.isArray(args) || typeof args[0] !== 'string') return REJECTED;
  const root = rootNamed(args[0]);
  if (!root || !root.node.exposed) return REJECTED;
  let node = root.node;
  const path = [root.name];
  let index = 1;

  while (node.children) {
    const token = args[index];
    if (token === undefined || HELP_TOKENS.has(token)) {
      return resolved(path.join('.'), { help: true, args });
    }
    if (typeof token !== 'string') return REJECTED;
    if (token.startsWith('-')) {
      return node.positionalAction && node.positionalOptions.includes(token)
        ? resolved(`${path.join('.')}.${node.positionalAction}`, {
          help: hasHelpBeforeOptionTerminator(args, index + 1),
          args,
        })
        : REJECTED_OPTION;
    }
    const child = childNamed(node, token);
    if (!child) {
      if (node.positionalAction) {
        return resolved(`${path.join('.')}.${node.positionalAction}`, {
          help: hasHelpBeforeOptionTerminator(args, index + 1),
          args,
        });
      }
      return REJECTED;
    }
    if (!child.node.exposed) return REJECTED;
    path.push(child.name);
    node = child.node;
    index++;
  }

  return resolved(path.join('.'), {
    help: hasHelpBeforeOptionTerminator(args, index, path.join('.')),
    args,
  });
}

function contractNode(name, node) {
  return Object.freeze({
    name,
    aliases: node.aliases,
    positionalAction: node.positionalAction,
    positionalOptions: node.positionalOptions,
    exposed: node.exposed,
    children: Object.freeze(node.children
      ? Object.entries(node.children).map(([childName, child]) => contractNode(childName, child))
      : []),
  });
}

/** Deterministic projection used to detect drift from the real Commander tree. */
export function listFigmaCommandGrammar() {
  return Object.freeze(
    Object.entries(COMMAND_GRAMMAR).map(([name, node]) => contractNode(name, node)),
  );
}
