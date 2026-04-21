/**
 * config.js — Централизованные настройки расширения Prompt
 *
 * Этот файл содержит все константы и настройки по умолчанию,
 * используемые background.js, sidebar.js и другими модулями.
 *
 * Преимущества:
 * - Единая точка настройки — легко менять
 * - Нет дублирования значений между файлами
 * - Типизированные константы для лимитов
 */

const DEFAULTS = Object.freeze({

  // =========================================================================
  // СЕРВЕРЫ И API
  // =========================================================================

  /**
   * Пресеты серверов — список OpenAI-совместимых API endpoint'ов.
   * Серверы проверяются по порядку, используется первый доступный.
   *
   * @property {boolean}  enabled      — включён ли пресет
   * @property {string}   apiUrl       — базовый URL API (должен заканчиваться на /v1)
   * @property {string}   extractMode  — режим извлечения контента 'smart'|'full'|'selection'
   */
   SERVER_PRESETS: [
     { enabled: true, apiUrl: 'http://localhost:1234/v1', extractMode: 'smart' }
   ],

   /** API ключ по умолчанию для авторизации */
   API_KEY: '',

   /** Название модели по умолчанию */
   MODEL: '',

   /**
    * Максимальное количество токенов для ответа.
    * Установлено очень большое значение чтобы ответ не обрезался.
    * Для большинства моделей реально используется меньше чем это значение.
    */
   MAX_TOKENS: 131072, // 128K токенов — практически без ограничений

  /**
   * Использовать ли модель, уже загруженную на сервере.
   * Если true — перед запросом делается GET /v1/models и берётся
   * первая доступная модель вместо settings.model.
   */
  USE_LOADED_MODEL: true,

  // =========================================================================
  // ЛИМИТЫ КОНТЕНТА
  // =========================================================================

  /**
   * Максимальная длина извлекаемого контента (символы).
   * Предотвращает отправку огромных страниц в API.
   * 50 000 символов ≈ 12 500 токенов — достаточно для большинства страниц.
   */
  MAX_CONTENT_LENGTH: 50000,

  /**
   * Максимальная глубина обхода DOM при извлечении контента.
   * Ограничивает рекурсию для производительности на тяжёлых страницах.
   */
  MAX_DOM_DEPTH: 10,

  /**
   * Debounce (мс) для извлечения контента.
   * Предотвращает частые повторные извлечения.
   * НЕ применяется при явном запросе пользователя (Ctrl+Enter).
   */
  CONTENT_EXTRACTION_DEBOUNCE: 2000,

  // =========================================================================
  // ЗАГРУЗКА ИЗОБРАЖЕНИЙ
  // =========================================================================

  /** Максимальное количество повторных попыток загрузки изображения */
  IMAGE_MAX_RETRIES: 3,

  /** Задержка (мс) между попытками загрузки изображения */
  IMAGE_RETRY_DELAY: 500,

  // =========================================================================
  // RETRY API ЗАПРОСОВ
  // =========================================================================

  /** Максимальное количество повторных попыток при ошибке API */
  API_RETRY_MAX: 4,

  /**
   * Базовая задержка для экспоненциального backoff (мс).
   * Реальные задержки: 2с → 4с → 8с (умножается на 2^attempt).
   * Увеличена для медленных серверов.
   */
  API_RETRY_BASE_DELAY: 2000,

  // =========================================================================
  // ТАЙМАУТЫ ДЛЯ МЕДЛЕННЫХ СЕРВЕРОВ
  // =========================================================================

  /**
   * Таймаут fetch запроса (мс).
   * Увеличен с 30с до 5 минут для серверов с долгой prefill (до 10 минут до первого токена).
   * На медленных серверах рекомендуется ещё больший timeout.
   */
  FETCH_TIMEOUT_MS: 300000, // 5 минут (можно увеличить до 600000 для 10 минут)

  /**
   * Таймаут stall (мс) — порог бездействия сервера перед retry.
   * Увеличен с 60с до 3 минут (сервер может думать дольше).
   * Для очень медленных серверов (до 10 минут до первого токена) рекомендуется:
   * -STALL_TIMEOUT_FIRST_TOKEN: таймаут до получения ПЕРВОГО токена (отдельно)
   * -STALL_TIMEOUT_STREAM: таймаут внутри стриминга (между чанками)
   */
  STALL_TIMEOUT_MS: 180000, // 3 минуты вместо 60с

  /**
   * Таймаут до получения первого токена (мс).
   * Для серверов с долгой prefill (до 10 минут).
   * Если первый токен не пришёл за это время — считается stall для FIRST TOKEN.
   */
  STALL_TIMEOUT_FIRST_TOKEN: 600000, // 10 минут для очень медленных серверов

  /**
   * Таймаут между чанками стриминга (мс).
   * Если во время стриминга нет новых чанков дольше этого времени — stall.
   * Должен быть меньше чем STALL_TIMEOUT_MS.
   */
  STALL_TIMEOUT_STREAM: 120000, // 2 минуты между чанками

  /**
   * Таймаут поиска доступного сервера (мс).
   * Увеличен с 2с до 10с для медленных серверов.
   */
  SERVER_CHECK_TIMEOUT_MS: 10000, // 10 секунд вместо 2с

  /**
   * Минимальное время ожидания перед retry (мс).
   * Увеличено для медленных серверов.
   */
  RETRY_MIN_DELAY: 5000, // 5 секунд

  /**
   * Максимальное кол-во stall retry попыток.
   * Увеличено с 5 до 10 для особо медленных серверов.
   */
  MAX_STALL_RETRIES: 10,

  /**
   * Максимальное время ожидания для серверов с долгой prefill (мс).
   * Если сервер не отвечает в течение этого времени после отправки - считается что
   * сервер может работать долго и stall retry не следует вызывать.
   * Рекомендуется установить больше чем typical prefill time (например 10 минут для очень медленных серверов).
   */
  STALL_MAX_TIMEOUT_MS: 600000,

  // =========================================================================
  // СИСТЕМНЫЕ ПРОМПТЫ
  // =========================================================================

  /**
   * Системный промпт по умолчанию для анализа веб-страниц.
   * Используется когда пользователь не задал свой промпт.
   */
  SYSTEM_PROMPT: 'Ты полезный ассистент. Анализируй содержимое веб-страниц и давай краткие выжимки на русском языке.',

  /**
   * Системный промпт по умолчанию для анализа изображений.
   * Используется при обработке изображений через контекстное меню (получить промт).
   */
  IMAGE_SYSTEM_PROMPT: 'Ты система анализа изображений. Опиши что видно на изображении подробно, на русском языке. Если есть текст — распознай и переведи его.',

  /**
   * Системный промпт по умолчанию для перевода текста с изображения.
   * Используется при обработке изображений через контекстное меню (перевод текста).
   */
  IMAGE_TRANSLATION_PROMPT: 'Ты система распознавания и перевода текста. Найди весь текст на изображении, распознай его и переведи на русский язык. Выведи только перевод без лишних комментариев.',

  // =========================================================================
  // UI НАСТРОЙКИ
  // =========================================================================

  /** Размер шрифта по умолчанию (px). Мин: 8, Макс: 16 */
  FONT_SIZE: 13,

  /** Тема по умолчанию: 'dark' или 'light' */
  THEME: 'dark',

  // =========================================================================
  // ПОРОГИ И ИНДИКАТОРЫ
  // =========================================================================

  /**
   * Порог readability score (0-1), ниже которого качество извлечения считается низким.
   */
  READABILITY_SCORE_MIN: 0.3,

  /**
   * Базовая скорость анимации стриминга (символов в минуту).
   * Используется в sidebar.js для плавной отрисовки текста.
   */
  STREAM_ANIMATION_BASE_SPEED: 360,

  // =========================================================================
  // ЛОГИРОВАНИЕ
  // =========================================================================

  /** Уровни логирования: 'DEBUG', 'INFO', 'WARN', 'ERROR' */
  LOG_LEVEL: 'INFO',

  /** Префикс логов для background service worker */
  LOG_PREFIX_BG: '[Prompt BG]',

  /** Префикс логов для content script */
  LOG_PREFIX_CONTENT: '[Prompt Content]',

  /** Префикс логов для sidebar */
  LOG_PREFIX_SIDEBAR: '[Prompt SB]',

  // =========================================================================
  // ВЕРСИОНИРОВАНИЕ
  // =========================================================================

   /** Версия конфигурации для возможной миграции настроек */
   CONFIG_VERSION: '1.0.0'
});

