/**
 * FigJam CDP Client
 *
 * Connects directly to FigJam via Chrome DevTools Protocol,
 * bypassing figma-use which has compatibility issues with FigJam.
 */

import WebSocket from 'ws';
import { getCdpPort } from './figma-patch.js';

export class FigJamClient {
  constructor() {
    this.ws = null;
    this.contexts = [];
    this.figmaContextId = null;
    this.msgId = 0;
    this.callbacks = new Map();
    this.pageTitle = null;
  }

  /**
   * List all available FigJam pages
   */
  static async listPages() {
    const port = getCdpPort();
    const response = await fetch(`http://localhost:${port}/json`);
    const pages = await response.json();
    return pages
      .filter(p => p.title.includes('FigJam'))
      .map(p => ({ title: p.title, id: p.id, url: p.url }));
  }

  /**
   * Connect to a FigJam page by title (partial match)
   */
  async connect(pageTitle) {
    const port = getCdpPort();
    const response = await fetch(`http://localhost:${port}/json`);
    const pages = await response.json();
    const page = pages.find(p => p.title.includes(pageTitle) && p.title.includes('FigJam'));

    if (!page) {
      const figjamPages = pages.filter(p => p.title.includes('FigJam'));
      if (figjamPages.length > 0) {
        throw new Error(`Page "${pageTitle}" not found. Available FigJam pages: ${figjamPages.map(p => p.title).join(', ')}`);
      }
      throw new Error('No FigJam pages open. Please open a FigJam file in Figma Desktop.');
    }

    this.pageTitle = page.title;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(page.webSocketDebuggerUrl);

      this.ws.on('open', async () => {
        await this.send('Runtime.enable');

        // Wait for contexts to be discovered
        await new Promise(r => setTimeout(r, 1500));

        // Find figma context
        for (const ctx of this.contexts) {
          try {
            const result = await this.send('Runtime.evaluate', {
              expression: 'typeof figma !== "undefined"',
              contextId: ctx.id,
              returnByValue: true
            });

            if (result.result?.result?.value === true) {
              this.figmaContextId = ctx.id;
              break;
            }
          } catch (e) {}
        }

        if (!this.figmaContextId) {
          reject(new Error('Could not find figma context. Try refreshing the FigJam page.'));
        } else {
          resolve(this);
        }
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);

        if (msg.method === 'Runtime.executionContextCreated') {
          this.contexts.push(msg.params.context);
        }

        if (msg.id && this.callbacks.has(msg.id)) {
          this.callbacks.get(msg.id)(msg);
          this.callbacks.delete(msg.id);
        }
      });

      this.ws.on('error', reject);

      setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.callbacks.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate JavaScript in the FigJam context
   */
  async eval(expression) {
    if (!this.figmaContextId) {
      throw new Error('Not connected to FigJam');
    }

    const result = await this.send('Runtime.evaluate', {
      expression,
      contextId: this.figmaContextId,
      returnByValue: true,
      awaitPromise: true
    });

    if (result.result?.exceptionDetails) {
      const error = result.result.exceptionDetails;
      throw new Error(error.exception?.description || error.text || 'Evaluation error');
    }

    return result.result?.result?.value;
  }

  /**
   * Get current page info
   */
  async getPageInfo() {
    return await this.eval(`
      (function() {
        return {
          name: figma.currentPage.name,
          id: figma.currentPage.id,
          childCount: figma.currentPage.children.length,
          editorType: figma.editorType
        };
      })()
    `);
  }

  /**
   * List all nodes on the current page
   */
  async listNodes(limit = 50) {
    return await this.eval(`
      figma.currentPage.children.slice(0, ${limit}).map(function(n) {
        return {
          id: n.id,
          type: n.type,
          name: n.name || '',
          x: Math.round(n.x),
          y: Math.round(n.y)
        };
      })
    `);
  }

  /**
   * Create a sticky note
   */
  async createSticky(text, x = 0, y = 0, color) {
    return await this.eval(`
      (async function() {
        var sticky = figma.createSticky();
        sticky.x = ${x};
        sticky.y = ${y};
        ${color ? `sticky.fills = [{type: 'SOLID', color: ${JSON.stringify(hexToRgb(color))}}];` : ''}
        // Load font before setting text
        await figma.loadFontAsync({ family: "Inter", style: "Medium" });
        sticky.text.characters = ${JSON.stringify(text)};
        return { id: sticky.id, x: sticky.x, y: sticky.y };
      })()
    `);
  }

  /**
   * Create a shape with text
   */
  async createShape(text, x = 0, y = 0, width = 200, height = 100, shapeType = 'ROUNDED_RECTANGLE') {
    return await this.eval(`
      (async function() {
        var shape = figma.createShapeWithText();
        shape.shapeType = ${JSON.stringify(shapeType)};
        shape.x = ${x};
        shape.y = ${y};
        shape.resize(${width}, ${height});
        if (shape.text) {
          await figma.loadFontAsync({ family: "Inter", style: "Medium" });
          shape.text.characters = ${JSON.stringify(text)};
        }
        return { id: shape.id, x: shape.x, y: shape.y };
      })()
    `);
  }

  /**
   * Create a connector between two nodes
   */
  async createConnector(startNodeId, endNodeId) {
    return await this.eval(`
      (function() {
        var startNode = figma.getNodeById(${JSON.stringify(startNodeId)});
        var endNode = figma.getNodeById(${JSON.stringify(endNodeId)});
        if (!startNode || !endNode) return { error: 'Node not found' };

        var connector = figma.createConnector();
        connector.connectorStart = { endpointNodeId: startNode.id, magnet: 'AUTO' };
        connector.connectorEnd = { endpointNodeId: endNode.id, magnet: 'AUTO' };
        return { id: connector.id };
      })()
    `);
  }

  /**
   * Create a text node
   */
  async createText(text, x = 0, y = 0, fontSize = 16) {
    return await this.eval(`
      (async function() {
        var textNode = figma.createText();
        textNode.x = ${x};
        textNode.y = ${y};
        await figma.loadFontAsync({ family: "Inter", style: "Medium" });
        textNode.characters = ${JSON.stringify(text)};
        textNode.fontSize = ${fontSize};
        return { id: textNode.id, x: textNode.x, y: textNode.y };
      })()
    `);
  }

  /**
   * Delete a node by ID
   */
  async deleteNode(nodeId) {
    return await this.eval(`
      (function() {
        var node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (node) {
          node.remove();
          return { deleted: true };
        }
        return { deleted: false, error: 'Node not found' };
      })()
    `);
  }

  /**
   * Move a node
   */
  async moveNode(nodeId, x, y) {
    return await this.eval(`
      (function() {
        var node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (node) {
          node.x = ${x};
          node.y = ${y};
          return { id: node.id, x: node.x, y: node.y };
        }
        return { error: 'Node not found' };
      })()
    `);
  }

  /**
   * Update text content of a node
   */
  async updateText(nodeId, text) {
    return await this.eval(`
      (async function() {
        var node = figma.getNodeById(${JSON.stringify(nodeId)});
        if (!node) return { error: 'Node not found' };

        await figma.loadFontAsync({ family: "Inter", style: "Medium" });

        if (node.type === 'STICKY' || node.type === 'SHAPE_WITH_TEXT') {
          node.text.characters = ${JSON.stringify(text)};
        } else if (node.type === 'TEXT') {
          node.characters = ${JSON.stringify(text)};
        } else {
          return { error: 'Node does not support text' };
        }
        return { id: node.id, updated: true };
      })()
    `);
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : { r: 1, g: 0.9, b: 0.5 }; // default yellow
}

export default FigJamClient;
