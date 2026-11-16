// bb-plugin-file-download — фронтенд.
//
// fileOpener на документные расширения: открытие файла запускает настоящее
// скачивание через experimental_saveFile (в веб-клиенте нативной кнопки
// Download нет — она зашита на capability nativeDownloads, которое сервер
// не отдаёт). Под плашкой рендерится Original — предпросмотр сохраняется.
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

export default definePluginApp((app) => {
  function DownloadOpener({ path, source, Original }: PluginFileOpenerProps) {
    const sdk = useSdk();
    const [state, setState] = useState<DownloadState>({ status: "idle" });
    const blobUrl = useRef<string | null>(null);
    const autoDone = useRef(false);
    const fileName = baseName(path);

    useEffect(
      () => () => {
        if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      },
      [],
    );

    const download = useCallback(async () => {
      setState({ status: "loading" });
      try {
        const file = await readSourceFile(sdk, path, source);
        const blob = fileContentToBlob(file);
        if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
        blobUrl.current = URL.createObjectURL(blob);
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
    }, [sdk, path, source, fileName]);

    // Одна автозагрузка на маунт и только при активной жесте пользователя:
    // восстановленные после перезагрузки приложения вкладки не должны качать.
    useEffect(() => {
      if (autoDone.current) return;
      if (navigator.userActivation?.isActive !== true) return;
      autoDone.current = true;
      void download();
    }, [download]);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
          <a
            href={blobUrl.current ?? "about:blank"}
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
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  }

  app.slots.fileOpener({
    id: "download",
    title: "Download",
    extensions: DOWNLOAD_EXTENSIONS,
    component: DownloadOpener,
  });
});
