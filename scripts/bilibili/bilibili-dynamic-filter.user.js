// ==UserScript==
// @name         哔哩哔哩动态关键字屏蔽
// @namespace    https://github.com/BlackCCCat/TampermonkeyScripts
// @version      0.2.0
// @description  通过关键字或正则表达式屏蔽哔哩哔哩动态，并支持动态加载内容。
// @author       BlackCCCat
// @license      MIT
// @homepageURL  https://github.com/BlackCCCat/TampermonkeyScripts
// @supportURL   https://github.com/BlackCCCat/TampermonkeyScripts/issues
// @downloadURL  https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili/bilibili-dynamic-filter.user.js
// @updateURL    https://raw.githubusercontent.com/BlackCCCat/TampermonkeyScripts/main/scripts/bilibili/bilibili-dynamic-filter.user.js
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
  });
  const normalizeText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  function normalizeConfig(stored) {
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_CONFIG };
    return {
      enabled: stored.enabled !== false,
      rulesText: typeof stored.rulesText === 'string' ? stored.rulesText : '',
      showStatusPanel: stored.showStatusPanel !== false,
    };
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
      findMatch,
      normalizeConfig,
      normalizeText,
      parseRules,
      shouldShowStatusPanel,
    };
    return;
  }

  const CONFIG_KEY = 'bilibili-dynamic-filter:config:v1';
  const CARD_SELECTOR = [
    '.bili-dyn-list__item',
    '.bili-dyn-item',
    '[data-did]',
  ].join(',');
  const CONTENT_SELECTOR = [
    '.bili-rich-text__content',
    '.bili-dyn-content__orig__desc',
    '.bili-dyn-card-video__title',
    '.bili-dyn-card-video__desc',
    '.bili-dyn-card-article__title',
    '.bili-dyn-card-article__desc',
    '.bili-dyn-card-reserve__title',
  ].join(',');
  const HIDDEN_CLASS = 'bdf-hidden-dynamic';
  const PREVIEW_CLASS = 'bdf-show-blocked-content';
  const OWNED_UI_SELECTOR = '#bdf-status, #bdf-overlay';

  let config = loadConfig();
  let parsedRules = parseRules(config.rulesText).rules;
  let configRevision = 0;
  let pendingTimer;
  let showBlockedContent = false;
  let statusPanel;
  let statusCount;
  let previewButton;
  let closeConfigDialog = null;
  const pendingRoots = new Set();
  const cardState = new WeakMap();

  function loadConfig() {
    return normalizeConfig(GM_getValue(CONFIG_KEY, DEFAULT_CONFIG));
  }

  function saveConfig(nextConfig) {
    config = normalizeConfig(nextConfig);
    parsedRules = parseRules(config.rulesText).rules;
    configRevision += 1;
    GM_setValue(CONFIG_KEY, config);
    setBlockedContentPreview(false, false);
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

  function extractCardText(card) {
    const contentNodes = Array.from(card.querySelectorAll(CONTENT_SELECTOR));
    const nodes = contentNodes.length > 0 ? contentNodes : [card];
    return normalizeText(
      nodes
        .map((node) => node.innerText || node.textContent || '')
        .join(' '),
    );
  }

  function filterCard(card) {
    if (!(card instanceof Element)) return;

    const text = extractCardText(card);
    const previous = cardState.get(card);
    if (previous?.revision === configRevision && previous.text === text) return;

    cardState.set(card, { revision: configRevision, text });
    const match = config.enabled && parsedRules.length > 0
      ? findMatch(text, parsedRules)
      : null;

    if (!match) {
      card.classList.remove(HIDDEN_CLASS);
      card.style.removeProperty('--bdf-original-display');
      card.removeAttribute('data-bdf-rule');
      card.removeAttribute('data-bdf-rule-type');
      return;
    }

    if (!card.classList.contains(HIDDEN_CLASS)) {
      const originalDisplay = getComputedStyle(card).display;
      if (originalDisplay !== 'none') {
        card.style.setProperty('--bdf-original-display', originalDisplay);
      }
    }
    card.classList.add(HIDDEN_CLASS);
    card.dataset.bdfRule = match.source;
    card.dataset.bdfRuleType = match.type;
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

    const hiddenCards = document.querySelectorAll(`.${HIDDEN_CLASS}`);
    const hiddenCount = hiddenCards.length;
    if (hiddenCount === 0 && showBlockedContent) {
      showBlockedContent = false;
      document.documentElement.classList.remove(PREVIEW_CLASS);
    }

    const panelVisible = shouldShowStatusPanel(config, parsedRules.length);
    statusPanel.hidden = !panelVisible;
    statusCount.textContent = `已屏蔽 ${hiddenCount} 条动态`;
    previewButton.disabled = hiddenCount === 0;
    previewButton.textContent = showBlockedContent ? '恢复屏蔽' : '查看屏蔽内容';
    previewButton.setAttribute('aria-pressed', String(showBlockedContent));
  }

  function setBlockedContentPreview(visible, scrollToFirst = true) {
    const firstHiddenCard = document.querySelector(`.${HIDDEN_CLASS}`);
    showBlockedContent = Boolean(visible && firstHiddenCard);
    document.documentElement.classList.toggle(PREVIEW_CLASS, showBlockedContent);
    updateStats();

    if (showBlockedContent && scrollToFirst) {
      requestAnimationFrame(() => {
        firstHiddenCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  function createStatusPanel() {
    statusPanel = document.createElement('aside');
    statusPanel.id = 'bdf-status';
    statusPanel.hidden = true;
    statusPanel.setAttribute('aria-label', '动态屏蔽状态');
    statusPanel.innerHTML = `
      <div id="bdf-status-count" aria-live="polite">已屏蔽 0 条动态</div>
      <div class="bdf-status-actions">
        <button type="button" data-action="preview" aria-pressed="false">查看屏蔽内容</button>
        <button type="button" data-action="config">配置</button>
      </div>
    `;

    statusCount = statusPanel.querySelector('#bdf-status-count');
    previewButton = statusPanel.querySelector('[data-action="preview"]');
    previewButton.addEventListener('click', () => {
      setBlockedContentPreview(!showBlockedContent);
    });
    statusPanel.querySelector('[data-action="config"]').addEventListener('click', openConfigDialog);
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
    const rulesInput = overlay.querySelector('#bdf-rules');
    const validation = overlay.querySelector('#bdf-validation');
    enabledInput.checked = config.enabled;
    showStatusInput.checked = config.showStatusPanel;
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
      saveConfig({
        enabled: enabledInput.checked,
        rulesText: rulesInput.value,
        showStatusPanel: showStatusInput.checked,
      });
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
    saveConfig({ ...config, enabled: !config.enabled });
  }

  function installStyles() {
    GM_addStyle(`
      .${HIDDEN_CLASS} { display: none !important; }
      html.${PREVIEW_CLASS} .${HIDDEN_CLASS} {
        display: var(--bdf-original-display, block) !important; position: relative;
        outline: 2px dashed #fb7299; outline-offset: 4px;
      }
      html.${PREVIEW_CLASS} .${HIDDEN_CLASS}::before {
        content: "已被动态屏蔽规则命中";
        display: inline-block; position: relative; z-index: 1;
        margin: 0 0 8px 12px; border-radius: 999px; padding: 4px 10px;
        color: #fff; background: #fb7299; font-size: 12px; line-height: 1.4;
      }
      #bdf-status {
        position: fixed; right: 24px; bottom: 24px; z-index: 99998;
        min-width: 238px; box-sizing: border-box; border: 1px solid #e3e5e7;
        border-radius: 12px; padding: 12px; color: #18191c; background: #fff;
        box-shadow: 0 6px 24px rgb(0 0 0 / 16%);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #bdf-status[hidden] { display: none !important; }
      #bdf-status-count { margin-bottom: 10px; font-weight: 600; }
      .bdf-status-actions { display: flex; gap: 8px; }
      .bdf-status-actions button {
        flex: 1; border: 1px solid #00aeec; border-radius: 7px; padding: 6px 9px;
        color: #00aeec; background: #fff; cursor: pointer; white-space: nowrap;
      }
      .bdf-status-actions button:hover { background: #e3f6fc; }
      .bdf-status-actions button:disabled {
        border-color: #c9ccd0; color: #9499a0; background: #f1f2f3; cursor: not-allowed;
      }
      .bdf-status-actions [data-action="config"] { color: #fff; background: #00aeec; }
      .bdf-status-actions [data-action="config"]:hover { background: #009bd3; }
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
        .bdf-status-actions button { background: #242628; }
        .bdf-status-actions button:hover { background: #163846; }
        .bdf-status-actions button:disabled { color: #777b80; background: #333538; }
        .bdf-status-actions [data-action="config"] { color: #fff; background: #00aeec; }
        #bdf-rules, .bdf-actions button { border-color: #55585c; }
        .bdf-actions button { color: #e3e5e7; background: #333538; }
        .bdf-help { color: #aeb3b8; }
      }
      @media (max-width: 600px) {
        #bdf-status { right: 12px; bottom: 12px; min-width: 218px; }
      }
    `);
  }

  function boot() {
    installStyles();
    createStatusPanel();
    scanRoot(document.body);
    updateStats();
    observeDynamicContent();
  }

  GM_registerMenuCommand('配置动态屏蔽规则', openConfigDialog);
  GM_registerMenuCommand('启用 / 暂停动态屏蔽', toggleFiltering);

  if (document.body) {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
