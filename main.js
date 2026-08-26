const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  MenuItem,
  shell,
  clipboard,
  nativeImage,
  session,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://chat.zalo.me/';

// Hosts allowed to open INSIDE the app (Zalo ecosystem).
// Everything else is pushed out to the OS default browser.
const INTERNAL_HOSTS = [
  'zalo.me',      // chat.zalo.me, id.zalo.me (login), qr.zalo.me...
  'zaloapp.com',
  'zdn.vn',       // image/sticker CDN
  'zadn.vn',      // legacy CDN
];

// Modern Chrome UA so Zalo does not block "outdated/unknown browsers".
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_RETRY = 10;
const RETRY_DELAY_MS = 3000;

// Flag meaning the app was started at login → stay hidden in the tray
const AUTO_START_ARG = '--hidden';

// Our own URL scheme (clashes with nothing) and the one the native Zalo
// client owns — taking that one over is opt-in, see the tray menu.
const OWN_PROTOCOL = 'zaloweb';
const ZALO_PROTOCOL = 'zalo';

let mainWindow = null;
let linkWindow = null;
let tray = null;
let isQuitting = false;
let unreadCount = 0;
let retryCount = 0;
let retryTimer = null;

// URL the window is meant to be showing. Retries and "Reload Page" go back to
// the deep link the user opened instead of always landing on APP_URL.
let currentUrl = APP_URL;

// A deep link that arrived before the app was ready (macOS fires `open-url`
// very early); replayed once the window exists.
let pendingDeepLink = null;

// ---------------------------------------------------------------------------
// Icon: pick the format per OS (.ico for Windows, .icns for macOS,
// .png for Linux), falling back to .png when missing.
// ---------------------------------------------------------------------------
function getIconPath() {
  const dir = path.join(__dirname, 'assets');
  const preferred =
    process.platform === 'win32'
      ? 'icon.ico'
      : process.platform === 'darwin'
        ? 'icon.icns'
        : 'icon.png';
  const p = path.join(dir, preferred);
  return fs.existsSync(p) ? p : path.join(dir, 'icon.png');
}

function getTrayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  // macOS menu bar uses 16-22px icons; Windows scales but resizing keeps it crisp.
  const size = process.platform === 'darwin' ? 18 : 16;
  return img.resize({ width: size, height: size });
}

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------
function isInternalUrl(url) {
  if (url === 'about:blank' || url === 'about:blank#blocked') return true; // WebRTC popup
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return INTERNAL_HOSTS.some(
      (h) => u.hostname === h || u.hostname.endsWith('.' + h)
    );
  } catch {
    return false;
  }
}

// Open a link in the system browser. Only http/https is allowed —
// deep links such as zalo:// are blocked so the app never gets kicked
// out to the native Zalo application.
function openExternal(url) {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === 'http:' || protocol === 'https:') {
      shell.openExternal(url);
    }
  } catch {
    /* malformed URL — ignore */
  }
}

// ---------------------------------------------------------------------------
// Deep links: bring Zalo links opened OUTSIDE the app back INTO it.
//
// Accepted shapes:
//   https://zalo.me/g/<code>     group invite — loaded as-is, Zalo redirects
//                                through id.zalo.me and lands on the group
//   https://chat.zalo.me/...     loaded as-is
//   zalo://zalo.me/g/<code>      rewritten to https
//   zalo://conversation?id=...   no web equivalent, opens the app itself
//   zaloweb://open?url=<encoded> escape hatch for scripts / other apps
//
// Anything that is not a Zalo link returns null and keeps going to the OS
// browser, so this can never become an open redirect into the app shell.
// ---------------------------------------------------------------------------
function toInternalUrl(raw, depth = 0) {
  if (typeof raw !== 'string' || !raw.trim() || depth > 3) return null;

  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }

  // Plain web links: keep only the ones inside the Zalo ecosystem.
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    if (!isInternalUrl(u.href)) return null;
    u.protocol = 'https:';
    return u.href;
  }

  if (u.protocol !== OWN_PROTOCOL + ':' && u.protocol !== ZALO_PROTOCOL + ':') {
    return null;
  }

  // zaloweb://open?url=https%3A%2F%2Fzalo.me%2Fg%2Fabc — the wrapped URL goes
  // back through this same function, so only Zalo hosts survive.
  if (u.protocol === OWN_PROTOCOL + ':' && u.hostname === 'open') {
    return toInternalUrl(u.searchParams.get('url'), depth + 1) || APP_URL;
  }

  // zalo://zalo.me/g/abc → https://zalo.me/g/abc
  const host = u.hostname;
  if (host && INTERNAL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    return 'https://' + host + u.pathname + u.search + u.hash;
  }

  // Any other zalo:// shape has no documented web equivalent — open the app
  // rather than dropping the click on the floor.
  return APP_URL;
}

