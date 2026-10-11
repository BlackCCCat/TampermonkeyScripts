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

function readUserScriptSource() {
  return fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'bilibili',
    'bilibili-dynamic-filter.user.js',
  ), 'utf8');
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
  const result = parseRules(`广告\n# 这是一行注释\n/抽奖|推广/i`);

  assert.deepEqual(
    Array.from(result.rules, ({ type, source, flags }) => ({ type, source, flags })),
    [
      { type: 'keyword', source: '广告', flags: '' },
      { type: 'regex', source: '抽奖|推广', flags: 'i' },
    ],
  );
  assert.equal(result.errors.length, 0);
});

test('parses comma-separated keywords and one-regex-per-line rules', () => {
  const { formatRulesText, parseRules } = loadTestApi();
  const result = parseRules('广告，美团, 带货\n/\\d{1,3}元|淘宝/i\n# 暂停使用');

  assert.deepEqual(
    Array.from(result.rules, ({ type, source: ruleSource, flags }) => ({
      type,
      source: ruleSource,
      flags,
    })),
    [
      { type: 'keyword', source: '广告', flags: '' },
      { type: 'keyword', source: '美团', flags: '' },
      { type: 'keyword', source: '带货', flags: '' },
      { type: 'regex', source: '\\d{1,3}元|淘宝', flags: 'i' },
    ],
  );
  assert.equal(result.errors.length, 0);
});

test('does not split commas inside a regex that spans its own line', () => {
  const { parseRules } = loadTestApi();
  const result = parseRules('美团\n/\\d{1,3}元|淘宝/i');

  assert.deepEqual(
    Array.from(result.rules, ({ type, source }) => ({ type, source })),
    [
      { type: 'keyword', source: '美团' },
      { type: 'regex', source: '\\d{1,3}元|淘宝' },
    ],
  );
  assert.equal(result.errors.length, 0);
});

test('formats rules with keywords on one line and each regex on its own line', () => {
  const { formatRulesText } = loadTestApi();

  assert.equal(
    formatRulesText('广告\n美团, /\\d{1,3}元/i'),
    '广告, 美团\n/\\d{1,3}元/i',
  );
  assert.equal(
    formatRulesText('# 注释\n推广\n/抽奖|推广/i'),
    '# 注释\n推广\n/抽奖|推广/i',
  );
  assert.equal(
    formatRulesText('/抽奖/i\n广告, 带货'),
    '广告, 带货\n/抽奖/i',
  );
  assert.equal(formatRulesText('广告，美团，/推广/i'), '广告, 美团\n/推广/i');
});

test('groups formatted rules into comments, keywords, and regexes', () => {
  const { groupRuleEntries } = loadTestApi();

  const newFormat = groupRuleEntries('# 注释\n广告, 带货\n/抽奖/i\n/推广/i\n/\\d{1,3}元/i');
  assert.deepEqual(
    {
      keywords: Array.from(newFormat.keywords),
      comments: Array.from(newFormat.comments),
      regexes: Array.from(newFormat.regexes),
      errors: Array.from(newFormat.errors),
    },
    {
      keywords: ['广告', '带货'],
      comments: ['# 注释'],
      regexes: ['/抽奖/i', '/推广/i', '/\\d{1,3}元/i'],
      errors: [],
    },
  );
  const legacyFormat = groupRuleEntries('广告, 美团, /\\d{1,3}元/i');
  assert.deepEqual(
    {
      keywords: Array.from(legacyFormat.keywords),
      comments: Array.from(legacyFormat.comments),
      regexes: Array.from(legacyFormat.regexes),
      errors: Array.from(legacyFormat.errors),
    },
    {
      keywords: ['广告', '美团'],
      comments: [],
      regexes: ['/\\d{1,3}元/i'],
      errors: [],
    },
  );
});

test('reports invalid regular expressions without discarding valid rules', () => {
  const { parseRules } = loadTestApi();
  const result = parseRules('正常关键字\n/(/');

  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].source, '正常关键字');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /第 2 行/);
});

