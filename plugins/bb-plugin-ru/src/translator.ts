/**
 * Подмена подписей интерфейса в живом DOM приложения bb.
 *
 * У bb нет слоя i18n: строки зашиты в JSX. Поэтому русификатор работает как
 * контент-скрипт — обходит текстовые узлы и переводит те, что точно совпали со
 * словарём, а MutationObserver догоняет всё, что React отрисовал позже.
 *
 * Каждая подмена запоминает оригинал, поэтому `revert()` возвращает интерфейс к
 * английскому без перезагрузки окна.
 */

import {
  ATTRIBUTE_PROTECTED_SELECTOR,
  PROTECTED_SELECTOR,
  TRANSLATABLE_ATTRIBUTES,
  missingKey,
  translateValue,
} from "./translate.js";

export interface TranslatorStats {
  /** Сколько текстовых узлов сейчас держат русский текст. */
  readonly textNodes: number;
  /** Сколько атрибутов сейчас держат русский текст. */
  readonly attributes: number;
  /** Сколько уникальных строк словарь не знает (если сбор включён). */
  readonly missing: number;
}

export interface TranslatorOptions {
  dictionary: Readonly<Record<string, string>>;
  /** Корень наблюдения; по умолчанию `document.body`. */
  root?: Element;
  /** Собирать строки, которых нет в словаре. */
  collectMissing?: boolean;
  /** Пачка новых непереведённых строк — не чаще раза в `flushDelayMs`. */
  onMissing?: (keys: readonly string[]) => void;
  /** Задержка отправки копилки, мс. */
  flushDelayMs?: number;
}

const MISSING_CAP = 2000;
const TOUCHED_PRUNE_THRESHOLD = 4000;

export class Translator {
  private readonly dictionary: Readonly<Record<string, string>>;
  private readonly root: Element;
  private readonly onMissing: ((keys: readonly string[]) => void) | undefined;
  private readonly flushDelayMs: number;

  private collectMissing: boolean;
  private enabled = false;
  private observer: MutationObserver | null = null;

  /** Что мы записали сами: защита от повторной обработки и от циклов. */
  private readonly writtenText = new WeakMap<Text, string>();
  private readonly originalText = new WeakMap<Text, string>();
  private readonly touchedText = new Set<Text>();

  private readonly writtenAttributes = new WeakMap<
    Element,
    Map<string, string>
  >();
  private readonly originalAttributes = new WeakMap<
    Element,
    Map<string, string | null>
  >();
  private readonly touchedAttributes = new Set<Element>();

  private readonly missing = new Map<string, number>();
  private pendingMissing: string[] = [];
  private missingTimer: ReturnType<typeof setTimeout> | null = null;

  private queue = new Set<Node>();
  private flushHandle: number | null = null;

