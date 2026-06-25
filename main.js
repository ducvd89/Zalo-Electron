const { app, BrowserWindow, session, Tray, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');

// [WINDOWS] Register App User Model ID for native notifications
if (process.platform === 'win32') {
    app.setAppUserModelId('com.cachyos.zalo');
}

// [CRITICAL FIX] Global User-Agent spoofing to bypass Zalo's strict browser detection in ALL popups & redirects
app.userAgentFallback = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let win;
let tray = null;
let isQuitting = false;

// --- HANDLE MACOS QUIT COMMAND (Cmd + Q) ---
app.on('before-quit', () => {
    isQuitting = true;
});

// --- SINGLE INSTANCE LOCK ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    const iconPath = process.platform === 'win32' ? path.join(__dirname, 'icon.ico') : path.join(__dirname, 'icon.png');

    // --- HELPER: CHECK IF DOMAIN IS ZALO ECOSYSTEM ---
    const isZaloEcosystem = (hostname) => {
        // Zalo uses multiple domains for Auth, CDN, and APIs
        const allowedDomains = ['zalo.me', 'zaloapp.com', 'zalo.vn', 'zdn.vn', 'zing.vn'];
        return allowedDomains.some(domain => hostname.includes(domain));
    };

    // --- HELPER: EXTRACT AND OPEN EXTERNAL LINKS ---
    const handleExternalLink = (urlToOpen) => {
        try {
            shell.openExternal(urlToOpen);
        } catch (err) {
            if (urlToOpen.startsWith('http')) shell.openExternal(urlToOpen);
        }
    };

    // --- GLOBAL WEB CONTENTS GUARD (Monitors Main Window & Popups) ---
    app.on('web-contents-created', (event, contents) => {

        contents.setWindowOpenHandler(({ url }) => {
            // Block Zalo's annoying deep-link attempts to open native app
            if (url.startsWith('zalo://')) return { action: 'deny' };

                // Allow blank popups (used for Auth, QR, or media viewers)
                if (url === 'about:blank' || url.startsWith('about:')) {
                    return {
                        action: 'allow',
                        overrideBrowserWindowOptions: {
                            autoHideMenuBar: true,
                            icon: iconPath,
                            webPreferences: { nodeIntegration: false, contextIsolation: true }
                        }
                    };
                }

                try {
                    const parsedUrl = new URL(url);
                    // Allow all Zalo ecosystem links to open INSIDE the app
                    if (isZaloEcosystem(parsedUrl.hostname)) {
                        return {
                            action: 'allow',
                            overrideBrowserWindowOptions: {
                                autoHideMenuBar: true,
                                icon: iconPath,
                                webPreferences: { nodeIntegration: false, contextIsolation: true }
                            }
                        };
                    } else {
                        handleExternalLink(url);
                        return { action: 'deny' };
                    }
                } catch (err) {
                    handleExternalLink(url);
                    return { action: 'deny' };
                }
        });

        // Intercept all in-page navigations and server-side redirects (Crucial for Login flow)
        const navigateHandler = (event, url) => {
            if (url.startsWith('zalo://')) {
                event.preventDefault();
                return;
            }

            if (url === 'about:blank' || url.startsWith('about:')) return;

            try {
                const parsedUrl = new URL(url);
                // Block external links from loading inside the app frame
                if (!isZaloEcosystem(parsedUrl.hostname)) {
                    event.preventDefault();
                    handleExternalLink(url);

                    // If an external link was clicked inside a popup, close the empty popup
                    if (win && contents !== win.webContents) {
                        const popupWin = BrowserWindow.fromWebContents(contents);
                        if (popupWin) popupWin.close();
                    }
                }
            } catch (err) {
                console.error("URL Parsing Error: ", err);
            }
        };

        contents.on('will-navigate', navigateHandler);
        contents.on('will-redirect', navigateHandler); // Catches Zalo's internal OAuth redirects
    });

    app.on('second-instance', () => {
        if (win) {
            if (!win.isVisible()) win.show();
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    function createWindow() {
        win = new BrowserWindow({
            width: 1200,
            height: 800,
            title: "Zalo",
            icon: iconPath,
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        // --- MACOS MENU CONFIGURATION ---
        if (process.platform === 'darwin') {
            const template = [
                { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
                { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
            ];
            Menu.setApplicationMenu(Menu.buildFromTemplate(template));
        }

        // --- CONNECTION & PAGE LOADING LOGIC ---
        let retryCount = 0;
        const maxRetries = 10;

        const loadApp = () => {
            // Note: userAgent is now handled globally at the top of the file
            win.loadURL('https://chat.zalo.me/').catch(() => {});
        };

        loadApp();

        win.webContents.on('did-finish-load', () => { retryCount = 0; });

        win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame) return;
            if (retryCount < maxRetries) {
                retryCount++;
                console.log(`Network disconnected. Retrying... Attempt ${retryCount}/${maxRetries}`);
                setTimeout(() => { if (win) loadApp(); }, 5000);
            } else {
                dialog.showErrorBox('Network Error', 'Cannot connect to Zalo. Please check your internet connection.');
                win.loadURL(`data:text/html;charset=utf-8,<body style="display:flex;justify-content:center;align-items:center;height:100vh;background-color:#1e1e1e;color:white;font-family:sans-serif;"><h2>No Internet Connection 🌐</h2></body>`);
            }
        });

        // Handle Close (X) button
        win.on('close', (event) => {
            if (!isQuitting) {
                event.preventDefault();
                win.hide();
            }
        });
    }

    // --- SYSTEM TRAY INITIALIZATION ---
    function createTray() {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show Zalo', click: () => win.show() },
                                                   { label: 'Reload', click: () => { if (win) { win.reload(); win.show(); } } },
                                                   { type: 'separator' },
                                                   { label: 'Quit', click: () => { isQuitting = true; app.quit(); }}
        ]);
        tray.setToolTip('Zalo');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => { win.isVisible() ? win.hide() : win.show(); });
    }

    // --- NOTIFICATION BADGE UPDATE ---
    ipcMain.on('update-badge', (event, count) => {
        const titleText = count ? `Zalo (${count})` : 'Zalo';
        const tooltipText = count ? `Zalo (${count} unread messages)` : 'Zalo';

        if (win) win.setTitle(titleText);
        if (tray) tray.setToolTip(tooltipText);

        // [MACOS / UBUNTU] Show red dot badge on Dock
        if (app.setBadgeCount) app.setBadgeCount(count ? parseInt(count) : 0);
    });

        // --- APP INITIALIZATION ---
        app.whenReady().then(() => {
            session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
                const allowed = ['media', 'notifications', 'fullscreen'];
                callback(allowed.includes(permission));
            });

            createWindow();
            createTray();

            // [MACOS] Handle click on Dock icon
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) { createWindow(); } else if (win && !win.isVisible()) { win.show(); }
            });
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin' && isQuitting) app.quit();
        });
}