// ============================================================================
// ВАЛИДАЦИЯ КОНФИГУРАЦИИ
// ============================================================================

/**
 * Применяет fallback-значения к конфигурации при невалидных входных данных.
 * Возвращает объект с перечнем применённых исправлений.
 *
 * ФУНКЦИЯ: Диагностика корректности конфигурации.
 * Эта функция проверяет все числовые параметры конфигурации и сообщает,
 * если какие-либо из них имеют некорректные значения. Это полезно при
 * отладке и обнаружении ошибок в настройках расширения.
 *
 * КАК РАБОТАЕТ:
 * 1. Определяет список всех числовых параметров с их ожидаемыми значениями по умолчанию
 * 2. Для каждого параметра запускает функцию-валидатор (check)
 * 3. Если значение не проходит валидацию — добавляет запись в список applied
 * 4. Возвращает объект с перечнем всех проблемных полей
 *
 * ПРИМЕЧАНИЕ: DEFAULTS — это Object.freeze объект, его нельзя изменять.
 * Функция только фиксирует что могло бы быть исправлено — для диагностики.
 * Фактические значения уже вшиты в DEFAULTS и не нуждаются в fallback,
 * поскольку не приходят из внешних источников.
 *
 * ИСПОЛЬЗОВАНИЕ: Вызывается автоматически при загрузке модуля после validateDefaults().
 * 
 * @returns {{applied: string[]}} Объект с перечнем полей, требующих внимания
 */
