/**
 * orchestrator §18.2 (r32, PLUG-245): общий запускатель команд и журнал
 * `command_runs`. Одна запись журнала = один запуск (spawn detached —
 * каждая команда в своей группе процессов). queued переживает рестарт и
 * запускается заново; running после рестарта сверяется по pid +
 * proc_start — живая группа убивается (SIGTERM → killGraceMs → SIGKILL)
 * и запись уходит в interrupted; повтора команды нет.
 *
 * Произвольные команды запускаются только через этот запускатель:
 * argv списком без shell (sh -c — только если владелец сам так записал),
 * вывод в журнале и логах маскируется (maskCommandOutput).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { maskSecrets } from "./scan.js";
import type { CommandRunRow, CommandRunSpec, DelegationStore } from "./store.js";

/** §18.2: вывод в журнале — хвост до 300 символов в одну строку. */
export const OUTPUT_TAIL_LIMIT = 300;
const RAW_OUTPUT_CAP = 256 * 1024;
export const DEFAULT_KILL_GRACE_MS = 10_000;

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Маскировка вывода/логов команды (§18.2): секреты сканера +
 * пароль в URL, токены glpat/Bearer/key=value; затем — одна строка
 * без управляющих символов, хвост ≤ 300.
 */
export function maskCommandOutput(text: string): string {
  let out = maskSecrets(text);
  out = out.replace(
    /((?:https?|ssh|git):\/\/[^/\s:@]+):[^/\s@]+@/g,
    "$1:***@",
  );
  out = out.replace(/\bglpat-[A-Za-z0-9_-]{8,}/g, "glpat-***");
  out = out.replace(
    /\b(authorization:\s*bearer\s+|bearer\s+)[^\s"']+/gi,
    "$1***",
  );
  out = out.replace(
    /\b(token|password|passwd|secret|api[_-]?key)=([^\s"']+)/gi,
    "$1=***",
  );
  out = out.replace(CONTROL_CHARS, "");
  out = out.replace(/[\r\n]+/g, " ").trim();
  if (out.length > OUTPUT_TAIL_LIMIT) out = out.slice(-OUTPUT_TAIL_LIMIT);
  return out;
}

export interface SpawnResult {
  code: number | null;
  signal: string | null;
  output: string;
  /** §18.3: командам провайдера PR нужны потоки раздельно (JSON, URL —
   * чистый stdout). Необязательны: журнальные фейки отдают только
   * сведённый `output`. */
  stdout?: string;
  stderr?: string;
}

export interface SpawnedCommand {
  pid: number;
  pgid: number;
  done: Promise<SpawnResult>;
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
}

export type CommandSpawner = (spec: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
}) => SpawnedCommand;

/**
 * §18.2: argv списком без shell; detached — лидер в своей группе
 * (pgid === pid), убийство идёт по -pgid, чтобы дети-внучата группы
 * не остались сиротами.
 */
export const defaultSpawner: CommandSpawner = (spec) => {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    detached: true,
    stdio: [spec.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  let stderr = "";
  const cap = (s: string) =>
    s.length > RAW_OUTPUT_CAP ? s.slice(-RAW_OUTPUT_CAP) : s;
  child.stdout?.on("data", (chunk: Buffer) => {
    const t = chunk.toString("utf8");
    output = cap(output + t);
    stdout = cap(stdout + t);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const t = chunk.toString("utf8");
    output = cap(output + t);
    stderr = cap(stderr + t);
  });
  const done = new Promise<SpawnResult>((resolve) => {
    child.once("error", (e) => {
      resolve({
        code: null,
        signal: null,
        output: output + "\n" + e.message,
        stdout,
        stderr: stderr + "\n" + e.message,
      });
    });
    child.once("close", (code, signal) =>
      resolve({ code, signal, output, stdout, stderr }),
    );
  });
  if (spec.stdin !== undefined) {
    child.stdin?.write(spec.stdin);
    child.stdin?.end();
  }
  const pgid = child.pid ?? -1;
  return {
    pid: child.pid ?? -1,
    pgid,
    done,
    killGroup: (signal) => {
      if (pgid <= 0) return; // spawn не поднялся — группы нет
      try {
        process.kill(-pgid, signal);
      } catch {
        /* группа уже мертва */
      }
    },
  };
};

/** starttime (поле 22) из /proc/<pid>/stat — идентификатор воплощения pid. */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
    return after[19] ?? null;
  } catch {
    return null;
  }
}

export function groupAlive(pgid: number): boolean {
  if (pgid <= 0) return false; // недействительная группа — не живая
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killGroupOf(pgid: number, signal: "SIGTERM" | "SIGKILL") {
  if (pgid <= 0) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    /* мертва */
  }
}

export interface CommandRunnerDeps {
  store: DelegationStore;
  spawn?: CommandSpawner;
  procStart?: (pid: number) => string | null;
  alive?: (pgid: number) => boolean;
  killGroup?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Лимит одновременно running (настройка maxConcurrentCommands). */
  maxConcurrent: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  killGraceMs?: number;
  warn?: (msg: string) => void;
}

export interface CommandRunner {
  /** Запустить queued в пределах лимита; одна running на group_key. */
  pump(): Promise<void>;
  /** Рестарт: running + живая группа → убить → interrupted. Без повтора. */
  recover(): Promise<void>;
  /** Остановка плагина: живым группам SIGTERM, записи → interrupted. */
  stopAll(): Promise<void>;
  /** Самоперезагрузка поставлена — новые queued не стартуют в этом
   * процессе, пока не истечёт ttlMs (умолчание 5 мин — PLUG-245 Б3:
   * не сработавшая перезагрузка не держит очередь вечно). */
  holdForSelfReload(ttlMs?: number): void;
  /** §18.5: флаг «остановлен» — после stopAll идущий такт не
   * запускает новых команд (pump пуст) и не берёт замков копии. */
  isStopped(): boolean;
}

const sleepDefault = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** §18.5: окно самоперезагрузки — если автоматизация не перезапустила
 * плагин за это время, очередь снимается с удержания сама. */
export const SELF_RELOAD_HOLD_MS = 5 * 60 * 1000;

export function createCommandRunner(deps: CommandRunnerDeps): CommandRunner {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepDefault;
  const spawner = deps.spawn ?? defaultSpawner;
  const procStart = deps.procStart ?? procStartTime;
  const alive = deps.alive ?? groupAlive;
  const killGroup = deps.killGroup ?? killGroupOf;
  const killGrace = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const warn = deps.warn ?? (() => {});
  const live = new Map<number, SpawnedCommand>();
  let heldUntil: number | null = null;
  let stopped = false;

  const startRow = async (row: CommandRunRow): Promise<boolean> => {
    if (!deps.store.claimCommandRun(row.id, now())) return false;
    let spec: CommandRunSpec;
    try {
      spec = {
        source: row.source,
        runKey: row.run_key,
        groupKey: row.group_key ?? undefined,
        name: row.name,
        argv: JSON.parse(row.argv ?? "[]") as string[],
        cwd: row.cwd ?? "/",
        env: (row.env ? JSON.parse(row.env) : {}) as Record<string, string>,
        stdin: row.stdin ?? undefined,
        timeoutSec: row.timeout_sec ?? undefined,
      };
    } catch (e) {
      deps.store.finishCommandRun(
        row.id,
        "failed",
        127,
        `битая спецификация: ${(e as Error).message}`,
        now(),
      );
      return true;
    }
    let spawned: SpawnedCommand;
    try {
      spawned = spawner({
        argv: spec.argv,
        cwd: spec.cwd,
        env: spec.env ?? {},
        stdin: spec.stdin,
      });
    } catch (e) {
      deps.store.finishCommandRun(
        row.id,
        "failed",
        127,
        maskCommandOutput((e as Error).message),
        now(),
      );
      return true;
    }
    deps.store.attachCommandProcess(
      row.id,
      spawned.pid > 0 ? spawned.pid : null,
      spawned.pgid > 0 ? spawned.pgid : null,
      spawned.pid > 0 ? procStart(spawned.pid) : null,
    );
    live.set(row.id, spawned);
    let timedOut = false;
    let termTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (spec.timeoutSec) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        spawned.killGroup("SIGTERM");
        termTimer = setTimeout(
          () => spawned.killGroup("SIGKILL"),
          killGrace,
        );
        termTimer.unref?.();
      }, spec.timeoutSec * 1000);
      timeoutTimer.unref?.();
    }
    void spawned.done.then((res) => {
      clearTimeout(timeoutTimer);
      clearTimeout(termTimer);
      live.delete(row.id);
      const status = timedOut
        ? "timeout"
        : res.code === 0
          ? "ok"
          : "failed";
      deps.store.finishCommandRun(
        row.id,
        status,
        res.code,
        maskCommandOutput(res.output),
        now(),
      );
    });
    return true;
  };

  return {
    async pump() {
      if (stopped) return; // §18.5: остановлен — новых запусков нет
      if (heldUntil !== null && now() < heldUntil) return;
      heldUntil = null;
      const running = deps.store.runningCommandRuns();
      let slots = Math.max(0, deps.maxConcurrent()) - running.length;
      if (slots <= 0) return;
      const busyGroups = new Set(
        running.map((r) => r.group_key).filter((g): g is string => !!g),
      );
      for (const row of deps.store.queuedCommandRuns()) {
        if (slots <= 0) break;
        if (row.group_key && busyGroups.has(row.group_key)) continue;
        if (await startRow(row)) {
          slots -= 1;
          if (row.group_key) busyGroups.add(row.group_key);
        }
      }
    },

    async recover() {
      for (const row of deps.store.runningCommandRuns()) {
        const pgid = row.pgid ?? -1;
        let kill = false;
        if (pgid > 0) {
          const start =
            row.pid != null && row.pid > 0 ? procStart(row.pid) : null;
          // §18.5: живость смотрим по ГРУППЕ — мёртвый лидер не мешает
          // добить живых детей (pgid не переиспользуется, пока группа
          // жива — alive(pgid) при мёртвом лидере = наши сироты). А вот
          // pid, занятый ЧУЖИМ процессом (proc_start не сошёлся),
          // группу не убивает — защита от переиспользования pid.
          kill =
            start === null ? alive(pgid) : row.proc_start === start;
        }
        if (kill) {
          killGroup(pgid, "SIGTERM");
          await sleep(killGrace);
          if (alive(pgid)) killGroup(pgid, "SIGKILL");
        }
        deps.store.interruptCommandRun(row.id, now());
      }
    },

    async stopAll() {
      // §18.5: флаг «остановлен» ставится до убийства групп — идущий
      // такт, дождавшийся своего await, уже не запустит queued и не
      // возьмёт замок копии.
      stopped = true;
      for (const [id, spawned] of live) {
        spawned.killGroup("SIGTERM");
        deps.store.interruptCommandRun(id, now());
      }
      const rows = deps.store.runningCommandRuns();
      for (const row of rows) {
        if (row.pgid != null && row.pgid > 0) killGroup(row.pgid, "SIGTERM");
        deps.store.interruptCommandRun(row.id, now());
      }
      if (live.size || rows.length) {
        await sleep(killGrace);
        for (const spawned of live.values()) spawned.killGroup("SIGKILL");
        for (const row of deps.store.runningCommandRuns()) {
          if (row.pgid != null && row.pgid > 0 && alive(row.pgid)) {
            killGroup(row.pgid, "SIGKILL");
          }
        }
      }
      live.clear();
      warn("command runner stopped");
    },

    holdForSelfReload(ttlMs = SELF_RELOAD_HOLD_MS) {
      heldUntil = now() + ttlMs;
    },

    isStopped() {
      return stopped;
    },
  };
}

/** §18.2/§18.5: glob-диалект when — *, ?, **; любой патч (ANY). */
export function globMatch(pattern: string, path: string): boolean {
  const parts = pattern.split(/(\*\*|\*|\?)/);
  let re = "^";
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === "**") {
      // `**/x` матчит и корневой `x` — `**/` это «ноль и более каталогов»
      if (parts[i + 1]?.startsWith("/")) {
        re += "(?:.*/)?";
        parts[i + 1] = parts[i + 1].slice(1);
      } else {
        re += ".*";
      }
    } else if (part === "*") {
      re += "[^/]*";
    } else if (part === "?") {
      re += "[^/]";
    } else {
      re += part.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re).test(path);
}
