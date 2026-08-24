// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Translator } from "./translator.js";

const DICT = {
  Settings: "Настройки",
  "New thread": "Новый тред",
  "Search files": "Поиск файлов",
  Send: "Отправить",
};

let root: HTMLElement;
let translator: Translator | null = null;

function html(markup: string): void {
  root.innerHTML = markup;
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  translator?.stop();
  translator = null;
});

function start(
  options: Partial<ConstructorParameters<typeof Translator>[0]> = {},
) {
  translator = new Translator({ dictionary: DICT, root, ...options });
  translator.start();
  return translator;
}

describe("перевод подписей", () => {
  it("переводит текстовые узлы интерфейса", () => {
    html(`<button>Settings</button><span> New thread </span>`);
    start();
    expect(root.querySelector("button")?.textContent).toBe("Настройки");
    expect(root.querySelector("span")?.textContent).toBe(" Новый тред ");
  });

  it("переводит placeholder, aria-label и title", () => {
    html(
      `<input placeholder="Search files" aria-label="Send" />` +
        `<a title="Settings" href="#">x</a>`,
    );
    start();
    const input = root.querySelector("input")!;
    // Подсказка поля ввода — подпись интерфейса, её переводим…
    expect(input.getAttribute("placeholder")).toBe("Поиск файлов");
    expect(input.getAttribute("aria-label")).toBe("Отправить");
    expect(root.querySelector("a")?.getAttribute("title")).toBe("Настройки");
  });

  it("переводит подсказку поля, но не его содержимое", () => {
    html(`<textarea placeholder="Search files">New thread</textarea>`);
    start();
    const textarea = root.querySelector("textarea")!;
    // …а вот значение поля — это то, что печатает человек.
    expect(textarea.getAttribute("placeholder")).toBe("Поиск файлов");
    expect(textarea.textContent).toBe("New thread");
  });

  it("не переводит подсказки внутри переписки", () => {
    html(`<div data-message-column=""><a title="Settings" href="#">x</a></div>`);
    start();
    expect(root.querySelector("a")?.getAttribute("title")).toBe("Settings");
  });

  it("переводит подсказки у обычных элементов", () => {
    html(`<div aria-label="Search files"><button title="Send">go</button></div>`);
    start();
    expect(root.querySelector("div")?.getAttribute("aria-label")).toBe(
      "Поиск файлов",
    );
    expect(root.querySelector("button")?.getAttribute("title")).toBe(
      "Отправить",
    );
  });
});

describe("защищённые области", () => {
  it("не трогает тела сообщений переписки", () => {
    html(`<div data-message-column=""><p>Settings</p></div>`);
    start();
    expect(root.querySelector("p")?.textContent).toBe("Settings");
  });

  it("не трогает код, поля ввода и редактируемый текст", () => {
    html(
      `<pre>Settings</pre><code>Send</code>` +
        `<textarea>Settings</textarea>` +
        `<div contenteditable="true">New thread</div>` +
        `<div contenteditable="false">New thread</div>`,
    );
    start();
    expect(root.querySelector("pre")?.textContent).toBe("Settings");
    expect(root.querySelector("code")?.textContent).toBe("Send");
    expect(root.querySelector("textarea")?.textContent).toBe("Settings");
    expect(
      root.querySelector('[contenteditable="true"]')?.textContent,
    ).toBe("New thread");
    // contenteditable="false" — обычный текст, его переводим.
    expect(
      root.querySelector('[contenteditable="false"]')?.textContent,
    ).toBe("Новый тред");
  });

  it("уважает явный отказ через data-bb-ru-skip", () => {
    html(`<div data-bb-ru-skip=""><span>Settings</span></div>`);
    start();
    expect(root.querySelector("span")?.textContent).toBe("Settings");
  });
});

