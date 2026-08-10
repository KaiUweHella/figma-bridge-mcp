const TRIGGERS = Object.freeze({
  click: { type: 'ON_CLICK' }, hover: { type: 'ON_HOVER' }, press: { type: 'ON_PRESS' },
  drag: { type: 'ON_DRAG' }, media_end: { type: 'ON_MEDIA_END' },
});

function parseJson(raw, label) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid ${label} JSON: ${error.message}`); }
}

function parseReactions(raw) {
  const reactions = parseJson(raw, 'reactions');
  if (!Array.isArray(reactions)) throw new Error('Reactions JSON must be an array');
  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== 'object' || !('trigger' in reaction)) throw new Error('Every reaction must contain trigger');
    if (reaction.actions !== undefined && !Array.isArray(reaction.actions)) throw new Error('Reaction actions must be an array');
  }
  return reactions;
}

function parseActions(raw) {
  const actions = parseJson(raw, 'actions');
  if (!Array.isArray(actions) || actions.some((action) => !action || typeof action.type !== 'string')) {
    throw new Error('Actions JSON must be an array of action objects with type');
  }
  return actions;
}

function parseTrigger(value) {
  const key = String(value || 'click').trim().toLowerCase().replaceAll('-', '_');
  if (TRIGGERS[key]) return TRIGGERS[key];
  const timeout = key.match(/^after:(\d+(?:\.\d+)?)$/);
  if (timeout) return { type: 'AFTER_TIMEOUT', timeout: Number(timeout[1]) };
  throw new Error(`Trigger must be one of ${Object.keys(TRIGGERS).join(', ')} or after:<seconds>`);
}

function prototypeNodeCode(nodeId, body) {
  return `(async () => {
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) throw new Error('Node not found: ${String(nodeId)}');
if (typeof node.setReactionsAsync !== 'function') throw new Error(node.type + ' does not support prototype reactions');
${body}
})()`;
}

function prototypeInspectCode({ nodeId }) {
  return prototypeNodeCode(nodeId, `return { id: node.id, name: node.name, type: node.type, reactions: node.reactions || [] };`);
}

function prototypeSetCode({ nodeId, reactions }) {
  const parsed = parseReactions(reactions);
  return prototypeNodeCode(nodeId, `const reactions = ${JSON.stringify(parsed)};
await node.setReactionsAsync(reactions);
return { id: node.id, name: node.name, type: node.type, reactions: node.reactions || reactions };`);
}

function prototypeAddCode({ nodeId, trigger = 'click', navigateTo = null, actions = null, transition = null }) {
  const parsedTrigger = parseTrigger(trigger);
  let parsedActions = actions === null ? null : parseActions(actions);
  if (!parsedActions) {
    if (!navigateTo) throw new Error('Provide --navigate-to or --actions');
    const parsedTransition = transition === null ? null : parseJson(transition, 'transition');
    parsedActions = [{ type: 'NODE', destinationId: String(navigateTo), navigation: 'NAVIGATE', transition: parsedTransition }];
  }
  return prototypeNodeCode(nodeId, `const reaction = { trigger: ${JSON.stringify(parsedTrigger)}, actions: ${JSON.stringify(parsedActions)} };
const reactions = [...(node.reactions || []), reaction];
await node.setReactionsAsync(reactions);
return { id: node.id, name: node.name, added: reaction, reactions: node.reactions || reactions };`);
}

function prototypeClearCode({ nodeId }) {
  return prototypeNodeCode(nodeId, `const removed = (node.reactions || []).length;
await node.setReactionsAsync([]);
return { id: node.id, name: node.name, removed, reactions: [] };`);
}

export {
  TRIGGERS, parseActions, parseReactions, parseTrigger, prototypeAddCode,
  prototypeClearCode, prototypeInspectCode, prototypeSetCode,
};
