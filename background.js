/**
 * background.js — Background Service Worker расширения Prompt
 *
 * НАЗНАЧЕНИЕ:
 * - Обработка сообщений от sidebar и content script
 * - Потоковая отправка запросов к OpenAI-совместимым API
 * - Управление контекстным меню для изображений
 * - Перевод/анализ изображений с CORS fallback
 * - Классификация и retry ошибок API
 *
 * АРХИТЕКТУРА:
 * Sidebar (UI) ←→ Background (логика + API) ←→ Content Script (извлечение контента)
 *
 * Важные принципы:
 * - API ключ НИКОГДА не передаётся в content script (безопасность)
 * - Каждый запрос фиксирует tabId активной вкладки на момент отправки
 * - Streaming ответа отправляется в sidebar через chrome.storage + runtime messages
 */

// Подключаем централизованные настройки
importScripts('config.js');

const LOG_PREFIX = DEFAULTS.LOG_PREFIX_BG;

// ============================================================================
// ЦЕНТРАЛИЗОВАННАЯ СИСТЕМА ЛОГИРОВАНИЯ
// ============================================================================

/**
 * Уровни логирования
 * @type {Object}
 */
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

/**
 * Текущий уровень логирования
 */
let currentLogLevel = LOG_LEVELS[DEFAULTS.LOG_LEVEL] ?? LOG_LEVELS.INFO;

/**
 * Центральный метод логирования
 * @param {string} level - уровень логирования ('DEBUG', 'INFO', 'WARN', 'ERROR')
 * @param  {...any} args - аргументы для вывода
 */
function log(level, ...args) {
  const levelVal = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
  if (levelVal >= currentLogLevel) {
    console.log(LOG_PREFIX, `[${level}]`, ...args);
  }
}

/**
 * Логирование DEBUG сообщений
 * @param  {...any} args - аргументы для вывода
 */
function logDebug(...args) {
  log('DEBUG', ...args);
}

/**
 * Логирование INFO сообщений
 * @param  {...any} args - аргументы для вывода
 */
function logInfo(...args) {
  log('INFO', ...args);
}

/**
 * Логирование WARN сообщений
 * @param  {...any} args - аргументы для вывода
 */
function logWarn(...args) {
  log('WARN', ...args);
}

/**
 * Логирование ошибок ERROR
 * @param  {...any} args - аргументы для вывода
 */
function logError(...args) {
  log('ERROR', ...args);
}

// ============================================================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ============================================================================

/**
 * Состояние текущего streaming ответа для анализа страницы.
 * Используется для отслеживания прогресса и отмены.
 */
let currentResponse = {
  content: '',
  isComplete: false,
  error: null
};

/**
 * Состояние текущего анализа изображения.
 */
let currentImageAnalysis = {
  imageUrl: '',
  isProcessing: false,
  error: null,
  analysisType: 'prompt'
};


/**
 * AbortController'ы для разных типов запросов.
 * Разделение предотвращает race condition — отмена одного типа
 * не влияет на другие (page vs chat vs image).
 */
let currentAbortControllers = {
  page: null,    /** @type {AbortController|null} — анализ страницы */
  chat: null,    /** @type {AbortController|null} — пользовательский чат */
  image: null    /** @type {AbortController|null} — анализ изображения */
};

/**
 * Сохраняет параметры последнего запроса для автоматического retry.
 * Если сервер оборвёт стриминг — запрос будет повторён с теми же данными.
 */
let lastRequestState = {
  type: null,       /** @type {'page'|'chat'|'image'|null} — тип запроса */
  request: null,    /** @type {Object|null} — исходный запрос (message) */
  retryCount: 0     /** @type {number} — кол-во попыток retry */
};

/** Сохраняет lastRequestState в storage для восстановления после перезапуска SW */
async function saveLastRequestState() {
  try {
    await chrome.storage.local.set({
      _lastRequestState: lastRequestState.type ? {
        type: lastRequestState.type,
        request: lastRequestState.request,
        retryCount: lastRequestState.retryCount
      } : null
    });
  } catch (e) {
    // Не критично
  }
}

/** Максимальное кол-во автоматических retry при обрыве стрима */
const MAX_STREAM_RETRY = 2;

  /**
   * Отслеживание состояния генерации на сервере.
   * Предотвращает отправку новых запросов пока сервер обрабатывает предыдущий.
   */
  let serverGenerationState = {
    isGenerating: false,     /** @type {boolean} — идёт ли сейчас генерация на сервере */
    startedAt: null,         /** @type {number|null} — timestamp начала генерации */
    lastDataAt: null,        /** @type {number|null} — timestamp последних полученных данных */
    requestType: null,       /** @type {'page'|'chat'|'image'|null} — тип текущего запроса */
    completedNormally: false,/** @type {boolean} — стрим завершился штатно (не stall) */
    stallTimeoutMs: DEFAULTS.STALL_TIMEOUT_MS,   /** @type {number} — порог staleness (3мин) */
    maxStallRetries: DEFAULTS.MAX_STALL_RETRIES /** @type {number} — макс. кол-во stall retry */
  };

/**
 * Сохраняет состояние генерации в storage для восстановления после перезапуска SW.
 */
async function saveGenerationState() {
  try {
    await chrome.storage.local.set({
      _generationState: {
        isGenerating: serverGenerationState.isGenerating,
        startedAt: serverGenerationState.startedAt,
        lastDataAt: serverGenerationState.lastDataAt,
        requestType: serverGenerationState.requestType,
        completedNormally: serverGenerationState.completedNormally
      }
    });
  } catch (e) {
    // Игнорируем ошибки storage — не критично
  }
}

/**
 * Восстанавливает состояние генерации из storage.
 * Вызывается при старте service worker.
 * Если обнаруживается что генерация была активна но SW перезапущен — запускается recovery.
 */
async function restoreGenerationState() {
  try {
    const result = await chrome.storage.local.get(['_generationState', '_lastRequestState']);
    if (result._generationState) {
      const saved = result._generationState;
      logInfo(`[GEN-STATE] Восстановление из storage: isGenerating=${saved.isGenerating}, requestType=${saved.requestType}`);

      // Восстанавливаем lastRequestState если есть
      if (result._lastRequestState) {
        lastRequestState = result._lastRequestState;
        logInfo(`[GEN-STATE] Восстановлен lastRequestState: type=${lastRequestState.type}`);
      }

      if (saved.isGenerating && !saved.completedNormally) {
        // Генерация была активна но не завершилась штатно — SW перезапущен
        logInfo(`[GEN-STATE] ⚠️ Обнаружен перезапущенный SW во время генерации! Запускаю recovery...`);

        // Восстанавливаем состояние
        serverGenerationState.isGenerating = saved.isGenerating;
        serverGenerationState.startedAt = saved.startedAt;
        serverGenerationState.lastDataAt = saved.lastDataAt;
        serverGenerationState.requestType = saved.requestType;
        serverGenerationState.completedNormally = saved.completedNormally;

        // Создаём новый AbortController для восстанавливаемого запроса
        const type = saved.requestType;
        const controller = new AbortController();
        if (type && currentAbortControllers[type] !== controller) {
          currentAbortControllers[type] = controller;
        }

        // Запускаем stall detection — если сервер замолчал, retry сработает
        startStallDetection(controller);

        // Если lastDataAt старый — сразу триггерим проверку
        if (saved.lastDataAt && Date.now() - saved.lastDataAt > serverGenerationState.stallTimeoutMs) {
          logInfo(`[GEN-STATE] 🚨 Данные устарели (${Date.now() - saved.lastDataAt}мс), запускаю retry...`);
          retryLastRequestDueToStall(null).catch(err => {
            logError(`[GEN-STATE] ❌ Recovery не удался:`, err.message);
          });
        }
      } else {
        logInfo(`[GEN-STATE] Состояние неактивно или завершено штатно, восстановление не требуется`);
      }

      // Очищаем сохранённое состояние
      await chrome.storage.local.remove(['_generationState', '_lastRequestState']);
    }
  } catch (e) {
    logError(`[GEN-STATE] Ошибка восстановления: ${e.message}`);
  }
}

/**
 * Очередь ожидающих запросов.
 * Если генерация уже идёт — запросы не ставятся в очередь, а тихо отменяются.
 * Но последний запрос сохраняется для повторной отправки если сервер замолчал.
 */
let pendingRequest = {
  type: null,       /** @type {'page'|'chat'|'image'|null} */
  request: null,    /** @type {Object|null} */
  sendResponse: null /** @type {Function|null} */
};

/**
 * Устаревшая ссылка для обратной совместимости (storage reset).
 * @deprecated Используйте currentAbortControllers
 */
let currentAbortController = null;

// ============================================================================
// ОБРАБОТКА УСТАНОВКИ РАСШИРЕНИЯ
// ============================================================================

// Восстанавливаем состояние генерации при старте service worker
restoreGenerationState().catch(e => logError(`[INIT] Ошибка восстановления: ${e.message}`));

/**
 * Обработчик установки/обновления расширения.
 * Создаёт контекстное меню и инициализирует настройки по умолчанию.
 */
chrome.runtime.onInstalled.addListener((details) => {
  logInfo(`[INIT] Extension installed: ${details.reason}`);

  // Создаём пункты контекстного меню для обработки изображений
  chrome.contextMenus.create({
    id: 'analyzeImagePrompt',
    title: '🖼️ Получить промт изображения',
    contexts: ['image']
  });

  chrome.contextMenus.create({
    id: 'analyzeImageTranslation',
    title: '🔤 Перевод текста с изображения',
    contexts: ['image']
  });

  logInfo('[INIT] Контекстное меню создано: "🖼️ Получить промт изображения" и "🔤 Перевод текста с изображения"');

  // Включаем side panel
  chrome.sidePanel.setOptions({ enabled: true });
  logInfo('[INIT] Side panel включён');

  // Инициализируем настройки по умолчанию если ещё не сохранены
  chrome.storage.local.get(['serverPresets'], (result) => {
    if (!result.serverPresets) {
      chrome.storage.local.set({
        serverPresets: DEFAULTS.SERVER_PRESETS,
        apiKey: DEFAULTS.API_KEY,
        model: DEFAULTS.MODEL,
        systemPrompt: DEFAULTS.SYSTEM_PROMPT,
        imageSystemPrompt: DEFAULTS.IMAGE_SYSTEM_PROMPT
      });
      logInfo('[INIT] Настройки по умолчанию сохранены');
    } else {
      logInfo(`[INIT] Настройки уже существуют, presets: ${result.serverPresets.length}`);
    }
  });
});

