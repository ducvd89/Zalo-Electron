const { contextBridge, ipcRenderer } = require('electron');

// The "Open Zalo Link" dialog runs sandboxed with context isolation on, so
// this is the only surface it gets. Validation and navigation both happen in
// the main process — the renderer never sees a URL it did not type.
contextBridge.exposeInMainWorld('zaloLink', {
  // Resolves to { ok: true } when the link was accepted and opened.
  open: (url) => ipcRenderer.invoke('open-link', url),

  // A Zalo link already on the clipboard, or '' when there is none.
  clipboardLink: () => ipcRenderer.invoke('clipboard-link'),

  cancel: () => ipcRenderer.send('close-link-dialog'),
});
