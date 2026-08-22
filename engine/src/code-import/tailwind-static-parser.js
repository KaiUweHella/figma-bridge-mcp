// Data-only parser for the static subset of Tailwind configuration modules.
// It deliberately does not evaluate JavaScript. Only token-bearing theme
// fields are materialized; unrelated config expressions are scanned and
// discarded so content/plugin configuration remains compatible without
// receiving host privileges.

const THEME_KEYS = new Set(['colors', 'color', 'borderRadius', 'spacing', 'fontFamily', 'fontSize', 'extend']);

const EXTEND_KEYS = new Set(['colors', 'color', 'borderRadius', 'spacing', 'fontFamily', 'fontSize']);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

export class StaticTailwindSyntaxError extends Error {
  constructor(message, line, column, code = 'TAILWIND_STATIC_SYNTAX') {
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'StaticTailwindSyntaxError';
    this.code = code;
  }
}

class Parser {
  constructor(source, limits) {
    this.source = source;
    this.index = 0;
    this.depth = 0;
    this.entries = 0;
    this.limits = limits;
  }

  location() {
    const before = this.source.slice(0, this.index);
    const lines = before.split('\n');
    return { line: lines.length, column: lines.at(-1).length + 1 };
  }

  error(message, code) {
    const { line, column } = this.location();
    throw new StaticTailwindSyntaxError(message, line, column, code);
  }

