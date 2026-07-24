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

- System tray: Open App / Reload Page / Launch at Startup (with a checkmark
  showing its state) / Quit; the (X) button only hides the app to the tray.
- Unread message counter parsed from the page title: tray tooltip, red-dot
  overlay on the Windows Taskbar, badge on the macOS Dock / Linux launcher.
- Right-click menu: copy text, copy/save images, copy/open links.
- External links open in the OS default browser; `zalo://` deep links are
  blocked so the app never gets kicked out to the native Zalo application.
- `about:blank` popups and internal zalo.me / zaloapp.com links are allowed
  inside the app so voice / video calls (WebRTC) work smoothly.
- Network resilience: retries up to 10 times on connection loss, then shows
  a friendly error page that reconnects automatically once back online.
- macOS: native Application Menu so Cmd+C / Cmd+V / Cmd+Q work.
- Modern Chrome User-Agent set globally so Zalo does not reject the app as
  an outdated browser.
