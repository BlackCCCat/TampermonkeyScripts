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
