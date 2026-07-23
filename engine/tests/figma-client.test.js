import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

// ----------------------------------------------------------------
// 1. URL Pattern Matching
// ----------------------------------------------------------------
describe('URL pattern matching', () => {
  const isDesignPage = (url) =>
    url != null && /figma\.com\/(design|file)\//.test(url);

  it('should match design URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME'), true);
  });

  it('should match file URLs', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/file/PLACEHOLDERFILEKEY/FILE_NAME'), true);
  });

  it('should NOT match /files/feed', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/files/feed'), false);
  });

  it('should NOT match /files/team/recents', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/files/team/123/recents'), false);
  });

  it('should NOT match /desktop_new_tab', () => {
    assert.strictEqual(isDesignPage('https://www.figma.com/desktop_new_tab'), false);
  });

  it('should NOT match null', () => {
    assert.strictEqual(isDesignPage(null), false);
  });

  it('should NOT match undefined', () => {
    assert.strictEqual(isDesignPage(undefined), false);
  });

  it('should NOT match empty string', () => {
    assert.strictEqual(isDesignPage(''), false);
  });
});

// ----------------------------------------------------------------
// 2. File Type Detection
// ----------------------------------------------------------------
describe('file type detection', () => {
  const extractFileType = (url) => {
    const match = url.match(/figma\.com\/(design|file)\//);
    return match ? match[1] : 'unknown';
  };

  it('should detect design type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME'), 'design');
  });

  it('should detect file type', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/file/PLACEHOLDERFILEKEY/FILE_NAME'), 'file');
  });

  it('should return unknown for other URLs', () => {
    assert.strictEqual(extractFileType('https://www.figma.com/files/feed'), 'unknown');
  });
});

// ----------------------------------------------------------------
// 3. FigmaClient Properties
// ----------------------------------------------------------------
describe('FigmaClient properties', () => {
  it('should initialize with null pageUrl', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.pageUrl, null);
  });

  it('should initialize with null fileType', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.fileType, null);
  });

  it('should initialize with null pageTitle', () => {
    const client = new FigmaClient();
    assert.strictEqual(client.pageTitle, null);
  });
});
