/**
 * sidebar.js — Sidebar UI для расширения "Prompt"
 *
 * ОБЗОР АРХИТЕКТУРЫ:
 * ==================
 * Sidebar (UI) ←→ Background Service Worker (логика + API) ←→ Content Script (DOM извлечение)
 *
 * ОСНОВНЫЕ КОМПОНЕНТЫ:
 * - **SidebarApp** — главный класс UI, управляет чатом, настройками, стримингом
 * - **formatMarkdown()** — конвертация markdown → HTML (code blocks, tables, headings, lists)
 * - **escapeHtml()** — экранирование HTML для безопасного рендеринга
 *
 * ПОТОК ДАННЫХ:
 * 1. Пользователь вводит запрос или нажимает 🚀
 * 2. Sidebar извлекает контент страницы через content script (или использует кэш)
 * 3. Sidebar отправляет `streamPageAnalysis` или `streamChatQuery` в background.js
 * 4. Background находит доступный сервер, отправляет запрос к API
 * 5. Background потоково возвращает чанки через `chrome.runtime.sendMessage`
 * 6. Sidebar анимирует вывод текста (smooth streaming с адаптивной скоростью)
 *
 * КЛЮЧЕВЫЕ МЕХАНИЗМЫ:
 * - **Smooth Streaming**: Фракционный аккумулятор для плавной посимвольной анимации
 *   (базовая скорость ~360 символов/мин, адаптивный множитель зависит от размера очереди)
 * - **Page Context Toggle**: Галочка 📄 включает/выключает контекст страницы в чате
 * - **Generation Stats**: Статистика генерации (время) отображается в бейдже контекста
 * - **Stall Detection**: Если >30с без данных — показывает "⏳ Ждём ответ..." в бейдже
 * - **Thinking Dots**: Три прыгающие точки внутри сообщения пока ждём первый чанк
 *
 * УПРАВЛЕНИЕ КОНТЕКСТОМ:
 * - 🚀 (анализ страницы) — ВСЕГДА принудительно извлекает и кэширует контент
 * - Чат с галочкой 📄 — использует кэш если URL совпадает, иначе извлекает
 * - Чат без галочки 📄 — работает как чат-бот без контекста страницы
 *
 * ВИЗУАЛЬНЫЕ СОСТОЯНИЯ:
 * - `.chat-message.assistant` (без `.streaming`) — padding 0 16px, точки по центру
 * - `.chat-message.assistant.streaming` — padding 12px 16px, текстовый контент
 *
 * @see background.js — Background Service Worker (обработка API запросов)
 * @see content.js — Content Script (извлечение DOM контента)
 * @see config.js — Централизованные настройки (DEFAULTS)
 */

/* global DEFAULTS, chrome */

const LOG_PREFIX = DEFAULTS.LOG_PREFIX_SIDEBAR;

/* ========================================================================= */
/* LOG LEVELS AND CONSTANTS                                                   */
/* ========================================================================= */
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_COLORS = { DEBUG: '#888', INFO: '#3b82f6', WARN: '#f59e0b', ERROR: '#ef4444' };

/**
 * Escape HTML entities in a string for safe rendering.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * Sanitizes HTML content to prevent XSS attacks.
 * Удаляет опасные паттерны: javascript:, onerror=, <script> и т.д.
 *
 * @param {string} html - HTML строка
 * @returns {string} безопасный HTML
 */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return html;

  let sanitized = html;

  // Удаляем <script> теги и их содержимое
  sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Удаляем незакрытые <script
  sanitized = sanitized.replace(/<script[\s\S]*/gi, '');

  // Удаляем javascript: в href/src
  sanitized = sanitized.replace(/javascript\s*:/gi, 'blocked:');

  // Удаляем event handler'ы: onerror=, onload=, onclick= и т.д.
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Удаляем <iframe>, <object>, <embed>
  sanitized = sanitized.replace(/<(?:iframe|object|embed)[\s\S]*?(?:<\/\w+>|\/?>)/gi, '');

  // Удаляем <style> теги
  sanitized = sanitized.replace(/<style[\s\S]*?<\/style>/gi, '');

  return sanitized;
}

/**
 * Format a string containing markdown into HTML.
 * @param {string} text - raw markdown text
 * @returns {string} HTML string
 */
