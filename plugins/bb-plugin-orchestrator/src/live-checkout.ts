/**
 * orchestrator §24.1 п.2–3 (PLUG-410): служебная живая копия
 * ~/.bb/plugin-live/<repo>, миграция `live-checkout setup` под §23
 * («всё или ничего») и защита живой копии.
 *
 * Порядок:
 *  1. `live-checkout setup` (координатор или владелец) определяет проект
 *     ОДИН раз и создаёт заявку с параметрами (проект, ветка, копия);
 *     ответ — отказ `live-checkout-needs-approval` с id заявки, владельцу —
 *     карточка и строка. Повтор той же заявки новой строки не даёт.
 *  2. Одобрение — только владелец (кнопка или `live-checkout approve <id>`
 *     из терминала без BB_THREAD_ID). Применяется ровно сохранённая заявка.
 *  3. Миграция под замком миграции проекта и замком живой копии (общая
 *     семантика `acquireCopyLock`, владелец — экземпляр плагина); пока
 *     идёт публикация шага 6 (метка публикации) — отказ.
 *  4. Перевод плагинов по одному: статус running, активный источник
 *     `path:<живая копия>/…`, build-info.json = SHA копии. Сбой — откат
 *     всех переведённых в обратном порядке, настройка не меняется.
 *     orchestrator переводится последним: его перезагрузка завершает
 *     миграцию в новом экземпляре по журналу (`resumeLiveCheckout`).
 *  5. Только после всех — одна подтверждённая запись `postPublish.checkout`.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { OrchestratorError } from "./errors.js";
import type { DelegationStore } from "./store.js";
import type { BbCli } from "./bb-cli.js";
import { acquireCopyLock, type MergeGit } from "./merge.js";

export const LIVE_MARKER = ".bb-live-checkout";

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function gitOut(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Канонический корень репозитория: родитель общего каталога git. */
export function canonicalRepoPath(repo: string): string {
  const common = gitOut([
    "-C",
    resolve(repo),
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return real(common ? dirname(common) : repo);
}

function keyOf(path: string): string {
  return `${basename(path)}-${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
}

export function projectLockDir(): string {
  const dir = join(homedir(), ".bb", "orchestrator-locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Замок миграции проекта (держит `live-checkout setup`). */
export function migrationLockPath(repo: string): string {
  return join(projectLockDir(), `migrate-${keyOf(canonicalRepoPath(repo))}.lock`);
}

/** Замок живой копии — один для setup и postPublish (вне её `.git`). */
export function liveCopyLockPath(liveDir: string): string {
  return join(projectLockDir(), `live-${keyOf(real(liveDir))}.lock`);
}

/** Совместимость: замок проекта по корню репозитория. */
export function projectLockPath(repo: string): string {
  return migrationLockPath(repo);
}

export function defaultLiveDir(repoRoot: string): string {
  return join(homedir(), ".bb", "plugin-live", basename(canonicalRepoPath(repoRoot)));
}

// ── Живая копия: маркер, реестр, токен ─────────────────────────────────

/** Живая копия опознаётся ТОЛЬКО по маркеру в её общем каталоге git,
 * который ставит `live-checkout setup` (§24.1 п.1–3): ни путь, ни
 * `postPublish.checkout` настройки, ни запись реестра сами по себе копию
 * живой не делают — обычная рабочая копия владельца никогда не станет
 * «только для чтения» и не попадёт под reference-transaction. */
export function hasLiveMarker(p: string): boolean {
  if (!p || !existsSync(p)) return false;
  const common = gitOut(["-C", resolve(p), "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return Boolean(common && existsSync(join(common, LIVE_MARKER)));
}

/** Маркер живой копии в её общем каталоге git — пишет только setup
 * после успешной миграции. `.git` уже может быть «только чтение»
 * (продолжение после самоперевода) — права каталога временно
 * возвращаются и восстанавливаются. */
export function writeLiveMarker(
  liveDir: string,
  data: { projectId: string; repo: string; sha: string },
): void {
  const common =
    gitOut(["-C", liveDir, "rev-parse", "--path-format=absolute", "--git-common-dir"]) ||
    join(liveDir, ".git");
  const mode = statSync(common).mode & 0o777;
  if ((mode & 0o200) === 0) chmodSync(common, mode | 0o700);
  try {
    const file = join(common, LIVE_MARKER);
    rmSync(file, { force: true });
    writeFileSync(file, JSON.stringify({ ...data, at: Date.now() }) + "\n", { mode: 0o444 });
  } finally {
    if ((mode & 0o200) === 0) chmodSync(common, mode);
  }
}

/** `hooksDir` оставлен для совместимости вызовов; реестр не источник. */
export function isLiveCheckoutPath(p: string, _hooksDir?: string): boolean {
  return hasLiveMarker(p);
}

function writeJsonAtomic(file: string, value: unknown, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, file);
}

/** Реестр живых копий (`live-copies.json`) — только каталоги успешной
 * миграции setup: путь без маркера в реестр не попадает никогда. */
export function writeLiveRegistry(hooksDir: string, paths: string[]): void {
  if (!existsSync(hooksDir)) return;
  const list = [...new Set(paths.filter((x) => x && hasLiveMarker(x)).map(real))].sort();
  writeJsonAtomic(join(hooksDir, "live-copies.json"), list);
}

/** Чистка реестра при загрузке настроек и `hooks install`: остаются только
 * записи с маркером (снимает пути, внесённые прежней версией из настройки). */
export function pruneLiveRegistry(hooksDir: string): void {
  if (!existsSync(join(hooksDir, "live-copies.json"))) return;
  writeLiveRegistry(hooksDir, readRegistry(hooksDir));
}

/** Внести каталог успешной миграции (с маркером) в реестр. */
export function registerLiveCopy(hooksDir: string, liveDir: string): void {
  writeLiveRegistry(hooksDir, [...readRegistry(hooksDir), liveDir]);
}

/** Целевые ветки всех проектов принятой настройки — для pre-commit. */
export function writeTargetsRegistry(hooksDir: string, branches: string[]): void {
  if (!existsSync(hooksDir)) return;
  const list = [...new Set(branches.filter(Boolean))].sort();
  writeJsonAtomic(join(hooksDir, "targets.json"), list);
}

export function liveTokenFile(): string {
  return join(homedir(), ".bb", "plugin-live", ".token");
}

function readTokenMap(): Record<string, { token: string; expiresAt: number }> {
  try {
    const m = JSON.parse(readFileSync(liveTokenFile(), "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

/** Одноразовый токен postPublish для одной копии (§24.1 п.3). */
export function issueLiveToken(liveDir: string, ttlMs = 600_000): string {
  const token = randomBytes(24).toString("hex");
  const map = readTokenMap();
  const now = Date.now();
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v.expiresAt !== "number" || v.expiresAt <= now) delete map[k];
  }
  map[real(liveDir)] = { token, expiresAt: now + ttlMs };
  writeJsonAtomic(liveTokenFile(), map, 0o600);
  return token;
}

export function revokeLiveToken(liveDir: string, token: string): void {
  const map = readTokenMap();
  const k = real(liveDir);
  if (map[k]?.token !== token) return;
  delete map[k];
  if (Object.keys(map).length === 0) {
    rmSync(liveTokenFile(), { force: true });
  } else {
    writeJsonAtomic(liveTokenFile(), map, 0o600);
  }
}

/**
 * Права служебной живой копии (§24.1 п.3): `makeWritable=false` —
 * каталоги и исполняемые 0555, прочие 0444; `true` — 0755/0644.
 * Символические ссылки не трогаются. `only` — подкаталог (например,
 * `.git`), остальное дерево не меняется.
 */
export function chmodRecursive(dir: string, makeWritable: boolean): void {
  if (!existsSync(dir)) return;
  const walk = (p: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (makeWritable) {
        try {
          chmodSync(p, 0o755);
        } catch {}
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(p);
      } catch {}
      for (const e of entries) walk(join(p, e));
      if (!makeWritable) {
        try {
          chmodSync(p, 0o555);
        } catch {}
      }
      return;
    }
    if (st.isFile()) {
      const exec = (st.mode & 0o111) !== 0;
      try {
        chmodSync(p, makeWritable ? (exec ? 0o755 : 0o644) : exec ? 0o555 : 0o444);
      } catch {}
    }
  };
  walk(dir);
}

// ── Миграция идёт? ─────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function migratingMetaKey(repo: string): string {
  return `live-checkout:migrating:${canonicalRepoPath(repo)}`;
}

/** Миграция идёт: живой замок миграции проекта или метка в базе с живым pid. */
export function isLiveCheckoutMigrating(
  store: DelegationStore | null | undefined,
  repo: string,
): boolean {
  const pid = lockPid(migrationLockPath(repo));
  if (pid !== null && pidAlive(pid)) return true;
  const raw = store?.metaGet?.(migratingMetaKey(repo));
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as { pid?: number };
    return typeof v.pid === "number" && pidAlive(v.pid);
  } catch {
    return raw === "true";
  }
}

export function setLiveCheckoutMigrating(
  store: DelegationStore | null | undefined,
  repo: string,
  migrating: boolean,
): void {
  if (!store?.metaSet) return;
  store.metaSet(
    migratingMetaKey(repo),
    migrating ? JSON.stringify({ pid: process.pid, at: Date.now() }) : "",
  );
}

// ── Метка публикации шага 6 ────────────────────────────────────────────

function publishMarkerPrefix(repo: string): string {
  return `publish-${keyOf(canonicalRepoPath(repo))}-`;
}

/**
 * Шаг 6 release: метка «идёт публикация» ставится ДО проверки миграции,
 * setup проверяет метки ПОСЛЕ взятия замка миграции — одна из сторон
 * обязательно видит другую. Возвращает снятие метки.
 */
export function beginPublish(
  store: DelegationStore | null | undefined,
  repo: string,
  releaseId: number | string,
): () => void {
  const file = join(projectLockDir(), `${publishMarkerPrefix(repo)}${releaseId}.lock`);
  writeFileSync(file, `${process.pid}\n${new Date().toISOString()}\n`);
  const done = () => rmSync(file, { force: true });
  if (isLiveCheckoutMigrating(store, repo)) {
    done();
    throw new OrchestratorError(
      "live-checkout-migrating",
      "live-checkout-migrating: идёт миграция служебной копии live-checkout",
    );
  }
  return done;
}

function activePublishes(repo: string): string[] {
  const dir = projectLockDir();
  const prefix = publishMarkerPrefix(repo);
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue;
    const pid = lockPid(join(dir, f));
    if (pid !== null && pidAlive(pid)) out.push(f);
    else rmSync(join(dir, f), { force: true });
  }
  return out;
}

// ── Заявка §23 ─────────────────────────────────────────────────────────

export interface LiveCheckoutRequest {
  id: string;
  projectId: string;
  repoRoot: string;
  canonicalRoot: string;
  liveDir: string;
  targetBranch: string;
  requestedBy: string | null;
  requestedAt: number;
  status: "pending" | "approved" | "rejected" | "migrating" | "done" | "failed";
  decidedAt?: number;
  result?: string;
}

const REQ_INDEX = "live-checkout:requests";
const reqKey = (id: string) => `live-checkout:request:${id}`;

function needStore(store: DelegationStore | null | undefined): DelegationStore {
  if (!store?.metaGet || !store.metaSet) {
    throw new OrchestratorError("live-checkout-failed", "нет базы плагина для заявки live-checkout");
  }
  return store;
}

export function getLiveCheckoutRequest(
  store: DelegationStore | null | undefined,
  id: string,
): LiveCheckoutRequest | null {
  const raw = store?.metaGet?.(reqKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LiveCheckoutRequest;
  } catch {
    return null;
  }
}

export function saveLiveCheckoutRequest(store: DelegationStore, req: LiveCheckoutRequest): void {
  store.metaSet(reqKey(req.id), JSON.stringify(req));
  let ids: string[] = [];
  try {
    ids = JSON.parse(store.metaGet(REQ_INDEX) ?? "[]");
  } catch {}
  if (!ids.includes(req.id)) {
    ids.push(req.id);
    store.metaSet(REQ_INDEX, JSON.stringify(ids.slice(-50)));
  }
}

export function listLiveCheckoutRequests(store: DelegationStore | null | undefined): LiveCheckoutRequest[] {
  if (!store?.metaGet) return [];
  let ids: string[] = [];
  try {
    ids = JSON.parse(store.metaGet(REQ_INDEX) ?? "[]");
  } catch {}
  return ids
    .map((id) => getLiveCheckoutRequest(store, id))
    .filter((r): r is LiveCheckoutRequest => r !== null);
}

export interface SetupLiveCheckoutOptions {
  repoRoot: string;
  /** Проект, определённый вызывающим один раз (резолвер настроек). */
  projectId: string;
  /** Целевая ветка этого проекта из принятой настройки. */
  targetBranch: string;
  liveDir?: string;
  store: DelegationStore | null | undefined;
  threadId?: string | null;
}

export interface SetupLiveCheckoutRequestResult {
  request: LiveCheckoutRequest;
  created: boolean;
}

/**
 * `live-checkout setup` (§24.1 п.2): только заявка. Проект и ветку
 * определяет вызывающий ОДИН раз; одобрение применит ровно их.
 * Повтор той же заявки возвращает прежнюю (created=false).
 */
export function requestLiveCheckout(opts: SetupLiveCheckoutOptions): SetupLiveCheckoutRequestResult {
  const store = needStore(opts.store);
  if (!opts.projectId) {
    throw new OrchestratorError(
      "live-checkout-project-unresolved",
      "live-checkout: проект копии не определён по настройкам release — заявка не создана",
    );
  }
  if (!opts.targetBranch) {
    throw new OrchestratorError(
      "live-checkout-project-unresolved",
      `live-checkout: у проекта ${opts.projectId} нет целевой ветки (target.branch)`,
    );
  }
  const repoRoot = real(opts.repoRoot);
  const canonicalRoot = canonicalRepoPath(repoRoot);
  const liveDir = resolve(opts.liveDir ?? defaultLiveDir(repoRoot));
  if (liveDir === canonicalRoot || liveDir.startsWith(canonicalRoot + "/")) {
    throw new OrchestratorError(
      "invalid-arguments",
      `live-checkout: служебная копия не может лежать внутри рабочей копии (${liveDir})`,
    );
  }
  const same = listLiveCheckoutRequests(store).find(
    (r) =>
      (r.status === "pending" || r.status === "migrating" || r.status === "approved") &&
      r.projectId === opts.projectId &&
      r.canonicalRoot === canonicalRoot &&
      r.liveDir === liveDir &&
      r.targetBranch === opts.targetBranch,
  );
  if (same) return { request: same, created: false };
  const req: LiveCheckoutRequest = {
    id: `lc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    projectId: opts.projectId,
    repoRoot,
    canonicalRoot,
    liveDir,
    targetBranch: opts.targetBranch,
    requestedBy: opts.threadId ?? null,
    requestedAt: Date.now(),
    status: "pending",
  };
  saveLiveCheckoutRequest(store, req);
  return { request: req, created: true };
}

export function needsApprovalError(req: LiveCheckoutRequest): OrchestratorError {
  return new OrchestratorError(
    "live-checkout-needs-approval",
    `live-checkout-needs-approval: заявка ${req.id} (проект ${req.projectId}, ветка ${req.targetBranch}, копия ${req.liveDir}) ждёт одобрения владельца по §23 — кнопка в карточке или \`bb orchestrator live-checkout approve ${req.id}\` из терминала владельца`,
  );
}

// ── Каталог плагинов BB ────────────────────────────────────────────────

export interface PluginInfo {
  id: string;
  rootDir: string;
  source: string;
  status: string;
}

/** Строгий разбор `bb plugin list --json`: `{ plugins: [...] }` с
 * полями id/rootDir/source/status у каждого; иначе — сбой. */
export function parsePluginList(stdout: string): PluginInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new OrchestratorError("live-checkout-failed", "bb plugin list вернул некорректный JSON");
  }
  const arr =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { plugins?: unknown }).plugins
      : undefined;
  if (!Array.isArray(arr)) {
    throw new OrchestratorError(
      "live-checkout-failed",
      "bb plugin list: неизвестная форма ответа (нет массива plugins)",
    );
  }
  return arr.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    for (const f of ["id", "rootDir", "source", "status"]) {
      if (typeof o[f] !== "string" || !o[f]) {
        throw new OrchestratorError(
          "live-checkout-failed",
          `bb plugin list: у записи ${i} нет поля ${f}`,
        );
      }
    }
    return {
      id: o.id as string,
      rootDir: o.rootDir as string,
      source: o.source as string,
      status: o.status as string,
    };
  });
}

