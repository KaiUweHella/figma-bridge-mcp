import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFigmaCommandGrammar } from '../src/figma-command-grammar.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const engineIndex = readFileSync(join(ROOT, 'engine', 'src', 'index.js'), 'utf8');
for (const match of engineIndex.matchAll(/import '\.\/(commands\/[^']+)';/g)) {
  await import(`../engine/src/${match[1]}`);
}
const { program } = await import('../engine/src/lib/cli-core.js');

function actualChild(command, name) {
  return command.commands.find((child) => child.name() === name || child.aliases().includes(name));
}

function assertNodeMatches(grammarNode, command, path) {
  const actualNames = command.commands.map((child) => child.name()).sort();
  const grammarNames = grammarNode.children.map((child) => child.name).sort();
  assert.deepEqual(grammarNames, actualNames, `${path} child grammar drifted from Commander`);
  if (command.commands.length && command.registeredArguments.length) {
    assert.ok(grammarNode.positionalAction, `${path} needs an explicit positional fallback action`);
    assert.deepEqual(
      [...grammarNode.positionalOptions].sort(),
      command.options.flatMap((option) => [option.short, option.long].filter(Boolean)).sort(),
      `${path} positional option grammar drifted from Commander`,
    );
  } else {
    assert.equal(grammarNode.positionalAction, null, `${path} has a stale positional fallback action`);
    assert.equal(grammarNode.positionalOptions, null, `${path} has stale positional options`);
  }
  for (const childGrammar of grammarNode.children) {
    const child = actualChild(command, childGrammar.name);
    assert.ok(child, `${path}.${childGrammar.name} exists in Commander`);
    assert.deepEqual([...childGrammar.aliases].sort(), child.aliases().sort(),
      `${path}.${childGrammar.name} alias grammar drifted from Commander`);
    assertNodeMatches(childGrammar, child, `${path}.${childGrammar.name}`);
  }
}

test('the recursive Capability grammar matches every exposed Commander command and alias', () => {
  for (const grammarRoot of listFigmaCommandGrammar()) {
    const command = actualChild(program, grammarRoot.name);
    assert.ok(command, `${grammarRoot.name} must resolve to a real command or documented alias`);
    assertNodeMatches(grammarRoot, command, grammarRoot.name);
  }
});
