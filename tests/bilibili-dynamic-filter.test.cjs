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
    { enabled: false, rulesText: '广告', showStatusPanel: true },
  );
});

test('preserves an explicitly disabled status panel setting', () => {
  const { normalizeConfig } = loadTestApi();

  assert.equal(normalizeConfig({ showStatusPanel: false }).showStatusPanel, false);
  assert.equal(normalizeConfig(null).showStatusPanel, true);
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

test('publishes a metadata endpoint and a legacy update bridge', () => {
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
  const legacyPath = path.join(
    __dirname,
    '..',
    'scripts',
    'bilibili-dynamic-filter.user.js',
  );
  const source = fs.readFileSync(scriptPath, 'utf8');
  const metadataSource = fs.readFileSync(metadataPath, 'utf8');
  const legacySource = fs.readFileSync(legacyPath, 'utf8');
  const scriptMetadata = readScriptMetadata(source);
  const updateMetadata = readScriptMetadata(metadataSource);

  assert.equal(
    scriptMetadata.updateURL,
    'https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili/bilibili-dynamic-filter.meta.js',
  );
  assert.equal(updateMetadata.version, scriptMetadata.version);
  assert.equal(updateMetadata.downloadURL, scriptMetadata.downloadURL);
  assert.equal(legacySource, source);
});