  constructor(options: TranslatorOptions) {
    this.dictionary = options.dictionary;
    this.root = options.root ?? document.body;
    this.collectMissing = options.collectMissing ?? false;
    this.onMissing = options.onMissing;
    this.flushDelayMs = options.flushDelayMs ?? 2000;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  stats(): TranslatorStats {
    let attributes = 0;
    for (const element of this.touchedAttributes) {
      attributes += this.writtenAttributes.get(element)?.size ?? 0;
    }
    return {
      textNodes: this.touchedText.size,
      attributes,
      missing: this.missing.size,
    };
  }

  setCollectMissing(collect: boolean): void {
    this.collectMissing = collect;
  }

  /** Включает перевод: разовый проход по документу плюс наблюдение. */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.translateSubtree(this.root);
    this.flushMissingSoon();

    this.observer = new MutationObserver((records) => {
      if (!this.enabled) return;
      for (const record of records) {
        if (record.type === "characterData") {
          this.queue.add(record.target);
        } else if (record.type === "attributes") {
          this.queue.add(record.target);
        } else {
          for (const added of record.addedNodes) this.queue.add(added);
        }
      }
      if (this.queue.size > 0) this.scheduleFlush();
    });
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });
  }

  /** Выключает перевод и возвращает английские подписи на место. */
  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.cancelFlush();
    if (this.missingTimer !== null) {
      clearTimeout(this.missingTimer);
      this.missingTimer = null;
    }
    this.enabled = false;
    this.revert();
  }

  /** Немедленно обрабатывает отложенную очередь (нужно тестам). */
  flush(): void {
    this.cancelFlush();
    const queued = this.queue;
    this.queue = new Set();
    for (const node of queued) {
      if (!node.isConnected) continue;
      this.translateSubtree(node);
    }
    this.pruneTouched();
    this.flushMissingSoon();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback: FrameRequestCallback) =>
            setTimeout(() => callback(0), 16) as unknown as number;
    this.flushHandle = raf(() => {
      this.flushHandle = null;
      if (this.enabled) this.flush();
    }) as unknown as number;
  }

  private cancelFlush(): void {
    if (this.flushHandle === null) return;
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.flushHandle);
    } else {
      clearTimeout(this.flushHandle as unknown as ReturnType<typeof setTimeout>);
    }
    this.flushHandle = null;
  }

  private translateSubtree(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      this.translateTextNode(node as Text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    // Слабая граница: внутри поля ввода ещё есть что переводить (подсказки),
    // а его содержимое отсечёт проверка каждого текстового узла.
    if (element.closest(ATTRIBUTE_PROTECTED_SELECTOR) !== null) return;

    this.translateAttributes(element);

    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (candidate: Node) =>
          candidate.nodeType === Node.ELEMENT_NODE &&
          (candidate as Element).matches(ATTRIBUTE_PROTECTED_SELECTOR)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      },
    );

    let current = walker.nextNode();
    while (current !== null) {
      if (current.nodeType === Node.TEXT_NODE) {
        this.translateTextNode(current as Text);
      } else {
        this.translateAttributes(current as Element);
      }
      current = walker.nextNode();
    }
  }

  private translateTextNode(node: Text): void {
    // Уже наша строка и с тех пор не менялась — работы нет.
    if (this.writtenText.get(node) === node.data) return;
    if (node.parentElement === null) return;
    if (node.parentElement.closest(PROTECTED_SELECTOR) !== null) return;

    const next = translateValue(this.dictionary, node.data);
    if (next === null) {
      this.recordMissing(node.data);
      return;
    }
    if (next === node.data) return;

    if (!this.originalText.has(node)) this.originalText.set(node, node.data);
    node.data = next;
    this.writtenText.set(node, next);
    this.touchedText.add(node);
  }

  private translateAttributes(element: Element): void {
    if (element.closest(ATTRIBUTE_PROTECTED_SELECTOR) !== null) return;

    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (this.writtenAttributes.get(element)?.get(attribute) === value) {
        continue;
      }

      const next = translateValue(this.dictionary, value);
      if (next === null) {
        this.recordMissing(value);
        continue;
      }
      if (next === value) continue;

      let originals = this.originalAttributes.get(element);
      if (originals === undefined) {
        originals = new Map();
        this.originalAttributes.set(element, originals);
      }
      if (!originals.has(attribute)) originals.set(attribute, value);

      element.setAttribute(attribute, next);

      let written = this.writtenAttributes.get(element);
      if (written === undefined) {
        written = new Map();
        this.writtenAttributes.set(element, written);
      }
      written.set(attribute, next);
      this.touchedAttributes.add(element);
    }
  }

  /** Возвращает оригинальные подписи всем узлам, которые мы меняли. */
  revert(): void {
    for (const node of this.touchedText) {
      const original = this.originalText.get(node);
      if (original === undefined) continue;
      // Если поверх нашей строки уже написал кто-то другой — не мешаем ему.
      if (node.data === this.writtenText.get(node)) node.data = original;
      this.writtenText.delete(node);
      this.originalText.delete(node);
    }
    this.touchedText.clear();

    for (const element of this.touchedAttributes) {
      const originals = this.originalAttributes.get(element);
      const written = this.writtenAttributes.get(element);
      if (originals === undefined) continue;
      for (const [attribute, original] of originals) {
        if (element.getAttribute(attribute) !== written?.get(attribute)) {
          continue;
        }
        if (original === null) element.removeAttribute(attribute);
        else element.setAttribute(attribute, original);
      }
      this.originalAttributes.delete(element);
      this.writtenAttributes.delete(element);
    }
    this.touchedAttributes.clear();
  }

  /** Непереведённые строки, самые частые первыми. */
  missingStrings(limit = 100): readonly { text: string; count: number }[] {
    return [...this.missing.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((left, right) => right.count - left.count || (left.text < right.text ? -1 : 1))
      .slice(0, limit);
  }

  private recordMissing(raw: string): void {
    if (!this.collectMissing) return;
    const key = missingKey(this.dictionary, raw);
    if (key === null) return;

    const seen = this.missing.get(key);
    if (seen !== undefined) {
      this.missing.set(key, seen + 1);
      return;
    }
    if (this.missing.size >= MISSING_CAP) return;
    this.missing.set(key, 1);
    this.pendingMissing.push(key);
  }

  private flushMissingSoon(): void {
    if (this.onMissing === undefined) return;
    if (this.pendingMissing.length === 0) return;
    if (this.missingTimer !== null) return;
    this.missingTimer = setTimeout(() => {
      this.missingTimer = null;
      const batch = this.pendingMissing;
      this.pendingMissing = [];
      if (batch.length > 0) this.onMissing?.(batch);
    }, this.flushDelayMs);
  }

  /**
   * Множество тронутых узлов держит на них сильные ссылки — иначе нечего было бы
   * возвращать при выключении. Отсоединённые от документа узлы отпускаем.
   */
  private pruneTouched(): void {
    if (this.touchedText.size > TOUCHED_PRUNE_THRESHOLD) {
      for (const node of this.touchedText) {
        if (!node.isConnected) this.touchedText.delete(node);
      }
    }
    if (this.touchedAttributes.size > TOUCHED_PRUNE_THRESHOLD) {
      for (const element of this.touchedAttributes) {
        if (!element.isConnected) this.touchedAttributes.delete(element);
      }
    }
  }
}
