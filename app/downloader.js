const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { dns } = require('dns').promises;
const URL = require('url').URL;

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i
];

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9\._-]/g, '_').substring(0, 255);
}

class Downloader {
  constructor(db) {
    this.db = db;
    this.activeDownloads = new Map();
  }

  async validateURL(urlStr) {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https protocols are allowed.');
    }

    const allowPrivate = process.env.MEDIA_DROP_ALLOW_PRIVATE_HOSTS === 'true';
    if (!allowPrivate) {
      const addresses = await require('dns').promises.resolve4(parsed.hostname).catch(() => []);
      const addresses6 = await require('dns').promises.resolve6(parsed.hostname).catch(() => []);
      const allIPs = [...addresses, ...addresses6];

      for (const ip of allIPs) {
        if (PRIVATE_IP_RANGES.some(range => range.test(ip))) {
          throw new Error(`Access to private IP ${ip} is blocked.`);
        }
      }
    }

    // Check allowlist
    const allowedDomains = (process.env.MEDIA_DROP_ALLOWED_DOMAINS || '').split(',').filter(Boolean);
    if (allowedDomains.length > 0 && !allowedDomains.includes(parsed.hostname)) {
      throw new Error(`Domain ${parsed.hostname} is not in the allowlist.`);
    }

    return parsed;
  }

  async checkYtDlp() {
    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  async startDownload(jobId) {
    const job = this.db.getJob(jobId);
    if (!job) return;

    this.db.updateJob(jobId, { status: 'downloading', updated_at: new Date().toISOString() });

    try {
      const parsed = new URL(job.url);
      const isYouTube = parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
      const hasYtDlp = await this.checkYtDlp();

      if (isYouTube && hasYtDlp) {
        await this.downloadYtDlp(job);
      } else if (await this.checkAria2()) {
        await this.downloadAria2(job);
      } else {
        await this.downloadNative(job);
      }
      
      this.db.updateJob(jobId, { 
        status: 'completed', 
        progress_percent: 100, 
        completed_at: new Date().toISOString() 
      });
    } catch (error) {
      console.error(`Download failed for job ${jobId}:`, error);
      this.db.updateJob(jobId, { 
        status: 'failed', 
        error_message: error.message, 
        updated_at: new Date().toISOString() 
      });
    }
  }

  async downloadYtDlp(job) {
    const finalDir = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'library');
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

    // Use yt-dlp to download. --get-filename helps if title is dynamic.
    // For MVP, we use the safe_filename or let yt-dlp decide and we rename it.
    const args = [
      '--output', path.join(finalDir, job.safe_filename),
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template', '{"percent":"%(progress._percent_str)s"}',
      job.url
    ];

    const child = spawn('yt-dlp', args);
    this.activeDownloads.set(job.id, child);

    return new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        const output = data.toString();
        // Parse json progress from template: {"percent":" 25.4%"}
        const match = output.match(/\{"percent":"\s*(.*)%"\}/);
        if (match) {
          const progress = parseFloat(match[1]);
          this.db.updateJob(job.id, { progress_percent: progress });
        }
      });

      child.on('close', (code) => {
        this.activeDownloads.delete(job.id);
        if (code === 0) {
          // Verify if filename was exact or changed
          const finalPath = path.join(finalDir, job.safe_filename);
          // Sometimes yt-dlp appends .ext even if we give a path without it
          // But our safe_filename should already have it.
          const stats = fs.statSync(finalPath);
          this.db.updateJob(job.id, {
              file_size: stats.size,
              absolute_path: finalPath,
              relative_path: job.safe_filename
          });
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });
    });
  }

  async getMetadata(url) {
    const parsed = new URL(url);
    const isYouTube = parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
    
    // For video platforms, use yt-dlp to get the title
    if (isYouTube && await this.checkYtDlp()) {
      return new Promise((resolve) => {
        const proc = spawn('yt-dlp', ['--get-title', '--skip-download', url]);
        let title = '';
        proc.stdout.on('data', (data) => title += data.toString());
        proc.on('close', () => resolve(title.trim() || path.basename(parsed.pathname)));
      });
    }

    // For direct files, try a HEAD request for Content-Disposition or basename
    return new Promise((resolve) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.request(url, { method: 'HEAD' }, (res) => {
        const disposition = res.headers['content-disposition'];
        if (disposition && disposition.includes('filename=')) {
          const match = disposition.match(/filename="?([^";]+)"?/);
          if (match) return resolve(match[1]);
        }
        resolve(path.basename(parsed.pathname) || 'download');
      });
      req.on('error', () => resolve(path.basename(parsed.pathname) || 'download'));
      req.end();
    });
  }

  async checkAria2() {
    return new Promise((resolve) => {
      const proc = spawn('aria2c', ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  async downloadAria2(job) {
    const tempDir = process.env.MEDIA_DROP_STORAGE_ROOT + '/tmp';
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const args = [
      '--dir=' + tempDir,
      '--out=' + job.safe_filename,
      '--max-connection-per-server=4',
      '--summary-interval=1',
      job.url
    ];

    const child = spawn('aria2c', args);
    this.activeDownloads.set(job.id, child);

    return new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        const output = data.toString();
        // Parse aria2c output for progress: [#id 1.2MiB/4.5MiB(26%) CN:1 DL:1.2MiB ETA:2s]
        const match = output.match(/\((.*)%\).*DL:(.*)\sETA:(.*)\]/);
        if (match) {
          const progress = parseFloat(match[1]);
          const speed = match[2];
          const eta = match[3];
          this.db.updateJob(job.id, { 
            progress_percent: progress,
            error_message: `Speed: ${speed}, ETA: ${eta}` // Temporary status info
          });
        }
      });

      child.on('close', (code) => {
        this.activeDownloads.delete(job.id);
        if (code === 0) {
          this.finalizeFile(job);
          resolve();
        } else {
          reject(new Error(`aria2c exited with code ${code}`));
        }
      });
    });
  }

  async downloadNative(job) {
    const tempPath = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'tmp', job.safe_filename);
    const file = fs.createWriteStream(tempPath);
    const protocol = job.url.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
      protocol.get(job.url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;

        response.pipe(file);

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const progress = (downloadedBytes / totalBytes) * 100;
            this.db.updateJob(job.id, { 
              progress_percent: progress.toFixed(1),
              downloaded_bytes: downloadedBytes,
              total_bytes: totalBytes
            });
          }
        });

        file.on('finish', () => {
          file.close();
          this.finalizeFile(job);
          resolve();
        });

        file.on('error', (err) => {
          fs.unlink(tempPath, () => reject(err));
        });
      }).on('error', (err) => {
        fs.unlink(tempPath, () => reject(err));
      });
    });
  }

  finalizeFile(job) {
    const tempPath = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'tmp', job.safe_filename);
    const finalDir = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'library');
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });
    
    const finalPath = path.join(finalDir, job.safe_filename);
    fs.renameSync(tempPath, finalPath);
    
    const stats = fs.statSync(finalPath);
    this.db.updateJob(job.id, {
        file_size: stats.size,
        absolute_path: finalPath,
        relative_path: job.safe_filename
    });
  }

  cancelDownload(jobId) {
    const child = this.activeDownloads.get(jobId);
    if (child) {
      child.kill();
      this.activeDownloads.delete(jobId);
      this.db.updateJob(jobId, { status: 'cancelled' });
    }
  }
}

module.exports = { Downloader, sanitizeFilename };
