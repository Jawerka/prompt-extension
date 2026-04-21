/**
 * content.js — Content Script расширения Prompt
 *
 * НАЗНАЧЕНИЕ:
 * - Извлечение основного содержимого веб-страниц с readability-эвристикой
 * - Загрузка изображений для анализа (с CORS fallback)
 * - Навигация к элементам страницы
 *
 * АРХИТЕКТУРА:
 * Content script работает НА СТРАНИЦЕ ПОЛЬЗОВАТЕЛЯ и:
 * - НЕ имеет доступа к API ключу, настройкам сервера (безопасность)
 * - Только извлекает DOM-контент и загружает изображения
 * - Все API запросы обрабатываются через background.js
 *
 * ВАЖНО:
 * - Работает на ВСЕХ сайтах (matches: <all_urls> в manifest)
 * - Не модифицирует DOM страницы (только чтение)
 * - Ограничивает глубину обхода DOM для производительности
 */

// Подключаем централизованные настройки через injection (content script не может importScripts)
// Поэтому определяем константы локально (синхронизировано с config.js)

/**
 * Выполняет fetch запрос с таймаутом.
 *
 * @param {string} url - URL запроса
 * @param {Object} options - fetch options
 * @param {number} timeoutMs - таймаут в миллисекундах
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => {
    clearTimeout(timeoutId);
  });
}
const CONTENT_CONFIG = {
  MAX_CONTENT_LENGTH: 50000,
  MAX_DOM_DEPTH: 10,
  LOG_PREFIX: '[Prompt Content]',
  IMAGE_TIMEOUT_MS: 10000, // Таймаут для загрузки изображений
  CACHE_DURATION_MS: 5000   // Время жизни кэша контента страницы (5 секунд)
};

// ============================================================================
// КАШИРОВАНИЕ КОНТЕНТА СТРАНИЦЫ
// ============================================================================

/**
 * Кэш для результатов извлечения контента страницы.
 * Использует WeakMap для хранения временных кэш-ссылок.
 * @type {Map<string, { content: string, timestamp: number, score: number, url: string, title: string }>}
 */
const pageContentCache = new Map();

/**
 * Очистка устаревших записей из кэша.
 * @returns {number} Количество удалённых записей
 */
function cleanupCache() {
  const now = Date.now();
  let removed = 0;
  
  for (const [url, data] of pageContentCache.entries()) {
    if (now - data.timestamp > CONTENT_CONFIG.CACHE_DURATION_MS) {
      pageContentCache.delete(url);
      removed++;
    }
  }
  
  if (removed > 0) {
    log(`Кэш очищен: удалено ${removed} устаревших записей`);
  }
  return removed;
}

/**
 * Проверяет, есть ли валидный кэш для данного URL.
 * @param {string} url - URL страницы
 * @returns {Object|null} Объект с данными если кэш валиден, иначе null
 */
function getCachedPageContent(url) {
  if (!url) return null;
  
  // Периодическая очистка кэша (каждые 10 вызовов)
  if (pageContentCache.size > 0 && pageContentCache.size % 10 === 0) {
    cleanupCache();
  }
  
  const cached = pageContentCache.get(url);
  if (!cached) return null;
  
  const elapsed = Date.now() - cached.timestamp;
  if (elapsed > CONTENT_CONFIG.CACHE_DURATION_MS) {
    pageContentCache.delete(url);
    return null;
  }
  
  log(`Контент страницы получен из кэша (возраст: ${elapsed}мс)`);
  return cached;
}

/**
 * Кэширует результат извлечения контента страницы.
 * @param {string} url - URL страницы
 * @param {string} content - извлечённый контент
 * @param {number} score - readability score
 * @param {string} title - заголовок страницы
 */
function cachePageContent(url, content, score, title) {
  if (!url) return;
  
  pageContentCache.set(url, {
    content: content,
    timestamp: Date.now(),
    score: score,
    url: url,
    title: title
  });
  
  log(`Контент страницы закэширован (${content.length} символов)`);
}

/**
 * Логирование
 * @param  {...any} args
 */
function log(...args) {
  console.log(CONTENT_CONFIG.LOG_PREFIX, ...args);
}

/**
 * Логирование ошибок
 * @param  {...any} args
 */
function logError(...args) {
  console.error(CONTENT_CONFIG.LOG_PREFIX, ...args);
}

// ============================================================================
// ОБРАБОТЧИК СООБЩЕНИЙ ОТ BACKGROUND/SIDEBAR
// ============================================================================

