/** Small owned shell styles. Exact BB markers fail open on unknown layouts. */
export const SIDEBAR_CONTROLS_STYLE_ID = "bb-plugin-sidebar-collapse-controls";
export const SIDEBAR_CONTROLS_CSS = `
[data-bb-sidebar-row-action] { opacity: 1 !important; }
@media (pointer: coarse) {
  [data-bb-sidebar-row-action] { width: 28px; height: 28px; }
}
[data-sidebar="footer"]:has([data-footer-item="builtin:settings"] > #sidebar-footer-settings)
[data-footer-item="plugin:sidebar-collapse/sidebar-collapse-settings"] { display: none !important; }
[data-testid="sidebar-navigation-region"][data-sidebar-navigation-placement="list"]
[data-nav-rail-badge="count"][data-nav-badge-tone="neutral"] > span {
  background-color: var(--sidebar-foreground) !important;
  color: var(--sidebar) !important;
}
/* Native queue handlers stay attached; phone actions reserve their own row space. */
@media (max-width: 767px) {
  [data-queued-message-row] [data-queued-message-actions] {
    display: flex !important; position: static !important;
    transform: none !important; translate: none !important;
    opacity: 1 !important; pointer-events: auto !important; flex-shrink: 0;
  }
  [data-queued-message-row] [data-queued-message-actions]::before { display: none !important; }
  [data-queued-message-row] [data-queued-message-actions] > button { width: 32px; height: 32px; }
  [data-queued-message-row] [data-queued-message-actions] + button:has([data-icon="MoreHorizontal"]) {
    display: none !important;
  }
}
[data-bb-git-section="only"][data-bb-git-open="false"] { display: none !important; }
[data-bb-git-section="mixed"] [data-bb-git-source] { display: none !important; }
[data-bb-git-section="only"][data-bb-git-open="true"],
[data-bb-git-section="mixed"] [data-bb-git-body][data-bb-git-open="true"] {
  position: fixed !important;
  left: var(--bb-git-left); top: var(--bb-git-top); width: var(--bb-git-width);
  max-height: var(--bb-git-height); overflow: auto; z-index: 45;
  background: var(--background); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 6px 24px #0003;
}
[data-bb-git-section="mixed"] [data-bb-git-body][data-bb-git-open="false"] { display: none !important; }
[data-bb-git-header] { display: inline-flex; min-width: 0; }
[data-bb-git-header] button {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 210px;
  padding: 0 7px; border: 1px solid var(--border); border-radius: 6px;
  font-size: 12px; color: var(--foreground); cursor: pointer;
}
[data-bb-git-header] button:hover { background: var(--accent); }
[data-bb-git-header] button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
[data-bb-git-header] button:disabled { opacity: .5; cursor: default; }
[data-bb-git-header-count] { display: none; }
[data-bb-git-compact="true"] [data-bb-git-header-summary] { display: none; }
[data-bb-git-compact="true"] [data-bb-git-header-count] { display: inline; }
@media (max-width: 767px), (pointer: coarse) {
  [data-bb-git-header] button { height: 36px; }
  [data-bb-git-header-summary] { display: none; }
  [data-bb-git-header-count] { display: inline; }
}
`;
export function mountSidebarControls(signal?: AbortSignal, doc: Document = document): () => void {
  if (signal?.aborted) return () => {};
  const style = doc.createElement("style");
  style.id = SIDEBAR_CONTROLS_STYLE_ID;
  style.textContent = SIDEBAR_CONTROLS_CSS;
  (doc.head ?? doc.documentElement).append(style);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    style.remove();
    signal?.removeEventListener("abort", dispose);
  };
  signal?.addEventListener("abort", dispose, {once: true});
  return dispose;
}
