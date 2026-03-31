// FinchWire Background Service Worker (MV3)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'DOWNLOAD_VIDEO':
        case 'DOWNLOAD_AUDIO':
            chrome.downloads.download({
                url: message.url,
                filename: `${message.filename || 'download'}.${message.type === 'DOWNLOAD_AUDIO' ? 'm4a' : 'mp4'}`,
                saveAs: true
            });
            break;
            
        case 'OPEN_VLC':
            if (sender.tab) {
                chrome.tabs.update(sender.tab.id, { url: message.url });
            }
            break;
            
        case 'REMOTE_DOWNLOAD':
            handleRemoteDownload(message.url, message.filename, sendResponse);
            return true; // Keep message channel open for async response

        case 'OPEN_OPTIONS':
            chrome.runtime.openOptionsPage();
            break;
            
        case 'COPY_URL':
            // Handled in content script
            break;
    }
});

async function handleRemoteDownload(videoUrl, title, sendResponse) {
    try {
        const { serverUrl, serverPassword } = await chrome.storage.sync.get(['serverUrl', 'serverPassword']);
        
        if (!serverUrl || !serverPassword) {
            console.error('FinchWire: Server URL or Password not set in options.');
            sendResponse({ success: false, error: 'Configuration missing' });
            return;
        }

        const response = await fetch(`${serverUrl}/api/downloads`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-FinchWire-Token': serverPassword
            },
            body: JSON.stringify({
                url: videoUrl,
                filename: title
            })
        });

        if (response.ok) {
            const data = await response.json();
            console.log('FinchWire: Remote download started successfully:', data);
            
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon128.png',
                title: 'FinchWire Download Started',
                message: `Successfully sent "${title}" to your server.`,
                priority: 2
            });

            sendResponse({ success: true, data });
        } else {
            const error = await response.json();
            console.error('FinchWire: Remote download failed:', error);
            sendResponse({ success: false, error: error.error || 'Server error' });
        }
    } catch (err) {
        console.error('FinchWire: Remote communication error:', err);
        sendResponse({ success: false, error: err.message });
    }
}
