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

/** Склейка корня хранилища и относительного пути без двойных/пропавших слэшей. */
export function joinPath(root: string, relativePath: string): string {
  const rel = relativePath.replace(/^\/+/, "");
  return root.endsWith("/") ? root + rel : root + "/" + rel;
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
    if (!source.projectId) throw new Error("workspace-файл без projectId — не разрешить");
    const routing = source.environmentId
      ? { environmentId: source.environmentId }
      : source.experimental_hostId
        ? { hostId: source.experimental_hostId }
        : {};
    return sdk.projects.fileContent({ projectId: source.projectId, path, signal, ...routing });
  }
  if (source.kind === "thread-storage") {
    if (!source.threadId) throw new Error("thread-storage-файл без threadId — не разрешить");
    const location = await sdk.threads.storageLocation({ threadId: source.threadId, signal });
    return sdk.files.read({ hostId: location.hostId, path: joinPath(location.storageRootPath, path), signal });
  }
  return sdk.files.read({ hostId: source.experimental_hostId, path, signal });
}
