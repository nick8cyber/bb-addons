---
name: server-switcher
description: Explain the sidebar server switcher that lists the bb servers on the user's bb account, switches between them, and colors each server's avatar ring.
---

# Server switcher

The Server switcher uses a standard monochrome Servers icon in the sidebar footer. The panel is closed by default and opens only when its icon is clicked. It never opens itself on registration or reload. The panel lists the current server and the other account servers. Avatars and rings remain inside the list.

- In a browser or on a `https://<handle>.getbb.app` URL, choosing a server
  navigates the tab to that server's URL.
- In the desktop app, the list is the desktop app's own server list, and
  choosing a server switches through the desktop app.
- Inside the bb mobile app the list is read-only.

## Ring colors

Each server's avatar has a colored ring: one color or a two-stop gradient.
Account servers start with a default gradient, assigned by sorted handle so
servers on one account get distinct colors. Click a server's avatar to open
the picker beside the sidebar: click a swatch, click the bar to add a second
color, click a stop to change it, use the dashed swatch for no ring, or Reset
to return to the default. Rings are saved on the server you are viewing, keyed
by server handle.

```
bb server-switcher ring list                               # saved overrides only
bb server-switcher ring set <server> <color> [<color>]     # hex, e.g. #3b82f6
bb server-switcher ring clear <server>                     # no ring
bb server-switcher ring reset <server>                     # back to the default
```

The server list comes from the bundled `connect` plugin and the avatar from
`bb-account`, so bb must be signed in (`bb account login`). List the same
servers with `bb connect servers`.