function applyFallbackValues() {
  const applied = [];

  const numericChecks = [
    ['MAX_TOKENS', 131072, (v) => Number.isInteger(v) && v > 0],
    ['MAX_CONTENT_LENGTH', 50000, (v) => Number.isInteger(v) && v > 0],
    ['MAX_DOM_DEPTH', 10, (v) => Number.isInteger(v) && v > 0],
    ['FONT_SIZE', 13, (v) => Number.isInteger(v) && v >= 8 && v <= 16],
    ['IMAGE_MAX_RETRIES', 3, (v) => Number.isInteger(v) && v > 0],
    ['IMAGE_RETRY_DELAY', 500, (v) => Number.isInteger(v) && v > 0],
    ['API_RETRY_MAX', 4, (v) => Number.isInteger(v) && v >= 0],
    ['API_RETRY_BASE_DELAY', 2000, (v) => Number.isInteger(v) && v > 0],
    ['STALL_TIMEOUT_MS', 180000, (v) => Number.isInteger(v) && v > 0],
    ['FETCH_TIMEOUT_MS', 300000, (v) => Number.isInteger(v) && v > 0],
    ['CONTENT_EXTRACTION_DEBOUNCE', 2000, (v) => Number.isInteger(v) && v >= 0],
    ['STREAM_ANIMATION_BASE_SPEED', 360, (v) => Number.isInteger(v) && v > 0],
    ['STALL_TIMEOUT_FIRST_TOKEN', 600000, (v) => Number.isInteger(v) && v > 0],
    ['STALL_TIMEOUT_STREAM', 120000, (v) => Number.isInteger(v) && v > 0],
    ['SERVER_CHECK_TIMEOUT_MS', 10000, (v) => Number.isInteger(v) && v > 0],
    ['RETRY_MIN_DELAY', 5000, (v) => Number.isInteger(v) && v > 0],
    ['MAX_STALL_RETRIES', 10, (v) => Number.isInteger(v) && v > 0],
    ['STALL_MAX_TIMEOUT_MS', 600000, (v) => Number.isInteger(v) && v > 0],
    ['READABILITY_SCORE_MIN', 0.3, (v) => typeof v === 'number' && v >= 0 && v <= 1]
  ];

  for (const [key, fallback, check] of numericChecks) {
    if (!check(DEFAULTS[key])) {
      applied.push(`${key}: некорректное значение ${DEFAULTS[key]}, ожидается ~${fallback}`);
    }
  }

  return { applied };
}