  skipTrivia() {
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (/\s/.test(char)) {
        this.index++;
        continue;
      }
      if (this.source.startsWith('//', this.index)) {
        const newline = this.source.indexOf('\n', this.index + 2);
        this.index = newline === -1 ? this.source.length : newline + 1;
        continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end === -1) this.error('Unterminated comment');
        this.index = end + 2;
        continue;
      }
      break;
    }
  }

  wordAt(word) {
    this.skipTrivia();
    if (!this.source.startsWith(word, this.index)) return false;
    const before = this.source[this.index - 1];
    const after = this.source[this.index + word.length];
    return (!before || !IDENTIFIER_PART.test(before)) && (!after || !IDENTIFIER_PART.test(after));
  }

  consumeWord(word) {
    if (!this.wordAt(word)) this.error(`Expected ${word}`);
    this.index += word.length;
  }

  consume(char) {
    this.skipTrivia();
    if (!this.source.startsWith(char, this.index)) this.error(`Expected ${char}`);
    this.index += char.length;
  }

  maybe(char) {
    this.skipTrivia();
    if (!this.source.startsWith(char, this.index)) return false;
    this.index += char.length;
    return true;
  }

  readIdentifier() {
    this.skipTrivia();
    if (!IDENTIFIER_START.test(this.source[this.index] || '')) this.error('Expected an identifier');
    const start = this.index++;
    while (IDENTIFIER_PART.test(this.source[this.index] || '')) this.index++;
    return this.source.slice(start, this.index);
  }

  enterCollection() {
    this.depth++;
    if (this.depth > this.limits.maxDepth) {
      this.error(`Static configuration nesting exceeds ${this.limits.maxDepth}`, 'TAILWIND_STATIC_DEPTH');
    }
  }

  leaveCollection() {
    this.depth--;
  }

  recordEntry() {
    this.entries++;
    if (this.entries > this.limits.maxEntries) {
      this.error(`Static configuration collection exceeds ${this.limits.maxEntries} entries`, 'TAILWIND_STATIC_ENTRIES');
    }
  }

  shouldMaterialize(path, key) {
    if (path.length === 0) return key === 'theme';
    if (path.length === 1 && path[0] === 'theme') return THEME_KEYS.has(key);
    if (path.length === 2 && path[0] === 'theme' && path[1] === 'extend') {
      return EXTEND_KEYS.has(key);
    }
    return true;
  }

  parseModule() {
    this.skipTrivia();
    while (this.wordAt('import')) {
      this.consumeWord('import');
      this.skipImport();
      this.skipTrivia();
    }

    let config;
    if (this.wordAt('export')) {
      this.consumeWord('export');
      if (this.wordAt('default')) this.consumeWord('default');
      else this.consume('=');
      config = this.parseRootObject();
      this.parseTypeSuffix();
    } else if (this.wordAt('module')) {
      this.consumeWord('module');
      this.consume('.');
      this.consumeWord('exports');
      this.consume('=');
      config = this.parseRootObject();
      this.parseTypeSuffix();
    } else if (this.wordAt('const')) {
      config = this.parseConstExport();
    } else {
      this.error('Expected export default, export =, module.exports, or a static exported const');
    }

    this.maybe(';');
    this.skipTrivia();
    if (this.index !== this.source.length) this.error('Unexpected executable statement after the configuration export');
    return config;
  }

  skipImport() {
    let quote = null;
    let escaped = false;
    let sawModuleSpecifier = false;
    let nested = 0;
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) {
          quote = null;
          sawModuleSpecifier = true;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === '{' || char === '[' || char === '(') nested++;
      else if (char === '}' || char === ']' || char === ')') nested--;
      if (char === ';') return;
      if (char === '\n' && nested === 0 && sawModuleSpecifier) return;
    }
    if (sawModuleSpecifier && nested === 0) return;
    this.error('Import declaration is incomplete');
  }

  parseConstExport() {
    this.consumeWord('const');
    const name = this.readIdentifier();
    if (this.maybe(':')) this.skipTypeUntil('=');
    this.consume('=');
    const config = this.parseRootObject();
    this.parseTypeSuffix({ stopBeforeExport: true });
    this.maybe(';');
    this.skipTrivia();

    let exported;
    if (this.wordAt('export')) {
      this.consumeWord('export');
      this.consumeWord('default');
      exported = this.readIdentifier();
    } else if (this.wordAt('module')) {
      this.consumeWord('module');
      this.consume('.');
      this.consumeWord('exports');
      this.consume('=');
      exported = this.readIdentifier();
    } else {
      this.error('Static const configuration must be exported directly');
    }
    if (exported !== name) this.error('Exported identifier does not match the static configuration const');
    return config;
  }

  parseTypeSuffix({ stopBeforeExport = false } = {}) {
    this.skipTrivia();
    if (this.wordAt('satisfies')) {
      this.consumeWord('satisfies');
      this.skipTypeUntil(';', { allowEnd: true, stopBeforeExport });
    } else if (this.wordAt('as')) {
      this.consumeWord('as');
      this.skipTypeUntil(';', { allowEnd: true, stopBeforeExport });
    }
  }

  skipTypeUntil(terminator, { allowEnd = false, stopBeforeExport = false } = {}) {
    const allowed = /[A-Za-z0-9_$\.<>\[\]|&,?\s]/;
    let sawType = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === terminator) {
        if (!sawType) this.error('Expected a static TypeScript type reference');
        return;
      }
      if (char === '\n' && stopBeforeExport) {
        const next = this.source.slice(this.index + 1).trimStart();
        if (/^(?:export\b|module\s*\.)/.test(next)) {
          if (!sawType) this.error('Expected a static TypeScript type reference');
          return;
        }
      }
      if (!allowed.test(char)) this.error('Unsupported TypeScript type expression');
      if (!/\s/.test(char)) sawType = true;
      this.index++;
    }
    if (!allowEnd) this.error(`Expected ${terminator} after the TypeScript type reference`);
    if (!sawType) this.error('Expected a static TypeScript type reference');
  }

  parseRootObject() {
    this.skipTrivia();
    if (this.source[this.index] !== '{') {
      this.error('Tailwind configuration export must be a static object literal');
    }
    return this.parseObject([]);
  }

  parseObject(path) {
    this.consume('{');
    this.enterCollection();
    const result = Object.create(null);
    const materialized = new Set();
    this.skipTrivia();
    while (!this.maybe('}')) {
      const key = this.readPropertyKey();
      this.consume(':');
      this.recordEntry();
      if (this.shouldMaterialize(path, key)) {
        if (materialized.has(key)) this.error(`Duplicate static property ${key}`);
        materialized.add(key);
        const value = this.parseValue([...path, key]);
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      } else {
        this.skipIgnoredValue();
      }
      this.skipTrivia();
      if (this.maybe(',')) {
        this.skipTrivia();
        if (this.maybe('}')) break;
      } else {
        this.consume('}');
        break;
      }
    }
    this.leaveCollection();
    return result;
  }

  readPropertyKey() {
    this.skipTrivia();
    const char = this.source[this.index];
    if (char === "'" || char === '"') return this.readString();
    if (char === '`') return this.readTemplate();
    if (IDENTIFIER_START.test(char || '')) return this.readIdentifier();
    const number = this.readNumber({ property: true });
    if (number !== null) return String(number);
    this.error('Static object properties must use literal keys');
  }

  parseArray(path) {
    this.consume('[');
    this.enterCollection();
    const result = [];
    this.skipTrivia();
    while (!this.maybe(']')) {
      this.recordEntry();
      result.push(this.parseValue([...path, String(result.length)]));
      this.skipTrivia();
      if (this.maybe(',')) {
        this.skipTrivia();
        if (this.maybe(']')) break;
      } else {
        this.consume(']');
        break;
      }
    }
    this.leaveCollection();
    return result;
  }

  parseValue(path) {
    this.skipTrivia();
    const char = this.source[this.index];
    if (char === '{') return this.parseObject(path);
    if (char === '[') return this.parseArray(path);
    if (char === "'" || char === '"') return this.readString();
    if (char === '`') return this.readTemplate();

    const number = this.readNumber();
    if (number !== null) return number;
    if (this.wordAt('true')) {
      this.consumeWord('true');
      return true;
    }
    if (this.wordAt('false')) {
      this.consumeWord('false');
      return false;
    }
    if (this.wordAt('null')) {
      this.consumeWord('null');
      return null;
    }
    this.error('Token-bearing Tailwind theme values must be static data');
  }

  readNumber({ property = false } = {}) {
    this.skipTrivia();
    const remaining = this.source.slice(this.index);
    const match = remaining.match(/^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
    if (!match) return null;
    const next = remaining[match[0].length];
    if (!property && next && IDENTIFIER_PART.test(next)) this.error('Unsupported numeric literal');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.error('Numeric literal is outside the supported range');
    return value;
  }

  readString() {
    this.skipTrivia();
    const quote = this.source[this.index++];
    let result = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return result;
      if (char === '\n' || char === '\r') this.error('Unterminated string literal');
      if (char !== '\\') {
        result += char;
        continue;
      }
      if (this.index >= this.source.length) this.error('Unterminated string escape');
      const escaped = this.source[this.index++];
      const simple = {
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        0: '\0',
        '\\': '\\',
        "'": "'",
        '"': '"',
      };
      if (Object.hasOwn(simple, escaped)) {
        result += simple[escaped];
      } else if (escaped === 'x') {
        result += this.readHexEscape(2);
      } else if (escaped === 'u') {
        result += this.readUnicodeEscape();
      } else if (escaped === '\n') {
        // JavaScript line continuation contributes no character.
      } else {
        result += escaped;
      }
    }
    this.error('Unterminated string literal');
  }

  readHexEscape(length) {
    const hex = this.source.slice(this.index, this.index + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) this.error('Invalid hexadecimal string escape');
    this.index += length;
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }

  readUnicodeEscape() {
    if (this.source[this.index] === '{') {
      const end = this.source.indexOf('}', this.index + 1);
      if (end === -1) this.error('Invalid Unicode string escape');
      const hex = this.source.slice(this.index + 1, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) this.error('Invalid Unicode string escape');
      const value = Number.parseInt(hex, 16);
      if (value > 0x10ffff) this.error('Unicode string escape is outside the valid range');
      this.index = end + 1;
      return String.fromCodePoint(value);
    }
    return this.readHexEscape(4);
  }

  readTemplate() {
    this.skipTrivia();
    this.index++;
    let result = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === '`') return result;
      if (char === '$' && this.source[this.index] === '{') {
        this.error('Template interpolation is executable and not static data');
      }
      if (char === '\\') {
        if (this.index >= this.source.length) this.error('Unterminated template escape');
        result += this.source[this.index++];
      } else {
        result += char;
      }
    }
    this.error('Unterminated template literal');
  }

  skipIgnoredValue() {
    this.skipTrivia();
    const stack = [];
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (stack.length === 0 && (char === ',' || char === '}')) return;
      if (char === "'" || char === '"' || char === '`') {
        this.skipOpaqueQuoted(char);
        continue;
      }
      if (this.source.startsWith('//', this.index) || this.source.startsWith('/*', this.index)) {
        this.skipTrivia();
        continue;
      }
      if (char === '{' || char === '[' || char === '(') {
        stack.push(char);
        this.recordEntry();
        if (stack.length > this.limits.maxDepth) {
          this.error(`Static configuration nesting exceeds ${this.limits.maxDepth}`, 'TAILWIND_STATIC_DEPTH');
        }
        this.index++;
        continue;
      }
      if (char === '}' || char === ']' || char === ')') {
        const expected = char === '}' ? '{' : char === ']' ? '[' : '(';
        if (stack.at(-1) !== expected) this.error('Unbalanced expression in ignored Tailwind field');
        stack.pop();
        this.index++;
        continue;
      }
      if (char === ',') this.recordEntry();
      this.index++;
    }
    if (stack.length) this.error('Unterminated expression in ignored Tailwind field');
  }

  skipOpaqueQuoted(quote) {
    this.index++;
    let escaped = false;
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        return;
      }
    }
    this.error('Unterminated literal in ignored Tailwind field');
  }
}

export function parseStaticTailwindModule(source, limits) {
  if (typeof source !== 'string') {
    throw new StaticTailwindSyntaxError('Tailwind source must be text', 1, 1);
  }
  return new Parser(source, limits).parseModule();
}
