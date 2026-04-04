// FinchWire Chrome Extension Content Script
console.log('🐦 FinchWire v1.1.2 Ready (YouTube Support Enhanced)');

const INJECTION_CLASS = 'finchwire-injected';
const IS_YOUTUBE = window.location.hostname.includes('youtube.com');

// 1. FINCHWIRE APP INJECTION
function injectFinchWireControls(element) {
    if (!element || element.classList.contains(INJECTION_CLASS)) return;
    
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
    if (!IS_YOUTUBE) return;

    // Try multiple selectors for the action bar
    const selectors = [
        'ytd-watch-metadata #top-level-buttons-computed',
        'ytd-menu-renderer #top-level-buttons-computed',
        '#top-level-buttons-computed',
        '#actions-inner #menu ytd-menu-renderer'
    ];

    let actionBar = null;
    for (const selector of selectors) {
        actionBar = document.querySelector(selector);
        if (actionBar) break;
    }

    if (!actionBar || actionBar.querySelector('.fw-yt-btn')) return;

    console.log('🐦 [YouTube] Found action bar, injecting button...');

    const videoUrl = window.location.href;
    const videoTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.innerText ||
                       document.querySelector('ytd-watch-metadata h1')?.innerText ||
                       document.querySelector('h1.ytd-video-primary-info-renderer')?.innerText || 
                       document.querySelector('yt-formatted-string.ytd-video-primary-info-renderer')?.innerText ||
                       document.querySelector('meta[name="title"]')?.content || 
                       document.title ||
                       "YouTube Video";

    const btn = document.createElement('button');
    btn.className = 'fw-main-btn fw-yt-btn';
    btn.innerHTML = '🐦 Remote Download';
    
    btn.onclick = (e) => {
        e.preventDefault();
        btn.innerText = '⏳ Sending...';
        btn.style.opacity = '0.7';
        
        chrome.runtime.sendMessage({ 
            type: 'REMOTE_DOWNLOAD', 
            url: window.location.href, // Always use current URL
            filename: videoTitle 
        }, (response) => {
            if (response && response.success) {
                btn.innerText = '✅ Sent to Server';
                btn.style.backgroundColor = '#10b981';
            } else {
                btn.innerText = '❌ Setup Required';
                btn.style.backgroundColor = '#ef4444';
                // Prompt to check options if failed
                if (response && response.error === 'Configuration missing') {
                    if (confirm('FinchWire: Server URL or Password not set. Open settings?')) {
                        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
                    }
                }
            }
            setTimeout(() => {
                btn.innerText = '🐦 Remote Download';
                btn.style.backgroundColor = '';
                btn.style.opacity = '';
            }, 5000);
        });
    };

    // Inject into the list
    if (actionBar.id === 'top-level-buttons-computed') {
        actionBar.appendChild(btn);
    } else {
        // Fallback for different container structures
        const list = actionBar.querySelector('#top-level-buttons-computed') || actionBar;
        list.appendChild(btn);
    }
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
    window.addEventListener('yt-navigate-finish', () => {
        console.log('🐦 [YouTube] Navigation finished, re-injecting...');
        setTimeout(injectYouTubeControls, 1000);
    });
    // Initial load
    setTimeout(injectYouTubeControls, 2000);
} else {
    document.querySelectorAll('.job-item, .finchwire-media-root').forEach(injectFinchWireControls);
}

document.addEventListener('click', () => {
    document.querySelectorAll('.fw-menu').forEach(m => m.classList.add('hidden'));
});