/**
 * Слушает сообщения от background.js и sidebar.
 *
 * Поддерживаемые actions:
 * - extractPageContent: извлечь контент со страницы
 * - getFullSizeImageUrl: найти полную ссылку на изображение
 * - loadImageAsBase64: загрузить изображение как Base64
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // --- Извлечение контента страницы ---
  if (request.action === 'extractPageContent') {
    try {
      const content = extractPageContent(request.mode || 'smart');
      sendResponse({ success: true, data: content });
    } catch (error) {
      logError('Ошибка извлечения контента:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }

  // --- Поиск полной ссылки на изображение ---
  if (request.action === 'getFullSizeImageUrl') {
    const fullSizeUrl = getFullSizeImageUrl(request.thumbnailUrl);
    sendResponse({ success: !!fullSizeUrl, fullSizeUrl: fullSizeUrl || request.thumbnailUrl });
    return true;
  }

  // --- Загрузка изображения как Base64 ---
   if (request.action === 'loadImageAsBase64') {
     loadImageAsBase64(request.imageUrl, CONTENT_CONFIG.IMAGE_TIMEOUT_MS)
       .then(base64Image => sendResponse({ success: true, base64Image }))
       .catch(error => sendResponse({ success: false, error: error.message }));
     return true; // асинхронный ответ
   }

  return true;
});

log('Content script инициализирован');

// ============================================================================
// ИЗВЛЕЧЕНИЕ КОНТЕНТА СТРАНИЦЫ (READABILITY)
// ============================================================================

/**
 * Извлекает основное содержимое веб-страницы.
 *
 * АЛГОРИТМ:
 * 1. Проверяем кэш — если URL совпадает и кэш валиден, возвращаем закэшированный контент
 * 2. Если пользователь выделил текст — возвращаем выделение (приоритет)
 * 3. Ищем семантические элементы: <article>, <main>, <div[role="main"]>
 * 4. Если не найдено — запускаем readability-эвристику:
 *    - Считаем "score" каждого блочного элемента: textLen² / (1 + links)
 *    - Исключаем навигацию, рекламу, сайдбары, футеры
 *    - Выбираем элемент с максимальным score + соседей
 * 5. Очищаем от скриптов, стилей, атрибутов
 * 6. Обрезаем до MAX_CONTENT_LENGTH
 * 7. Кэшируем результат для повторного использования
 *
 * @param {string} mode - режим: 'smart' | 'full' | 'selection'
 * @param {boolean} forceRefresh - если true, игнорирует кэш
 * @returns {{title: string, url: string, content: string, selectedText: string, readabilityScore: number}}
 */
function extractPageContent(mode = 'smart', forceRefresh = false) {
  const startTime = performance.now();
  const currentPageUrl = window.location.href;

  // Режим: только выделение пользователя
  if (mode === 'selection') {
    const selectedText = window.getSelection()?.toString().trim() || '';
    return {
      title: document.title,
      url: window.location.href,
      content: selectedText,
      selectedText: selectedText,
      readabilityScore: 1.0, // выделение = максимальное качество
      extractedAt: new Date().toISOString(),
      extractionTimeMs: Math.round(performance.now() - startTime)
    };
  }

  // Проверяем выделение в smart режиме
  if (mode === 'smart') {
    const selectedText = window.getSelection()?.toString().trim() || '';
    if (selectedText.length > 50) {
      log('Используем выделение пользователя, длина:', selectedText.length);
      return {
        title: document.title,
        url: window.location.href,
        content: selectedText,
        selectedText: selectedText,
        readabilityScore: 1.0,
        extractedAt: new Date().toISOString(),
        extractionTimeMs: Math.round(performance.now() - startTime)
      };
    }
  }

  // Проверяем кэш (если не принудительное обновление)
  if (!forceRefresh) {
    const cached = getCachedPageContent(currentPageUrl);
    if (cached && cached.content && cached.content.length > 0) {
      return {
        title: cached.title || document.title,
        url: cached.url || currentPageUrl,
        content: cached.content,
        selectedText: '',
        readabilityScore: cached.score || 0,
        wasTruncated: cached.content.length > CONTENT_CONFIG.MAX_CONTENT_LENGTH,
        extractedAt: new Date().toISOString(),
        extractionTimeMs: 0, // из кэша — мгновенно
        fromCache: true
      };
    }
  }

  // Попытка извлечь из семантических элементов
  let content = '';
  let readabilityScore = 0;

  // Приоритет 1: <article>
  const articles = document.querySelectorAll('article');
  if (articles.length > 0) {
    content = extractElementsContent(articles);
    readabilityScore = 0.8;
  }

  // Приоритет 2: <main>
  if (!content) {
    const main = document.querySelector('main');
    if (main) {
      content = extractElementContent(main);
      readabilityScore = 0.75;
    }
  }

  // Приоритет 3: [role="main"]
  if (!content) {
    const roleMain = document.querySelector('[role="main"]');
    if (roleMain) {
      content = extractElementContent(roleMain);
      readabilityScore = 0.7;
    }
  }

  // Приоритет 4: Readability-эвристика
  if (!content) {
    const result = extractWithReadability();
    content = result.content;
    readabilityScore = result.score;
  }

  // Приоритет 5: <body> как fallback
  if (!content) {
    content = extractElementContent(document.body);
    readabilityScore = 0.3;
  }

  // Ограничиваем длину
  const wasTruncated = content.length > CONTENT_CONFIG.MAX_CONTENT_LENGTH;
  if (wasTruncated) {
    content = content.substring(0, CONTENT_CONFIG.MAX_CONTENT_LENGTH);
    log('Контент обрезан до', CONTENT_CONFIG.MAX_CONTENT_LENGTH, 'символов');
  }

  const extractionTime = Math.round(performance.now() - startTime);
  log('Извлечение завершено за', extractionTime, 'мс, длина:', content.length, 'score:', readabilityScore);

  // Кэшируем результат
  cachePageContent(currentPageUrl, content, readabilityScore, document.title);

  return {
    title: document.title,
    url: currentPageUrl,
    content: content,
    selectedText: '',
    readabilityScore: readabilityScore,
    wasTruncated: wasTruncated,
    extractedAt: new Date().toISOString(),
    extractionTimeMs: extractionTime
  };
}

