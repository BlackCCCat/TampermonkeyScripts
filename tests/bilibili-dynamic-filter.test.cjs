const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTestApi() {
  const scriptPath = path.join(
    __dirname,
    '..',
    'scripts',
    'bilibili',
    'bilibili-dynamic-filter.user.js',
  );
  const source = fs.readFileSync(scriptPath, 'utf8');
  const sandbox = {
    __BDF_TEST_MODE__: true,
    console,
  };

  vm.runInNewContext(source, sandbox, { filename: scriptPath });
  return sandbox.__BDF_TEST_EXPORTS__;
}

function readScriptMetadata(source) {
  return Object.fromEntries(
    Array.from(source.matchAll(/^\/\/\s+@(\S+)\s+(.+)$/gm), ([, key, value]) => [
      key,
      value.trim(),
    ]),
  );
}

test('parses keywords, comments, and regular expressions', () => {
  const { parseRules } = loadTestApi();
  const result = parseRules(`
    广告
    # 这是一行注释
    /抽奖|推广/i
  `);

  assert.deepEqual(
    Array.from(result.rules, ({ type, source, flags }) => ({ type, source, flags })),
    [
      { type: 'keyword', source: '广告', flags: '' },
      { type: 'regex', source: '抽奖|推广', flags: 'i' },
    ],
  );
  assert.equal(result.errors.length, 0);
});

test('reports invalid regular expressions without discarding valid rules', () => {
  const { parseRules } = loadTestApi();
  const result = parseRules('正常关键字\n/(/');

  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].source, '正常关键字');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /第 2 行/);
});

test('matches keywords case-insensitively and returns the matched rule', () => {
  const { findMatch, parseRules } = loadTestApi();
  const { rules } = parseRules('SPONSOR');

  assert.deepEqual(
    { ...findMatch('A sponsor message', rules) },
    { type: 'keyword', source: 'SPONSOR', flags: '' },
  );
  assert.equal(findMatch('ordinary content', rules), null);
});

test('matches regular expressions repeatedly even with the global flag', () => {
  const { findMatch, parseRules } = loadTestApi();
  const { rules } = parseRules('/抽奖\\s*送/gi');

  assert.equal(findMatch('抽奖 送手机', rules)?.type, 'regex');
  assert.equal(findMatch('再次抽奖送礼物', rules)?.type, 'regex');
});

test('supports escaped slashes in regular expression literals', () => {
  const { findMatch, parseRules } = loadTestApi();
  const result = parseRules('/b23\\.tv\\/abc/i');

  assert.equal(result.errors.length, 0);
  assert.equal(findMatch('链接 B23.TV/ABC', result.rules)?.type, 'regex');
});

test('normalizes whitespace before matching', () => {
  const { findMatch, parseRules } = loadTestApi();
  const { rules } = parseRules('限时 优惠');

  assert.equal(findMatch('限时\n\t优惠', rules)?.source, '限时 优惠');
});

test('migrates existing configuration with the status panel enabled', () => {
  const { normalizeConfig } = loadTestApi();

  assert.deepEqual(
    { ...normalizeConfig({ enabled: false, rulesText: '广告' }) },
    {
      enabled: false,
      rulesText: '广告',
      showStatusPanel: true,
      filterVideoDynamics: true,
    },
  );
});

test('preserves an explicitly disabled status panel setting', () => {
  const { normalizeConfig } = loadTestApi();

  assert.equal(normalizeConfig({ showStatusPanel: false }).showStatusPanel, false);
  assert.equal(normalizeConfig(null).showStatusPanel, true);
});

test('preserves an explicitly disabled video filtering setting', () => {
  const { normalizeConfig } = loadTestApi();

  assert.equal(normalizeConfig({ filterVideoDynamics: false }).filterVideoDynamics, false);
  assert.equal(normalizeConfig(null).filterVideoDynamics, true);
});

test('classifies video dynamics from their card structure', () => {
  const { isVideoDynamic, videoSelector } = loadTestApi();
  const videoCard = {
    matches(selector) {
      assert.equal(selector, videoSelector);
      return false;
    },
    querySelector(selector) {
      assert.equal(selector, videoSelector);
      return {};
    },
  };
  const textCard = {
    matches() {
      return false;
    },
    querySelector() {
      return null;
    },
  };

  assert.equal(isVideoDynamic(videoCard), true);
  assert.equal(isVideoDynamic(textCard), false);
});

test('skips hiding matched videos only when video filtering is disabled', () => {
  const { shouldHideMatchedCard } = loadTestApi();

  assert.equal(shouldHideMatchedCard(false, false), true);
  assert.equal(shouldHideMatchedCard(true, true), true);
  assert.equal(shouldHideMatchedCard(true, false), false);
});

test('formats video match counts and marks unfiltered video matches', () => {
  const { formatStatusText } = loadTestApi();

  assert.equal(formatStatusText(3, 2, true), '已屏蔽 3 条动态 · 视频命中 2 条');
  assert.equal(
    formatStatusText(1, 4, false),
    '已屏蔽 1 条动态 · 视频命中 4 条（未过滤）',
  );
});

