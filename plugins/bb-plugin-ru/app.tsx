/**
 * Фронтенд русификатора.
 *
 * Контент-скрипт монтирует переводчик в оболочку приложения; раздел настроек и
 * кнопка в подвале боковой панели им управляют. React и SDK предоставляет сам bb
 * — этот файл собирается `bb plugin build` в dist/app.js.
 */
import { useCallback, useEffect, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { pluralize } from "./src/plural";
import {
  clearMissing,
  fetchMissing,
  isCollecting,
  isEnabled,
  mount,
  setEnabled,
  stats,
  subscribe,
  toggle,
  DICTIONARY_SIZE,
  type MissingRow,
} from "./src/runtime";

/**
 * Перерисовывает компонент, когда перевод включили или выключили, и раз в
 * секунду — чтобы счётчики переведённых подписей не отставали от интерфейса.
 */
function useTranslatorState(): { enabled: boolean } {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1);
    const unsubscribe = subscribe(bump);
    const timer = setInterval(bump, 1000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  return { enabled: isEnabled() };
}

function SettingsSection() {
  const { enabled } = useTranslatorState();
  const [rows, setRows] = useState<MissingRow[] | null>(null);
  const current = stats();
  const collecting = isCollecting();

  const loadMissing = useCallback(() => {
    void fetchMissing(50).then(setRows);
  }, []);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            toast.success(next ? "Интерфейс переведён" : "Интерфейс на английском");
          }}
        >
          {enabled ? "Перевод включён" : "Перевод выключен"}
        </Button>
        <span className="text-muted-foreground">
          В словаре {pluralize(DICTIONARY_SIZE, "строка", "строки", "строк")}
          {current === null
            ? ""
            : `, сейчас переведено ${pluralize(current.textNodes, "подпись", "подписи", "подписей")}` +
              ` и ${pluralize(current.attributes, "подсказка", "подсказки", "подсказок")}`}
        </span>
      </div>

      <p className="text-muted-foreground">
        Переводятся только подписи самого интерфейса. Переписка, код, диффы и
        поля ввода не затрагиваются: содержимое сообщений плагин не трогает
        принципиально.
      </p>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={loadMissing}>
            Непереведённые строки
          </Button>
          {rows !== null && rows.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void clearMissing().then((removed) => {
                  setRows([]);
                  toast.success(
                    `Очищено ${pluralize(removed, "строка", "строки", "строк")}`,
                  );
                });
              }}
            >
              Очистить
            </Button>
          ) : null}
        </div>
        {collecting ? null : (
          <p className="text-muted-foreground">
            Сбор непереведённых строк выключен. Включить:{" "}
            <span className="font-mono text-xs">
              bb plugin config ru set collectMissing true
            </span>
          </p>
        )}
        {rows === null ? null : rows.length === 0 ? (
          <p className="text-muted-foreground">Пока ничего не собрано.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={row.text} className="flex gap-2">
                <span className="w-10 shrink-0 text-right text-muted-foreground">
                  {row.count}
                </span>
                <span className="font-mono text-xs">{row.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "translate",
    mount: () => mount(),
  });

  app.slots.settingsSection({
    id: "ru",
    title: "Русификатор",
    description:
      "Перевод подписей интерфейса bb. Переключается на месте, без перезагрузки окна.",
    component: SettingsSection,
  });

  app.slots.sidebarFooterAction({
    id: "toggle",
    title: "Русский / English",
    icon: "Globe",
    run: () => {
      const enabled = toggle();
      toast.success(enabled ? "Интерфейс переведён" : "Интерфейс на английском");
    },
  });
});