/**
 * Извлекает текст из массива элементов.
 *
 * @param {NodeList|Array} elements
 * @returns {string}
 */
function extractElementsContent(elements) {
  const texts = [];

  elements.forEach(el => {
    const text = extractElementContent(el);
    if (text.trim().length > 50) { // игнорируем пустые
      texts.push(text);
    }
  });

  return texts.join('\n\n').trim();
}

/**
 * Извлекает текстовое содержимое одного элемента с очисткой.
 *
 * @param {Element} element
 * @returns {string}
 */
function extractElementContent(element) {
  // Клонируем чтобы не модифицировать оригинал
  const clone = element.cloneNode(true);

  // Удаляем нежелательные элементы
  const selectorsToRemove = [
    'script', 'style', 'noscript', 'svg', 'iframe',
    'nav', 'footer', 'header:not(article header):not(main header)',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '.sidebar', '.nav', '.footer', '.header', '.ad', '.ads', '.advertisement',
    '.cookie', '.popup', '.modal', '.share', '.social',
    '#sidebar', '#nav', '#footer', '#header', '#ad', '#ads'
  ];

  selectorsToRemove.forEach(selector => {
    try {
      clone.querySelectorAll(selector).forEach(el => {
        // Не удаляем если элемент находится внутри семантических элементов контента
        const closestContent = el.closest('article, main, .content, .post, .entry');
        if (!closestContent || closestContent === el) {
          el.remove();
        }
      });
    } catch (e) {
      // Селектор может быть невалидным — игнорируем
    }
  });

  // Получаем текст
  let text = clone.textContent || '';

  // Очищаем: убираем множественные пробелы и пустые строки
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // максимум 2 переноса подряд
    .replace(/[ \t]+$/gm, '')   // trailing пробелы
    .trim();

  return text;
}

/**
 * Оптимизированная Readability-эвристика для нахождения основного контента.
 *
 * АЛГОРИТМ с использованием TreeWalker (производительнее querySelectorAll):
 * 1. Используем TreeWalker для обхода DOM без создания промежуточных массивов
 * 2. Для каждого блочного элемента считаем score = textLen² / (1 + linkDensity * 10)
 * 3. Исключаем элементы с классами рекламы/навигации
 * 4. Выбираем элемент с максимальным score
 * 5. Берём его + родитель + следующие сиблинги с score > 50% от max
 *
 * @returns {{content: string, score: number}}
 */
