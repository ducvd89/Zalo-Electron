const { ipcRenderer } = require('electron');

// Track the last known message count to avoid spamming IPC messages
let lastCount = 0;

// Set up a MutationObserver to watch for changes to the <title> tag
const observer = new MutationObserver(() => {
    const title = document.title;

    // Zalo sets title like "(2) Zalo" or "(2) Zalo Web" when there are new messages
    const match = title.match(/^\((\d+)\)/);

    // Parse the count, default to 0 if no match
    const count = match ? parseInt(match[1]) : 0;

    // Only send IPC message if the count actually changed
    if (count !== lastCount) {
        lastCount = count;
        ipcRenderer.send('update-badge', count);
    }
});

// Wait for the DOM to load before attaching the observer
window.addEventListener('DOMContentLoaded', () => {
    const titleEl = document.querySelector('title');
    if (titleEl) {
        observer.observe(titleEl, { childList: true });
    }
});