export interface MigrationDeps {
  store: DelegationStore;
  /** Владелец замков — экземпляр плагина (как у postPublish). */
  instanceId: string;
  /** id этого плагина — переводится последним. */
  selfPluginId?: string;
  /** Корень этого экземпляра плагина (где лежит его dist). */
  selfRoot?: string;
  bbCli?: BbCli;
  listPlugins?: () => Promise<PluginInfo[]>;
  switchPlugin?: (id: string, dir: string) => Promise<void>;
  buildPlugin?: (dir: string, liveSha: string) => Promise<void>;
  /** Одна подтверждённая запись postPublish.checkout; бросает при сбое
   * записи или проверки (и сама возвращает прежнее значение). */
  writeCheckout: (projectId: string, liveDir: string) => Promise<void>;
  notifyOwner: (line: string, extraThreads?: string[]) => Promise<boolean>;
  hooksDir?: string;
  /** Сколько ждать статуса running после перевода (мс). */
  settleMs?: number;
  pollMs?: number;
}

export interface MigrationResult {
  ok: boolean;
  /** true — переведён сам orchestrator, итог допишет новый экземпляр. */
  pendingSelf?: boolean;
  liveDir: string;
  headSha: string;
  switchedPlugins: string[];
  message: string;
}

const INFLIGHT = (canon: string) => `live-checkout:inflight:${canon}`;

