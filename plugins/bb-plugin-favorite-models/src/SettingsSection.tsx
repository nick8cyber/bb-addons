import React, { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getState,
  subscribe,
  addFavorite,
  removeFavorite,
  clearFavorites,
  updateConfig,
  exportFavoritesJson,
  importFavoritesJson,
  getFavoritesCount,
  type FavoritesState,
} from "./favorites-manager.js";
import { StarFilledIcon, TrashIcon, PlusIcon } from "./icons.js";

export function SettingsSection() {
  const [state, setState] = useState<FavoritesState>(getState());
  const [newProvider, setNewProvider] = useState("");
  const [newModel, setNewModel] = useState("");
  const [importJsonText, setImportJsonText] = useState("");
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    return subscribe((next) => {
      setState(next);
    });
  }, []);

  const totalCount = getFavoritesCount();
  const providerEntries = Object.entries(state.favorites).filter(([_, list]) => list.length > 0);

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    const prov = newProvider.trim().toLowerCase();
    const mod = newModel.trim();
    if (!prov || !mod) {
      toast.error("Укажите провайдера и название модели");
      return;
    }
    addFavorite(prov, mod);
    setNewModel("");
    toast.success(`Модель ${mod} добавлена в избранное для ${prov}`);
  };

  const handleRemove = (providerId: string, modelId: string) => {
    removeFavorite(providerId, modelId);
    toast.success(`Модель ${modelId} удалена из избранного`);
  };

  const handleClearAll = () => {
    if (confirm("Вы уверены, что хотите очистить весь список избранных моделей?")) {
      clearFavorites();
      toast.success("Все избранные модели очищены");
    }
  };

  const handleExport = async () => {
    const json = exportFavoritesJson();
    try {
      await navigator.clipboard.writeText(json);
      toast.success("Список избранного скопирован в буфер обмена (JSON)");
    } catch {
      toast.info("JSON избранного: " + json);
    }
  };

  const handleImport = () => {
    if (!importJsonText.trim()) {
      toast.error("Вставьте JSON в поле ввода");
      return;
    }
    const success = importFavoritesJson(importJsonText.trim());
    if (success) {
      toast.success("Избранные модели успешно импортированы!");
      setShowImport(false);
      setImportJsonText("");
    } else {
      toast.error("Неверный формат JSON");
    }
  };

  return (
    <div className="space-y-6 text-sm">
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <StarFilledIcon className="size-4 text-amber-500" />
            <span>Параметры избранного</span>
          </div>
          <span className="text-xs text-muted-foreground">
            Всего в избранном: <strong className="text-foreground">{totalCount}</strong>
          </span>
        </div>

        <div className="space-y-3 pt-2">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={state.pinToTop}
              onChange={(e) => updateConfig({ pinToTop: e.target.checked })}
              className="size-4 rounded border-border text-amber-500 focus:ring-amber-500"
            />
            <span className="text-xs text-foreground font-medium">
              Закреплять избранные модели поверх общего списка в выпадающем меню
            </span>
          </label>

          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={state.showQuickBar}
              onChange={(e) => updateConfig({ showQuickBar: e.target.checked })}
              className="size-4 rounded border-border text-amber-500 focus:ring-amber-500"
            />
            <span className="text-xs text-foreground font-medium">
              Показывать кнопку «⭐ Избранное» в панели действий поля ввода для быстрого выбора
            </span>
          </label>
        </div>
      </div>

      {/* Grouped favorites list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Сохраненные модели ({totalCount})
          </h4>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleExport} className="h-7 text-xs">
              Экспорт JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowImport(!showImport)}
              className="h-7 text-xs"
            >
              Импорт JSON
            </Button>
            {totalCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleClearAll}
                className="h-7 text-xs text-destructive hover:text-destructive"
              >
                Очистить всё
              </Button>
            )}
          </div>
        </div>

        {showImport && (
          <div className="rounded-lg border border-border bg-card p-3 space-y-2">
            <textarea
              value={importJsonText}
              onChange={(e) => setImportJsonText(e.target.value)}
              placeholder='Вставьте JSON в формате: {"favorites": {"codex": ["gpt-5.4"]}}'
              className="w-full h-24 p-2 text-xs font-mono rounded border border-border bg-background"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowImport(false)} className="h-7 text-xs">
                Отмена
              </Button>
              <Button size="sm" onClick={handleImport} className="h-7 text-xs">
                Применить импорт
              </Button>
            </div>
          </div>
        )}

        {providerEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            У вас пока нет моделей в избранном.
            <br />
            Нажмите на звёздочку <StarFilledIcon className="inline size-3.5 text-amber-500 mx-1" /> рядом с моделью в меню выбора или добавьте модель вручную ниже.
          </div>
        ) : (
          <div className="space-y-3">
            {providerEntries.map(([providerId, models]) => (
              <div key={providerId} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="bg-muted/40 px-3 py-1.5 flex items-center justify-between border-b border-border text-xs font-medium">
                  <span className="flex items-center gap-1.5 text-foreground">
                    <span className="size-2 rounded-full bg-amber-500" />
                    <span>Провайдер: <strong>{providerId}</strong></span>
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {models.length} {models.length === 1 ? "модель" : "моделей"}
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {models.map((modelId) => {
                    const label = state.modelLabels[`${providerId}:${modelId}`] || modelId;
                    return (
                      <div
                        key={modelId}
                        className="flex items-center justify-between px-3 py-2 text-xs hover:bg-state-hover/50 transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <StarFilledIcon className="size-3.5 text-amber-500 shrink-0" />
                          <span className="font-mono text-foreground truncate">{modelId}</span>
                          {label !== modelId && (
                            <span className="text-subtle-foreground text-2xs truncate">({label})</span>
                          )}
                        </div>
                        <button
                          type="button"
                          title="Удалить из избранного"
                          aria-label={`Удалить ${modelId}`}
                          onClick={() => handleRemove(providerId, modelId)}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-state-hover transition-colors cursor-pointer"
                        >
                          <TrashIcon className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual add form */}
      <form onSubmit={handleAddManual} className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <PlusIcon className="size-3.5" />
          <span>Добавить модель вручную</span>
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="text-2xs text-muted-foreground block mb-1">
              Провайдер (например: codex, claude-code, agy, pi)
            </label>
            <Input
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
              placeholder="codex"
              className="h-8 text-xs"
            />
          </div>
          <div>
            <label className="text-2xs text-muted-foreground block mb-1">
              ID или имя модели (например: gpt-5.4, claude-3-7-sonnet)
            </label>
            <Input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="gpt-5.4"
              className="h-8 text-xs"
            />
          </div>
        </div>
        <div className="flex justify-end pt-1">
          <Button type="submit" size="sm" className="h-8 text-xs">
            Добавить в избранное
          </Button>
        </div>
      </form>
    </div>
  );
}
