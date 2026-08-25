import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  getState,
  subscribe,
  getFavoritesForProvider,
  getModelLabel,
  getProviderDisplayName,
  type FavoritesState,
} from "./favorites-manager.js";
import { switchComposerModel, openNativeModelPicker, detectActiveProvider } from "./dom-observer.js";
import { StarFilledIcon, StarOutlineIcon } from "./icons.js";

export function QuickFavoritesAction() {
  // If the composer-view hook is unavailable in some host context, fall back
  // to session behavior instead of killing the whole action.
  return (
    <ComposerViewBoundary fallback={<QuickFavoritesActionInner assumeSession />}>
      <QuickFavoritesActionInner />
    </ComposerViewBoundary>
  );
}

class ComposerViewBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function QuickFavoritesActionInner({ assumeSession = false }: { assumeSession?: boolean }) {
  const [state, setState] = useState<FavoritesState>(getState());
  const [isOpen, setIsOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string>("default");

  // New-thread composer shows favorites of all providers; a session (thread,
  // queued message, side chat) composer shows only the active provider's.
  const view = assumeSession
    ? null
    : (useComposerView() as { scope?: { kind?: string } } | null);
  const isNewThread = view?.scope?.kind === "new-thread";
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const measuredHRef = useRef(0);
  const placeRetryRef = useRef(0);

  useEffect(() => {
    return subscribe((next) => {
      setState(next);
    });
  }, []);

  // Pin the menu to the button edge: upward opens get their BOTTOM edge fixed
  // just above the button, downward opens get their TOP edge just below it.
  // Height is capped by the space of the chosen direction, so the menu can
  // never float away from the button or leave the viewport.
  const place = () => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Button hidden or not laid out yet (e.g. mid view-switch): retry briefly
      if (placeRetryRef.current < 20) {
        placeRetryRef.current += 1;
        requestAnimationFrame(() => place());
      }
      return;
    }
    placeRetryRef.current = 0;
    const margin = 8;
    const gap = 6;
    const MAX_H = 420;
    // Menu width is ~288px (w-72), shrunk on narrow (mobile) viewports
    const menuW = Math.max(200, Math.min(288, window.innerWidth - margin * 2));
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - menuW - margin));

    const h = measuredHRef.current || 300;
    const spaceBelow = window.innerHeight - margin - rect.bottom;
    const spaceAbove = rect.top - margin;

    if (h <= spaceBelow - 16 || spaceBelow >= spaceAbove) {
      const maxHeight = Math.max(120, Math.min(MAX_H, spaceBelow - 16));
      setCoords((prev) =>
        prev && prev.top !== undefined &&
        Math.abs(prev.top - (rect.bottom + gap)) < 1 &&
        Math.abs(prev.left - left) < 1 &&
        Math.abs(prev.maxHeight - maxHeight) < 1
          ? prev
          : { top: rect.bottom + gap, left, maxHeight }
      );
    } else {
      const maxHeight = Math.max(120, Math.min(MAX_H, spaceAbove - 16));
      const bottom = window.innerHeight - rect.top + gap;
      setCoords((prev) =>
        prev && prev.bottom !== undefined &&
        Math.abs(prev.bottom - bottom) < 1 &&
        Math.abs(prev.left - left) < 1 &&
        Math.abs(prev.maxHeight - maxHeight) < 1
          ? prev
          : { bottom, left, maxHeight }
      );
    }
  };

  // First paint: menu renders invisibly, measure it, then place and reveal.
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) return;
    const contentH = menuRef.current.scrollHeight;
    if (contentH > 0 && Math.abs(contentH - measuredHRef.current) > 1) {
      measuredHRef.current = contentH;
    }
    place();
  }, [isOpen, state]);

  // Handle outside clicks, resize, scroll, and Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };

    const handleScrollOrResize = () => {
      place();
    };

    window.addEventListener("mousedown", handleDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      window.removeEventListener("mousedown", handleDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen]);

  const handleToggleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const prov = detectActiveProvider();
    setActiveProvider(prov);

    const providerFavs = getFavoritesForProvider(prov);
    const allFavs = Object.entries(state.favorites).filter(([_, list]) => list.length > 0);

    if (providerFavs.length === 0 && allFavs.length === 0) {
      toast.info("Нет избранных моделей", {
        description: "Откройте список моделей и нажмите ⭐ рядом с нужной моделью.",
      });
      openNativeModelPicker();
      return;
    }

    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        placeRetryRef.current = 0;
        setCoords(null); // re-measure and place on open
      }
      return next;
    });
  };

  const handleSelectModel = async (modelId: string, provId?: string) => {
    setIsOpen(false);
    const targetProv = provId || activeProvider;
    const label = getModelLabel(targetProv, modelId);
    toast.loading(`Переключение на ${label}...`, { id: "fav-switch" });

    const success = await switchComposerModel(modelId, targetProv);
    if (success) {
      toast.success(`Выбрана модель: ${label}`, { id: "fav-switch" });
    } else {
      toast.info(`Откройте список моделей и выберите ${label}`, {
        id: "fav-switch",
      });
    }
  };

  const handleOpenAllModels = () => {
    setIsOpen(false);
    openNativeModelPicker();
  };

  const providerFavs = getFavoritesForProvider(activeProvider);
  // "default" means provider detection failed (no open picker, no "Provider: Model"
  // trigger title). Nothing is ever stored under that key, so scoping to it would
  // hide every favorite — fall back to showing all of them instead.
  const showAllProviders = isNewThread || activeProvider === "default";
  const otherProviders = showAllProviders
    ? Object.entries(state.favorites).filter(
        ([p, list]) => p !== activeProvider && list.length > 0
      )
    : [];

  // Active provider first, then the remaining ones (new-thread composer only).
  // Headers only appear once more than one provider is on screen.
  const groups: Array<[string, string[]]> = [];
  if (providerFavs.length > 0) groups.push([activeProvider, providerFavs]);
  groups.push(...otherProviders);
  const showGroupHeaders = groups.length > 1;

  const totalFavs = Object.values(state.favorites).reduce((acc, list) => acc + list.length, 0);
  const hasFavs = totalFavs > 0;

  // Render popup via portal to avoid parent overflow: hidden clipping.
  // Renders invisibly first (coords === null) so it can be measured, then placed.
  const popupMenu = isOpen && typeof document !== "undefined" ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
      style={{
        zIndex: 2147483000,
        width: `min(288px, calc(100vw - 16px))`,
        top: coords?.top !== undefined ? `${coords.top}px` : undefined,
        bottom: coords?.bottom !== undefined ? `${coords.bottom}px` : undefined,
        left: coords ? `${coords.left}px` : "0px",
        maxHeight: coords ? `${coords.maxHeight}px` : undefined,
        visibility: coords ? "visible" : "hidden",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      {groups.length === 0 ? (
        <div className="px-3 py-2.5 text-xs text-muted-foreground">
          Нет избранного для текущего провайдера
        </div>
      ) : (
        groups.map(([prov, models], groupIndex) => (
          <div
            key={prov}
            role="none"
            className={groupIndex > 0 ? "border-t border-border/50 p-1" : "p-1"}
          >
            {showGroupHeaders && (
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {getProviderDisplayName(prov)}
              </div>
            )}
            {models.map((modelId) => {
              const label = getModelLabel(prov, modelId);
              return (
                <button
                  key={modelId}
                  type="button"
                  role="menuitem"
                  onClick={() => handleSelectModel(modelId, prov)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent transition-colors"
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <StarFilledIcon className="size-3 shrink-0 text-amber-500/70" />
                </button>
              );
            })}
          </div>
        ))
      )}

      <div role="none" className="border-t border-border/50 p-1">
        <button
          type="button"
          role="menuitem"
          onClick={handleOpenAllModels}
          className="flex w-full cursor-pointer items-center rounded-md px-2 py-1 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Все модели…
        </button>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className="inline-flex items-center">
      <button
        ref={buttonRef}
        type="button"
        title="Избранные модели (быстрое переключение)"
        aria-label="Избранные модели"
        aria-expanded={isOpen}
        onClick={handleToggleOpen}
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors cursor-pointer select-none hover:bg-accent hover:text-accent-foreground"
      >
        {hasFavs ? (
          <StarFilledIcon className="size-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
        ) : (
          <StarOutlineIcon className="size-3.5 shrink-0" />
        )}
        <span className="max-sm:hidden">Избранное</span>
      </button>

      {popupMenu}
    </div>
  );
}
