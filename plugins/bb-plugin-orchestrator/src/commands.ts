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
const DEFAULT_KILL_GRACE_MS = 10_000;

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
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > RAW_OUTPUT_CAP) {
      output = output.slice(-RAW_OUTPUT_CAP);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const done = new Promise<SpawnResult>((resolve) => {
    child.once("error", (e) => {
      resolve({ code: null, signal: null, output: output + "\n" + e.message });
    });
    child.once("close", (code, signal) => resolve({ code, signal, output }));
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
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killGroupOf(pgid: number, signal: "SIGTERM" | "SIGKILL") {
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
  /** Самоперезагрузка поставлена — новые queued не стартуют в этом процессе. */
  holdForSelfReload(): void;
}

const sleepDefault = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

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
  let held = false;

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
      spawned.pid,
      spawned.pgid,
      procStart(spawned.pid),
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
      if (held) return;
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
        let kill = false;
        if (row.pgid != null && row.pid != null) {
          const start = procStart(row.pid);
          // §18.2: убиваем только свою группу — лидер тот же
          // (proc_start совпал). pid переиспользован чужим процессом —
          // группу не трогаем, запись всё равно interrupted.
          kill =
            start !== null &&
            row.proc_start === start &&
            alive(row.pgid);
        }
        if (kill && row.pgid != null) {
          killGroup(row.pgid, "SIGTERM");
          await sleep(killGrace);
          if (alive(row.pgid)) killGroup(row.pgid, "SIGKILL");
        }
        deps.store.interruptCommandRun(row.id, now());
      }
    },

    async stopAll() {
      for (const [id, spawned] of live) {
        spawned.killGroup("SIGTERM");
        deps.store.interruptCommandRun(id, now());
      }
      const rows = deps.store.runningCommandRuns();
      for (const row of rows) {
        if (row.pgid != null) killGroup(row.pgid, "SIGTERM");
        deps.store.interruptCommandRun(row.id, now());
      }
      if (live.size || rows.length) {
        await sleep(killGrace);
        for (const spawned of live.values()) spawned.killGroup("SIGKILL");
        for (const row of deps.store.runningCommandRuns()) {
          if (row.pgid != null && alive(row.pgid)) {
            killGroup(row.pgid, "SIGKILL");
          }
        }
      }
      live.clear();
      warn("command runner stopped");
    },

    holdForSelfReload() {
      held = true;
    },
  };
}

/** §18.2/§18.5: glob-диалект when — *, ?, **; любой патч (ANY). */
export function globMatch(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split(/(\*\*|\*|\?)/)
        .map((part) => {
          if (part === "**") return ".*";
          if (part === "*") return "[^/]*";
          if (part === "?") return "[^/]";
          return part.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
        })
        .join("") +
      "$",
  );
  return re.test(path);
}
