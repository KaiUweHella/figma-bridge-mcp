/**
 * FigCli (Safe/Hardened) Bridge Plugin
 *
 * Safe Mode: connects to the local figma-safe-mcp daemon over WebSocket.
 * No debug port, no app patching. The connection is authenticated with an
 * access key the user pastes in once; it is persisted in figma.clientStorage
 * (only reachable from this main thread, not the UI iframe) and handed to the
 * UI on request.
 */

const KEY_STORAGE = 'daemonKey';

// Visible UI so the user can paste the access key. Kept small.
figma.showUI(__html__, { width: 300, height: 220 });

// Execute code with auto-return and timeout protection
async function executeCode(code, timeoutMs = 25000) {
  let trimmed = code.trim();

  // Don't add return if code already starts with return
  if (!trimmed.startsWith('return ')) {
    const isSimpleExpr = !trimmed.includes(';');
    const isIIFE = trimmed.startsWith('(function') || trimmed.startsWith('(async function');
    const isArrowIIFE = trimmed.startsWith('(() =>') || trimmed.startsWith('(async () =>');

    if (isSimpleExpr || isIIFE || isArrowIIFE) {
      trimmed = `return ${trimmed}`;
    } else {
      const lastSemicolon = trimmed.lastIndexOf(';');
      if (lastSemicolon !== -1) {
        const beforeLast = trimmed.substring(0, lastSemicolon + 1);
        const lastStmt = trimmed.substring(lastSemicolon + 1).trim();
        if (lastStmt && !lastStmt.startsWith('return ')) {
          trimmed = beforeLast + ' return ' + lastStmt;
        }
      }
    }
  }

  // Figma's QuickJS sandbox blocks `new Function` / `new AsyncFunction`.
  // eval() runs in the plugin's main scope where `figma` is already global.
  const execPromise = eval(`(async () => { ${trimmed} })()`);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Execution timeout (${timeoutMs / 1000}s)`)), timeoutMs)
  );

  return Promise.race([execPromise, timeoutPromise]);
}

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
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '', error: e.message });
    }
    return;
  }

  // --- Eval bridge ---
  if (msg.type === 'eval') {
    try {
      const result = await executeCode(msg.code);
      figma.ui.postMessage({ type: 'result', id: msg.id, result: result });
    } catch (error) {
      figma.ui.postMessage({ type: 'result', id: msg.id, error: error.message });
    }
  }

  // Batch eval (execute multiple codes in sequence, return all results)
  if (msg.type === 'eval-batch') {
    const results = [];
    for (const code of msg.codes) {
      try {
        const result = await executeCode(code);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    figma.ui.postMessage({ type: 'batch-result', id: msg.id, results: results });
  }

  if (msg.type === 'connected') {
    figma.notify('✓ FigCli connected', { timeout: 2000 });
  }

  if (msg.type === 'disconnected') {
    figma.notify('FigCli disconnected', { timeout: 2000 });
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
    figma.notify('FigCli: access key rejected — re-enter it', { error: true });
  }

  if (msg.type === 'error') {
    figma.notify('FigCli: ' + msg.message, { error: true });
  }
};

console.log('FigCli (Safe/Hardened) plugin started');