interface Inflight {
  requestId: string;
  projectId: string;
  canonicalRoot: string;
  liveDir: string;
  liveSha: string;
  switched: Array<{ id: string; prevDir: string }>;
  selfId: string;
  selfPrev: string;
  selfNew: string;
  at: number;
}

async function defaultList(deps: MigrationDeps): Promise<PluginInfo[]> {
  if (deps.listPlugins) return deps.listPlugins();
  if (!deps.bbCli) throw new OrchestratorError("live-checkout-failed", "нет bb CLI для списка плагинов");
  const res = await deps.bbCli.run(["plugin", "list", "--json"], { timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new OrchestratorError(
      "live-checkout-failed",
      `bb plugin list: ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
    );
  }
  return parsePluginList(res.stdout);
}

async function defaultSwitch(deps: MigrationDeps, id: string, dir: string): Promise<void> {
  if (deps.switchPlugin) return deps.switchPlugin(id, dir);
  if (!deps.bbCli) throw new Error("нет bb CLI для перевода плагина");
  const res = await deps.bbCli.run(["plugin", "install", dir], { timeoutMs: 600_000 });
  if (res.exitCode !== 0) {
    throw new Error(`bb plugin install ${dir}: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
  }
}

function readBuildSha(dir: string): string | null {
  try {
    const info = JSON.parse(readFileSync(join(dir, "dist", "build-info.json"), "utf8"));
    return typeof info.gitSha === "string" ? info.gitSha : null;
  } catch {
    return null;
  }
}

async function defaultBuild(deps: MigrationDeps, dir: string, liveSha: string): Promise<void> {
  if (deps.buildPlugin) return deps.buildPlugin(dir, liveSha);
  const pkgFile = join(dir, "package.json");
  if (!existsSync(pkgFile)) return;
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  if (!existsSync(join(dir, "node_modules")) && existsSync(join(dir, "package-lock.json"))) {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, stdio: "pipe" });
  }
  if (pkg.scripts?.build) {
    execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
  }
  // Сборка сделана в живой копии на liveSha: метка сборки — факт этой
  // сборки. Свою метку (postbuild) с другим SHA не переписываем — это сбой.
  const sha = readBuildSha(dir);
  if (sha === null) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "dist", "build-info.json"),
      JSON.stringify({ gitSha: liveSha, builtAt: Date.now(), by: "live-checkout" }, null, 2),
    );
  } else if (sha !== liveSha) {
    throw new Error(`build-info.json в ${dir}: ${sha} ≠ ${liveSha}`);
  }
}

