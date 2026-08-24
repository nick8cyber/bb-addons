import React, { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  getState,
  subscribe,
  getFavoritesForProvider,
  getModelLabel,
  type FavoritesState,
} from "./favorites-manager.js";
import { switchComposerModel } from "./dom-observer.js";
import { StarFilledIcon, StarOutlineIcon } from "./icons.js";

export function QuickFavoritesAction() {
  const [state, setState] = useState<FavoritesState>(getState());
  const [isOpen, setIsOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string>("default");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribe((next) => {
      setState(next);
    });
  }, []);

  // Close popup when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    window.addEventListener("mousedown", handleDown);
    return () => window.removeEventListener("mousedown", handleDown);
  }, [isOpen]);

  const detectProvider = (): string => {
    const triggerBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="Provider, model" i], button[aria-label*="Model" i]'
    );
    if (triggerBtn) {
      const title = triggerBtn.getAttribute("title") || "";
      if (title.includes(":")) {
        const prov = title.split(":")[0].trim().toLowerCase();
        if (prov.includes("codex")) return "codex";
        if (prov.includes("claude")) return "provider-claude-code";
        if (prov.includes("antigravity") || prov.includes("agy")) return "agy";
        if (prov.includes("pi")) return "provider-pi";
        return prov.replace(/\s+/g, "-");
      }
    }
    return "default";
  };

  const handleToggleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const prov = detectProvider();
    setActiveProvider(prov);

    const providerFavs = getFavoritesForProvider(prov);
    const allFavs = Object.entries(state.favorites);

    if (providerFavs.length === 0 && allFavs.length === 0) {
      toast.info("Нет избранных моделей", {
        description: "Откройте список моделей и нажмите ⭐ рядом с нужной моделью.",
      });
      return;
    }

    setIsOpen((prev) => !prev);
  };

  const handleSelectModel = async (modelId: string, provId?: string) => {
    setIsOpen(false);
    const label = getModelLabel(provId || activeProvider, modelId);
    toast.loading(`Переключение на ${label}...`, { id: "fav-switch" });

    const success = await switchComposerModel(modelId, provId || activeProvider);
    if (success) {
      toast.success(`Выбрана модель: ${label}`, { id: "fav-switch" });
    } else {
      toast.info(`Откройте список моделей и выберите ${label}`, {
        id: "fav-switch",
      });
    }
  };

  const providerFavs = getFavoritesForProvider(activeProvider);
  const otherProviders = Object.entries(state.favorites).filter(
    ([p, list]) => p !== activeProvider && list.length > 0
  );

  const totalFavs = Object.values(state.favorites).reduce((acc, list) => acc + list.length, 0);
  const hasFavs = totalFavs > 0;

  return (
    <div className="relative inline-flex items-center" ref={menuRef}>
      <button
        type="button"
        title="Избранные модели (быстрое переключение)"
        aria-label="Избранные модели"
        onClick={handleToggleOpen}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors cursor-pointer ${
          hasFavs
            ? "text-amber-500 hover:bg-state-hover hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300"
            : "text-muted-foreground hover:bg-state-hover hover:text-foreground"
        }`}
      >
        {hasFavs ? (
          <StarFilledIcon className="size-3.5 text-amber-500 dark:text-amber-400" />
        ) : (
          <StarOutlineIcon className="size-3.5" />
        )}
        <span className="max-sm:hidden">Избранное</span>
        {hasFavs && (
          <span className="flex size-4 items-center justify-center rounded-full bg-amber-500/15 text-2xs font-semibold text-amber-600 dark:text-amber-300">
            {totalFavs}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="absolute bottom-full left-0 z-50 mb-1.5 w-64 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{ maxHeight: "320px", overflowY: "auto" }}
        >
          <div className="flex items-center justify-between px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/60 mb-1">
            <span className="flex items-center gap-1">
              <StarFilledIcon className="size-3 text-amber-500" />
              <span>Быстрый выбор модели</span>
            </span>
            <span>{activeProvider}</span>
          </div>

          {providerFavs.length > 0 ? (
            <div className="space-y-0.5">
              {providerFavs.map((modelId) => {
                const label = getModelLabel(activeProvider, modelId);
                return (
                  <button
                    key={modelId}
                    type="button"
                    onClick={() => handleSelectModel(modelId, activeProvider)}
                    className="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs hover:bg-state-hover hover:text-foreground transition-colors group"
                  >
                    <span className="truncate font-medium text-foreground group-hover:text-foreground">
                      {label}
                    </span>
                    <StarFilledIcon className="size-3 shrink-0 text-amber-500 ml-2" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              Нет избранных моделей для {activeProvider}.
            </div>
          )}

          {otherProviders.length > 0 && (
            <div className="mt-1 pt-1 border-t border-border/60">
              <div className="px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                Другие провайдеры
              </div>
              {otherProviders.map(([prov, list]) => (
                <div key={prov} className="mt-1">
                  <div className="px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                    {prov}:
                  </div>
                  {list.map((modelId) => {
                    const label = getModelLabel(prov, modelId);
                    return (
                      <button
                        key={`${prov}:${modelId}`}
                        type="button"
                        onClick={() => handleSelectModel(modelId, prov)}
                        className="flex w-full cursor-pointer items-center justify-between rounded-sm px-2 py-1 text-left text-xs hover:bg-state-hover hover:text-foreground transition-colors group"
                      >
                        <span className="truncate text-muted-foreground group-hover:text-foreground">
                          {label}
                        </span>
                        <span className="text-2xs text-subtle-foreground ml-1 shrink-0">{prov}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
