// FinchWire Chrome Extension Content Script
console.log('FinchWire Extension Active');

const INJECTION_CLASS = 'finchwire-injected';

function injectControls(element) {
    if (element.classList.contains(INJECTION_CLASS)) return;
    element.classList.add(INJECTION_CLASS);

    const title = element.getAttribute('data-media-title');
    const mediaUrl = element.getAttribute('data-media-url');
    const audioUrl = element.getAttribute('data-audio-url');
    const vlcUrl = element.getAttribute('data-vlc-url');

    if (!mediaUrl) return;

    const container = document.createElement('div');
    container.className = 'finchwire-extension-controls';
    
    const mainBtn = document.createElement('button');
    mainBtn.className = 'fw-main-btn';
    mainBtn.innerHTML = '🐦 FinchWire';
    
    const menu = document.createElement('div');
    menu.className = 'fw-menu hidden';
    
    const actions = [
        { label: '📥 Download Video', action: 'DOWNLOAD_VIDEO', url: mediaUrl },
        { label: '🎵 Download Audio', action: 'DOWNLOAD_AUDIO', url: audioUrl || mediaUrl + '?audio=true' },
        { label: '📺 Open in VLC', action: 'OPEN_VLC', url: vlcUrl },
        { label: '🔗 Copy Media URL', action: 'COPY_URL', url: mediaUrl }
    ];

    actions.forEach(item => {
        if (item.action === 'DOWNLOAD_AUDIO' && !audioUrl && !mediaUrl.includes('youtube')) return; 
        
        const btn = document.createElement('button');
        btn.innerText = item.label;
        btn.onclick = (e) => {
            e.stopPropagation();
            if (item.action === 'COPY_URL') {
                navigator.clipboard.writeText(item.url).then(() => {
                    btn.innerText = '✅ Copied!';
                    setTimeout(() => btn.innerText = item.label, 2000);
                });
            } else {
                chrome.runtime.sendMessage({ 
                    type: item.action, 
                    url: item.url, 
                    filename: title 
                });
                menu.classList.add('hidden');
            }
        };
        menu.appendChild(btn);
    });

    mainBtn.onclick = (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    };

    container.appendChild(mainBtn);
    container.appendChild(menu);
    
    // Find a good place to inject
    const titleEl = element.querySelector('.job-title') || element.querySelector('#player-title') || element;
    titleEl.parentElement.appendChild(container);
    
    // Handle clicking outside to close menu
    document.addEventListener('click', () => menu.classList.add('hidden'));
}

// Observer for SPA/Dynamic content
const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
                if (node.classList.contains('job-item') || node.classList.contains('finchwire-media-root')) {
                    injectControls(node);
                }
                const subItems = node.querySelectorAll('.job-item, .finchwire-media-root');
                subItems.forEach(injectControls);
            }
        });
    });
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial scan
document.querySelectorAll('.job-item, .finchwire-media-root').forEach(injectControls);
