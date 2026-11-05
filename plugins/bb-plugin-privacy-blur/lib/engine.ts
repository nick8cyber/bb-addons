// Движок размытия. DOM не переписывает: совпадения помечаются через
// CSS Custom Highlight API (::highlight), поэтому React-деревья bb не ломаются.
// Где Highlight API нет — размывается родительский элемент совпадения.
import { createDetector, type Detector } from "./patterns";

export const HIGHLIGHT_NAME = "bb-privacy-blur";
export const ROOT_CLASS = "bb-privacy-blur-on";
export const IGNORE_ATTR = "data-privacy-blur-ignore";
const HIT_ATTR = "data-privacy-blur-hit";
const STORAGE_KEY = "bb-privacy-blur:enabled";
// Последние настройки с сервера: при включении слова доступны сразу, до ответа RPC.
const OPTIONS_CACHE_KEY = "bb-privacy-blur:options";

export interface EngineOptions {
  terms: string[];
  blurInputs: boolean;
  blurTerminal: boolean;
  blurAvatars: boolean;
  blurThreadTitles: boolean;
  detectNames: boolean;
  extraSelectors: string;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  terms: [],
  blurInputs: true,
  blurTerminal: true,
  blurAvatars: true,
  blurThreadTitles: false,
  detectNames: false,
  extraSelectors: "",
};

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH"]);

// Минимальные типы Highlight API: в lib.dom старых TypeScript их может не быть.
interface HighlightLike {
  add(range: AbstractRange): void;
  delete(range: AbstractRange): boolean;
  clear(): void;
}
type HighlightCtor = new (...ranges: AbstractRange[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): boolean;
}

function highlightApi(): { ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
  const ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined)?.highlights;
  return ctor && registry ? { ctor, registry } : null;
}

export function buildCss(options: EngineOptions): string {
  const on = `html.${ROOT_CLASS}`;
  const blurred: string[] = [`${on} [${HIT_ATTR}]`];
  if (options.blurInputs) {
    blurred.push(
      `${on} input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=color]):not(:focus)`,
      `${on} textarea:not(:focus)`,
      `${on} select:not(:focus)`,
    );
  }
  if (options.blurTerminal) blurred.push(`${on} .xterm`, `${on} .xterm-screen`);
  if (options.blurAvatars) {
    blurred.push(
      `${on} img[src*="avatar" i]`,
      `${on} img[alt*="avatar" i]`,
      `${on} img[src*="gravatar" i]`,
      `${on} img[src*="githubusercontent" i]`,
      `${on} [data-slot="avatar"] img`,
    );
  }
  if (options.blurThreadTitles) {
    blurred.push(
      `${on} [data-sidebar-thread-id] > span`,
      `${on} .bb-thread-title`,
    );
  }
  for (const raw of options.extraSelectors.split(/[\n,]/)) {
    const selector = raw.trim();
    if (selector && isValidSelector(selector)) blurred.push(`${on} ${selector}`);
  }
  return [
    // Текстовые совпадения: прозрачный текст + размытая «тень» + серая подложка.
    // Плашка непрозрачная: форма букв не угадывается даже без поддержки text-shadow.
    `::highlight(${HIGHLIGHT_NAME}) {`,
    `  color: transparent;`,
    `  -webkit-text-fill-color: transparent;`,
    `  background-color: rgb(140, 140, 140);`,
    `  text-shadow: 0 0 5px rgb(140, 140, 140), 0 0 10px rgb(140, 140, 140);`,
    `  text-decoration: none;`,
    `}`,
    `${blurred.join(",\n")} {`,
    `  filter: blur(7px) !important;`,
    `  transition: filter 120ms ease;`,
    `}`,
  ].join("\n");
}

function isValidSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** Кэш из localStorage — недоверенный ввод: берём только поля нужных типов. */
export function parseCachedOptions(raw: string): Partial<EngineOptions> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: Partial<EngineOptions> = {};
  if (Array.isArray(record.terms)) {
    out.terms = record.terms.filter((term): term is string => typeof term === "string").slice(0, 2000);
  }
  for (const key of ["blurInputs", "blurTerminal", "blurAvatars", "blurThreadTitles", "detectNames"] as const) {
    if (typeof record[key] === "boolean") out[key] = record[key];
  }
  if (typeof record.extraSelectors === "string") out.extraSelectors = record.extraSelectors;
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

type Listener = (enabled: boolean) => void;

export class PrivacyBlurEngine {
  private enabled = false;
  private options: EngineOptions = { ...DEFAULT_OPTIONS };
  private detector: Detector = createDetector([], { names: DEFAULT_OPTIONS.detectNames });
  /** Слова, собранные во фронтенде: заголовки тредов, имена серверов, хост страницы. */
  private clientTerms: string[] = [];
  private threadTitles: string[] = [];
  private readonly ranges = new Map<Text, Range[]>();
  private readonly hitElements = new Set<Element>();
  private highlight: HighlightLike | null = null;
  private style: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private readonly dirty = new Set<Node>();
  private pruneNeeded = false;
  private readonly listeners = new Set<Listener>();
  private readonly api = highlightApi();

