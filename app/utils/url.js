const URL = require('url').URL;

/**
 * Modern URL builder for Media Drop
 */
class UrlHelper {
    static getBase() {
        const base = process.env.MEDIA_DROP_HTTP_BASE_URL || 'https://media.p3lending.space';
        // Clean trailing slash
        return base.replace(/\/$/, '');
    }

    static normalizeRelativePath(filename) {
        if (!filename) return '';
        return String(filename)
            .replace(/\\/g, '/')
            .replace(/^\.?\//, '')
            .replace(/\/{2,}/g, '/')
            .trim();
    }

    static encodeRelativePath(relativePath) {
        const normalized = this.normalizeRelativePath(relativePath);
        if (!normalized) return '';
        return normalized
            .split('/')
            .filter(Boolean)
            .map((segment) => encodeURIComponent(segment))
            .join('/');
    }

    static buildMediaUrl(filename) {
        if (!filename) return '';
        const base = this.getBase();
        const encodedPath = this.encodeRelativePath(filename);
        // Use URL object to ensure proper formatting and avoid https// issues
        const url = new URL(`${base}/media/${encodedPath}`);
        return url.toString();
    }

    static buildMediaUrlWithToken(filename, token) {
        const mediaUrl = this.buildMediaUrl(filename);
        if (!mediaUrl || !token) return mediaUrl;
        const separator = mediaUrl.includes('?') ? '&' : '?';
        return `${mediaUrl}${separator}token=${encodeURIComponent(token)}`;
    }

    static buildVlcUrl(filename) {
        if (!filename) return '';
        const mediaUrl = this.buildMediaUrl(filename);
        // Always ensure vlc://https:// structure
        return `vlc://${mediaUrl}`;
    }

    static buildAudioUrl(filename) {
        if (!filename) return '';
        // Same as media but helps in naming later if we want separation
        return this.buildMediaUrl(filename);
    }
}

module.exports = UrlHelper;