function formatMarkdown(text) {
  let formatted = escapeHtml(text);

  // Code blocks (must come first)
  formatted = formatted.replace(/```(\w*)\n([\s\S]+?)```/g, '<pre><code class="language-$1">$2</code></pre>');

  // Tables
  formatted = parseTables(formatted);

  // Headings (largest to smallest)
  formatted = formatted.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  formatted = formatted.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  formatted = formatted.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  formatted = formatted.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  formatted = formatted.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  formatted = formatted.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold + italic
  formatted = formatted.replace(/\*\*\*(.+?)\*\*\*/g, '<em><strong>$1</strong></em>');
  formatted = formatted.replace(/___(.+?)___/g, '<em><strong>$1</strong></em>');

  // Bold
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');
  formatted = formatted.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  formatted = formatted.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Blockquotes
  formatted = formatted.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  formatted = formatted.replace(/^---$/gm, '<hr>');
  formatted = formatted.replace(/^\*\*\*$/gm, '<hr>');

  // Unordered list items
  formatted = formatted.replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>');

  // Ordered list items
  formatted = formatted.replace(/^\s*\d+\+\.\s+(.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  formatted = formatted.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Links [text](url)
  formatted = formatted.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Images ![alt](url)
  formatted = formatted.replace(/!\[(.+?)\]\((.+?)\)/g, '<img src="$2" alt="$1" style="max-width: 100%; border-radius: 8px; margin: 8px 0;">');

  // Inline code (must be after most other rules)
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs: сначала двойной newline → </p><p>, потом одиночный → <br>
  formatted = formatted.replace(/\n\n+/g, '</p><p>');
  formatted = formatted.replace(/\n/g, '<br>');

  // Wrap bare text in <p> if not already wrapped
  if (!formatted.startsWith('<')) {
    formatted = '<p>' + formatted + '</p>';
  }

  // === КРИТИЧЕСКАЯ ОЧИСТКА: убираем <br> вокруг блочных элементов ===
  // <br> после закрывающих тегов блочных элементов
  const blockTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote', 'table', 'hr', 'li', 'p'];
  for (const tag of blockTags) {
    formatted = formatted.replace(new RegExp(`</${tag}><br>`, 'gi'), `</${tag}>`);
  }
  // <br> перед открывающими тегами блочных элементов
  for (const tag of blockTags) {
    formatted = formatted.replace(new RegExp(`<br><${tag}`, 'gi'), `<${tag}`);
  }
  // <br> между блочными элементами
  for (const tag1 of blockTags) {
    for (const tag2 of blockTags) {
      formatted = formatted.replace(
        new RegExp(`</${tag1}>(<br>)+<${tag2}`, 'gi'),
        `</${tag1}><${tag2}`
      );
    }
  }

  // Убираем trailing <br>, leading <br>, пустые параграфы
  formatted = formatted.replace(/<br>$/g, '');
  formatted = formatted.replace(/^<br>/, '');
  formatted = formatted.replace(/<p><\/p>/g, '');
  formatted = formatted.replace(/<p><br><\/p>/g, '');

  // XSS sanitization — удаляем опасные паттерны после всех преобразований
  return sanitizeHtml(formatted);
}

/**
 * Parse markdown table syntax into HTML tables.
 * @param {string} text
 * @returns {string}
 */
function parseTables(text) {
  const lines = text.split('\n');
  const result = [];
  let inTable = false;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isTableRow = /^\|.*\|$/.test(line);
    const isSeparator = /^\|?[-:| ]+\|?$/.test(line) && line.includes('-');

    if (isTableRow && !inTable) {
      inTable = true;
      tableRows = [line];
    } else if (isTableRow && inTable) {
      tableRows.push(line);
    } else if (isSeparator && inTable) {
      tableRows.push(line);
    } else {
      if (inTable && tableRows.length >= 3) {
        result.push(buildTable(tableRows));
        inTable = false;
        tableRows = [];
      } else if (inTable) {
        result.push(...tableRows);
        inTable = false;
        tableRows = [];
      }
      result.push(line);
    }
  }

  if (inTable && tableRows.length >= 3) {
    result.push(buildTable(tableRows));
  } else if (inTable) {
    result.push(...tableRows);
  }

  return result.join('\n');
}

/**
 * Build an HTML table from an array of pipe-delimited row strings.
 * @param {string[]} rows
 * @returns {string}
 */
function buildTable(rows) {
  if (rows.length < 3) return rows.join('\n');

  const headers = rows[0].split('|').filter(c => c.trim());
  const headerCells = headers.map(h => `<th>${h.trim()}</th>`).join('');

  const dataRows = rows.slice(2).map(row => {
    const cells = row.split('|').filter(c => c.trim());
    const cellsHtml = cells.map(c => `<td>${c.trim()}</td>`).join('');
    return `<tr>${cellsHtml}</tr>`;
  }).join('');

  return `<table><thead><tr>${headerCells}</tr></thead><tbody>${dataRows}</tbody></table>`;
}

/* ========================================================================= */
/* SIDEBAR APP CLASS                                                         */
/* ========================================================================= */

class SidebarApp {
  constructor() {
    this.log('=== SidebarApp constructor start ===');

    // --- State ---
    /** @type {Array<{role: 'user'|'assistant', content: string}>} */
    this.chatHistory = [];
    /** @type {number|null} */
    this.currentTabId = null;
    /** @type {string} */
    this.currentTabUrl = '';
    /** @type {string} */
    this.lastTabUrl = '';
    /** @type {AbortController|null} */
    this.abortController = null;

    // Page context toggle state
    /** @type {boolean} */
    this.pageContextEnabled = false;
    /** @type {string|null} */
    this.cachedPageContent = null;
    /** @type {string} */
    this.cachedPageUrl = '';

    // Chunk counters for progress display
    /** @type {number} */
    this.streamChunkCount = 0;
    /** @type {number} */
    this.imageAnalysisChunkCount = 0;
    /** @type {number} */
    this.reasoningChunkCount = 0;
    /** @type {number} */
    this.imageReasoningChunkCount = 0;

    // Streaming monitoring
    /** @type {number} — timestamp последнего полученного чанка */
    this._lastChunkTime = 0;
    /** @type {number} — timestamp начала текущего стрима */
    this._streamStartTime = 0;
    /** @type {number|null} — ID интервала мониторинга */
    this._stallCheckTimerId = null;
    /** @type {number|null} — ID интервала проверки активности анализа изображения */
    this._imageAnalysisCheckTimerId = null;

    // Generation metrics
    /** @type {number} — количество полученных токенов (примерно) */
    this._totalTokens = 0;
    /** @type {string|null} — модель для API запроса */
    this._currentModel = '';

    // Smooth streaming animation state
    /** @type {string} — все полученные чанки (чистый текст) */
    this._streamBuffer = '';
    /** @type {string} — то что уже отображено */
    this._streamDisplayed = '';
    /** @type {number} — дробный накопитель для плавной скорости <1 символа/тик */
    this._streamFraction = 0;
    /** @type {number|null} — ID setTimeout для анимации стриминга */
    this._streamTimerId = null;
    /** @type {HTMLElement|null} — текущее сообщение для обновления */
    this._streamMessageEl = null;
    /** @type {boolean} — стриминг завершён, нужно допечатать остаток */
    this._streamFinished = false;
    /** @type {number} — timestamp последнего тика анимации */
    this._streamLastTick = 0;
    /** @type {number} — максимальный достигнутый множитель (не уменьшается) */
    this._streamMaxMultiplier = 1.0;

    // Reasoning animation state
    /** @type {string} */
    this._reasoningBuffer = '';
    /** @type {string} */
    this._reasoningDisplayed = '';
    /** @type {number} */
    this._reasoningFraction = 0;
    /** @type {number|null} — ID setTimeout для анимации reasoning */
    this._reasoningTimerId = null;
    /** @type {number} */
    this._reasoningLastTick = 0;
    /** @type {number} — максимальный достигнутый множитель (не уменьшается) */
    this._reasoningMaxMultiplier = 1.0;
    /** @type {boolean} — reasoning завершён, нужно допечатать остаток */
    this._reasoningFinished = false;

    /** @type {boolean} */
    this.isStreaming = false;

    /**
     * Система умного автоскролла:
     * - _autoScrollEnabled: true = чат автоскроллится, false = пользователь отцепился
     * - _scrollDebounceTimer: debounce для определения что пользователь остановился
     * - _isUserScrolling: флаг что пользователь активно скроллит (не программный скролл)
     */
    this._autoScrollEnabled = true;
    this._scrollDebounceTimer = null;
    this._isUserScrolling = false;

    /** @type {boolean} */
    this.isReasoningStreaming = false;
    /** @type {boolean} */
    this.reasoningExpanded = false;
    /** @type {string} */
    this.currentResponse = '';
    /** @type {string} */
    this.currentReasoning = '';

    /** @type {boolean} */
    this.isDarkTheme = false;

    // Image analysis state
    /** @type {boolean} */
    this.isImageAnalysisActive = false;
    /** @type {string} */
    this.currentImageAnalysis = '';
    /** @type {string} */
    this.currentImageReasoning = '';
    /** @type {string} */
    this.imageAnalysisType = 'prompt'; // 'prompt' или 'translation'
    /** @type {string} */
    this.imageSystemPrompt = DEFAULTS.IMAGE_SYSTEM_PROMPT;
    /** @type {string} */
    this.imageTranslationPrompt = DEFAULTS.IMAGE_TRANSLATION_PROMPT;

    // Settings (defaults from config.js)
    this.settings = {
      serverPresets: JSON.parse(JSON.stringify(DEFAULTS.SERVER_PRESETS)),
      apiKey: DEFAULTS.API_KEY,
      model: DEFAULTS.MODEL,
      useLoadedModel: DEFAULTS.USE_LOADED_MODEL,
      systemPrompt: DEFAULTS.SYSTEM_PROMPT,
      fontSize: DEFAULTS.FONT_SIZE
    };

    /** @type {number} */
    this.storageChangesReceived = 0;

    /** @type {boolean} — флаг для предотвращения цикла в storage.onChanged */
    this._isUpdatingFromStorage = false;

    // --- DOM elements ---
    this.initElements();

    // --- Load persisted settings ---
    this.loadSettings();

    // --- Bind events ---
    this.bindEvents();

    // --- Listen for storage changes & runtime messages ---
    this.setupStorageListener();

    // Запускаем отслеживание скролла пользователя
    this._bindScrollTracking();

    // --- Check if analysis is already in progress (sidebar opened after analysis started) ---
    this.checkActiveAnalysis();

    this.log('=== SidebarApp constructor complete ===');
  }

  /**
   * Проверяет storage на наличие активного анализа изображения.
   * Если анализ уже идёт — сразу показываем прогресс-бар.
   */
  async checkActiveAnalysis() {
    // Если DOM ещё не готов — выходим безопасно
    if (!this.chatMessages || !this.progressContainer) return;

    try {
      const data = await chrome.storage.local.get(['imageAnalysisActive', 'streamProgress', 'streamProgressText', 'streamImageContent', 'imageAnalysisType']);
      if (data.imageAnalysisActive) {
        this.log('[PROGRESS] Обнаружен активный анализ при инициализации');
        // Восстанавливаем тип анализа
        this.imageAnalysisType = data.imageAnalysisType || 'prompt';
        // Запускаем мониторинг для восстановленного состояния
        this.startStreamMonitoring();
        // Показываем прогресс-бар
        if (this.progressContainer) this.progressContainer.classList.remove('hidden');
        // Восстанавливаем текущий прогресс
        if (typeof data.streamProgressText === 'string' && this.progressText) {
          this.progressText.textContent = data.streamProgressText;
        }
        // Если уже есть контент — показываем через анимацию, не напрямую
        if (data.streamImageContent) {
          this.log(`[PROGRESS] Восстановлен контент: ${data.streamImageContent.length} символов`);
          this.currentImageAnalysis = data.streamImageContent;
          // Показываем в чате
          if (this.placeholder) this.placeholder.style.display = 'none';
          if (this.chatHistoryEl) this.chatHistoryEl.style.display = 'block';
          // Создаём или обновляем assistant сообщение
          let msgEl = this.chatMessages?.lastElementChild;
          if (!msgEl || !msgEl.classList.contains('assistant')) {
            msgEl = this.appendAssistantPlaceholder();
          }
          // Используем анимационный буфер — но начинаем близко к концу, чтобы не догонять всё сразу
          this._streamBuffer = data.streamImageContent;
          // Начинаем с 80% контента, чтобы анимация плавно допечатала остаток
          const startOffset = Math.floor(data.streamImageContent.length * 0.8);
          this._streamDisplayed = data.streamImageContent.substring(0, startOffset);
          this._streamFraction = 0;
          this._streamMaxMultiplier = 1.0;
          this._streamMessageEl = msgEl;
          this._startStreamAnimation();
        }
      }
    } catch (error) {
      this.log(`[PROGRESS] Ошибка проверки активного анализа: ${error.message}`, 'warning');
    }
  }

  /* ====================================================================== */
  /* LOGGING                                                                */
  /* ====================================================================== */

  /**
   * Log a message to the sidebar log panel and the browser console.
   * @param  {...any} args - message parts; last arg may be a type string
   */
  log(...args) {
    let type = 'info';
    let messages = args;

    const lastArg = args[args.length - 1];
    if (['error', 'success', 'warning', 'info'].includes(lastArg)) {
      type = lastArg;
      messages = args.slice(0, -1);
    }

    const message = messages.map(arg => {
      if (typeof arg === 'object') {
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }
      return String(arg);
    }).join(' ');

    // Write to sidebar log panel if available
    if (this.logContent) {
      const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
      const entry = document.createElement('div');
      entry.className = `log-entry ${type}`;
      entry.innerHTML = `<span class="log-time">[${time}]</span><span>${escapeHtml(message)}</span>`;
      this.logContent.appendChild(entry);
      this.logContent.scrollTop = this.logContent.scrollHeight;
    }

    console.log(`${LOG_PREFIX} [${type.toUpperCase()}]`, message);
  }

  /**
   * Безопасная отправка сообщения в background script.
   * Оборачивает chrome.runtime.sendMessage в try/catch
   * и проверяет chrome.runtime.lastError.
   *
   * @param {Object} message - сообщение для отправки
   * @returns {Promise<any>} ответ или undefined при ошибке
   */
  async sendMessage(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      // Проверяем lastError — может быть установлен даже без исключения
      if (chrome.runtime.lastError) {
        this.log(`sendMessage error: ${chrome.runtime.lastError.message}`, 'warning');
        return undefined;
      }
      return response;
    } catch (error) {
      // Sidebar может быть закрыт — это нормально
      if (error.message?.includes('Receiving end does not exist')) {
        this.log('Background script недоступен (sidebar закрыт?)', 'warning');
      } else {
        this.log(`sendMessage exception: ${error.message}`, 'error');
      }
      return undefined;
    }
  }

  /* ====================================================================== */
  /* ELEMENT INITIALIZATION                                                 */
  /* ====================================================================== */

  /**
   * Cache references to all DOM elements used by the sidebar.
   */
  initElements() {
    // Header buttons
    this.settingsBtn = document.getElementById('settings-btn');
    this.logsBtn = document.getElementById('logs-btn');

    // Main panel
    this.mainPanel = document.getElementById('main-panel');
    this.systemPromptInput = document.getElementById('system-prompt');
    this.promptSaved = document.querySelector('.prompt-saved');

    // Chat area
    this.placeholder = document.getElementById('placeholder');
    this.chatMessages = document.getElementById('chat-messages');
    this.chatHistoryEl = document.getElementById('chat-history');

    // Кнопка автоскролла вниз
    this.scrollToBottomBtn = document.getElementById('scroll-to-bottom-btn');

    // Page context toggle
    this.pageContextToggle = document.getElementById('page-context-toggle');

    // Context source badge
    this.contextSourceBadge = document.getElementById('context-source-badge');
    this.contextSourceUrl = document.getElementById('context-source-url');
    this.generationStats = document.getElementById('generation-stats');

    // Reasoning container
    this.reasoningContainer = document.getElementById('reasoning-container');
    this.reasoningToggle = document.getElementById('reasoning-toggle');
    this.reasoningContent = document.getElementById('reasoning-content');

    // Progress
    this.progressContainer = document.getElementById('progress-container');
    this.progressText = document.getElementById('progress-text');

    // User input
    this.userInput = document.getElementById('user-input');
    this.sendBtn = document.getElementById('send-btn');

    // Floating action buttons
    this.actionBtn = document.getElementById('action-btn');
    this.copyBtn = document.getElementById('copy-btn');
    this.clearBtn = document.getElementById('clear-btn');

    // Error banner
    this.errorBanner = document.getElementById('error-banner');
    this.errorBannerText = document.getElementById('error-banner-text');
    this.errorBannerCopy = document.getElementById('error-banner-copy');
    this.errorBannerClose = document.getElementById('error-banner-close');
    this._currentErrorText = '';

    // Settings panel
    this.settingsPanel = document.getElementById('settings-panel');
    this.settingsClose = document.getElementById('settings-close');
    this.saveSettingsBtn = document.getElementById('save-settings');
    this.apiUrlInput = null; // URL серверов задаются через .preset-api-url в пресетах
    this.apiKeyInput = document.getElementById('api-key');
    this.modelInput = document.getElementById('model');
    this.useLoadedModelInput = document.getElementById('use-loaded-model');
    this.themeToggleBtn = document.getElementById('theme-toggle');
    this.fontSizeInput = document.getElementById('font-size');
    this.fontSizeIncreaseBtn = document.getElementById('font-size-increase');
    this.fontSizeDecreaseBtn = document.getElementById('font-size-decrease');
    this.imageTranslationPromptInput = document.getElementById('image-translation-prompt');
    this.imagePromptInput = document.getElementById('image-prompt');

    // Server presets
    this.serverPresets = [];
    for (let i = 0; i < 3; i++) {
      const preset = document.querySelector(`.server-preset[data-preset-index="${i}"]`);
      if (preset) {
        this.serverPresets.push({
          element: preset,
          enabled: preset.querySelector('.preset-enabled'),
          apiUrl: preset.querySelector('.preset-api-url'),
          extractMode: preset.querySelector('.preset-extract-mode'),
          statusIndicator: preset.querySelector('.status-indicator'),
          statusText: preset.querySelector('.status-text')
        });
      }
    }
    this.checkServersBtn = document.getElementById('check-servers');

    // Logs panel
    this.logsPanel = document.getElementById('logs-panel');
    this.logsClose = document.getElementById('logs-close');
    this.logContent = document.getElementById('log-content');
    this.clearLogBtn = document.getElementById('clear-log');
  }

  /* ====================================================================== */
  /* EVENT BINDING                                                          */
  /* ====================================================================== */

  /**
   * Attach all event listeners.
   */
  bindEvents() {
    const self = this;

    // --- Escape key: close panels ---
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!this.settingsPanel.classList.contains('hidden')) this.showPanel('main');
        else if (!this.logsPanel.classList.contains('hidden')) this.showPanel('main');
      }
    });

    // --- Header buttons ---
    this.settingsBtn?.addEventListener('click', () => {
      this.log('Клик: settings-btn');
      this.showPanel('settings');
    });

    this.logsBtn?.addEventListener('click', () => {
      this.log('Клик: logs-btn');
      this.showPanel('logs');
    });

    // --- Panel close buttons ---
    this.settingsClose?.addEventListener('click', () => this.showPanel('main'));
    this.logsClose?.addEventListener('click', () => this.showPanel('main'));

    // --- Save settings ---
    this.saveSettingsBtn?.addEventListener('click', () => this.saveSettings());

    // --- Theme toggle ---
    this.themeToggleBtn?.addEventListener('click', () => this.toggleTheme());

    // --- Font size ---
    this.fontSizeIncreaseBtn?.addEventListener('click', () => this.changeFontSize(1));
    this.fontSizeDecreaseBtn?.addEventListener('click', () => this.changeFontSize(-1));
    this.fontSizeInput?.addEventListener('change', () => this.applyFontSize());

    // --- Send button (chat input) ---
    this.sendBtn?.addEventListener('click', () => {
      const input = this.userInput?.value?.trim();
      if (input && !this.isStreaming) {
        this.handleAction();
      }
    });

    // --- Check servers ---
    this.checkServersBtn?.addEventListener('click', () => {
      this.log('Проверка доступности серверов...');
      this.checkServerPresets();
    });

    // --- Server preset checkboxes ---
    this.serverPresets.forEach((preset, index) => {
      preset.enabled?.addEventListener('change', () => this.updatePresetDisabledState(index));
    });

    // --- Main action button (analyse / stop) ---
    this.actionBtn?.addEventListener('click', () => {
      this.log(`Клик: action-btn, isStreaming: ${this.isStreaming}`);
      if (this.isStreaming) {
        this.stopStreaming();
      } else {
        this.handleAction();
      }
    });

    // --- User input textarea ---
    this.bindUserInput();

    // --- Ctrl+R: reload ---
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К')) {
        if (document.activeElement.tagName !== 'TEXTAREA') {
          e.preventDefault();
          this.log('Ctrl+R: сброс чата');
          this.resetChat();
        }
      }
    });

    // --- Prompt panel (удалено — системный промпт теперь в настройках) ---

    // --- Copy result ---
    this.copyBtn?.addEventListener('click', async () => {
      const success = await this.copyResult();
      if (success) {
        // Показываем галочку
        this.copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
        this.copyBtn.style.color = 'var(--success)';

        // Возвращаем иконку через 2 секунды
        setTimeout(() => {
          this.copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          `;
          this.copyBtn.style.color = '';
        }, 2000);
      }
    });

    // --- Clear chat ---
    this.clearBtn?.addEventListener('click', () => this.clearChat());

    // --- Error banner handlers ---
    this.errorBannerClose?.addEventListener('click', () => this.hideErrorBanner());
    this.errorBannerCopy?.addEventListener('click', () => this.copyErrorToClipboard());

    // --- Кнопка автоскролла вниз ---
    this.scrollToBottomBtn?.addEventListener('click', () => {
      this._reengageAutoScroll();
    });

    // --- Отслеживание скролла пользователя на чате ---
    this._bindScrollTracking();

    // --- Page context toggle ---
    this.pageContextToggle?.addEventListener('change', () => {
      this.pageContextEnabled = this.pageContextToggle.checked;
      if (!this.pageContextEnabled) {
        this.cachedPageContent = null;
        this.cachedPageUrl = '';
        this.log('Контекст страницы: выкл', 'warning');
      } else {
        this.log('Контекст страницы: вкл', 'success');
      }
    });

    // --- Clear log ---
    this.clearLogBtn?.addEventListener('click', () => {
      this.logContent.innerHTML = '';
      this.log('Логи очищены', 'info');
    });

    // --- Toggle reasoning ---
    this.reasoningToggle?.addEventListener('click', () => this.toggleReasoning());

    this.log('=== bindEvents complete ===');
  }

  /**
   * Bind events for the user input textarea (#user-input).
   * - Auto-resize (min 24px, max 120px)
   * - Send on Ctrl+Enter
   */
  bindUserInput() {
    const self = this;

    if (!this.userInput) return;

    // Auto-resize on input
    this.userInput.addEventListener('input', () => {
      this.autoResizeTextarea();
    });

    // Keydown: Ctrl+Enter to send
    this.userInput.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (this.isStreaming) {
          this.stopStreaming();
        } else {
          this.handleAction();
        }
      }
    });
  }

  /**
   * Auto-resize the textarea between 24px and 120px.
   */
  autoResizeTextarea() {
    if (!this.userInput) return;
    this.userInput.style.height = 'auto';
    const newHeight = Math.min(120, Math.max(24, this.userInput.scrollHeight));
    this.userInput.style.height = `${newHeight}px`;
  }

  /* ====================================================================== */
  /* SETTINGS                                                               */
  /* ====================================================================== */

  /**
   * Load settings from chrome.storage.local.
   * @returns {Promise<void>}
   */
  async loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['serverPresets', 'apiKey', 'model', 'useLoadedModel', 'systemPrompt', 'darkTheme', 'fontSize', 'imageSystemPrompt', 'imageTranslationPrompt'],
        (result) => {
          this.log('loadSettings:', JSON.stringify(result));

          if (result.serverPresets && Array.isArray(result.serverPresets)) {
            this.settings.serverPresets = result.serverPresets;
            this.serverPresets.forEach((preset, index) => {
              if (result.serverPresets[index]) {
                preset.enabled.checked = result.serverPresets[index].enabled !== false;
                preset.apiUrl.value = result.serverPresets[index].apiUrl || '';
                preset.extractMode.value = result.serverPresets[index].extractMode || 'smart';
              }
            });
          }

          if (result.apiKey) {
            this.settings.apiKey = result.apiKey;
            this.apiKeyInput.value = result.apiKey;
          }
          if (result.model) {
            this.settings.model = result.model;
            this.modelInput.value = result.model;
          }
          if (result.useLoadedModel !== undefined) {
            this.settings.useLoadedModel = result.useLoadedModel;
            if (this.useLoadedModelInput) {
              this.useLoadedModelInput.checked = result.useLoadedModel;
            }
          }
          if (result.systemPrompt) {
            this.settings.systemPrompt = result.systemPrompt;
            this.systemPromptInput.value = result.systemPrompt;
          }
          if (result.darkTheme !== undefined) {
            this.isDarkTheme = result.darkTheme;
          }
          if (result.fontSize !== undefined) {
            this.settings.fontSize = result.fontSize;
            this.fontSizeInput.value = result.fontSize;
          }
          if (result.imageSystemPrompt) {
            this.imageSystemPrompt = result.imageSystemPrompt;
            if (this.imagePromptInput) {
              this.imagePromptInput.value = result.imageSystemPrompt;
            }
          } else if (this.imagePromptInput) {
            this.imagePromptInput.value = DEFAULTS.IMAGE_SYSTEM_PROMPT;
          }
          if (result.imageTranslationPrompt) {
            this.imageTranslationPrompt = result.imageTranslationPrompt;
            if (this.imageTranslationPromptInput) {
              this.imageTranslationPromptInput.value = result.imageTranslationPrompt;
            }
          } else if (this.imageTranslationPromptInput) {
            this.imageTranslationPromptInput.value = DEFAULTS.IMAGE_TRANSLATION_PROMPT;
          }

          this.applyTheme();
          this.applyFontSize();
          this.updatePresetDisabledStates();
          this.log('loadSettings complete');
          resolve();
        }
      );
    });
  }

  /**
   * Save current settings to chrome.storage.local.
   */
  async saveSettings() {
    this.settings.serverPresets = this.serverPresets.map(preset => ({
      enabled: preset.enabled.checked,
      apiUrl: preset.apiUrl.value.trim(),
      extractMode: preset.extractMode.value
    }));

    this.settings.apiKey = this.apiKeyInput.value;
    this.settings.model = this.modelInput.value;
    this.settings.useLoadedModel = this.useLoadedModelInput?.checked ?? DEFAULTS.USE_LOADED_MODEL;
    this.settings.fontSize = parseInt(this.fontSizeInput.value) || DEFAULTS.FONT_SIZE;

    // Сохраняем оба промпта из UI
    if (this.imagePromptInput && this.imagePromptInput.value.trim()) {
      this.imageSystemPrompt = this.imagePromptInput.value.trim();
    }
    if (this.imageTranslationPromptInput && this.imageTranslationPromptInput.value.trim()) {
      this.imageTranslationPrompt = this.imageTranslationPromptInput.value.trim();
    }

    // Сохраняем системный промпт из textarea
    const systemPromptValue = this.systemPromptInput?.value?.trim();
    if (systemPromptValue) {
      this.settings.systemPrompt = systemPromptValue;
    }

    await chrome.storage.local.set({
      serverPresets: this.settings.serverPresets,
      apiKey: this.settings.apiKey,
      model: this.settings.model,
      useLoadedModel: this.settings.useLoadedModel,
      systemPrompt: this.settings.systemPrompt,
      darkTheme: this.isDarkTheme,
      fontSize: this.settings.fontSize,
      imageSystemPrompt: this.imageSystemPrompt,
      imageTranslationPrompt: this.imageTranslationPrompt
    });

    this.log('Настройки сохранены', 'success');
    this.showPanel('main');
  }

  /* ====================================================================== */
  /* THEME & FONT SIZE                                                      */
  /* ====================================================================== */

  toggleTheme() {
    this.isDarkTheme = !this.isDarkTheme;
    this.applyTheme();
  }

  applyTheme() {
    if (this.isDarkTheme) {
      document.body.classList.add('dark-theme');
      if (this.themeToggleBtn) {
        this.themeToggleBtn.classList.add('active');
        this.themeToggleBtn.querySelector('.theme-icon').textContent = '☀️';
        this.themeToggleBtn.querySelector('.theme-text').textContent = 'Светлая тема';
      }
    } else {
      document.body.classList.remove('dark-theme');
      if (this.themeToggleBtn) {
        this.themeToggleBtn.classList.remove('active');
        this.themeToggleBtn.querySelector('.theme-icon').textContent = '🌙';
        this.themeToggleBtn.querySelector('.theme-text').textContent = 'Тёмная тема';
      }
    }
  }

  applyFontSize() {
    const fontSize = parseInt(this.fontSizeInput.value) || DEFAULTS.FONT_SIZE;
    const clamped = Math.max(8, Math.min(16, fontSize));
    this.fontSizeInput.value = clamped;
    document.documentElement.style.setProperty('--font-size', `${clamped}px`);
  }

  changeFontSize(delta) {
    const current = parseInt(this.fontSizeInput.value) || DEFAULTS.FONT_SIZE;
    const newSize = Math.max(8, Math.min(16, current + delta));
    this.fontSizeInput.value = newSize;
    this.applyFontSize();
  }

  /* ====================================================================== */
  /* PANEL MANAGEMENT                                                       */
  /* ====================================================================== */

  /**
   * Show one panel, hide the others.
   * @param {'main'|'settings'|'logs'} panelName
   */
  showPanel(panelName) {
    this.settingsPanel.classList.add('hidden');
    this.logsPanel.classList.add('hidden');
    this.mainPanel.classList.add('hidden');

    if (panelName === 'settings') {
      this.settingsPanel.classList.remove('hidden');
    } else if (panelName === 'logs') {
      this.logsPanel.classList.remove('hidden');
    } else {
      this.mainPanel.classList.remove('hidden');
    }
  }

  /* ====================================================================== */
  /* SERVER PRESETS                                                         */
  /* ====================================================================== */

  updatePresetDisabledStates() {
    this.serverPresets.forEach((_, i) => this.updatePresetDisabledState(i));
  }

  updatePresetDisabledState(index) {
    const preset = this.serverPresets[index];
    if (!preset) return;

    const enabled = preset.enabled.checked;
    preset.apiUrl.disabled = !enabled;
    preset.extractMode.disabled = !enabled;

    if (!enabled) {
      preset.element.classList.add('disabled');
      preset.statusIndicator.className = 'status-indicator disabled';
      preset.statusText.className = 'status-text disabled';
      preset.statusText.textContent = 'Отключено';
    } else {
      preset.element.classList.remove('disabled');
      preset.statusIndicator.className = 'status-indicator';
      preset.statusText.className = 'status-text';
      preset.statusText.textContent = 'Не проверено';
    }
  }

  async checkServerPresets() {
    this.log('Начало проверки серверов...');

    for (let i = 0; i < this.serverPresets.length; i++) {
      const preset = this.serverPresets[i];
      const enabled = preset.enabled.checked;
      const apiUrl = preset.apiUrl.value.trim();

      if (!enabled) {
        preset.statusIndicator.className = 'status-indicator disabled';
        preset.statusText.className = 'status-text disabled';
        preset.statusText.textContent = 'Отключено';
        continue;
      }

      if (!apiUrl || !apiUrl.includes('://')) {
        preset.statusIndicator.className = 'status-indicator unavailable';
        preset.statusText.className = 'status-text unavailable';
        preset.statusText.textContent = !apiUrl ? 'Не указан URL' : 'Некорректный URL';
        continue;
      }

      preset.statusIndicator.className = 'status-indicator checking';
      preset.statusText.className = 'status-text checking';
      preset.statusText.textContent = 'Проверка...';

      const available = await this.checkServerAvailability(apiUrl);

      if (available) {
        preset.statusIndicator.className = 'status-indicator available';
        preset.statusText.className = 'status-text available';
        preset.statusText.textContent = 'Доступен';
        this.log(`Сервер ${i + 1} (${apiUrl}): доступен`, 'success');
      } else {
        preset.statusIndicator.className = 'status-indicator unavailable';
        preset.statusText.className = 'status-text unavailable';
        preset.statusText.textContent = 'Недоступен';
        this.log(`Сервер ${i + 1} (${apiUrl}): недоступен`, 'error');
      }
    }

    this.log('Проверка серверов завершена');
  }

  /**
   * Запрашивает у первого доступного сервера список загруженных моделей.
   * Перебирает включённые пресеты по порядку, пробуя GET /v1/models.
   * Возвращает ID первой найденной модели или null.
   * @returns {Promise<string|null>}
   */
  async fetchLoadedModel() {
    const enabledPresets = this.serverPresets.filter(p => p.enabled.checked && p.apiUrl.value.trim());

    if (enabledPresets.length === 0) {
      this.log('[MODEL] Нет включённых серверов с URL');
      return null;
    }

    const apiKey = this.apiKeyInput.value;

    for (const preset of enabledPresets) {
      const apiUrl = preset.apiUrl.value.replace(/\/$/, '');
      this.log(`[MODEL] Пробую сервер: ${apiUrl}`);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(`${apiUrl}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          this.log(`[MODEL] ${apiUrl} — status=${response.status}, пробую следующий`);
          continue;
        }

        const data = await response.json();
        const models = data.data || data.models || [];

        if (models.length === 0) {
          this.log(`[MODEL] ${apiUrl} — нет моделей, пробую следующий`);
          continue;
        }

        const modelId = models[0].id || models[0].name || models[0];
        this.log(`[MODEL] ✅ Найдена модель на ${apiUrl}: ${modelId} (всего: ${models.length})`);
        return modelId;

      } catch (error) {
        this.log(`[MODEL] ${apiUrl} — ошибка: ${error.message}, пробую следующий`);
        continue;
      }
    }

    this.log('[MODEL] ❌ Ни один сервер не вернул модель');
    return null;
  }

  async checkServerAvailability(apiUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.apiKeyInput.value}` },
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  /* ====================================================================== */
  /* CONTEXT SOURCE BADGE                                                   */
  /* ====================================================================== */

  /**
   * Update the context source badge with the current page URL.
   * @param {string} url
   */
  updateContextSourceBadge(url) {
    this.currentTabUrl = url;

    if (this.contextSourceBadge && this.contextSourceUrl) {
      if (url) {
        // Truncate URL for display
        const displayUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
        this.contextSourceUrl.textContent = displayUrl;
        this.contextSourceUrl.title = url;
        this.contextSourceBadge.classList.remove('hidden');
      } else {
        this.contextSourceBadge.classList.add('hidden');
      }
    }
  }

  /* ====================================================================== */
  /* CHAT RENDERING                                                         */
  /* ====================================================================== */

  /**
   * Append a user message to the chat history UI.
   * @param {string} content
   */
  appendUserMessage(content) {
    // НЕ добавляем в chatHistory здесь — это делает sendChatQuery перед отправкой запроса
    // Добавляем только в UI

    // Show chat history container
    this.chatHistoryEl.style.display = 'block';
    this.placeholder.style.display = 'none';

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message user';
    msgEl.innerHTML = `<div class="message-bubble">${escapeHtml(content)}</div>`;
    this.chatMessages.appendChild(msgEl);

    this.scrollToBottom(true);
  }

  /**
   * Append an assistant message placeholder for streaming.
   * Переиспользует существующее assistant сообщение если оно есть.
   * @returns {HTMLElement} The message element for updating.
   */
  appendAssistantPlaceholder() {
    this.chatHistoryEl.style.display = 'block';
    this.placeholder.style.display = 'none';

    // Проверяем, есть ли уже assistant сообщение — если да, переиспользуем его
    const existingMsg = this.chatMessages?.querySelector('.chat-message.assistant:last-child');
    if (existingMsg) {
      // Всегда создаём с курсором — точки появятся позже при начале стриминга
      existingMsg.innerHTML = '<div class="message-bubble"><span class="cursor"></span></div>';
      existingMsg.classList.remove('streaming');
      this._streamMessageEl = existingMsg;
      this.scrollToBottom(true);
      return existingMsg;
    }

    // Нет assistant сообщения — создаём новое с курсором
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message assistant';
    msgEl.innerHTML = '<div class="message-bubble"><span class="cursor"></span></div>';
    this.chatMessages.appendChild(msgEl);

    // Сохраняем ссылку для анимации
    this._streamMessageEl = msgEl;

    this.scrollToBottom(true);
    return msgEl;
  }

  /**
   * Update the assistant message element with streamed content.
   * @param {HTMLElement} msgEl
   * @param {string} content
   */
  updateAssistantMessage(msgEl, content) {
    const bubble = msgEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.innerHTML = formatMarkdown(content);
      this.setupCodeCopyButtons(bubble);
    }
    this.scrollToBottom(false);
  }

  /**
   * Finalize the assistant message (remove cursor).
   * @param {HTMLElement} msgEl
   * @param {string} content
   */
  finalizeAssistantMessage(msgEl, content) {
    const bubble = msgEl.querySelector('.message-bubble');
    if (bubble) {
      const processed = this.postProcessContent(content);
      bubble.innerHTML = formatMarkdown(processed);
      this.setupCodeCopyButtons(bubble);
    }
    // Remove streaming class
    msgEl.classList.remove('streaming');
    // Не форсируем скролл — если пользователь отцепился, не перематываем
    this.scrollToBottom(false);
  }

  /**
   * Show error in assistant message.
   * @param {HTMLElement} msgEl
   * @param {string} error
   */
  showAssistantError(msgEl, error) {
    if (!error) return; // Не показывать пустые ошибки
    const bubble = msgEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.innerHTML = `<div style="color: var(--danger); padding: 12px; background: rgba(234,67,53,0.1); border-radius: 8px; border: 1px solid var(--danger);"><strong>Ошибка:</strong> ${escapeHtml(error)}</div>`;
    }
    msgEl.classList.remove('streaming');
  }

  /**
   * Отслеживает скролл пользователя на чате.
   * Определяет: пользователь на дне (автоскролл активен) или отцепился (показываем кнопку).
   */
  _bindScrollTracking() {
    const chatEl = this.chatHistoryEl;
    if (!chatEl) return;

    const self = this;

    /**
     * Проверяет находится ли пользователь внизу чата.
     * Порог: 80px от дна = считается «на дне».
     * @returns {boolean}
     */
    function isNearBottom() {
      const gap = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
      return gap < 80; // 80px порог — достаточно чтобы считать что пользователь внизу
    }

    chatEl.addEventListener('scroll', () => {
      // Игнорируем программный скролл
      if (self._isUserScrolling) return;

      const nearBottom = isNearBottom();

      if (nearBottom && !self._autoScrollEnabled) {
        // Пользователь вернулся вниз — снова включаем автоскролл
        self._autoScrollEnabled = true;
        self._hideScrollButton();
      } else if (!nearBottom && self._autoScrollEnabled) {
        // Пользователь прокрутил вверх — отключаем автоскролл, показываем кнопку
        self._autoScrollEnabled = false;
        self._showScrollButton();
      }
    });
  }

  /**
   * Показывает кнопку автоскролла.
   */
  _showScrollButton() {
    if (this.scrollToBottomBtn) {
      this.scrollToBottomBtn.classList.remove('hidden');
      // Небольшая задержка для CSS transition
      requestAnimationFrame(() => {
        this.scrollToBottomBtn.classList.add('visible');
      });
    }
  }

  /**
   * Скрывает кнопку автоскролла.
   */
  _hideScrollButton() {
    if (this.scrollToBottomBtn) {
      this.scrollToBottomBtn.classList.remove('visible');
      // Ждём окончания анимации перед hidden
      setTimeout(() => {
        this.scrollToBottomBtn.classList.add('hidden');
      }, 350);
    }
  }

  /**
   * Повторно включает автоскролл (пользователь нажал кнопку «вниз»).
   */
  _reengageAutoScroll() {
    this._autoScrollEnabled = true;
    this._hideScrollButton();
    this.scrollToBottom(true);
  }

  /**
   * Сбрасывает состояние автоскролла при новом запросе.
   * Всегда начинаем с автоскролла включённым.
   */
  _resetAutoScroll() {
    this._autoScrollEnabled = true;
    this._hideScrollButton();
  }

  /**
   * Прокручивает чат вниз.
   *
   * УМНЫЙ АВТОСКРОЛЛ:
   * - force=true: принудительный скролл (новое сообщение пользователя, ошибка)
   * - force=false: автоскролл только если _autoScrollEnabled = true
   *
   * Алгоритм работает как у ChatGPT/Claude:
   * - Пока стриминг идёт и пользователь внизу — чат автоскроллится
   * - Если пользователь прокрутил вверх — автоскролл отключается, появляется кнопка «↓»
   * - При клике на кнопку — автоскролл снова включается
   *
   * @param {boolean} force — if true, always scroll; if false, only if auto-scroll is enabled
   */
  scrollToBottom(force = false) {
    const parent = this.chatHistoryEl;
    if (!parent) return;

    // Если не force и автоскролл отключён — не скроллим, но показываем кнопку
    if (!force && !this._autoScrollEnabled) {
      this._showScrollButton();
      return;
    }

    // Если force — включаем автоскролл и скрываем кнопку
    if (force) {
      this._autoScrollEnabled = true;
      this._hideScrollButton();
    }

    const scroll = () => {
      // Флаг что скролл программный — чтобы scroll-обработчик не реагировал
      this._isUserScrolling = true;
      parent.scrollTop = parent.scrollHeight;
      // Сбрасываем флаг после скролла
      requestAnimationFrame(() => {
        this._isUserScrolling = false;
      });
    };

    // Деферим скролл чтобы DOM успел обновиться (двойной rAF)
    requestAnimationFrame(() => {
      requestAnimationFrame(scroll);
    });
  }

  /**
   * Добавляет кнопки копирования ко всем блокам кода внутри контейнера.
   * @param {HTMLElement} container — элемент, содержащий <pre><code> блоки
   */
  setupCodeCopyButtons(container) {
    if (!container) return;
    
    const self = this;
    const codeBlocks = container.querySelectorAll('pre code');
    
    codeBlocks.forEach((codeBlock) => {
      // Проверяем, не добавлена ли уже кнопка
      if (codeBlock.dataset.copyBtnAdded) return;
      codeBlock.dataset.copyBtnAdded = 'true';
      
      // Обёртка для позиционирования
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position: relative; display: inline-block; width: 100%;';
      
      // Кнопка копирования
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.title = 'Копировать код';
      copyBtn.style.cssText = 'position: absolute; top: 0px; right: 2px; z-index: 5;';
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
      
      // Обработчик клика
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeBlock.textContent);
          copyBtn.classList.add('copied');
          copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          `;
          
          // Возвращаем исходное состояние через 2 секунды
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            `;
          }, 2000);
        } catch (err) {
          self.log(`Ошибка копирования: ${err.message}`, 'error');
        }
      });
      
      // Вставляем обёртку перед code, перемещаем code в обёртку
      const parent = codeBlock.parentElement;
      if (parent) {
        parent.insertBefore(wrapper, codeBlock);
        wrapper.appendChild(codeBlock);
        wrapper.appendChild(copyBtn);
      }
    });
  }

  /**
   * Post-process content: remove excessive newlines and duplicate headings.
   * @param {string} content
   * @returns {string}
   */
  postProcessContent(content) {
    if (!content || typeof content !== 'string') return content;

    let processed = content;
    processed = processed.replace(/\n{3,}/g, '\n\n');
    processed = processed.replace(/^(#{1,6} .+)\n+/gm, '$1\n');
    processed = processed.replace(/\n+(#{1,6} .+)$/gm, '\n$1');
    processed = processed.replace(/[ \t]+$/gm, '');
    return processed;
  }

  /**
   * Обновляет текст прогресса и показывает контейнер.
   * Полоса прогресса удалена — остался только текстовый индикатор.
   * @param {number} _percent — 0-100 (игнорируется, оставлен для совместимости)
   * @param {string} text — текст статуса
   */
  setProgress(_percent, text) {
    if (this.progressText) this.progressText.textContent = text;
    if (this.progressContainer) this.progressContainer.classList.remove('hidden');
    this.log(`[PROGRESS] ${text}`);
  }

  /* ====================================================================== */
  /* STREAMING MONITORING                                                   */
  /* ====================================================================== */

  /**
   * Форматирует миллисекунды в человекочитаемый вид.
   * @param {number} ms
   * @returns {string} например "7м 31с", "45с", "1.2с"
   */
  formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}с`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}м ${s}с`;
  }

  /**
   * Запускает мониторинг стрима: таймеры + предупреждение о задержке.
   * Сообщение с точками создаётся в appendAssistantPlaceholder().
   */
  startStreamMonitoring() {
    this._lastChunkTime = Date.now();
    this._streamStartTime = Date.now();
    this._totalTokens = 0;
    this.hideGenerationStats();

    // Очищаем предыдущие предупреждения
    if (this.progressContainer) {
      this.progressContainer.classList.remove('analysis-cancelled');
    }
    
    // Добавляем индикатор размышлений
    if (this.progressText) {
      this.progressText.classList.add('thinking');
    }

    // Периодическая проверка каждые 10 секунд
    this._stallCheckTimerId = setInterval(() => {
      this.checkStreamStall();
    }, 10000);

    // Проверка активности анализа изображения каждые 5 секунд
    this._imageAnalysisCheckTimerId = setInterval(() => {
      this.checkImageAnalysisActive();
    }, 5000);
  }

  /**
   * Проверяет, активен ли ещё анализ изображения.
   * Если analysis был отменён — оповещает пользователя.
   */
  async checkImageAnalysisActive() {
    if (!this.isImageAnalysisActive) return;

    try {
      this.log('[IMAGE CHECK] Проверка активности анализа изображения...');
      const data = await chrome.storage.local.get(['imageAnalysisActive']);
      
      if (!data.imageAnalysisActive) {
        this.log('[IMAGE CHECK] Анализ изображения был остановлен сервером', 'warning');
        this.showAnalysisCancelledWarning();
        this.stopImageAnalysisCheck();
      } else {
        this.log('[IMAGE CHECK] Анализ изображения активен — продолжаем ожидание');
      }
    } catch (error) {
      this.log(`[IMAGE CHECK] Ошибка проверки статуса анализа: ${error.message}`, 'error');
    }
  }

  /**
   * Показывает интерактивное предупреждение об отмене анализа.
   * Добавляет пульсирующую анимацию и сообщение в прогресс-бар.
   */
  showAnalysisCancelledWarning() {
    if (!this.progressContainer) return;

    // Убираем индикатор размышлений
    if (this.progressText) {
      this.progressText.classList.remove('thinking');
    }

    // Добавляем класс с пульсирующей анимацией
    this.progressContainer.classList.add('analysis-cancelled');
    
    // Обновляем текст прогресса
    if (this.progressText) {
      this.progressText.innerHTML = `
        <span class="analysis-cancelled-text">⚠️ Анализ изображения был остановлен</span>
      `;
    }
  }

  /**
   * Останавливает проверку активности анализа изображения.
   */
  stopImageAnalysisCheck() {
    if (this._imageAnalysisCheckTimerId) {
      clearInterval(this._imageAnalysisCheckTimerId);
      this._imageAnalysisCheckTimerId = null;
    }
  }

  /**
   * Обновляет timestamp последнего чанка.
   */
  onStreamChunkReceived() {
    this._lastChunkTime = Date.now();

    // Убеждаемся что _streamMessageEl установлен
    if (!this._streamMessageEl) {
      const lastMsg = this.chatMessages?.querySelector('.chat-message.assistant:last-child');
      if (lastMsg) {
        this._streamMessageEl = lastMsg;
      }
    }
  }

  /**
   * Проверяет, не "завис" ли стрим.
   * Если стрим идёт — сразу показываем предупреждение.
   */
  checkStreamStall() {
    if (!this.isStreaming) {
      this.stopStreamMonitoring();
      return;
    }

    const totalTime = Date.now() - this._streamStartTime;
    this.showStallWarning(totalTime);
  }

  /**
   * Останавливает мониторинг: убирает таймеры.
   */
  stopStreamMonitoring() {
    if (this._stallCheckTimerId) {
      clearInterval(this._stallCheckTimerId);
      this._stallCheckTimerId = null;
    }
    if (this._waitingUpdateTimer) {
      clearInterval(this._waitingUpdateTimer);
      this._waitingUpdateTimer = null;
    }
    this.stopImageAnalysisCheck();
  }

  /**
   * Показывает предупреждение о долгом ожидании в бейдже.
   * @param {number} elapsed — прошедшее время в мс
   */
  showStallWarning(elapsed) {
    if (!this.generationStats) return;

    this.generationStats.textContent = `⏳ Ждём ответ уже ${this.formatDuration(elapsed)}...`;
    this.generationStats.classList.remove('hidden');
    this.generationStats.style.opacity = '1';
    this.generationStats.style.maxWidth = '400px';

    // Очищаем предыдущий таймер если был (защита от накопления)
    if (this._waitingUpdateTimer) {
      clearInterval(this._waitingUpdateTimer);
      this._waitingUpdateTimer = null;
    }

    // Обновляем каждые 10 секунд
    this._waitingUpdateTimer = setInterval(() => {
      if (this.generationStats && this.isStreaming) {
        const elapsed = Date.now() - this._streamStartTime;
        this.generationStats.textContent = `⏳ Ждём ответ уже ${this.formatDuration(elapsed)}...`;
      }
    }, 10000);
  }

  /**
   * Убирает сообщение о долгом ожидании.
   */
  hideAnalysisWaiting() {
    if (this._waitingMessageEl) {
      this._waitingMessageEl.remove();
      this._waitingMessageEl = null;
    }
    if (this._waitingUpdateTimer) {
      clearInterval(this._waitingUpdateTimer);
      this._waitingUpdateTimer = null;
    }
  }

  /**
   * Показывает ошибку в чате как сообщение.
   * Перед показом удаляет последний assistant placeholder с точками.
   * @param {string} errorText
   */
  /**
   * Показывает ошибку во всплывающем баннере сверху.
   * @param {string} errorText - текст ошибки
   */
  showInErrorBanner(errorText) {
    this._currentErrorText = errorText;
    if (this.errorBannerText) {
      this.errorBannerText.textContent = errorText;
    }
    if (this.errorBanner) {
      this.errorBanner.classList.remove('hidden');
    }
    // Сбрасываем состояние copied если было
    if (this.errorBannerCopy) {
      this.errorBannerCopy.classList.remove('copied');
    }
    this.log(`[ERROR BANNER] Показана ошибка: ${errorText}`, 'error');
  }

  /**
   * Скрывает error banner.
   */
  hideErrorBanner() {
    this._currentErrorText = '';
    if (this.errorBanner) {
      this.errorBanner.classList.add('hidden');
    }
    if (this.errorBannerCopy) {
      this.errorBannerCopy.classList.remove('copied');
    }
  }

  /**
   * Копирует текст ошибки в буфер обмена.
   */
  async copyErrorToClipboard() {
    if (!this._currentErrorText) return;
    try {
      await navigator.clipboard.writeText(this._currentErrorText);
      // Визуальная обратная связь
      if (this.errorBannerCopy) {
        this.errorBannerCopy.classList.add('copied');
        setTimeout(() => {
          this.errorBannerCopy?.classList.remove('copied');
        }, 1500);
      }
      this.log('[ERROR BANNER] Текст ошибки скопирован', 'success');
    } catch (e) {
      this.log(`[ERROR BANNER] Не удалось скопировать: ${e.message}`, 'warning');
    }
  }

  /**
   * Обновляет метрики: подсчитывает токены из длины контента.
   */
  updateGenerationMetrics() {
    const contentLen = this._streamBuffer?.length || 0;
    this._totalTokens = Math.round(contentLen / 4);
  }

  /**
   * Показывает статистику генерации в бейдже.
   * @param {number} elapsedMs — время генерации в мс
   */
  showGenerationStats(elapsedMs) {
    if (!this.generationStats) return;

    const tokenRate = this._totalTokens > 0 ? (this._totalTokens / (elapsedMs / 1000)).toFixed(1) : '—';

    const parts = [
      `⏱ ${this.formatDuration(elapsedMs)}`
    ];

    this.generationStats.textContent = parts.join(' · ');
    this.generationStats.classList.remove('hidden');
  }

  /**
   * Скрывает статистику генерации.
   */
  hideGenerationStats() {
    if (this.generationStats) {
      this.generationStats.classList.add('hidden');
      this.generationStats.textContent = '';
    }
    this._totalTokens = 0;
    this._currentModel = '';
  }

  /* ====================================================================== */
  /* MAIN ACTION HANDLER                                                    */
  /* ====================================================================== */

  /**
   * Handle the main action button click or Ctrl+Enter:
   * - If userInput has text → send as chat query with page context
   * - If userInput is empty → analyse current page
   */
  async handleAction() {
    this.log('handleAction: начало');

    if (this.isStreaming) {
      this.stopStreaming();
      return;
    }

    // Reset streaming state
    this.currentResponse = '';
    this.currentReasoning = '';
    this.isReasoningStreaming = false;
    this.reasoningExpanded = false;

    const userInput = this.userInput?.value?.trim() || '';

    if (userInput) {
      // User entered text → send as chat query
      this.log(`handleAction: отправка запроса: "${userInput.substring(0, 50)}..."`);
      await this.sendChatQuery(userInput);
    } else {
      // Empty input → analyse current page
      this.log('handleAction: анализ страницы');
      await this.analyzePage();
    }
  }

  /* ====================================================================== */
  /* PAGE ANALYSIS                                                          */
  /* ====================================================================== */

  /**
   * Analyse the current active tab's page content.
   * Всегда принудительно извлекает контент со страницы.
   */
  async analyzePage() {
    this.log('analyzePage: начало');

    try {
      // Get the current active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) {
        this.log('Нет активной вкладки', 'error');
        return;
      }

      const tab = tabs[0];
      this.currentTabId = tab.id;
      this.lastTabUrl = this.currentTabUrl;
      this.currentTabUrl = tab.url || '';
      this.updateContextSourceBadge(this.currentTabUrl);

      this.setStreamingState(true);
      this.startStreamMonitoring();
      this.progressContainer.classList.remove('hidden');
      this.log('[PROGRESS] Показан прогресс-бар');
      this.setProgress(5, 'Определение модели...');

      // Сбрасываем автоскролл — новый запрос начинается с автоскролла
      this._resetAutoScroll();

      // Определяем модель: либо с сервера, либо из настроек
      let resolvedModel = this.settings.model;
      if (this.settings.useLoadedModel) {
        const loadedModel = await this.fetchLoadedModel();
        if (loadedModel) {
          resolvedModel = loadedModel;
          this.log(`[MODEL] Используем загруженную модель: ${resolvedModel}`);
          this.setProgress(8, `Модель: ${resolvedModel.substring(0, 30)}...`);
        } else {
          this.log(`[MODEL] Не удалось определить модель, используем настройку: ${resolvedModel}`, 'warning');
        }
      }

      this.setProgress(10, 'Извлечение контента...');

      // Принудительно извлекаем контент со страницы
      const pageContent = await this.extractPageContent(tab.id);

      // Кэшируем контент для последующего использования
      this.cachedPageContent = pageContent;
      this.cachedPageUrl = this.currentTabUrl;

      this.setProgress(30, 'Отправка запроса...');

      // Reset response
      this.currentResponse = '';

      // Create assistant message element
      const msgEl = this.appendAssistantPlaceholder();

       // Создаём AbortController для отмены запроса
       this.abortController = new AbortController();

       // Send to background for streaming analysis
       await this.sendMessage({
         action: 'streamPageAnalysis',
         pageContent: pageContent,
         tabUrl: tab.url,
         tabId: tab.id,
         resolvedModel: resolvedModel,
         settings: this.settings,
         signal: this.abortController.signal
       });

      this.setProgress(50, 'Анализ...');
      this.log('analyzePage: запрос отправлен в background', 'success');

    } catch (error) {
      this.log(`Ошибка анализа: ${error.message}`, 'error');
      this.showInErrorBanner(error.message);
      this.setStreamingState(false);
    }
  }

  /**
   * Extract page content from a specific tab via content script messaging.
   * @param {number} tabId
   * @returns {Promise<string>}
   */
  async extractPageContent(tabId) {
    return new Promise((resolve, reject) => {
      const firstEnabledPreset = this.serverPresets.find(p => p.enabled.checked);
      const extractMode = firstEnabledPreset ? firstEnabledPreset.extractMode.value : 'smart';

      chrome.tabs.sendMessage(tabId, {
        action: 'extractPageContent',
        mode: extractMode,
        maxTokens: this.settings.maxTokens
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Обновите страницу'));
          return;
        }

        if (response && response.success && response.data) {
          const content = response.data.content || '';
          this.log(`Извлечено ~${Math.round(content.length / 4)} токенов, score: ${response.data.readabilityScore}`, 'success');
          resolve(content);
        } else {
          reject(new Error('Не удалось извлечь контент'));
        }
      });
    });
  }

  /* ====================================================================== */
  /* CHAT QUERY                                                             */
  /* ====================================================================== */

  /**
   * Send a user query along with the current page context.
   * Если pageContextEnabled — использует кэшированный контент или извлекает новый.
   * Если выключено — работает как чат-бот без контекста страницы.
   * @param {string} query
   */
  async sendChatQuery(query) {
    this.log(`sendChatQuery: "${query.substring(0, 50)}..."`);

    // Abort any previous in-flight request
    this.abortPreviousRequest();

    // Add user message to UI and history
    this.appendUserMessage(query);

    // Clear input
    if (this.userInput) {
      this.userInput.value = '';
      this.autoResizeTextarea();
    }

    try {
      // Always get the current active tab for fresh context
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) {
        this.log('Нет активной вкладки', 'error');
        return;
      }

      const tab = tabs[0];
      // Fix tabId at moment of send
      this.currentTabId = tab.id;
      this.lastTabUrl = this.currentTabUrl;
      this.currentTabUrl = tab.url || '';
      this.updateContextSourceBadge(this.currentTabUrl);

      this.setStreamingState(true);
      this.startStreamMonitoring();
      this.progressContainer.classList.remove('hidden');
      this.log('[PROGRESS] Показан прогресс-бар');
      this.setProgress(5, 'Определение модели...');

      // Сбрасываем автоскролл — новый запрос начинается с автоскролла
      this._resetAutoScroll();

      // Определяем модель: либо с сервера, либо из настроек
      let resolvedModel = this.settings.model;
      if (this.settings.useLoadedModel) {
        const loadedModel = await this.fetchLoadedModel();
        if (loadedModel) {
          resolvedModel = loadedModel;
          this.log(`[MODEL] Используем загруженную модель: ${resolvedModel}`);
          this.setProgress(8, `Модель: ${resolvedModel.substring(0, 30)}...`);
        } else {
          this.log(`[MODEL] Не удалось определить модель, используем настройку: ${resolvedModel}`, 'warning');
        }
      }

      // Определяем контент страницы
      let pageContent = '';
      if (this.pageContextEnabled) {
        // Проверяем кэш: если URL совпадает — используем кэшированный контент
        if (this.cachedPageContent && this.cachedPageUrl === this.currentTabUrl) {
          this.log('Используем кэшированный контент страницы', 'info');
          pageContent = this.cachedPageContent;
        } else {
          // Извлекаем новый контент и кэшируем
          this.setProgress(10, 'Извлечение контента...');
          pageContent = await this.extractPageContent(tab.id);
          this.cachedPageContent = pageContent;
          this.cachedPageUrl = this.currentTabUrl;
          this.log('Контент извлечён и кэширован', 'info');
        }
      } else {
        this.log('Контекст страницы отключён — работает как чат-бот', 'info');
      }

      this.setProgress(30, 'Отправка запроса...');

      // Сбрасываем response
      this.currentResponse = '';

      // Создаём AbortController для отмены запроса
      this.abortController = new AbortController();

      // Добавляем текущий запрос пользователя в историю чата перед отправкой.
      // Background.js ожидает что chatHistory уже содержит текущее сообщение пользователя
      // как последний элемент (см. streamChatQuery в background.js).
      this.chatHistory.push({ role: 'user', content: query });

      // Create assistant message element
      const msgEl = this.appendAssistantPlaceholder();

       // Send to background for streaming chat
       await this.sendMessage({
         action: 'streamChatQuery',
         query: query,
         chatHistory: this.chatHistory,
         pageContent: pageContent,
         tabId: tab.id,
         tabUrl: tab.url,
         resolvedModel: resolvedModel,
         settings: this.settings,
         signal: this.abortController.signal
       });

      this.setProgress(50, 'Анализ...');
      this.log('sendChatQuery: запрос отправлен в background', 'success');

    } catch (error) {
      this.log(`Ошибка запроса: ${error.message}`, 'error');
      this.showInErrorBanner(error.message);
      this.setStreamingState(false);
    }
  }

  /**
   * Abort any previous in-flight request to prevent overlapping responses.
   */
  abortPreviousRequest() {
    // Сброс счётчиков чанков
    this.streamChunkCount = 0;
    this.imageAnalysisChunkCount = 0;
    this.reasoningChunkCount = 0;
    this.imageReasoningChunkCount = 0;

    // Сброс анимации
    this._resetStreamAnimation();

    // Сброс флага завершённости (защита от двойного вызова)
    this._streamCompleteProcessed = false;
    this._streamFinished = false;
    this._finalizeStreamProcessed = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.log('Предыдущий запрос отменён', 'warning');
    }

    // If currently streaming, stop it
    if (this.isStreaming) {
      this.stopStreaming();
    }
  }

  /* ====================================================================== */
  /* SMOOTH STREAMING ANIMATION                                             */
  /* ====================================================================== */

   /**
    * ID последнего requestAnimationFrame для анимации.
    * @type {number|null}
    */
   _streamAnimationFrameId = null;

   /**
    * ID последнего requestAnimationFrame для анимации reasoning.
    * @type {number|null}
    */
   _reasoningAnimationFrameId = null;

    /**
     * Запускает или возобновляет анимацию потока ответа.
     * Использует requestAnimationFrame для синхронизации с частотой обновления экрана.
     */
    _startStreamAnimation() {
      if (this._streamAnimationFrameId !== null) return; // уже запущена

      // --- Гарантируем наличие элемента сообщения ---
      if (!this._streamMessageEl) {
        const lastMsg = this.chatMessages?.querySelector('.chat-message.assistant:last-child');
        if (lastMsg) {
          this._streamMessageEl = lastMsg;
        } else {
          this._streamMessageEl = this.appendAssistantPlaceholder();
        }
      }

      // Показываем точки размышления при начале стриминга
      if (this._streamMessageEl) {
        this._streamMessageEl.classList.add('streaming');
        const bubble = this._streamMessageEl.querySelector('.message-bubble');
        if (bubble) {
          bubble.innerHTML = '<div class="thinking-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
        }
      }

      // Скрываем placeholder сразу при начале запроса
      if (this.placeholder) this.placeholder.style.display = 'none';
      if (this.chatHistoryEl) this.chatHistoryEl.style.display = 'block';

      this.hideGenerationStats();
      this._totalTokens = 0;

      this._streamLastTick = performance.now();
      this._animationTickStream();
    }

   /**
    * Тик анимации с использованием requestAnimationFrame вместо setTimeout.
    * Синхронизирован с частотой обновления экрана (обычно 60Hz).
    */
   _animationTickStream() {
     const self = this;
     
     const tick = () => {
       if (!this._streamAnimationFrameId) return;
       
       self._animateStream();
       self._streamAnimationFrameId = requestAnimationFrame(tick);
     };
     
     this._streamAnimationFrameId = requestAnimationFrame(tick);
   }

   /**
    * Сбрасывает ID анимации при остановке.
    */
   _resetStreamAnimationTimer() {
     if (this._streamAnimationFrameId !== null) {
       cancelAnimationFrame(this._streamAnimationFrameId);
       this._streamAnimationFrameId = null;
     }
   }

  /**
   * Вычисляет множитель скорости на основе размера очереди.
   * Использует экспоненциальное ускорение для плавного набора скорости.
   * Множитель только растёт — не уменьшается при сокращении очереди.
   * 0 = 1.0, 1 = 1.1, 10 = 2.0, 100 = 11.0, 490 = capped at 50.0
   * @param {string} type — 'stream' или 'reasoning'
   * @param {number} remaining — кол-во ненаписанных символов
   * @param {number} maxMultiplier — максимальный множитель
   * @returns {number}
   */
  _getSpeedMultiplier(type, remaining, maxMultiplier = 50.0) {
    // Линейная часть: каждый символ добавляет +0.1 к множителю
    const linear = 1 + remaining * 0.1;
    
    // Экспоненциальная часть: ускоряем при большой очереди
    // При 100 символах = 2.0×, при 200 = 4.0×, при 500 = 10.0×
    const exponential = Math.pow(1.02, remaining);
    
    // Комбинируем: линейная + экспоненциальная (с весами)
    const combined = 0.5 * linear + 0.5 * exponential;
    
    // Ограничиваем максимальным множителем
    const capped = Math.min(combined, maxMultiplier);

    // Сохраняем и возвращаем максимальный достигнутый множитель
    if (type === 'stream') {
      this._streamMaxMultiplier = Math.max(this._streamMaxMultiplier, capped);
      return this._streamMaxMultiplier;
    } else {
      this._reasoningMaxMultiplier = Math.max(this._reasoningMaxMultiplier, capped);
      return this._reasoningMaxMultiplier;
    }
  }

   /**
    * Тик анимации: забирает символы из буфера и обновляет DOM.
    * Использует дробный накопитель для точной скорости.
    * Скорость зависит от реального времени (delta), а не от частоты кадров.
    * Синхронизирован с requestAnimationFrame для плавности.
    */
   _animateStream() {
     // Если элемент сообщения пропал – пробуем восстановить
     if (!this._streamMessageEl) {
       const lastMsg = this.chatMessages?.querySelector('.chat-message.assistant:last-child');
       if (lastMsg) {
         this._streamMessageEl = lastMsg;
       } else {
         this._resetStreamAnimationTimer();
         this._streamFraction = 0;
         this.log('_animateStream: _streamMessageEl не найден, выходим', 'warning');
         return;
       }
     }

     const now = performance.now();
     const deltaMs = now - this._streamLastTick;
     this._streamLastTick = now;

     // Защита от слишком большого delta (например, при переключении вкладок)
     const clampedDelta = Math.min(deltaMs, 1000); // макс 1 секунда
     const deltaSeconds = clampedDelta / 1000;

     const remaining = this._streamBuffer.length - this._streamDisplayed.length;

     if (remaining <= 0 && this._streamFinished) {
       // Буфер исчерпан и стриминг завершён — останавливаемся
       this._resetStreamAnimationTimer();
       this._streamFraction = 0;
       this._finalizeStreamDisplay();
       return;
     }

     if (remaining <= 0) {
       // Буфер пуст, но стриминг ещё идёт — ждём следующий чанк
       this._resetStreamAnimationTimer();
       this._streamFraction = 0;
       return;
     }

     // Вычисляем скорость на основе размера очереди через мультипликатор.
     // Базовая: 360/мин (6/сек) — комфортный темп чтения.
     // Множитель: каждый символ в очереди = +0.1 к скорости.
     // 0 = 1.0× (360/мин), 10 = 2.0× (720/мин), 490+ = capped 50.0× (18000/мин)
     const baseSymbolsPerMinute = 360;
     const multiplier = this._getSpeedMultiplier('stream', remaining);
     const symbolsPerMinute = baseSymbolsPerMinute * multiplier;
     const symbolsPerSecond = symbolsPerMinute / 60;

     // Конвертируем в символы за прошедшее время
     const symbolsToPrint = symbolsPerSecond * deltaSeconds;

     // Накапливаем дробную часть
     this._streamFraction += symbolsToPrint;

     // Печатаем целое количество символов из накопителя
     let charsToPrint = Math.floor(this._streamFraction);
     if (charsToPrint > 0) {
       // Защита: не печатаем больше чем осталось в буфере
       const maxChars = Math.max(0, this._streamBuffer.length - this._streamDisplayed.length);
       charsToPrint = Math.min(charsToPrint, maxChars);

       if (charsToPrint > 0) {
         this._streamDisplayed = this._streamBuffer.substring(0, this._streamDisplayed.length + charsToPrint);
         this._streamFraction -= charsToPrint;

         // Обновляем DOM (без курсора)
         if (this._streamMessageEl) {
           const bubble = this._streamMessageEl.querySelector('.message-bubble');
           if (bubble) {
             bubble.innerHTML = formatMarkdown(this._streamDisplayed);
           }
         }
       }
     }
   }

  /**
   * Завершает стриминг: убирает курсор, показывает финальный текст.
   * НЕ скроллит принудительно — если пользователь читает, не сбиваем его.
   */
  _finalizeStreamDisplay() {
    // Защита от повторных вызовов
    if (this._finalizeStreamProcessed) return;
    this._finalizeStreamProcessed = true;

    if (this._streamMessageEl) {
      const bubble = this._streamMessageEl.querySelector('.message-bubble');
      if (bubble) {
        const processed = this.postProcessContent(this._streamBuffer);
        bubble.innerHTML = formatMarkdown(processed);
        this.setupCodeCopyButtons(bubble);
        this.log(`_finalizeStreamDisplay: ${this._streamBuffer?.length || 0} символов отрендерено`, 'success');
      } else {
        this.log(`_finalizeStreamDisplay: .message-bubble не найден`, 'warning');
      }
      this._streamMessageEl.classList.add('streaming');
    } else {
      this.log(`_finalizeStreamDisplay: _streamMessageEl не установлен`, 'warning');
    }
    // НЕ скроллим — пользователь может читать, не сбиваем его
    // this.scrollToBottom(false);
  }

  /**
   * Сброс всех анимационных состояний.
   */
   _resetStreamAnimation() {
     this._resetStreamAnimationTimer();
     
     if (this._reasoningAnimationFrameId !== null) {
       cancelAnimationFrame(this._reasoningAnimationFrameId);
       this._reasoningAnimationFrameId = null;
     }
     
     this._streamBuffer = '';
     this._streamDisplayed = '';
     this._streamFraction = 0;
     this._streamLastTick = 0;
     this._streamMaxMultiplier = 1.0;
     // НЕ обнуляем _streamMessageEl — сохраняем ссылку для переиспользования
     this._streamFinished = false;
     // Сбрасываем флаг финализации для корректной работы при новом стриме
     this._finalizeStreamProcessed = false;
     // Убираем streaming чтобы при новом стриминге снова показались точки
     const msgEl = this._streamMessageEl;
     if (msgEl) {
       msgEl.classList.remove('streaming');
     }
     this._reasoningBuffer = '';
     this._reasoningDisplayed = '';
     this._reasoningFraction = 0;
     this._reasoningLastTick = 0;
     this._reasoningMaxMultiplier = 1.0;
     this._reasoningFinished = false;
   }

   /**
    * Запускает анимацию reasoning.
    */
   _startReasoningAnimation() {
     if (this._reasoningAnimationFrameId !== null) return;
     this._reasoningLastTick = performance.now();
     this._animationTickReasoning();
   }

   /**
    * Тик анимации с использованием requestAnimationFrame для reasoning.
    * Синхронизирован с частотой обновления экрана (обычно 60Hz).
    */
   _animationTickReasoning() {
     const self = this;
     
     const tick = () => {
       if (!this._reasoningAnimationFrameId) return;
       
       self._animateReasoning();
       this._reasoningAnimationFrameId = requestAnimationFrame(tick);
     };
     
     this._reasoningAnimationFrameId = requestAnimationFrame(tick);
   }

   /**
    * Сбрасывает ID анимации reasoning при остановке.
    */
   _resetReasoningAnimationTimer() {
     if (this._reasoningAnimationFrameId !== null) {
       cancelAnimationFrame(this._reasoningAnimationFrameId);
       this._reasoningAnimationFrameId = null;
     }
   }

  /**
   * Тик анимации reasoning — дробный накопитель для плавной скорости.
   * Скорость зависит от реального времени (delta), а не от частоты кадров.
   */
   _animateReasoning() {
     const now = performance.now();
     let deltaMs = now - this._reasoningLastTick;
     this._reasoningLastTick = now;

     // Защита от слишком большого delta
     const clampedDelta = Math.min(deltaMs, 1000);
     deltaMs = clampedDelta;
     const deltaSeconds = deltaMs / 1000;

     const remaining = this._reasoningBuffer.length - this._reasoningDisplayed.length;

     if (remaining <= 0 && (this.isReasoningStreaming === false || this._reasoningFinished)) {
       this._resetReasoningAnimationTimer();
       this._reasoningFraction = 0;
       // Финализируем reasoning ТОЛЬКО если ещё не финализирован
       this._finalizeReasoningDisplay();
       return;
     }

     if (remaining <= 0) {
       this._resetReasoningAnimationTimer();
       this._reasoningFraction = 0;
       return;
     }

     // Скорость reasoning через мультипликатор — используется та же базовая скорость.
     // Базовая: 360/мин (6/сек) — комфортный темп чтения.
     // Множитель: каждый символ = +0.1, cap 50.0× (18000/мин)
     const baseSymbolsPerMinute = 360;
     const multiplier = this._getSpeedMultiplier('reasoning', remaining);
     const symbolsPerMinute = baseSymbolsPerMinute * multiplier;
     const symbolsPerSecond = symbolsPerMinute / 60;

     const symbolsToPrint = symbolsPerSecond * deltaSeconds;

     this._reasoningFraction += symbolsToPrint;

     let charsToPrint = Math.floor(this._reasoningFraction);
     if (charsToPrint > 0) {
       charsToPrint = Math.min(charsToPrint, remaining);
       this._reasoningDisplayed = this._reasoningBuffer.substring(0, this._reasoningDisplayed.length + charsToPrint);
       this._reasoningFraction -= charsToPrint;

       if (this.reasoningContent) {
         this.reasoningContent.classList.add('streaming');
         this.reasoningContent.innerHTML = escapeHtml(this._reasoningDisplayed) + '<span class="cursor"></span>';
       }
     }
   }

  /**
   * Завершает reasoning: убирает курсор, показывает финальный текст.
   */
  _finalizeReasoningDisplay() {
    // Защита от повторных вызовов — уже был финализирован
    if (this._reasoningFinalized) {
      return;
    }
    
    if (this.reasoningContent && this._reasoningBuffer) {
      this._reasoningFinalized = true;
      this.reasoningContent.classList.remove('streaming');
      this.reasoningContent.innerHTML = formatMarkdown(this._reasoningBuffer);
      this.setupCodeCopyButtons(this.reasoningContent);
      this.log(`_finalizeReasoningDisplay: ${this._reasoningBuffer?.length || 0} символов`, 'success');
    }
    this._reasoningFinished = true;
  }

  /* ====================================================================== */
  /* STREAMING STATE                                                        */
  /* ====================================================================== */

  setStreamingState(streaming) {
    this.isStreaming = streaming;

    if (this.actionBtn) {
      if (streaming) {
        // Иконка "стоп" — SVG вместо эмодзи
        this.actionBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="6" y="6" width="12" height="12" rx="1"></rect>
          </svg>
        `;
        this.actionBtn.classList.add('loading');
        this.actionBtn.title = 'Остановить генерацию';
      } else {
        // Иконка "анализировать" — SVG
        this.actionBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2L11 13"></path>
            <path d="M22 2L15 22L11 13L2 9L22 2Z"></path>
          </svg>
        `;
        this.actionBtn.classList.remove('loading');
        this.actionBtn.title = 'Анализировать страницу (Ctrl+Enter)';
      }
    }

    if (this.userInput) {
      this.userInput.disabled = streaming;
    }

    if (!streaming) {
      if (this.progressContainer) {
        if (this.progressText) {
          this.progressText.classList.remove('thinking');
        }
        this.progressContainer.classList.remove('analysis-cancelled');
        this.progressContainer.classList.add('hidden');
      }
      this.stopStreamMonitoring();
    }
  }

  stopStreaming() {
    this.log('Остановка...', 'warning');

    // Notify background to abort
    chrome.runtime.sendMessage({ action: 'abortStream' }).catch(() => {});

    this.setStreamingState(false);

    // Remove any cursors
    document.querySelectorAll('.cursor').forEach(c => c.remove());
    this.log('Стриминг остановлен', 'warning');
  }

  /* ====================================================================== */
  /* STREAM HANDLERS (from background via storage / messages)               */
  /* ====================================================================== */

  /**
   * Handle a streamed content chunk from background.
   * @param {string} content — полный текст от начала (не дельта!)
   */
  handleStreamChunk(content) {
    if (!content || typeof content !== 'string') return;

    this.currentResponse = content;
    this.streamChunkCount++;
    this.onStreamChunkReceived();
    this.updateGenerationMetrics();

    // Чанки приходят с полным текстом — обновляем буфер
    // ВНИМАНИЕ: не перезаписываем _streamDisplayed — анимация сама управляет им
    this._streamBuffer = content;

    // --- Принудительно создаём/находим assistant-сообщение, если его нет ---
    if (!this._streamMessageEl) {
      const lastMsg = this.chatMessages?.querySelector('.chat-message.assistant:last-child');
      if (lastMsg) {
        this._streamMessageEl = lastMsg;
      } else {
        this._streamMessageEl = this.appendAssistantPlaceholder();
      }
    }

    // Запускаем или возобновляем анимацию
    this._startStreamAnimation();

    // Обновляем прогресс
    this.setProgress(85, `Получение ответа... (#${this.streamChunkCount})`);
  }

  /**
   * Handle stream completion.
   * @param {string} content
   */
  handleStreamComplete(content) {
    // Защита от двойного вызова (runtime message + storage fallback)
    if (this._streamCompleteProcessed) {
      this.log('[COMPLETE] handleStreamComplete уже вызван, пропускаю', 'warning');
      return;
    }
    this._streamCompleteProcessed = true;

    this.log(`handleStreamComplete: ${content?.length || 0} символов`, 'success');

    // Останавливаем мониторинг — стрим завершён
    this.stopStreamMonitoring();

    // Обновляем буфер финальным текстом
    this._streamBuffer = content || this._streamBuffer;

    // Убеждаемся что _streamMessageEl установлен
    if (!this._streamMessageEl) {
      const lastAssistantMsg = this.chatMessages?.lastElementChild;
      if (lastAssistantMsg && lastAssistantMsg.classList.contains('assistant')) {
        this._streamMessageEl = lastAssistantMsg;
      }
    }

    // Показываем статистику генерации
    const elapsed = Date.now() - this._streamStartTime;
    this.showGenerationStats(elapsed);

    // Помечаем что стриминг завершён
    this._streamFinished = true;

    // Если анимация не запущена или уже остановлена — финализируем сразу
    if (this._streamAnimationFrameId === null) {
      this.log('[COMPLETE] Анимация не активна, финализируем сразу');
      this._finalizeStreamDisplay();
    } else {
      this.log('[COMPLETE] Анимация активна, допечатает остаток');
      // Иначе анимация сама допечатает остаток и вызовет _finalizeStreamDisplay
    }

    // Add to chat history
    if (this._streamBuffer && this._streamBuffer.trim()) {
      this.chatHistory.push({ role: 'assistant', content: this._streamBuffer });
    }

    this.setStreamingState(false);

    setTimeout(() => {
      this.log('[PROGRESS] Скрыт прогресс-бар');
      if (this.progressContainer) {
        if (this.progressText) {
          this.progressText.classList.remove('thinking');
        }
        this.progressContainer.classList.remove('analysis-cancelled');
        this.progressContainer.classList.add('hidden');
      }
    }, 1500);
  }

  /**
   * Handle stream error.
   * @param {string} error
   */
  handleStreamError(error) {
    if (!error) return; // Не показывать пустые ошибки
    this.log(`handleStreamError: ${error}`, 'error');

    // Показываем ошибку как отдельное сообщение в чате
    this.showInErrorBanner(error);

    this.setStreamingState(false);
  }

  /* ====================================================================== */
  /* REASONING                                                              */
  /* ====================================================================== */

  handleReasoningChunk(content) {
    if (!content || typeof content !== 'string') return;

    this.currentReasoning = content;
    this.reasoningContainer?.classList.remove('hidden');
    this.reasoningChunkCount++;

    // Чанки приходят с полным текстом — обновляем буфер
    this._reasoningBuffer = content;

    // Запускаем анимацию
    this._startReasoningAnimation();

    // Обновляем прогресс: модель рассуждает — показываем номер чанка
    this.setProgress(70, `Модель рассуждает... (#${this.reasoningChunkCount})`);
  }

   handleReasoningComplete(content) {
     this.log('handleReasoningComplete');
     this.isReasoningStreaming = false;

     // Обновляем буфер финальным текстом
     if (content) this._reasoningBuffer = content;
     this._reasoningFinished = true;

     // Завершаем reasoning анимацию — она допечатает остаток
     // Проверка: если анимация не запущена (AnimationFrameId === null), финализируем сразу
     if (this._reasoningAnimationFrameId === null && this._reasoningBuffer) {
       // Сбрасываем анимационные таймеры перед финализацией
       this._resetReasoningAnimationTimer();
       this._finalizeReasoningDisplay();
       return;
     }

     if (content && content.length < 500 && !this.reasoningExpanded) {
       this.expandReasoning();
     }
   }

  toggleReasoning() {
    if (this.reasoningExpanded) {
      this.collapseReasoning();
    } else {
      this.expandReasoning();
    }
  }

  expandReasoning() {
    this.reasoningExpanded = true;
    this.reasoningContent?.classList.remove('collapsed');
    this.reasoningToggle?.setAttribute('aria-expanded', 'true');
  }

  collapseReasoning() {
    this.reasoningExpanded = false;
    this.reasoningContent?.classList.add('collapsed');
    this.reasoningToggle?.setAttribute('aria-expanded', 'false');
  }

  /* ====================================================================== */
  /* IMAGE ANALYSIS (renamed from imageTranslation)                         */
  /* ====================================================================== */

  /**
   * Handle image analysis completion.
   * @param {string} content
   */
  handleImageAnalysisComplete(content) {
    if (!content || content.length === 0) {
      this.log('handleImageAnalysisComplete: пустой контент, игнорируем');
      return;
    }

    // Объявляем переменную isOldTextRemaining перед первым использованием
    let isOldTextRemaining = false;

    this.log('handleImageAnalysisComplete:', content.length, 'streamAnimationFrameId:', this._streamAnimationFrameId, '_streamBuffer:', this._streamBuffer?.length || 0, '_streamDisplayed:', this._streamDisplayed?.length || 0, '_finalizeStreamProcessed:', this._finalizeStreamProcessed);

    // КРИТИЧЕСКАЯ ЗАЩИТА ДЛЯ ВТОРОГО ЗАПУСКА:
    // Если флаг финализации остался true с предыдущего анализа — принудительно сбрасываем
    // Это происходит когда _resetContext() не сработал или анимация не была корректно остановлена
    if (this._finalizeStreamProcessed) {
      this.log('[ANALYSIS COMPLETE] КРИТИЧНО: _finalizeStreamProcessed=true, сбрасываем!', 'warning');
      this._finalizeStreamProcessed = false;
      // Очищаем DOM чтобы новый контент мог отобразиться
      if (this._streamMessageEl) {
        const bubble = this._streamMessageEl.querySelector('.message-bubble');
        if (bubble) {
          bubble.innerHTML = '<span class="cursor"></span>';
        }
      }
    }

    this.setProgress(100, 'Анализ завершён!');

    // Останавливаем мониторинг — стрим завершён
    this.stopStreamMonitoring();

    // Показываем статистику генерации
    const elapsed = Date.now() - this._streamStartTime;
    this.showGenerationStats(elapsed);

    // Если буфер пуст (не было чанков), заполняем его полученным контентом
    if (!this._streamBuffer || this._streamBuffer.length === 0) {
      this.log('[ANALYSIS COMPLETE] Буфер пуст, заполняю из content');
      this._streamBuffer = content;
    }
    
    // КРИТИЧЕСКАЯ ЗАЩИТА ДЛЯ ВТОРОГО ЗАПУСКА:
    // _streamDisplayed должен быть меньше или равен _streamBuffer
    // Если _streamDisplayed > _streamBuffer — это остаток предыдущего анализа
    isOldTextRemaining = false;
    if (this._streamDisplayed && this._streamDisplayed.length > 0 && this._streamBuffer && this._streamBuffer.length > 0) {
      if (this._streamDisplayed.length > this._streamBuffer.length) {
        this.log('[IMAGE CHUNK] Сброс _streamDisplayed (старый текст больше нового): ' + this._streamDisplayed.length + ' -> 0');
        this._streamDisplayed = '';
        this._streamFraction = 0;
        isOldTextRemaining = true;
      }
    }
    
    // Проверка: если _streamDisplayed не пустой и не равен _streamBuffer — значит
    // анимация не была завершена корректно, сбрасываем до корректного состояния
    if (this._streamDisplayed && this._streamDisplayed.length > 0 && this._streamDisplayed !== this._streamBuffer) {
      // Вычисляем корректный remaining для этого запуска
      const remaining = (this._streamBuffer?.length || 0) - (this._streamDisplayed?.length || 0);
      // Если remaining слишком большой — вероятно старый текст в _streamDisplayed
      if (remaining < 0 || (remaining > (this._streamBuffer?.length || 0) * 0.5)) {
        this.log('[ANALYSIS COMPLETE] Подозрительное состояние: сбрасываем _streamDisplayed');
        this._streamDisplayed = '';
        this._streamFraction = 0;
        isOldTextRemaining = true;
      }
    }
    
    // content содержит полные данные от API, не надо перезаписывать _streamBuffer
    // _streamBuffer уже содержит все собранные чанки (reasoning + imageAnalysis)
    
    // Помечаем что стриминг завершён
    this._streamFinished = true;
    
    // Проверяем разницу между буфером и отображённым текстом
    const remaining = (this._streamBuffer?.length || 0) - (this._streamDisplayed?.length || 0);
    this.log('[ANALYSIS COMPLETE] content.length=' + content.length + ', _streamBuffer.length=' + (this._streamBuffer?.length || 0) + ', _streamDisplayed.length=' + (this._streamDisplayed?.length || 0) + ', remaining=' + remaining + ', isOldTextRemaining=' + isOldTextRemaining);
    
    // Если анимация не запущена (AnimationFrameId === null) — финализируем сразу
    // Это случается если старый requestAnimationFrame был отменён, но флаг не был сброшен
    if (this._streamAnimationFrameId === null) {
      this.log('[ANALYSIS COMPLETE] Анимация не активна, финализируем сразу');
      this._finalizeStreamDisplay();
    } else if (remaining > 500) {
      // Если осталось слишком много символов (>500) — финализируем сразу
      this.log('[ANALYSIS COMPLETE] Не успели отобразить ' + remaining + ' символов, финализируем сразу');
      this._resetStreamAnimationTimer(); // Останавливаем анимацию
      this._finalizeStreamDisplay();
    } else if (isOldTextRemaining || remaining <= 0) {
      // КРИТИЧЕСКАЯ ЗАЩИТА: если был старый текст или remaining <= 0, финализируем сразу
      // Это предотвращает зависание анимации в состоянии когда remaining=9
      this.log('[ANALYSIS COMPLETE] isOldTextRemaining=' + isOldTextRemaining + ', finalizing immediately');
      this._finalizeStreamDisplay();
    } else {
      this.log('[ANALYSIS COMPLETE] Анимация продолжится, remaining=' + remaining);
      // Иначе анимация сама допечатает остаток и вызовет _finalizeStreamDisplay
    }

    // Сохраняем ссылку на сообщение для финализации
    const msgEl = this.chatMessages?.lastElementChild;
    if (msgEl && msgEl.classList.contains('assistant')) {
      if (!this._streamMessageEl) {
        this._streamMessageEl = msgEl;
      }
    }

    // НЕ добавляем в chatHistory — анализ изображения не является частью диалога
    this.isImageAnalysisActive = false;
    this.stopImageAnalysisCheck();

    // Скрываем прогресс-бар через 1.5 секунды
    setTimeout(() => {
      this.log('[PROGRESS] Скрыт прогресс-бар (анализ изображения)');
      if (this.progressContainer) {
        if (this.progressText) {
          this.progressText.classList.remove('thinking');
        }
        this.progressContainer.classList.remove('analysis-cancelled');
        this.progressContainer.classList.add('hidden');
      }
      this.stopImageAnalysisCheck();
    }, 1500);
  }

  /**
   * Handle image analysis error.
   * @param {string} error
   */
  handleImageAnalysisError(error) {
    if (!error) return; // Не показывать пустые ошибки
    this.log('handleImageAnalysisError:', error);

    // Показываем ошибку как отдельное сообщение в чате
    this.showInErrorBanner(error);

    if (this.progressContainer) {
      if (this.progressText) {
        this.progressText.classList.remove('thinking');
      }
      this.progressContainer.classList.remove('analysis-cancelled');
      this.progressContainer.classList.add('hidden');
    }

    this.isImageAnalysisActive = false;
    this.stopImageAnalysisCheck();
  }

  /**
   * Handle image analysis chunk.
   * @param {string} content
   */
  handleImageAnalysisChunk(content) {
    if (!content || typeof content !== 'string') return;

    // ВАЖНО: Сбрасываем _streamDisplayed при начале нового чанка,
    // чтобы избежать ситуации когда _streamDisplayed > _streamBuffer
    // (это происходит если предыдущий анализ не был полностью отображён)
    if (this._streamDisplayed && this._streamDisplayed.length > 0 && this._streamBuffer && this._streamBuffer.length > 0) {
      if (this._streamDisplayed.length > this._streamBuffer.length) {
        this.log('[IMAGE CHUNK] Сброс _streamDisplayed: ' + this._streamDisplayed.length + ' -> 0 (старый текст)');
        this._streamDisplayed = '';
        this._streamFraction = 0;
      }
    }
    
    // Дополнительная проверка: если _streamDisplayed больше чем новый контент - сбрасываем
    if (this._streamDisplayed && this._streamDisplayed.length > content.length) {
      this.log('[IMAGE CHUNK] Сброс _streamDisplayed (старый текст больше нового): ' + this._streamDisplayed.length + ' -> 0');
      this._streamDisplayed = '';
      this._streamFraction = 0;
    }

    this.log('[IMAGE CHUNK START] Перед добавлением: _streamBuffer=' + this._streamBuffer?.length + ', _streamMessageEl=' + (this._streamMessageEl ? 'SET' : 'NULL'), '_streamDisplayed=' + this._streamDisplayed?.length + ', _streamFinished=' + this._streamFinished);
    
    this.currentImageAnalysis = content;
    this.imageAnalysisChunkCount++;

    // ВАЖНО: content содержит полный текст на данный момент (не дельта),
    // поэтому мы просто устанавливаем его как _streamBuffer
    this._streamBuffer = content;
    
    this.log('[IMAGE CHUNK] Установлен чанк: _streamBuffer=' + this._streamBuffer?.length + ', content.length=' + content.length + ', imageAnalysisChunkCount=' + this.imageAnalysisChunkCount);

    // Убеждаемся что _streamMessageEl установлен
    if (!this._streamMessageEl) {
      this.log('[IMAGE CHUNK] _streamMessageEl НЕ установлен, создаём новый');
      // Создаём или обновляем assistant сообщение
      const msgEl = this.chatMessages?.lastElementChild;
      if (msgEl && msgEl.classList.contains('assistant')) {
        this._streamMessageEl = msgEl;
        this.log('[IMAGE CHUNK] Найдено существующее assistant сообщение');
      } else {
        this._streamMessageEl = this.appendAssistantPlaceholder();
        this.log('[IMAGE CHUNK] Создано новое assistant сообщение');
      }
    } else {
      this.log('[IMAGE CHUNK] _streamMessageEl уже установлен, используем существующий');
      // Проверяем есть ли message-bubble элемент
      const bubble = this._streamMessageEl.querySelector('.message-bubble');
      if (bubble) {
        this.log('[IMAGE CHUNK] message-bubble найден, текущий innerHTML:', bubble.innerHTML.substring(0, 50));
      } else {
        this.log('[IMAGE CHUNK] message-bubble НЕ найден!');
      }
    }

    // Запускаем анимацию если ещё не запущена
    if (!this._streamAnimationFrameId) {
      this.log('[IMAGE CHUNK] Запускаем _startStreamAnimation');
      this._startStreamAnimation();
    } else {
      this.log('[IMAGE CHUNK] Анимация уже запущена (_streamAnimationFrameId=' + this._streamAnimationFrameId + ')');
    }

    if (this.imageAnalysisChunkCount <= 3 || this.imageAnalysisChunkCount > this.imageAnalysisChunkCount - 3) {
      this.log('[IMAGE CHUNK LATE] _streamBuffer=' + this._streamBuffer?.length + ', _streamDisplayed=' + this._streamDisplayed?.length + ', bubble inner=' + (this._streamMessageEl?.querySelector('.message-bubble')?.innerHTML || 'NULL')?.substring(0, 50));
    }

    // Обновляем прогресс: модель анализирует — показываем номер чанка
    this.setProgress(80, `Анализ изображения... (#${this.imageAnalysisChunkCount})`);
  }

  /**
   * Handle image reasoning chunk.
   * @param {string} content
   */
  handleImageReasoningChunk(content) {
    this.log('handleImageReasoningChunk:', content?.length || 0);

    this.currentImageReasoning = content;
    this.reasoningContainer?.classList.remove('hidden');
    this.imageReasoningChunkCount++;

    // Унифицировано с page analysis — используем буфер и анимацию
    this._reasoningBuffer = content;
    this._startReasoningAnimation();

    // reasoning отображается ТОЛЬКО в панели рассуждений, НЕ в чате
    if (!this._streamMessageEl) {
      const msgEl = this.chatMessages?.lastElementChild;
      if (msgEl && msgEl.classList.contains('assistant')) {
        this._streamMessageEl = msgEl;
      } else {
        this._streamMessageEl = this.appendAssistantPlaceholder();
      }
    }
    
    // Запускаем анимацию стриминга если не запущена
    if (!this._streamAnimationFrameId) {
      this._startStreamAnimation();
    }

    // Обновляем прогресс: модель рассуждает — показываем номер чанка
    this.setProgress(70, `Модель рассуждает... (#${this.imageReasoningChunkCount})`);
  }

  /**
   * Handle image reasoning complete.
   * @param {string} content
   */
  handleImageReasoningComplete(content) {
    this.log('handleImageReasoningComplete:', content?.length || 0);
    // Устанавливаем флаги — анимация сама допечатает и финализирует
    this._reasoningBuffer = content;
    this._reasoningFinished = true;
    // Проверка: если анимация не запущена (AnimationFrameId === null), финализируем сразу
    if (this._reasoningAnimationFrameId === null) {
      // Сбрасываем анимационные таймеры перед финализацией
      this._resetReasoningAnimationTimer();
      this._finalizeReasoningDisplay();
    }
  }

  /* ====================================================================== */
  /* STORAGE CHANGE LISTENER                                                */
  /* ====================================================================== */

  setupStorageListener() {
    const self = this;

    // Storage listener — handles ONLY progress updates.
    // Content/error/complete are handled via runtime.onMessage (faster, no duplication).
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local') return;

      // Предотвращаем бесконечный цикл — игнорируем изменения, инициированные самим sidebar
      if (self._isUpdatingFromStorage) return;

      self.storageChangesReceived++;
      const changedKeys = Object.keys(changes);
      self.log(`storage onChanged #${self.storageChangesReceived}:`, changedKeys.join(', '));

      // --- streamProgress (только показ контейнера и лог) ---
      if (changes.streamProgress) {
        const val = changes.streamProgress.newValue ?? changes.streamProgress.value;
        if (typeof val === 'number' && val > 0) {
          // Показываем прогресс-бар только если прогресс > 0
          if (self.progressContainer) {
            self.progressContainer.classList.remove('hidden');
          }
          self.log(`[PROGRESS] storage: ${val}%`);
        }
      }

      // --- streamProgressText (только лог) ---
      if (changes.streamProgressText) {
        const val = changes.streamProgressText.newValue ?? changes.streamProgressText.value;
        if (typeof val === 'string' && val.length > 0) {
          // Показываем прогресс-бар только если текст не пустой
          if (self.progressContainer) {
            self.progressContainer.classList.remove('hidden');
          }
          // Обновляем текст только если setProgress ещё не установил свой
          if (self.progressText && !self.isStreaming) {
            self.progressText.textContent = val;
          }
          self.log(`[PROGRESS] storage text: ${val}`);
        }
      }

      // --- streamError — показываем ошибку в чате ---
      if (changes.streamError) {
        const val = changes.streamError.newValue ?? changes.streamError.value;
        if (typeof val === 'string' && val) {
          self.log(`[ERROR] storage: ${val}`, 'error');
          self.showInErrorBanner(val);
          self.setStreamingState(false);
        }
      }

      // --- streamIsComplete — завершение стрима через storage (fallback если runtime message потерялось) ---
      if (changes.streamIsComplete) {
        const val = changes.streamIsComplete.newValue ?? changes.streamIsComplete.value;
        if (val === true) {
          self.log('[COMPLETE] streamIsComplete через storage — fallback', 'success');
          // Получаем контент из streamContent
          chrome.storage.local.get(['streamContent'], (result) => {
            if (result.streamContent) {
              self.handleStreamComplete(result.streamContent);
            } else {
              // Если контента нет в storage — используем буфер
              self.handleStreamComplete(self._streamBuffer);
            }
          });
        }
      }

      // --- streamImageError — ошибка анализа изображения ---
      if (changes.streamImageError) {
        const val = changes.streamImageError.newValue ?? changes.streamImageError.value;
        if (typeof val === 'string' && val) {
          self.log(`[IMAGE ERROR] storage: ${val}`, 'error');
          self.showInErrorBanner(val);
          self.isImageAnalysisActive = false;
          self.stopImageAnalysisCheck();
          if (self.progressContainer) {
            if (self.progressText) {
              self.progressText.classList.remove('thinking');
            }
            self.progressContainer.classList.remove('analysis-cancelled');
          }
          self.stopStreamMonitoring();
        }
      }

      // --- streamContent — финальный контент из background (fallback если runtime message не дошёл) ---
      if (changes.streamContent) {
        const val = changes.streamContent.newValue ?? changes.streamContent.value;
        if (typeof val === 'string' && val && !self._streamBuffer) {
          self.log(`[FALLBACK] streamContent из storage: ${val.length} символов`);
          // Убеждаемся что _streamMessageEl установлен
          if (!self._streamMessageEl) {
            const lastMsg = self.chatMessages?.lastElementChild;
            if (lastMsg && lastMsg.classList.contains('assistant')) {
              self._streamMessageEl = lastMsg;
            }
          }
          self._streamBuffer = val;
          self._finalizeStreamDisplay();
          self.showGenerationStats(Date.now() - self._streamStartTime);
        }
      }
    });

    // --- Direct runtime messages from background ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Ignore content-script-only messages
      if (message.action === 'getFullSizeImageUrl' || message.action === 'translateImage') {
        sendResponse({ success: false, error: 'Sidebar не обрабатывает это сообщение' });
        return true;
      }

      // Сброс чата перед новым анализом изображения
      if (message.action === 'resetChatForImageAnalysis') {
        self._resetContext();
        sendResponse({ success: true });
        return true;
      }

      if (message.type === 'streamChunk') {
        self.handleStreamChunk(message.content);
        sendResponse({ success: true });
      } else if (message.type === 'streamComplete') {
        self.handleStreamComplete(message.content);
        sendResponse({ success: true });
      } else if (message.type === 'streamError') {
        self.handleStreamError(message.error);
        sendResponse({ success: true });
      } else if (message.type === 'streamProgress') {
        // Только лог — UI управляется через setProgress в handleChunk
        if (typeof message.progress === 'number') self.log(`[PROGRESS] runtime: ${message.progress}%`);
        if (typeof message.progressText === 'string') self.log(`[PROGRESS] runtime text: ${message.progressText}`);
        sendResponse({ success: true });
      }

      // --- Image analysis messages (renamed from imageTranslation*) ---
      else if (message.type === 'imageAnalysisChunk') {
        self.log('imageAnalysisChunk:', message.content?.substring(0, 100));
        self.handleImageAnalysisChunk(message.content);
        sendResponse({ success: true });
      }

      else if (message.type === 'imageAnalysisComplete') {
        self.handleImageAnalysisComplete(message.content);
        sendResponse({ success: true });
      }

      else if (message.type === 'imageAnalysisError') {
        self.handleImageAnalysisError(message.error);
        sendResponse({ success: true });
      }

      else if (message.type === 'imageReasoningChunk') {
        self.log('imageReasoningChunk:', message.content?.substring(0, 100));
        self.handleImageReasoningChunk(message.content);
        sendResponse({ success: true });
      }

      else if (message.type === 'imageReasoningComplete') {
        self.handleImageReasoningComplete(message.content);
        sendResponse({ success: true });
      }

      // --- Command to start analysis ---
      else if (message.action === 'startAnalysis') {
        self.log('startAnalysis command received');
        self.handleAction();
        sendResponse({ success: true });
      }

      // Для неизвестных сообщений — ответ по умолчанию
      else {
        sendResponse({ success: true });
      }
    });

    this.log('setupStorageListener: обработчики установлены');
  }

  /* ====================================================================== */
  /* RESET CHAT                                                             */
  /* ====================================================================== */

  /**
   * Сбрасывает чат и контекст. Вызывается по Ctrl+R или через clear-btn.
   */
  resetChat() {
    this.log('resetChat: сброс чата');
    this._resetContext();
    this.log('Чат сброшен', 'info');
  }

  /* ====================================================================== */
  /* COPY & CLEAR                                                           */
  /* ====================================================================== */

  /**
   * Сбрасывает контекст: историю чата, кэш страницы, метрики стриминга, storage, UI.
   * НЕ трогает настройки сервера.
   */
  _resetContext() {
    this.log('_resetContext: начало полного сброса');
    
    // === ПОЛНЫЙ СБРОС ВСЕХ АНИМАЦИОННЫХ ПОЛЕЙ ===
    // Вызываем _resetStreamAnimation() для остановки всех таймеров
    this._resetStreamAnimation();
    
    // Явно обнуляем все ID анимации (на случай если они не были сброшены _resetStreamAnimation)
    this._streamAnimationFrameId = null;
    this._reasoningAnimationFrameId = null;
    
    // КРИТИЧЕСКИ ВАЖНО: обнуляем _streamMessageEl — он будет указывать на удалённый DOM-элемент
    // после того как chatMessages.innerHTML будет очищен ниже. Если не обнулить — анимация
    // будет обновлять bubble.innerHTML удалённого элемента и ничего не отобразится в UI.
    this._streamMessageEl = null;
    
    // Сбрасываем буферы и отображённый текст
    this._streamBuffer = '';
    this._streamDisplayed = '';
    this._streamFraction = 0;
    
    this._reasoningBuffer = '';
    this._reasoningDisplayed = '';
    this._reasoningFraction = 0;
    
    // Сбрасываем таймиг
    this._streamLastTick = 0;
    this._reasoningLastTick = 0;
    
    // Сбрасываем множители
    this._streamMaxMultiplier = 1.0;
    this._reasoningMaxMultiplier = 1.0;
    
    // Сбрасываем флаги завершённости
    this._streamFinished = false;
    this._reasoningFinished = false;
    
    // Сбрасываем флага финализации (КРИТИЧЕСКИ ВАЖНО для корректной работы второго запуска)
    this._finalizeStreamProcessed = false;
    this._reasoningFinalized = false;
    
    // === КОНЕЦ СБРОСА АНИМАЦИИ ===

    // Сбрасываем историю чата и ответы
    this.chatHistory = [];
    this.currentResponse = '';
    this.currentReasoning = '';
    this.currentImageAnalysis = '';
    this.currentImageReasoning = '';

    // Сбрасываем состояние автоскролла
    this._resetAutoScroll();

    // Сбрасываем счётчики чанков
    this.streamChunkCount = 0;
    this.imageAnalysisChunkCount = 0;
    this.reasoningChunkCount = 0;
    this.imageReasoningChunkCount = 0;

    // Сбрасываем кэш страницы
    this.cachedPageContent = null;
    this.cachedPageUrl = '';

    // Сбрасываем метрики стриминга
    this._streamStartTime = 0;
    this._lastChunkTime = 0;
    this._totalTokens = 0;
    this._streamCompleteProcessed = false;
    // НЕ обнуляем _streamFinished — уже сделано выше

    // Сбрасываем состояние стриминга
    this.isReasoningStreaming = false;
    this.reasoningExpanded = false;
    this.isImageAnalysisActive = false;
    this.stopImageAnalysisCheck();

    // Сбрасываем storage (ТОЛЬКО runtime-ключи, настройки НЕ трогаем)
    chrome.storage.local.set({
      streamContent: '',
      streamImageContent: '',
      streamIsComplete: false,
      streamImageComplete: false,
      streamError: null,
      streamImageError: null,
      streamProgress: 0,
      streamProgressText: '',
      imageAnalysisActive: false,
      imageAnalysisType: ''
    });

    // Очищаем UI
    if (this.chatMessages) this.chatMessages.innerHTML = '';
    this.showPlaceholder();
    this.hideGenerationStats();
    this.hideErrorBanner();
    if (this.reasoningContainer) this.reasoningContainer.classList.add('hidden');
    if (this.progressContainer) {
      if (this.progressText) {
        this.progressText.classList.remove('thinking');
      }
      this.progressContainer.classList.remove('analysis-cancelled');
      this.progressContainer.classList.add('hidden');
    }

    this.log('Контекст расширения очищен', 'info');
  }

  /**
   * Извлекает текст из HTML-элемента с сохранением форматирования:
   * переносов строк, отступов абзацев, списков и т.д.
   *
   * @param {HTMLElement} element — DOM-элемент
   * @returns {string} отформатированный текст
   */
  extractFormattedText(element) {
    if (!element) return '';

    const parts = [];

    /**
     * Рекурсивно обходит узлы и извлекает текст с форматированием.
     * @param {Node} node
     */
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Текстовый узел — берём как есть (сохраняет пробелы и табы)
        parts.push(node.textContent);
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();

      // Блочные элементы — добавляем переносы
      const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                         'ul', 'ol', 'pre', 'blockquote', 'table', 'hr'];

      if (tag === 'br') {
        parts.push('\n');
      } else if (tag === 'hr') {
        parts.push('\n\n---\n\n');
      } else if (tag === 'li') {
        parts.push('\n• ');
        for (const child of node.childNodes) {
          walk(child);
        }
      } else if (tag === 'pre') {
        // Блоки кода — текст как есть, с сохранением всех отступов
        parts.push('\n\n');
        const codeEl = node.querySelector('code');
        if (codeEl) {
          parts.push(codeEl.textContent);
        } else {
          parts.push(node.textContent);
        }
        parts.push('\n\n');
      } else if (tag === 'blockquote') {
        parts.push('\n');
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            parts.push('> ' + child.textContent);
          } else {
            walk(child);
          }
        }
        parts.push('\n');
      } else if (tag === 'table') {
        // Простое текстовое представление таблицы
        parts.push('\n');
        for (const row of node.querySelectorAll('tr')) {
          const cells = [];
          for (const cell of row.querySelectorAll('th, td')) {
            cells.push(cell.textContent.trim());
          }
          parts.push(cells.join(' | ') + '\n');
        }
        parts.push('\n');
      } else if (blockTags.includes(tag)) {
        parts.push('\n\n');
        for (const child of node.childNodes) {
          walk(child);
        }
        parts.push('\n\n');
      } else {
        // Inline элементы — просто обходим детей
        for (const child of node.childNodes) {
          walk(child);
        }
      }
    }

    walk(element);

    // Убираем множественные пустые строки, но сохраняем двойные для абзацев
    return parts.join('').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  /**
   * Copy the last AI response to clipboard.
   * Копирует текст с сохранением переносов строк, отступов и форматирования.
   * @returns {Promise<boolean>} true при успехе, false при ошибке
   */
  async copyResult() {
    const lastMsg = this.chatMessages?.querySelector('.chat-message.assistant:last-child .message-bubble');

    let text = '';
    if (lastMsg) {
      // Извлекаем текст с сохранением форматирования
      text = this.extractFormattedText(lastMsg);
    } else if (this._streamBuffer) {
      // Fallback: используем сырой буфер стриминга
      text = this._streamBuffer.trim();
    }

    if (!text) {
      this.log('Нечего копировать', 'warning');
      return false;
    }

    try {
      await navigator.clipboard.writeText(text);
      this.log('Скопировано в буфер обмена (с форматированием)', 'success');
      return true;
    } catch (error) {
      this.log(`Ошибка копирования: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Clear the chat history and reset UI.
   */
  clearChat() {
    this.resetChat();
  }

  /**
   * Show the placeholder, hide chat elements.
   */
  showPlaceholder() {
    if (this.chatHistoryEl) this.chatHistoryEl.style.display = 'none';
    if (this.placeholder) this.placeholder.style.display = 'flex';
  }

  /* ====================================================================== */
  /* DESTROY AND CLEANUP                                                    */
  /* ====================================================================== */

  /**
   * Полная очистка ресурсов и уничтожение экземпляра.
   * Вызывается при beforeunload для предотвращения утечек памяти.
   */
  destroy() {
    this.log('=== Initializing destroy process ===', 'info');

    // Отключаем context checks
    this.isImageAnalysisActive = false;
    this.isStreaming = false;

    // Останавливаем все таймеры мониторинга стрима
    if (this._stallCheckTimerId) {
      clearInterval(this._stallCheckTimerId);
      this._stallCheckTimerId = null;
      this.log('Destroyed stallCheckTimerId', 'debug');
    }
    if (this._imageAnalysisCheckTimerId) {
      clearInterval(this._imageAnalysisCheckTimerId);
      this._imageAnalysisCheckTimerId = null;
      this.log('Destroyed imageAnalysisCheckTimerId', 'debug');
    }
    if (this._waitingUpdateTimer) {
      clearInterval(this._waitingUpdateTimer);
      this._waitingUpdateTimer = null;
      this.log('Destroyed waitingUpdateTimer', 'debug');
    }

    // Останавливаем таймеры анимации
    if (this._reasoningTimerId) {
      clearTimeout(this._reasoningTimerId);
      this._reasoningTimerId = null;
      this.log('Destroyed reasoningTimerId', 'debug');
    }
    if (this._streamTimerId) {
      clearTimeout(this._streamTimerId);
      this._streamTimerId = null;
      this.log('Destroyed streamTimerId', 'debug');
    }

    // Сбрасываем abort controller
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.log('Aborted abortController', 'debug');
    }

    // Сбрасываем и очищаем requestAnimationFrame ID (если не были отменены)
    if (this._streamAnimationFrameId) {
      cancelAnimationFrame(this._streamAnimationFrameId);
      this._streamAnimationFrameId = null;
      this.log('Cancelled stream animation frame', 'debug');
    }
    if (this._reasoningAnimationFrameId) {
      cancelAnimationFrame(this._reasoningAnimationFrameId);
      this._reasoningAnimationFrameId = null;
      this.log('Cancelled reasoning animation frame', 'debug');
    }

    // Сбрасываем анимационные состояния
    this._resetStreamAnimation();

    // Останавливаем чанк мониторинг
    this.stopImageAnalysisCheck();
    this.stopStreamMonitoring();

    this.log('=== SidebarApp destroy complete ===', 'success');
  }
}

/* ========================================================================= */
/* INITIALIZATION                                                           */
/* ========================================================================= */

const app = new SidebarApp();

/**
 * Обработчик уничтожения sidebar — вызывает метод destroy экземпляра.
 * Предотвращает утечку памяти при закрытии панели.
 */
window.addEventListener('beforeunload', () => {
  if (app && typeof app.destroy === 'function') {
    app.destroy();
  }
});

/* ========================================================================= */
/* SAFE RUNTIME CHECK HELPER                                                */
/* ========================================================================= */

