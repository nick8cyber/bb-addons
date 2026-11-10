/** Small owned shell styles. Exact BB markers fail open on unknown layouts. */
export const SIDEBAR_CONTROLS_STYLE_ID = "bb-plugin-compact-ui-controls";
export const SIDEBAR_CONTROLS_CSS = `
[data-bb-sidebar-row-action] { opacity: 1 !important; }
@media (pointer: coarse) {
  [data-bb-sidebar-row-action] { width: 28px; height: 28px; }
}
[data-sidebar="footer"]:has([data-footer-item="builtin:settings"] > #sidebar-footer-settings)
[data-footer-item="plugin:compact-ui/compact-ui-settings"] { display: none !important; }
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
/* Compact queue keeps BB's own trigger, preview, count and inert state. */
section:has(> header[data-queued-messages-mode="collapsed"]) {
  height: 32px !important; min-height: 32px !important;
  margin-bottom: 0 !important; padding-bottom: 0 !important;
  border-radius: 8px !important;
}
header[data-queued-messages-mode="collapsed"] > button {
  height: 30px !important; min-height: 30px !important; padding-block: 0 !important;
}
section:has(> header[data-queued-messages-mode="collapsed"]) > [data-queued-messages-scroll-frame] { display: none !important; }
[data-bb-git-section="mixed"] [data-bb-git-action] { display: none !important; }
[data-bb-activity-card][data-bb-activity-open="false"] { display: none !important; }
[data-bb-activity-card][data-bb-activity-open="true"] {
  position: fixed !important;
  left: var(--bb-activity-left); top: var(--bb-activity-top); width: var(--bb-activity-width);
  max-height: var(--bb-activity-height); overflow: auto !important; z-index: 45;
  background: var(--background); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 6px 24px #0003;
}
[data-bb-activity-header] { display: inline-flex; min-width: 0; }
[data-bb-activity-header] button {
  display: inline-flex; align-items: center; gap: 6px; height: 28px;
  padding: 0 7px; border: 1px solid var(--border); border-radius: 6px;
  font-size: 12px; color: var(--foreground); cursor: pointer;
}
[data-bb-activity-header] button:hover { background: var(--accent); }
[data-bb-activity-header] button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
[data-bb-activity-card] div[aria-label] { flex-wrap: wrap; }
[data-bb-activity-card] [title] {
  white-space: normal !important; overflow: visible !important;
  text-overflow: clip !important; overflow-wrap: anywhere;
}
@media (max-width: 767px), (pointer: coarse) {
  [data-bb-git-header] button, [data-bb-activity-header] button { height: 44px; min-width: 44px; }
  [data-bb-activity-label] { display: none; }
  section:has(> header[data-queued-messages-mode="collapsed"]) { height: 44px !important; min-height: 44px !important; }
  header[data-queued-messages-mode="collapsed"] > button { height: 42px !important; min-height: 42px !important; }
  [data-queued-message-row] > div { flex-wrap: wrap; }
  [data-queued-message-actions] { margin-left: auto; }
  [data-queued-message-actions] > button { min-width: 44px; min-height: 44px; }
}
/* Composer: editor scroll area stays under ~1/3 of the viewport (desktop + mobile),
   so the conversation above keeps most of the screen. 56px reserves promptbox chrome
   (send row, model picker); min() keeps BB's own 312px ceiling on tall desktops. */
form[class*="group/promptbox"] div.overflow-y-auto:has(.ProseMirror) {
  max-height: min(312px, calc(33vh - 56px));
  max-height: min(312px, calc(33svh - 56px));
}
/* Navigation (list placement): collapse the four destinations into one icon row.
   Labels and per-item option chevrons are hidden; aria-labels keep tooltips. */
[data-testid="sidebar-navigation-list"] {
  display: flex !important; flex-direction: row !important;
  align-items: center !important; gap: 2px;
}
[data-testid="sidebar-navigation-destinations"] {
  display: flex !important; flex-direction: row !important;
  align-items: center !important; gap: 2px;
  max-height: none !important; overflow: visible !important; flex: 0 0 auto;
}
[data-sidebar-navigation-item] { flex: 0 0 auto; }
[data-testid="sidebar-navigation-list"] button {
  width: var(--bb-sidebar-row-height) !important;
  min-width: var(--bb-sidebar-row-height) !important;
  padding-left: 0 !important; padding-right: 0 !important;
  justify-content: center !important;
}
[data-testid="sidebar-navigation-list"] button > :not([data-icon-root]):not(.rounded-full) {
  display: none !important;
}
[data-testid="sidebar-navigation-region"] .bb-sidebar-hover-actions {
  display: none !important;
}
/* Nav icons cloned into the top chrome row by the nav-top-row script: hide the
   original region (kept alive for click forwarding) and style the clones. */
html[data-bb-nav-icons-active] [data-testid="sidebar-navigation-region"] {
  position: absolute !important; visibility: hidden !important; pointer-events: none !important;
}
.bb-nav-top-icons { display: flex; align-items: center; gap: 2px; margin-right: auto; }
.bb-nav-top-icons > button {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 6px; border: 0; padding: 0;
  background: transparent; color: var(--sidebar-foreground); cursor: pointer;
}
.bb-nav-top-icons > button:hover { background: var(--sidebar-accent); }
.bb-nav-top-icons > button:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.bb-nav-top-icons > button svg { width: 16px; height: 16px; display: block; }
@media (max-width: 767px), (pointer: coarse) {
  .bb-nav-top-icons > button { width: 36px; height: 36px; }
  .bb-nav-top-icons > button svg { width: 20px; height: 20px; }
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