// ============================================================================
// КОНТЕКСТНОЕ МЕНЮ ИЗОБРАЖЕНИЙ
// ============================================================================

/**
 * Обработчик клика по контекстному меню изображений.
 * Запускает анализ изображения с соответствующим промптом.
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'analyzeImagePrompt') {
    logInfo(`[IMAGE] Клик: 🖼️ Получить промт изображения, URL: ${info.srcUrl}`);
    await handleImageMenuClick(info, tab, 'prompt');
  } else if (info.menuItemId === 'analyzeImageTranslation') {
    logInfo(`[IMAGE] Клик: 🔤 Перевод текста с изображения, URL: ${info.srcUrl}`);
    await handleImageMenuClick(info, tab, 'translation');
  }
});

/**
 * Обрабатывает клик по пункту меню анализа изображения.
 *
 * @param {Object} info - информация о клике
 * @param {Object} tab - вкладка
 * @param {string} analysisType - тип анализа: 'prompt' или 'translation'
 */
async function handleImageMenuClick(info, tab, analysisType) {
  // Проверяем, идёт ли уже генерация на сервере
  if (serverGenerationState.isGenerating) {
    logWarn(`[IMAGE] ⚠️ СЕРВЕР УЖЕ ГЕНЕРИРУЕТ (${serverGenerationState.requestType}). Новый запрос анализа изображения ОТМЕНЁН тихо.`);
    return;
  }

  // Открываем sidebar
  chrome.sidePanel.open({ windowId: tab.windowId });
  logInfo(`[IMAGE] Sidebar открыт для tab ${tab.id}`);

  // Пробуем получить полную ссылку через content script
  let fullSizeUrl = info.srcUrl;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'getFullSizeImageUrl',
      thumbnailUrl: info.srcUrl
    });

    if (response?.success && response.fullSizeUrl) {
      fullSizeUrl = response.fullSizeUrl;
      logInfo(`[IMAGE] Получена полная ссылка: ${fullSizeUrl}`);
    }
  } catch (error) {
    logError(`[IMAGE] Не удалось получить полную ссылку через content script: ${error.message}`);
  }

  // Запускаем анализ изображения с соответствующим типом
  analyzeImage({
    fullSizeUrl: fullSizeUrl,
    base64Image: null,
    analysisType: analysisType
  }).catch(error => {
    logError(`[IMAGE] Ошибка анализа изображения:`, error);
  });
}

// ============================================================================
// ОБРАБОТКА СООБЩЕНИЙ
// ============================================================================

/**
 * Главный обработчик всех сообщений от sidebar и content script.
 *
 * @param {Object} message - входящее сообщение
 * @param {Object} sender - отправитель
 * @param {Function} sendResponse - функция ответа
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `tab:${sender.tab.id}` : 'extension';
  const action = message.action || message.type;
  
  // Проверка безопасности: проверяем отправителя
  // Разрешаем сообщения только от расширения
  if (sender.id !== chrome.runtime.id && sender.id !== 'extension') {
    logError(`[SECURITY] ⛔ Отклонено сообщение от неизвестного отправителя: ${sender.id}`);
    sendResponse({ success: false, error: 'Unauthorized sender' });
    return false;
  }
  
  logInfo(`[MSG] ← ${action} от: ${senderInfo}`);

  // --- Запрос настроек ---
  if (message.action === 'getSettings') {
    logInfo(`[MSG] Запрос настроек`);
    chrome.storage.local.get([
      'serverPresets', 'apiKey', 'model',
      'systemPrompt', 'imageSystemPrompt', 'imageTranslationPrompt'
    ], (result) => {
      logInfo(`[MSG] Настройки отправлены, presets: ${result.serverPresets?.length || 0}`);
      sendResponse(result);
    });
    return true; // асинхронный ответ
  }

  // --- Запрос анализа страницы (поток) ---
  if (message.action === 'streamPageAnalysis') {
    logInfo(`[MSG] → streamPageAnalysis, tabId: ${message.tabId}`);
    logInfo(`[MSG] Query длина: ${message.query?.length || 0}`);

    // Проверяем, идёт ли уже генерация на сервере
    if (serverGenerationState.isGenerating) {
      logWarn(`[MSG] ⚠️ СЕРВЕР УЖЕ ГЕНЕРИРУЕТ (${serverGenerationState.requestType}), ${Date.now() - serverGenerationState.startedAt}мс назад). Новый запрос анализа страницы ОТМЕНЁН тихо.`);
      sendResponse({ success: false, error: 'server_busy', reason: 'generation_in_progress' });
      return true;
    }

    // Отменяем предыдущий запрос ТОЛЬКО этого типа (page)
    if (currentAbortControllers.page) {
      currentAbortControllers.page.abort();
      logInfo(`[MSG] ⚠️ Предыдущий запрос анализа страницы отменён`);
    }

    // Сбрасываем состояние
    currentResponse = { content: '', isComplete: false, error: null };
    currentAbortControllers.page = new AbortController();

    // Сохраняем для возможного retry
    const isRetry = !!lastRequestState.type && lastRequestState.type === 'page';
    const savedRetryCount = isRetry ? lastRequestState.retryCount : 0;
    lastRequestState = { type: 'page', request: message, retryCount: savedRetryCount };
    saveLastRequestState();

    // Запускаем анализ
    streamPageAnalysis(message, currentAbortControllers.page.signal)
      .then(() => {
        logInfo(`[MSG] → streamPageAnalysis завершён успешно`);
        sendResponse({ success: true });
      })
      .catch(error => {
        if (error.name === 'AbortError') {
          logInfo(`[MSG] → Запрос отменён пользователем`);
          sendResponse({ success: false, error: 'aborted' });
        } else {
          logError(`[MSG] → streamPageAnalysis ошибка:`, error.message);
          sendResponse({ success: false, error: error.message });
        }
      });
    return true;
  }

  // --- Запрос пользовательского чата (поток) ---
  if (message.action === 'streamChatQuery') {
    logInfo(`[MSG] → streamChatQuery, tabId: ${message.tabId}`);
    logInfo(`[MSG] Query: "${message.query?.substring(0, 50)}..."`);
    logInfo(`[MSG] ChatHistory: ${message.chatHistory?.length || 0} сообщений`);
    logInfo(`[MSG] PageContent: ${typeof message.pageContent === 'string' ? message.pageContent.length + ' символов' : 'объект'}`);

    // Проверяем, идёт ли уже генерация на сервере
    if (serverGenerationState.isGenerating) {
      logWarn(`[MSG] ⚠️ СЕРВЕР УЖЕ ГЕНЕРИРУЕТ (${serverGenerationState.requestType}, началось ${Date.now() - serverGenerationState.startedAt}мс назад). Новый запрос чата ОТМЕНЁН тихо.`);
      sendResponse({ success: false, error: 'server_busy', reason: 'generation_in_progress' });
      return true;
    }

    // Отменяем предыдущий запрос ТОЛЬКО этого типа (chat)
    if (currentAbortControllers.chat) {
      currentAbortControllers.chat.abort();
      logInfo(`[MSG] ⚠️ Предыдущий запрос чата отменён`);
    }

    // Сбрасываем состояние
    currentResponse = { content: '', isComplete: false, error: null };
    currentAbortControllers.chat = new AbortController();

    // Сохраняем для возможного retry
    const isRetry = !!lastRequestState.type && lastRequestState.type === 'chat';
    const savedRetryCount = isRetry ? lastRequestState.retryCount : 0;
    lastRequestState = { type: 'chat', request: message, retryCount: savedRetryCount };
    saveLastRequestState();

    streamChatQuery(message, currentAbortControllers.chat.signal)
      .then(() => {
        logInfo(`[MSG] → streamChatQuery завершён успешно`);
        sendResponse({ success: true });
      })
      .catch(error => {
        if (error.name === 'AbortError') {
          logInfo(`[MSG] → Запрос отменён пользователем`);
          sendResponse({ success: false, error: 'aborted' });
        } else {
          logError(`[MSG] → streamChatQuery ошибка:`, error.message);
          sendResponse({ success: false, error: error.message });
        }
      });
    return true;
  }

  // --- Аборт текущего streaming запроса (кнопка "Стоп") ---
  if (message.action === 'abortStream') {
    logInfo(`[MSG] → Abort всех запросов по команде пользователя`);
    // Отменяем ВСЕ активные запросы
    if (currentAbortControllers.page) { currentAbortControllers.page.abort(); currentAbortControllers.page = null; }
    if (currentAbortControllers.chat) { currentAbortControllers.chat.abort(); currentAbortControllers.chat = null; }
    if (currentAbortControllers.image) { currentAbortControllers.image.abort(); currentAbortControllers.image = null; }
    // Сбрасываем retry state — пользователь отменил явно
    lastRequestState = { type: null, request: null, retryCount: 0 };
    saveLastRequestState();
    // Сбрасываем generation state — пользователь явно остановил
    markGenerationAborted();
    currentResponse = { content: '', isComplete: false, error: null };
    sendResponse({ success: true });
    return true;
  }

  // --- Сброс состояния потока ---
  if (message.action === 'resetStreamState') {
    logInfo(`[MSG] → Сброс состояния потока`);
    // Отменяем ВСЕ активные запросы
    if (currentAbortControllers.page) { currentAbortControllers.page.abort(); currentAbortControllers.page = null; }
    if (currentAbortControllers.chat) { currentAbortControllers.chat.abort(); currentAbortControllers.chat = null; }
    if (currentAbortControllers.image) { currentAbortControllers.image.abort(); currentAbortControllers.image = null; }
    currentResponse = { content: '', isComplete: false, error: null };
    // Сбрасываем generation state — сброс не штатное завершение
    markGenerationAborted();
    sendResponse({ success: true });
    return true;
  }

  // --- Открытие sidebar ---
  if (message.action === 'openSidebar') {
    logInfo(`[MSG] → Открытие sidebar, windowId: ${sender.tab?.windowId}`);
    chrome.sidePanel.open({ windowId: sender.tab.windowId });
    sendResponse({ success: true });
    return true;
  }

  // --- Анализ изображения (от sidebar) ---
  if (message.action === 'analyzeImage') {
    const analysisType = message.analysisType || 'prompt';
    logInfo(`[MSG] → Запрос анализа изображения: ${message.imageData?.fullSizeUrl}, тип: ${analysisType}`);

    // Проверяем, идёт ли уже генерация на сервере
    if (serverGenerationState.isGenerating) {
      logWarn(`[MSG] ⚠️ СЕРВЕР УЖЕ ГЕНЕРИРУЕТ (${serverGenerationState.requestType}, началось ${Date.now() - serverGenerationState.startedAt}мс назад). Новый запрос анализа изображения ОТМЕНЁН тихо.`);
      sendResponse({ success: false, error: 'server_busy', reason: 'generation_in_progress' });
      return true;
    }

    // Отменяем предыдущий анализ изображения
    if (currentAbortControllers.image) {
      currentAbortControllers.image.abort();
      logInfo(`[MSG] ⚠️ Предыдущий анализ изображения отменён`);
    }
    currentAbortControllers.image = new AbortController();

    chrome.sidePanel.open({ windowId: sender.tab?.windowId });

    analyzeImage({
      ...message.imageData,
      analysisType: analysisType,
      signal: currentAbortControllers.image.signal
    })
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        logError(`[MSG] → Ошибка анализа изображения:`, error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  return false;
});

// ============================================================================
// АНАЛИЗ ВЕБ-СТРАНИЦЫ (STREAMING)
// ============================================================================

/**
 * Анализирует содержимое веб-страницы через AI API с потоковой передачей.
 *
 * АЛГОРИТМ:
 * 1. Извлекает контент с указанной вкладки через content script
 * 2. Находит первый доступный сервер среди пресетов
 * 3. Формирует запрос с systemPrompt + контентом страницы
 * 4. Отправляет в API с streaming=true
 * 5. Потоково обрабатывает ответ и отправляет в sidebar
 *
 * @param {Object} request - запрос от sidebar
 * @param {Object} request.settings - настройки (serverPresets, apiKey, model, systemPrompt)
 * @param {number} request.tabId - ID вкладки для извлечения контента
 * @param {string} request.tabUrl - URL вкладки (для информации)
 * @param {AbortSignal} signal - сигнал отмены запроса
 */
