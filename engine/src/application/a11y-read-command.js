// Exact bounded accessibility diagnostics for contrast, touch, text, focus, and audit.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  A11Y_READ_ACTIONS,
  MAX_A11Y_TOUCH_MINIMUM,
  a11yReadArgvFromRequest,
  parseA11yReadRequest,
} from './a11y-read-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  a11yReadArgvFromRequest,
  a11yReadPlanningArgvFromRequest,
} from './a11y-read-request.js';

const APPLICATION_IDS = new Set(A11Y_READ_ACTIONS.map((action) => `a11y.${action}`));
export const MAX_A11Y_READ_NODES = 50_000;
export const MAX_A11Y_READ_ITEMS = 20_000;
export const MAX_A11Y_READ_NATIVE_FACTS = 500_000;
export const MAX_A11Y_READ_RESULT_CODE_UNITS = 1_000_000;
const MAX_NAME_CODE_UNITS = 1_024;
const MAX_PREVIEW_CODE_UNITS = 128;
const MAX_MESSAGE_CODE_UNITS = 1_024;
const MAX_PARENT_DEPTH = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const normalized = (request) => parseA11yReadRequest(a11yReadArgvFromRequest(request));

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function a11yReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${jsValue(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const finite = (value) => typeof value === 'number' && Number.isFinite(value);
    const coordinate = (value) => finite(value)
      && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE * 2};
    const unit = (value) => finite(value) && value >= 0 && value <= 1;
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_A11Y_READ_RESULT_CODE_UNITS}) {
        throw new Error('A11y read result exceeded its bounded response limit.');
      }
      return serialized;
    };
    let visited = 0;
    let nativeFacts = 0;
    const countFact = (amount = 1) => {
      nativeFacts += amount;
      if (nativeFacts > ${MAX_A11Y_READ_NATIVE_FACTS}) {
        throw new Error('A11y read native fact limit exceeded.');
      }
    };
    const validId = (value) => typeof value === 'string'
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const validateNode = (node) => {
      if (!node || !validId(node.id)
        || typeof node.name !== 'string' || node.name.length > ${MAX_NAME_CODE_UNITS}
        || typeof node.type !== 'string' || node.type.length === 0 || node.type.length > 64
        || (node.visible !== undefined && typeof node.visible !== 'boolean')) {
        throw new Error('A11y read found invalid bounded node facts.');
      }
      return node;
    };
    const childrenOf = (node) => {
      const children = 'children' in node ? node.children : null;
      if (children !== null && (!Array.isArray(children)
        || children.length > ${MAX_A11Y_READ_NODES})) {
        throw new Error('A11y read found invalid child facts.');
      }
      if (children) countFact(children.length);
      return children;
    };
    const dimensions = (node) => {
      if (!finite(node.width) || node.width < 0 || node.width > ${MAX_ABSOLUTE_NODE_COORDINATE * 2}
        || !finite(node.height) || node.height < 0
        || node.height > ${MAX_ABSOLUTE_NODE_COORDINATE * 2}) {
        throw new Error('A11y read found invalid node dimensions.');
      }
      return { width: Math.round(node.width), height: Math.round(node.height) };
    };
    const getSolidColor = (node) => {
      const fills = node.fills;
      if (!Array.isArray(fills)) return null;
      countFact(fills.length);
      for (const fill of fills) {
        if (!fill || fill.type !== 'SOLID' || fill.visible === false) continue;
        if (!fill.color || !unit(fill.color.r) || !unit(fill.color.g) || !unit(fill.color.b)
          || (fill.opacity !== undefined && !unit(fill.opacity))) {
          throw new Error('A11y read found invalid solid paint facts.');
        }
        return {
          r: fill.color.r, g: fill.color.g, b: fill.color.b,
          a: fill.opacity === undefined ? 1 : fill.opacity,
        };
      }
      return null;
    };
    const getBgColor = (node) => {
      let current = node.parent;
      const seen = new Set();
      let depth = 0;
      while (current) {
        depth += 1;
        if (depth > ${MAX_PARENT_DEPTH} || !validId(current.id) || seen.has(current.id)) {
          throw new Error('A11y read found an invalid parent chain.');
        }
        seen.add(current.id);
        const color = getSolidColor(current);
        if (color && color.a > 0.01) return color;
        current = current.parent;
      }
      return { r: 1, g: 1, b: 1, a: 1 };
    };
    const luminance = (r, g, b) => {
      const values = [r, g, b].map((value) => value <= 0.03928
        ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const contrastRatio = (left, right) => (Math.max(left, right) + 0.05)
      / (Math.min(left, right) + 0.05);
    const blendOnWhite = (color) => ({
      r: color.r * color.a + (1 - color.a),
      g: color.g * color.a + (1 - color.a),
      b: color.b * color.a + (1 - color.a),
    });
    const toHex = (color) => '#' + [color.r, color.g, color.b]
      .map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
    const interactivePattern = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;
    const interactive = (node) => {
      const reactions = node.reactions;
      if (reactions !== undefined && !Array.isArray(reactions)) {
        throw new Error('A11y read found invalid reaction facts.');
      }
      if (reactions) countFact(reactions.length);
      return node.type === 'INSTANCE' || node.type === 'COMPONENT'
        || interactivePattern.test(node.name) || Boolean(reactions && reactions.length > 0);
    };
    const fontSize = (node, fallback = null) => finite(node.fontSize) ? node.fontSize : fallback;
    const fontWeight = (node) => finite(node.fontWeight) ? node.fontWeight : 400;
    const textPreview = (node, maximum) => typeof node.characters === 'string'
      ? clean(node.characters.slice(0, maximum), maximum) : '';
    const lineHeightFacts = (node, size) => {
      const lineHeight = node.lineHeight;
      let value = null;
      let ratio = null;
      if (lineHeight && typeof lineHeight === 'object') {
        if (lineHeight.unit === 'PIXELS' || lineHeight.unit === 'PERCENT') {
          if (!finite(lineHeight.value) || lineHeight.value < 0
            || lineHeight.value > ${MAX_ABSOLUTE_NODE_COORDINATE * 2}) {
            throw new Error('A11y read found invalid line-height facts.');
          }
          if (lineHeight.unit === 'PIXELS') {
            value = lineHeight.value;
            if (size) ratio = lineHeight.value / size;
          } else {
            ratio = lineHeight.value / 100;
            if (size) value = size * ratio;
          }
        }
      }
      return { value, ratio };
    };
    const absolutePosition = (node) => {
      if (!coordinate(node.x) || !coordinate(node.y)) {
        throw new Error('A11y read found invalid node position facts.');
      }
      let x = node.x;
      let y = node.y;
      let current = node.parent;
      const seen = new Set();
      let depth = 0;
      while (current && current.type !== 'PAGE') {
        depth += 1;
        if (depth > ${MAX_PARENT_DEPTH} || !validId(current.id) || seen.has(current.id)
          || !coordinate(current.x) || !coordinate(current.y)) {
          throw new Error('A11y read found an invalid positioned parent chain.');
        }
        seen.add(current.id);
        x += current.x;
        y += current.y;
        if (!coordinate(x) || !coordinate(y)) {
          throw new Error('A11y read absolute position exceeded its bound.');
        }
        current = current.parent;
      }
      return { x: Math.round(x), y: Math.round(y) };
    };
    const addItem = (items, item) => {
      if (items.length >= ${MAX_A11Y_READ_ITEMS}) {
        throw new Error('A11y read item limit exceeded.');
      }
      items.push(item);
    };

    const root = request.nodeId
      ? await figma.getNodeByIdAsync(request.nodeId)
      : request.action === 'focus'
        ? (figma.currentPage && Array.isArray(figma.currentPage.selection)
          ? figma.currentPage.selection[0] : null) || figma.currentPage
        : figma.currentPage;
    if (!root) throw new Error('A11y read target was not found.');
    validateNode(root);
    const rootChildren = childrenOf(root);
    const stack = request.action === 'contrast' && rootChildren === null
      ? [root] : rootChildren ? [...rootChildren].reverse() : [];
    const contrastItems = [];
    const touchItems = [];
    const textItems = [];
    const focusItems = [];
    const auditIssues = [];
    let auditTextCount = 0;
    let auditInteractiveCount = 0;

    while (stack.length > 0) {
      const node = validateNode(stack.pop());
      visited += 1;
      if (visited > ${MAX_A11Y_READ_NODES}) throw new Error('A11y read node limit exceeded.');
      if (node.visible === false) continue;
      const children = childrenOf(node);

      if (request.action === 'contrast' && node.type === 'TEXT') {
        const textColor = getSolidColor(node);
        if (textColor) {
          const bgColor = getBgColor(node);
          const fg = blendOnWhite(textColor);
          const bg = blendOnWhite(bgColor);
          const size = fontSize(node, 16);
          const large = size >= 18 || (size >= 14 && fontWeight(node) >= 700);
          const ratio = contrastRatio(luminance(fg.r, fg.g, fg.b), luminance(bg.r, bg.g, bg.b));
          addItem(contrastItems, {
            id: node.id, name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
            text: textPreview(node, 50), fontSize: size, isLarge: large,
            fgColor: toHex(fg), bgColor: toHex(bg),
            ratio: Math.round(ratio * 100) / 100,
            aa: large ? ratio >= 3 : ratio >= 4.5,
            aaa: large ? ratio >= 4.5 : ratio >= 7,
          });
        }
      } else if (request.action === 'touch' && interactive(node)) {
        const size = dimensions(node);
        const pass = size.width >= request.minimum && size.height >= request.minimum;
        const wcag248 = size.width >= 24 && size.height >= 24;
        if (!pass) addItem(touchItems, {
          id: node.id, name: clean(node.name, ${MAX_NAME_CODE_UNITS}), type: node.type,
          width: size.width, height: size.height, pass, wcag248,
          issue: size.width < request.minimum && size.height < request.minimum
            ? 'both' : size.width < request.minimum ? 'width' : 'height',
        });
        touchItems.total = (touchItems.total || 0) + 1;
        touchItems.passing = (touchItems.passing || 0) + Number(pass);
        touchItems.critical = (touchItems.critical || 0) + Number(!wcag248);
      } else if (request.action === 'text' && node.type === 'TEXT') {
        const size = fontSize(node);
        const line = lineHeightFacts(node, size);
        const issues = [];
        if (size && size < 12) issues.push({
          rule: 'min-size', message: 'Font size < 12px (hard to read)', severity: 'error',
        });
        else if (size && size < 14) issues.push({
          rule: 'min-size', message: 'Font size < 14px (consider increasing for body text)', severity: 'warning',
        });
        if (size && size <= 18 && line.ratio && line.ratio < 1.5) issues.push({
          rule: 'line-height', message: 'Line height < 1.5x for body text (WCAG 1.4.12)', severity: 'warning',
        });
        if (node.paragraphSpacing !== undefined && size) {
          if (!finite(node.paragraphSpacing)) throw new Error('A11y read found invalid paragraph spacing.');
          if (node.paragraphSpacing > 0 && node.paragraphSpacing < size * 2) issues.push({
            rule: 'paragraph-spacing', message: 'Paragraph spacing < 2x font size (WCAG 1.4.12)', severity: 'warning',
          });
        }
        if (node.letterSpacing && typeof node.letterSpacing === 'object'
          && node.letterSpacing.unit === 'PIXELS' && size) {
          if (!finite(node.letterSpacing.value)) throw new Error('A11y read found invalid letter spacing.');
          if (node.letterSpacing.value < size * 0.12 && node.letterSpacing.value !== 0) issues.push({
            rule: 'letter-spacing', message: 'Letter spacing < 0.12x font size (WCAG 1.4.12)', severity: 'warning',
          });
        }
        if (node.textCase === 'UPPER' && typeof node.characters === 'string'
          && node.characters.length > 20) issues.push({
          rule: 'all-caps', message: 'Long ALL CAPS text (> 20 chars) reduces readability', severity: 'warning',
        });
        textItems.total = (textItems.total || 0) + 1;
        if (issues.length > 0) addItem(textItems, {
          id: node.id, name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
          text: textPreview(node, 40), fontSize: size,
          lineHeight: line.value ? Math.round(line.value * 10) / 10 : null,
          lineHeightRatio: line.ratio ? Math.round(line.ratio * 100) / 100 : null,
          issues,
        });
      } else if (request.action === 'focus') {
        const isInteractive = interactive(node);
        if (isInteractive || node.type === 'TEXT') {
          const position = absolutePosition(node);
          const size = dimensions(node);
          addItem(focusItems, {
            id: node.id, name: clean(node.name, ${MAX_NAME_CODE_UNITS}), type: node.type,
            role: isInteractive ? 'interactive' : 'text',
            x: position.x, y: position.y, width: size.width, height: size.height,
          });
        }
      } else if (request.action === 'audit') {
        if (node.type === 'TEXT') {
          auditTextCount += 1;
          const textColor = getSolidColor(node);
          const size = fontSize(node);
          if (textColor) {
            const bgColor = getBgColor(node);
            const foreground = blendOnWhite(textColor);
            const ratio = contrastRatio(
              luminance(foreground.r, foreground.g, foreground.b),
              luminance(bgColor.r, bgColor.g, bgColor.b));
            const actualSize = size === null ? 16 : size;
            const large = actualSize >= 18 || (actualSize >= 14 && fontWeight(node) >= 700);
            const required = request.level === 'AAA' ? (large ? 4.5 : 7) : (large ? 3 : 4.5);
            if (ratio < required) addItem(auditIssues, {
              category: 'contrast',
              severity: ratio < (large ? 3 : 4.5) ? 'error' : 'warning',
              id: node.id, name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
              message: clean('Contrast ' + ratio.toFixed(2) + ':1 (need ' + required + ':1)', ${MAX_MESSAGE_CODE_UNITS}),
              details: {
                ratio: Math.round(ratio * 100) / 100, required,
                fg: toHex(textColor), bg: toHex(bgColor), fontSize: actualSize,
              },
            });
          }
          if (size && size < 12) addItem(auditIssues, {
            category: 'text', severity: 'error', id: node.id,
            name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
            message: clean('Font size ' + size + 'px < 12px minimum', ${MAX_MESSAGE_CODE_UNITS}),
          });
          if (size && size <= 18 && node.lineHeight) {
            const line = lineHeightFacts(node, size);
            if (line.ratio && line.ratio < 1.5) addItem(auditIssues, {
              category: 'text', severity: 'warning', id: node.id,
              name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
              message: clean('Line height ' + line.ratio.toFixed(2)
                + 'x < 1.5x (WCAG 1.4.12)', ${MAX_MESSAGE_CODE_UNITS}),
            });
          }
          if (node.textCase === 'UPPER' && typeof node.characters === 'string'
            && node.characters.length > 20) addItem(auditIssues, {
            category: 'text', severity: 'warning', id: node.id,
            name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
            message: 'Long ALL CAPS text reduces readability',
          });
        }
        if (interactive(node)) {
          auditInteractiveCount += 1;
          const size = dimensions(node);
          if (size.width < 24 || size.height < 24) addItem(auditIssues, {
            category: 'touch', severity: 'error', id: node.id,
            name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
            message: clean('Touch target ' + size.width + 'x' + size.height
              + 'px < 24x24 minimum (WCAG 2.5.8)', ${MAX_MESSAGE_CODE_UNITS}),
          });
          else if (size.width < 44 || size.height < 44) addItem(auditIssues, {
            category: 'touch', severity: 'warning', id: node.id,
            name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
            message: clean('Touch target ' + size.width + 'x' + size.height
              + 'px < 44x44 recommended', ${MAX_MESSAGE_CODE_UNITS}),
          });
        }
      }
      if (children) {
        for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      }
    }

    let data;
    if (request.action === 'contrast') {
      const passing = contrastItems.filter((item) => request.level === 'AAA' ? item.aaa : item.aa);
      const issues = contrastItems.filter((item) => request.level === 'AAA' ? !item.aaa : !item.aa);
      data = {
        level: request.level, total: contrastItems.length,
        passing: passing.length, failing: issues.length, issues, all: contrastItems,
      };
    } else if (request.action === 'touch') {
      data = {
        minSize: request.minimum, total: touchItems.total || 0,
        passing: touchItems.passing || 0, failing: touchItems.length,
        critical: touchItems.critical || 0, issues: touchItems,
      };
    } else if (request.action === 'text') {
      const errors = textItems.filter((item) => item.issues.some(
        (issue) => issue.severity === 'error')).length;
      const warnings = textItems.filter((item) => item.issues.some(
        (issue) => issue.severity === 'warning') && !item.issues.some(
        (issue) => issue.severity === 'error')).length;
      data = {
        total: textItems.total || 0, errors, warnings,
        passing: (textItems.total || 0) - textItems.length, issues: textItems,
      };
    } else if (request.action === 'focus') {
      focusItems.sort((left, right) => {
        const rowDifference = Math.abs(left.y - right.y);
        return rowDifference < 20 ? left.x - right.x : left.y - right.y;
      });
      let tabOrder = 0;
      for (const item of focusItems) {
        if (item.role === 'interactive') { tabOrder += 1; item.tabOrder = tabOrder; }
      }
      const issues = [];
      for (let index = 1; index < focusItems.length; index++) {
        const previous = focusItems[index - 1];
        const current = focusItems[index];
        if (current.y < previous.y - 50 && current.role === 'interactive'
          && previous.role === 'interactive') addItem(issues, {
          element: current.name,
          message: clean('May be reached before visually higher element "'
            + previous.name + '"', ${MAX_MESSAGE_CODE_UNITS}),
          severity: 'warning',
        });
      }
      data = { total: focusItems.length, interactive: tabOrder, order: focusItems, issues };
    } else {
      const errors = auditIssues.filter((issue) => issue.severity === 'error');
      const warnings = auditIssues.filter((issue) => issue.severity === 'warning');
      const breakdown = {};
      for (const category of ['contrast', 'text', 'touch']) {
        const items = auditIssues.filter((issue) => issue.category === category);
        breakdown[category] = {
          issues: items.length,
          errors: items.filter((issue) => issue.severity === 'error').length,
        };
      }
      data = {
        score: auditIssues.length === 0 ? 'A+' : errors.length === 0 ? 'B'
          : errors.length <= 3 ? 'C' : 'D',
        level: request.level,
        summary: {
          textNodes: auditTextCount, interactiveElements: auditInteractiveCount,
          errors: errors.length, warnings: warnings.length,
        },
        breakdown,
        issues: auditIssues,
      };
    }
    return bounded({ schemaVersion: 1, action: request.action, visited, data });
  })()`;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE_TEXT_CONTROLS.test(value);
}
function id(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function count(value, maximum = MAX_A11Y_READ_ITEMS) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function finite(value, minimum = -MAX_ABSOLUTE_NODE_COORDINATE * 2,
  maximum = MAX_ABSOLUTE_NODE_COORDINATE * 2) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}
function hex(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value); }
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function validContrastItem(item) {
  return exact(item, [
    'id', 'name', 'text', 'fontSize', 'isLarge', 'fgColor', 'bgColor',
    'ratio', 'aa', 'aaa',
  ]) && id(item.id) && text(item.name, MAX_NAME_CODE_UNITS)
    && text(item.text, 50) && finite(item.fontSize, 0)
    && typeof item.isLarge === 'boolean' && hex(item.fgColor) && hex(item.bgColor)
    && finite(item.ratio, 1, 21) && typeof item.aa === 'boolean'
    && typeof item.aaa === 'boolean';
}
function validContrast(data, input) {
  if (!exact(data, ['level', 'total', 'passing', 'failing', 'issues', 'all'])
    || data.level !== input.level || !count(data.total) || !count(data.passing)
    || !count(data.failing) || data.passing + data.failing !== data.total
    || !Array.isArray(data.all) || data.all.length !== data.total
    || !data.all.every(validContrastItem) || !Array.isArray(data.issues)
    || data.issues.length !== data.failing || !data.issues.every(validContrastItem)) return false;
  const expected = data.all.filter((item) => input.level === 'AAA' ? !item.aaa : !item.aa);
  return sameJson(expected, data.issues);
}
function validTouchItem(item, minimum) {
  if (!exact(item, [
    'id', 'name', 'type', 'width', 'height', 'pass', 'wcag248', 'issue',
  ]) || !id(item.id) || !text(item.name, MAX_NAME_CODE_UNITS)
    || !text(item.type, 64, false) || !finite(item.width, 0) || !finite(item.height, 0)
    || item.pass !== false || typeof item.wcag248 !== 'boolean'
    || !['both', 'width', 'height'].includes(item.issue)) return false;
  const issue = item.width < minimum && item.height < minimum
    ? 'both' : item.width < minimum ? 'width' : item.height < minimum ? 'height' : null;
  return issue === item.issue && item.wcag248 === (item.width >= 24 && item.height >= 24);
}
function validTouch(data, input) {
  return exact(data, ['minSize', 'total', 'passing', 'failing', 'critical', 'issues'])
    && data.minSize === input.minimum && data.minSize <= MAX_A11Y_TOUCH_MINIMUM
    && count(data.total, MAX_A11Y_READ_NODES) && count(data.passing, MAX_A11Y_READ_NODES)
    && count(data.failing) && data.passing + data.failing === data.total
    && count(data.critical, MAX_A11Y_READ_NODES) && data.critical <= data.total
    && Array.isArray(data.issues) && data.issues.length === data.failing
    && data.issues.every((item) => validTouchItem(item, input.minimum));
}
function validTextIssue(issue) {
  return exact(issue, ['rule', 'message', 'severity'])
    && ['min-size', 'line-height', 'paragraph-spacing', 'letter-spacing', 'all-caps']
      .includes(issue.rule)
    && text(issue.message, MAX_MESSAGE_CODE_UNITS, false)
    && ['error', 'warning'].includes(issue.severity);
}
function validTextItem(item) {
  return exact(item, [
    'id', 'name', 'text', 'fontSize', 'lineHeight', 'lineHeightRatio', 'issues',
  ]) && id(item.id) && text(item.name, MAX_NAME_CODE_UNITS) && text(item.text, 40)
    && (item.fontSize === null || finite(item.fontSize, 0))
    && (item.lineHeight === null || finite(item.lineHeight, 0))
    && (item.lineHeightRatio === null || finite(item.lineHeightRatio, 0))
    && Array.isArray(item.issues) && item.issues.length > 0 && item.issues.length <= 5
    && item.issues.every(validTextIssue);
}
function validText(data) {
  if (!exact(data, ['total', 'errors', 'warnings', 'passing', 'issues'])
    || !count(data.total, MAX_A11Y_READ_NODES) || !count(data.errors)
    || !count(data.warnings) || !count(data.passing, MAX_A11Y_READ_NODES)
    || data.errors + data.warnings + data.passing !== data.total
    || !Array.isArray(data.issues) || data.issues.length !== data.errors + data.warnings
    || !data.issues.every(validTextItem)) return false;
  const errors = data.issues.filter((item) => item.issues.some(
    (issue) => issue.severity === 'error')).length;
  return errors === data.errors && data.issues.length - errors === data.warnings;
}
function validFocusItem(item, interactiveOrder) {
  const isInteractive = item?.role === 'interactive';
  const keys = ['id', 'name', 'type', 'role', 'x', 'y', 'width', 'height',
    ...(isInteractive ? ['tabOrder'] : [])];
  return exact(item, keys) && id(item.id) && text(item.name, MAX_NAME_CODE_UNITS)
    && text(item.type, 64, false) && ['interactive', 'text'].includes(item.role)
    && finite(item.x) && finite(item.y) && finite(item.width, 0) && finite(item.height, 0)
    && (!isInteractive || item.tabOrder === interactiveOrder);
}
function validFocus(data) {
  if (!exact(data, ['total', 'interactive', 'order', 'issues'])
    || !count(data.total) || !count(data.interactive)
    || !Array.isArray(data.order) || data.order.length !== data.total
    || !Array.isArray(data.issues) || data.issues.length > data.total) return false;
  let order = 0;
  for (const item of data.order) {
    if (item?.role === 'interactive') order += 1;
    if (!validFocusItem(item, order)) return false;
  }
  if (order !== data.interactive || !data.issues.every((issue) => exact(
    issue, ['element', 'message', 'severity'])
    && text(issue.element, MAX_NAME_CODE_UNITS)
    && text(issue.message, MAX_MESSAGE_CODE_UNITS, false)
    && issue.severity === 'warning')) return false;
  const expected = [];
  for (let index = 1; index < data.order.length; index++) {
    const previous = data.order[index - 1];
    const current = data.order[index];
    if (current.y < previous.y - 50 && current.role === 'interactive'
      && previous.role === 'interactive') expected.push({
      element: current.name,
      message: `May be reached before visually higher element "${previous.name}"`,
      severity: 'warning',
    });
  }
  return sameJson(expected, data.issues);
}
function validAuditIssue(issue) {
  if (!issue || !['contrast', 'text', 'touch'].includes(issue.category)) return false;
  const hasDetails = issue.category === 'contrast';
  if (!exact(issue, [
    'category', 'severity', 'id', 'name', 'message', ...(hasDetails ? ['details'] : []),
  ]) || !['error', 'warning'].includes(issue.severity) || !id(issue.id)
    || !text(issue.name, MAX_NAME_CODE_UNITS)
    || !text(issue.message, MAX_MESSAGE_CODE_UNITS, false)) return false;
  return !hasDetails || (exact(issue.details, ['ratio', 'required', 'fg', 'bg', 'fontSize'])
    && finite(issue.details.ratio, 1, 21) && [3, 4.5, 7].includes(issue.details.required)
    && hex(issue.details.fg) && hex(issue.details.bg) && finite(issue.details.fontSize, 0));
}
function validAudit(data, input) {
  if (!exact(data, ['score', 'level', 'summary', 'breakdown', 'issues'])
    || !['A+', 'B', 'C', 'D'].includes(data.score) || data.level !== input.level
    || !exact(data.summary, [
      'textNodes', 'interactiveElements', 'errors', 'warnings',
    ]) || !count(data.summary.textNodes, MAX_A11Y_READ_NODES)
    || !count(data.summary.interactiveElements, MAX_A11Y_READ_NODES)
    || !count(data.summary.errors) || !count(data.summary.warnings)
    || !exact(data.breakdown, ['contrast', 'text', 'touch'])
    || !Array.isArray(data.issues) || data.issues.length > MAX_A11Y_READ_ITEMS
    || !data.issues.every(validAuditIssue)) return false;
  const errors = data.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = data.issues.length - errors;
  if (errors !== data.summary.errors || warnings !== data.summary.warnings) return false;
  for (const category of ['contrast', 'text', 'touch']) {
    const fact = data.breakdown[category];
    const items = data.issues.filter((issue) => issue.category === category);
    if (!exact(fact, ['issues', 'errors']) || fact.issues !== items.length
      || fact.errors !== items.filter((issue) => issue.severity === 'error').length) return false;
  }
  const score = data.issues.length === 0 ? 'A+' : errors === 0 ? 'B' : errors <= 3 ? 'C' : 'D';
  return data.score === score;
}
function validPayload(value, input) {
  return exact(value, ['schemaVersion', 'action', 'visited', 'data'])
    && value.schemaVersion === 1 && value.action === input.action
    && count(value.visited, MAX_A11Y_READ_NODES)
    && (value.action === 'contrast' ? validContrast(value.data, input)
      : value.action === 'touch' ? validTouch(value.data, input)
        : value.action === 'text' ? validText(value.data)
          : value.action === 'focus' ? validFocus(value.data)
            : validAudit(value.data, input));
}
function safeText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ');
}

export function formatA11yReadResult(payload, { json = false } = {}) {
  const result = payload.data;
  if (json) return JSON.stringify(result, null, 2);
  if (payload.action === 'contrast') {
    const lines = [
      `Contrast Check (WCAG ${result.level})`, '',
      `✓ Pass: ${result.passing}/${result.total}   ✗ Fail: ${result.failing}/${result.total}`,
    ];
    if (result.issues.length > 0) {
      lines.push('', 'Failing elements:');
      for (const issue of result.issues) {
        const needed = issue.isLarge
          ? (result.level === 'AAA' ? '4.5:1' : '3:1')
          : (result.level === 'AAA' ? '7:1' : '4.5:1');
        lines.push('', `✗ ${safeText(issue.name)} - "${safeText(issue.text)}"`,
          `  Ratio: ${issue.ratio.toFixed(2)}:1 (need ${needed})  FG: ${issue.fgColor}  BG: ${issue.bgColor}  Size: ${issue.fontSize}px${issue.isLarge ? ' (large)' : ''}`,
          `  ID: ${issue.id}`);
      }
    } else lines.push('', `All text passes WCAG ${result.level}! ✓`);
    return lines.join('\n');
  }
  if (payload.action === 'touch') {
    const lines = [
      `Touch Target Check (min ${result.minSize}x${result.minSize}px)`, '',
      `✓ Pass: ${result.passing}/${result.total}   ✗ Fail: ${result.failing}/${result.total}   ⚠ Critical (<24px): ${result.critical}`,
    ];
    if (result.issues.length > 0) {
      lines.push('', 'Undersized targets:');
      for (const issue of result.issues) lines.push(
        `${issue.wcag248 ? '✗' : '⚠'} ${safeText(issue.name)} (${issue.type})  ${issue.width}x${issue.height}px  ID: ${issue.id}`);
    } else lines.push('', 'All interactive elements meet minimum size! ✓');
    return lines.join('\n');
  }
  if (payload.action === 'text') {
    const lines = [
      'Text Accessibility Check', '',
      `✓ Pass: ${result.passing}/${result.total}   ✗ Errors: ${result.errors}   ⚠ Warnings: ${result.warnings}`,
    ];
    if (result.issues.length > 0) {
      for (const item of result.issues) {
        const icon = item.issues.some((issue) => issue.severity === 'error') ? '✗' : '⚠';
        lines.push('', `${icon} ${safeText(item.name)} - "${safeText(item.text)}"  ${item.fontSize}px${item.lineHeightRatio ? ` / ${item.lineHeightRatio}x` : ''}`);
        for (const issue of item.issues) lines.push(`  ${safeText(issue.message)}`);
        lines.push(`  ID: ${item.id}`);
      }
    } else lines.push('', 'All text passes accessibility checks! ✓');
    return lines.join('\n');
  }
  if (payload.action === 'focus') {
    const lines = [
      'Focus / Reading Order', '',
      `Total elements: ${result.total}   Interactive: ${result.interactive}`, '',
    ];
    let tab = 0;
    for (const item of result.order) {
      if (item.role === 'interactive') {
        tab += 1;
        lines.push(`${String(tab).padStart(3)}  ${safeText(item.name)} (${item.type})  at ${item.x},${item.y}  ${item.width}x${item.height}px`);
      } else lines.push(`  -  ${safeText(item.name)}  at ${item.x},${item.y}`);
    }
    if (result.issues.length > 0) {
      lines.push('', 'Potential order issues:', '');
      for (const issue of result.issues) lines.push(`⚠ ${safeText(issue.message)}`);
    }
    return lines.join('\n');
  }
  const lines = [
    `Accessibility Audit (WCAG ${result.level})`, '',
    `Score: ${result.score}   (${result.summary.textNodes} text nodes, ${result.summary.interactiveElements} interactive elements)`, '',
  ];
  for (const [category, label] of [
    ['contrast', 'Contrast'], ['text', 'Text'], ['touch', 'Touch Target'],
  ]) {
    const fact = result.breakdown[category];
    const warnings = fact.issues - fact.errors;
    lines.push(`${fact.errors > 0 ? '✗' : warnings > 0 ? '⚠' : '✓'} ${label.padEnd(12)} ${fact.issues === 0 ? 'Pass' : `${fact.errors} errors${warnings > 0 ? `, ${warnings} warnings` : ''}`}`);
  }
  if (result.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const [category, label] of [
      ['contrast', 'Contrast'], ['text', 'Text'], ['touch', 'Touch Targets'],
    ]) {
      const issues = result.issues.filter((issue) => issue.category === category);
      if (issues.length === 0) continue;
      lines.push('', `${label}:`);
      for (const issue of issues) lines.push(
        `${issue.severity === 'error' ? '✗' : '⚠'} ${safeText(issue.name)} - ${safeText(issue.message)}  ID: ${issue.id}`);
    }
  } else lines.push('', 'Perfect score! No accessibility issues found. ✓');
  return lines.join('\n');
}

export async function executeA11yRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('A11y read requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(a11yReadCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_A11Y_READ_RESULT_CODE_UNITS) {
    throw new Error('A11y read returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('A11y read returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('A11y read returned an invalid bounded result.');
  }
  const issueCount = input.action === 'focus' ? 0 : payload.data.issues.length;
  return {
    stdout: formatA11yReadResult(payload, { json: input.json }),
    stderr: input.warning || '',
    code: input.failOnIssues && issueCount > 0 ? 1 : 0,
    result: payload,
  };
}

export function a11yReadPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('A11y read routing requires a Command Plan.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-a11y-read';
}

export function executeA11yReadPlan(plan, adapters = {}) {
  if (a11yReadPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by A11y read.');
  }
  return executeA11yRead(parseA11yReadRequest(plan.argv), adapters);
}
