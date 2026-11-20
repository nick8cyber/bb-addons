import React, { useState, useEffect, useRef, useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  useComposerView,
  useBbContext,
  experimental_useSidebarThreads,
  type ComposerView,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  getState,
  subscribe,
  getFavoritesForProvider,
  getModelLabel,
  getProviderDisplayName,
} from "./favorites-manager.js";
import {
  switchComposerModel,
  openNativeModelPicker,
  detectActiveProvider,
  cancelPendingSwitch,
  normalizeProviderId,
  type SwitchFailure,
} from "./dom-observer.js";
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

let toastSeq = 0;

function QuickFavoritesActionInner({ assumeSession = false }: { assumeSession?: boolean }) {
  // useSyncExternalStore: the snapshot is read at render time, so an update
  // landing between mount and a passive-effect subscribe can no longer be
  // missed (m4).
  const state = useSyncExternalStore(subscribe, getState, getState);
  const [isOpen, setIsOpen] = useState(false);
  const [domProvider, setDomProvider] = useState<string>("default");
  // Provider resolved when the menu was opened; frozen so a late SDK answer
  // cannot reshuffle groups under the user's finger (M4).
  const [menuProvider, setMenuProvider] = useState<string | null>(null);

  // New-thread composer shows favorites of all providers; a session (thread,
  // queued message, side chat) composer shows only the active provider's.
  const view = assumeSession ? null : (useComposerView() as ComposerView | null);
  const scope = view?.scope;
  const isNewThread = scope?.kind === "new-thread";
  // Resolve the thread from the composer's own scope. bbContext.threadId is the
  // route's thread, which can still point at the last open thread while the
  // new-thread screen is up — scoping to that would pick the wrong provider.
  const scopeThreadId =
    scope?.kind === "thread" || scope?.kind === "queued-message"
      ? scope.threadId
      : scope?.kind === "side-chat"
        ? scope.childThreadId
        : null;

  // The host knows which provider a thread runs on. Ask it instead of reading
  // the provider back out of the composer's DOM, which only works when the
  // picker happens to be open and mislabels everything else as "default".
  const bbContext = useBbContext();
  const sidebar = experimental_useSidebarThreads();
  const threadId = isNewThread ? null : (scopeThreadId ?? bbContext.threadId);
  const sdkProvider = (() => {
    if (!threadId) return null;
    const thread = sidebar.threads.find((t) => t.id === threadId);
    return thread ? normalizeProviderId(thread.providerId) : null;
  })();
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

  // A pending programmatic switch must not survive a context change or this
  // composer's unmount — its polls would then click into a menu that no
  // longer belongs to the user's intent (B3). Scoped to THIS composer's
  // trigger: another composer unmounting cancels nothing of ours.
  useEffect(() => {
    const btn = buttonRef.current;
    return () => cancelPendingSwitch(btn);
  }, [threadId]);

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
      setMenuProvider(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setMenuProvider(null);
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

    // Only consult the DOM when the host could not tell us (new-thread screen).
    // Scoped to OUR composer's trigger — a document-wide lookup reads whatever
    // composer comes first (M4/B1).
    const prov = sdkProvider ?? detectActiveProvider(undefined, buttonRef.current);
    setDomProvider(prov);

    const providerFavs = getFavoritesForProvider(prov);
    const allFavs = Object.entries(state.favorites).filter(([_, list]) => list.length > 0);

    if (providerFavs.length === 0 && allFavs.length === 0) {
      toast.info("Нет избранных моделей", {
        description: "Откройте список моделей и нажмите ⭐ рядом с нужной моделью.",
      });
      openNativeModelPicker(buttonRef.current);
      return;
    }

    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        placeRetryRef.current = 0;
        setCoords(null); // re-measure and place on open
        setMenuProvider(prov); // freeze provider for this menu session
      } else {
        setMenuProvider(null);
      }
      return next;
    });
  };

  const handleSelectModel = async (modelId: string, provId?: string) => {
    setIsOpen(false);
    setMenuProvider(null);
    const targetProv = provId || activeProvider;
    const label = getModelLabel(targetProv, modelId);
    // Unique toast id per attempt: a stale switch can no longer overwrite the
    // status of the selection that replaced it (B3).
    const toastId = `fav-switch-${++toastSeq}`;

    toast.loading(`Переключение на ${label}...`, { id: toastId });

    const result = await switchComposerModel(modelId, targetProv, buttonRef.current);
    if (result.ok) {
      toast.success(`Выбрана модель: ${label}`, { id: toastId });
      return;
    }
    toast.info(describeSwitchFailure(result.reason, label, targetProv), {
      id: toastId,
    });
  };

  const handleOpenAllModels = () => {
    setIsOpen(false);
    setMenuProvider(null);
    openNativeModelPicker(buttonRef.current);
  };

  // Inside a thread the provider is fixed, so the menu stays scoped to it.
  // Only the new-thread screen, where no thread exists yet, lists every provider.
  const isSession = threadId !== null;
  const activeProvider = isOpen && menuProvider ? menuProvider : (sdkProvider ?? domProvider);
  // "default" is not a provider — it means neither the host nor the DOM could
  // name one. In a session that case must NOT dump every provider's models:
  // cross-provider picks may be unavailable or route into BB's handoff (M4).
  const sidebarLoading = sidebar.status === "loading";
  const providerUnknown = activeProvider === "default";
  const providerFavs = getFavoritesForProvider(activeProvider);

  const groups: Array<[string, string[]]> = [];
  if (isSession) {
    if (providerFavs.length > 0) groups.push([activeProvider, providerFavs]);
  } else {
    for (const [p, list] of Object.entries(state.favorites)) {
      if (list.length > 0) groups.push([p, list]);
    }
  }
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
          {sidebarLoading
            ? "Определяем провайдера…"
            : providerUnknown
              ? "Не удалось определить провайдера"
              : "Нет избранного для текущего провайдера"}
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

  // The setting is real now: unchecked means no composer button at all (M13).
  if (!state.showQuickBar) return null;

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

/** Turn a failed switch into something the user can act on. */
function describeSwitchFailure(
  reason: SwitchFailure | undefined,
  label: string,
  providerId: string
): string {
  switch (reason) {
    case "trigger-disabled":
      return `Модель сейчас нельзя сменить — переключатель заблокирован (обычно во время ответа агента)`;
    case "no-trigger":
      return `В этом композере нет переключателя модели`;
    case "no-popover":
      return `Список моделей не открылся — попробуйте ещё раз`;
    case "provider-tab-missing":
      return `Провайдер «${getProviderDisplayName(providerId)}» недоступен в этом треде`;
    case "model-not-found":
      return `Модель ${label} не найдена в списке провайдера`;
    case "unconfirmed":
      return `Модель ${label} могла не примениться — проверьте переключатель или выберите её вручную`;
    case "cancelled":
      return `Переключение на ${label} отменено`;
    default:
      return `Откройте список моделей и выберите ${label}`;
  }
}