/**
 * Валидирует значения конфигурации DEFAULTS.
 * Вызывается при инициализации для проверки корректности настроек.
 * После валидации применяются fallback-значения.
 *
 * ФУНКЦИЯ: Полная валидация всей конфигурации расширения.
 * Эта функция проверяет каждый параметр конфигурации на корректность,
 * используя специфичные для каждого типа правила валидации.
 *
 * ЧТО ПРОВЕРЯЕТСЯ:
 * - MAX_TOKENS: положительное целое число
 * - MAX_CONTENT_LENGTH: положительное целое число
 * - MAX_DOM_DEPTH: положительное целое число
 * - FONT_SIZE: целое число от 8 до 16
 * - IMAGE_MAX_RETRIES: положительное целое число
 * - IMAGE_RETRY_DELAY: положительное целое число
 * - API_RETRY_MAX: неотрицательное целое число
 * - API_RETRY_BASE_DELAY: положительное целое число
 * - STALL_TIMEOUT_MS: положительное целое число
 * - CONTENT_EXTRACTION_DEBOUNCE: неотрицательное целое число
 * - STREAM_ANIMATION_BASE_SPEED: положительное целое число
 * - READABILITY_SCORE_MIN: число от 0 до 1
 * - LOG_LEVEL: одна из ['DEBUG', 'INFO', 'WARN', 'ERROR']
 * - SERVER_PRESETS: массив с валидными объектами пресетов
 *
 * КАК РАБОТАЕТ:
 * 1. Создаёт массив errors для накопления ошибок
 * 2. Последовательно проверяет каждый параметр
 * 3. При обнаружении ошибки — добавляет описание в errors
 * 4. Возвращает объект с флагом valid и списком ошибок
 *
 * ИСПОЛЬЗОВАНИЕ: Вызывается автоматически при загрузке модуля.
 * Если валидация не пройдена — выводится предупреждение в консоль.
 *
 * @returns {Object} Объект с результатами валидации { valid: boolean, errors: string[] }
 */