async function streamPageAnalysis(request, signal) {
  const { settings, tabId, tabUrl, pageContent: providedContent, resolvedModel } = request;
  const { serverPresets, apiKey, systemPrompt } = settings;

  // Используем resolvedModel если предоставлена, иначе fallback на settings.model
  const model = resolvedModel || settings.model || DEFAULTS.MODEL;
  const maxTokens = DEFAULTS.MAX_TOKENS;

  logInfo(`[PAGE] === streamPageAnalysis начало ===`);
  logInfo(`[PAGE] TabId: ${tabId}, URL: ${tabUrl}`);
  logInfo(`[PAGE] Модель: ${model}${resolvedModel ? ' (автоопределена)' : ' (из настроек)'}, MaxTokens: ${maxTokens}`);
  logInfo(`[PAGE] ServerPresets: ${serverPresets?.length || 0}`);
  logInfo(`[PAGE] ProvidedContent длина: ${typeof providedContent === 'string' ? providedContent.length : 'объект'}`);

  // Шаг 1: Используем контент из sidebar (уже извлечён)
  await saveToStorage({ streamProgress: 5, streamProgressText: 'Извлечение контента страницы...' });

  const contentText = typeof providedContent === 'string' ? providedContent : (providedContent?.content || '');
  logInfo(`[PAGE] Контент получен из sidebar: ${contentText.length} символов`);

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Шаг 2: Находим сервер
  await saveToStorage({ streamProgress: 15, streamProgressText: 'Поиск доступного сервера...' });
  const selectedPreset = await findAvailableServer(serverPresets, apiKey);

  if (!selectedPreset) {
    logError(`[PAGE] ❌ Нет доступных серверов`);
    throw new Error('Нет доступных серверов. Проверьте настройки.');
  }
  logInfo(`[PAGE] ✅ Выбран сервер: ${selectedPreset.apiUrl}`);

  await saveToStorage({ streamProgress: 20, streamProgressText: `Сервер: ${selectedPreset.apiUrl}` });

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Шаг 3: Обрезка контента по токенам
  const maxChars = maxTokens * 4;
  const trimmedText = contentText.length > maxChars ? contentText.substring(0, maxChars) : contentText;
  const wasTrimmed = contentText.length > maxChars;
  
  logInfo(`[PAGE] Контент: ${trimmedText.length} символов (было ${contentText.length})${wasTrimmed ? ', обрезано' : ''}`);
  logInfo(`[PAGE] Оценка токенов контента: ~${Math.round(trimmedText.length / 4)}`);

  await saveToStorage({ streamProgress: 30, streamProgressText: `Контент: ~${Math.round(trimmedText.length / 4)} токенов` });

  // Шаг 4: Формируем messages
  let userMessage = `Проанализируй следующую веб-страницу:\n\nURL: ${tabUrl || 'неизвестно'}\n\nСодержимое:\n${trimmedText}`;

  const messages = [
    { role: 'system', content: systemPrompt || DEFAULTS.SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ];

  logInfo(`[PAGE] Сообщений сформировано: ${messages.length}`);

  await saveToStorage({ streamProgress: 40, streamProgressText: 'Отправка запроса...' });

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Шаг 5: Отправляем запрос с retry
  const apiUrl = selectedPreset.apiUrl.replace(/\/$/, '');
  const requestBody = {
    model: model || DEFAULTS.MODEL,
    messages: messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  };

  logInfo(`[PAGE] URL запроса: ${apiUrl}/chat/completions`);
  logInfo(`[PAGE] Модель: ${requestBody.model}, messages: ${requestBody.messages.length}, max_tokens: ${requestBody.max_tokens}`);

  // Генерация началась — запрос отправляется на сервер
  markGenerationStarted('page');
  startStallDetection(signal);

  try {
    const response = await fetchWithRetry(
      `${apiUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody)
      },
      signal
    );

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (!response.ok) {
      const errorText = await response.text();
      logError(`[PAGE] API вернул ошибку: status=${response.status}`);
      throw classifyApiError(errorText, response.status);
    }

    logInfo(`[PAGE] ✅ Ответ получен, начинаем streaming`);
    await saveToStorage({ streamProgress: 70, streamProgressText: 'Получение ответа...' });

    try {
      await processStreamResponse(response, signal);
      logInfo(`[PAGE] ✅ Streaming завершён успешно`);
      await saveToStorage({ streamProgress: 100, streamProgressText: 'Готово!' });
    } finally {
      stopStallDetection();
      markGenerationComplete();
    }

  } catch (error) {
    // При ошибке тоже сбрасываем состояние
    stopStallDetection();
    markGenerationAborted();

    if (error.name === 'AbortError') throw error;
    logError(`[PAGE] streamPageAnalysis ошибка:`, error);
    currentResponse.error = error.message;
    await saveToStorage({ streamError: error.message });
    throw error;
  }
}

// ============================================================================
// ПОЛЬЗОВАТЕЛЬСКИЙ ЧАТ (STREAMING)
// ============================================================================

/**
 * Обрабатывает запрос пользователя в чате.
 * Использует контент страницы, переданный sidebar'ом (sidebar уже извлёк).
 *
 * @param {Object} request - запрос от sidebar
 * @param {string} request.query - текст запроса пользователя
 * @param {Array}  request.chatHistory - история диалога [{role, content}]
 * @param {string} request.pageContent - уже извлечённый контент страницы (от sidebar)
 * @param {Object} request.settings - настройки
 * @param {string} request.tabUrl - URL вкладки (для информации)
 * @param {AbortSignal} signal - сигнал отмены
 */
async function streamChatQuery(request, signal) {
  const { query, chatHistory, pageContent, settings, tabUrl, resolvedModel } = request;
  const { serverPresets, apiKey, systemPrompt } = settings;

  // Используем resolvedModel если предоставлена, иначе fallback на settings.model
  const model = resolvedModel || settings.model || DEFAULTS.MODEL;
  const maxTokens = DEFAULTS.MAX_TOKENS;

  logInfo(`[CHAT] === streamChatQuery начало ===`);
  logInfo(`[CHAT] Query (первые 100 символов): "${query.substring(0, 100)}"`);
  logInfo(`[CHAT] TabUrl: ${tabUrl}`);
  logInfo(`[CHAT] ChatHistory сообщений: ${chatHistory?.length || 0}`);
  logInfo(`[CHAT] PageContent длина: ${typeof pageContent === 'string' ? pageContent.length : 'объект'}`);
  logInfo(`[CHAT] Модель: ${model}${resolvedModel ? ' (автоопределена)' : ' (из настроек)'}, MaxTokens: ${maxTokens}`);
  logInfo(`[CHAT] ServerPresets: ${serverPresets?.length || 0}`);

  // Контент уже извлечён sidebar'ом, используем его
  await saveToStorage({ streamProgress: 5, streamProgressText: 'Извлечение контента...' });

  // pageContent — это строка с текстом, форматируем для API
  const formattedContent = typeof pageContent === 'string' ? pageContent : (pageContent?.content || '');
  logInfo(`[CHAT] Контент страницы после форматирования: ${formattedContent.length} символов`);

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Шаг 2: Находим сервер
  await saveToStorage({ streamProgress: 15, streamProgressText: 'Поиск сервера...' });

  const selectedPreset = await findAvailableServer(serverPresets, apiKey);

  if (!selectedPreset) {
    logError(`[CHAT] ❌ Нет доступных серверов`);
    throw new Error('Нет доступных серверов. Проверьте настройки.');
  }
  logInfo(`[CHAT] ✅ Выбран сервер: ${selectedPreset.apiUrl}`);

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Шаг 3: Формируем messages
  // chatHistory уже содержит все предыдущие сообщения + последнее сообщение пользователя
  // (добавлено в sidebar.js перед отправкой)
  const contextBlock = formattedContent.length > 0
    ? `--- Контекст страницы ---\nURL: ${tabUrl || 'неизвестно'}\n\n${formattedContent}`
    : '';
  logInfo(`[CHAT] ContextBlock длина: ${contextBlock.length} символов`);

  // Собираем сообщения: system + вся история чата
  let messages = [
    { role: 'system', content: systemPrompt || DEFAULTS.SYSTEM_PROMPT },
    ...chatHistory
  ];

  // Если есть контекст страницы — добавляем его к ПОСЛЕДНЕМУ сообщению пользователя
  // (не создаём новое сообщение, а дополняем существующее)
  if (contextBlock.length > 0 && messages.length > 1) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'user') {
      lastMsg.content = lastMsg.content + '\n\n' + contextBlock;
      logInfo(`[CHAT] Контекст страницы добавлен к последнему сообщению пользователя`);
    }
  }

  logInfo(`[CHAT] Всего сообщений до обрезки: ${messages.length}`);

  // Обрезаем только историю (не трогая последнее сообщение с контекстом)
  const trimmedMessages = trimChatHistoryToTokenLimit(messages, maxTokens);
  logInfo(`[CHAT] Сообщений после обрезки: ${trimmedMessages.length}`);

  const estimatedTokens = estimateTokens(trimmedMessages);
  logInfo(`[CHAT] Оценка токенов: ~${estimatedTokens}`);

  await saveToStorage({
    streamProgress: 30,
    streamProgressText: `Запрос: ~${estimatedTokens} токенов`
  });

  await saveToStorage({ streamProgress: 40, streamProgressText: 'Отправка запроса...' });

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  // Шаг 4: Отправляем запрос
  const apiUrl = selectedPreset.apiUrl.replace(/\/$/, '');
  const requestBody = {
    model: model || DEFAULTS.MODEL,
    messages: trimmedMessages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  };
  
  logInfo(`[CHAT] URL запроса: ${apiUrl}/chat/completions`);
  logInfo(`[CHAT] Модель: ${requestBody.model}, messages: ${requestBody.messages.length}, max_tokens: ${requestBody.max_tokens}`);

  // Генерация началась — запрос отправляется на сервер
  markGenerationStarted('chat');
  startStallDetection(signal);

  try {
    const response = await fetchWithRetry(
      `${apiUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      },
      signal
    );

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (!response.ok) {
      const errorText = await response.text();
      logError(`[CHAT] API вернул ошибку: status=${response.status}`);
      throw classifyApiError(errorText, response.status);
    }

    logInfo(`[CHAT] ✅ Ответ получен, начинаем streaming`);
    await saveToStorage({ streamProgress: 70, streamProgressText: 'Получение ответа...' });

    try {
      // Шаг 5: Streaming
      await processStreamResponse(response, signal);
      logInfo(`[CHAT] ✅ Streaming завершён успешно`);
      await saveToStorage({ streamProgress: 100, streamProgressText: 'Готово!' });
    } finally {
      stopStallDetection();
      markGenerationComplete();
    }

  } catch (error) {
    // При ошибке тоже сбрасываем состояние
    stopStallDetection();
    markGenerationAborted();

    if (error.name === 'AbortError') throw error;

    logError(`[CHAT] streamChatQuery ошибка:`, error);
    currentResponse.error = error.message;
    await saveToStorage({ streamError: error.message });
    throw error;
  }
}

// ============================================================================
// УПРАВЛЕНИЕ ТОКЕНАМИ В СООБЩЕНИЯХ
// ============================================================================

/**
 * Оценивает количество токенов в массиве сообщений.
 * Грубая оценка: 4 символа = 1 токен.
 *
 * @param {Array} messages - массив сообщений [{role, content}]
 * @returns {number} примерное кол-во токенов
 */
function estimateTokens(messages) {
  const totalChars = messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content :
      Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
    return sum + content.length;
  }, 0);
  return Math.round(totalChars / 4);
}

