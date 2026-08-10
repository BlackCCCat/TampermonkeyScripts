// ==UserScript==
// @name         哔哩哔哩动态关键字屏蔽
// @namespace    https://github.com/BlackCCCat/TampermonkeyScripts
// @version      0.5.0
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
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
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
  });
  const DEFAULT_UI_STATE = Object.freeze({
    compact: false,
    position: null,
  });
  const CONFIG_KEY = 'bilibili-dynamic-filter:config:v1';
  const UI_STATE_KEY = 'bilibili-dynamic-filter:ui:v1';
  const VIDEO_CONTENT_SELECTORS = [
    '.bili-dyn-card-video__title',
    '.bili-dyn-card-video__desc',
  ];
  const CONTENT_SELECTOR = [
    '.bili-rich-text__content',
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

  function extractCardText(card) {
    const contentNodes = Array.from(card.querySelectorAll(CONTENT_SELECTOR));
    const outermostNodes = contentNodes.filter((node) => (
      !contentNodes.some((candidate) => candidate !== node && candidate.contains?.(node))
    ));
    const nodes = outermostNodes.length > 0 ? outermostNodes : [card];
    return normalizeText(
      nodes
        .map((node) => node.innerText || node.textContent || '')
        .join(' '),
    );
  }

  function normalizeConfig(stored) {
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_CONFIG };
    return {
      enabled: stored.enabled !== false,
      rulesText: typeof stored.rulesText === 'string' ? stored.rulesText : '',
      showStatusPanel: stored.showStatusPanel !== false,
      filterVideoDynamics: stored.filterVideoDynamics !== false,
    };
  }

  function configsEqual(left, right) {
    return Object.keys(DEFAULT_CONFIG).every((key) => left[key] === right[key]);
  }

  function persistNormalizedValue(
    storageKey,
    nextValue,
    { normalize, valuesEqual, setValue, getValue, errorMessage },
  ) {
    const normalized = normalize(nextValue);
    setValue(storageKey, normalized);
    const storedValue = getValue(storageKey, null);
    const stored = storedValue && typeof storedValue === 'object'
      ? normalize(storedValue)
      : null;
    if (!stored || !valuesEqual(normalized, stored)) {
      throw new Error(errorMessage);
    }
    return normalized;
  }

  function persistConfig(storageKey, nextConfig, setValue, getValue) {
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

  function persistUiState(storageKey, nextState, setValue, getValue) {
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

  function togglePreviewMode(currentMode, targetMode) {
    return currentMode === targetMode ? 'none' : targetMode;
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

  function parseRules(rulesText) {
    const rules = [];
    const errors = [];

    String(rulesText ?? '')
      .split(/\r?\n/)
      .forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return;

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

  if (globalThis.__BDF_TEST_MODE__) {
    globalThis.__BDF_TEST_EXPORTS__ = {
      contentSelector: CONTENT_SELECTOR,
      clampPanelPosition,
      extractCardText,
      findMatch,
      formatStatusText,
      isVideoDynamic,
      isDragGesture,
      normalizeConfig,
      normalizeUiState,
      normalizeText,
      parseRules,
      persistConfig,
      persistUiState,
      resolvePreviewMode,
      shouldHideMatchedCard,
      shouldShowStatusPanel,
      togglePreviewMode,
      videoSelector: VIDEO_SELECTOR,
    };
    return;
  }

  const CARD_SELECTOR = [
    '.bili-dyn-list__item',
    '.bili-dyn-item',
    '[data-did]',
  ].join(',');
  const HIDDEN_CLASS = 'bdf-hidden-dynamic';
  const VIDEO_MATCH_CLASS = 'bdf-matched-video-dynamic';
  const PREVIEW_CLASS = 'bdf-show-blocked-content';
  const VIDEO_PREVIEW_CLASS = 'bdf-show-blocked-videos';
  const OWNED_UI_SELECTOR = '#bdf-status, #bdf-overlay';

  let config = loadConfig();
  let uiState = loadUiState();
  let parsedRules = parseRules(config.rulesText).rules;
  let configRevision = 0;
  let pendingTimer;
  let previewMode = 'none';
  let statusPanel;
  let statusCount;
  let compactHiddenCount;
  let compactVideoCount;
  let compactToggle;
  let previewButton;
  let videoPreviewButton;
  let activePanelDrag = false;
  let suppressCompactClick = false;
  let closeConfigDialog = null;
  const pendingRoots = new Set();
  const cardState = new WeakMap();

  function loadConfig() {
    return normalizeConfig(GM_getValue(CONFIG_KEY, DEFAULT_CONFIG));
  }

  function loadUiState() {
    return normalizeUiState(GM_getValue(UI_STATE_KEY, DEFAULT_UI_STATE));
  }

  function saveUiState(nextState) {
    uiState = persistUiState(
      UI_STATE_KEY,
      nextState,
      GM_setValue,
      GM_getValue,
    );
    return uiState;
  }

  function saveConfig(nextConfig) {
    const savedConfig = persistConfig(
      CONFIG_KEY,
      nextConfig,
      GM_setValue,
      GM_getValue,
    );
    config = savedConfig;
    parsedRules = parseRules(config.rulesText).rules;
    configRevision += 1;
    setBlockedContentPreview('none', false);
    scanRoot(document.body);
    updateStats();
  }

  function canonicalCard(element) {
    if (!(element instanceof Element)) return null;
    return (
      element.closest('.bili-dyn-list__item') ||
      element.closest('.bili-dyn-item') ||
      element.closest('[data-did]')
    );
  }

  function filterCard(card) {
    if (!(card instanceof Element)) return;

    const text = extractCardText(card);
    const videoDynamic = isVideoDynamic(card);
    const previous = cardState.get(card);
    if (
      previous?.revision === configRevision &&
      previous.text === text &&
      previous.videoDynamic === videoDynamic
    ) return;

    cardState.set(card, { revision: configRevision, text, videoDynamic });
    const match = config.enabled && parsedRules.length > 0
      ? findMatch(text, parsedRules)
      : null;

    if (!match) {
      card.classList.remove(HIDDEN_CLASS);
      card.classList.remove(VIDEO_MATCH_CLASS);
      card.style.removeProperty('--bdf-original-display');
      card.removeAttribute('data-bdf-rule');
      card.removeAttribute('data-bdf-rule-type');
      return;
    }

    card.classList.toggle(VIDEO_MATCH_CLASS, videoDynamic);
    card.dataset.bdfRule = match.source;
    card.dataset.bdfRuleType = match.type;

    if (!shouldHideMatchedCard(videoDynamic, config.filterVideoDynamics)) {
      card.classList.remove(HIDDEN_CLASS);
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
    const previewText = previewMode === 'all' ? '恢复屏蔽' : '查看全部';
    if (previewButton.textContent !== previewText) previewButton.textContent = previewText;
    previewButton.setAttribute(
      'aria-label',
      previewMode === 'all' ? '恢复动态屏蔽' : '查看全部屏蔽内容',
    );
    const pressed = String(previewMode === 'all');
    if (previewButton.getAttribute('aria-pressed') !== pressed) {
      previewButton.setAttribute('aria-pressed', pressed);
    }
    videoPreviewButton.hidden = hiddenVideoCount === 0;
    const videoPreviewText = previewMode === 'video' ? '恢复屏蔽' : '仅看视频';
    if (videoPreviewButton.textContent !== videoPreviewText) {
      videoPreviewButton.textContent = videoPreviewText;
    }
    videoPreviewButton.setAttribute(
      'aria-label',
      previewMode === 'video' ? '恢复视频动态屏蔽' : '仅查看被屏蔽的视频动态',
    );
    const videoPressed = String(previewMode === 'video');
    if (videoPreviewButton.getAttribute('aria-pressed') !== videoPressed) {
      videoPreviewButton.setAttribute('aria-pressed', videoPressed);
    }
    if (panelVisible && (wasHidden || (uiState.compact && compactStatsChanged))) {
      requestAnimationFrame(applyStatusPanelPosition);
    }
  }

  function setBlockedContentPreview(mode, refreshStats = true) {
    previewMode = mode;
    document.documentElement.classList.toggle(PREVIEW_CLASS, previewMode === 'all');
    document.documentElement.classList.toggle(
      VIDEO_PREVIEW_CLASS,
      previewMode === 'video',
    );
    if (refreshStats) updateStats();
  }

  function setStatusPanelPosition(position) {
    statusPanel.style.left = `${Math.round(position.x)}px`;
    statusPanel.style.top = `${Math.round(position.y)}px`;
    statusPanel.style.right = 'auto';
    statusPanel.style.bottom = 'auto';
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

  function setStatusPanelCompact(compact) {
    try {
      saveUiState({ ...uiState, compact });
    } catch (error) {
      console.error('[哔哩哔哩动态屏蔽] 状态面板显示模式保存失败', error);
      return;
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

    const finishDrag = (event, persistPosition) => {
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

      const previousState = uiState;
      const rect = statusPanel.getBoundingClientRect();
      const position = clampPanelPosition(
        { x: rect.left, y: rect.top },
        { width: window.innerWidth, height: window.innerHeight },
        { width: rect.width, height: rect.height },
      );
      setStatusPanelPosition(position);
      const nextState = {
        ...uiState,
        position: { x: Math.round(position.x), y: Math.round(position.y) },
      };
      if (uiStatesEqual(uiState, nextState)) return;
      try {
        saveUiState(nextState);
      } catch (error) {
        uiState = previousState;
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
          <button type="button" data-action="preview" aria-label="查看全部屏蔽内容" aria-pressed="false">查看全部</button>
          <button type="button" data-action="preview-video" aria-label="仅查看被屏蔽的视频动态" aria-pressed="false" hidden>仅看视频</button>
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
      setBlockedContentPreview(togglePreviewMode(previewMode, 'all'));
    });
    videoPreviewButton.addEventListener('click', () => {
      setBlockedContentPreview(togglePreviewMode(previewMode, 'video'));
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

  function openConfigDialog() {
    closeConfigDialog?.();

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
        <label for="bdf-rules">屏蔽规则（每行一条）</label>
        <textarea id="bdf-rules" spellcheck="false" placeholder="广告\n/抽奖|推广/i"></textarea>
        <p class="bdf-help">普通文本按关键字匹配（不区分大小写）；以 <code>/表达式/标志</code> 书写正则；以 <code>#</code> 开头的行是注释。</p>
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
    const rulesInput = overlay.querySelector('#bdf-rules');
    const validation = overlay.querySelector('#bdf-validation');
    enabledInput.checked = config.enabled;
    showStatusInput.checked = config.showStatusPanel;
    filterVideoInput.checked = config.filterVideoDynamics;
    rulesInput.value = config.rulesText;

    const validate = () => {
      const result = parseRules(rulesInput.value);
      validation.textContent = formatErrors(result.errors);
      validation.classList.toggle('bdf-error', result.errors.length > 0);
      return result.errors.length === 0;
    };

    const close = () => {
      document.removeEventListener('keydown', handleKeydown);
      overlay.remove();
      if (closeConfigDialog === close) closeConfigDialog = null;
    };
    const handleKeydown = (event) => {
      if (event.key === 'Escape') close();
    };

    rulesInput.addEventListener('input', validate);
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
    overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
      if (!validate()) return;
      try {
        saveConfig({
          enabled: enabledInput.checked,
          rulesText: rulesInput.value,
          showStatusPanel: showStatusInput.checked,
          filterVideoDynamics: filterVideoInput.checked,
        });
      } catch (error) {
        validation.textContent = error instanceof Error
          ? error.message
          : '配置写入 Tampermonkey Storage 失败，请重试';
        validation.classList.add('bdf-error');
        return;
      }
      close();
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

  function toggleFiltering() {
    try {
      saveConfig({ ...config, enabled: !config.enabled });
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
      .bdf-status-actions [data-action="preview"][aria-pressed="true"] {
        border-color: #fb7299; color: #fff; background: #fb7299;
      }
      .bdf-status-actions [data-action="preview-video"][aria-pressed="true"] {
        color: #fff; background: #00aeec;
      }
      #bdf-overlay {
        position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center;
        padding: 20px; background: rgb(0 0 0 / 45%); color: #18191c;
      }
      #bdf-dialog {
        width: min(560px, 100%); box-sizing: border-box; padding: 22px;
        border-radius: 14px; background: #fff; box-shadow: 0 16px 48px rgb(0 0 0 / 24%);
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #bdf-dialog h2 { margin: 0 0 16px; font-size: 20px; }
      #bdf-dialog label { display: block; margin: 10px 0 6px; font-weight: 600; }
      #bdf-dialog .bdf-switch-row { display: flex; gap: 8px; align-items: center; font-weight: 400; }
      #bdf-rules {
        display: block; width: 100%; min-height: 220px; box-sizing: border-box;
        resize: vertical; border: 1px solid #c9ccd0; border-radius: 8px; padding: 10px;
        color: inherit; background: #fff; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #bdf-rules:focus { outline: 2px solid #00aeec44; border-color: #00aeec; }
      .bdf-help { margin: 8px 0; color: #61666d; font-size: 12px; }
      #bdf-validation { min-height: 20px; margin: 8px 0; color: #2f9b61; white-space: pre-wrap; font: inherit; }
      #bdf-validation.bdf-error { color: #d83a52; }
      .bdf-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
      .bdf-actions button { border: 1px solid #c9ccd0; border-radius: 8px; padding: 7px 14px; background: #fff; cursor: pointer; }
      .bdf-actions .bdf-primary { border-color: #00aeec; color: #fff; background: #00aeec; }
      @media (prefers-color-scheme: dark) {
        #bdf-status, #bdf-dialog, #bdf-rules { color: #e3e5e7; background: #242628; }
        #bdf-status { border-color: #55585c; }
        #bdf-status.bdf-compact { background: rgb(36 38 40 / 94%); }
        .bdf-collapse { color: #aeb3b8; background: #333538; }
        .bdf-collapse:hover { color: #00aeec; background: #163846; }
        .bdf-status-actions button { background: #242628; }
        .bdf-status-actions button:hover { background: #163846; }
        .bdf-status-actions button:disabled { color: #777b80; background: #333538; }
        .bdf-status-actions [data-action="config"] { color: #fff; background: #00aeec; }
        #bdf-rules, .bdf-actions button { border-color: #55585c; }
        .bdf-actions button { color: #e3e5e7; background: #333538; }
        .bdf-help { color: #aeb3b8; }
      }
      @media (max-width: 600px) {
        #bdf-status { right: 12px; bottom: 12px; min-width: 0; max-width: calc(100vw - 24px); }
      }
    `);
  }

  function boot() {
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
  }

  GM_registerMenuCommand('配置动态屏蔽规则', openConfigDialog);
  GM_registerMenuCommand('启用 / 暂停动态屏蔽', toggleFiltering);

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
