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

let mainWindow = null;
let tray = null;
let isQuitting = false;
let unreadCount = 0;
let retryCount = 0;
let retryTimer = null;

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
    // External links → default browser (zalo:// deep links are blocked)
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return; // internal error page
    if (!isInternalUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
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
      if (mainWindow) mainWindow.loadURL(APP_URL);
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
function createMainWindow(startHidden = false) {
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

  mainWindow.loadURL(APP_URL);

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
    {
      label: 'Reload Page',
      click: () => {
        retryCount = 0;
        if (mainWindow) mainWindow.loadURL(APP_URL);
      },
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
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.ducvd.zaloweb');
    }
    setupAppMenu();
    // Started at login → stay quiet in the tray, no window popping up
    const startHidden =
      process.argv.includes(AUTO_START_ARG) ||
      app.getLoginItemSettings().wasOpenedAsHidden;
    createMainWindow(startHidden);
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