/**
 * Обрезает массив сообщений чтобы уложиться в лимит токенов.
 * Удаляет самые старые пары сообщений (user+assistant) при превышении.
 * System message и последнее сообщение никогда не удаляются.
 *
 * @param {Array} messages - исходные сообщения
 * @param {number} maxTokens - лимит токенов
 * @returns {Array} обрезанные сообщения
 */
function trimMessagesToTokenLimit(messages, maxTokens) {
  if (messages.length <= 2) return messages; // system + 1 сообщение — нечего обрезать

  const maxChars = maxTokens * 4;
  let result = [...messages];

  // Вычисляем текущий размер
  const getTotalChars = (msgs) => msgs.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : '';
    return sum + content.length;
  }, 0);

  // Удаляем самые старые пары (индексы 1,2 затем 3,4 и т.д.)
  // Индекс 0 = system — никогда не удаляем
  // Последнее сообщение — никогда не удаляем
  while (getTotalChars(result) > maxChars && result.length > 3) {
    // Удаляем первую пару после system message
    result.splice(1, 2);
    logInfo('История обрезана, осталось сообщений:', result.length);
  }

  return result;
}

/**
 * Обрезает историю чата, сохраняя system + последнее сообщение с контекстом.
 * Последнее сообщение (с контекстом страницы) НИКОГДА не удаляется и не обрезается.
 *
 * @param {Array} messages - сообщения: [system, ...chatHistory, finalUserWithContent]
 * @param {number} maxTokens - лимит токенов
 * @returns {Array} обрезанные сообщения
 */
function trimChatHistoryToTokenLimit(messages, maxTokens) {
  if (messages.length <= 2) return messages; // system + final — нечего обрезать

  const maxChars = maxTokens * 4;

  // System (0) и последнее сообщение — священны, не трогаем
  const systemMsg = messages[0];
  const finalMsg = messages[messages.length - 1];
  const history = messages.slice(1, -1); // только история

  // Если история пустая — ничего обрезать не нужно
  if (history.length === 0) return messages;

  // Вычисляем размер system + final (они всегда остаются)
  const getContentLength = (msg) => typeof msg.content === 'string' ? msg.content.length : 0;
  const fixedSize = getContentLength(systemMsg) + getContentLength(finalMsg);

  // Если даже system + final превышают лимит — оставляем как есть
  if (fixedSize > maxChars) {
    logInfo('System + контекст превышают лимит, возвращаем как есть');
    return [systemMsg, finalMsg];
  }

  // Доступный размер для истории
  const availableForHistory = maxChars - fixedSize;

  // Вычисляем текущий размер истории
  const historySize = history.reduce((sum, msg) => sum + getContentLength(msg), 0);

  // Если история вписывается — возвращаем всё
  if (historySize <= availableForHistory) return messages;

  // Обрезаем историю: удаляем самые старые пары (user+assistant)
  let trimmedHistory = [...history];
  while (trimmedHistory.length > 0) {
    const currentHistorySize = trimmedHistory.reduce((sum, msg) => sum + getContentLength(msg), 0);
    if (currentHistorySize <= availableForHistory) break;

    // Удаляем первую пару (user + assistant)
    if (trimmedHistory.length >= 2) {
      trimmedHistory.splice(0, 2);
    } else {
      // Осталось одно сообщение — удаляем его
      trimmedHistory.shift();
    }
    logInfo('История обрезана, осталось сообщений в истории:', trimmedHistory.length);
  }

  // Собираем обратно: system + обрезанная история + final
  return [systemMsg, ...trimmedHistory, finalMsg];
}

// ============================================================================
// УПРАВЛЕНИЕ СОСТОЯНИЕМ ГЕНЕРАЦИИ СЕРВЕРА
// ============================================================================

/**
 * Устанавливает флаг "сервер генерирует" при начале запроса.
 * Вызывается ПЕРЕД отправкой запроса на сервер.
 * @param {string} type - тип запроса: 'page', 'chat', 'image'
 */
function markGenerationStarted(type) {
  serverGenerationState.isGenerating = true;
  serverGenerationState.startedAt = Date.now();
  serverGenerationState.lastDataAt = Date.now(); // таймер stall с момента отправки
  serverGenerationState.requestType = type;
  serverGenerationState.completedNormally = false;
  logInfo(`[GEN-STATE] ▶️ Генерация началась (${type}), запрос отправляется на сервер`);
  saveGenerationState(); // сохраняем для восстановления
}

/**
 * Сбрасывает флаг "сервер генерирует" при штатном завершении.
 */
function markGenerationComplete() {
  const wasGenerating = serverGenerationState.isGenerating;
  const duration = serverGenerationState.startedAt ? Date.now() - serverGenerationState.startedAt : 0;
  serverGenerationState.isGenerating = false;
  serverGenerationState.startedAt = null;
  serverGenerationState.completedNormally = true; // штатное завершение
  serverGenerationState.requestType = null;
  logInfo(`[GEN-STATE] ⏹️ Генерация завершена штатно, длительность: ${duration}мс`);
  saveGenerationState();
}

/**
 * Сбрасывает флаг "сервер генерирует" при отмене/сбросе (не штатное завершение).
 * Не ставит completedNormally — stall detection может сработать.
 */
function markGenerationAborted() {
  serverGenerationState.isGenerating = false;
  serverGenerationState.startedAt = null;
  // completedNormally НЕ ставим — может быть stall
  serverGenerationState.requestType = null;
  logInfo(`[GEN-STATE] ⚠️ Генерация прервана/сброшена (не штатно)`);
  saveGenerationState();
}

/**
 * Обновляет timestamp последних полученных данных.
 * Вызывается при каждом полученном чанке.
 */
function markDataReceived() {
  serverGenerationState.lastDataAt = Date.now();
}

/**
 * Проверяет, не замолчал ли сервер (stall detection).
 * Сервер считается "замолчавшим" если:
 * - Запрос был отправлен (isGenerating === true)
 * - Штатно НЕ завершился (completedNormally === false)
 * - И при этом последние данные были получены > stallTimeoutMs назад
 * Это покрывает два сценария:
 * 1. Сервер не ответил вообще (fetch завис, нет данных с момента отправки)
 * 2. Сервер начал стрим но замолчал mid-response
 * @returns {boolean} true если stall обнаружен
 */
function isServerStalled() {
  // Если запрос не отправлен — нечего проверять
  if (!serverGenerationState.isGenerating) return false;
  // Если штатно завершился — не stall
  if (serverGenerationState.completedNormally) return false;
  // Если нет timestamp последних данных — нечего проверять
  if (!serverGenerationState.lastDataAt) return false;
  // Проверяем: давно не было данных
  const elapsed = Date.now() - serverGenerationState.lastDataAt;
  return elapsed > serverGenerationState.stallTimeoutMs;
}

/**
 * Запускает мониторинг stall для текущего запроса.
 * Если сервер замолчал — автоматически повторяет запрос.
 * @param {AbortController} controller - контроллер отмены для текущего запроса
 */
