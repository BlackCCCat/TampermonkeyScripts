// ==UserScript==
// @name         哔哩哔哩动态关键字屏蔽
// @namespace    https://github.com/BlackCCCat/TampermonkeyScripts
// @version      0.7.3
// @description  通过关键字或正则表达式屏蔽哔哩哔哩动态，并支持动态加载内容。
// @author       BlackCCCat
// @license      MIT
// @homepageURL  https://github.com/BlackCCCat/TampermonkeyScripts
// @supportURL   https://github.com/BlackCCCat/TampermonkeyScripts/issues
// @downloadURL  https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili/bilibili-dynamic-filter.user.js
// @updateURL    https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili/bilibili-dynamic-filter.meta.js
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*/dynamic*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM.getValue
// @grant        GM.addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM.setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    rulesText: '',
    showStatusPanel: true,
    filterVideoDynamics: true,
    showQuickBlockButton: true,
  });
  const DEFAULT_UI_STATE = Object.freeze({
    compact: false,
    position: null,
  });
  const HIDDEN_CLASS = 'bdf-hidden-dynamic';
  const VIDEO_MATCH_CLASS = 'bdf-matched-video-dynamic';
  const PREVIEW_DISMISSED_CLASS = 'bdf-preview-dismissed';
  const CONFIG_KEY = 'bilibili-dynamic-filter:config:v1';
  const UI_STATE_KEY = 'bilibili-dynamic-filter:ui:v1';
  const VIDEO_CONTENT_SELECTORS = [
    '.bili-dyn-card-video__title',
    '.bili-dyn-card-video__desc',
  ];
  const CONTENT_SELECTOR = [
    '.bili-dyn-content__orig__desc',
    '.bili-dyn-content__forw__desc',
    '.dyn-card-opus__title',
    '.dyn-card-opus__summary',
    ...VIDEO_CONTENT_SELECTORS,
    '.bili-dyn-card-article__title',
    '.bili-dyn-card-article__desc',
    '.bili-dyn-card-reserve__title',
  ].join(',');
  const VIDEO_SELECTOR = [
    '.bili-dyn-card-video',
    ...VIDEO_CONTENT_SELECTORS,
  ].join(',');
  const normalizeText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  function normalizeTextWithOffsets(text) {
    const value = String(text ?? '');
    const offsets = [];
    let normalized = '';
    let whitespaceStart = -1;
    let whitespaceEnd = -1;

    const append = (chunk, start, end) => {
      normalized += chunk;
      for (let index = 0; index < chunk.length; index += 1) {
        offsets.push({ start, end });
      }
    };

    for (let index = 0; index < value.length;) {
      const character = String.fromCodePoint(value.codePointAt(index));
      const end = index + character.length;
      if (/\s/u.test(character)) {
        if (normalized && whitespaceStart === -1) whitespaceStart = index;
        whitespaceEnd = end;
      } else {
        if (whitespaceStart !== -1) {
          append(' ', whitespaceStart, whitespaceEnd);
          whitespaceStart = -1;
        }
        append(character, index, end);
      }
      index = end;
    }

    return { text: normalized, offsets };
  }

  function getCardContentNodes(card) {
    const contentNodes = Array.from(card.querySelectorAll(CONTENT_SELECTOR));
    const outermostNodes = contentNodes.filter((node) => (
      !contentNodes.some((candidate) => candidate !== node && candidate.contains?.(node))
    ));
    return outermostNodes;
  }

  function buildCardTextIndex(card) {
    const contentNodes = getCardContentNodes(card);
    const text = normalizeText(
      contentNodes
        .map((node) => node.innerText || node.textContent || '')
        .join(' '),
    );
    if (typeof document === 'undefined') return { text, segments: [] };

    const segments = [];
    let contentStart = 0;
    contentNodes.forEach((contentNode) => {
      const contentText = normalizeText(
        contentNode.innerText || contentNode.textContent || '',
      );
      if (!contentText) return;

      const start = text.indexOf(contentText, contentStart);
      if (start === -1) return;
      let nodeStart = 0;
      const walker = document.createTreeWalker(contentNode, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const normalizedNode = normalizeTextWithOffsets(walker.currentNode.data);
        if (!normalizedNode.text) continue;
        const offset = contentText.indexOf(normalizedNode.text, nodeStart);
        if (offset === -1) continue;
        segments.push({
          node: walker.currentNode,
          start: start + offset,
          end: start + offset + normalizedNode.text.length,
          offsets: normalizedNode.offsets,
        });
        nodeStart = offset + normalizedNode.text.length;
      }
      contentStart = start + contentText.length;
    });

    return { text, segments };
  }

  function extractCardText(card) {
    return normalizeText(
      getCardContentNodes(card)
        .map((node) => node.innerText || node.textContent || '')
        .join(' '),
    );
  }

  function extractCardAuthor(card) {
    const nameNode = card.querySelector(
      '.bili-dyn-item__header .bili-dyn-title__text, .bili-dyn-item__header .bili-dyn-title__name',
    );
    const avatar = card.querySelector(
      '.bili-dyn-item__avatar [data-layer-tag="AVATAR_LAYER"] img, .bili-dyn-item__avatar img',
    );
    return {
      name: normalizeText(nameNode?.innerText || nameNode?.textContent) || '未知 UP 主',
      avatarUrl: avatar?.currentSrc || avatar?.getAttribute('src') || avatar?.getAttribute('data-src') || '',
    };
  }

  function normalizeConfig(stored) {
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_CONFIG };
    return {
      enabled: stored.enabled !== false,
      rulesText: typeof stored.rulesText === 'string' ? stored.rulesText : '',
      showStatusPanel: stored.showStatusPanel !== false,
      filterVideoDynamics: stored.filterVideoDynamics !== false,
      showQuickBlockButton: stored.showQuickBlockButton !== false,
    };
  }

  function configsEqual(left, right) {
    return Object.keys(DEFAULT_CONFIG).every((key) => left[key] === right[key]);
  }

  function mergeConfigEdits(baseline, edited, latest) {
    const original = normalizeConfig(baseline);
    const local = normalizeConfig(edited);
    const current = normalizeConfig(latest);
    const merged = { ...current };
    const conflicts = [];

    Object.keys(DEFAULT_CONFIG).forEach((key) => {
      if (local[key] === original[key]) return;
      if (current[key] !== original[key] && current[key] !== local[key]) {
        conflicts.push(key);
        return;
      }
      merged[key] = local[key];
    });

    return { config: merged, conflicts };
  }

  async function persistNormalizedValue(
    storageKey,
    nextValue,
    { normalize, valuesEqual, setValue, getValue, errorMessage },
  ) {
    const normalized = normalize(nextValue);
    await setValue(storageKey, normalized);
    const storedValue = await getValue(storageKey, null);
    const stored = storedValue && typeof storedValue === 'object'
      ? normalize(storedValue)
      : null;
    if (!stored || !valuesEqual(normalized, stored)) {
      throw new Error(errorMessage);
    }
    return normalized;
  }

  async function persistConfig(storageKey, nextConfig, setValue, getValue) {
    return persistNormalizedValue(
      storageKey,
      nextConfig,
      {
        normalize: normalizeConfig,
        valuesEqual: configsEqual,
        setValue,
        getValue,
        errorMessage: '配置写入 Tampermonkey Storage 后校验失败，请重试',
      },
    );
  }

  async function updateStoredConfig(
    storageKey,
    fallbackConfig,
    resolveNextConfig,
    setValue,
    getValue,
  ) {
    const storedConfig = normalizeConfig(await getValue(storageKey, fallbackConfig));
    const nextConfig = normalizeConfig(resolveNextConfig(storedConfig));
    if (configsEqual(storedConfig, nextConfig)) return storedConfig;
    return persistConfig(storageKey, nextConfig, setValue, getValue);
  }

  function normalizeUiState(stored) {
    const position = stored?.position;
    const validPosition = (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
    ) ? { x: position.x, y: position.y } : null;
    return {
      compact: stored?.compact === true,
      position: validPosition,
    };
  }

  function uiStatesEqual(left, right) {
    return (
      left.compact === right.compact &&
      left.position?.x === right.position?.x &&
      left.position?.y === right.position?.y
    );
  }

  function createSerializedUpdateQueue(runUpdate) {
    let tail = Promise.resolve();
    return (...args) => {
      const result = tail.then(() => runUpdate(...args));
      tail = result.catch(() => undefined);
      return result;
    };
  }

  async function persistUiState(storageKey, nextState, setValue, getValue) {
    return persistNormalizedValue(
      storageKey,
      nextState,
      {
        normalize: normalizeUiState,
        valuesEqual: uiStatesEqual,
        setValue,
        getValue,
        errorMessage: '状态面板位置写入 Tampermonkey Storage 后校验失败',
      },
    );
  }

  async function readStoredState(getValue) {
    const [storedConfig, storedUiState] = await Promise.all([
      getValue(CONFIG_KEY, DEFAULT_CONFIG),
      getValue(UI_STATE_KEY, DEFAULT_UI_STATE),
    ]);
    return {
      config: normalizeConfig(storedConfig),
      uiState: normalizeUiState(storedUiState),
    };
  }

  function clampPanelPosition(position, viewport, panel, margin = 8) {
    const maxX = Math.max(margin, viewport.width - panel.width - margin);
    const maxY = Math.max(margin, viewport.height - panel.height - margin);
    return {
      x: Math.min(Math.max(position.x, margin), maxX),
      y: Math.min(Math.max(position.y, margin), maxY),
    };
  }

  function isDragGesture(start, current, threshold = 4) {
    return Math.hypot(current.x - start.x, current.y - start.y) >= threshold;
  }

  function isVideoDynamic(card) {
    return Boolean(
      card?.matches?.(VIDEO_SELECTOR) || card?.querySelector?.(VIDEO_SELECTOR),
    );
  }

  function shouldHideMatchedCard(videoDynamic, filterVideoDynamics) {
    return !videoDynamic || filterVideoDynamics;
  }

  function formatStatusText(hiddenCount, videoMatchCount, filterVideoDynamics) {
    const videoSuffix = filterVideoDynamics ? '' : '（未过滤）';
    return `已屏蔽 ${hiddenCount} 条动态 · 视频命中 ${videoMatchCount} 条${videoSuffix}`;
  }

  function resolvePreviewMode(mode, hiddenCount, hiddenVideoCount) {
    if (mode === 'all' && hiddenCount > 0) return 'all';
    if (mode === 'video' && hiddenVideoCount > 0) return 'video';
    return 'none';
  }

  function getBlockedPreviewCards(root, mode) {
    const cards = Array.from(root.querySelectorAll(`.${HIDDEN_CLASS}`));
    return mode === 'video'
      ? cards.filter((card) => card.classList.contains(VIDEO_MATCH_CLASS))
      : cards;
  }

  function isCardVisibleInPreview(card, mode) {
    return card.classList.contains(HIDDEN_CLASS) &&
      !card.classList.contains(PREVIEW_DISMISSED_CLASS) &&
      (mode === 'all' || mode === 'video' && card.classList.contains(VIDEO_MATCH_CLASS));
  }

  function shouldShowStatusPanel(currentConfig, ruleCount) {
    return (
      currentConfig.enabled &&
      currentConfig.showStatusPanel &&
      ruleCount > 0
    );
  }

  function findRegexClosingSlash(line) {
    for (let index = line.length - 1; index > 0; index -= 1) {
      if (line[index] !== '/') continue;

      let backslashCount = 0;
      for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
        backslashCount += 1;
      }

      if (backslashCount % 2 === 0) return index;
    }
    return -1;
  }

  function splitIntoLines(rulesText) {
    const lines = [];
    for (const line of String(rulesText ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
    return lines;
  }

  function startsComment(line) {
    const leadingIndex = line.search(/[^#\s]/);
    return leadingIndex !== -1 && line[leadingIndex] === '#';
  }

  // 若一条“整行”文本含逗号分隔，用逐字符状态机扫描整行，在保证
  // “正则内部的逗号不拆分、字符类不误判、转义不误伤”的前提下切分条目。
  // 支持关键词与正则任意混排（旧版逗号格式），也兼容正则独占一行的新格式输入。
  function splitLegacyCommaLine(line) {
    const entries = [];
    let entry = '';
    let inRegex = false;
    let inCharacterClass = false;
    let escaped = false;

    const pushToken = (token) => {
      if (token.trim()) entries.push(token.trim());
    };

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (inRegex) {
        entry += character;
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '[') {
          inCharacterClass = true;
        } else if (character === ']') {
          inCharacterClass = false;
        } else if (character === '/' && !inCharacterClass) {
          inRegex = false;
        }
        continue;
      }

      if (character === ',' || character === '，') {
        pushToken(entry);
        entry = '';
        continue;
      }

      const isLeading = entry.trim() === '' && !/\s/.test(character);
      if (!inRegex && isLeading && character === '/') {
        const closing = findRegexClosingSlash(line.slice(index));
        if (closing > 0) {
          entry += character;
          inRegex = true;
          continue;
        }
      }
      entry += character;
    }
    pushToken(entry);
    return entries;
  }

  // 将规则文本拆成条目列表（一条条目 = 一个正则 / 注释 / 单个关键词）。
  // 规则按行书写：每个正则表达式独占一行；关键词单独成行，行内用逗号分隔。
  // 旧版“单行逗号混排”的写法仍能正确解析（正则内部逗号不会拆分）。
  function splitRuleEntries(rulesText) {
    const entries = [];
    let pendingRegex = '';

    const flushPendingRegex = () => {
      if (pendingRegex) {
        entries.push(pendingRegex.trim());
        pendingRegex = '';
      }
    };

    splitIntoLines(rulesText).forEach((line) => {
      if (line.startsWith('/')) {
        if (findRegexClosingSlash(line) > 0) {
          // 完整的正则独占一行，是首要的新格式。
          flushPendingRegex();
          entries.push(line);
          return;
        }
        if (/[,\uFF0C]/.test(line)) {
          // 以 / 开头但未闭合，且含逗号：实际是旧版逗号混排（未闭合正则混在关键词行里），
          // 按逐字符扫描拆开，避免把整行当作一个正则吞掉后续规则。
          flushPendingRegex();
          splitLegacyCommaLine(line).forEach((entry) => entries.push(entry));
          return;
        }
        // 无逗号的未闭合正则（例如 /(/）：单独记录，交给 parseRules 报非法正则错误。
        flushPendingRegex();
        pendingRegex = line;
        return;
      }

      flushPendingRegex();
      if (startsComment(line) || !/[,\uFF0C]/.test(line)) {
        entries.push(line);
        return;
      }
      splitLegacyCommaLine(line).forEach((entry) => entries.push(entry));
    });
    flushPendingRegex();
    return entries;
  }

  function groupRuleEntries(rulesText) {
    const grouped = { keywords: [], comments: [], regexes: [], errors: [] };
    splitRuleEntries(rulesText).forEach((entry) => {
      if (entry.startsWith('#')) {
        grouped.comments.push(entry);
      } else if (entry.startsWith('/')) {
        grouped.regexes.push(entry);
      } else {
        grouped.keywords.push(entry);
      }
    });
    return grouped;
  }

  // 将规则文本整理成新格式：正则每个占一行、关键词合并成一行且用逗号分隔。
  function formatRulesText(rulesText) {
    if (rulesText && typeof rulesText === 'object' && !Array.isArray(rulesText)) {
      return formatGroupedRules(rulesText);
    }
    return formatGroupedRules(groupRuleEntries(rulesText));
  }

  function formatGroupedRules(grouped) {
    const sections = [];
    if (grouped.comments.length > 0) sections.push(grouped.comments.join('\n'));
    if (grouped.keywords.length > 0) sections.push(grouped.keywords.join(', '));
    if (grouped.regexes.length > 0) sections.push(grouped.regexes.join('\n'));
    return sections.join('\n');
  }

  function parseRules(rulesText) {
    const rules = [];
    const errors = [];

    splitRuleEntries(rulesText)
      .forEach((line, index) => {
        if (line.startsWith('#')) return;

        const closingSlash = line.startsWith('/') ? findRegexClosingSlash(line) : -1;
        if (closingSlash > 0) {
          const source = line.slice(1, closingSlash);
          const flags = line.slice(closingSlash + 1);
          try {
            rules.push({
              type: 'regex',
              source,
              flags,
              matcher: new RegExp(source, flags),
            });
          } catch (error) {
            errors.push(`第 ${index + 1} 行：${error.message}`);
          }
          return;
        }

        rules.push({
          type: 'keyword',
          source: line,
          flags: '',
          keyword: normalizeText(line).toLocaleLowerCase(),
        });
      });

    return { rules, errors };
  }

  function appendQuickBlockKeyword(rulesText, input, cardText) {
    const keyword = normalizeText(input);
    const grouped = groupRuleEntries(rulesText);
    if (!keyword) {
      return { rulesText: formatRulesText(grouped), keyword, added: false, error: '关键词不能为空' };
    }
    if (keyword.length > 80) {
      return { rulesText: formatRulesText(grouped), keyword, added: false, error: '关键词不能超过 80 个字符' };
    }
    if (keyword.startsWith('#') || keyword.startsWith('/')) {
      return {
        rulesText: formatRulesText(grouped),
        keyword,
        added: false,
        error: '快捷屏蔽只支持普通关键词，且不能以 # 或 / 开头',
      };
    }
    if (!normalizeText(cardText).toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) {
      return {
        rulesText: formatRulesText(grouped),
        keyword,
        added: false,
        error: '当前动态不包含这个关键词，请重新选择',
      };
    }

    const exists = parseRules(formatRulesText(grouped)).rules.some((rule) => (
      rule.type === 'keyword' &&
      rule.keyword === keyword.toLocaleLowerCase()
    ));
    const nextKeywords = exists
      ? grouped.keywords
      : [...grouped.keywords, keyword];
    return {
      rulesText: formatRulesText({ ...grouped, keywords: nextKeywords }),
      keyword,
      added: !exists,
      error: '',
    };
  }

  function resolveQuickBlockUpdate(
    currentConfig,
    input,
    cardText,
    videoDynamic,
    confirmEnableVideoFiltering,
  ) {
    const normalizedConfig = normalizeConfig(currentConfig);
    const result = appendQuickBlockKeyword(normalizedConfig.rulesText, input, cardText);
    if (result.error) return { config: normalizedConfig, result, cancelled: false };

    const videoFilteringRequired = videoDynamic && !normalizedConfig.filterVideoDynamics;
    if (videoFilteringRequired && !confirmEnableVideoFiltering()) {
      return { config: normalizedConfig, result, cancelled: true };
    }
    if (!result.added && !videoFilteringRequired) {
      return { config: normalizedConfig, result, cancelled: false };
    }
    return {
      config: {
        ...normalizedConfig,
        rulesText: result.rulesText,
        filterVideoDynamics: normalizedConfig.filterVideoDynamics || videoFilteringRequired,
      },
      result,
      cancelled: false,
    };
  }

  function findMatch(text, rules) {
    const normalizedText = normalizeText(text);
    const lowerText = normalizedText.toLocaleLowerCase();

    for (const rule of rules) {
      let matched = false;
      if (rule.type === 'keyword') {
        matched = lowerText.includes(rule.keyword);
      } else {
        rule.matcher.lastIndex = 0;
        matched = rule.matcher.test(normalizedText);
        rule.matcher.lastIndex = 0;
      }

      if (matched) {
        return {
          type: rule.type,
          source: rule.source,
          flags: rule.flags,
        };
      }
    }

    return null;
  }

  function findMatchRanges(text, match) {
    const value = normalizeText(text);
    const ranges = [];
    if (!match?.source) return ranges;

    if (match.type === 'keyword') {
      const foldedValue = foldTextWithOffsets(value);
      const keyword = normalizeText(match.source).toLocaleLowerCase();
      if (!keyword) return ranges;
      let start = 0;
      while ((start = foldedValue.text.indexOf(keyword, start)) !== -1) {
        const firstOffset = foldedValue.offsets[start];
        const lastOffset = foldedValue.offsets[start + keyword.length - 1];
        if (firstOffset && lastOffset) {
          ranges.push({ start: firstOffset.start, end: lastOffset.end });
        }
        start += keyword.length;
      }
      return ranges;
    }

    const lookaheadRanges = findPositiveLookaheadRanges(value, match);
    if (lookaheadRanges.length > 0) return lookaheadRanges;

    const ruleFlags = match.flags || '';
    const flags = ruleFlags.includes('g') ? ruleFlags : `${ruleFlags}g`;
    const matcher = new RegExp(match.source, flags);
    for (const result of value.matchAll(matcher)) {
      if (!result[0]) continue;
      ranges.push({ start: result.index, end: result.index + result[0].length });
    }
    return ranges;
  }

  function findRegexGroupEnd(source, start) {
    let depth = 0;
    let escaped = false;
    let inCharacterClass = false;

    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '[') inCharacterClass = true;
      if (character === ']' && inCharacterClass) inCharacterClass = false;
      if (inCharacterClass) continue;
      if (character === '(') depth += 1;
      if (character === ')' && --depth === 0) return index;
    }
    return -1;
  }

  function extractPositiveLookaheadPatterns(source) {
    const patterns = [];
    for (let index = 0; index < source.length - 2; index += 1) {
      if (!source.startsWith('(?=', index)) continue;
      const end = findRegexGroupEnd(source, index);
      if (end === -1) continue;
      const body = source.slice(index + 3, end);
      const candidate = body.replace(/^(?:\.\*\??|\[\\s\\S\]\*\??)/, '');
      if (candidate && !/^\(\?[=!]/.test(candidate)) patterns.push(candidate);
    }
    return patterns;
  }

  function findPositiveLookaheadRanges(text, match) {
    const ranges = [];
    const flags = `${(match.flags || '').replace(/[gyd]/g, '')}g`;
    extractPositiveLookaheadPatterns(match.source).forEach((pattern) => {
      let matcher;
      try {
        matcher = new RegExp(pattern, flags);
      } catch (_error) {
        return;
      }
      for (const result of text.matchAll(matcher)) {
        if (!result[0]) continue;
        ranges.push({ start: result.index, end: result.index + result[0].length });
      }
    });

    return ranges
      .sort((left, right) => left.start - right.start || right.end - left.end)
      .reduce((merged, range) => {
        const previous = merged[merged.length - 1];
        if (!previous || range.start >= previous.end) merged.push({ ...range });
        else if (range.end > previous.end) previous.end = range.end;
        return merged;
      }, []);
  }

  function foldTextWithOffsets(text) {
    const value = String(text ?? '');
    const folded = value.toLocaleLowerCase();
    const offsets = [];

    for (let index = 0; index < value.length;) {
      const character = String.fromCodePoint(value.codePointAt(index));
      const end = index + character.length;
      const foldedLength = character.toLocaleLowerCase().length;
      for (let offset = 0; offset < foldedLength; offset += 1) {
        offsets.push({ start: index, end });
      }
      index = end;
    }

    return { text: folded, offsets };
  }

  function resolveHighlightAction(shouldHighlight, hasHighlight) {
    if (shouldHighlight === hasHighlight) return 'none';
    return shouldHighlight ? 'add' : 'remove';
  }

  function highlightPiecesEqual(expectedPieces, actualPieces) {
    return (
      expectedPieces.length === actualPieces.length &&
      expectedPieces.every((piece, index) => piece === actualPieces[index])
    );
  }

  if (globalThis.__BDF_TEST_MODE__) {
    globalThis.__BDF_TEST_EXPORTS__ = {
      contentSelector: CONTENT_SELECTOR,
      appendQuickBlockKeyword,
      clampPanelPosition,
      createSerializedUpdateQueue,
      extractCardText,
      extractCardAuthor,
      findMatch,
      findMatchRanges,
      formatRulesText,
      formatStatusText,
      getBlockedPreviewCards,
      groupRuleEntries,
      highlightPiecesEqual,
      isVideoDynamic,
      isCardVisibleInPreview,
      isDragGesture,
      mergeConfigEdits,
      normalizeConfig,
      normalizeUiState,
      normalizeText,
      parseRules,
      persistConfig,
      persistUiState,
      readStoredState,
      resolveQuickBlockUpdate,
      resolveHighlightAction,
      resolvePreviewMode,
      shouldHideMatchedCard,
      shouldShowStatusPanel,
      updateStoredConfig,
      videoSelector: VIDEO_SELECTOR,
    };
    return;
  }

  const CARD_SELECTOR = [
    '.bili-dyn-list__item',
    '.bili-dyn-item',
    '[data-did]',
  ].join(',');
  const PREVIEW_CLASS = 'bdf-show-blocked-content';
  const VIDEO_PREVIEW_CLASS = 'bdf-show-blocked-videos';
  const PREVIEW_TARGET_CLASS = 'bdf-preview-target';
  const HIGHLIGHT_SELECTOR = '[data-bdf-match-highlight]';
  const QUICK_BLOCK_SELECTOR = '[data-bdf-quick-block]';
  const RESTORE_BLOCK_SELECTOR = '[data-bdf-restore-block]';
  const QUICK_BLOCK_HOST_CLASS = 'bdf-quick-block-host';
  const OWNED_UI_SELECTOR = `#bdf-status, #bdf-overlay, #bdf-quick-block-overlay, #bdf-list-dialog, ${QUICK_BLOCK_SELECTOR}, ${RESTORE_BLOCK_SELECTOR}`;

  let config = normalizeConfig(DEFAULT_CONFIG);
  let uiState = normalizeUiState(DEFAULT_UI_STATE);
  let parsedRules = parseRules(config.rulesText).rules;
  let configRevision = 0;
  let pendingTimer;
  let previewMode = 'none';
  let previewTarget = null;
  let statusPanel;
  let statusCount;
  let compactHiddenCount;
  let compactVideoCount;
  let compactToggle;
  let previewButton;
  let videoPreviewButton;
  let activePanelDrag = false;
  let compactSavePending = false;
  let suppressCompactClick = false;
  let closeConfigDialog = null;
  let closeQuickBlockDialog = null;
  let closeBlockedListDialog = null;
  let positionBlockedListDialog = null;
  const pendingRoots = new Set();
  const cardState = new WeakMap();

  const updateUiState = createSerializedUpdateQueue(async (patch) => {
    const nextState = normalizeUiState({ ...uiState, ...patch });
    if (uiStatesEqual(uiState, nextState)) return uiState;
    uiState = await persistUiState(
      UI_STATE_KEY,
      nextState,
      (key, value) => GM.setValue(key, value),
      (key, fallback) => GM.getValue(key, fallback),
    );
    return uiState;
  });

  function applyConfig(nextConfig) {
    const normalizedConfig = normalizeConfig(nextConfig);
    if (configsEqual(config, normalizedConfig)) return;
    config = normalizedConfig;
    parsedRules = parseRules(config.rulesText).rules;
    configRevision += 1;
    closeBlockedListDialog?.();
    setBlockedContentPreview('none', false);
    scanRoot(document.body);
    updateStats();
  }

  const updateConfig = createSerializedUpdateQueue(async (resolveNextConfig) => {
    const savedConfig = await updateStoredConfig(
      CONFIG_KEY,
      config,
      resolveNextConfig,
      (key, value) => GM.setValue(key, value),
      (key, fallback) => GM.getValue(key, fallback),
    );
    applyConfig(savedConfig);
    return config;
  });

  function saveConfig(nextConfigOrUpdater) {
    const resolveNextConfig = typeof nextConfigOrUpdater === 'function'
      ? nextConfigOrUpdater
      : () => nextConfigOrUpdater;
    return updateConfig(resolveNextConfig);
  }

  function canonicalCard(element) {
    if (!(element instanceof Element)) return null;
    return (
      element.closest('.bili-dyn-list__item') ||
      element.closest('.bili-dyn-item') ||
      element.closest('[data-did]')
    );
  }

  function clearCardMatchHighlights(card) {
    card.querySelectorAll(HIGHLIGHT_SELECTOR).forEach((highlight) => {
      const parent = highlight.parentNode;
      highlight.replaceWith(highlight.textContent || '');
      parent?.normalize();
    });
  }

  function getCardHighlightPieces(card, match) {
    if (!match) return [];

    const textIndex = buildCardTextIndex(card);
    const matchRanges = findMatchRanges(textIndex.text, match);
    return textIndex.segments.flatMap((segment) => (
      matchRanges.flatMap((range) => {
        const normalizedStart = Math.max(range.start, segment.start);
        const normalizedEnd = Math.min(range.end, segment.end);
        if (normalizedStart >= normalizedEnd) return [];
        const firstOffset = segment.offsets[normalizedStart - segment.start];
        const lastOffset = segment.offsets[normalizedEnd - segment.start - 1];
        return [{
          node: segment.node,
          start: firstOffset.start,
          end: lastOffset.end,
        }];
      })
    ));
  }

  function highlightCardMatch(card, match) {
    clearCardMatchHighlights(card);
    if (!match) return;

    const piecesByNode = new Map();
    getCardHighlightPieces(card, match).forEach((piece) => {
      if (!piecesByNode.has(piece.node)) piecesByNode.set(piece.node, []);
      piecesByNode.get(piece.node).push(piece);
    });
    piecesByNode.forEach((pieces, node) => {
      pieces.reverse().forEach(({ start, end }) => {
        node.splitText(end);
        const matchedText = node.splitText(start);
        const highlight = document.createElement('mark');
        highlight.dataset.bdfMatchHighlight = '';
        highlight.textContent = matchedText.data;
        matchedText.replaceWith(highlight);
      });
    });
  }

  function shouldHighlightCard(card) {
    return isCardVisibleInPreview(card, previewMode);
  }

  function syncRestoreBlockButton(card) {
    const button = Array.from(card.children).find(
      (child) => child.matches(RESTORE_BLOCK_SELECTOR),
    );
    if (!shouldHighlightCard(card)) {
      button?.remove();
      return;
    }
    if (button) return;

    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.dataset.bdfRestoreBlock = '';
    restoreButton.setAttribute('aria-label', '恢复屏蔽这条动态');
    restoreButton.title = '恢复屏蔽这条动态';
    restoreButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      card.classList.add(PREVIEW_DISMISSED_CLASS);
      card.classList.remove(PREVIEW_TARGET_CLASS);
      if (previewTarget === card) {
        previewTarget = null;
        document.querySelector('#bdf-blocked-list [aria-current="true"]')?.removeAttribute('aria-current');
      }
      reconcileCardMatchHighlight(card, cardState.get(card)?.match);
    });
    card.append(restoreButton);
  }

  function hasCompleteCardMatchHighlight(card, match) {
    const expectedPieces = getCardHighlightPieces(card, match).map(
      ({ node, start, end }) => node.data.slice(start, end),
    );
    const actualPieces = Array.from(
      card.querySelectorAll(HIGHLIGHT_SELECTOR),
      (highlight) => highlight.textContent || '',
    );
    return highlightPiecesEqual(expectedPieces, actualPieces);
  }

  function reconcileCardMatchHighlight(card, match) {
    const shouldHighlight = shouldHighlightCard(card);
    const action = resolveHighlightAction(
      shouldHighlight,
      shouldHighlight
        ? hasCompleteCardMatchHighlight(card, match)
        : Boolean(card.querySelector(HIGHLIGHT_SELECTOR)),
    );
    if (action === 'add') highlightCardMatch(card, match);
    if (action === 'remove') clearCardMatchHighlights(card);
    syncRestoreBlockButton(card);
  }

  function syncMatchHighlights() {
    const highlightedCards = new Set(
      Array.from(document.querySelectorAll(HIGHLIGHT_SELECTOR), canonicalCard)
        .filter(Boolean),
    );
    const targetCards = new Set();
    if (previewMode !== 'none') {
      document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((card) => {
        if (shouldHighlightCard(card)) targetCards.add(card);
      });
    }

    highlightedCards.forEach((card) => {
      if (!targetCards.has(card)) clearCardMatchHighlights(card);
    });
    targetCards.forEach((card) => {
      if (!highlightedCards.has(card)) {
        highlightCardMatch(card, cardState.get(card)?.match);
      }
    });
    const cards = new Set(document.querySelectorAll(`.${HIDDEN_CLASS}`));
    document.querySelectorAll(RESTORE_BLOCK_SELECTOR).forEach((button) => {
      const card = canonicalCard(button);
      if (card) cards.add(card);
    });
    cards.forEach(syncRestoreBlockButton);
  }

  function selectedTextInsideCard(card) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    if (!card.contains(range.commonAncestorContainer)) return '';
    return normalizeText(selection.toString()).slice(0, 80);
  }

  function quickBlockCard(card) {
    if (closeQuickBlockDialog && closeQuickBlockDialog() === false) return;
    const cardText = extractCardText(card);
    const videoDynamic = isVideoDynamic(card);
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.id = 'bdf-quick-block-overlay';
    overlay.innerHTML = `
      <form id="bdf-quick-block-dialog" role="dialog" aria-modal="true" aria-labelledby="bdf-quick-block-title">
        <h2 id="bdf-quick-block-title">添加屏蔽关键词</h2>
        <p class="bdf-help">可以先选中动态中的文字，再点击右上角“屏蔽”。</p>
        <label for="bdf-quick-block-input">关键词</label>
        <input id="bdf-quick-block-input" type="text" maxlength="80" autocomplete="off" aria-describedby="bdf-quick-block-validation">
        <p class="bdf-help" id="bdf-quick-block-video-note">这是一条视频动态；如果视频过滤当前已关闭，保存时会同时开启。</p>
        <pre id="bdf-quick-block-validation" aria-live="polite"></pre>
        <div class="bdf-actions">
          <button type="button" data-action="cancel">取消</button>
          <button type="submit" class="bdf-primary" data-action="save">保存并屏蔽</button>
        </div>
      </form>
    `;

    const form = overlay.querySelector('#bdf-quick-block-dialog');
    const input = overlay.querySelector('#bdf-quick-block-input');
    const videoNote = overlay.querySelector('#bdf-quick-block-video-note');
    const validation = overlay.querySelector('#bdf-quick-block-validation');
    const cancelButton = overlay.querySelector('[data-action="cancel"]');
    const saveButton = overlay.querySelector('[data-action="save"]');
    let isSaving = false;
    input.value = selectedTextInsideCard(card);
    videoNote.hidden = !videoDynamic;

    const setSaving = (saving) => {
      isSaving = saving;
      input.disabled = saving;
      cancelButton.disabled = saving;
      saveButton.disabled = saving;
      saveButton.textContent = saving ? '正在保存…' : '保存并屏蔽';
    };
    const close = (force = false) => {
      if (isSaving && !force) return false;
      document.removeEventListener('keydown', handleKeydown);
      overlay.remove();
      if (closeQuickBlockDialog === close) closeQuickBlockDialog = null;
      previousFocus?.focus?.();
      return true;
    };
    const handleKeydown = (event) => {
      if (event.key === 'Escape') close();
    };

    input.addEventListener('input', () => {
      validation.textContent = '';
      validation.classList.remove('bdf-error');
    });
    cancelButton.addEventListener('click', () => close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (isSaving) return;
      setSaving(true);

      let outcome;
      try {
        await saveConfig((currentConfig) => {
          outcome = resolveQuickBlockUpdate(
            currentConfig,
            input.value,
            cardText,
            videoDynamic,
            () => true,
          );
          if (outcome.result.error) throw new Error(outcome.result.error);
          return outcome.config;
        });
      } catch (error) {
        validation.textContent = error instanceof Error
          ? error.message
          : '快捷屏蔽保存失败，请重试';
        validation.classList.add('bdf-error');
        setSaving(false);
        input.focus();
        return;
      }

      if (!outcome.result.added) {
        validation.textContent = `“${outcome.result.keyword}”已经在屏蔽列表中`;
        validation.classList.remove('bdf-error');
        isSaving = false;
        cancelButton.disabled = false;
        cancelButton.textContent = '关闭';
        saveButton.hidden = true;
        return;
      }
      close(true);
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    closeQuickBlockDialog = close;
    document.addEventListener('keydown', handleKeydown);
    document.body.append(overlay);
    input.focus();
    if (input.value) input.select();
  }

  function syncQuickBlockButton(card) {
    const existingButton = Array.from(card.children).find(
      (child) => child.matches(QUICK_BLOCK_SELECTOR),
    );
    if (!config.enabled || !config.showQuickBlockButton) {
      existingButton?.remove();
      card.classList.remove(QUICK_BLOCK_HOST_CLASS);
      return;
    }
    if (existingButton) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.bdfQuickBlock = '';
    button.setAttribute('aria-label', '选择关键词屏蔽这条动态');
    button.title = '选择关键词屏蔽这条动态';
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      quickBlockCard(card);
    });
    card.classList.add(QUICK_BLOCK_HOST_CLASS);
    card.append(button);
  }

  function filterCard(card) {
    if (!(card instanceof Element)) return;

    syncQuickBlockButton(card);

    const text = extractCardText(card);
    const videoDynamic = isVideoDynamic(card);
    const previous = cardState.get(card);
    if (
      previous?.revision === configRevision &&
      previous.text === text &&
      previous.videoDynamic === videoDynamic
    ) {
      reconcileCardMatchHighlight(card, previous.match);
      return;
    }

    const match = config.enabled && parsedRules.length > 0
      ? findMatch(text, parsedRules)
      : null;
    cardState.set(card, { revision: configRevision, text, videoDynamic, match });

    if (!match) {
      clearCardMatchHighlights(card);
      if (previewTarget === card) previewTarget = null;
      card.classList.remove(PREVIEW_TARGET_CLASS);
      card.classList.remove(HIDDEN_CLASS);
      card.classList.remove(VIDEO_MATCH_CLASS);
      card.classList.remove(PREVIEW_DISMISSED_CLASS);
      syncRestoreBlockButton(card);
      card.style.removeProperty('--bdf-original-display');
      card.removeAttribute('data-bdf-rule');
      card.removeAttribute('data-bdf-rule-type');
      return;
    }

    card.classList.toggle(VIDEO_MATCH_CLASS, videoDynamic);
    card.dataset.bdfRule = match.source;
    card.dataset.bdfRuleType = match.type;

    if (!shouldHideMatchedCard(videoDynamic, config.filterVideoDynamics)) {
      clearCardMatchHighlights(card);
      card.classList.remove(HIDDEN_CLASS);
      card.classList.remove(PREVIEW_DISMISSED_CLASS);
      syncRestoreBlockButton(card);
      card.style.removeProperty('--bdf-original-display');
      return;
    }

    if (!card.classList.contains(HIDDEN_CLASS)) {
      const originalDisplay = getComputedStyle(card).display;
      if (originalDisplay !== 'none') {
        card.style.setProperty('--bdf-original-display', originalDisplay);
      }
    }
    card.classList.add(HIDDEN_CLASS);
    reconcileCardMatchHighlight(card, match);
  }

  function scanRoot(root) {
    if (!(root instanceof Element)) return;

    const cards = new Set();
    const containingCard = canonicalCard(root);
    if (containingCard) cards.add(containingCard);
    if (root.matches(CARD_SELECTOR)) cards.add(canonicalCard(root));
    root.querySelectorAll(CARD_SELECTOR).forEach((element) => {
      cards.add(canonicalCard(element));
    });

    cards.delete(null);
    cards.forEach(filterCard);
  }

  function queueScan(root) {
    if (!(root instanceof Element)) return;
    if (root.closest(OWNED_UI_SELECTOR)) return;

    const scanTarget = canonicalCard(root) || root;
    for (const pendingRoot of pendingRoots) {
      if (pendingRoot.contains(scanTarget)) return;
      if (scanTarget.contains(pendingRoot)) pendingRoots.delete(pendingRoot);
    }
    pendingRoots.add(scanTarget);

    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      roots.forEach(scanRoot);
      updateStats();
    }, 80);
  }

  function observeDynamicContent() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'characterData') {
          queueScan(mutation.target.parentElement);
          return;
        }

        let queuedAddedElement = false;
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          queuedAddedElement = true;
          queueScan(node);
        });
        if (!queuedAddedElement) queueScan(mutation.target);
      });
    });

    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function updateStats() {
    if (!statusPanel) return;

    let hiddenCount = 0;
    let videoMatchCount = 0;
    let hiddenVideoCount = 0;
    document
      .querySelectorAll(`.${HIDDEN_CLASS}, .${VIDEO_MATCH_CLASS}`)
      .forEach((card) => {
        const hidden = card.classList.contains(HIDDEN_CLASS);
        const videoMatch = card.classList.contains(VIDEO_MATCH_CLASS);
        if (hidden) hiddenCount += 1;
        if (videoMatch) videoMatchCount += 1;
        if (hidden && videoMatch) hiddenVideoCount += 1;
      });
    const resolvedPreviewMode = resolvePreviewMode(
      previewMode,
      hiddenCount,
      hiddenVideoCount,
    );
    if (resolvedPreviewMode !== previewMode) setBlockedContentPreview(resolvedPreviewMode, false);

    const wasHidden = statusPanel.hidden;
    const panelVisible = shouldShowStatusPanel(config, parsedRules.length);
    statusPanel.hidden = !panelVisible;
    const statusText = formatStatusText(
      hiddenCount,
      videoMatchCount,
      config.filterVideoDynamics,
    );
    if (statusCount.textContent !== statusText) statusCount.textContent = statusText;
    const hiddenText = String(hiddenCount);
    const videoText = String(videoMatchCount);
    const compactStatsChanged = (
      compactHiddenCount.textContent !== hiddenText ||
      compactVideoCount.textContent !== videoText
    );
    if (compactHiddenCount.textContent !== hiddenText) compactHiddenCount.textContent = hiddenText;
    if (compactVideoCount.textContent !== videoText) compactVideoCount.textContent = videoText;
    const videoLabel = config.filterVideoDynamics ? '视频命中' : '视频命中（未过滤）';
    const compactLabel = `已屏蔽 ${hiddenCount} 条动态，${videoLabel} ${videoMatchCount} 条；点击展开，拖动调整位置`;
    if (compactToggle.getAttribute('aria-label') !== compactLabel) {
      compactToggle.setAttribute('aria-label', compactLabel);
    }
    previewButton.disabled = hiddenCount === 0;
    videoPreviewButton.hidden = hiddenVideoCount === 0;
    if (
      !panelVisible || hiddenCount === 0 ||
      (document.querySelector('#bdf-list-dialog')?.dataset.mode === 'video' && hiddenVideoCount === 0)
    ) {
      closeBlockedListDialog?.();
    }
    positionBlockedListDialog?.();
    if (panelVisible && (wasHidden || (uiState.compact && compactStatsChanged))) {
      requestAnimationFrame(applyStatusPanelPosition);
    }
  }

  function setBlockedContentPreview(mode, refreshStats = true) {
    previewMode = mode;
    if (mode === 'none') {
      previewTarget?.classList.remove(PREVIEW_TARGET_CLASS);
      previewTarget = null;
      document.querySelectorAll(`.${PREVIEW_DISMISSED_CLASS}`).forEach((card) => {
        card.classList.remove(PREVIEW_DISMISSED_CLASS);
      });
    }
    document.documentElement.classList.toggle(PREVIEW_CLASS, previewMode === 'all');
    document.documentElement.classList.toggle(
      VIDEO_PREVIEW_CLASS,
      previewMode === 'video',
    );
    syncMatchHighlights();
    if (refreshStats) updateStats();
  }

  function openBlockedListDialog(mode) {
    if (document.querySelector('#bdf-list-dialog')?.dataset.mode === mode) {
      closeBlockedListDialog?.();
      return;
    }
    closeBlockedListDialog?.();
    const cards = getBlockedPreviewCards(document, mode);
    if (cards.length === 0) return;

    const previousFocus = document.activeElement;
    const anchor = mode === 'video' ? videoPreviewButton : previewButton;
    const dialog = document.createElement('section');
    dialog.id = 'bdf-list-dialog';
    dialog.dataset.mode = mode;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-labelledby', 'bdf-list-title');
    dialog.innerHTML = `
      <div class="bdf-list-header">
        <h2 id="bdf-list-title"></h2>
        <button type="button" data-action="close" aria-label="关闭列表">×</button>
      </div>
      <ol id="bdf-blocked-list"></ol>
      <p id="bdf-list-message" aria-live="polite"></p>
      <div class="bdf-actions">
        <button type="button" data-action="restore" hidden>恢复全部屏蔽</button>
      </div>
    `;
    dialog.querySelector('#bdf-list-title').textContent = `${mode === 'video' ? '已屏蔽视频' : '已屏蔽动态'}（${cards.length}）`;
    const list = dialog.querySelector('#bdf-blocked-list');
    const message = dialog.querySelector('#bdf-list-message');
    const position = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const rect = dialog.getBoundingClientRect();
      const above = anchorRect.top >= rect.height + 16;
      const point = clampPanelPosition(
        {
          x: anchorRect.right - rect.width,
          y: above ? anchorRect.top - rect.height - 8 : anchorRect.bottom + 8,
        },
        { width: window.innerWidth, height: window.innerHeight },
        { width: rect.width, height: rect.height },
      );
      dialog.style.left = `${point.x}px`;
      dialog.style.top = `${point.y}px`;
    };
    const close = () => {
      const shouldRestoreFocus = dialog.contains(document.activeElement);
      document.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('pointerdown', handleOutside);
      window.removeEventListener('resize', position);
      dialog.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (closeBlockedListDialog === close) closeBlockedListDialog = null;
      if (positionBlockedListDialog === position) positionBlockedListDialog = null;
      if (shouldRestoreFocus) previousFocus?.focus?.();
    };
    const handleKeydown = (event) => {
      if (event.key === 'Escape') close();
    };
    const handleOutside = (event) => {
      if (!dialog.contains(event.target) && !statusPanel.contains(event.target)) close();
    };

    cards.forEach((card) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const author = document.createElement('span');
      const avatar = document.createElement('img');
      const name = document.createElement('strong');
      const excerpt = document.createElement('span');
      button.type = 'button';
      author.className = 'bdf-list-author';
      excerpt.className = 'bdf-list-excerpt';
      const cardAuthor = extractCardAuthor(card);
      avatar.alt = '';
      avatar.loading = 'lazy';
      if (cardAuthor.avatarUrl) avatar.src = cardAuthor.avatarUrl;
      name.textContent = cardAuthor.name;
      author.append(avatar, name);
      const text = extractCardText(card);
      excerpt.textContent = text ? `${text.slice(0, 120)}${text.length > 120 ? '…' : ''}` : '无文字内容';
      button.append(author, excerpt);
      button.addEventListener('click', () => {
        if (!card.isConnected || !card.classList.contains(HIDDEN_CLASS)) {
          message.textContent = '这条动态已不在当前页面，请重新打开列表';
          return;
        }
        const wasDismissed = card.classList.contains(PREVIEW_DISMISSED_CLASS);
        card.classList.remove(PREVIEW_DISMISSED_CLASS);
        if (previewMode !== mode) setBlockedContentPreview(mode);
        else if (wasDismissed) reconcileCardMatchHighlight(card, cardState.get(card)?.match);
        previewTarget?.classList.remove(PREVIEW_TARGET_CLASS);
        previewTarget = card;
        card.classList.add(PREVIEW_TARGET_CLASS);
        list.querySelector('[aria-current="true"]')?.removeAttribute('aria-current');
        button.setAttribute('aria-current', 'true');
        restoreButton.hidden = false;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      item.append(button);
      list.append(item);
    });

    const restoreButton = dialog.querySelector('[data-action="restore"]');
    restoreButton.hidden = previewMode === 'none';
    restoreButton.addEventListener('click', () => {
      setBlockedContentPreview('none');
      close();
    });
    dialog.querySelector('[data-action="close"]').addEventListener('click', close);
    closeBlockedListDialog = close;
    positionBlockedListDialog = position;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('pointerdown', handleOutside);
    window.addEventListener('resize', position);
    document.body.append(dialog);
    position();
    list.querySelector('button')?.focus();
  }

  function setStatusPanelPosition(position) {
    statusPanel.style.left = `${Math.round(position.x)}px`;
    statusPanel.style.top = `${Math.round(position.y)}px`;
    statusPanel.style.right = 'auto';
    statusPanel.style.bottom = 'auto';
    positionBlockedListDialog?.();
  }

  function applyStatusPanelPosition() {
    if (!statusPanel || statusPanel.hidden || activePanelDrag) return;
    if (!uiState.position) {
      statusPanel.style.removeProperty('left');
      statusPanel.style.removeProperty('top');
      statusPanel.style.removeProperty('right');
      statusPanel.style.removeProperty('bottom');
      return;
    }

    const rect = statusPanel.getBoundingClientRect();
    setStatusPanelPosition(clampPanelPosition(
      uiState.position,
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
    ));
  }

  async function setStatusPanelCompact(compact) {
    if (compactSavePending || uiState.compact === compact) return;
    if (compact) closeBlockedListDialog?.();
    compactSavePending = true;
    try {
      await updateUiState({ compact });
    } catch (error) {
      console.error('[哔哩哔哩动态屏蔽] 状态面板显示模式保存失败', error);
      return;
    } finally {
      compactSavePending = false;
    }

    statusPanel.classList.toggle('bdf-compact', uiState.compact);
    applyStatusPanelPosition();
  }

  function installPanelDragging(handle, compactHandle = false) {
    let dragSession = null;

    handle.addEventListener('pointerdown', (event) => {
      if (dragSession || activePanelDrag) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!compactHandle && event.target.closest('button')) return;

      const rect = statusPanel.getBoundingClientRect();
      dragSession = {
        pointerId: event.pointerId,
        startPointer: { x: event.clientX, y: event.clientY },
        startPosition: { x: rect.left, y: rect.top },
        panelSize: { width: rect.width, height: rect.height },
        moved: false,
      };
      activePanelDrag = true;
      handle.setPointerCapture?.(event.pointerId);
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragSession || event.pointerId !== dragSession.pointerId) return;

      const current = { x: event.clientX, y: event.clientY };
      if (!dragSession.moved) {
        dragSession.moved = isDragGesture(dragSession.startPointer, current);
        if (!dragSession.moved) return;
        statusPanel.classList.add('bdf-dragging');
      }

      const position = clampPanelPosition(
        {
          x: dragSession.startPosition.x + current.x - dragSession.startPointer.x,
          y: dragSession.startPosition.y + current.y - dragSession.startPointer.y,
        },
        { width: window.innerWidth, height: window.innerHeight },
        dragSession.panelSize,
      );
      setStatusPanelPosition(position);
      event.preventDefault();
    });

    const finishDrag = async (event, persistPosition) => {
      if (!dragSession || event.pointerId !== dragSession.pointerId) return;

      const { moved } = dragSession;
      dragSession = null;
      activePanelDrag = false;
      statusPanel.classList.remove('bdf-dragging');
      if (handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }

      if (!moved) {
        applyStatusPanelPosition();
        return;
      }
      if (compactHandle) {
        suppressCompactClick = true;
        setTimeout(() => {
          suppressCompactClick = false;
        }, 0);
      }

      if (!persistPosition) {
        applyStatusPanelPosition();
        return;
      }

      const rect = statusPanel.getBoundingClientRect();
      const position = clampPanelPosition(
        { x: rect.left, y: rect.top },
        { width: window.innerWidth, height: window.innerHeight },
        { width: rect.width, height: rect.height },
      );
      setStatusPanelPosition(position);
      try {
        await updateUiState({
          position: { x: Math.round(position.x), y: Math.round(position.y) },
        });
        applyStatusPanelPosition();
      } catch (error) {
        applyStatusPanelPosition();
        console.error('[哔哩哔哩动态屏蔽] 状态面板位置保存失败', error);
      }
    };

    handle.addEventListener('pointerup', (event) => finishDrag(event, true));
    handle.addEventListener('pointercancel', (event) => finishDrag(event, false));
  }

  function createStatusPanel() {
    statusPanel = document.createElement('aside');
    statusPanel.id = 'bdf-status';
    statusPanel.hidden = true;
    statusPanel.setAttribute('aria-label', '动态屏蔽状态');
    statusPanel.innerHTML = `
      <div class="bdf-status-expanded">
        <div class="bdf-status-header" title="拖动调整位置">
          <div id="bdf-status-count" aria-live="polite">${formatStatusText(0, 0, true)}</div>
          <button type="button" class="bdf-collapse" data-action="collapse" aria-label="缩小状态面板" title="缩小">−</button>
        </div>
        <div class="bdf-status-actions">
          <button type="button" data-action="preview" aria-label="查看全部屏蔽内容" aria-controls="bdf-list-dialog" aria-expanded="false">查看全部</button>
          <button type="button" data-action="preview-video" aria-label="仅查看被屏蔽的视频动态" aria-controls="bdf-list-dialog" aria-expanded="false" hidden>仅看视频</button>
          <button type="button" data-action="config">配置</button>
        </div>
      </div>
      <button id="bdf-compact-toggle" type="button" title="粉色：已屏蔽动态；蓝色：视频命中。点击展开，拖动调整位置">
        <span class="bdf-mini-stat bdf-mini-hidden"><strong id="bdf-mini-hidden">0</strong></span>
        <span class="bdf-mini-stat bdf-mini-video"><strong id="bdf-mini-video">0</strong></span>
      </button>
    `;

    statusCount = statusPanel.querySelector('#bdf-status-count');
    compactHiddenCount = statusPanel.querySelector('#bdf-mini-hidden');
    compactVideoCount = statusPanel.querySelector('#bdf-mini-video');
    compactToggle = statusPanel.querySelector('#bdf-compact-toggle');
    previewButton = statusPanel.querySelector('[data-action="preview"]');
    videoPreviewButton = statusPanel.querySelector('[data-action="preview-video"]');
    previewButton.addEventListener('click', () => {
      openBlockedListDialog('all');
    });
    videoPreviewButton.addEventListener('click', () => {
      openBlockedListDialog('video');
    });
    statusPanel.querySelector('[data-action="config"]').addEventListener('click', openConfigDialog);
    statusPanel.querySelector('[data-action="collapse"]').addEventListener('click', () => {
      setStatusPanelCompact(true);
    });
    compactToggle.addEventListener('click', () => {
      if (suppressCompactClick) {
        suppressCompactClick = false;
        return;
      }
      setStatusPanelCompact(false);
    });
    installPanelDragging(statusPanel.querySelector('.bdf-status-header'));
    installPanelDragging(compactToggle, true);
    statusPanel.classList.toggle('bdf-compact', uiState.compact);
    document.body.append(statusPanel);
  }

  function formatErrors(errors) {
    return errors.length > 0 ? errors.join('\n') : '规则格式正确';
  }

  async function openConfigDialog() {
    closeBlockedListDialog?.();
    if (closeConfigDialog && closeConfigDialog() === false) return;
    try {
      applyConfig(await GM.getValue(CONFIG_KEY, config));
    } catch (error) {
      console.error('[哔哩哔哩动态屏蔽] 打开配置前读取 Storage 失败', error);
    }
    const openingConfig = { ...config };

    const overlay = document.createElement('div');
    overlay.id = 'bdf-overlay';
    overlay.innerHTML = `
      <section id="bdf-dialog" role="dialog" aria-modal="true" aria-labelledby="bdf-title">
        <h2 id="bdf-title">哔哩哔哩动态屏蔽</h2>
        <label class="bdf-switch-row">
          <input id="bdf-enabled" type="checkbox">
          启用动态屏蔽
        </label>
        <label class="bdf-switch-row">
          <input id="bdf-show-status" type="checkbox">
          在右下角显示过滤状态
        </label>
        <label class="bdf-switch-row">
          <input id="bdf-filter-video" type="checkbox">
          过滤视频动态（关闭后仍统计命中数量）
        </label>
        <label class="bdf-switch-row">
          <input id="bdf-show-quick-block" type="checkbox">
          在每条动态右上角显示“屏蔽”按钮
        </label>
        <label for="bdf-rules">屏蔽规则（关键词用逗号分隔，每条正则独占一行）</label>
        <textarea id="bdf-rules" spellcheck="false" placeholder="广告, 带货&#10;/抽奖|推广/i"></textarea>
        <p class="bdf-help">关键词单独占一行、彼此用英文或中文逗号分隔，按包含关系匹配（不区分大小写）；每个正则表达式单独占一行，以 <code>/表达式/标志</code> 书写，正则内部的逗号不会被拆分；正则含正向前瞻时，查看模式优先标红其中实际命中的词；以 <code>#</code> 开头的行是注释。</p>
        <pre id="bdf-validation" aria-live="polite"></pre>
        <div class="bdf-actions">
          <button type="button" data-action="cancel">取消</button>
          <button type="button" class="bdf-primary" data-action="save">保存并重新过滤</button>
        </div>
      </section>
    `;

    const enabledInput = overlay.querySelector('#bdf-enabled');
    const showStatusInput = overlay.querySelector('#bdf-show-status');
    const filterVideoInput = overlay.querySelector('#bdf-filter-video');
    const showQuickBlockInput = overlay.querySelector('#bdf-show-quick-block');
    const rulesInput = overlay.querySelector('#bdf-rules');
    const validation = overlay.querySelector('#bdf-validation');
    const cancelButton = overlay.querySelector('[data-action="cancel"]');
    const saveButton = overlay.querySelector('[data-action="save"]');
    const editableControls = [
      enabledInput,
      showStatusInput,
      filterVideoInput,
      showQuickBlockInput,
      rulesInput,
      cancelButton,
      saveButton,
    ];
    let isSaving = false;
    enabledInput.checked = config.enabled;
    showStatusInput.checked = config.showStatusPanel;
    filterVideoInput.checked = config.filterVideoDynamics;
    showQuickBlockInput.checked = config.showQuickBlockButton;
    rulesInput.value = formatRulesText(config.rulesText);

    const validate = () => {
      const result = parseRules(rulesInput.value);
      validation.textContent = formatErrors(result.errors);
      validation.classList.toggle('bdf-error', result.errors.length > 0);
      return result.errors.length === 0;
    };

    const setSaving = (saving) => {
      isSaving = saving;
      editableControls.forEach((control) => {
        control.disabled = saving;
      });
      saveButton.textContent = saving ? '正在保存…' : '保存并重新过滤';
    };
    const close = (force = false) => {
      if (isSaving && !force) return false;
      document.removeEventListener('keydown', handleKeydown);
      overlay.remove();
      if (closeConfigDialog === close) closeConfigDialog = null;
      return true;
    };
    const handleKeydown = (event) => {
      if (event.key === 'Escape') close();
    };

    rulesInput.addEventListener('input', validate);
    cancelButton.addEventListener('click', () => close());
    saveButton.addEventListener('click', async () => {
      if (isSaving || !validate()) return;
      setSaving(true);
      try {
        const editedConfig = {
          enabled: enabledInput.checked,
          rulesText: formatRulesText(rulesInput.value),
          showStatusPanel: showStatusInput.checked,
          filterVideoDynamics: filterVideoInput.checked,
          showQuickBlockButton: showQuickBlockInput.checked,
        };
        await saveConfig((latestConfig) => {
          const resolved = mergeConfigEdits(openingConfig, editedConfig, latestConfig);
          if (resolved.conflicts.length > 0) {
            throw new Error('配置已在其他标签页更新，当前修改与最新配置冲突；请复制修改内容，重新打开配置后再保存');
          }
          return resolved.config;
        });
      } catch (error) {
        validation.textContent = error instanceof Error
          ? error.message
          : '配置写入 Tampermonkey Storage 失败，请重试';
        validation.classList.add('bdf-error');
        setSaving(false);
        return;
      }
      close(true);
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    closeConfigDialog = close;
    document.addEventListener('keydown', handleKeydown);
    document.body.append(overlay);
    validate();
    rulesInput.focus();
  }

  async function toggleFiltering() {
    try {
      await saveConfig((currentConfig) => ({
        ...currentConfig,
        enabled: !currentConfig.enabled,
      }));
    } catch (error) {
      console.error('[哔哩哔哩动态屏蔽] 配置保存失败', error);
      window.alert('动态屏蔽开关保存失败，请打开配置页面重试。');
    }
  }

  function installStyles() {
    GM_addStyle(`
      .${HIDDEN_CLASS} { display: none !important; }
      html.${PREVIEW_CLASS} .${HIDDEN_CLASS},
      html.${VIDEO_PREVIEW_CLASS} .${HIDDEN_CLASS}.${VIDEO_MATCH_CLASS} {
        display: var(--bdf-original-display, block) !important; position: relative;
        outline: 2px dashed #fb7299; outline-offset: 4px;
      }
      html.${PREVIEW_CLASS} .${HIDDEN_CLASS}.${PREVIEW_DISMISSED_CLASS},
      html.${VIDEO_PREVIEW_CLASS} .${HIDDEN_CLASS}.${VIDEO_MATCH_CLASS}.${PREVIEW_DISMISSED_CLASS} {
        display: none !important;
      }
      html.${PREVIEW_CLASS} .${HIDDEN_CLASS}::before,
      html.${VIDEO_PREVIEW_CLASS} .${HIDDEN_CLASS}.${VIDEO_MATCH_CLASS}::before {
        content: "已被动态屏蔽规则命中";
        display: inline-block; position: relative; z-index: 1;
        margin: 0 0 8px 12px; border-radius: 999px; padding: 4px 10px;
        color: #fff; background: #fb7299; font-size: 12px; line-height: 1.4;
      }
      html.${VIDEO_PREVIEW_CLASS} .${HIDDEN_CLASS}.${VIDEO_MATCH_CLASS}::before {
        content: "已屏蔽的视频动态"; background: #00aeec;
      }
      html.${PREVIEW_CLASS} .${PREVIEW_TARGET_CLASS},
      html.${VIDEO_PREVIEW_CLASS} .${PREVIEW_TARGET_CLASS} {
        outline: 3px solid #00aeec; outline-offset: 4px;
      }
      ${HIGHLIGHT_SELECTOR} {
        color: #d83a52 !important; background: transparent; pointer-events: none;
      }
      .${QUICK_BLOCK_HOST_CLASS} { position: relative; }
      ${QUICK_BLOCK_SELECTOR} {
        position: absolute; top: 12px; right: 44px; z-index: 4;
        min-width: 42px; height: 25px; box-sizing: border-box;
        border: 1px solid rgb(251 114 153 / 55%); border-radius: 13px; padding: 0 8px;
        color: #fb7299; background: rgb(255 255 255 / 90%); cursor: pointer;
        opacity: .72; font: 12px/23px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      ${QUICK_BLOCK_SELECTOR}::before { content: "屏蔽"; }
      ${QUICK_BLOCK_SELECTOR}:hover,
      ${QUICK_BLOCK_SELECTOR}:focus-visible { opacity: 1; color: #fff; background: #fb7299; }
      .${HIDDEN_CLASS} > ${QUICK_BLOCK_SELECTOR} { display: none !important; }
      ${RESTORE_BLOCK_SELECTOR} {
        position: absolute; top: 8px; right: 8px; z-index: 4;
        border: 1px solid #fb7299; border-radius: 13px; padding: 3px 9px;
        color: #fb7299; background: #fff; cursor: pointer;
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      ${RESTORE_BLOCK_SELECTOR}::before { content: "恢复屏蔽"; }
      ${RESTORE_BLOCK_SELECTOR}:hover, ${RESTORE_BLOCK_SELECTOR}:focus-visible { color: #fff; background: #fb7299; }
      #bdf-status {
        position: fixed; right: 24px; bottom: 24px; z-index: 99998;
        width: 252px; min-width: 0; max-width: calc(100vw - 16px); box-sizing: border-box;
        border: 1px solid #e3e5e7;
        border-radius: 11px; padding: 10px; color: #18191c; background: #fff;
        box-shadow: 0 6px 24px rgb(0 0 0 / 16%);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #bdf-status[hidden] { display: none !important; }
      #bdf-status.bdf-compact {
        min-width: 0; width: auto; max-width: none; border: 0; border-radius: 12px; padding: 5px;
        background: rgb(255 255 255 / 94%); box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
      }
      #bdf-status.bdf-dragging { box-shadow: 0 10px 32px rgb(0 0 0 / 24%); }
      .bdf-status-expanded { display: block; }
      #bdf-status.bdf-compact .bdf-status-expanded { display: none; }
      .bdf-status-header {
        display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
        cursor: grab; touch-action: none; user-select: none;
      }
      #bdf-status.bdf-dragging .bdf-status-header,
      #bdf-status.bdf-dragging #bdf-compact-toggle { cursor: grabbing; }
      #bdf-status-count { flex: 1; font-weight: 600; }
      .bdf-collapse {
        flex: 0 0 auto; width: 24px; height: 24px; border: 0; border-radius: 50%; padding: 0;
        color: #61666d; background: #f1f2f3; cursor: pointer; font: 700 17px/22px sans-serif;
      }
      .bdf-collapse:hover { color: #00aeec; background: #e3f6fc; }
      #bdf-compact-toggle {
        display: none; align-items: center; gap: 5px; border: 0; padding: 0;
        color: #fff; background: transparent; cursor: grab; touch-action: none; user-select: none;
      }
      #bdf-status.bdf-compact #bdf-compact-toggle { display: flex; }
      .bdf-mini-stat {
        display: grid; place-items: center; min-width: 34px; height: 30px;
        box-sizing: border-box; border-radius: 8px; padding: 0 7px;
        color: #fff; font-size: 14px; line-height: 1; font-variant-numeric: tabular-nums;
      }
      .bdf-mini-hidden { background: #fb7299; }
      .bdf-mini-video { background: #00aeec; }
      .bdf-status-actions { display: flex; gap: 6px; }
      .bdf-status-actions button {
        flex: 1 1 0; min-width: 0; border: 1px solid #00aeec; border-radius: 7px;
        padding: 5px 5px; color: #00aeec; background: #fff; cursor: pointer;
        white-space: nowrap; font-size: 12px;
      }
      .bdf-status-actions button[hidden] { display: none !important; }
      .bdf-status-actions button:hover { background: #e3f6fc; }
      .bdf-status-actions button:disabled {
        border-color: #c9ccd0; color: #9499a0; background: #f1f2f3; cursor: not-allowed;
      }
      .bdf-status-actions [data-action="config"] { color: #fff; background: #00aeec; }
      .bdf-status-actions [data-action="config"]:hover { background: #009bd3; }
      #bdf-overlay, #bdf-quick-block-overlay {
        position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center;
        padding: 20px; background: rgb(0 0 0 / 45%); color: #18191c;
      }
      #bdf-dialog, #bdf-quick-block-dialog {
        color-scheme: light;
        width: min(560px, 100%); box-sizing: border-box; padding: 22px;
        border-radius: 14px; background: #fff; box-shadow: 0 16px 48px rgb(0 0 0 / 24%);
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #bdf-quick-block-dialog { width: min(420px, 100%); }
      #bdf-list-dialog {
        position: fixed; z-index: 99999; display: flex; flex-direction: column;
        width: min(340px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 16px));
        box-sizing: border-box; border: 1px solid #e3e5e7; border-radius: 11px; padding: 12px;
        color: #18191c; background: #fff; box-shadow: 0 12px 36px rgb(0 0 0 / 25%);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .bdf-list-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      .bdf-list-header h2 { margin: 0; font-size: 15px; }
      .bdf-list-header button { border: 0; color: inherit; background: transparent; cursor: pointer; font: 24px/1 sans-serif; }
      #bdf-blocked-list { min-height: 0; overflow-y: auto; margin: 16px 0 0; padding: 0; list-style: none; }
      #bdf-blocked-list li + li { border-top: 1px solid #e3e5e7; }
      #bdf-blocked-list button { display: block; width: 100%; border: 0; border-radius: 7px; padding: 10px; color: inherit; background: transparent; text-align: left; cursor: pointer; font: inherit; }
      #bdf-blocked-list button:hover, #bdf-blocked-list button:focus-visible { background: #f1f7fa; }
      #bdf-blocked-list button[aria-current="true"] { background: #e3f6fc; }
      #bdf-blocked-list .bdf-list-author { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
      #bdf-blocked-list .bdf-list-author img { flex: 0 0 30px; width: 30px; height: 30px; border-radius: 50%; object-fit: cover; background: #f1f2f3; }
      #bdf-blocked-list .bdf-list-author strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #bdf-blocked-list .bdf-list-excerpt { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
      #bdf-list-message { margin: 8px 0 0; color: #d83a52; }
      #bdf-list-message:empty { display: none; }
      #bdf-dialog h2, #bdf-quick-block-dialog h2 { margin: 0 0 16px; font-size: 20px; }
      #bdf-dialog label, #bdf-quick-block-dialog label { display: block; margin: 10px 0 6px; font-weight: 600; }
      #bdf-dialog .bdf-switch-row { display: flex; gap: 8px; align-items: center; font-weight: 400; }
      #bdf-rules, #bdf-quick-block-input {
        display: block; width: 100%; min-height: 220px; box-sizing: border-box;
        resize: vertical; border: 1px solid #c9ccd0; border-radius: 8px; padding: 10px;
        color: inherit; background: #fff; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #bdf-quick-block-input { min-height: 40px; resize: none; font-family: inherit; }
      #bdf-rules:focus, #bdf-quick-block-input:focus { outline: 2px solid #00aeec44; border-color: #00aeec; }
      .bdf-help { margin: 8px 0; color: #61666d; font-size: 12px; }
      #bdf-validation, #bdf-quick-block-validation { min-height: 20px; margin: 8px 0; color: #2f9b61; white-space: pre-wrap; font: inherit; }
      #bdf-validation.bdf-error, #bdf-quick-block-validation.bdf-error { color: #d83a52; }
      .bdf-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
      .bdf-actions button { border: 1px solid #c9ccd0; border-radius: 8px; padding: 7px 14px; background: #fff; cursor: pointer; }
      .bdf-actions .bdf-primary { border-color: #00aeec; color: #fff; background: #00aeec; }
      @media (prefers-color-scheme: dark) {
        #bdf-status, #bdf-dialog, #bdf-rules, #bdf-quick-block-dialog, #bdf-quick-block-input, #bdf-list-dialog { color: #e3e5e7; background: #242628; }
        #bdf-dialog, #bdf-quick-block-dialog, #bdf-list-dialog { color-scheme: dark; }
        #bdf-list-dialog { border-color: #55585c; }
        ${RESTORE_BLOCK_SELECTOR} { color: #fb7299; background: #242628; }
        #bdf-blocked-list li + li { border-color: #55585c; }
        #bdf-blocked-list button:hover, #bdf-blocked-list button:focus-visible { background: #333538; }
        #bdf-blocked-list button[aria-current="true"] { background: #163846; }
        #bdf-status { border-color: #55585c; }
        #bdf-status.bdf-compact { background: rgb(36 38 40 / 94%); }
        .bdf-collapse { color: #aeb3b8; background: #333538; }
        .bdf-collapse:hover { color: #00aeec; background: #163846; }
        .bdf-status-actions button { background: #242628; }
        .bdf-status-actions button:hover { background: #163846; }
        .bdf-status-actions button:disabled { color: #777b80; background: #333538; }
        .bdf-status-actions [data-action="config"] { color: #fff; background: #00aeec; }
        #bdf-rules, #bdf-quick-block-input, .bdf-actions button { border-color: #55585c; }
        .bdf-actions button { color: #e3e5e7; background: #333538; }
        .bdf-help { color: #aeb3b8; }
      }
      @media (max-width: 600px) {
        #bdf-status { right: 12px; bottom: 12px; min-width: 0; max-width: calc(100vw - 24px); }
      }
    `);
  }

  async function boot() {
    try {
      const stored = await readStoredState(
        (key, fallback) => GM.getValue(key, fallback),
      );
      config = stored.config;
      uiState = stored.uiState;
      parsedRules = parseRules(config.rulesText).rules;
    } catch (error) {
      console.error('[哔哩哔哩动态屏蔽] 读取 Tampermonkey Storage 失败', error);
    }

    installStyles();
    createStatusPanel();
    scanRoot(document.body);
    updateStats();
    observeDynamicContent();
    let resizeFrame;
    window.addEventListener('resize', () => {
      if (!uiState.position || statusPanel.hidden || resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        applyStatusPanelPosition();
      });
    });

    GM_registerMenuCommand('配置动态屏蔽规则', openConfigDialog);
    GM_registerMenuCommand('启用 / 暂停动态屏蔽', toggleFiltering);
    try {
      await GM.addValueChangeListener(CONFIG_KEY, (_key, _oldValue, newValue) => {
        applyConfig(newValue);
      });
      applyConfig(await GM.getValue(CONFIG_KEY, config));
    } catch (error) {
      console.error('[哔哩哔哩动态屏蔽] 监听 Tampermonkey Storage 失败', error);
    }
  }

  if (document.body) {
    void boot();
  } else {
    window.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
  }
})();
