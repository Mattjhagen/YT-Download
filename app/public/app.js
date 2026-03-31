const App = {
    init() {
        this.cacheDOM();
        this.bindEvents();
        this.checkSession();
        this.currentTab = 'dashboard-page';
    },

    cacheDOM() {
        this.loginContainer = document.getElementById('login-container');
        this.appContainer = document.getElementById('app-container');
        this.passwordInput = document.getElementById('admin-password');
        this.loginBtn = document.getElementById('login-btn');
        this.logoutBtn = document.getElementById('logout-btn');
        this.mediaUrlInput = document.getElementById('media-url');
        this.customFilenameInput = document.getElementById('custom-filename');
        this.isAudioInput = document.getElementById('is-audio');
        this.submitUrlBtn = document.getElementById('submit-url-btn');
        this.activeJobsList = document.getElementById('active-jobs-list');
        this.historyJobsList = document.getElementById('history-jobs-list');
        this.filesList = document.getElementById('files-list');
        this.navLinks = document.querySelectorAll('.nav-link');
        this.pages = document.querySelectorAll('.page');
        this.toastContainer = document.getElementById('toast-container');
        
        // Media Modal
        this.mediaModal = document.getElementById('media-modal');
        this.closeModalBtn = document.getElementById('close-modal-btn');
        this.playerContainer = document.getElementById('player-container');
        this.playerTitle = document.getElementById('player-title');
        this.playerDownloadLink = document.getElementById('player-download-link');
        this.playerVlcLink = document.getElementById('player-vlc-link');
    },

    bindEvents() {
        this.loginBtn.onclick = () => this.login();
        this.logoutBtn.onclick = () => this.logout();
        this.submitUrlBtn.onclick = () => this.submitUrl();
        this.navLinks.forEach(link => {
            link.onclick = (e) => this.switchTab(e);
        });
        this.passwordInput.onkeyup = (e) => e.key === 'Enter' && this.login();
        this.mediaUrlInput.onkeyup = (e) => e.key === 'Enter' && this.submitUrl();
        this.closeModalBtn.onclick = () => this.closePlayer();
        this.mediaModal.onclick = (e) => {
            if (e.target === this.mediaModal) this.closePlayer();
        };
    },

    async checkSession() {
        const res = await fetch('/api/session');
        const data = await res.json();
        if (data.authenticated) {
            this.showApp();
        } else {
            this.showLogin();
        }
    },

    async login() {
        const password = this.passwordInput.value;
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.success) {
            this.showApp();
        } else {
            this.showToast('Invalid password', 'error');
        }
    },

    async logout() {
        await fetch('/api/logout', { method: 'POST' });
        this.showLogin();
    },

    showLogin() {
        this.loginContainer.classList.remove('hidden');
        this.appContainer.classList.add('hidden');
    },

    showApp() {
        this.loginContainer.classList.add('hidden');
        this.appContainer.classList.remove('hidden');
        this.loadDashboard();
        this.startSSE();
    },

    switchTab(e) {
        e.preventDefault();
        const target = e.target.dataset.target;
        this.navLinks.forEach(link => link.classList.remove('active'));
        e.target.classList.add('active');
        this.pages.forEach(page => page.classList.add('hidden'));
        document.getElementById(target).classList.remove('hidden');
        this.currentTab = target;
        
        if (target === 'dashboard-page') this.loadDashboard();
        if (target === 'files-page') this.loadFiles();
    },

    async submitUrl() {
        const url = this.mediaUrlInput.value;
        const filename = this.customFilenameInput.value;
        const is_audio = this.isAudioInput.checked;
        if (!url) return this.showToast('URL is required', 'error');

        const res = await fetch('/api/downloads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, filename, is_audio })
        });
        const data = await res.json();
        if (res.ok) {
            this.showToast('Download started');
            this.mediaUrlInput.value = '';
            this.customFilenameInput.value = '';
            this.loadDashboard();
        } else {
            this.showToast(data.error, 'error');
        }
    },

    async loadDashboard() {
        const res = await fetch('/api/downloads');
        const jobs = await res.json();
        this.renderJobs(jobs);
    },

    renderJobs(jobs) {
        const active = jobs.filter(j => j.status === 'downloading' || j.status === 'queued');
        const history = jobs.filter(j => j.status !== 'downloading' && j.status !== 'queued');

        this.activeJobsList.innerHTML = active.map(j => this.renderJobItem(j)).join('') || '<div class="empty-state">No active downloads</div>';
        this.historyJobsList.innerHTML = history.map(j => this.renderJobItem(j)).join('') || '<div class="empty-state">History is empty</div>';
    },

    renderJobItem(job) {
        return `
            <div class="job-item" data-id="${job.id}" 
                 data-media-title="${job.filename || job.url}"
                 data-media-url="${job.media_url}"
                 data-audio-url="${job.is_audio ? job.media_url : ''}"
                 data-vlc-url="${job.vlc_url}">
                <div class="job-info">
                    <div class="job-title">${job.filename || job.url}</div>
                    <div class="job-meta">${job.source_domain} | ${new Date(job.created_at).toLocaleString()}</div>
                </div>
                ${job.status === 'downloading' ? `
                    <div class="progress-bar-container">
                        <div class="progress-bar-fill" style="width: ${job.progress_percent || 0}%"></div>
                    </div>
                    <div class="job-percent">${Math.round(job.progress_percent || 0)}%</div>
                ` : ''}
                <div class="status-badge status-${job.status}">${job.status}${job.is_audio ? ' (Audio)' : ''}</div>
                <div class="job-actions">
                    ${job.status === 'completed' ? `
                        <button onclick="App.playInVlc('${job.vlc_url}')" class="primary-btn sm-btn vlc-btn" title="Open in VLC">📺 VLC</button>
                        <button onclick="App.openPlayer('${job.media_url}', ${job.is_audio}, '${job.filename || job.url}', '${job.vlc_url}')" class="primary-btn sm-btn" title="Play in Browser">▶️ Play</button>
                        <a href="${job.media_url}?download=true" download class="primary-btn sm-btn secondary-btn" style="text-decoration:none; display:inline-flex; align-items:center;">⬇️ Download</a>
                    ` : ''}
                    ${job.status === 'failed' ? `<button onclick="App.retryJob('${job.id}')" class="primary-btn sm-btn">Retry</button>` : ''}
                    <button onclick="App.deleteJob('${job.id}')" class="text-btn">Delete</button>
                </div>
            </div>
        `;
    },

    async retryJob(id) {
        const res = await fetch(`/api/downloads/${id}/retry`, { method: 'POST' });
        if (res.ok) {
            this.showToast('Retrying download...');
            this.loadDashboard();
        } else {
            this.showToast('Failed to retry', 'error');
        }
    },

    playInVlc(vlcUrl) {
        if (!vlcUrl) return;
        window.location.assign(vlcUrl);
        this.showToast('Opening in VLC...');
    },

    openPlayer(mediaUrl, isAudio, title, vlcUrl) {
        this.playerTitle.innerText = title;
        this.playerDownloadLink.href = `${mediaUrl}?download=true`;
        this.playerVlcLink.href = vlcUrl;
        this.playerVlcLink.onclick = (e) => {
            e.preventDefault();
            this.playInVlc(vlcUrl);
        };

        // Extension Hooks
        this.mediaModal.setAttribute('data-media-title', title);
        this.mediaModal.setAttribute('data-media-url', mediaUrl);
        this.mediaModal.setAttribute('data-audio-url', isAudio ? mediaUrl : '');
        this.mediaModal.setAttribute('data-vlc-url', vlcUrl);

        const mediaElement = isAudio ? 'audio' : 'video';
        this.playerContainer.innerHTML = `
            <${mediaElement} controls playsinline preload="metadata" autoplay>
                <source src="${mediaUrl}" type="${isAudio ? 'audio/mpeg' : 'video/mp4'}">
                Your browser does not support the ${mediaElement} element.
            </${mediaElement}>
        `;

        this.mediaModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden'; // Prevent scrolling background
    },

    closePlayer() {
        this.playerContainer.innerHTML = '';
        this.mediaModal.classList.add('hidden');
        document.body.style.overflow = 'auto';
    },

    async loadFiles() {
        const res = await fetch('/api/files');
        const files = await res.json();
        this.filesList.innerHTML = files.map(f => `
            <div class="file-item">
                <div class="job-info">
                    <div class="job-title">${f.name}</div>
                    <div class="job-meta">${(f.size / 1024 / 1024).toFixed(2)} MB | ${new Date(f.mtime).toLocaleString()}</div>
                </div>
                <div class="file-actions">
                    <button onclick="App.openPlayer('${f.url}', ${f.name.endsWith('.m4a') || f.name.endsWith('.mp3')}, '${f.name}', '${f.vlc_url}')" class="icon-btn" title="Stream in Browser">▶️</button>
                    <button onclick="App.playInVlc('${f.vlc_url}')" class="icon-btn vlc-icon" title="Play in VLC">📺</button>
                    <button onclick="App.copyToClipboard('${f.url}')" class="icon-btn" title="Copy Streaming URL">🔗</button>
                    <button onclick="App.deleteFile('${f.name}')" class="icon-btn" title="Delete">🗑️</button>
                </div>
            </div>
        `).join('') || '<div class="empty-state">No files found</div>';
    },

    async deleteJob(id) {
        if (!confirm('Are you sure you want to delete this job?')) return;
        await fetch(`/api/downloads/${id}`, { method: 'DELETE' });
        this.loadDashboard();
    },

    async deleteFile(name) {
      // For MVP, we can reuse DELETE /api/downloads/:id if we track file to job, 
      // but simpler to add a dedicated file delete if needed.
      // Re-using job delete logic for now or implement direct delete.
      this.showToast('Deleting files is currently bound to job history deletion.');
    },

    startSSE() {
        if (this.eventSource) this.eventSource.close();
        this.eventSource = new EventSource('/api/events');
        this.eventSource.onmessage = (e) => {
            const payload = JSON.parse(e.data);

            if (payload.type === 'refresh') {
                // A job changed status — do a full dashboard reload
                if (this.currentTab === 'dashboard-page') this.loadDashboard();
                return;
            }

            if (payload.type === 'progress' && Array.isArray(payload.jobs)) {
                payload.jobs.forEach(job => {
                    const item = document.querySelector(`.job-item[data-id="${job.id}"]`);
                    if (item) {
                        const bar = item.querySelector('.progress-bar-fill');
                        const text = item.querySelector('.job-percent');
                        if (bar) bar.style.width = `${job.progress_percent}%`;
                        if (text) text.innerText = `${Math.round(job.progress_percent)}%`;
                    }
                });
            }
        };
        this.eventSource.onerror = () => {
            // Reconnect after a short delay on error
            setTimeout(() => this.startSSE(), 3000);
        };
    },

    showToast(msg, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerText = msg;
        this.toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    },

    copyToClipboard(text) {
        navigator.clipboard.writeText(text);
        this.showToast('Copied to clipboard');
    }
};

window.onload = () => App.init();