function startStallDetection(controller) {
  // Очищаем предыдущий таймер если есть
  stopStallDetection();

  // Сохраняем контроллер для использования в retry (с защитой от undefined)
  if (controller && controller.signal && !controller.signal.aborted) {
    const type = serverGenerationState.requestType;
    if (type && currentAbortControllers[type] !== controller) {
      currentAbortControllers[type] = controller;
    }
  }

  const checkInterval = 10000; // проверяем каждые 10 секунд

  serverGenerationState._stallCheckInterval = setInterval(() => {
    // Если сигнал отменён — останавливаем
    if (controller?.signal?.aborted) {
      logInfo(`[STALL] ⚠️ Сигнал отменён, останавливаю stall detection`);
      stopStallDetection();
      return;
    }

    // Если штатно завершился — останавливаем
    if (serverGenerationState.completedNormally) {
      logInfo(`[STALL] ⚠️ Генерация завершена штатно, останавливаю stall detection`);
      stopStallDetection();
      return;
    }

    // Проверяем stall
    if (isServerStalled()) {
      const stallDuration = Date.now() - serverGenerationState.lastDataAt;
      logInfo(`[STALL] 🚨 СЕРВЕР ЗАМОЛЧАЛ! Последние данные: ${stallDuration}мс назад (лимит: ${serverGenerationState.stallTimeoutMs}мс)`);

      // Останавливаем мониторинг чтобы не запускать retry дважды
      stopStallDetection();

      // Запускаем retry асинхронно, передавая контроллер
      retryLastRequestDueToStall(controller).catch(err => {
        logError(`[STALL] ❌ Retry после stall не удался:`, err.message);
      });
    }
  }, checkInterval);

  logInfo(`[STALL] 🔍 Stall detection запущен, проверка каждые ${checkInterval}мс, порог: ${serverGenerationState.stallTimeoutMs}мс`);
}

/**
 * Останавливает мониторинг stall.
 */
function stopStallDetection() {
  if (serverGenerationState._stallCheckInterval) {
    clearInterval(serverGenerationState._stallCheckInterval);
    serverGenerationState._stallCheckInterval = null;
    logInfo(`[STALL] 🔍 Stall detection остановлен`);
  }
}

async function retryLastRequestDueToStall(activeController) {
  if (!lastRequestState.type || !lastRequestState.request) {
    logWarn(`[STALL-RETRY] Нет сохранённого запроса для retry`);
    markGenerationComplete();
    return;
  }

  // Проверяем лимит retry
  if (lastRequestState.retryCount >= serverGenerationState.maxStallRetries) {
    logError(`[STALL-RETRY] ❌ Лимит retry исчерпан (${lastRequestState.retryCount}/${serverGenerationState.maxStallRetries})`);
    await sendMessageToSidebar({
      type: 'streamError',
      error: `Сервер перестал отвечать. Повторные попытки (${lastRequestState.retryCount}) не удались.`
    });
    markGenerationComplete();
    lastRequestState = { type: null, request: null, retryCount: 0 };
    return;
  }

  lastRequestState.retryCount++;
  const { type, request } = lastRequestState;

  logInfo(`[STALL-RETRY] 🔄 Сервер замолчал, повторяю запрос типа "${type}", попытка ${lastRequestState.retryCount}/${serverGenerationState.maxStallRetries}`);

  // Уведомляем sidebar о retry
  await sendMessageToSidebar({
    type: 'streamProgress',
    progress: 40,
    progressText: `Сервер не отвечает, повторяю запрос... (${lastRequestState.retryCount}/${serverGenerationState.maxStallRetries})`
  });

  // Отменяем текущий запрос через AbortController (если активен)
  const currentController = activeController || currentAbortControllers[type];
  if (currentController && !currentController.signal.aborted) {
    currentController.abort();
    logInfo(`[STALL-RETRY] ⚠️ Текущий запрос отменён из-за stall`);
  }

  // Небольшая задержка перед retry
  await sleep(DEFAULTS.RETRY_MIN_DELAY);

  // controller объявлен вне try блока — доступен в catch для рекурсивного retry
  let controller = null;

  try {
    // Сбрасываем generation state для нового запроса
    markGenerationAborted(); // старый запрос не завершился штатно

    // СОХРАНЯЕМ resolvedModel в retryRequest
    const retryRequest = { 
      ...request,
      resolvedModel: request.resolvedModel // сохраняем определённую модель
    };

    // Создаём новый AbortController для retry
    controller = new AbortController();
    currentAbortControllers[type] = controller;

    logInfo(`[STALL-RETRY] 🚀 Повторная отправка запроса...`);

    if (type === 'page') {
      await streamPageAnalysis(retryRequest, controller.signal);
    } else if (type === 'chat') {
      await streamChatQuery(retryRequest, controller.signal);
    } else if (type === 'image') {
      await analyzeImage({ ...retryRequest, signal: controller.signal });
    }

    logInfo(`[STALL-RETRY] ✅ Retry запроса "${type}" завершён успешно`);
    lastRequestState = { type: null, request: null, retryCount: 0 };
    saveLastRequestState();

  } catch (error) {
    if (error.name === 'AbortError') {
      logInfo(`[STALL-RETRY] ⚠️ Retry запроса отменён`);
      return;
    }
    logError(`[STALL-RETRY] ❌ Retry запроса "${type}" не удался:`, error.message);
    // Рекурсивный retry если ещё есть попытки
    await retryLastRequestDueToStall(controller);
  }
}

// ============================================================================
// ОБРАБОТКА STREAMING ОТВЕТА
// ============================================================================

/**
 * Обрабатывает streaming ответ от API.
 * Потоково читает SSE (Server-Sent Events) и отправляет chunks в sidebar.
 *
 * @param {Response} response - fetch Response с streaming телом
 * @param {AbortSignal} signal - сигнал отмены
 */
async function processStreamResponse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullResponse = '';
  let fullReasoning = '';
  let buffer = '';
  let chunkCount = 0;
  let contentCount = 0;
  let reasoningCount = 0;
  let totalBytes = 0;

  logInfo('[STREAM] === processStreamResponse начало ===');

  try {
    while (true) {
      // Проверяем отмену
      if (signal.aborted) {
        logInfo('[STREAM] ⚠️ Streaming отменён пользователем');
        throw new DOMException('Aborted', 'AbortError');
      }

      let chunkResult;
      try {
        chunkResult = await reader.read();
      } catch (readError) {
        // Обработка ошибок чтения не AbortError
        if (readError.name !== 'AbortError') {
          logError('[STREAM] ❌ Ошибка чтения reader:', readError);
          // Сервер оборвал стрим — пробуем retry
          const receivedSomeData = fullResponse.length > 0 || fullReasoning.length > 0;
          if (receivedSomeData) {
            logWarn(`[STREAM] ⚠️ Стрим оборван на середине (получено: ${fullResponse.length} символов)`);
            retryLastRequest(readError.message).catch(err => {
              logError('[STREAM] ❌ Retry не удался:', err.message);
            });
            return; // Выходим — retry обработит остальное
          }
          throw readError;
        }
        throw readError; // Пробрасываем AbortError
      }

      const { done, value } = chunkResult;

      if (done) {
        logInfo(`[STREAM] ✅ Streaming завершён`);
        logInfo(`[STREAM] Статистика:`);
        logInfo(`[STREAM]   - Всего чанков: ${chunkCount}`);
        logInfo(`[STREAM]   - Чанков с контентом: ${contentCount}`);
        logInfo(`[STREAM]   - Чанков с reasoning: ${reasoningCount}`);
        logInfo(`[STREAM]   - Всего байт: ${totalBytes}`);
        logInfo(`[STREAM]   - Длина ответа: ${fullResponse.length} символов`);
        logInfo(`[STREAM]   - Длина reasoning: ${fullReasoning.length} символов`);
        break;
      }

      chunkCount++;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      totalBytes += value.length;

      // Обновляем timestamp последних данных
      markDataReceived();

      if (chunkCount % 10 === 0) {
        logInfo(`[STREAM] Обработано чанков: ${chunkCount}, байт: ${totalBytes}`);
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('data: ')) {
          const dataStr = trimmedLine.slice(6);

          if (dataStr === '[DONE]') {
            logInfo('[STREAM] Получен маркер [DONE]');
            break;
          }

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0];
            const content = choice?.delta?.content || '';
            const reasoning = choice?.delta?.reasoning_content || '';

            // Обработка размышлений
            if (reasoning) {
              fullReasoning += reasoning;
              reasoningCount++;

              if (reasoningCount % 5 === 0) {
                logInfo(`[STREAM] Reasoning update #${reasoningCount}, длина: ${fullReasoning.length}`);
                await sendMessageToSidebar({ type: 'reasoningChunk', content: fullReasoning });
              }
            }

            // Обработка основного контента
            if (content) {
              contentCount++;
              fullResponse += content;

              if (contentCount % 5 === 0) {
                logInfo(`[STREAM] Content update #${contentCount}, длина: ${fullResponse.length}`);
                await sendMessageToSidebar({ type: 'streamChunk', content: fullResponse });
              }
            }
          } catch (e) {
            // Игнорируем ошибки парсинга отдельных чанков
            if (chunkCount <= 3) {
              logWarn(`[STREAM] ⚠️ Ошибка парсинга чанка:`, dataStr?.substring(0, 100));
            }
          }
        }
      }
    }
  } catch (readError) {
    if (readError.name === 'AbortError') throw readError;
    logError('[STREAM] ❌ processStreamResponse ошибка чтения:', readError);

    // Сервер оборвал стрим — пробуем retry
    const receivedSomeData = fullResponse.length > 0 || fullReasoning.length > 0;
    if (receivedSomeData) {
      logWarn(`[STREAM] ⚠️ Стрим оборван на середине (получено: ${fullResponse.length} символов)`);
      // Запускаем retry асинхронно — не блокируем текущий поток
      retryLastRequest(readError.message).catch(err => {
        logError('[STREAM] ❌ Retry не удался:', err.message);
      });
      return; // Выходим — retry обработит остальное
    }

    throw readError;
  }

  // Финальная обработка
  logInfo('[STREAM] === Финальная обработка ===');
  logInfo(`[STREAM] Длина ответа: ${fullResponse.length}, длина reasoning: ${fullReasoning.length}`);

  // Если content пустой но есть reasoning — используем reasoning
  let finalResponse = fullResponse;
  if (!fullResponse && fullReasoning) {
    logInfo('[STREAM] ⚠️ Ответ пустой, используем размышления как ответ');
    finalResponse = fullReasoning;
  }

  // Сохраняем и отправлем в sidebar
  await chrome.storage.local.set({
    streamContent: String(finalResponse),
    streamIsComplete: true,
    streamError: null
  });

  logInfo('[STREAM] ✅ Ответ сохранён в storage');
  await sendMessageToSidebar({ type: 'streamComplete', content: finalResponse });

  // Отправляем размышления если отличаются
  if (fullReasoning && fullReasoning !== finalResponse) {
    logInfo('[STREAM] Отправляем reasoning отдельно');
    await sendMessageToSidebar({ type: 'reasoningComplete', content: fullReasoning });
  }
  
  logInfo('[STREAM] === processStreamResponse завершён ===');
}

// ============================================================================
// КЛАССИФИКАЦИЯ И RETRY ОШИБОК API
// ============================================================================