/** Ждём: плагин в списке, статус (running, если был running), активный
 * источник — новая папка, build-info = SHA копии. */
async function verifySwitched(
  deps: MigrationDeps,
  id: string,
  dir: string,
  liveSha: string,
  wasRunning: boolean,
): Promise<void> {
  const deadline = Date.now() + (deps.settleMs ?? 60_000);
  const want = real(dir);
  for (;;) {
    const list = await defaultList(deps);
    const p = list.find((x) => x.id === id);
    let last = "нет записи в каталоге";
    if (p) {
      const srcOk = p.source === `path:${dir}` || p.source === `path:${want}`;
      const rootOk = real(p.rootDir) === want;
      const statusOk = wasRunning ? p.status === "running" : true;
      if (srcOk && rootOk && statusOk) break;
      last = `статус ${p.status}, источник ${p.source}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(`плагин ${id} не поднялся из ${dir} (${last})`);
    }
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
  }
  const sha = readBuildSha(dir);
  if (sha !== liveSha) {
    throw new Error(`build-info.json плагина ${id}: ${sha ?? "нет"} ≠ ${liveSha}`);
  }
}

/** Порядок отката: обратный порядку перевода, но сам orchestrator —
 * ПОСЛЕДНИМ: его перезагрузка посреди отката не оставит прочие плагины
 * на служебной копии (аудит р.5 п.5б). */
export function rollbackOrder<T extends { id: string }>(switched: T[], selfId: string): T[] {
  const rev = [...switched].reverse();
  return [...rev.filter((s) => s.id !== selfId), ...rev.filter((s) => s.id === selfId)];
}

async function rollback(
  deps: MigrationDeps,
  switched: Array<{ id: string; prevDir: string }>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const s of rollbackOrder(switched, deps.selfPluginId ?? "orchestrator")) {
    try {
      await defaultSwitch(deps, s.id, s.prevDir);
    } catch (e) {
      errors.push(`${s.id}: ${(e as Error).message ?? String(e)}`);
    }
  }
  return errors;
}

function rollbackText(errors: string[]): string {
  return errors.length
    ? `откат с ошибками: ${errors.join("; ")}`
    : "все переведённые плагины возвращены на прежние источники";
}

const dummyGit: MergeGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });

function finishRequest(
  store: DelegationStore,
  req: LiveCheckoutRequest,
  status: LiveCheckoutRequest["status"],
  result: string,
): void {
  const cur = getLiveCheckoutRequest(store, req.id) ?? req;
  saveLiveCheckoutRequest(store, { ...cur, status, result, decidedAt: cur.decidedAt ?? Date.now() });
}

/**
 * Применение одобренной заявки (§24.1 п.2). Бросает
 * `live-checkout-failed` с причиной и итогом отката; строка владельцу
 * уходит в обоих исходах.
 */
export async function runLiveCheckoutMigration(
  deps: MigrationDeps,
  req: LiveCheckoutRequest,
): Promise<MigrationResult> {
  const store = deps.store;
  if (req.status !== "approved") {
    throw new OrchestratorError(
      "live-checkout-needs-approval",
      `live-checkout-needs-approval: заявка ${req.id} в статусе ${req.status}`,
    );
  }
  const repoRoot = req.canonicalRoot;
  const liveDir = req.liveDir;
  const owner = deps.instanceId;

  // Замки: миграция проекта, затем живая копия. Отказ захвата — прерывание.
  const releaseMigrate = await acquireCopyLock(dummyGit, repoRoot, migrationLockPath(repoRoot), {
    owner,
  });
  let releaseLive: (() => void) | null = null;
  const switched: Array<{ id: string; prevDir: string }> = [];
  let token: string | null = null;
  let selfHandoff = false;
  try {
    setLiveCheckoutMigrating(store, repoRoot, true);
    const busy = activePublishes(repoRoot);
    if (busy.length) {
      throw new OrchestratorError(
        "live-checkout-busy",
        `live-checkout: идёт публикация release (${busy.length}) — повторите после неё`,
      );
    }
    mkdirSync(dirname(liveDir), { recursive: true, mode: 0o700 });
    releaseLive = await acquireCopyLock(dummyGit, liveDir, liveCopyLockPath(liveDir), { owner });
    finishRequest(store, req, "migrating", "");

    // (а) служебная копия: clone на origin/<target> либо fetch + ff.
    const origin = gitOut(["-C", repoRoot, "remote", "get-url", "origin"]) || repoRoot;
    const env = { ...process.env } as Record<string, string>;
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    if (!existsSync(liveDir)) {
      execFileSync("git", ["clone", "--branch", req.targetBranch, origin, liveDir], {
        stdio: "pipe",
        env,
      });
    } else {
      chmodRecursive(liveDir, true);
      token = issueLiveToken(liveDir);
      const tenv = { ...env, ORCH_LIVE_TOKEN: token };
      execFileSync("git", ["-C", liveDir, "fetch", "origin"], { stdio: "pipe", env: tenv });
      const br = gitOut(["-C", liveDir, "symbolic-ref", "--short", "-q", "HEAD"]);
      if (br !== req.targetBranch) {
        throw new OrchestratorError(
          "live-checkout-failed",
          `служебная копия ${liveDir} на ветке ${br || "detached"}, ожидалась ${req.targetBranch}`,
        );
      }
      execFileSync("git", ["-C", liveDir, "merge", "--ff-only", `origin/${req.targetBranch}`], {
        stdio: "pipe",
        env: tenv,
      });
    }
    const liveSha = gitOut(["-C", liveDir, "rev-parse", "HEAD"]);
    if (!liveSha) throw new OrchestratorError("live-checkout-failed", `нет HEAD в ${liveDir}`);

    // Плагины проекта: источник path: внутри репозитория.
    const before = await defaultList(deps);
    const roots = [real(req.repoRoot), repoRoot];
    const plan = before
      .filter((p) => p.source.startsWith("path:"))
      .map((p) => {
        const root = real(p.rootDir);
        const base = roots.find((r) => root === r || root.startsWith(r + "/"));
        return base ? { info: p, root, rel: relative(base, root) } : null;
      })
      .filter((x): x is { info: PluginInfo; root: string; rel: string } => x !== null)
      .filter((x) => real(join(liveDir, x.rel)) !== x.root);
    const selfId = deps.selfPluginId ?? "orchestrator";
    plan.sort((a, b) => Number(a.info.id === selfId) - Number(b.info.id === selfId));
    for (const p of plan) {
      if (!existsSync(join(liveDir, p.rel, "package.json"))) {
        throw new OrchestratorError(
          "live-checkout-failed",
          `плагина ${p.info.id} нет в служебной копии (${join(liveDir, p.rel)})`,
        );
      }
    }

    // (б) сборка переводимых плагинов в служебной копии.
    for (const p of plan) {
      try {
        await defaultBuild(deps, join(liveDir, p.rel), liveSha);
      } catch (e) {
        throw new OrchestratorError(
          "live-checkout-failed",
          `сборка ${p.info.id}: ${(e as Error).message ?? String(e)}`,
        );
      }
    }

    // (в) перевод по одному.
    for (const p of plan) {
      const newDir = join(liveDir, p.rel);
      const wasRunning = p.info.status === "running";
      if (p.info.id === selfId) {
        const inflight: Inflight = {
          requestId: req.id,
          projectId: req.projectId,
          canonicalRoot: repoRoot,
          liveDir,
          liveSha,
          switched: [...switched],
          selfId,
          selfPrev: p.root,
          selfNew: real(newDir),
          at: Date.now(),
        };
        store.metaSet(INFLIGHT(repoRoot), JSON.stringify(inflight));
      }
      try {
        await defaultSwitch(deps, p.info.id, newDir);
        switched.push({ id: p.info.id, prevDir: p.root });
        if (p.info.id === selfId && deps.selfRoot && real(deps.selfRoot) !== real(newDir)) {
          // Этот экземпляр — прежний orchestrator: итог допишет новый.
          selfHandoff = true;
          return {
            ok: true,
            pendingSelf: true,
            liveDir,
            headSha: liveSha,
            switchedPlugins: switched.map((s) => s.id),
            message: `orchestrator переведён на ${newDir}; запись postPublish.checkout сделает новый экземпляр после проверки`,
          };
        }
        await verifySwitched(deps, p.info.id, newDir, liveSha, wasRunning);
      } catch (e) {
        if (!switched.some((s) => s.id === p.info.id)) {
          // install мог частично переключить — возвращаем и этот плагин
          switched.push({ id: p.info.id, prevDir: p.root });
        }
        store.metaSet(INFLIGHT(repoRoot), "");
        const errs = await rollback(deps, switched);
        throw new OrchestratorError(
          "live-checkout-failed",
          `сбой перевода плагина ${p.info.id}: ${(e as Error).message ?? String(e)}; ${rollbackText(errs)}`,
        );
      }
    }
    store.metaSet(INFLIGHT(repoRoot), "");

    // (г) одна подтверждённая запись postPublish.checkout.
    try {
      await deps.writeCheckout(req.projectId, liveDir);
    } catch (e) {
      const errs = await rollback(deps, switched);
      throw new OrchestratorError(
        "live-checkout-failed",
        `сбой записи postPublish.checkout: ${(e as Error).message ?? String(e)}; ${rollbackText(errs)}`,
      );
    }
    // Маркер `.bb-live-checkout` — только после успешной миграции (§24.1 п.3).
    writeLiveMarker(liveDir, { projectId: req.projectId, repo: repoRoot, sha: liveSha });
    if (deps.hooksDir) {
      try {
        registerLiveCopy(deps.hooksDir, liveDir);
      } catch {}
    }
    const msg = `live-checkout ${req.id}: служебная копия ${liveDir} (${liveSha.slice(0, 7)}), переведены: ${switched.map((s) => s.id).join(", ") || "нет"}; postPublish.checkout проекта ${req.projectId} → ${liveDir}`;
    finishRequest(store, req, "done", msg);
    await deps.notifyOwner(msg, req.requestedBy ? [req.requestedBy] : []).catch(() => false);
    return { ok: true, liveDir, headSha: liveSha, switchedPlugins: switched.map((s) => s.id), message: msg };
  } catch (e) {
    const reason = (e as Error).message ?? String(e);
    finishRequest(store, req, "failed", reason);
    await deps
      .notifyOwner(`live-checkout ${req.id} не выполнен: ${reason}; postPublish.checkout не менялся`, req.requestedBy ? [req.requestedBy] : [])
      .catch(() => false);
    throw e instanceof OrchestratorError ? e : new OrchestratorError("live-checkout-failed", reason);
  } finally {
    if (token) revokeLiveToken(liveDir, token);
    if (existsSync(liveDir)) chmodRecursive(liveDir, false);
    if (!selfHandoff) setLiveCheckoutMigrating(store, repoRoot, false);
    releaseLive?.();
    if (!selfHandoff) releaseMigrate();
    else {
      // Замок миграции держится до итога нового экземпляра: его pid тот
      // же процесс BB, владелец — прежний экземпляр; новый снимает его в
      // resumeLiveCheckout.
    }
  }
}

function readRegistry(hooksDir: string): string[] {
  try {
    const list = JSON.parse(readFileSync(join(hooksDir, "live-copies.json"), "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Старт экземпляра: незавершённая миграция с переводом самого
 * orchestrator. Этот экземпляр загружен из служебной копии и его
 * build-info = SHA копии → запись postPublish.checkout. Иначе (перевод
 * не состоялся или истёк срок) — откат остальных и строка владельцу.
 */
export async function resumeLiveCheckout(
  deps: MigrationDeps,
  opts: { maxAgeMs?: number } = {},
): Promise<MigrationResult[]> {
  const store = deps.store;
  const out: MigrationResult[] = [];
  for (const req of listLiveCheckoutRequests(store)) {
    if (req.status !== "migrating") continue;
    const raw = store.metaGet(INFLIGHT(req.canonicalRoot));
    if (!raw) continue;
    let inf: Inflight;
    try {
      inf = JSON.parse(raw) as Inflight;
    } catch {
      continue;
    }
    const selfRoot = deps.selfRoot ? real(deps.selfRoot) : "";
    const newSelf = inf.selfNew;
    const switchedAll = [...inf.switched, { id: inf.selfId, prevDir: inf.selfPrev }];
    const migrateLock = migrationLockPath(inf.canonicalRoot);
    const done = () => {
      store.metaSet(INFLIGHT(inf.canonicalRoot), "");
      setLiveCheckoutMigrating(store, inf.canonicalRoot, false);
      rmSync(migrateLock, { force: true });
    };
    const loadedFromLive = selfRoot !== "" && selfRoot === newSelf;
    if (loadedFromLive && readBuildSha(selfRoot) === inf.liveSha) {
      try {
        await deps.writeCheckout(inf.projectId, inf.liveDir);
        writeLiveMarker(inf.liveDir, { projectId: inf.projectId, repo: inf.canonicalRoot, sha: inf.liveSha });
        if (deps.hooksDir) {
          try {
            registerLiveCopy(deps.hooksDir, inf.liveDir);
          } catch {}
        }
        const msg = `live-checkout ${req.id}: переведены ${switchedAll.map((s) => s.id).join(", ")}; postPublish.checkout проекта ${inf.projectId} → ${inf.liveDir} (${inf.liveSha.slice(0, 7)})`;
        finishRequest(store, req, "done", msg);
        done();
        await deps.notifyOwner(msg, req.requestedBy ? [req.requestedBy] : []).catch(() => false);
        out.push({ ok: true, liveDir: inf.liveDir, headSha: inf.liveSha, switchedPlugins: switchedAll.map((s) => s.id), message: msg });
      } catch (e) {
        const errs = await rollback(deps, switchedAll);
        const reason = `сбой записи postPublish.checkout: ${(e as Error).message ?? String(e)}; ${rollbackText(errs)}`;
        finishRequest(store, req, "failed", reason);
        done();
        await deps.notifyOwner(`live-checkout ${req.id} не выполнен: ${reason}`, req.requestedBy ? [req.requestedBy] : []).catch(() => false);
        out.push({ ok: false, liveDir: inf.liveDir, headSha: inf.liveSha, switchedPlugins: [], message: reason });
      }
      continue;
    }
    const age = Date.now() - inf.at;
    if (loadedFromLive || age > (opts.maxAgeMs ?? 15 * 60_000)) {
      const errs = await rollback(deps, loadedFromLive ? switchedAll : inf.switched);
      const reason = loadedFromLive
        ? `orchestrator поднялся из ${selfRoot}, но build-info ≠ ${inf.liveSha}; ${rollbackText(errs)}`
        : `перевод orchestrator не завершился за ${Math.round(age / 60000)} мин; ${rollbackText(errs)}`;
      finishRequest(store, req, "failed", reason);
      done();
      await deps.notifyOwner(`live-checkout ${req.id} не выполнен: ${reason}; postPublish.checkout не менялся`, req.requestedBy ? [req.requestedBy] : []).catch(() => false);
      out.push({ ok: false, liveDir: inf.liveDir, headSha: inf.liveSha, switchedPlugins: [], message: reason });
    }
  }
  return out;
}