test('normalizes persisted status panel UI state', () => {
  const { normalizeUiState } = loadTestApi();
  const restored = normalizeUiState({
    compact: true,
    position: { x: 128.5, y: 64 },
  });

  assert.equal(restored.compact, true);
  assert.equal(restored.position.x, 128.5);
  assert.equal(restored.position.y, 64);
  assert.equal(normalizeUiState({ position: { x: '128', y: 64 } }).position, null);
  assert.equal(normalizeUiState(null).compact, false);
});

test('clamps a dragged panel inside the visible viewport', () => {
  const { clampPanelPosition } = loadTestApi();

  assert.deepEqual(
    { ...clampPanelPosition(
      { x: -20, y: 900 },
      { width: 800, height: 600 },
      { width: 280, height: 120 },
    ) },
    { x: 8, y: 472 },
  );
  assert.deepEqual(
    { ...clampPanelPosition(
      { x: 700, y: -10 },
      { width: 800, height: 600 },
      { width: 64, height: 44 },
    ) },
    { x: 700, y: 8 },
  );
});

test('distinguishes a drag from a click using a movement threshold', () => {
  const { isDragGesture } = loadTestApi();

  assert.equal(isDragGesture({ x: 10, y: 10 }, { x: 13, y: 14 }), true);
  assert.equal(isDragGesture({ x: 10, y: 10 }, { x: 12, y: 12 }), false);
});

test('persists compact mode and panel position with immediate readback', () => {
  const { persistUiState } = loadTestApi();
  const storage = new Map();
  const saved = persistUiState(
    'ui-key',
    { compact: true, position: { x: 120, y: 80 } },
    (key, value) => storage.set(key, value),
    (key, fallback) => storage.get(key) ?? fallback,
  );

  assert.equal(saved.compact, true);
  assert.equal(saved.position.x, 120);
  assert.equal(saved.position.y, 80);
  assert.equal(storage.get('ui-key').compact, true);
});

test('writes configuration to storage and verifies it by immediate readback', () => {
  const { persistConfig } = loadTestApi();
  const storage = new Map();
  const saved = persistConfig(
    'config-key',
    { enabled: true, rulesText: '广告', filterVideoDynamics: false },
    (key, value) => storage.set(key, value),
    (key, fallback) => storage.get(key) ?? fallback,
  );

  assert.equal(storage.get('config-key').filterVideoDynamics, false);
  assert.deepEqual({ ...saved }, { ...storage.get('config-key') });
});

test('reports a storage write that cannot be read back', () => {
  const { persistConfig } = loadTestApi();

  assert.throws(
    () => persistConfig(
      'config-key',
      {},
      () => {},
      (_key, fallback) => fallback,
    ),
    /配置写入 Tampermonkey Storage 后校验失败/,
  );
});

test('shows the status panel only for an active filter with rules', () => {
  const { shouldShowStatusPanel } = loadTestApi();

  assert.equal(
    shouldShowStatusPanel({ enabled: true, showStatusPanel: true }, 1),
    true,
  );
  assert.equal(
    shouldShowStatusPanel({ enabled: true, showStatusPanel: false }, 1),
    false,
  );
  assert.equal(
    shouldShowStatusPanel({ enabled: false, showStatusPanel: true }, 1),
    false,
  );
  assert.equal(
    shouldShowStatusPanel({ enabled: true, showStatusPanel: true }, 0),
    false,
  );
});

test('extracts text from forwarded and opus dynamic content', () => {
  const { contentSelector, extractCardText } = loadTestApi();
  const forwardedText = { innerText: '转发内容中的推广关键字' };
  const card = {
    querySelectorAll(selector) {
      assert.equal(selector, contentSelector);
      return [forwardedText];
    },
  };

  assert.match(contentSelector, /\.bili-dyn-content__forw__desc/);
  assert.match(contentSelector, /\.dyn-card-opus__summary/);
  assert.equal(extractCardText(card), '转发内容中的推广关键字');
});

test('does not duplicate text from nested content selectors', () => {
  const { extractCardText } = loadTestApi();
  const child = { innerText: '推广内容' };
  const parent = {
    innerText: '推广内容',
    contains(node) {
      return node === child;
    },
  };
  const card = {
    querySelectorAll() {
      return [parent, child];
    },
  };

  assert.equal(extractCardText(card), '推广内容');
});

test('publishes a matching metadata update endpoint', () => {
  const scriptPath = path.join(
    __dirname,
    '..',
    'scripts',
    'bilibili',
    'bilibili-dynamic-filter.user.js',
  );
  const metadataPath = path.join(
    __dirname,
    '..',
    'scripts',
    'bilibili',
    'bilibili-dynamic-filter.meta.js',
  );
  const source = fs.readFileSync(scriptPath, 'utf8');
  const metadataSource = fs.readFileSync(metadataPath, 'utf8');
  const scriptMetadata = readScriptMetadata(source);
  const updateMetadata = readScriptMetadata(metadataSource);

  assert.equal(
    scriptMetadata.updateURL,
    'https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili/bilibili-dynamic-filter.meta.js',
  );
  assert.equal(updateMetadata.version, scriptMetadata.version);
  assert.equal(updateMetadata.downloadURL, scriptMetadata.downloadURL);
});