/**
 * Классифицирует ошибку API для принятия решения о retry.
 *
 * @param {string} errorText - текст ошибки
 * @param {number} status - HTTP статус
 * @returns {Error} классифицированная ошибка
 */
function classifyApiError(errorText, status) {
  logError(`[ERROR] Классификация ошибки: status=${status}`);
  logError(`[ERROR] Текст ошибки (первые 200 символов):`, errorText?.substring(0, 200));

  if (status === 0) {
    logError(`[ERROR] → Network error (status 0)`);
    return new Error('❌ Нет подключения. Проверьте интернет и сервер.');
  }
  if (status === 401 || status === 403) {
    logError(`[ERROR] → Auth error (${status})`);
    return new Error(`❌ Ошибка авторизации (${status}). Проверьте API Key в настройках.`);
  }
  if (status === 404) {
    logError(`[ERROR] → Not found error (404)`);
    return new Error('❌ URL неверен. Убедитесь что адрес заканчивается на /v1 (например: http://localhost:1234/v1)');
  }
  if (status === 429) {
    logError(`[ERROR] → Rate limit error (429)`);
    return new Error('❌ Превышен лимит запросов. Подождите и попробуйте снова.');
  }
  if (status >= 500) {
    logError(`[ERROR] → Server error (${status})`);
    return new Error(`❌ Сервер недоступен (${status}). Повторная попытка...`);
  }
  logError(`[ERROR] → Client error (${status})`);
  return new Error(`API error: ${status} — ${errorText}`);
}

/**
 * Выполняет fetch запрос с автоматическим retry при recoverable ошибках.
 * Добавлен явный таймаут через Promise.race с setTimeout.
 *
 * АЛГОРИТМ:
 * - При network/server ошибах: до API_RETRY_MAX попыток с экспоненциальной задержкой
 * - При auth/rate-limit ошибках: без retry, сразу ошибка
 *
 * @param {string} url - URL запроса
 * @param {Object} options - fetch options
 * @param {AbortSignal} signal - сигнал отмены
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, signal) {
  let lastError = null;

  for (let attempt = 0; attempt <= DEFAULTS.API_RETRY_MAX; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // timeoutId должен быть в области видимости catch для корректной очистки
    let timeoutId = null;

    try {
      // Логируем детали запроса (без чувствительных данных)
      const method = options.method || 'GET';
      const headers = options.headers || {};
      const contentType = headers['Content-Type'] || 'не указан';
      const hasAuth = !!headers['Authorization'];
      const bodySize = options.body ? `${Math.round(options.body.length / 1024)}KB` : 'нет';
      
      logInfo(`[RETRY] Попытка ${attempt + 1}/${DEFAULTS.API_RETRY_MAX + 1} | ${method} ${url}`);
      logInfo(`[RETRY] Content-Type: ${contentType}, Auth: ${hasAuth ? 'да' : 'нет'}, Body: ${bodySize}`);
      logInfo(`[RETRY] Signal: aborted=${signal.aborted}`);
      
      // Добавляем явный таймаут с корректной очисткой
      const fetchPromiseWithTimeout = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timeout: запрос к ${url} занял больше ${DEFAULTS.FETCH_TIMEOUT_MS/1000} секунд`));
        }, DEFAULTS.FETCH_TIMEOUT_MS);
        
        fetch(url, options)
          .then(result => {
            clearTimeout(timeoutId);
            timeoutId = null;
            resolve(result);
          })
          .catch(err => {
            clearTimeout(timeoutId);
            timeoutId = null;
            reject(err);
          });
      });
      
      const response = await fetchPromiseWithTimeout;
      logInfo(`[RETRY] Ответ получен: status=${response.status}, ok=${response.ok}`);

      // Auth и rate-limit — не retry-им
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        logInfo(`[RETRY] ${response.status} — auth/rate-limit ошибка, без retry`);
        return response;
      }

      // Network error (status 0) — retry
      if (!response.ok && response.status === 0) {
        lastError = new Error(`Network error: ${response.status}`);
        if (attempt < DEFAULTS.API_RETRY_MAX) {
          const delay = DEFAULTS.API_RETRY_BASE_DELAY * Math.pow(2, attempt);
          logInfo(`[RETRY] Network error (status 0), следующая попытка через ${delay}мс`);
          await sleep(delay);
          continue;
        }
        logError(`[RETRY] Лимит retry исчерпан (network error)`);
        return response;
      }

      // Server error (5xx) — retry
      if (!response.ok && response.status >= 500) {
        lastError = new Error(`Server error: ${response.status}`);
        if (attempt < DEFAULTS.API_RETRY_MAX) {
          const delay = DEFAULTS.API_RETRY_BASE_DELAY * Math.pow(2, attempt);
          logInfo(`[RETRY] Server error (${response.status}), следующая попытка через ${delay}мс`);
          await sleep(delay);
          continue;
        }
        logError(`[RETRY] Лимит retry исчерпан (server error)`);
        return response;
      }

      // Успех или client error (4xx кроме 401/403/429)
      logInfo(`[RETRY] Запрос завершён: status=${response.status}`);
      return response;

    } catch (error) {
      if (error.name === 'AbortError') {
        if (timeoutId) clearTimeout(timeoutId);
        throw error;
      }
      if (timeoutId) clearTimeout(timeoutId);
      
      lastError = error;

      if (attempt < DEFAULTS.API_RETRY_MAX) {
        const delay = DEFAULTS.API_RETRY_BASE_DELAY * Math.pow(2, attempt);
        logInfo(`[RETRY] Исключение (${error.name}), следующая попытка через ${delay}мс: ${error.message}`);
        await sleep(delay);
        continue;
      }
      logError(`[RETRY] Лимит retry исчерпан, пробрасываем ошибку`);
      throw error;
    }
  }

  throw lastError || new Error('Неизвестная ошибка fetch');
}

/**
 * Задержка в миллисекундах
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// ПРОВЕРКА ДОСТУПНОСТИ СЕРВЕРА
// ============================================================================

/**
 * Проверяет доступность сервера через endpoint /models.
 * В MV3 service worker не может делать fetch к внешним URL из-за CSP,
 * поэтому проверяем только если URL локальный или используем probing через реальный запрос.
 *
 * @param {string} apiUrl - базовый URL API
 * @param {string} apiKey - API ключ
 * @returns {Promise<boolean>}
 */
async function checkServerAvailability(apiUrl, apiKey) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULTS.SERVER_CHECK_TIMEOUT_MS);

    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey || ''}` },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    logDebug(`[SERVER] checkServerAvailability ошибка (${apiUrl}): ${error.message}`);
    return false;
  }
}

/**
 * Находит первый доступный сервер среди включённых пресетов.
 * Перебирает пресеты по порядку, проверяя доступность через /models.
 *
 * @param {Array} serverPresets - список пресетов
 * @param {string} apiKey - API ключ
 * @returns {Object|null} первый доступный пресет или null
 */
async function findAvailableServer(serverPresets, apiKey) {
  const enabledPresets = (serverPresets || []).filter(p => p.enabled && p.apiUrl && p.apiUrl.trim());

  logInfo(`[SERVER] Поиск доступного сервера, включённых: ${enabledPresets.length}/${serverPresets?.length || 0}`);

  for (let i = 0; i < enabledPresets.length; i++) {
    const preset = enabledPresets[i];
    const originalIndex = serverPresets.indexOf(preset) + 1;
    const apiUrl = preset.apiUrl.replace(/\/$/, '');

    logInfo(`[SERVER] Пресет ${originalIndex}: проверяю ${apiUrl}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULTS.SERVER_CHECK_TIMEOUT_MS);

      const response = await fetch(`${apiUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey || ''}` },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        logInfo(`[SERVER] ✅ Пресет ${originalIndex} (${apiUrl}) доступен`);
        return preset;
      }

      logInfo(`[SERVER] Пресет ${originalIndex} (${apiUrl}) — status=${response.status}, пробую следующий`);
    } catch (error) {
      logInfo(`[SERVER] Пресет ${originalIndex} (${apiUrl}) — ошибка: ${error.message}, пробую следующий`);
      continue;
    }
  }

  logError(`[SERVER] ❌ Нет доступных серверов (${enabledPresets.length} включённых, все недоступны)`);
  return null;
}

// ============================================================================
// АНАЛИЗ ИЗОБРАЖЕНИЙ
// ============================================================================

/**
 * Анализирует изображение через AI API с соответствующим промптом.
 * Поддерживает CORS fallback: content script → background fetch.
 *
 * @param {Object} imageData - данные изображения
 * @param {string} imageData.fullSizeUrl - URL изображения
 * @param {string|null} imageData.base64Image - Base64 если уже загружен
 * @param {string} imageData.analysisType - тип анализа: 'prompt' или 'translation'
 */