function validateDefaults() {
  const errors = [];

  // Валидация MAX_TOKENS
  if (!Number.isInteger(DEFAULTS.MAX_TOKENS) || DEFAULTS.MAX_TOKENS <= 0) {
    errors.push(`MAX_TOKENS должно быть положительным целым числом, получено: ${DEFAULTS.MAX_TOKENS}`);
  }

  // Валидация MAX_CONTENT_LENGTH
  if (!Number.isInteger(DEFAULTS.MAX_CONTENT_LENGTH) || DEFAULTS.MAX_CONTENT_LENGTH <= 0) {
    errors.push(`MAX_CONTENT_LENGTH должно быть положительным целым числом, получено: ${DEFAULTS.MAX_CONTENT_LENGTH}`);
  }

  // Валидация MAX_DOM_DEPTH
  if (!Number.isInteger(DEFAULTS.MAX_DOM_DEPTH) || DEFAULTS.MAX_DOM_DEPTH <= 0) {
    errors.push(`MAX_DOM_DEPTH должно быть положительным целым числом, получено: ${DEFAULTS.MAX_DOM_DEPTH}`);
  }

  // Валидация FONT_SIZE
  if (!Number.isInteger(DEFAULTS.FONT_SIZE) || DEFAULTS.FONT_SIZE < 8 || DEFAULTS.FONT_SIZE > 16) {
    errors.push(`FONT_SIZE должно быть от 8 до 16, получено: ${DEFAULTS.FONT_SIZE}`);
  }

  // Валидация IMAGE_MAX_RETRIES
  if (!Number.isInteger(DEFAULTS.IMAGE_MAX_RETRIES) || DEFAULTS.IMAGE_MAX_RETRIES <= 0) {
    errors.push(`IMAGE_MAX_RETRIES должно быть положительным целым числом, получено: ${DEFAULTS.IMAGE_MAX_RETRIES}`);
  }

  // Валидация IMAGE_RETRY_DELAY
  if (!Number.isInteger(DEFAULTS.IMAGE_RETRY_DELAY) || DEFAULTS.IMAGE_RETRY_DELAY <= 0) {
    errors.push(`IMAGE_RETRY_DELAY должно быть положительным целым числом, получено: ${DEFAULTS.IMAGE_RETRY_DELAY}`);
  }

  // Валидация API_RETRY_MAX
  if (!Number.isInteger(DEFAULTS.API_RETRY_MAX) || DEFAULTS.API_RETRY_MAX < 0) {
    errors.push(`API_RETRY_MAX должно быть неотрицательным целым числом, получено: ${DEFAULTS.API_RETRY_MAX}`);
  }

  // Валидация API_RETRY_BASE_DELAY
  if (!Number.isInteger(DEFAULTS.API_RETRY_BASE_DELAY) || DEFAULTS.API_RETRY_BASE_DELAY <= 0) {
    errors.push(`API_RETRY_BASE_DELAY должно быть положительным целым числом, получено: ${DEFAULTS.API_RETRY_BASE_DELAY}`);
  }

  // Валидация STALL_TIMEOUT_MS
  if (!Number.isInteger(DEFAULTS.STALL_TIMEOUT_MS) || DEFAULTS.STALL_TIMEOUT_MS <= 0) {
    errors.push(`STALL_TIMEOUT_MS должно быть положительным целым числом, получено: ${DEFAULTS.STALL_TIMEOUT_MS}`);
  }

  // Валидация CONTENT_EXTRACTION_DEBOUNCE
  if (!Number.isInteger(DEFAULTS.CONTENT_EXTRACTION_DEBOUNCE) || DEFAULTS.CONTENT_EXTRACTION_DEBOUNCE < 0) {
    errors.push(`CONTENT_EXTRACTION_DEBOUNCE должно быть неотрицательным целым числом, получено: ${DEFAULTS.CONTENT_EXTRACTION_DEBOUNCE}`);
  }

  // Валидация STREAM_ANIMATION_BASE_SPEED
  if (!Number.isInteger(DEFAULTS.STREAM_ANIMATION_BASE_SPEED) || DEFAULTS.STREAM_ANIMATION_BASE_SPEED <= 0) {
    errors.push(`STREAM_ANIMATION_BASE_SPEED должно быть положительным целым числом, получено: ${DEFAULTS.STREAM_ANIMATION_BASE_SPEED}`);
  }

  // Валидация READABILITY_SCORE_MIN
  if (typeof DEFAULTS.READABILITY_SCORE_MIN !== 'number' || DEFAULTS.READABILITY_SCORE_MIN < 0 || DEFAULTS.READABILITY_SCORE_MIN > 1) {
    errors.push(`READABILITY_SCORE_MIN должно быть числом от 0 до 1, получено: ${DEFAULTS.READABILITY_SCORE_MIN}`);
  }

  // Валидация LOG_LEVEL
  const validLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
  if (!validLogLevels.includes(DEFAULTS.LOG_LEVEL)) {
    errors.push(`LOG_LEVEL должно быть одним из [${validLogLevels.join(', ')}], получено: ${DEFAULTS.LOG_LEVEL}`);
  }

  // Валидация SERVER_PRESETS
  if (!Array.isArray(DEFAULTS.SERVER_PRESETS)) {
    errors.push(`SERVER_PRESETS должен быть массивом, получено: ${typeof DEFAULTS.SERVER_PRESETS}`);
  } else {
    DEFAULTS.SERVER_PRESETS.forEach((preset, index) => {
      // Проверяем только тип — false является валидным значением для disabled пресета
      if (typeof preset.enabled !== 'boolean') {
        errors.push(`SERVER_PRESETS[${index}].enabled должен быть boolean, получено: ${typeof preset.enabled}`);
      }
      if (!preset.apiUrl || typeof preset.apiUrl !== 'string' || !preset.apiUrl.endsWith('/v1')) {
        errors.push(`SERVER_PRESETS[${index}].apiUrl должен быть строкой, заканчивающейся на /v1: "${preset.apiUrl}"`);
      }
      if (!['smart', 'full', 'selection'].includes(preset.extractMode)) {
        errors.push(`SERVER_PRESETS[${index}].extractMode должно быть 'smart', 'full' или 'selection', получено: "${preset.extractMode}"`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

// Инициализация при загрузке модуля — проверяем настройки при старте
const validation = validateDefaults();
if (!validation.valid) {
  console.warn('[Prompt Config] Предупреждения при валидации:', validation.errors);
  // Диагностическая информация (DEFAULTS не изменяется, это Object.freeze)
  const fallbacks = applyFallbackValues();
  if (fallbacks.applied.length > 0) {
    console.warn('[Prompt Config] Поля с некорректными значениями:', fallbacks.applied);
  }
}

// Экспортируем функции валидации для отладки
if (typeof window !== 'undefined') {
  window.PromptConfig = { validateDefaults, applyFallbackValues, DEFAULTS };
}