// Load a Zalo URL in the main window, creating / un-hiding it as needed.
function openInApp(url) {
  if (!app.isReady()) {
    pendingDeepLink = url;
    return;
  }
  if (!mainWindow) {
    createMainWindow(false, url);
    return;
  }

  showMainWindow();

  const loaded = mainWindow.webContents.getURL();
  // Already where we were asked to go — just focus, no jarring SPA reload.
  if (url === loaded || (url === APP_URL && loaded.startsWith(APP_URL))) return;

  retryCount = 0;
  currentUrl = url;
  mainWindow.loadURL(url);
}

// Returns true when the URL was a Zalo link and got handled internally.
function handleDeepLink(raw) {
  const target = toInternalUrl(raw);
  if (!target) return false;
  openInApp(target);
  return true;
}

// Windows / Linux hand the deep link over as a command-line argument, both on
// a cold start and through the `second-instance` event.
function deepLinkFromArgv(argv) {
  return (
    argv.slice(1).find((arg) => !arg.startsWith('-') && toInternalUrl(arg)) || null
  );
}

// ---------------------------------------------------------------------------
// "Open Zalo Link" dialog — paste a link straight into the app.
//
// Windows routes https:// links by scheme, not by domain, so a zalo.me link
// clicked anywhere else always lands in the default browser. This is the way
// in that does not depend on the OS handing us anything.
// ---------------------------------------------------------------------------
function openLinkDialog() {
  if (linkWindow) {
    if (linkWindow.isMinimized()) linkWindow.restore();
    linkWindow.focus();
    return;
  }

  linkWindow = new BrowserWindow({
    width: 520,
    height: 230,
    // Size the web page itself — the title bar height differs per OS and would
    // otherwise eat into the form.
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Open Zalo Link',
    icon: getIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'open-link-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  linkWindow.loadFile(path.join(__dirname, 'open-link.html'));
  linkWindow.once('ready-to-show', () => linkWindow.show());
  linkWindow.on('closed', () => {
    linkWindow = null;
  });
}

function closeLinkDialog() {
  if (linkWindow) linkWindow.close();
}

// The renderer only ever hands over raw text; toInternalUrl decides whether it
// is a Zalo link at all, so a typo cannot navigate the app somewhere else.
ipcMain.handle('open-link', (_event, raw) => {
  const target = toInternalUrl(raw);
  if (!target) return { ok: false };
  closeLinkDialog();
  openInApp(target);
  return { ok: true };
});

ipcMain.handle('clipboard-link', () => {
  const text = clipboard.readText().trim();
  return toInternalUrl(text) ? text : '';
});

ipcMain.on('close-link-dialog', closeLinkDialog);

// In development the app runs as `electron .`, so the scheme has to point at
// the Electron binary plus the project path; a packaged build needs neither.
function protocolClientArgs() {
  return app.isPackaged || !process.argv[1] ? [] : [path.resolve(process.argv[1])];
}

function isProtocolClient(scheme) {
  return app.isDefaultProtocolClient(scheme, process.execPath, protocolClientArgs());
}

function setProtocolClient(scheme, enable) {
  const args = protocolClientArgs();
  return enable
    ? app.setAsDefaultProtocolClient(scheme, process.execPath, args)
    : app.removeAsDefaultProtocolClient(scheme, process.execPath, args);
}

// ---------------------------------------------------------------------------
// Launch at startup
// Windows/macOS: use the OS Login Items.
// Linux: write a .desktop file into ~/.config/autostart (XDG standard).
// ---------------------------------------------------------------------------
function linuxAutostartFile() {
  return path.join(app.getPath('home'), '.config', 'autostart', 'zaloweb.desktop');
}

function isAutoStartEnabled() {
  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartFile());
  }
  // Windows: must query with the exact registered args, otherwise openAtLogin is always false
  return app.getLoginItemSettings({ args: [AUTO_START_ARG] }).openAtLogin;
}