  isEnabled(): boolean {
    return this.enabled;
  }



  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Восстановить сохранённое состояние вкладки. */
  restore(): void {
    try {
      const cached = localStorage.getItem(OPTIONS_CACHE_KEY);
      if (cached) this.applyOptions(parseCachedOptions(cached));
    } catch {
      // Битый кэш — остаются значения по умолчанию.
    }
    let saved = false;
    try {
      saved = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      saved = false;
    }
    this.setEnabled(saved, { persist: false });
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  setEnabled(next: boolean, { persist = true }: { persist?: boolean } = {}): void {
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Хранилище недоступно — состояние живёт до перезагрузки.
      }
    }
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) this.start();
    else this.stop();
    for (const listener of this.listeners) listener(next);
  }

  setOptions(options: Partial<EngineOptions>): void {
    this.applyOptions(options);
    try {
      localStorage.setItem(OPTIONS_CACHE_KEY, JSON.stringify(this.options));
    } catch {
      // Кэш недоступен — слова придут при следующем включении.
    }
  }

  private applyOptions(options: Partial<EngineOptions>): void {
    this.options = { ...this.options, ...options };
    this.rebuild();
  }

  /** Слова из хуков фронтенда; не кэшируются — приходят сразу при монтировании. */
  setClientTerms(terms: readonly string[], threadTitles: readonly string[] = []): void {
    if (sameList(terms, this.clientTerms) && sameList(threadTitles, this.threadTitles)) return;
    this.clientTerms = [...terms];
    this.threadTitles = [...threadTitles];
    this.rebuild();
  }

  private rebuild(): void {
    const terms = [...this.options.terms, ...this.clientTerms];
    // Заголовки тредов — словами, чтобы скрыть их везде: шапка, списки, упоминания.
    if (this.options.blurThreadTitles) terms.push(...this.threadTitles);
    this.detector = createDetector(terms, {
      names: this.options.detectNames,
    });
    if (this.style) this.style.textContent = buildCss(this.options);
    if (this.enabled) this.rescanAll();
  }

  /** Полная очистка: снимает класс, стили, наблюдатель и все пометки. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private start(): void {
    const root = document.documentElement;
    this.style = document.createElement("style");
    this.style.setAttribute("data-privacy-blur", "");
    this.style.textContent = buildCss(this.options);
    document.head.appendChild(this.style);
    root.classList.add(ROOT_CLASS);
    if (this.api) {
      this.highlight = new this.api.ctor();
      this.api.registry.set(HIGHLIGHT_NAME, this.highlight);
    }
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.rescanAll();
  }

  private stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.dirty.clear();
    this.highlight?.clear();
    this.api?.registry.delete(HIGHLIGHT_NAME);
    this.highlight = null;
    this.ranges.clear();
    for (const element of this.hitElements) element.removeAttribute(HIT_ATTR);
    this.hitElements.clear();
    document.documentElement.classList.remove(ROOT_CLASS);
    this.style?.remove();
    this.style = null;
  }

  private rescanAll(): void {
    this.highlight?.clear();
    this.ranges.clear();
    for (const element of this.hitElements) element.removeAttribute(HIT_ATTR);
    this.hitElements.clear();
    this.scanSubtree(document.body);
  }

  private onMutations(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === "characterData") {
        this.dirty.add(record.target);
      } else {
        record.addedNodes.forEach((node) => this.dirty.add(node));
        if (record.removedNodes.length > 0) this.pruneNeeded = true;
      }
    }
    // Синхронно: колбэк MutationObserver — микрозадача до отрисовки, поэтому
    // новый текст ни одного кадра не виден открытым.
    this.flush();
  }

  private flush(): void {
    if (!this.enabled) return;
    if (this.pruneNeeded) {
      this.pruneNeeded = false;
      for (const [node, ranges] of this.ranges) {
        if (!node.isConnected) {
          for (const range of ranges) this.highlight?.delete(range);
          this.ranges.delete(node);
        }
      }
      for (const element of this.hitElements) {
        if (!element.isConnected) this.hitElements.delete(element);
      }
    }
    const nodes = [...this.dirty];
    this.dirty.clear();
    for (const node of nodes) {
      if (!node.isConnected) continue;
      if (node.nodeType === Node.TEXT_NODE) this.scanText(node as Text);
      else if (node.nodeType === Node.ELEMENT_NODE) this.scanSubtree(node);
    }
  }

  private scanSubtree(root: Node): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      this.scanText(node as Text);
    }
  }

  private isSkipped(text: Text): boolean {
    const parent = text.parentElement;
    if (!parent) return true;
    if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return true;
    return parent.closest(`[${IGNORE_ATTR}]`) !== null;
  }

  private scanText(text: Text): void {
    const previous = this.ranges.get(text);
    if (previous) {
      for (const range of previous) this.highlight?.delete(range);
      this.ranges.delete(text);
    }
    if (this.isSkipped(text)) return;
    const value = text.data;
    const spans = this.detector.find(value);
    if (spans.length === 0) return;
    if (!this.highlight) {
      const parent = text.parentElement!;
      parent.setAttribute(HIT_ATTR, "");
      this.hitElements.add(parent);
      return;
    }
    const ranges: Range[] = [];
    for (const span of spans) {
      const range = document.createRange();
      range.setStart(text, span.start);
      range.setEnd(text, Math.min(span.end, value.length));
      this.highlight.add(range);
      ranges.push(range);
    }
    this.ranges.set(text, ranges);
  }
}