function extractWithReadability() {
  const candidates = [];
  const body = document.body;

  if (!body) {
    return { content: '', score: 0 };
  }

  // Определяем селекторы блочных элементов
  const blockElements = {
    'DIV': true,
    'SECTION': true,
    'ARTICLE': true,
    'P': true,
    'TD': true,
    'LI': true,
    'BLOCKQUOTE': true,
    'PRE': true,
    'TABLE': true
  };

  // Используем TreeWalker для эффективного обхода без querySelectorAll
  const walker = document.createTreeWalker(
    body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        // Проверяем глубину
        const depth = getElementDepth(node, body);
        if (depth > CONTENT_CONFIG.MAX_DOM_DEPTH) {
          return NodeFilter.FILTER_SKIP;
        }

        // Пропускаем неблочные элементы
        if (!blockElements[node.nodeName]) {
          return NodeFilter.FILTER_SKIP;
        }

        // Пропускаем исключаемые элементы
        if (isExcludedElement(node)) {
          return NodeFilter.FILTER_SKIP;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  // Проходим по всем принятым узлам
  let node;
  while ((node = walker.nextNode())) {
    const score = calculateReadabilityScore(node);
    if (score > 0) {
      candidates.push({ element: node, score: score });
    }
  }

  // Если нет кандидатов — пустой результат
  if (candidates.length === 0) {
    return { content: '', score: 0 };
  }

  // Сортируем по score (убывающий порядок)
  candidates.sort((a, b) => b.score - a.score);

  // Лучший кандидат
  const best = candidates[0];
  const maxScore = best.score;

  // Собираем контент: лучший + сиблинги с score > 50% от max
  const contentParts = [];
  const parent = best.element.parentElement;

  if (parent) {
    const children = Array.from(parent.children);
    const bestIndex = children.indexOf(best.element);

    // Берём лучший элемент + соседние с высоким score
    for (let i = Math.max(0, bestIndex - 3); i <= Math.min(children.length - 1, bestIndex + 5); i++) {
      const child = children[i];
      if (isExcludedElement(child)) continue;

      const childText = (child.textContent || '').trim();
      if (childText.length < 20) continue; // пропускаем пустые

      // Проверяем score соседа
      const siblingScore = calculateReadabilityScore(child);
      if (siblingScore >= maxScore * 0.5 || child === best.element) {
        contentParts.push(childText);
      }
    }
  } else {
    contentParts.push((best.element.textContent || '').trim());
  }

  const content = contentParts.join('\n\n').trim();
  // Нормализуем score: 0.4-1.0 мапим на 0.0-1.0
  const normalizedScore = Math.max(0, Math.min(1, (maxScore - 0.4) / 0.6));

  return {
    content: content,
    score: normalizedScore
  };
}

/**
 * Считает readability score для элемента.
 *
 * Формула: (textLength / 100)² / (1 + linkDensity * 10)
 * Где linkDensity = linkTextLength / totalTextLength
 *
 * Высокий score = много текста, мало ссылок = вероятный основной контент.
 *
 * @param {Element} el
 * @returns {number}
 */
function calculateReadabilityScore(el) {
  const text = (el.textContent || '').trim();
  const textLen = text.length;

  // Слишком короткие элементы не интересны
  if (textLen < 50) return 0;

  // Считаем ссылки
  const links = el.querySelectorAll('a');
  let linkTextLen = 0;
  links.forEach(link => {
    linkTextLen += (link.textContent || '').length;
  });

  const linkDensity = textLen > 0 ? linkTextLen / textLen : 0;

  // Штраф за большую плотность ссылок (навигация/сайдбар)
  const score = Math.pow(textLen / 100, 2) / (1 + linkDensity * 10);

  return score;
}

/**
 * Проверяет является ли элемент "исключаемым" (реклама, навигация и т.д.)
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isExcludedElement(el) {
  const className = (el.className || '').toLowerCase();
  const id = (el.id || '').toLowerCase();

  // Паттерны для исключения
  const excludePatterns = [
    'sidebar', 'nav', 'navigation', 'menu', 'footer', 'header',
    'ad-', 'ads-', 'advert', 'banner', 'cookie', 'popup',
    'share', 'social', 'comment', 'widget', 'toolbar',
    'de-refmap', 'de-post-buttons', 'de-img-name' // совместимость
  ];

  const allNames = `${className} ${id}`;
  return excludePatterns.some(pattern => allNames.includes(pattern));
}

/**
 * Вычисляет глубину элемента относительно root.
 *
 * @param {Element} el
 * @param {Element} root
 * @returns {number}
 */
function getElementDepth(el, root) {
  let depth = 0;
  let current = el;

  while (current && current !== root && depth <= CONTENT_CONFIG.MAX_DOM_DEPTH + 1) {
    depth++;
    current = current.parentElement;
  }

  return depth;
}

// ============================================================================
// ОБРАБОТКА ИЗОБРАЖЕНИЙ
// ============================================================================

/**
 * Находит полную ссылку на изображение по URL превью.
 * Ищет в DOM актуальную ссылку.
 *
 * @param {string} thumbnailUrl - URL превью
 * @returns {string|null}
 */
function getFullSizeImageUrl(thumbnailUrl) {
  // Извлекаем имя файла
  const thumbMatch = thumbnailUrl.match(/\/([^\/?#]+)$/);
  if (!thumbMatch) return null;

  const thumbFileName = thumbMatch[1];

  // Ищем все изображения в постах/статьях
  const allImages = document.querySelectorAll(
    '.post__image-link, .post__image img, figure a, a[href*="src"]'
  );

  for (const img of allImages) {
    const imgElement = img.tagName === 'IMG' ? img : img.querySelector('img');
    const linkElement = img.tagName === 'A' ? img : img.closest('a');

    if (!imgElement) continue;

    const imgSrc = imgElement.src || imgElement.getAttribute('data-src') || '';
    if (imgSrc && imgSrc.includes(thumbFileName)) {
      const fullSizeLink = linkElement?.getAttribute('href');
      if (fullSizeLink) return fullSizeLink;
    }
  }

  return null;
}

/**
 * Загружает изображение как Base64.
 * Для file:// URL ищет изображение в DOM и конвертирует через canvas.
 * Для http(s):// использует fetch с таймаутом.
 *
 * @param {string} url - URL изображения
 * @param {number} timeoutMs - таймаут в миллисекундах
 * @returns {Promise<string>}
 */
async function loadImageAsBase64(url, timeoutMs = 10000) {
  // Проверка на корректный URL
  if (!url || typeof url !== 'string') {
    throw new Error('Некорректный URL изображения');
  }

  try {
    log('Загрузка изображения:', url, '(таймаут:', timeoutMs + 'мс)');

    // Если это file:// URL — ищем изображение в DOM и конвертируем через canvas
    if (url.startsWith('file://') || url.startsWith('blob:')) {
      log('Локальный файл, ищем в DOM...');

      // Ищем img элемент по src
      const allImages = document.querySelectorAll('img');
      let imgElement = null;
      for (const img of allImages) {
        const imgSrc = img.src || img.getAttribute('data-src') || '';
        if (imgSrc === url || imgSrc.includes(url.split('/').pop())) {
          imgElement = img;
          break;
        }
      }

      // Также проверяем элементы с background-image
      if (!imgElement) {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const bgImage = getComputedStyle(el).backgroundImage;
          if (bgImage && bgImage.includes(url.split('/').pop())) {
            // Попробуем создать временный img с таймаутом
            const tempImg = new Image();
            tempImg.crossOrigin = 'Anonymous';
            
            imgElement = await new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(null), timeoutMs);
              tempImg.onload = () => {
                clearTimeout(timeout);
                resolve(tempImg);
              };
              tempImg.onerror = () => {
                clearTimeout(timeout);
                resolve(null);
              };
              tempImg.src = url;
            });
            
            if (imgElement) break;
          }
        }
      }

      if (!imgElement) {
        throw new Error('Изображение не найдено в DOM');
      }

      // Конвертируем через canvas с таймаутом
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Таймаут конвертации изображения в canvas'));
        }, timeoutMs);

        try {
          const canvas = document.createElement('canvas');
          canvas.width = imgElement.naturalWidth || imgElement.width;
          canvas.height = imgElement.naturalHeight || imgElement.height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height);

          const dataUrl = canvas.toDataURL('image/png');
          const base64 = dataUrl.split(',')[1] || dataUrl;
          clearTimeout(timeout);
          log('Изображение конвертировано через canvas, Base64 длина:', base64.length);
          resolve(base64);
        } catch (error) {
          clearTimeout(timeout);
          reject(new Error('Не удалось конвертировать изображение (возможно CORS): ' + error.message));
        }
      });
    }

    // Для http/https — используем fetch с таймаутом и обработкой CORS
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit'
    }, timeoutMs);

    if (!response.ok) {
      // Обработка CORS ошибок
      if (response.status === 0) {
        throw new Error('CORS ошибка: сервер не отвечает. Возможно CORS заблокирован.');
      }
      throw new Error(`HTTP ошибка: ${response.status}`);
    }

    const blob = await response.blob().catch(error => {
      throw new Error('Не удалось получить blob из ответа: ' + error.message);
    });

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        const base64 = result.split(',')[1] || result;
        log('Изображение загружено, Base64 длина:', base64.length);
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    logError('Ошибка загрузки изображения:', error);
    throw error;
  }
}