function setAutoStart(enable) {
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (enable) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Zalo Web',
          'Comment=Start Zalo at login',
          `Exec="${process.execPath}" ${AUTO_START_ARG}`,
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n')
      );
    } else {
      fs.rmSync(file, { force: true });
    }
  } else {
    app.setLoginItemSettings({
      openAtLogin: enable,
      openAsHidden: true, // macOS: open hidden
      args: [AUTO_START_ARG], // Windows: open hidden via the --hidden flag
    });
  }
}

// ---------------------------------------------------------------------------
// Unread message count parsed from the page title, e.g. "(3) Zalo"
// ---------------------------------------------------------------------------
function updateUnreadCount(title) {
  const m = /\((\d+)\+?\)/.exec(title || '');
  const count = m ? parseInt(m[1], 10) : 0;
  if (count === unreadCount) return;
  const increased = count > unreadCount;
  unreadCount = count;

  // System tray tooltip
  if (tray) {
    tray.setToolTip(
      count > 0 ? `Zalo — ${count} unread messages` : 'Zalo'
    );
  }

  // Badge on the Dock (macOS) / Launcher (Linux)
  if (process.platform !== 'win32') {
    app.setBadgeCount(count);
  }

  // Red dot on the Taskbar (Windows)
  if (process.platform === 'win32' && mainWindow) {
    if (count > 0) {
      const badge = nativeImage.createFromPath(
        path.join(__dirname, 'assets', 'badge.png')
      );
      mainWindow.setOverlayIcon(badge, `${count} unread messages`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  }

  // Flash the Taskbar when new messages arrive while the window is unfocused
  if (increased && mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
}

// ---------------------------------------------------------------------------
// Right-click menu: copy text, copy image, copy/open links...
// ---------------------------------------------------------------------------
function buildContextMenu(contents, params) {
  const menu = new Menu();

  if (params.linkURL) {
    // A Zalo link stays home; anything else is a trip to the browser.
    if (toInternalUrl(params.linkURL)) {
      menu.append(
        new MenuItem({
          label: 'Open Link in Zalo',
          click: () => handleDeepLink(params.linkURL),
        })
      );
    }
    menu.append(
      new MenuItem({
        label: 'Open Link in Browser',
        click: () => openExternal(params.linkURL),
      })
    );
    menu.append(
      new MenuItem({
        label: 'Copy Link Address',
        click: () => clipboard.writeText(params.linkURL),
      })
    );
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.mediaType === 'image') {
    menu.append(
      new MenuItem({
        label: 'Copy Image',
        click: () => contents.copyImageAt(params.x, params.y),
      })
    );
    menu.append(
      new MenuItem({
        label: 'Save Image…',
        click: () => contents.downloadURL(params.srcURL),
      })
    );
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (params.isEditable) {
    menu.append(new MenuItem({ label: 'Cut', role: 'cut' }));
    menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    menu.append(new MenuItem({ label: 'Paste', role: 'paste' }));
    menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
  } else if (params.selectionText && params.selectionText.trim()) {
    menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
  }

  return menu.items.length > 0 ? menu : null;
}

// ---------------------------------------------------------------------------
// Watch EVERY webContents (main window + all popups) — no external link slips through
// ---------------------------------------------------------------------------
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Internal popups (about:blank for WebRTC, voice/video call windows...)
    if (isInternalUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          icon: getIconPath(),
        },
      };
    }
    // zalo:// deep links land in this window instead of kicking us over to the
    // native Zalo client; everything else goes out to the default browser.
    if (!handleDeepLink(url)) openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return; // internal error page
    if (isInternalUrl(url)) return;
    event.preventDefault();
    if (!handleDeepLink(url)) openExternal(url);
  });

  contents.on('context-menu', (_e, params) => {
    const menu = buildContextMenu(contents, params);
    if (menu) menu.popup();
  });
});

