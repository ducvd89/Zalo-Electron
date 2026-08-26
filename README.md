# Zalo Web Desktop

Zalo desktop app (wrapping the `chat.zalo.me` web version) for Windows / macOS / Linux, built with Electron.

## Run in development

```bash
npm install
npm start
```

## Packaging

| Command | Output |
|---|---|
| `npm run dist:win` | `.exe` installer (NSIS) for Windows |
| `npm run dist:linux` | `.pacman` package for Arch/CachyOS (run on Linux) |
| `npm run dist:mac` | `.dmg` for macOS (run on a Mac) |

Artifacts are written to the `dist/` folder.

> Note: the `.pacman` package must be built on Linux and the `.dmg` on macOS
> (an electron-builder limitation). The `.exe` builds right on Windows.

## Features

- System tray: Open App / Open Zalo Link… / Reload Page / Back to Chat List /
  Launch at Startup (with a checkmark showing its state) / Quit; the (X) button
  only hides the app to the tray.
- Paste-a-link box (<kbd>Ctrl</kbd>+<kbd>L</kbd>) for opening `zalo.me` links
  the OS would otherwise send to the browser.
- Unread message counter parsed from the page title: tray tooltip, red-dot
  overlay on the Windows Taskbar, badge on the macOS Dock / Linux launcher.
- Right-click menu: copy text, copy/save images, copy/open links.
- External links open in the OS default browser; `zalo://` deep links are
  resolved *inside* the app so it never gets kicked out to the native Zalo
  application. See [Opening Zalo links from outside](#opening-zalo-links-from-outside).
- `about:blank` popups and internal zalo.me / zaloapp.com links are allowed
  inside the app so voice / video calls (WebRTC) work smoothly.
- Network resilience: retries up to 10 times on connection loss, then shows
  a friendly error page that reconnects automatically once back online.
- macOS: native Application Menu so Cmd+C / Cmd+V / Cmd+Q work.
- Modern Chrome User-Agent set globally so Zalo does not reject the app as
  an outdated browser.

## Opening Zalo links from outside

Zalo links such as `https://zalo.me/g/z2x2jz42jt44o02povvr` (a group invite)
can be handed to the app and they open in the main window instead of a browser
tab. The app loads the URL directly; Zalo's own redirect chain
(`zalo.me/g/...` → `id.zalo.me/account/login?continue=...` → the group) runs
inside the app, and since you are already signed in there the login hop is a
no-op.

Four ways in:

| Entry point | Example |
|---|---|
| **Paste it into the app** | Tray → *Open Zalo Link…*, or <kbd>Ctrl</kbd>+<kbd>L</kbd> in the main window |
| Command line | `"Zalo Web.exe" https://zalo.me/g/z2x2jz42jt44o02povvr` |
| `zaloweb://` scheme | `zaloweb://open?url=https%3A%2F%2Fzalo.me%2Fg%2Fz2x2jz42jt44o02povvr` |
| `zalo://` scheme | `zalo://zalo.me/g/z2x2jz42jt44o02povvr` |

The paste box is the one that always works, because it needs nothing from the
OS. It opens pre-filled when a Zalo link is already on the clipboard, rejects
anything that is not a Zalo link, and takes <kbd>Enter</kbd> to open /
<kbd>Esc</kbd> to close.

`zaloweb://` belongs to this app and is registered at runtime on every launch,
so it becomes available the first time you open the app — the Windows
installer does not register it (electron-builder's `protocols` field is macOS
only, where it fills in `CFBundleURLTypes` for the `.dmg` build). `zalo://` is the scheme the **native Zalo client** owns —
claiming it is opt-in through the tray checkbox *Open zalo:// Links in This
App*, and unticking it hands the scheme back.

If the app is already running, the link is routed to the existing window
(single-instance lock) rather than starting a second copy.

Only Zalo hosts (`zalo.me`, `zaloapp.com`, `zdn.vn`, `zadn.vn` and their
subdomains) are ever loaded in the window. A link to anywhere else — including
one smuggled in as `zaloweb://open?url=https://example.com` — is either sent to
the OS browser or falls back to the chat list, so the scheme cannot be used to
render an arbitrary page inside the app shell.

> **Note on `https://` links:** Windows has no per-domain HTTP handler, so a
> `zalo.me` link clicked in Chrome still opens in Chrome. Getting it into the
> app needs one of the entry points above (a custom scheme, or passing the URL
> on the command line). On macOS the tray toggle for `zalo://` is best-effort:
> the scheme is not declared in the app bundle, so the OS may keep pointing it
> at the native client.
