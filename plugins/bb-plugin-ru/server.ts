/**
 * Бэкенд русификатора.
 *
 * Сам перевод живёт во фронтенде (app.tsx + src/): словарь встроен в бандл, а
 * подмена идёт в DOM. Серверу остаётся то, ради чего словарь можно поддерживать
 * дальше — копилка строк, которых в словаре нет. Фронтенд присылает их пачками,
 * а `bb ru missing` показывает самые частые: это и есть рабочий список на
 * следующий проход перевода.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Больше этого в одной пачке не принимаем. */
const MAX_BATCH = 200;
/** Строки длиннее — не подписи интерфейса. */
const MAX_TEXT_LENGTH = 200;
/** Верхняя граница таблицы, чтобы копилка не росла бесконечно. */
const MAX_ROWS = 5000;

const missingRow = z.object({
  text: z.string(),
  count: z.number().int().nonnegative(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

export const rpcContract = defineRpcContract({
  /** Фронтенд сообщает строки, которых нет в словаре. */
  reportMissing: {
    input: z.object({ strings: z.array(z.string()).max(MAX_BATCH) }).strict(),
    output: z
      .object({ accepted: z.number().int(), collecting: z.boolean() })
      .strict(),
  },
  /** Состояние копилки для страницы настроек. */
  status: {
    input: z.null(),
    output: z
      .object({ collecting: z.boolean(), missingCount: z.number().int() })
      .strict(),
  },
  /** Самые частые непереведённые строки. */
  listMissing: {
    input: z.object({ limit: z.number().int().min(1).max(500) }).strict(),
    output: z.object({ rows: z.array(missingRow) }).strict(),
  },
  clearMissing: {
    input: z.null(),
    output: z.object({ removed: z.number().int() }).strict(),
  },
});

interface MissingRow {
  text: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    collectMissing: {
      type: "boolean",
      label: "Собирать непереведённые строки",
      default: false,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS missing_strings (
       text TEXT PRIMARY KEY,
       count INTEGER NOT NULL DEFAULT 1,
       first_seen_at TEXT NOT NULL,
       last_seen_at TEXT NOT NULL
     )`,
  ]);

  const upsert = db.prepare<[string, string, string]>(
    `INSERT INTO missing_strings (text, count, first_seen_at, last_seen_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(text) DO UPDATE SET
       count = count + 1,
       last_seen_at = excluded.last_seen_at`,
  );
  const countRows = db.prepare(
    `SELECT COUNT(*) AS total FROM missing_strings`,
  );
  const selectTop = db.prepare<[number]>(
    `SELECT text, count, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
       FROM missing_strings
      ORDER BY count DESC, text ASC
      LIMIT ?`,
  );

  const total = () =>
    (countRows.get() as { total: number } | undefined)?.total ?? 0;

  const insertBatch = db.transaction((texts: readonly string[]) => {
    let accepted = 0;
    let room = MAX_ROWS - total();
    for (const raw of texts) {
      const text = raw.replace(/\s+/g, " ").trim();
      if (text.length === 0 || text.length > MAX_TEXT_LENGTH) continue;
      const existing = db
        .prepare<[string]>(`SELECT 1 FROM missing_strings WHERE text = ?`)
        .get(text);
      if (existing === undefined) {
        if (room <= 0) continue;
        room -= 1;
      }
      const now = new Date().toISOString();
      upsert.run(text, now, now);
      accepted += 1;
    }
    return accepted;
  });

  bb.rpc.register(rpcContract, {
    async reportMissing({ strings }) {
      const { collectMissing } = await settings.get();
      // Выключенный сбор — не ошибка: фронтенд узнаёт об этом из ответа и
      // перестаёт присылать пачки.
      if (!collectMissing) return { accepted: 0, collecting: false };
      return { accepted: insertBatch(strings), collecting: true };
    },
    async status() {
      const { collectMissing } = await settings.get();
      return { collecting: collectMissing, missingCount: total() };
    },
    listMissing({ limit }) {
      return { rows: selectTop.all(limit) as MissingRow[] };
    },
    clearMissing() {
      const removed = total();
      db.prepare(`DELETE FROM missing_strings`).run();
      return { removed };
    },
  });

  bb.cli.register({
    name: "ru",
    summary: "Русификатор интерфейса bb: состояние словаря и непереведённые строки",
    commands: [
      { name: "stats", summary: "Сколько строк собрано", usage: "bb ru stats" },
      {
        name: "missing",
        summary: "Самые частые непереведённые строки",
        usage: "bb ru missing [--limit N] [--json]",
      },
      {
        name: "clear",
        summary: "Очистить копилку непереведённых строк",
        usage: "bb ru clear",
      },
    ],
    async run(argv) {
      const [command = "stats"] = argv;
      const json = argv.includes("--json");
      const limitFlag = argv.indexOf("--limit");
      const limitRaw =
        limitFlag === -1 ? undefined : Number(argv[limitFlag + 1]);
      const limit =
        limitRaw !== undefined && Number.isInteger(limitRaw) && limitRaw > 0
          ? Math.min(limitRaw, 500)
          : 50;

      const { collectMissing } = await settings.get();

      if (command === "stats") {
        const payload = { collecting: collectMissing, missingCount: total() };
        if (json) return { exitCode: 0, stdout: JSON.stringify(payload) };
        return {
          exitCode: 0,
          stdout:
            `сбор: ${collectMissing ? "включён" : "выключен"}\n` +
            `непереведённых строк: ${payload.missingCount}\n` +
            (collectMissing
              ? ""
              : "включить: bb plugin config ru set collectMissing true\n"),
        };
      }

      if (command === "missing") {
        const rows = selectTop.all(limit) as MissingRow[];
        if (json) return { exitCode: 0, stdout: JSON.stringify({ rows })  };
        if (rows.length === 0) {
          return {
            exitCode: 0,
            stdout: collectMissing
              ? "Пока ничего не собрано — открой интерфейс bb и вернись.\n"
              : "Сбор выключен: bb plugin config ru set collectMissing true\n",
          };
        }
        const width = Math.min(
          80,
          rows.reduce((max, row) => Math.max(max, row.text.length), 0),
        );
        return {
          exitCode: 0,
          stdout:
            rows
              .map((row) => `${String(row.count).padStart(5)}  ${row.text.padEnd(width)}`)
              .join("\n") + "\n",
        };
      }

      if (command === "clear") {
        const removed = total();
        db.prepare(`DELETE FROM missing_strings`).run();
        return { exitCode: 0, stdout: `удалено строк: ${removed}\n` };
      }

      return {
        exitCode: 1,
        stderr: `неизвестная команда: ${command}\nдоступно: stats, missing, clear\n`,
      };
    },
  });

  bb.log.info("русификатор загружен");
}
