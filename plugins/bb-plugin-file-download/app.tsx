// bb-plugin-file-download — фронтенд.
//
// fileOpener на документные расширения: над предпросмотром плашка с кнопкой
// «Скачать» — реальная загрузка через experimental_saveFile (в веб-клиенте
// нативной кнопки Download нет — она зашита на capability nativeDownloads,
// которое сервер не отдаёт). Автозагрузки нет — только по кнопке (слово
// владельца). PDF рендерится iframe'ом с blob-URL, когда браузер умеет
// встроенный PDF viewer (navigator.pdfViewerEnabled) — иначе Original.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_saveFile,
  useSdk,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import {
  DOWNLOAD_EXTENSIONS,
  baseName,
  fileContentToBlob,
  readSourceFile,
} from "./src/resolve";

type DownloadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; fileName: string }
  | { status: "failed"; message: string };

export default definePluginApp((_app) => {
  function DownloadOpener({ path, source, Original }: PluginFileOpenerProps) {
    const sdk = useSdk();
    const [state, setState] = useState<DownloadState>({ status: "idle" });
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const blobRef = useRef<Blob | null>(null);
    const fileName = baseName(path);
    const isPdf = /\.pdf$/i.test(fileName);
    const pdfPreview =
      isPdf &&
      typeof navigator !== "undefined" &&
      navigator.pdfViewerEnabled === true;

    useEffect(
      () => () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
      [objectUrl],
    );

    // Чтение файла → Blob (кэшируется: один проход и для превью, и для «Скачать»).
    const ensureBlob = useCallback(async (): Promise<Blob> => {
      if (blobRef.current) return blobRef.current;
      const file = await readSourceFile(sdk, path, source);
      const blob = fileContentToBlob(file);
      blobRef.current = blob;
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      return blob;
    }, [sdk, path, source]);

    const download = useCallback(async () => {
      setState({ status: "loading" });
      try {
        const blob = await ensureBlob();
        const outcome = await experimental_saveFile({ fileName, blob });
        setState(
          outcome === "started"
            ? { status: "done", fileName }
            : { status: "failed", message: "загрузка не стартовала" },
        );
      } catch (error) {
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, [ensureBlob, fileName]);

    // PDF-превью: байты грузим при маунте; ошибку показываем в плашке,
    // ниже остаётся карточка Original.
    const [previewError, setPreviewError] = useState<string | null>(null);
    useEffect(() => {
      if (!pdfPreview) return;
      let cancelled = false;
      ensureBlob().catch((error) => {
        if (cancelled) return;
        setPreviewError(error instanceof Error ? error.message : String(error));
      });
      return () => {
        cancelled = true;
      };
    }, [pdfPreview, ensureBlob]);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
          <a
            href={objectUrl ?? "about:blank"}
            download={fileName}
            onClick={(event) => {
              event.preventDefault();
              void download();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-foreground hover:bg-state-hover"
          >
            Скачать
          </a>
          <span className="truncate" title={path}>
            {fileName}
          </span>
          <span className="ml-auto shrink-0">
            {state.status === "loading" && "Скачивание…"}
            {state.status === "done" && `Скачан: ${state.fileName}`}
            {state.status === "failed" && (
              <span className="text-destructive">Ошибка: {state.message}</span>
            )}
            {state.status !== "failed" && previewError && (
              <span className="text-destructive">Ошибка: {previewError}</span>
            )}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {pdfPreview && !previewError ? (
            objectUrl ? (
              <iframe
                title={fileName}
                src={objectUrl}
                className="h-full w-full border-0"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Загрузка превью…
              </div>
            )
          ) : (
            <Original />
          )}
        </div>
      </div>
    );
  }

  _app.slots.fileOpener({
    id: "download",
    title: "Download",
    extensions: DOWNLOAD_EXTENSIONS,
    component: DownloadOpener,
  });
});
