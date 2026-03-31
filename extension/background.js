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
            
        case 'COPY_URL':
            // Clipboard API is tricky in service workers, but logic can be handled in content script 
            // or use a temporary offscreen document for MV3 if needed. 
            // For now, content.js can just handle copy to clipboard directly.
            break;
    }
});
