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

const APP_URL = 'https://www.messenger.com/';

// Các host được phép mở NGAY TRONG ứng dụng (hệ sinh thái Facebook/Messenger).
// Mọi thứ khác sẽ bị đẩy ra trình duyệt mặc định của hệ điều hành.
const INTERNAL_HOSTS = [
  'messenger.com',
  'facebook.com',
  'fb.com',
  'fbcdn.net',
  'fbsbx.com',
];

// UA của Chrome mới để Facebook không chặn "trình duyệt cũ" (đặc biệt quan trọng với Zalo).
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_RETRY = 10;
const RETRY_DELAY_MS = 3000;

// Cờ báo app được khởi động cùng hệ thống → mở ẩn dưới khay, không bung cửa sổ
const AUTO_START_ARG = '--hidden';

let mainWindow = null;
let tray = null;
let isQuitting = false;
let unreadCount = 0;
let retryCount = 0;
let retryTimer = null;

// ---------------------------------------------------------------------------
// Icon: chọn định dạng theo hệ điều hành (.ico cho Windows, .icns cho macOS,
// .png cho Linux), thiếu file nào thì lùi về .png.
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
  // macOS dùng icon 16-22px trên menu bar; Windows tự scale nhưng resize cho nét.
  const size = process.platform === 'darwin' ? 18 : 16;
  return img.resize({ width: size, height: size });
}

// ---------------------------------------------------------------------------
// Phân loại URL
// ---------------------------------------------------------------------------
function isInternalUrl(url) {
  if (url === 'about:blank' || url === 'about:blank#blocked') return true; // popup WebRTC
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

// Bóc URL gốc khỏi Link Shim của Facebook (l.facebook.com/l.php?u=...)
function extractLinkShim(url) {
  try {
    const u = new URL(url);
    const isShim =
      (u.hostname === 'l.facebook.com' ||
        u.hostname === 'lm.facebook.com' ||
        u.hostname === 'l.messenger.com') &&
      u.pathname === '/l.php';
    if (isShim) {
      const target = u.searchParams.get('u');
      if (target) return target;
    }
  } catch {
    /* không phải URL hợp lệ */
  }
  return null;
}

// Mở link bằng trình duyệt hệ thống. Chỉ cho phép http/https —
// các deep-link kiểu zalo://, fb-messenger:// bị chặn để app không bị "đá văng".
function openExternal(url) {
  const real = extractLinkShim(url) || url;
  try {
    const protocol = new URL(real).protocol;
    if (protocol === 'http:' || protocol === 'https:') {
      shell.openExternal(real);
    }
  } catch {
    /* URL hỏng — bỏ qua */
  }
}

// ---------------------------------------------------------------------------
// Khởi động cùng hệ thống
// Windows: dùng Task Scheduler (không bị Windows/AV vô hiệu hóa như Run key).
// macOS: dùng Login Items của hệ điều hành.
// Linux: ghi file .desktop vào ~/.config/autostart (chuẩn XDG).
// ---------------------------------------------------------------------------
const { execFileSync } = require('child_process');
const WIN_TASK_NAME = 'FBMessengerAutoStart';

function runPowerShell(command) {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
    { stdio: 'ignore', windowsHide: true }
  );
}

function winTaskExists() {
  try {
    runPowerShell(
      `if (Get-ScheduledTask -TaskName '${WIN_TASK_NAME}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`
    );
    return true;
  } catch {
    return false;
  }
}

function winTaskCreate() {
  const exe = process.execPath.replace(/'/g, "''");
  runPowerShell(
    `$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '${AUTO_START_ARG}'; ` +
      `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ` +
      // ExecutionTimeLimit 0 = không giới hạn thời gian chạy (mặc định task bị ngắt sau 3 ngày)
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0); ` +
      `Register-ScheduledTask -TaskName '${WIN_TASK_NAME}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`
  );
}

function winTaskDelete() {
  runPowerShell(
    `Unregister-ScheduledTask -TaskName '${WIN_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`
  );
}

function linuxAutostartFile() {
  return path.join(app.getPath('home'), '.config', 'autostart', 'fbmess.desktop');
}

// Cache trạng thái để menu khay không phải gọi PowerShell mỗi lần mở
let autoStartCache = null;

