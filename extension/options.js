// Save settings to chrome.storage
document.getElementById('save').addEventListener('click', () => {
  const serverUrl = document.getElementById('serverUrl').value.replace(/\/$/, ""); // Strip trailing slash
  const serverPassword = document.getElementById('serverPassword').value;

  chrome.storage.sync.set({
    serverUrl,
    serverPassword
  }, () => {
    const status = document.getElementById('status');
    status.textContent = '✅ Settings saved successfully!';
    setTimeout(() => {
      status.textContent = '';
    }, 3000);
  });
});

// Load settings on startup
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['serverUrl', 'serverPassword'], (items) => {
    if (items.serverUrl) document.getElementById('serverUrl').value = items.serverUrl;
    if (items.serverPassword) document.getElementById('serverPassword').value = items.serverPassword;
  });
});
