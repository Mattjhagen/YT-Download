// Save settings to chrome.storage
document.getElementById('save').addEventListener('click', () => {
  const serverUrl = document.getElementById('serverUrl').value.replace(/\/$/, ""); // Strip trailing slash
  const serverPassword = document.getElementById('serverPassword').value;

  // 🔐 Dual-Save: Sync for portability, Local for reliability
  chrome.storage.sync.set({ serverUrl, serverPassword });
  chrome.storage.local.set({ serverUrl, serverPassword }, () => {
    const status = document.getElementById('status');
    status.textContent = '✅ Settings saved (Sync & Local)!';
    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  });
});

// Load settings from both Sync and Local
document.addEventListener('DOMContentLoaded', async () => {
  const syncItems = await chrome.storage.sync.get(['serverUrl', 'serverPassword']);
  const localItems = await chrome.storage.local.get(['serverUrl', 'serverPassword']);
  
  const serverUrl = syncItems.serverUrl || localItems.serverUrl || '';
  const serverPassword = syncItems.serverPassword || localItems.serverPassword || '';
  
  if (serverUrl) document.getElementById('serverUrl').value = serverUrl;
  if (serverPassword) document.getElementById('serverPassword').value = serverPassword;
});
