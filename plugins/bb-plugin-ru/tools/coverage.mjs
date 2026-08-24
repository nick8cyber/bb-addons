#!/usr/bin/env node
/**
 * Замер покрытия перевода по живому интерфейсу bb.
 *
 * Обходит маршруты в headless-браузере, ждёт, пока перевод устоится, и считает
 * видимые текстовые узлы: сколько русских, сколько ещё английских. Считает
 * только то, что плагин имеет право переводить — переписка, код и поля ввода
 * исключены теми же селекторами, что и в самом плагине.
 *
 * Запуск:  node tools/coverage.mjs [маршрут…]
 * Нужен playwright и запущенный bb на 127.0.0.1:38886.
 *
 * Считаются УЗЛЫ, а не различные строки, поэтому длинная однообразная страница
 * (например, горячие клавиши) весит в итоге больше короткой. Смотри разбивку по
 * маршрутам, а не только итог.
 */
import { writeFileSync } from "node:fs";

import { chromium } from "playwright";

const BASE = process.env.BB_URL ?? "http://127.0.0.1:38886";

/** Маршруты самого bb плюс каталоги: у каталогов текст приходит с сервера. */
const DEFAULT_ROUTES = [
  "/",
  "/settings",
  "/settings/appearance",
  "/settings/keyboard",
  "/settings/files",
  "/settings/machines",
  "/settings/updates",
  "/settings/providers",
  "/settings/experiments",
  "/settings/archived",
  "/settings/usage",
  "/settings/marketplaces",
  "/settings/community",
  "/settings/plugins/ru",
  "/settings/plugins/memory",
  "/settings/plugins/tasks",
  "/extensions/plugins?view=installed",
  "/extensions/skills",
  "/automations",
  "/skills",
];

const PROTECTED = [
  "[data-markdown-preview]",
  "[data-message-column]",
  "[data-timeline-file-diff]",
  "[data-queued-message-row]",
  "[data-prompt-mention]",
  "pre",
  "code",
  "kbd",
  "samp",
  "style",
  "script",
  "textarea",
  "input",
  "select",
  "option",
  '[contenteditable]:not([contenteditable="false"])',
  ".cm-editor",
  ".monaco-editor",
].join(",");

const routes = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_ROUTES;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const english = new Map();
let totalEn = 0;
let totalRu = 0;

for (const route of routes) {
  try {
    await page.goto(`${BASE}${route}`, {
      waitUntil: "networkidle",
      timeout: 25000,
    });
    // Ждём, пока перевод устоится: React дорисовывает, плагин догоняет.
    await page
      .waitForFunction(
        () => {
          let count = 0;
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
          );
          let node;
          while ((node = walker.nextNode())) {
            if (/[А-Яа-яЁё]/.test(node.data)) count += 1;
          }
          const previous = window.__ruPrev ?? -1;
          window.__ruPrev = count;
          return previous === count && count > 0;
        },
        { timeout: 12000, polling: 600 },
      )
      .catch(() => {});
    await page.waitForTimeout(900);

    const result = await page.evaluate((protectedSelector) => {
      const en = [];
      let ru = 0;
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(protectedSelector)) continue;
        if (!parent.offsetParent && parent.tagName !== "BODY") continue;
        const text = node.data.replace(/\s+/g, " ").trim();
        if (text.length < 2) continue;
        if (/[А-Яа-яЁё]/.test(text)) {
          ru += 1;
          continue;
        }
        if (!/[A-Za-z]{2}/.test(text)) continue;
        if (/[/\\]/.test(text)) continue;
        if (/^[a-z0-9.+-]+$/.test(text)) continue;
        en.push(text);
      }
      return { en, ru };
    }, PROTECTED);

    totalEn += result.en.length;
    totalRu += result.ru;
    for (const text of result.en) {
      english.set(text, (english.get(text) ?? 0) + 1);
    }
    const share = (100 * result.ru) / (result.ru + result.en.length || 1);
    console.log(
      `${route.padEnd(40)} EN ${String(result.en.length).padStart(4)}   RU ${String(result.ru).padStart(4)}   ${share.toFixed(0)}%`,
    );
  } catch (error) {
    console.log(`${route.padEnd(40)} ошибка: ${String(error).slice(0, 60)}`);
  }
}

const share = (100 * totalRu) / (totalRu + totalEn || 1);
console.log(
  `\nИТОГО узлов: EN ${totalEn}, RU ${totalRu} → покрытие ${share.toFixed(1)}%`,
);
console.log(`уникальных английских строк: ${english.size}`);
for (const [text, count] of [...english.entries()]
  .sort((left, right) => right[1] - left[1])
  .slice(0, 40)) {
  console.log(`  ${String(count).padStart(3)}  ${text.slice(0, 90)}`);
}

writeFileSync(
  "coverage-report.json",
  JSON.stringify(
    [...english.entries()].map(([text, count]) => ({ text, count })),
    null,
    1,
  ),
);
await browser.close();