function isAutoStartEnabled() {
  if (process.platform === 'win32') {
    if (autoStartCache === null) autoStartCache = winTaskExists();
    return autoStartCache;
  }
  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartFile());
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoStart(enable) {
  try {
    if (process.platform === 'win32') {
      if (enable) {
        winTaskCreate();
        // Dọn phương pháp cũ (Registry Run key từ bản 1.1.x trước) để không khởi động 2 lần
        app.setLoginItemSettings({ openAtLogin: false, args: [AUTO_START_ARG] });
      } else {
        winTaskDelete();
      }
      autoStartCache = winTaskExists(); // xác nhận trạng thái thật sau thao tác
    } else if (process.platform === 'linux') {
      const file = linuxAutostartFile();
      if (enable) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          [
            '[Desktop Entry]',
            'Type=Application',
            'Name=FB Messenger',
            'Comment=Start Messenger at login',
            `Exec="${process.execPath}" ${AUTO_START_ARG}`,
            'X-GNOME-Autostart-enabled=true',
            '',
          ].join('\n')
        );
      } else {
        fs.rmSync(file, { force: true });
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: true });
    }
  } catch (err) {
    console.log(`[FBMess] Failed to update auto-start: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Đếm tin nhắn chưa đọc từ tiêu đề trang, ví dụ "(3) Messenger"
// ---------------------------------------------------------------------------
function updateUnreadCount(title) {
  const m = /\((\d+)\+?\)/.exec(title || '');
  const count = m ? parseInt(m[1], 10) : 0;
  if (count === unreadCount) return;
  const increased = count > unreadCount;
  unreadCount = count;

  // Tooltip ở khay hệ thống
  if (tray) {
    tray.setToolTip(
      count > 0 ? `Messenger — ${count} unread messages` : 'Messenger'
    );
  }

  // Badge trên Dock (macOS) / Launcher (Linux)
  if (process.platform !== 'win32') {
    app.setBadgeCount(count);
  }

  // Dấu chấm đỏ trên Taskbar (Windows)
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

  // Nháy Taskbar khi có tin mới mà cửa sổ không focus
  if (increased && mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
}

// ---------------------------------------------------------------------------
// Menu chuột phải: copy chữ, copy hình ảnh, copy/mở link...
// ---------------------------------------------------------------------------
function buildContextMenu(contents, params) {
  const menu = new Menu();

  if (params.linkURL) {
    const realLink = extractLinkShim(params.linkURL) || params.linkURL;
    menu.append(
      new MenuItem({
        label: 'Open Link in Browser',
        click: () => openExternal(realLink),
      })
    );
    menu.append(
      new MenuItem({
        label: 'Copy Link Address',
        click: () => clipboard.writeText(realLink),
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
// Giám sát MỌI webContents (cửa sổ chính + mọi popup) — không link ngoài nào lọt qua
// ---------------------------------------------------------------------------
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Link Shim → bóc URL gốc, đẩy ra trình duyệt, bỏ qua lớp tracking
    const shimTarget = extractLinkShim(url);
    if (shimTarget) {
      openExternal(shimTarget);
      return { action: 'deny' };
    }
    // Popup nội bộ (về about:blank cho WebRTC, cửa sổ gọi thoại/video...)
    if (isInternalUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          icon: getIconPath(),
        },
      };
    }
    // Link web ngoài → trình duyệt mặc định
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return; // trang báo lỗi nội bộ
    const shimTarget = extractLinkShim(url);
    if (shimTarget) {
      event.preventDefault();
      openExternal(shimTarget);
      return;
    }
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
// Bảo vệ kết nối: tự thử lại tối đa 10 lần, hỏng hẳn thì hiện trang lỗi thân thiện
// ---------------------------------------------------------------------------
function handleLoadFailure(errorCode, errorDescription) {
  // -3 (ERR_ABORTED) thường do điều hướng bình thường, không phải lỗi mạng
  if (errorCode === -3 || !mainWindow) return;

  if (retryCount < MAX_RETRY) {
    retryCount += 1;
    console.log(
      `[FBMess] Connection lost (${errorDescription}). Retry ${retryCount}/${MAX_RETRY}...`
    );
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (mainWindow) mainWindow.loadURL(APP_URL);
    }, RETRY_DELAY_MS);
  } else {
    console.log('[FBMess] Connection failed permanently, showing error page.');
    retryCount = 0;
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  }
}

// ---------------------------------------------------------------------------
// Cửa sổ chính
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
    title: 'Messenger',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
  });

  // Cho phép mic/camera/chia sẻ màn hình/thông báo với origin nội bộ (WebRTC)
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
    if (!url.startsWith('file://')) retryCount = 0; // mạng ổn trở lại
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) handleLoadFailure(errorCode, errorDescription);
    }
  );

  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  // Bấm (X): ẩn xuống khay (Windows/Linux) hoặc ẩn khỏi màn hình nhưng giữ trên Dock (macOS)
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
// Khay hệ thống
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
      label: 'Start with System',
      type: 'checkbox',
      checked: isAutoStartEnabled(),
      click: (item) => {
        setAutoStart(item.checked);
        tray.setContextMenu(buildTrayMenu()); // đồng bộ lại trạng thái tick
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
  tray.setToolTip('Messenger');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

// ---------------------------------------------------------------------------
// Application Menu cho macOS (để Cmd+C, Cmd+V, Cmd+Q... hoạt động)
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
// Vòng đời ứng dụng
// ---------------------------------------------------------------------------
app.userAgentFallback = USER_AGENT; // User-Agent toàn cục

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.ducvd.fbmess');
    }
    setupAppMenu();
    // Khởi động cùng hệ thống → nằm im dưới khay, không bung cửa sổ
    const startHidden =
      process.argv.includes(AUTO_START_ARG) ||
      app.getLoginItemSettings().wasOpenedAsHidden;
    createMainWindow(startHidden);
    createTray();
  });

  // macOS: bấm icon trên Dock thì hiện lại cửa sổ
  app.on('activate', showMainWindow);

  app.on('before-quit', () => {
    isQuitting = true;
  });

  // Không thoát khi đóng hết cửa sổ — app sống ở khay hệ thống / Dock
  app.on('window-all-closed', () => {
    /* giữ app chạy nền */
  });
}
