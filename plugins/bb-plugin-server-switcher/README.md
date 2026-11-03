---
title: Server Switcher
license: MIT
---

# Server Switcher

A compact server switcher for BB. The standard monochrome icon in the sidebar footer opens the current server and all available switch targets immediately. The panel stays closed until clicked; it has no nested disclosure, avatar pictures, or colored rings.

## Install

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin server-switcher --yes
```

BB must be signed in to its account, with the bundled Connect plugin enabled. Offline servers remain visible and disabled. In the browser, selecting a server navigates to its URL. The desktop app uses its native server selection; the native mobile app keeps its read-only list.

For a local checkout:

```bash
bb plugin install ./plugins/bb-plugin-server-switcher --yes
```

## Develop

Run inside `plugins/bb-plugin-server-switcher`:

```bash
npm ci
npm run verify
```

The original ring storage and CLI remain compatible, although the interface does not display rings or offer a color picker. Authentication, account connections, and server URLs use the native BB services.

## License and origin

[MIT](LICENSE). Maintained in the existing `bb-addons` repository.

Derived from [brsbl/bb-plugins](https://github.com/brsbl/bb-plugins/tree/00febc4b2585d2de6d837b05bd0b25dcefccef5c/plugins/server-switcher), Server Switcher 0.1.2, snapshot `00febc4b2585d2de6d837b05bd0b25dcefccef5c`. Original provenance is preserved in [NOTICE](NOTICE).
