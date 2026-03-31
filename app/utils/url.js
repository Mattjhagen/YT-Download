const URL = require('url').URL;

/**
 * Modern URL builder for Media Drop
 */
class UrlHelper {
    static getBase() {
        const base = process.env.MEDIA_DROP_HTTP_BASE_URL || 'https://yt.finchwire.site';
        // Clean trailing slash
        return base.replace(/\/$/, '');
    }

    static buildMediaUrl(filename) {
        if (!filename) return '';
        const base = this.getBase();
        // Use URL object to ensure proper formatting and avoid https// issues
        const url = new URL(`${base}/media/${encodeURIComponent(filename)}`);
        return url.toString();
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