async function analyzeImage(imageData) {
  const { fullSizeUrl, base64Image, analysisType = 'prompt', signal } = imageData;

  logInfo(`[IMAGE] === analyzeImage начало ===`);
  logInfo(`[IMAGE] URL: ${fullSizeUrl}`);
  logInfo(`[IMAGE] Base64 предоставлен: ${!!base64Image}`);
  logInfo(`[IMAGE] Тип анализа: ${analysisType}`);

  // Проверяем сигнал отмены
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Сохраняем запрос для возможного retry
  lastRequestState = { type: 'image', request: imageData, retryCount: 0 };
  saveLastRequestState();

  try {
    // Очищаем чат sidebar перед новым анализом
    await chrome.runtime.sendMessage({ action: 'resetChatForImageAnalysis' }).catch(() => {});

    // Инициализируем состояние
    currentImageAnalysis = {
      imageUrl: fullSizeUrl,
      isProcessing: true,
      error: null,
      analysisType: analysisType
    };

    await saveToStorage({
      streamProgress: 10,
      streamProgressText: 'Загрузка изображения...',
      streamImageContent: null,
      streamImageError: null,
      imageAnalysisActive: true,
      imageAnalysisType: analysisType
    });

    // Получаем настройки
    const settings = await getSettings();
    logInfo(`[IMAGE] Настройки получены, модель: ${settings.model}`);

    // Загружаем изображение в Base64 (с CORS fallback)
    let imageBase64 = base64Image;
    let tabId = null;
    
    // Получаем tabId заранее для использования в fallback методах
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]) {
        tabId = tabs[0].id;
        logInfo(`[IMAGE] Получен tabId: ${tabId}, URL: ${tabs[0].url}`);
      }
    } catch (error) {
      logError(`[IMAGE] Не удалось получить информацию о вкладке: ${error.message}`);
    }
    
    if (!imageBase64) {
      await saveToStorage({ streamProgress: 20, streamProgressText: 'Загрузка изображения...' });

      // Путь 1: через content script
      if (tabId) {
        try {
          logInfo(`[IMAGE] Пробуем загрузить через content script (tab ${tabId})`);
          const response = await chrome.tabs.sendMessage(tabId, {
            action: 'loadImageAsBase64',
            imageUrl: fullSizeUrl
          });

          if (response && response.success && response.base64Image) {
            imageBase64 = response.base64Image;
            logInfo(`[IMAGE] Base64 получен из content script, длина: ${imageBase64.length}`);
          } else {
            logInfo(`[IMAGE] Content script не вернул base64`);
          }
        } catch (error) {
          logError(`[IMAGE] Content script недоступен для загрузки изображения: ${error.message}`);
        }
      } else {
        logWarn(`[IMAGE] tabId не получен, пропускаем content script`);
      }

      // Путь 2: CORS fallback — background fetch напрямую (только для http/https)
      if (!imageBase64 && !fullSizeUrl.startsWith('file://')) {
        logInfo(`[IMAGE] Загрузка изображения напрямую через background fetch...`);
        imageBase64 = await loadImageAsBase64WithRetry(fullSizeUrl, signal);
        logInfo(`[IMAGE] Base64 загружен через background, длина: ${imageBase64.length}`);
      } 
      // Путь 3: file:// URL — пробуем через chrome.scripting.executeScript (inline function)
      else if (!imageBase64 && fullSizeUrl.startsWith('file://')) {
        logInfo(`[IMAGE] file:// URL — пробуем загрузить через scripting API с inline-функцией`);
        if (tabId) {
          try {
            // Используем inline-функцию для загрузки изображения
            const result = await chrome.scripting.executeScript({
              target: { tabId: tabId },
              func: async (imageUrl) => {
                return new Promise((resolve, reject) => {
                  const img = new Image();
                  img.crossOrigin = 'Anonymous';
                  
                  const timeoutId = setTimeout(() => {
                    reject(new Error('Таймаут загрузки изображения (30 сек)'));
                  }, 30000);
                  
                  img.onload = async () => {
                    clearTimeout(timeoutId);
                    try {
                      const canvas = document.createElement('canvas');
                      canvas.width = img.naturalWidth || img.width;
                      canvas.height = img.naturalHeight || img.height;
                      
                      const ctx = canvas.getContext('2d');
                      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                      
                      const dataUrl = canvas.toDataURL(imageUrl.match(/\.png$/i) ? 'image/png' : 'image/jpeg');
                      const base64 = dataUrl.split(',')[1] || dataUrl;
                      resolve(base64);
                    } catch (error) {
                      reject(new Error('Ошибка конвертации изображения: ' + error.message));
                    }
                  };
                  
                  img.onerror = () => {
                    clearTimeout(timeoutId);
                    reject(new Error('Не удалось загрузить изображение из file://'));
                  };
                  
                  img.src = imageUrl;
                });
              },
              args: [fullSizeUrl]
            });
            
            if (result && result[0] && result[0].result) {
              imageBase64 = result[0].result;
              logInfo(`[IMAGE] Base64 получен через scripting API, длина: ${imageBase64.length}`);
            } else {
              logInfo(`[IMAGE] scripting API не вернул результат`);
            }
          } catch (error) {
            logError(`[IMAGE] Ошибка загрузки через scripting API: ${error.message}`);
          }
        } else {
          logError(`[IMAGE] tabId не получен для scripting API, загрузка file:// невозможна`);
        }
      }
    }

    await saveToStorage({ streamProgress: 40, streamProgressText: 'Подготовка запроса...' });

    // Находим доступный сервер
    await saveToStorage({ streamProgress: 50, streamProgressText: 'Поиск доступного сервера...' });
    const selectedPreset = await findAvailableServer(settings.serverPresets, settings.apiKey);

    if (!selectedPreset) {
      logError(`[IMAGE] ❌ Нет доступных серверов`);
      throw new Error('Нет доступных серверов. Проверьте настройки.');
    }

    logInfo(`[IMAGE] ✅ Выбран сервер: ${selectedPreset.apiUrl}`);

    await saveToStorage({
      streamProgress: 60,
      streamProgressText: `Сервер: ${selectedPreset.apiUrl}`
    });

    // Отправляем изображение в API
    await saveToStorage({ streamProgress: 65, streamProgressText: 'Отправка на анализ...' });

    // Проверяем отмену перед отправкой
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    await sendImageToAPI(imageBase64, selectedPreset, settings, analysisType, signal);

    await saveToStorage({
      streamProgress: 100,
      streamProgressText: 'Анализ завершён!',
      imageAnalysisActive: false
    });

    currentImageAnalysis.isProcessing = false;
    logInfo(`[IMAGE] ✅ analyzeImage завершено успешно`);

  } catch (error) {
    logError(`[IMAGE] ❌ analyzeImage ошибка:`, error);
    currentImageAnalysis.isProcessing = false;
    currentImageAnalysis.error = error.message;

    await saveToStorage({
      streamProgress: 100,
      streamProgressText: 'Ошибка анализа',
      streamImageError: error.message,
      imageAnalysisActive: false
    });

    throw error;
  }
}

/**
 * Загружает изображение и конвертирует в Base64 с повторными попытками.
 * Добавлена поддержка AbortSignal для отмены запроса.
 *
 * @param {string} url - URL изображения
 * @param {AbortSignal} [signal] - сигнал отмены
 * @returns {Promise<string>} Base64 строка
 */
async function loadImageAsBase64WithRetry(url, signal) {
  let lastError = null;

  for (let attempt = 0; attempt < DEFAULTS.IMAGE_MAX_RETRIES; attempt++) {
    // Проверяем сигнал отмены перед каждой итерацией
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      logInfo(`loadImageAsBase64: попытка ${attempt + 1}/${DEFAULTS.IMAGE_MAX_RETRIES}, URL:`, url);

      // Создаём AbortController для загрузки этого изображения
      const imageController = new AbortController();
      
      // Синхронизируем с внешним сигналом отмены (проверка перед добавлением обработчика)
      if (signal && !signal.aborted) {
        const abortHandler = () => {
          if (!imageController.signal.aborted) {
            imageController.abort();
          }
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: imageController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const blob = await response.blob();

      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result;
          const base64 = result.split(',')[1] || result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

    } catch (error) {
      lastError = error;
      if (attempt < DEFAULTS.IMAGE_MAX_RETRIES - 1) {
        logInfo(`Ошибка загрузки, retry через ${DEFAULTS.IMAGE_RETRY_DELAY}мс:`, error.message);
        await sleep(DEFAULTS.IMAGE_RETRY_DELAY);
      }
    }
  }

  throw lastError || new Error('Не удалось загрузить изображение');
}

/**
 * Запрашивает список моделей с сервера и возвращает ID первой доступной модели.
 *
 * @param {string} apiUrl - URL API сервера
 * @param {AbortSignal} [signal] - сигнал отмены
 * @param {string} [apiKey] - API ключ для авторизации
 * @returns {Promise<string|null>} ID модели или null при ошибке
 */
async function getFirstModelFromServer(apiUrl, signal, apiKey = '') {
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + (apiKey || ''),
        'Content-Type': 'application/json'
      },
      signal: signal
    });

    if (!response.ok) {
      logWarn(`GET /models вернул статус ${response.status}`);
      return null;
    }

    const data = await response.json();
    const models = data.data || [];
    
    if (models && models.length > 0) {
      const modelId = models[0].id || models[0].name || models[0];
      logInfo(`[IMAGE] ✅ Автоопределена модель: ${modelId}`);
      return modelId;
    }

    return null;
  } catch (error) {
    logWarn(`Ошибка при определении модели: ${error.message}`);
    return null;
  }
}

/**
 * Отправляет изображение в AI API с соответствующим промптом.
 * Работает в OLD-style режиме: модель берется напрямую из settings.model
 *
 * @param {string} base64Image - Base64 изображение
 * @param {Object} preset - настройки сервера
 * @param {Object} settings - общие настройки
 * @param {string} analysisType - тип анализа: 'prompt' или 'translation'
 * @param {AbortSignal} [signal] - сигнал отмены
 */
async function sendImageToAPI(base64Image, preset, settings, analysisType = 'prompt', signal = null) {
  const { apiUrl } = preset;
  const { apiKey, model, imageSystemPrompt, imageTranslationPrompt } = settings;

  // Модель берется напрямую из настроек (OLD-style)
  const finalModel = model || DEFAULTS.MODEL;

  // Выбираем промпт в зависимости от типа анализа
  const defaultPrompt = analysisType === 'translation'
    ? DEFAULTS.IMAGE_TRANSLATION_PROMPT
    : DEFAULTS.IMAGE_SYSTEM_PROMPT;

  const storedPrompt = analysisType === 'translation'
    ? imageTranslationPrompt
    : imageSystemPrompt;

  const prompt = storedPrompt || defaultPrompt;

  // Текст пользователя тоже зависит от типа анализа
  const userText = analysisType === 'translation'
    ? 'Распознай весь текст на этом изображении и переведи его на русский язык.'
    : 'Опиши что видно на этом изображении. Если есть текст — распознай и переведи на русский.';

  logInfo(`sendImageToAPI: URL: ${apiUrl}, модель: ${finalModel || '(не указана)'}, тип: ${analysisType}`);
  logInfo(`sendImageToAPI: base64Image длина: ${base64Image ? base64Image.length : 0}, первый символ: ${base64Image ? base64Image[0] : 'null'}`);
  
  // Проверка корректности Base64 (должен начинаться с буквы или цифры, без non-ASCII)
  if (base64Image && base64Image.length > 0) {
    const firstChunk = base64Image.substring(0, 50);
    const validBase64Chars = /^[A-Za-z0-9+\/=]+$/;
    if (!validBase64Chars.test(firstChunk)) {
      logError(`sendImageToAPI: Base64 содержит некорректные символы! Первые 50 символов: ${firstChunk}`);
    }
  }

  await saveToStorage({ streamProgress: 70, streamProgressText: 'Анализ изображения...' });

  // Формируем multimodal запрос
  const messages = [
    {
      role: 'system',
      content: prompt
    },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${base64Image}`
          }
        },
        {
          type: 'text',
          text: userText
        }
      ]
    }
  ];

  try {
    const controller = signal ? { signal } : {};

    // Генерация началась — запрос отправляется на сервер
    markGenerationStarted('image');
    startStallDetection(signal);

    const normalizedUrl = apiUrl.replace(/\/$/, '');
    const response = await fetch(`${normalizedUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      ...controller,
      body: JSON.stringify({
        model: finalModel,
        messages: messages,
        temperature: 0.3,
        max_tokens: 8192,
        stream: true
      })
    });

    logInfo('sendImageToAPI: статус:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} — ${errorText}. Убедитесь что модель поддерживает vision/multimodal.`);
    }

    await saveToStorage({ streamProgress: 80, streamProgressText: 'Получение ответа...' });

    try {
      await processImageAnalysisStream(response, signal);
    } finally {
      stopStallDetection();
      markGenerationComplete();
    }

  } catch (error) {
    // При ошибке тоже сбрасываем состояние
    stopStallDetection();
    markGenerationAborted();
    logError('sendImageToAPI: ошибка:', error);
    throw error;
  }
}