// ---------------------------------------------------------------------------
// Network resilience: retry up to 10 times, then show a friendly error page
// ---------------------------------------------------------------------------
function handleLoadFailure(errorCode, errorDescription) {
  // -3 (ERR_ABORTED) is usually a normal navigation, not a network failure
  if (errorCode === -3 || !mainWindow) return;

  if (retryCount < MAX_RETRY) {
    retryCount += 1;
    console.log(
      `[ZaloWeb] Connection lost (${errorDescription}). Retry ${retryCount}/${MAX_RETRY}...`
    );
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (mainWindow) mainWindow.loadURL(currentUrl);
    }, RETRY_DELAY_MS);
  } else {
    console.log('[ZaloWeb] Connection failed for good, showing the error page.');
    retryCount = 0;
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  }
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createMainWindow(startHidden = false, initialUrl = APP_URL) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    show: !startHidden,
    icon: getIconPath(),
    autoHideMenuBar: true,
    title: 'Zalo',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
  });

  // Allow mic/camera/screen-share/notifications for internal origins (WebRTC)
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const allowed = [
        'media',
        'mediaKeySystem',
        'notifications',
        'fullscreen',
        'display-capture',
        'pointerLock',
        'clipboard-sanitized-write',
      ];
      const requestOk =
        allowed.includes(permission) && isInternalUrl(webContents.getURL());
      callback(requestOk);
    }
  );

  currentUrl = initialUrl;
  mainWindow.loadURL(initialUrl);

  mainWindow.webContents.on('page-title-updated', (_e, title) => {
    updateUnreadCount(title);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (!url.startsWith('file://')) retryCount = 0; // network is healthy again
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) handleLoadFailure(errorCode, errorDescription);
    }
  );

  // Ctrl+L (Cmd+L on macOS) opens the "paste a link" dialog, the way a browser
  // would focus its address bar.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || input.shift) return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && input.key && input.key.toLowerCase() === 'l') {
      event.preventDefault();
      openLinkDialog();
    }
  });

  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  // Close button (X): hide to tray (Windows/Linux) or hide but stay on the Dock (macOS)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open App', click: showMainWindow },
    { label: 'Open Zalo Link…', click: openLinkDialog },
    {
      label: 'Reload Page',
      click: () => {
        retryCount = 0;
        if (mainWindow) mainWindow.loadURL(currentUrl);
      },
    },
    {
      label: 'Back to Chat List',
      click: () => openInApp(APP_URL),
    },
    { type: 'separator' },
    {
      label: 'Launch at Startup',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      click: (item) => {
        setAutoStart(item.checked);
        tray.setContextMenu(buildTrayMenu()); // re-sync the checkmark state
      },
    },
    {
      // Off by default: claiming zalo:// steals the scheme from the native
      // Zalo client, so the user has to ask for it explicitly.
      label: 'Open zalo:// Links in This App',
      type: 'checkbox',
      checked: isProtocolClient(ZALO_PROTOCOL),
      click: (item) => {
        setProtocolClient(ZALO_PROTOCOL, item.checked);
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Zalo');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

// ---------------------------------------------------------------------------
// Application Menu for macOS (so Cmd+C, Cmd+V, Cmd+Q... work)
// ---------------------------------------------------------------------------
function setupAppMenu() {
  if (process.platform === 'darwin') {
    const menu = Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]);
    Menu.setApplicationMenu(menu);
  } else {
    Menu.setApplicationMenu(null);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.userAgentFallback = USER_AGENT; // global User-Agent

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A second launch is either a plain "open the app" or a deep link the OS
  // handed to a brand new process — either way it belongs to this instance.
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (!link || !handleDeepLink(link)) showMainWindow();
  });

  // macOS delivers deep links here, sometimes before the app is ready.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.ducvd.zaloweb');
    }
    setupAppMenu();

    // zaloweb:// is ours alone, so claim it silently on every start.
    setProtocolClient(OWN_PROTOCOL, true);

    const initialUrl =
      toInternalUrl(pendingDeepLink || deepLinkFromArgv(process.argv)) || APP_URL;
    pendingDeepLink = null;

    // Started at login → stay quiet in the tray, no window popping up.
    // A deep link always wins over that: the user just clicked something.
    const startHidden =
      initialUrl === APP_URL &&
      (process.argv.includes(AUTO_START_ARG) ||
        app.getLoginItemSettings().wasOpenedAsHidden);

    createMainWindow(startHidden, initialUrl);
    createTray();
  });

  // macOS: clicking the Dock icon brings the window back
  app.on('activate', showMainWindow);

  app.on('before-quit', () => {
    isQuitting = true;
  });

  // Do not quit when all windows are closed — the app lives in the tray / Dock
  app.on('window-all-closed', () => {
    /* keep running in the background */
  });
}