test('does not let an unterminated slash swallow following legacy rules', () => {
  const { parseRules } = loadTestApi();
  const result = parseRules('/unfinished, 美团\n广告');

  assert.deepEqual(
    Array.from(result.rules, ({ type, source }) => ({ type, source })),
    [
      { type: 'keyword', source: '/unfinished' },
      { type: 'keyword', source: '美团' },
      { type: 'keyword', source: '广告' },
    ],
  );
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

test('locates every case-insensitive keyword occurrence for preview highlighting', () => {
  const { findMatchRanges } = loadTestApi();

  assert.deepEqual(
    Array.from(
      findMatchRanges('广告 AD 广告', { type: 'keyword', source: '广告', flags: '' }),
      (range) => ({ ...range }),
    ),
    [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ],
  );

  assert.deepEqual(
    Array.from(
      findMatchRanges('限时\n\t优惠', {
        type: 'keyword',
        source: '限时 优惠',
        flags: '',
      }),
      (range) => ({ ...range }),
    ),
    [{ start: 0, end: 5 }],
  );

  assert.deepEqual(
    Array.from(
      findMatchRanges('İX', { type: 'keyword', source: 'x', flags: '' }),
      (range) => ({ ...range }),
    ),
    [{ start: 1, end: 2 }],
  );
});

test('locates every regular-expression occurrence for preview highlighting', () => {
  const { findMatch, findMatchRanges, parseRules } = loadTestApi();

  assert.deepEqual(
    Array.from(
      findMatchRanges('抽奖 送手机，再次抽奖送礼物', {
        type: 'regex',
        source: '抽奖\\s*送',
        flags: 'i',
      }),
      (range) => ({ ...range }),
    ),
    [
      { start: 0, end: 4 },
      { start: 9, end: 12 },
    ],
  );

  const text = '今天美团可以下单';
  const { rules } = parseRules(
    '/^(?!.*(?:不是广告))(?:(?=.*(?:广告|推广))|(?=.*(?:美团|淘宝|省钱(快|块|海)报))(?=.*(?:下单|优惠)))[\\s\\S]+$/i',
  );
  assert.deepEqual(
    Array.from(findMatchRanges(text, findMatch(text, rules)), (range) => ({ ...range })),
    [
      { start: 2, end: 4 },
      { start: 6, end: 8 },
    ],
  );
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
      showQuickBlockButton: true,
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

test('enables the per-dynamic quick block button by default', () => {
  const { normalizeConfig } = loadTestApi();

  assert.equal(normalizeConfig({}).showQuickBlockButton, true);
  assert.equal(normalizeConfig({ showQuickBlockButton: false }).showQuickBlockButton, false);
});

test('appends a matching quick-block keyword once', () => {
  const { appendQuickBlockKeyword } = loadTestApi();

  assert.deepEqual(
    { ...appendQuickBlockKeyword('广告', ' 美团 ', '今天美团有优惠') },
    { rulesText: '广告, 美团', keyword: '美团', added: true, error: '' },
  );
  assert.deepEqual(
    { ...appendQuickBlockKeyword('广告, 美团', '美团', '今天美团有优惠') },
    { rulesText: '广告, 美团', keyword: '美团', added: false, error: '' },
  );
});

test('appends quick-block keywords to the keyword line, not after regexes', () => {
  const { appendQuickBlockKeyword } = loadTestApi();

  assert.deepEqual(
    { ...appendQuickBlockKeyword('广告\n/抽奖|推广/i', '美团', '今天美团有优惠') },
    {
      rulesText: '广告, 美团\n/抽奖|推广/i',
      keyword: '美团',
      added: true,
      error: '',
    },
  );
  assert.deepEqual(
    { ...appendQuickBlockKeyword('广告, 美团\n/抽奖|推广/i', '美团', '今天美团有优惠') },
    {
      rulesText: '广告, 美团\n/抽奖|推广/i',
      keyword: '美团',
      added: false,
      error: '',
    },
  );
  assert.deepEqual(
    { ...appendQuickBlockKeyword('广告, 美团', '推广', '推广内容') },
    { rulesText: '广告, 美团, 推广', keyword: '推广', added: true, error: '' },
  );
});

test('rejects unsafe or unrelated quick-block keywords', () => {
  const { appendQuickBlockKeyword } = loadTestApi();

  assert.match(appendQuickBlockKeyword('', '', '正文').error, /不能为空/);
  assert.match(appendQuickBlockKeyword('', '# 注释', '# 注释').error, /不能以/);
  assert.match(appendQuickBlockKeyword('', '/广告/i', '/广告/i').error, /普通关键词/);
  assert.match(appendQuickBlockKeyword('', '淘宝', '美团优惠').error, /当前动态不包含/);
});

test('requires confirmation before quick-block enables video filtering', () => {
  const { resolveQuickBlockUpdate } = loadTestApi();
  const current = {
    enabled: true,
    rulesText: '广告',
    showStatusPanel: true,
    filterVideoDynamics: false,
    showQuickBlockButton: true,
  };
  const declined = resolveQuickBlockUpdate(
    current,
    '美团',
    '美团优惠',
    true,
    () => false,
  );
  const accepted = resolveQuickBlockUpdate(
    current,
    '美团',
    '美团优惠',
    true,
    () => true,
  );

  assert.equal(declined.cancelled, true);
  assert.equal(declined.config.rulesText, '广告');
  assert.equal(declined.config.filterVideoDynamics, false);
  assert.equal(accepted.cancelled, false);
  assert.equal(accepted.config.rulesText, '广告, 美团');
  assert.equal(accepted.config.filterVideoDynamics, true);
});

test('uses a system-theme-aware custom dialog for quick blocking', () => {
  const source = readUserScriptSource();
  const quickBlockStart = source.indexOf('function quickBlockCard');
  const quickBlockEnd = source.indexOf('\n  function syncQuickBlockButton', quickBlockStart);
  const quickBlockSource = source.slice(quickBlockStart, quickBlockEnd);

  assert.doesNotMatch(quickBlockSource, /window\.(?:prompt|confirm|alert)/);
  assert.match(source, /#bdf-quick-block-dialog/);
  assert.match(
    source,
    /@media \(prefers-color-scheme: dark\)[\s\S]*#bdf-quick-block-dialog/,
  );
});

test('merges local config edits with newer values from another tab', () => {
  const { mergeConfigEdits } = loadTestApi();
  const baseline = {
    enabled: true,
    rulesText: '旧规则',
    showStatusPanel: true,
    filterVideoDynamics: true,
  };
  const edited = { ...baseline, rulesText: '本地新规则' };
  const latest = { ...baseline, showStatusPanel: false };
  const resolved = mergeConfigEdits(baseline, edited, latest);

  assert.deepEqual(Array.from(resolved.conflicts), []);
  assert.equal(resolved.config.rulesText, '本地新规则');
  assert.equal(resolved.config.showStatusPanel, false);
});

test('reports a conflict when two tabs edit the same config field', () => {
  const { mergeConfigEdits } = loadTestApi();
  const baseline = { rulesText: '旧规则' };
  const edited = { rulesText: '标签页 A' };
  const latest = { rulesText: '标签页 B' };
  const resolved = mergeConfigEdits(baseline, edited, latest);

  assert.deepEqual(Array.from(resolved.conflicts), ['rulesText']);
  assert.equal(resolved.config.rulesText, '标签页 B');
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

test('keeps only preview modes that still have matching hidden cards', () => {
  const { resolvePreviewMode } = loadTestApi();

  assert.equal(resolvePreviewMode('all', 3, 1), 'all');
  assert.equal(resolvePreviewMode('video', 3, 1), 'video');
  assert.equal(resolvePreviewMode('all', 0, 0), 'none');
  assert.equal(resolvePreviewMode('video', 3, 0), 'none');
  assert.equal(resolvePreviewMode('unexpected', 3, 1), 'none');
});

test('blocked-content list follows page order and limits the video view to hidden videos', () => {
  const { getBlockedPreviewCards } = loadTestApi();
  const makeCard = (video) => ({
    classList: { contains: (name) => name === 'bdf-matched-video-dynamic' && video },
  });
  const cards = [makeCard(false), makeCard(true), makeCard(true)];
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, '.bdf-hidden-dynamic');
      return cards;
    },
  };

  assert.deepEqual(Array.from(getBlockedPreviewCards(root, 'all')), cards);
  assert.deepEqual(Array.from(getBlockedPreviewCards(root, 'video')), cards.slice(1));
});

test('a single restored block stays hidden in preview until selected again', () => {
  const { isCardVisibleInPreview } = loadTestApi();
  const classes = new Set(['bdf-hidden-dynamic', 'bdf-matched-video-dynamic']);
  const card = { classList: { contains: (name) => classes.has(name) } };

  assert.equal(isCardVisibleInPreview(card, 'all'), true);
  assert.equal(isCardVisibleInPreview(card, 'video'), true);
  classes.add('bdf-preview-dismissed');
  assert.equal(isCardVisibleInPreview(card, 'all'), false);
  assert.equal(isCardVisibleInPreview(card, 'video'), false);
  classes.delete('bdf-preview-dismissed');
  assert.equal(isCardVisibleInPreview(card, 'video'), true);
  assert.equal(isCardVisibleInPreview(card, 'none'), false);
});

test('restores a missing preview highlight after a same-text rerender', () => {
  const { highlightPiecesEqual, resolveHighlightAction } = loadTestApi();

  assert.equal(resolveHighlightAction(true, false), 'add');
  assert.equal(resolveHighlightAction(true, true), 'none');
  assert.equal(resolveHighlightAction(false, true), 'remove');
  assert.equal(resolveHighlightAction(false, false), 'none');
  assert.equal(highlightPiecesEqual(['广告', '推广'], ['广告']), false);
  assert.equal(highlightPiecesEqual(['广告', '推广'], ['广告', '推广']), true);
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

test('persists compact mode and panel position after the storage write completes', async () => {
  const { persistUiState } = loadTestApi();
  const storage = new Map();
  const saved = await persistUiState(
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

test('waits for configuration storage before verifying the saved value', async () => {
  const { persistConfig } = loadTestApi();
  const storage = new Map();
  let finishWrite;
  let finishRead;
  let readBeforeWriteFinished = false;
  let readStarted = false;
  const writeFinished = new Promise((resolve) => {
    finishWrite = resolve;
  });
  const readFinished = new Promise((resolve) => {
    finishRead = resolve;
  });
  const saving = persistConfig(
    'config-key',
    { enabled: true, rulesText: '广告', filterVideoDynamics: false },
    async (key, value) => {
      await writeFinished;
      storage.set(key, value);
    },
    async (key, fallback) => {
      if (!storage.has(key)) readBeforeWriteFinished = true;
      readStarted = true;
      await readFinished;
      return storage.get(key) ?? fallback;
    },
  );
  await Promise.resolve();
  assert.equal(readBeforeWriteFinished, false);
  finishWrite();
  while (!readStarted) await Promise.resolve();
  let saveSettled = false;
  saving.finally(() => {
    saveSettled = true;
  });
  await Promise.resolve();
  assert.equal(saveSettled, false);
  finishRead();
  const saved = await saving;

  assert.equal(storage.get('config-key').filterVideoDynamics, false);
  assert.deepEqual({ ...saved }, { ...storage.get('config-key') });
});

test('loads the latest configuration through the asynchronous storage API', async () => {
  const { readStoredState } = loadTestApi();
  let finishConfigRead;
  const configRead = new Promise((resolve) => {
    finishConfigRead = resolve;
  });
  const loading = readStoredState((key) => (
    key.includes(':config:')
      ? configRead
      : Promise.resolve({ compact: true, position: null })
  ));
  let settled = false;
  loading.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  finishConfigRead({ enabled: true, rulesText: '最新规则' });
  const stored = await loading;

  assert.equal(stored.config.rulesText, '最新规则');
  assert.equal(stored.uiState.compact, true);
});

test('reports a storage write that cannot be read back', async () => {
  const { persistConfig } = loadTestApi();

  await assert.rejects(
    persistConfig(
      'config-key',
      {},
      async () => {},
      (_key, fallback) => fallback,
    ),
    /配置写入 Tampermonkey Storage 后校验失败/,
  );
});

test('does not verify configuration after Tampermonkey rejects the write', async () => {
  const { persistConfig } = loadTestApi();
  let readAttempted = false;

  await assert.rejects(
    persistConfig(
      'config-key',
      { rulesText: '新规则' },
      async () => {
        throw new Error('storage unavailable');
      },
      () => {
        readAttempted = true;
        return null;
      },
    ),
    /storage unavailable/,
  );
  assert.equal(readAttempted, false);
});

test('writes only when a serialized configuration update changes storage', async () => {
  const { updateStoredConfig } = loadTestApi();
  const storage = new Map([
    ['config-key', {
      enabled: true,
      rulesText: '广告',
      showStatusPanel: true,
      filterVideoDynamics: true,
      showQuickBlockButton: true,
    }],
  ]);
  let writeCount = 0;
  const setValue = async (key, value) => {
    writeCount += 1;
    storage.set(key, value);
  };
  const getValue = async (key, fallback) => storage.get(key) ?? fallback;

  await updateStoredConfig('config-key', {}, (current) => current, setValue, getValue);
  assert.equal(writeCount, 0);

  await updateStoredConfig(
    'config-key',
    {},
    (current) => ({ ...current, rulesText: `${current.rulesText}\n美团` }),
    setValue,
    getValue,
  );
  assert.equal(writeCount, 1);
  assert.equal(storage.get('config-key').rulesText, '广告\n美团');
});

test('cancelled video quick-block does not write configuration storage', async () => {
  const { resolveQuickBlockUpdate, updateStoredConfig } = loadTestApi();
  const storage = new Map([
    ['config-key', {
      enabled: true,
      rulesText: '广告',
      showStatusPanel: true,
      filterVideoDynamics: false,
      showQuickBlockButton: true,
    }],
  ]);
  let writeCount = 0;

  await updateStoredConfig(
    'config-key',
    {},
    (current) => resolveQuickBlockUpdate(
      current,
      '美团',
      '美团优惠',
      true,
      () => false,
    ).config,
    async (key, value) => {
      writeCount += 1;
      storage.set(key, value);
    },
    async (key, fallback) => storage.get(key) ?? fallback,
  );

  assert.equal(writeCount, 0);
  assert.equal(storage.get('config-key').rulesText, '广告');
  assert.equal(storage.get('config-key').filterVideoDynamics, false);
});

test('serializes state patches and merges each patch into the latest saved state', async () => {
  const { createSerializedUpdateQueue } = loadTestApi();
  let state = { compact: false, position: null };
  let finishFirstWrite;
  const firstWriteFinished = new Promise((resolve) => {
    finishFirstWrite = resolve;
  });
  let writeCount = 0;
  const updateState = createSerializedUpdateQueue(async (patch) => {
    const nextState = { ...state, ...patch };
    writeCount += 1;
    if (writeCount === 1) await firstWriteFinished;
    state = nextState;
    return state;
  });

  const compactSave = updateState({ compact: true });
  const positionSave = updateState({ position: { x: 120, y: 80 } });
  await Promise.resolve();
  assert.equal(writeCount, 1);
  finishFirstWrite();
  await Promise.all([compactSave, positionSave]);

  assert.equal(writeCount, 2);
  assert.deepEqual(state, {
    compact: true,
    position: { x: 120, y: 80 },
  });
});

test('continues serialized updates after an earlier update fails', async () => {
  const { createSerializedUpdateQueue } = loadTestApi();
  const calls = [];
  const update = createSerializedUpdateQueue(async (value) => {
    calls.push(value);
    if (value === 'first') throw new Error('first failed');
    return value;
  });

  const first = update('first');
  const second = update('second');

  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'second');
  assert.deepEqual(calls, ['first', 'second']);
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