describe("догоняющий перевод", () => {
  it("переводит то, что React дорисовал позже", async () => {
    html(`<div id="host"></div>`);
    start();
    const host = root.querySelector("#host")!;
    host.append(document.createElement("button"));
    host.querySelector("button")!.textContent = "Send";

    await vi.waitFor(() => {
      expect(root.querySelector("button")?.textContent).toBe("Отправить");
    });
  });

  it("переводит заново, если React вернул английский текст", async () => {
    html(`<button>Send</button>`);
    start();
    const button = root.querySelector("button")!;
    expect(button.textContent).toBe("Отправить");

    button.firstChild!.nodeValue = "Settings";
    await vi.waitFor(() => {
      expect(button.textContent).toBe("Настройки");
    });
  });

  it("не зацикливается на собственных записях", async () => {
    html(`<button>Send</button>`);
    const instance = start();
    const spy = vi.spyOn(instance as unknown as { revert: () => void }, "revert");
    for (let index = 0; index < 5; index += 1) instance.flush();
    expect(root.querySelector("button")?.textContent).toBe("Отправить");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("возврат к английскому", () => {
  it("восстанавливает текст и атрибуты при выключении", () => {
    html(`<button title="Send">Settings</button>`);
    const instance = start();
    expect(root.querySelector("button")?.textContent).toBe("Настройки");

    instance.stop();
    translator = null;

    const button = root.querySelector("button")!;
    expect(button.textContent).toBe("Settings");
    expect(button.getAttribute("title")).toBe("Send");
  });

  it("не перетирает текст, который после нас изменил кто-то другой", () => {
    html(`<button>Settings</button>`);
    const instance = start();
    const node = root.querySelector("button")!.firstChild!;
    node.nodeValue = "Что-то своё";

    instance.stop();
    translator = null;

    expect(node.nodeValue).toBe("Что-то своё");
  });
});

describe("копилка непереведённых строк", () => {
  it("собирает только то, чего нет в словаре", () => {
    html(`<button>Settings</button><span>Merge base</span><i>42</i>`);
    const instance = start({ collectMissing: true });
    const missing = instance.missingStrings();
    expect(missing.map((row) => row.text)).toEqual(["Merge base"]);
  });

  it("молчит, когда сбор выключен", () => {
    html(`<span>Merge base</span>`);
    const instance = start();
    expect(instance.missingStrings()).toEqual([]);
  });

  it("не собирает содержимое переписки", () => {
    html(`<div data-message-column=""><p>Absolutely unknown phrase</p></div>`);
    const instance = start({ collectMissing: true });
    expect(instance.missingStrings()).toEqual([]);
  });

  it("отдаёт пачку наружу", async () => {
    const onMissing = vi.fn();
    html(`<span>Merge base</span>`);
    start({ collectMissing: true, onMissing, flushDelayMs: 1 });
    await vi.waitFor(() => {
      expect(onMissing).toHaveBeenCalledWith(["Merge base"]);
    });
  });
});

describe("статистика", () => {
  it("считает подписи и подсказки", () => {
    html(`<button title="Send">Settings</button>`);
    const instance = start();
    const current = instance.stats();
    expect(current.textNodes).toBe(1);
    expect(current.attributes).toBe(1);
  });
});

describe("подсказка редактора промпта", () => {
  it("переводит data-placeholder даже внутри contenteditable", () => {
    html(
      `<div contenteditable="true"><p data-placeholder="Search files">New thread</p></div>`,
    );
    start();
    const paragraph = root.querySelector("p")!;
    expect(paragraph.getAttribute("data-placeholder")).toBe("Поиск файлов");
    // Набранный текст остаётся неприкосновенным.
    expect(paragraph.textContent).toBe("New thread");
  });
});

describe("переписка защищена на обеих сборках bb", () => {
  it("не трогает тело сообщения с data-markdown-preview (bb 0.39)", () => {
    html(
      `<div data-timeline-row-id="1"><div data-markdown-preview=""><p>Send</p></div></div>`,
    );
    start();
    expect(root.querySelector("p")?.textContent).toBe("Send");
  });

  it("не трогает дифф и текст сообщения в очереди", () => {
    html(
      `<div data-timeline-file-diff=""><span>Settings</span></div>` +
        `<div data-queued-message-row=""><span>Send</span></div>`,
    );
    start();
    expect(root.querySelector("[data-timeline-file-diff] span")?.textContent).toBe("Settings");
    expect(root.querySelector("[data-queued-message-row] span")?.textContent).toBe("Send");
  });

  it("переводит подписи вокруг сообщения, не заходя внутрь", () => {
    html(
      `<div data-timeline-row-id="1">` +
        `<button title="Copy message">c</button>` +
        `<div data-markdown-preview=""><p>Settings</p></div>` +
        `<span>Send</span>` +
        `</div>`,
    );
    start({ dictionary: { ...DICT, "Copy message": "Копировать сообщение" } });
    expect(root.querySelector("button")?.getAttribute("title")).toBe("Копировать сообщение");
    expect(root.querySelector("p")?.textContent).toBe("Settings");
    expect(root.querySelector("span")?.textContent).toBe("Отправить");
  });
});

describe("редактор промпта", () => {
  it("не трогает внутренние узлы Tiptap, чтобы не устроить пинг-понг", () => {
    html(
      `<div class="tiptap ProseMirror" contenteditable="true" aria-label="Search files">` +
        `<p data-placeholder="Send" class="is-editor-empty"><br /></p>` +
        `</div>`,
    );
    start();
    // Атрибуты самого редактора переводим…
    expect(root.querySelector(".ProseMirror")?.getAttribute("aria-label")).toBe(
      "Поиск файлов",
    );
    // …а его внутреннее оформление оставляем ProseMirror.
    expect(root.querySelector("p")?.getAttribute("data-placeholder")).toBe("Send");
  });
});

describe("служебные теги", () => {
  it("не трогает содержимое style и script", () => {
    html(`<style>.x{content:"Send"}</style><script>var a = "Settings";</script>`);
    const instance = start({ collectMissing: true });
    expect(root.querySelector("style")?.textContent).toBe('.x{content:"Send"}');
    expect(root.querySelector("script")?.textContent).toBe('var a = "Settings";');
    expect(instance.missingStrings()).toEqual([]);
  });
});
