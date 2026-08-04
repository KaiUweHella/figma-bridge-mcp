/**
 * FigCli (Safe/Hardened) Bridge Plugin
 *
 * Safe Mode: connects to the local figma-bridge-mcp daemon over WebSocket.
 * No debug port, no app patching. The connection is authenticated with an
 * access key the user pastes in once; it is persisted in figma.clientStorage
 * (only reachable from this main thread, not the UI iframe) and handed to the
 * UI on request.
 */

const KEY_STORAGE = 'daemonKey';

// Visible UI: connection status, access-key entry, activity log, pause switch,
// selection push, checkpoint. The UI may grow itself via the `resize` message.
figma.showUI(__html__, { width: 320, height: 240 });

// Execute code with auto-return and timeout protection.
//
// REPL pattern: first try the code as a single EXPRESSION — `return (code)`.
// If that throws a SyntaxError, the throw happens at PARSE time, before any
// execution, so falling back to running the code as plain statements never
// double-executes anything. The previous string heuristics (split at the last
// `;`, "no semicolon = expression") corrupted legal code: a trailing
// `for (…) { … }` block, or multi-statement code without semicolons, became a
// SyntaxError. Statement code now returns undefined unless it ends with an
// explicit `return` — which is what every engine call site already does.
// 22s, deliberately BELOW the daemon's 25s eval timeout: with both at 25s the
// daemon always fired first and the plugin's more precise error message
// (naming the actual slow API call) never reached anyone. Note the timeout
// only rejects the promise — the sandboxed eval itself keeps running.
async function executeCode(code, timeoutMs = 22000) {
  const trimmed = code.trim();

  let execPromise;
  try {
    // eval() (not new Function — Figma's QuickJS blocks that) runs in the
    // plugin's main scope where `figma` is already global.
    execPromise = eval(`(async () => { return (${trimmed}\n) })()`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      execPromise = eval(`(async () => { ${trimmed} })()`);
    } else {
      throw e;
    }
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Execution timeout (${timeoutMs / 1000}s)`)), timeoutMs)
  );

  return Promise.race([execPromise, timeoutPromise]);
}

// Normalize anything thrown into a non-empty string. `throw 'msg'` or a
// rejected plain object used to produce `error: undefined`, which the daemon
// treats as SUCCESS (falsy error check) — a failing script read as "worked,
// returned nothing".
function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  try {
    return typeof error === 'string' ? error : JSON.stringify(error) || String(error);
  } catch (e) {
    return String(error);
  }
}

// --- Selection push (UI feature C) ---
// Fully automatic: every selection change is pushed (debounced) — the UI
// displays it and forwards it to the daemon, where the MCP tool
// figma_selection picks it up. There is no button; selecting IS the gesture.
//
// Component identity: for the first few nodes the STABLE publish key is
// resolved (main component for instances, own key for components/sets) so a
// Storybook/code mapping can identify the component — node ids are file-local.
const KEY_RESOLVE_CAP = 10; // bound the async main-component lookups per push

async function selectionSnapshot() {
  const selection = figma.currentPage.selection;
  const nodes = [];
  for (let i = 0; i < Math.min(selection.length, 50); i++) {
    const n = selection[i];
    const entry = { id: n.id, name: n.name, type: n.type };
    try {
      entry.width = Math.round(n.width);
      entry.height = Math.round(n.height);
    } catch (e) {}
    if (i < KEY_RESOLVE_CAP) {
      try {
        if (n.type === 'INSTANCE') {
          const main = await n.getMainComponentAsync();
          if (main) {
            entry.mainName = main.name;
            if (main.key) entry.componentKey = main.key;
            if (main.parent && main.parent.type === 'COMPONENT_SET') {
              entry.setName = main.parent.name;
              if (main.parent.key) entry.setKey = main.parent.key;
            }
          }
        } else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
          if (n.key) entry.componentKey = n.key;
        }
      } catch (e) {}
    }
    nodes.push(entry);
  }
  return {
    page: figma.currentPage.name,
    total: selection.length,
    nodes,
    // File identity for the optional REST layer (default scope = this file).
    // figma.fileKey needs enablePrivatePluginApi in the manifest and is
    // undefined for never-saved drafts — both degrade to null gracefully.
    fileKey: (typeof figma.fileKey === 'string' && figma.fileKey) || null,
    fileName: figma.root.name,
  };
}

async function pushSelection() {
  figma.ui.postMessage({ type: 'selection-snapshot', selection: await selectionSnapshot() });
}

// Auto-push on selection change (debounced) so the agent's figma_selection is
// always current without the user pressing the button.
let selectionDebounce = null;
figma.on('selectionchange', () => {
  if (selectionDebounce) clearTimeout(selectionDebounce);
  selectionDebounce = setTimeout(pushSelection, 300);
});

// Eval serialization chain — every handler in it catches its own errors, so
// the chain itself never rejects (a rejected chain would wedge all later evals).
let evalChain = Promise.resolve();

// Handle messages from UI (WebSocket bridge)
figma.ui.onmessage = async (msg) => {
  // --- Access-key bridge (clientStorage is only reachable here) ---
  if (msg.type === 'get-key') {
    let value = '';
    try {
      value = (await figma.clientStorage.getAsync(KEY_STORAGE)) || '';
    } catch (e) {
      value = '';
    }
    figma.ui.postMessage({ type: 'key', value });
    return;
  }

  if (msg.type === 'save-key') {
    try {
      await figma.clientStorage.setAsync(KEY_STORAGE, msg.value || '');
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '' });
      figma.notify('Access key saved', { timeout: 1500 });
    } catch (e) {
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '', error: errorMessage(e) });
    }
    return;
  }

  // --- Eval bridge ---
  // Serialized through a promise chain: figma.ui.onmessage is async, so two
  // evals arriving back-to-back would otherwise interleave at their await
  // points and mutate shared document state mid-flight. The daemon currently
  // sends strictly serially, but the plugin must not depend on that.
  if (msg.type === 'eval') {
    const { id, code } = msg;
    evalChain = evalChain.then(async () => {
      try {
        const result = await executeCode(code);
        figma.ui.postMessage({ type: 'result', id, result });
      } catch (error) {
        figma.ui.postMessage({ type: 'result', id, error: errorMessage(error) });
      }
    });
    return;
  }

  // Batch eval (execute multiple codes in sequence, return all results)
  if (msg.type === 'eval-batch') {
    const { id, codes } = msg;
    evalChain = evalChain.then(async () => {
      const results = [];
      for (const code of codes) {
        try {
          const result = await executeCode(code);
          results.push({ success: true, result });
        } catch (error) {
          results.push({ success: false, error: errorMessage(error) });
        }
      }
      figma.ui.postMessage({ type: 'batch-result', id, results });
    });
    return;
  }

  // --- UI feature bridge ---
  // The iframe cannot resize itself; it asks the main thread.
  if (msg.type === 'resize') {
    const w = Math.max(280, Math.min(500, Number(msg.width) || 320));
    const h = Math.max(200, Math.min(700, Number(msg.height) || 240));
    figma.ui.resize(w, h);
    return;
  }

  // Checkpoint (UI feature D): a labeled entry in Figma's native version
  // history. No restore API exists — this is a safety net the user can
  // restore from via Figma's own version history UI.
  if (msg.type === 'checkpoint') {
    try {
      await figma.saveVersionHistoryAsync('FigCli checkpoint ' + new Date().toISOString());
      figma.ui.postMessage({ type: 'checkpoint-done' });
      figma.notify('✓ Checkpoint saved to version history', { timeout: 2000 });
    } catch (e) {
      figma.ui.postMessage({ type: 'checkpoint-done', error: errorMessage(e) });
      figma.notify('FigCli: checkpoint failed — ' + errorMessage(e), { error: true });
    }
    return;
  }

  if (msg.type === 'connected') {
    figma.notify('✓ FigCli connected', { timeout: 2000 });
    // Seed the daemon with the current selection right away.
    pushSelection();
  }

  if (msg.type === 'disconnected') {
    figma.notify('FigCli disconnected', { timeout: 2000 });
  }

  // Another Figma window's plugin authenticated after us — the daemon routes
  // all evals there now. The UI shows the state; this is just the toast.
  if (msg.type === 'superseded') {
    figma.notify('FigCli: another Figma window took over the connection', { timeout: 4000 });
  }

  // Fired once per outage, after the UI has scanned all ports for a few
  // seconds without finding the daemon.
  if (msg.type === 'daemon-unreachable') {
    figma.notify('FigCli: daemon not reachable — run figma_connect to restart it', {
      error: true,
      timeout: 5000,
    });
  }

  if (msg.type === 'auth-error') {
    // The daemon distinguishes why auth failed; mirror that in the toast.
    // Re-entering the key only helps for invalid-key.
    const reason = msg.reason || 'invalid-key';
    if (reason === 'no-key-configured') {
      figma.notify('FigCli: daemon has no access key configured — run figma_connect', { error: true });
    } else if (reason === 'timeout') {
      figma.notify('FigCli: auth handshake timed out — reconnecting', { error: true, timeout: 3000 });
    } else {
      figma.notify('FigCli: access key rejected — re-enter it', { error: true });
    }
  }

  if (msg.type === 'error') {
    figma.notify('FigCli: ' + msg.message, { error: true });
  }
};

console.log('FigCli (Safe/Hardened) plugin started');
