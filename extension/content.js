// FinchWire Chrome Extension Content Script
console.log('🐦 FinchWire v1.1.0 Ready (YouTube Support Enabled)');

const INJECTION_CLASS = 'finchwire-injected';
const IS_YOUTUBE = window.location.hostname.includes('youtube.com');

// 1. FINCHWIRE APP INJECTION
function injectFinchWireControls(element) {
    if (element.classList.contains(INJECTION_CLASS)) return;
    
    let mediaUrl = element.getAttribute('data-media-url');
    let title = element.getAttribute('data-media-title');
    let vlcUrl = element.getAttribute('data-vlc-url');
    let audioUrl = element.getAttribute('data-audio-url');

    if (!mediaUrl) {
        const playBtn = element.querySelector('.sm-btn[onclick*="openPlayer"]');
        if (playBtn) {
            const onclick = playBtn.getAttribute('onclick');
            const matches = onclick.match(/App\.openPlayer\('(.*?)',\s*(.*?),\s*'(.*?)',\s*'(.*?)'\)/);
            if (matches) {
                mediaUrl = matches[1];
                title = matches[3];
                vlcUrl = matches[4];
            }
        }
    }

    if (!mediaUrl) return;

    element.classList.add(INJECTION_CLASS);
    
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
                navigator.clipboard.writeText(item.url || '').then(() => {
                    const originalText = btn.innerText;
                    btn.innerText = '✅ Copied!';
                    setTimeout(() => btn.innerText = originalText, 2000);
                });
            } else {
                chrome.runtime.sendMessage({ type: item.action, url: item.url, filename: title });
                menu.classList.add('hidden');
            }
        };
        menu.appendChild(btn);
    });

    mainBtn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        document.querySelectorAll('.fw-menu').forEach(m => m.classList.add('hidden'));
        if (wasHidden) menu.classList.remove('hidden');
    };

    container.appendChild(mainBtn);
    container.appendChild(menu);
    
    const target = element.querySelector('.job-actions') || element.querySelector('.modal-content') || element;
    if (target.classList.contains('job-actions')) {
        target.prepend(container);
    } else {
        target.appendChild(container);
    }
}

// 2. YOUTUBE INJECTION
function injectYouTubeControls() {
    // Target YouTube's button bar
    const actionBar = document.querySelector('#top-level-buttons-computed');
    if (!actionBar || actionBar.querySelector('.fw-yt-btn')) return;

    const videoUrl = window.location.href;
    const videoTitle = document.querySelector('h1.ytd-video-primary-info-renderer')?.innerText || 
                       document.querySelector('meta[name="title"]')?.content || 
                       "YouTube Video";

    const btn = document.createElement('button');
    btn.className = 'fw-main-btn fw-yt-btn';
    btn.style.marginLeft = '8px';
    btn.style.height = '36px'; // Matches YT button height
    btn.innerHTML = '🐦 Remote Download';
    
    btn.onclick = (e) => {
        e.preventDefault();
        btn.innerText = '⏳ Sending...';
        btn.style.opacity = '0.7';
        
        chrome.runtime.sendMessage({ 
            type: 'REMOTE_DOWNLOAD', 
            url: videoUrl, 
            filename: videoTitle 
        }, (response) => {
            if (response && response.success) {
                btn.innerText = '✅ Sent to Server';
                btn.style.backgroundColor = '#10b981';
            } else {
                btn.innerText = '❌ Failed (Set URL in Options)';
                btn.style.backgroundColor = '#ef4444';
            }
            setTimeout(() => {
                btn.innerText = '🐦 Remote Download';
                btn.style.backgroundColor = '';
                btn.style.opacity = '';
            }, 5000);
        });
    };

    actionBar.appendChild(btn);
}

// 3. COMMON LOGIC
const observer = new MutationObserver((mutations) => {
    if (IS_YOUTUBE) {
        injectYouTubeControls();
    } else {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.matches('.job-item, .finchwire-media-root')) injectFinchWireControls(node);
                    node.querySelectorAll('.job-item, .finchwire-media-root').forEach(injectFinchWireControls);
                }
            }
        }
    }
});

observer.observe(document.body, { childList: true, subtree: true });

// YouTube SPA detection
if (IS_YOUTUBE) {
    window.addEventListener('yt-navigate-finish', injectYouTubeControls);
    injectYouTubeControls();
} else {
    document.querySelectorAll('.job-item, .finchwire-media-root').forEach(injectFinchWireControls);
}

document.addEventListener('click', () => {
    document.querySelectorAll('.fw-menu').forEach(m => m.classList.add('hidden'));
});
