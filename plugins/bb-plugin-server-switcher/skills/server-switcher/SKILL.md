---
name: server-switcher
description: Explain the compact sidebar server switcher, its one-click server list, online indicators, and native browser/desktop/mobile switching behavior.
---

# Server switcher

The standard monochrome Servers icon in the sidebar footer opens the current server and all switch targets immediately. The panel starts closed and never opens itself on registration or reload. It has no inner disclosure or arrow, avatar images, colored rings, or color picker.

- In a browser, selecting an online server navigates to its URL.
- In the desktop app, switching goes through the native server list.
- In the native mobile app the list is read-only.
- Offline servers are visible and disabled.

The list comes from the bundled `connect` plugin. BB must be signed in to its account. `bb connect servers` lists the same account servers.

The original `bb server-switcher ring list | set | clear | reset` CLI and saved ring data remain compatible; those rings are not rendered by this fork.

The maintained plugin is MIT-licensed in `nick8cyber/bb-addons`, under `plugins/bb-plugin-server-switcher`.
