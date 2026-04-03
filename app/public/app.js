const App = {
    init() {
        this.currentTab = 'dashboard-page';
        this.pendingSuggestedUrl = '';
        this.cacheDOM();
        this.bindEvents();
        this.checkSession();
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
        this.refreshJobsBtn = document.getElementById('refresh-jobs-btn');
        this.activeJobsList = document.getElementById('active-jobs-list');
        this.historyJobsList = document.getElementById('history-jobs-list');
        this.filesList = document.getElementById('files-list');
        this.navLinks = document.querySelectorAll('.nav-link');
        this.pages = document.querySelectorAll('.page');
        this.toastContainer = document.getElementById('toast-container');

        // Media modal
        this.mediaModal = document.getElementById('media-modal');
        this.closeModalBtn = document.getElementById('close-modal-btn');
        this.playerContainer = document.getElementById('player-container');
        this.playerTitle = document.getElementById('player-title');

        // Dashboard AI
        this.aiPromptInput = document.getElementById('ai-prompt');
        this.aiAskBtn = document.getElementById('ai-ask-btn');
        this.aiResponse = document.getElementById('ai-response');
        this.aiActions = document.getElementById('ai-actions');
        this.aiQueueBtn = document.getElementById('ai-queue-btn');

        // Discover
        this.refreshNewsBtn = document.getElementById('refresh-news-btn');
        this.discoverTopics = document.getElementById('discover-topics');
        this.discoverList = document.getElementById('discover-list');

        // Settings
        this.settingCurrentPassword = document.getElementById('setting-current-password');
        this.settingNewPassword = document.getElementById('setting-new-password');
        this.changePasswordBtn = document.getElementById('change-password-btn');
        this.settingAiProvider = document.getElementById('setting-ai-provider');
        this.settingTtsProvider = document.getElementById('setting-tts-provider');
        this.settingAiApiKey = document.getElementById('setting-ai-api-key');
        this.settingTtsApiKey = document.getElementById('setting-tts-api-key');
        this.saveProviderSettingsBtn = document.getElementById('save-provider-settings-btn');
    },

    bindEvents() {
        this.loginBtn.onclick = () => this.login();
        this.logoutBtn.onclick = () => this.logout();
        this.submitUrlBtn.onclick = () => this.submitUrl();
        this.refreshJobsBtn.onclick = () => this.loadDashboard();
        this.closeModalBtn.onclick = () => this.closePlayer();
        this.aiAskBtn.onclick = () => this.askAi();
        this.aiQueueBtn.onclick = () => this.queueSuggestedFromAi();
        this.refreshNewsBtn.onclick = () => this.loadDiscover();
        this.changePasswordBtn.onclick = () => this.changePassword();
        this.saveProviderSettingsBtn.onclick = () => this.saveProviderSettings();

        this.navLinks.forEach((link) => {
            link.onclick = (event) => this.switchTab(event);
        });

        this.passwordInput.onkeyup = (event) => {
            if (event.key === 'Enter') this.login();
        };

        this.mediaUrlInput.onkeyup = (event) => {
            if (event.key === 'Enter') this.submitUrl();
        };
        this.aiPromptInput.onkeyup = (event) => {
            if (event.key === 'Enter') this.askAi();
        };

        this.mediaModal.onclick = (event) => {
            if (event.target === this.mediaModal) this.closePlayer();
        };
    },

    async request(url, options = {}) {
        const response = await fetch(url, options);
        const text = await response.text();
        let payload = {};

        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = { error: text || 'Unexpected response from server' };
        }

        if (!response.ok) {
            const message = payload.error || `Request failed (${response.status})`;
            throw new Error(message);
        }

        return payload;
    },

    async checkSession() {
        try {
            const data = await this.request('/api/session');
            if (data.authenticated) {
                this.showApp();
            } else {
                this.showLogin();
            }
        } catch {
            this.showLogin();
        }
    },

    async login() {
        const password = this.passwordInput.value.trim();
        if (!password) {
            this.showToast('Password is required', 'error');
            return;
        }

        try {
            const data = await this.request('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });

            if (data.success) {
                this.passwordInput.value = '';
                this.showApp();
            } else {
                this.showToast('Invalid password', 'error');
            }
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async logout() {
        try {
            await this.request('/api/logout', { method: 'POST' });
        } catch {
            // No-op; we still force local logout state.
        }
        this.showLogin();
    },

    showLogin() {
        this.loginContainer.classList.remove('hidden');
        this.appContainer.classList.add('hidden');
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    },

    showApp() {
        this.loginContainer.classList.add('hidden');
        this.appContainer.classList.remove('hidden');
        this.loadDashboard();
        this.loadSettings();
        this.startSSE();
        if (window.lucide) lucide.createIcons();
    },

    switchTab(event) {
        event.preventDefault();
        const target = event.currentTarget.dataset.target;
        if (!target) return;

        this.navLinks.forEach((link) => link.classList.remove('active'));
        event.currentTarget.classList.add('active');

        this.pages.forEach((page) => page.classList.add('hidden'));
        document.getElementById(target).classList.remove('hidden');
        this.currentTab = target;

        if (target === 'dashboard-page') this.loadDashboard();
        if (target === 'files-page') this.loadFiles();
        if (target === 'discover-page') this.loadDiscover();
        if (target === 'settings-page') this.loadSettings();
    },

    async submitUrl() {
        const url = this.mediaUrlInput.value.trim();
        const filename = this.customFilenameInput.value.trim();
        const isAudio = this.isAudioInput.checked;

        if (!url) {
            this.showToast('Media URL is required', 'error');
            return;
        }

        try {
            await this.request('/api/downloads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    filename: filename || undefined,
                    is_audio: isAudio,
                }),
            });

            this.showToast('Download started');
            this.mediaUrlInput.value = '';
            this.customFilenameInput.value = '';
            this.loadDashboard();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async askAi() {
        const prompt = this.aiPromptInput.value.trim();
        if (!prompt) {
            this.showToast('Enter a prompt first', 'error');
            return;
        }

        this.aiAskBtn.disabled = true;
        this.aiAskBtn.textContent = 'Thinking...';
        this.aiResponse.classList.add('hidden');
        this.aiActions.classList.add('hidden');

        try {
            const payload = await this.request('/api/ai/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
            });

            const answerText = String(payload.answer || payload.message || '').trim() || 'No response available.';
            const suggestedUrl = String(payload.suggested_url || '').trim();
            const lines = [
                answerText,
                '',
                payload.provider ? `Provider: ${payload.provider}` : null,
                payload.query ? `Search query: ${payload.query}` : null,
                suggestedUrl ? `Suggested media URL: ${suggestedUrl}` : null,
            ].filter(Boolean);

            this.aiResponse.textContent = lines.join('\n');
            this.aiResponse.classList.remove('hidden');
            this.pendingSuggestedUrl = suggestedUrl || '';

            if (this.pendingSuggestedUrl) {
                this.aiActions.classList.remove('hidden');
            }
        } catch (error) {
            this.showToast(error.message, 'error');
        } finally {
            this.aiAskBtn.disabled = false;
            this.aiAskBtn.textContent = 'Ask AI';
        }
    },

    async queueSuggestedFromAi() {
        const suggestedUrl = String(this.pendingSuggestedUrl || '').trim();
        if (!suggestedUrl) {
            this.showToast('No suggested URL available yet', 'error');
            return;
        }

        this.mediaUrlInput.value = suggestedUrl;
        this.switchToTab('dashboard-page');
        await this.submitUrl();
    },

    switchToTab(targetId) {
        const targetLink = Array.from(this.navLinks).find((link) => link.dataset.target === targetId);
        if (!targetLink) return;
        targetLink.click();
    },

    async loadDashboard() {
        try {
            const jobs = await this.request('/api/downloads');
            this.renderJobs(jobs);
        } catch (error) {
            if (String(error.message).toLowerCase().includes('unauthorized')) {
                this.showLogin();
                return;
            }
            this.showToast(error.message, 'error');
        }
    },

    renderJobs(jobs) {
        const active = jobs.filter((job) => job.status === 'downloading' || job.status === 'queued');
        const history = jobs.filter((job) => job.status !== 'downloading' && job.status !== 'queued');

        this.activeJobsList.innerHTML = active.map((job) => this.renderJobItem(job)).join('') || '<div class="empty-state">No active downloads</div>';
        this.historyJobsList.innerHTML = history.map((job) => this.renderJobItem(job)).join('') || '<div class="empty-state">History is empty</div>';

        if (window.lucide) lucide.createIcons();
    },

    renderJobItem(job) {
        const displayTitle = this.escapeHtml(job.filename || job.url || 'Untitled');
        const displayMeta = this.escapeHtml(`${job.source_domain || 'unknown'} | ${new Date(job.created_at).toLocaleString()}`);
        const mediaUrl = this.toSameOriginMediaUrl(job.media_url);
        const encodedMediaUrl = encodeURIComponent(mediaUrl);
        const encodedTitle = encodeURIComponent(job.filename || job.url || 'Untitled');
        const isAudio = job.is_audio ? 'true' : 'false';
        const statusClass = this.escapeHtml(String(job.status || '').toLowerCase());

        return `
            <div class="job-item" data-id="${job.id}">
                <div class="job-info">
                    <div class="job-title">${displayTitle}</div>
                    <div class="job-meta">${displayMeta}</div>
                    ${job.status === 'downloading' ? `
                        <div class="progress-bar-container">
                            <div class="progress-bar-fill" style="width: ${Math.round(job.progress_percent || 0)}%"></div>
                        </div>
                        <div class="job-percent">${Math.round(job.progress_percent || 0)}%</div>
                    ` : ''}
                </div>
                <div class="job-actions">
                    <span class="status-badge status-${statusClass}">${this.escapeHtml(String(job.status || 'unknown'))}</span>
                    ${job.status === 'completed' ? `
                        <button class="primary-btn sm-btn" onclick="App.openPlayer(decodeURIComponent('${encodedMediaUrl}'), ${isAudio}, decodeURIComponent('${encodedTitle}'))" title="Play in browser">
                            <i data-lucide="play"></i> Play
                        </button>
                    ` : ''}
                    ${job.status === 'failed' ? `
                        <button class="icon-btn" onclick="App.retryJob('${job.id}')" title="Retry download">
                            <i data-lucide="refresh-cw"></i>
                        </button>
                    ` : ''}
                    <button class="sm-btn danger-btn" onclick="App.deleteJob('${job.id}')" title="Delete">
                        <i data-lucide="trash-2"></i> Delete
                    </button>
                </div>
            </div>
        `;
    },

    async retryJob(id) {
        try {
            await this.request(`/api/downloads/${id}/retry`, { method: 'POST' });
            this.showToast('Retrying download...');
            this.loadDashboard();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    openPlayer(mediaUrl, isAudio, title) {
        const sourceType = this.detectMimeType(mediaUrl, isAudio);
        const safeTitle = title || 'Now Playing';

        this.playerTitle.innerText = safeTitle;
        this.playerContainer.innerHTML = isAudio
            ? `
                <audio controls autoplay preload="metadata">
                    <source src="${mediaUrl}" type="${sourceType}">
                    Your browser does not support audio playback.
                </audio>
            `
            : `
                <video controls playsinline autoplay preload="metadata">
                    <source src="${mediaUrl}" type="${sourceType}">
                    Your browser does not support video playback.
                </video>
            `;

        this.mediaModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    },

    closePlayer() {
        this.playerContainer.innerHTML = '';
        this.mediaModal.classList.add('hidden');
        document.body.style.overflow = 'auto';
    },

    async loadFiles() {
        try {
            const files = await this.request('/api/files');
            this.filesList.innerHTML = files.map((file) => this.renderFileItem(file)).join('') || '<div class="empty-state">No media files found</div>';
            if (window.lucide) lucide.createIcons();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async loadDiscover() {
        try {
            this.discoverList.innerHTML = '<div class="empty-state">Loading discover feed...</div>';
            const payload = await this.request('/api/discover/news');
            const interests = Array.isArray(payload?.interests) ? payload.interests : [];
            const articles = Array.isArray(payload?.articles) ? payload.articles : [];

            this.discoverTopics.innerHTML = interests.length
                ? interests.map((topic) => `<span class="topic-chip">${this.escapeHtml(topic)}</span>`).join('')
                : '<span class="topic-chip">general</span>';

            this.discoverList.innerHTML = articles.length
                ? articles.map((item) => this.renderDiscoverCard(item)).join('')
                : '<div class="empty-state">No stories yet. Ask FinchWire AI and watch more media to personalize this feed.</div>';
            if (window.lucide) lucide.createIcons();
        } catch (error) {
            this.discoverList.innerHTML = `<div class="empty-state">Failed to load discover feed: ${this.escapeHtml(error.message)}</div>`;
        }
    },

    renderDiscoverCard(item) {
        const title = this.escapeHtml(item.title || 'Untitled');
        const summary = this.escapeHtml(item.summary || '');
        const source = this.escapeHtml(item.source || 'News');
        const date = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : '';
        const link = this.escapeHtml(item.link || '#');
        const image = String(item.imageUrl || '').trim();
        const video = String(item.videoUrl || '').trim();
        const imageTag = image
            ? `<img src="${this.escapeAttr(image)}" alt="${title}" class="discover-image" loading="lazy" referrerpolicy="no-referrer">`
            : '<div class="discover-image"></div>';

        return `
            <article class="discover-card">
                ${imageTag}
                <div class="discover-body">
                    <div class="discover-meta">${source}${date ? ` • ${this.escapeHtml(date)}` : ''}</div>
                    <div class="discover-title">${title}</div>
                    <div class="discover-summary">${summary}</div>
                    <div class="discover-actions">
                        <a class="link-btn" href="${link}" target="_blank" rel="noopener noreferrer">Read Article</a>
                        ${video ? `<a class="link-btn" href="${this.escapeAttr(video)}" target="_blank" rel="noopener noreferrer">Play Video</a>` : ''}
                    </div>
                </div>
            </article>
        `;
    },

    renderFileItem(file) {
        const mediaUrl = this.toSameOriginMediaUrl(file.url);
        const isAudio = this.isAudioFilename(file.name);
        const encodedUrl = encodeURIComponent(mediaUrl);
        const encodedTitle = encodeURIComponent(file.name || 'Media');
        const encodedPath = encodeURIComponent(file.relative_path || file.name);

        return `
            <div class="file-item">
                <div class="job-info">
                    <div class="job-title">${this.escapeHtml(file.name)}</div>
                    <div class="job-meta">${(file.size / 1024 / 1024).toFixed(2)} MB | ${new Date(file.mtime).toLocaleString()}</div>
                </div>
                <div class="file-actions">
                    <button class="primary-btn sm-btn" onclick="App.openPlayer(decodeURIComponent('${encodedUrl}'), ${isAudio ? 'true' : 'false'}, decodeURIComponent('${encodedTitle}'))" title="Play in browser">
                        <i data-lucide="play"></i> Play
                    </button>
                    <button class="sm-btn danger-btn" onclick="App.deleteFile(decodeURIComponent('${encodedPath}'))" title="Delete file">
                        <i data-lucide="trash-2"></i> Delete
                    </button>
                </div>
            </div>
        `;
    },

    async deleteJob(id) {
        const shouldDelete = window.confirm('Delete this item from history and remove its media file?');
        if (!shouldDelete) return;

        try {
            await this.request(`/api/downloads/${id}`, { method: 'DELETE' });
            this.showToast('Deleted');
            this.loadDashboard();
            if (this.currentTab === 'files-page') this.loadFiles();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async deleteFile(relativePath) {
        const shouldDelete = window.confirm('Delete this media file from server storage?');
        if (!shouldDelete) return;

        try {
            await this.request('/api/files', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ relative_path: relativePath }),
            });

            this.showToast('File deleted');
            this.loadFiles();
            if (this.currentTab === 'dashboard-page') this.loadDashboard();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async loadSettings() {
        try {
            const payload = await this.request('/api/settings');
            const settings = payload?.settings || {};
            this.settingAiProvider.value = settings.ai_provider || 'none';
            this.settingTtsProvider.value = settings.tts_provider || 'none';
            this.settingAiApiKey.value = '';
            this.settingTtsApiKey.value = '';
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async saveProviderSettings() {
        try {
            const payload = {
                ai_provider: this.settingAiProvider.value,
                tts_provider: this.settingTtsProvider.value,
            };

            const aiApiKey = this.settingAiApiKey.value.trim();
            const ttsApiKey = this.settingTtsApiKey.value.trim();
            if (aiApiKey) payload.ai_api_key = aiApiKey;
            if (ttsApiKey) payload.tts_api_key = ttsApiKey;

            await this.request('/api/settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            this.settingAiApiKey.value = '';
            this.settingTtsApiKey.value = '';
            this.showToast('Provider settings saved');
            this.loadSettings();
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    async changePassword() {
        const currentPassword = this.settingCurrentPassword.value.trim();
        const newPassword = this.settingNewPassword.value.trim();

        if (!currentPassword || !newPassword) {
            this.showToast('Enter current and new password', 'error');
            return;
        }

        if (newPassword.length < 8) {
            this.showToast('New password must be at least 8 characters', 'error');
            return;
        }

        try {
            await this.request('/api/account/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_password: currentPassword,
                    new_password: newPassword,
                }),
            });

            this.settingCurrentPassword.value = '';
            this.settingNewPassword.value = '';
            this.showToast('Password updated');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },

    startSSE() {
        if (this.eventSource) this.eventSource.close();
        this.eventSource = new EventSource('/api/events');

        this.eventSource.onmessage = (event) => {
            const payload = JSON.parse(event.data);

            if (payload.type === 'refresh') {
                if (this.currentTab === 'dashboard-page') this.loadDashboard();
                if (this.currentTab === 'files-page') this.loadFiles();
                return;
            }

            if (payload.type === 'progress' && Array.isArray(payload.jobs)) {
                payload.jobs.forEach((job) => {
                    const item = document.querySelector(`.job-item[data-id="${job.id}"]`);
                    if (!item) return;
                    const bar = item.querySelector('.progress-bar-fill');
                    const text = item.querySelector('.job-percent');
                    if (bar) bar.style.width = `${job.progress_percent}%`;
                    if (text) text.innerText = `${Math.round(job.progress_percent)}%`;
                });
            }
        };

        this.eventSource.onerror = () => {
            setTimeout(() => this.startSSE(), 3000);
        };
    },

    toSameOriginMediaUrl(rawUrl) {
        if (!rawUrl) return '';
        try {
            const parsed = new URL(rawUrl, window.location.origin);
            return `${window.location.origin}${parsed.pathname}${parsed.search}`;
        } catch {
            return rawUrl;
        }
    },

    detectMimeType(mediaUrl, isAudio) {
        const extension = (mediaUrl.split('?')[0].split('.').pop() || '').toLowerCase();
        const mimeMap = {
            mp4: 'video/mp4',
            webm: 'video/webm',
            mkv: 'video/x-matroska',
            mov: 'video/quicktime',
            mp3: 'audio/mpeg',
            m4a: 'audio/mp4',
            aac: 'audio/aac',
            ogg: 'audio/ogg',
            opus: 'audio/ogg; codecs=opus',
        };

        if (mimeMap[extension]) return mimeMap[extension];
        return isAudio ? 'audio/mpeg' : 'video/mp4';
    },

    isAudioFilename(filename) {
        const lowered = String(filename || '').toLowerCase();
        return lowered.endsWith('.mp3') || lowered.endsWith('.m4a') || lowered.endsWith('.aac') || lowered.endsWith('.ogg') || lowered.endsWith('.opus');
    },

    escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    escapeAttr(value) {
        return this.escapeHtml(value).replace(/`/g, '&#96;');
    },

    showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerText = message;
        this.toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 2800);
    },
};

window.onload = () => App.init();