/**
 * Обрабатывает streaming ответ для анализа изображения.
 * Добавлена проверка signal.aborted в цикле.
 *
 * @param {Response} response - ответ от API
 * @param {AbortSignal} [signal] - сигнал отмены
 */
async function processImageAnalysisStream(response, signal = null) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullResponse = '';
  let fullReasoning = '';
  let buffer = '';
  let chunkCount = 0;
  let contentCount = 0;

  logInfo('processImageAnalysisStream: начало');

  try {
    while (true) {
      // Проверяем отмену
      if (signal?.aborted) {
        logInfo('[IMAGE] ⚠️ Streaming отменён пользователем');
        throw new DOMException('Aborted', 'AbortError');
      }

      const { done, value } = await reader.read();

      // Проверяем signal.aborted между итерациями
      if (signal?.aborted) {
        logInfo('[IMAGE] ⚠️ Streaming отменён пользователем (между чанками)');
        throw new DOMException('Aborted', 'AbortError');
      }

      if (done) {
        logInfo('Streaming завершён, чанков:', chunkCount);
        break;
      }

      chunkCount++;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Обновляем timestamp последних данных
      markDataReceived();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith('data: ')) {
          const dataStr = trimmedLine.slice(6);

          if (dataStr === '[DONE]') break;

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0];
            const content = choice?.delta?.content || '';
            const reasoning = choice?.delta?.reasoning_content || '';

            if (reasoning) {
              fullReasoning += reasoning;
              if (fullReasoning.length % 50 < 10) {
                await sendMessageToSidebar({ type: 'imageReasoningChunk', content: fullReasoning });
              }
            }

            if (content) {
              contentCount++;
              fullResponse += content;

              // Отправляем первый чанк немедленно для быстрого отклика, 
              // затем буферизуем чанки по 5 для оптимизации
              if (contentCount === 1 || contentCount % 5 === 0) {
                await sendMessageToSidebar({ type: 'imageAnalysisChunk', content: fullResponse });
              }
            }
          } catch (e) {
            // Игнорируем ошибки парсинга отдельных чанков
          }
        }
      }
    }
  } catch (readError) {
    if (readError.name === 'AbortError') throw readError;
    logError('processImageAnalysisStream ошибка:', readError);

    // Сервер оборвал стрим — пробуем retry
    const receivedSomeData = fullResponse.length > 0;
    if (receivedSomeData) {
      logWarn(`[IMAGE] ⚠️ Стрим изображения оборван (получено: ${fullResponse.length} символов)`);
      retryLastRequest(readError.message).catch(err => {
        logError('[IMAGE] ❌ Retry не удался:', err.message);
      });
      return;
    }

    throw readError;
  }

  const finalResponse = fullResponse || fullReasoning;

  await chrome.storage.local.set({
    streamImageContent: String(finalResponse),
    streamImageComplete: true,
    streamImageReasoning: fullReasoning || null
  });

  // Вариант 2: если основной ответ есть, но чанки не отправлялись – отправляем его как один финальный чанк
  // Это исправляет случай когда модель выдаёт reasoning постранично, а потом сразу весь ответ
  if (fullResponse && contentCount === 0) {
    logInfo('[IMAGE] Content чанков не было, отправляю финальный чанк');
    await sendMessageToSidebar({ type: 'imageAnalysisChunk', content: fullResponse });
  }

  await sendMessageToSidebar({ type: 'imageAnalysisComplete', content: finalResponse });

  if (fullReasoning && fullReasoning !== finalResponse) {
    await sendMessageToSidebar({ type: 'imageReasoningComplete', content: fullReasoning });
  }

  logInfo('processImageAnalysisStream: результат сохранён');
}

// ============================================================================
// УТИЛИТЫ ОТПРАВКИ В SIDEBAR
// ============================================================================

/**
 * Отправляет сообщение в sidebar.
 * Sidebar слушает как через chrome.storage, так и через runtime messages.
 *
 * @param {Object} message - сообщение
 */
async function sendMessageToSidebar(message) {
  try {
    // Отправляем через runtime message (мгновенно)
    await chrome.runtime.sendMessage(message).catch(() => {
      // Sidebar может быть не доступен — это нормально
    });
  } catch (error) {
    logError('Ошибка отправки в sidebar:', error);
  }
}

/**
 * Автоматический retry последнего запроса при обрыве стрима.
 * Если сервер оборвал соединение mid-stream — повторяем запрос с теми же параметрами.
 *
 * @param {string} errorReason — причина обрыва (для логирования)
 */
async function retryLastRequest(errorReason) {
  if (!lastRequestState.type || !lastRequestState.request) {
    logWarn(`[RETRY] Нет сохранённого запроса для retry`);
    return;
  }

  if (lastRequestState.retryCount >= MAX_STREAM_RETRY) {
    logError(`[RETRY] Лимит retry исчерпан (${lastRequestState.retryCount}/${MAX_STREAM_RETRY})`);
    await sendMessageToSidebar({
      type: 'streamError',
      error: `Сервер оборвал ответ (${errorReason}). Повторные попытки не удались.`
    });
    lastRequestState = { type: null, request: null, retryCount: 0 };
    return;
  }

  lastRequestState.retryCount++;
  const { type, request } = lastRequestState;

  logInfo(`[RETRY] Автоматический retry запроса типа "${type}", попытка ${lastRequestState.retryCount}/${MAX_STREAM_RETRY}`);

  // Уведомляем sidebar о retry
  await sendMessageToSidebar({
    type: 'streamProgress',
    progress: 45,
    progressText: `Обрыв связи, повторяю запрос... (${lastRequestState.retryCount}/${MAX_STREAM_RETRY})`
  });

  // Небольшая задержка перед retry
  await sleep(2000);

  try {
    // Сбрасываем состояние генерации — старый запрос оборвался
    markGenerationAborted();

    // СОХРАНЯЕМ resolvedModel в retryRequest
    const retryRequest = { 
      ...request,
      resolvedModel: request.resolvedModel // сохраняем определённую модель
    };

    // Создаём новый AbortController для retry
    const controller = new AbortController();
    currentAbortControllers[type] = controller;

    if (type === 'page') {
      await streamPageAnalysis(retryRequest, controller.signal);
    } else if (type === 'chat') {
      await streamChatQuery(retryRequest, controller.signal);
    }
    // Image analysis не retry-ится автоматически (запускается из контекстного меню)

    logInfo(`[RETRY] Retry запроса "${type}" завершён успешно`);
    lastRequestState = { type: null, request: null, retryCount: 0 };
    saveLastRequestState();

  } catch (error) {
    if (error.name === 'AbortError') {
      logInfo(`[RETRY] Retry запроса отменён пользователем`);
      return;
    }
    logError(`[RETRY] Retry запроса "${type}" не удался:`, error.message);
    // Рекурсивный retry если ещё есть попытки
    await retryLastRequest(error.message);
  }
}

/**
 * Сохраняет данные в storage и дублирует в sidebar.
 *
 * @param {Object} data - данные для сохранения
 */
async function saveToStorage(data) {
  try {
    await chrome.storage.local.set(data);

    // Дублируем прогресс в sidebar
    if (data.streamProgress !== undefined || data.streamProgressText !== undefined) {
      await sendMessageToSidebar({
        type: 'streamProgress',
        progress: data.streamProgress,
        progressText: data.streamProgressText
      });
    }

    // Дублируем ошибки
    if (data.streamError) {
      await sendMessageToSidebar({
        type: 'streamError',
        error: data.streamError
      });
    }

    if (data.streamImageError) {
      await sendMessageToSidebar({
        type: 'imageAnalysisError',
        error: data.streamImageError
      });
    }
  } catch (error) {
    logError('saveToStorage error:', error);
  }
}

// ============================================================================
// ОБРАБОТКА КЛИКА ПО КНОПКЕ EXTENSION
// ============================================================================

/**
 * При клике на иконку расширения — открываем sidebar БЕЗ авто-анализа.
 * Пользователь сам вводит запрос или нажимает 🚀 для анализа.
 */
chrome.action.onClicked.addListener(async (tab) => {
  logInfo(`[ACTION] Клик на иконке, windowId: ${tab.windowId}, tabId: ${tab.id}`);
  await chrome.sidePanel.open({ windowId: tab.windowId });
  logInfo('[ACTION] Sidebar открыт (без авто-анализа)');
});

// ============================================================================
// ОБРАБОТКА ИЗМЕНЕНИЙ STORAGE
// ============================================================================

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.resetStream) {
    logInfo('Storage: resetStream detected');
    // Отменяем ВСЕ активные запросы
    if (currentAbortControllers.page) { currentAbortControllers.page.abort(); currentAbortControllers.page = null; }
    if (currentAbortControllers.chat) { currentAbortControllers.chat.abort(); currentAbortControllers.chat = null; }
    if (currentAbortControllers.image) { currentAbortControllers.image.abort(); currentAbortControllers.image = null; }
    currentResponse = { content: '', isComplete: false, error: null };
    // Сбрасываем generation state — сброс из storage не штатное завершение
    markGenerationAborted();
  }
});

// ============================================================================
// УТИЛИТЫ
// ============================================================================

/**
 * Получает настройки из storage.
 * Возвращает все настройки включая useLoadedModel.
 * @returns {Promise<Object>}
 */
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'serverPresets', 'apiKey', 'model',
      'systemPrompt', 'imageSystemPrompt', 'imageTranslationPrompt',
      'useLoadedModel'
    ], (result) => {
      // Возвращаем useLoadedModel с fallback на true по умолчанию
      result.useLoadedModel = result.useLoadedModel ?? DEFAULTS.USE_LOADED_MODEL;
      resolve(result);
    });
  });
}
