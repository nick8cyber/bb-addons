// Разрешение байтов файла по PluginFileOpenerProps.source и сборка Blob.
// Чистые функции — тестируются моком sdk, без DOM.
import type {
  PluginBrowserBbSdk,
  PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";

/** Общая форма ответа projects.fileContent и files.read (без ветки notModified). */
export interface ResolvedFileContent {
  content: string;
  contentEncoding: "base64" | "utf8";
  mimeType?: string | null;
  sizeBytes?: number;
}

/** Расширения, для которых opener выбирается по умолчанию (документы/артефакты, не исходники). */
export const DOWNLOAD_EXTENSIONS = [
  "md", "txt", "pdf", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml",
  "toml", "ini", "log", "patch", "diff",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "xlsx", "xls", "docx", "doc", "pptx", "ppt",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
  "mp3", "wav", "ogg", "flac", "mp4", "webm", "mov",
  "html", "htm", "ics",
] as const;

/** Последний непустой сегмент пути (POSIX и Windows-разделители). */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : "download";
}

/**
 * Склейка корня хранилища и относительного пути без двойных/пропавших слэшей.
 * Сегменты `.`/`..` выкидываются — относительный путь не может выйти за корень.
 */
export function joinPath(root: string, relativePath: string): string {
  const safe = relativePath
    .split(/[\\/]+/)
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .join("/");
  return root.endsWith("/") ? root + safe : root + "/" + safe;
}

/** Потолок на размер скачиваемого файла — всё содержимое живёт в памяти вкладки. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export function formatBytes(size: number): string {
  if (size >= 1024 * 1024 * 1024) return `${(size / 1073741824).toFixed(1)} ГБ`;
  if (size >= 1024 * 1024) return `${(size / 1048576).toFixed(1)} МБ`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${size} Б`;
}

/**
 * Гейт по размеру. SDK не даёт stat-API — размер известен только после чтения,
 * но проверка до сборки Blob не даёт удвоить расход памяти на гигантских файлах.
 */
export function assertSizeWithinLimit(file: ResolvedFileContent): ResolvedFileContent {
  const size = file.sizeBytes ?? 0;
  if (size > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `файл слишком большой для скачивания через браузер (${formatBytes(size)} > ${formatBytes(MAX_DOWNLOAD_BYTES)})`,
    );
  }
  return file;
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** contentEncoding → Blob с mimeType от хоста (или безопасный дефолт). */
export function fileContentToBlob(file: ResolvedFileContent): Blob {
  const mime = file.mimeType ||
    (file.contentEncoding === "base64" ? "application/octet-stream" : "text/plain;charset=utf-8");
  return file.contentEncoding === "base64"
    ? new Blob([base64ToBytes(file.content)], { type: mime })
    : new Blob([file.content], { type: mime });
}

/**
 * Читает файл по источнику fileOpener через авторизованную сессию sdk.
 * workspace — projects.fileContent (путь относительно worktree);
 * host — files.read по абсолютному пути;
 * thread-storage — storageLocation резолвит корень хранилища, затем files.read.
 */
export async function readSourceFile(
  sdk: PluginBrowserBbSdk,
  path: string,
  source: PluginFileOpenerSource,
  signal?: AbortSignal,
): Promise<ResolvedFileContent> {
  if (source.kind === "workspace") {
    let projectId = source.projectId;
    if (!projectId && source.environmentId) {
      // У непроектных воркспейсов projectId в source пуст — добираем из environment.
      const env = await sdk.environments.get({ environmentId: source.environmentId, signal });
      projectId = env.projectId || null;
      if (!projectId && env.path) {
        return assertSizeWithinLimit(await sdk.files.read({
          hostId: env.hostId || source.experimental_hostId,
          path: joinPath(env.path, path),
          signal,
        }));
      }
    }
    if (!projectId) throw new Error("workspace-файл без projectId — не разрешить");
    const routing = source.environmentId
      ? { environmentId: source.environmentId }
      : source.experimental_hostId
        ? { hostId: source.experimental_hostId }
        : {};
    return assertSizeWithinLimit(await sdk.projects.fileContent({ projectId, path, signal, ...routing }));
  }
  if (source.kind === "thread-storage") {
    if (!source.threadId) throw new Error("thread-storage-файл без threadId — не разрешить");
    const location = await sdk.threads.storageLocation({ threadId: source.threadId, signal });
    return assertSizeWithinLimit(await sdk.files.read({ hostId: location.hostId, path: joinPath(location.storageRootPath, path), signal }));
  }
  // kind === "host": без experimental_hostId files.read молча уйдёт на primary
  // host — для файла треда с удалённой ноды это чужой путь. Резолвим хост треда.
  let hostId = source.experimental_hostId || undefined;
  if (!hostId && source.threadId) {
    const thread = await sdk.threads.get({ threadId: source.threadId, signal });
    const environmentId = thread.environmentId;
    const env = environmentId
      ? await sdk.environments.get({ environmentId, signal })
      : null;
    hostId = env?.hostId || undefined;
    if (!hostId) {
      throw new Error("host-файл треда: не удалось разрешить hostId удалённого хоста");
    }
  }
  return assertSizeWithinLimit(await sdk.files.read({ hostId, path, signal }));
}
