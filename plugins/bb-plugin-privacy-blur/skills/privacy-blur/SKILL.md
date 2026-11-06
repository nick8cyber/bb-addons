---
name: privacy-blur
description: Privacy Blur plugin — one-click blur of sensitive data (emails, ids, paths, URLs, domains, IPs, tokens, project/host names, custom words) in the bb UI for screenshots and screen sharing.
---

# Privacy Blur

- Toggle: the `EyeOff` button in the sidebar footer, or `Alt+Shift+P`. While on, a "Данные скрыты" pill sits bottom-right; click it to turn off.
- State is per browser (localStorage), synced between tabs of the same browser.
- Built-in detectors: emails, URLs, absolute and `~/` paths, Windows paths, bb ids (`thr_…`, `proj_…`, `env_…`, …), UUIDs, long hex, API keys/JWT, IPv4/IPv6, domains, international phones, `@handles`.
- Auto words (setting `autoTerms`): project names, host names, OS hostname and user, git `user.name`/`user.email`, public app URL host.
- Settings: `bb plugin config privacy-blur` — `customTerms` (comma/newline list), `blurInputs`, `blurTerminal`, `blurAvatars`, `blurThreadTitles`, `extraSelectors`. Reload the plugin after changing settings; terms are re-fetched each time the mode is turned on.
- Text is masked through the CSS Custom Highlight API (no DOM rewrites). Text split across several DOM nodes, `title` tooltips and canvas content are not matched; inputs and the terminal are blurred as whole elements.
