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
  /^0\.0\.0\.0$/,
  /^::$/,
  /^fc00:/i,
  /^fe80:/i
];

const MAX_CONCURRENT_JOBS = parseInt(process.env.MEDIA_DROP_MAX_CONCURRENT_JOBS || '3', 10);
const MAX_FILE_SIZE_BYTES = parseInt(process.env.MEDIA_DROP_MAX_FILE_SIZE_GB || '2', 10) * 1024 * 1024 * 1024;

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
        try {
            let allIPs = [];
            // If hostname is already an IP, add it. Otherwise resolve it.
            const isIP = /^[\d\.]+$|:/.test(parsed.hostname);
            if (isIP) {
                allIPs.push(parsed.hostname);
            } else {
                const addresses = await require('dns').promises.resolve4(parsed.hostname).catch(() => []);
                const addresses6 = await require('dns').promises.resolve6(parsed.hostname).catch(() => []);
                allIPs = [...addresses, ...addresses6];
                
                // fallback to lookup for localhost/etc-hosts
                if (allIPs.length === 0) {
                    const lookup = await require('dns').promises.lookup(parsed.hostname).catch(() => null);
                    if (lookup) allIPs.push(lookup.address);
                }
            }

            for (const ip of allIPs) {
                if (PRIVATE_IP_RANGES.some(range => range.test(ip))) {
                    throw new Error(`Access to private IP ${ip} is blocked.`);
                }
            }
        } catch (e) {
            if (e.message.includes('blocked')) throw e;
            console.warn(`DNS validation failed for ${parsed.hostname}: ${e.message}`);
        }
    }

    // Check allowlist
    const allowedDomains = (process.env.MEDIA_DROP_ALLOWED_DOMAINS || '').split(',').filter(Boolean);
    if (allowedDomains.length > 0 && !allowedDomains.includes(parsed.hostname)) {
      throw new Error(`Domain ${parsed.hostname} is not in the allowlist.`);
    }

    // Check file size via HEAD request if not a video platform
    const isVideoPlatform = parsed.hostname.includes('youtube.com') || 
                            parsed.hostname.includes('youtu.be') || 
                            parsed.hostname.includes('vimeo.com');

    if (!isVideoPlatform) {
      try {
        const size = await this.getFileSize(urlStr);
        if (size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`File size (${(size / 1024 / 1024 / 1024).toFixed(2)} GB) exceeds the limit of ${process.env.MEDIA_DROP_MAX_FILE_SIZE_GB || '2'} GB.`);
        }
      } catch (err) {
        console.warn(`Could not verify file size for ${urlStr}: ${err.message}`);
      }
    }

    return parsed;
  }

  async getFileSize(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        const size = parseInt(res.headers['content-length'], 10);
        resolve(isNaN(size) ? 0 : size);
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout checking file size'));
      });
      req.end();
    });
  }

  async checkYtDlp() {
    return new Promise((resolve) => {
      const proc = spawn('/usr/local/bin/yt-dlp', ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  async checkAria2() {
    return new Promise((resolve) => {
      const proc = spawn('/usr/bin/aria2c', ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  async getMetadata(url) {
    const parsed = new URL(url);
    const isYouTube = parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
    
    // For video platforms, use yt-dlp to get the title
    if (isYouTube && await this.checkYtDlp()) {
      return new Promise((resolve) => {
        const cookiesPath = path.join(process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop', 'cookies.txt');
        const args = [
          '--get-title', 
          '--skip-download', 
          '--js-runtime', 'node',
          '--extractor-args', 'youtube:player-client=web_embedded,mweb,tv',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];
        
        const proc = spawn('/usr/local/bin/yt-dlp', args);
        let title = '';
        proc.stdout.on('data', (data) => title += data.toString());
        proc.on('close', () => resolve(title.trim() || path.basename(parsed.pathname)));
        proc.on('error', () => resolve(path.basename(parsed.pathname)));
      });
    }

    // For direct files, try a HEAD request for Content-Disposition or basename
    return new Promise((resolve) => {
      try {
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
      } catch (err) {
          resolve(path.basename(parsed.pathname) || 'download');
      }
    });
  }

  async startDownload(jobId) {
    const activeCount = Array.from(this.activeDownloads.keys()).length;
    if (activeCount >= MAX_CONCURRENT_JOBS) {
      console.log(`[Downloader] Queueing job ${jobId} (Active: ${activeCount}/${MAX_CONCURRENT_JOBS})`);
      this.db.updateJob(jobId, { status: 'queued' });
      return;
    }

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
    } finally {
      // Check for next job in queue
      this.processQueue();
    }
  }

  processQueue() {
    const queuedJobs = this.db.getAllJobs().filter(j => j.status === 'queued');
    if (queuedJobs.length > 0 && this.activeDownloads.size < MAX_CONCURRENT_JOBS) {
        const nextJob = queuedJobs[queuedJobs.length - 1]; // Oldest first (ASC order usually, but getAllJobs is DESC)
        // Correcting: find the oldest queued job
        const oldestQueued = queuedJobs.sort((a,b) => new Date(a.created_at) - new Date(b.created_at))[0];
        if (oldestQueued) {
            console.log(`[Downloader] Picking up queued job: ${oldestQueued.id}`);
            this.startDownload(oldestQueued.id);
        }
    }
  }

  async downloadYtDlp(job) {
    const finalDir = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'library');
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

    const binary = '/usr/local/bin/yt-dlp';
    const storageRoot = process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop';
    const cookiesPath = path.join(storageRoot, 'cookies.txt');
    
    const args = [
      '--output', path.join(finalDir, job.safe_filename),
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template', '{"percent":"%(progress._percent_str)s"}',
      '--js-runtime', 'node',
      '--extractor-args', 'youtube:player-client=web_embedded,mweb,tv',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    if (fs.existsSync(cookiesPath)) {
        console.log(`[yt-dlp] Using cookies from ${cookiesPath}`);
        args.push('--cookies', cookiesPath);
    }
    
    args.push(job.url);

    console.log(`[yt-dlp] Starting download for job ${job.id}: ${job.url}`);
    const child = spawn(binary, args);
    this.activeDownloads.set(job.id, child);

    return new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/\{"percent":"\s*(.*)%"\}/);
        if (match) {
          const progress = parseFloat(match[1]);
          this.db.updateJob(job.id, { progress_percent: progress });
        }
      });

      child.stderr.on('data', (data) => {
        console.error(`[yt-dlp] [stderr] job ${job.id}: ${data.toString()}`);
      });

      child.on('error', (err) => {
        console.error(`[yt-dlp] Failed to start process for job ${job.id}:`, err);
        this.activeDownloads.delete(job.id);
        reject(err);
      });

      child.on('close', (code) => {
        this.activeDownloads.delete(job.id);
        console.log(`[yt-dlp] Process exited with code ${code} for job ${job.id}`);
        if (code === 0) {
          const finalPath = path.join(finalDir, job.safe_filename);
          if (fs.existsSync(finalPath)) {
            const stats = fs.statSync(finalPath);
            this.db.updateJob(job.id, {
                file_size: stats.size,
                absolute_path: finalPath,
                relative_path: job.safe_filename
            });
          }
          resolve();
        } else {
          let errorMsg = `yt-dlp exited with code ${code}`;
          if (child.stderr_data && child.stderr_data.includes('Sign in to confirm you’re not a bot')) {
              errorMsg = 'YouTube Bot Check: Please upload cookies.txt (see README)';
          }
          reject(new Error(errorMsg));
        }
      });

      // Capture stderr for better error reporting
      child.stderr_data = '';
      child.stderr.on('data', (data) => {
          child.stderr_data += data.toString();
          console.error(`[yt-dlp] [stderr] job ${job.id}: ${data.toString()}`);
      });
    });
  }

  async downloadAria2(job) {
    const tmpDir = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'tmp');
    const finalDir = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'library');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

    const binary = '/usr/bin/aria2c';
    const args = [
      '--dir', tmpDir,
      '--out', job.safe_filename,
      '--continue=true',
      '--max-connection-per-server=5',
      '--summary-interval=1',
      job.url
    ];

    console.log(`[aria2c] Starting download for job ${job.id}: ${job.url}`);
    const child = spawn(binary, args);
    this.activeDownloads.set(job.id, child);

    return new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/\((.*)%\)/);
        if (match) {
          const progress = parseFloat(match[1]);
          this.db.updateJob(job.id, { progress_percent: progress });
        }
      });

      child.stderr.on('data', (data) => {
        console.error(`[aria2c] [stderr] job ${job.id}: ${data.toString()}`);
      });

      child.on('error', (err) => {
        console.error(`[aria2c] Failed to start process for job ${job.id}:`, err);
        this.activeDownloads.delete(job.id);
        reject(err);
      });

      child.on('close', (code) => {
        this.activeDownloads.delete(job.id);
        console.log(`[aria2c] Process exited with code ${code} for job ${job.id}`);
        if (code === 0) {
          const tmpPath = path.join(tmpDir, job.safe_filename);
          const finalPath = path.join(finalDir, job.safe_filename);
          if (fs.existsSync(tmpPath)) {
            fs.renameSync(tmpPath, finalPath);
            const stats = fs.statSync(finalPath);
            this.db.updateJob(job.id, {
              file_size: stats.size,
              absolute_path: finalPath,
              relative_path: job.safe_filename
            });
          }
          resolve();
        } else {
          reject(new Error(`aria2c exited with code ${code}`));
        }
      });
    });
  }

  async downloadNative(job) {
    const tmpDir = path.join(process.env.MEDIA_DROP_STORAGE_ROOT, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    
    const tempPath = path.join(tmpDir, job.safe_filename);
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
