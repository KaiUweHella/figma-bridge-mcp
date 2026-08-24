// Closed recursive grammar for every Figma Command exposed through figma_run.
//
// The Capability Catalog resolves this grammar before confirmation, audit or
// dispatch. Positional values deliberately live outside it: a stable action id
// such as `node.set` may reach the Audit Trail, while node ids, names, JSX and
// paths never become action identity.

const HELP_TOKENS = new Set(['--help', '-h']);

const EMPTY_OPTION_FACTS = Object.freeze({
  terminatorIndex: null,
  entries: Object.freeze([]),
});

function optionFacts(args) {
  if (!Array.isArray(args)) return EMPTY_OPTION_FACTS;
  const entries = [];
  let terminatorIndex = null;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === '--') {
      terminatorIndex = index;
      break;
    }
    if (typeof token !== 'string' || token === '-' || !token.startsWith('-')) continue;
    const equals = token.indexOf('=');
    entries.push(Object.freeze({
      name: equals === -1 ? token : token.slice(0, equals),
      index,
      inline: equals !== -1,
    }));
  }
  return Object.freeze({ terminatorIndex, entries: Object.freeze(entries) });
}

function hasHelpBeforeOptionTerminator(args, startIndex) {
  for (let index = startIndex; index < args.length; index++) {
    if (args[index] === '--') return false;
    if (HELP_TOKENS.has(args[index])) return true;
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
    // These inherited commands bypass the bounded Safe-Mode primitives. Keep
    // them in the grammar contract so Commander drift cannot expose them.
    image: blockedAction(),
    component: blockedAction(),
    group: blockedAction(),
  }),
  combos: action(),
  sizes: action(),
  node: actionGroup('tree bindings css to-component group ungroup boolean flatten duplicate reparent move resize rename set-text set-fill set-image delete bind set'),
  component: group({
    ...actionGroup('create instantiate list main swap detach overrides combine add-variant').children,
    prop: actionGroup('add list set delete'),
  }),
  tokens: actionGroup('spacing radii import sync overlap import-design-md add rebind'),
  var: actionGroup('list create find show update set-value code-syntax resolve publish-status visualize create-batch delete delete-all'),
  col: actionGroup('list create show update mode-add mode-rename mode-remove publish-status delete extend'),
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
  slides: actionGroup('inspect create duplicate move transition skip delete'),
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

function resolved(actionId, { help = false, args = [] } = {}) {
  return Object.freeze({
    accepted: true,
    actionId: help ? `${actionId}.help` : actionId,
    help,
    reason: null,
    options: optionFacts(args),
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
  const rootName = args[0];
  let node = COMMAND_GRAMMAR[rootName];
  if (!node || !node.exposed) return REJECTED;
  const path = [rootName];
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
    help: hasHelpBeforeOptionTerminator(args, index),
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
