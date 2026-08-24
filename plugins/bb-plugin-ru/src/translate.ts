/**
 * Чистая логика перевода: подбор строки по словарю и правила о том, какие узлы
 * DOM трогать нельзя. Здесь нет обращений к DOM API за пределами типов, поэтому
 * модуль целиком покрывается юнит-тестами.
 */

/**
 * Поддеревья, внутри которых мы не переводим ничего и никогда.
 *
 * Это содержимое переписки, а не подписи интерфейса: подменять в нём текст
 * значило бы искажать то, что человек написал или что ответила модель. Ответ
 * агента вроде «Done» — не кнопка «Done».
 *
 * Тела сообщений помечены по-разному в разных версиях bb, поэтому держим оба
 * якоря: `data-markdown-preview` рисует и пузырь пользователя, и markdown
 * ответа агента в 0.39, а `data-message-column` появился в более новой ленте.
 * Лишний селектор безвреден, отсутствующий — дыра в защите.
 */
export const PROTECTED_SELECTOR = [
  "[data-markdown-preview]",
  "[data-message-column]",
  "[data-timeline-file-diff]",
  "[data-queued-message-row]",
  "[data-prompt-mention]",
  "[data-bb-ru-skip]",
  "pre",
  "code",
  "kbd",
  "samp",
  // Текстовые узлы <style> и <script> — это CSS и JS, а не подписи. Копилка
  // однажды принесла оттуда правило radix, и это прямой путь испортить вёрстку.
  "style",
  "script",
  "noscript",
  "template",
  "svg",
  "textarea",
  "input",
  "select",
  "option",
  '[contenteditable]:not([contenteditable="false"])',
  ".cm-editor",
  ".monaco-editor",
].join(",");

/**
 * Для атрибутов защита уже: поле ввода нельзя трогать по содержимому, но его
 * `placeholder` и `aria-label` — это подписи интерфейса, ради которых плагин и
 * ставят («Search threads», «Reply…»). Здесь остаётся только то, где значение
 * атрибута может быть данными пользователя.
 */
export const ATTRIBUTE_PROTECTED_SELECTOR = [
  "[data-markdown-preview]",
  "[data-message-column]",
  "[data-timeline-file-diff]",
  "[data-prompt-mention]",
  "[data-bb-ru-skip]",
  "pre",
  "code",
  ".cm-editor",
  ".monaco-editor",
  // Внутренности редактора промпта (Tiptap/ProseMirror) трогать нельзя. Он
  // держит своё представление документа и на любую нашу правку атрибута
  // перерисовывает узел обратно: замер в живом bb показал 120 мутаций в
  // секунду в бесконечном пинг-понге. Атрибуты самого редактора — снаружи
  // этого правила, поэтому его aria-label по-прежнему переводится.
  ".ProseMirror *",
  ".tiptap *",
  "style",
  "script",
  "noscript",
  "template",
].join(",");

/**
 * Атрибуты, чьи значения видит пользователь. `data-placeholder` — подсказка
 * редактора Tiptap в поле ввода промпта: bb рисует её через CSS
 * `content: attr(data-placeholder)`, поэтому иначе она осталась бы английской.
 */
export const TRANSLATABLE_ATTRIBUTES = [
  "placeholder",
  "data-placeholder",
  "aria-label",
  "title",
  "alt",
] as const;

/**
 * Строки длиннее этого — почти наверняка не подпись интерфейса.
 *
 * Потолок высокий сознательно: страницы настроек состоят из описаний вроде
 * «Tint browser tabs to tell instances apart.», а они легко перебирают 120
 * символов. Риска это не добавляет — совпадение всё равно точное, а переписка
 * защищена поддеревьями.
 */
export const MAX_STRING_LENGTH = 240;

/** Приводит строку к ключу словаря: без краёв, внутренние пробелы сжаты. */
export function normalizeKey(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Годится ли строка в кандидаты на перевод. Отсекает пустое, слишком длинное и
 * то, в чём нет ни одной латинской буквы (числа, иконки-символы, пути).
 */
export function isCandidateString(raw: string): boolean {
  const key = normalizeKey(raw);
  if (key.length === 0 || key.length > MAX_STRING_LENGTH) return false;
  return /[A-Za-z]/.test(key);
}

const TRAILING_PUNCTUATION = /^(.*?[^\s.:!?…])(\.\.\.|[.:!?…])$/;

/**
 * Ищет перевод для значения из DOM.
 *
 * Возвращает готовую строку замены с сохранёнными краевыми пробелами оригинала
 * (React часто отдаёт текстовые узлы вида `" Настройки "`), либо `null`, если
 * словарь такую строку не знает. Совпадение только точное: это и есть защита от
 * порчи пользовательского текста — случайная фраза человека почти никогда не
 * равна подписи кнопки целиком.
 */
export function translateValue(
  dictionary: Readonly<Record<string, string>>,
  raw: string,
): string | null {
  const edges = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  if (!edges) return null;
  const [, leading, core, trailing] = edges;
  if (!core || !isCandidateString(core)) return null;

  const key = normalizeKey(core);
  let hit = dictionary[key];

  if (hit === undefined) {
    // «Настройки:» и «Загрузка…» живут в словаре без концевого знака.
    const punctuation = TRAILING_PUNCTUATION.exec(key);
    if (punctuation) {
      const base = dictionary[punctuation[1]];
      if (base !== undefined && base.length > 0) hit = base + punctuation[2];
    }
  }

  if (hit === undefined || hit.length === 0 || hit === key) return null;
  return `${leading}${hit}${trailing}`;
}

/**
 * Строки, которые собирать бессмысленно: подпись собрана на ходу из данных
 * пользователя или счётчиков («Codex · 31% 5h», «Open <название треда> —
 * Unread thread succeeded»). Ключом словаря такое быть не может, а список
 * пропусков они забивают.
 */
const DYNAMIC_MARKERS = /[0-9·%]/;
const CYRILLIC = /[А-Яа-яЁё]/;
/** Пути и имена файлов. */
const PATH_LIKE = /[/\\]/;
/**
 * kebab-case — так выглядят имена навыков, плагинов и веток. Проверяем только
 * строки из одного слова: в обычном тексте дефис встречается сплошь
 * («built-in palette», «third-party marketplace»), и отсекать такие фразы
 * означало бы терять живые подписи.
 */
const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
/** Одно слово целиком в нижнем регистре — тоже идентификатор, а не подпись. */
const LONE_LOWERCASE = /^[a-z0-9.]+$/;

/** Ключ для копилки непереведённых строк, либо `null`, если строка не кандидат. */
export function missingKey(
  dictionary: Readonly<Record<string, string>>,
  raw: string,
): string | null {
  if (!isCandidateString(raw)) return null;
  const key = normalizeKey(raw);
  if (dictionary[key] !== undefined) return null;
  // Только осмысленные подписи: минимум две буквы и не одинокий символ.
  if (!/[A-Za-z]{2}/.test(key)) return null;
  if (DYNAMIC_MARKERS.test(key)) return null;
  // Кириллица внутри означает либо уже переведённое, либо чужой текст.
  if (CYRILLIC.test(key)) return null;
  if (PATH_LIKE.test(key)) return null;
  if (IDENTIFIER.test(key)) return null;
  if (LONE_LOWERCASE.test(key)) return null;
  return key;
}
