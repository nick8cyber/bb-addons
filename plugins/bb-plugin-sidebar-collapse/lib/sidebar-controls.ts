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
