const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const URL = require('url').URL;
const { getStorageRoot } = require('./storage');

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

const MAX_CONCURRENT_JOBS = parseInt(process.env.MEDIA_DROP_MAX_CONCURRENT || '3', 10);
const MAX_FILE_SIZE_BYTES = parseInt(process.env.MEDIA_DROP_MAX_FILE_SIZE_BYTES || String(2 * 1024 * 1024 * 1024), 10);

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
            const isIP = /^[\d\.]+$|:/.test(parsed.hostname);
            if (isIP) {
                allIPs.push(parsed.hostname);
            } else {
                const addresses = await require('dns').promises.resolve4(parsed.hostname).catch(() => []);
                const addresses6 = await require('dns').promises.resolve6(parsed.hostname).catch(() => []);
                allIPs = [...addresses, ...addresses6];
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

    const allowedDomains = (process.env.MEDIA_DROP_ALLOWED_DOMAINS || '').split(',').filter(Boolean);
    if (allowedDomains.length > 0 && !allowedDomains.includes(parsed.hostname)) {
      throw new Error(`Domain ${parsed.hostname} is not in the allowlist.`);
    }

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

  getToolPath(tool) {
    const envPath = process.env[`MEDIA_DROP_${tool.toUpperCase().replace(/-/g, '_')}_PATH`];
    if (envPath && fs.existsSync(envPath)) return envPath;

    const commonPaths = [
      `/opt/homebrew/bin/${tool}`,
      `/usr/local/bin/${tool}`,
      `/usr/bin/${tool}`,
      tool
    ];

    for (const p of commonPaths) {
      if (p === tool || fs.existsSync(p)) return p;
    }
    return tool;
  }

  async checkYtDlp() {
    return new Promise((resolve) => {
      const proc = spawn(this.getToolPath('yt-dlp'), ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  async checkAria2() {
    return new Promise((resolve) => {
      const proc = spawn(this.getToolPath('aria2c'), ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  async getMetadata(url) {
    const parsed = new URL(url);
    const isYouTube = parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be');
    
    if (isYouTube && await this.checkYtDlp()) {
      return new Promise((resolve) => {
        const storageRoot = getStorageRoot();
        const cookiesPath = path.join(storageRoot, 'cookies.txt');
        const args = [
          '--get-title', 
          '--skip-download', 
          '--no-warnings',
          '--js-runtime', 'node',
          '--extractor-args', 'youtube:player_client=ios,tv,mweb,web',
          '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Referer:https://www.youtube.com/'
        ];
        if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
        args.push(url);
        
        const proc = spawn(this.getToolPath('yt-dlp'), args);
        let title = '';
        proc.stdout.on('data', (data) => title += data.toString());
        proc.on('close', () => {
            let finalTitle = title.trim();
            if (!finalTitle) {
                const videoId = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
                finalTitle = videoId ? `youtube_${videoId[1]}` : path.basename(parsed.pathname);
            }
            resolve(finalTitle);
        });
        proc.on('error', () => {
            const videoId = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
            resolve(videoId ? `youtube_${videoId[1]}` : path.basename(parsed.pathname));
        });
      });
    }

    // 🕵️ Generic HTML Title Scraper as a fallback
    return new Promise((resolve) => {
      try {
          const timeout = 5000;
          const protocol = url.startsWith('https') ? https : http;
          const req = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return this.getMetadata(new URL(res.headers.location, url).href).then(resolve);
            }
            let html = '';
            res.on('data', (d) => {
                html += d;
                if (html.length > 50000) res.destroy(); // Don't download entire page
            });
            res.on('close', () => {
                const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (match) return resolve(match[1].trim());
                resolve(path.basename(parsed.pathname) || 'download');
            });
          });
          req.on('error', () => resolve(path.basename(parsed.pathname) || 'download'));
          req.end();
      } catch (err) {
          resolve(path.basename(parsed.pathname) || 'download');
      }
    });
  }

  async resolveSearchQuery(input) {
    const value = String(input || '').trim();
    if (!value) {
      throw new Error('Search query is empty');
    }

    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    const hasYtDlp = await this.checkYtDlp();
    if (!hasYtDlp) {
      throw new Error('yt-dlp is required for search queries. Paste a direct URL instead.');
    }

    return new Promise((resolve, reject) => {
      const binary = this.getToolPath('yt-dlp');
      const args = [
        '--skip-download',
        '--no-warnings',
        '--default-search',
        'ytsearch1',
        '--print',
        'webpage_url',
        '--js-runtime', 'node',
        '--extractor-args', 'youtube:player_client=ios,tv,mweb,web',
        value
      ];

      const proc = spawn(binary, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => reject(err));

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(stderr.trim() || `Search failed (code ${code})`));
        }

        const firstLine = stdout
          .split('\n')
          .map((line) => line.trim())
          .find(Boolean);

        if (!firstLine) {
          return reject(new Error('No search results found'));
        }

        if (/^https?:\/\//i.test(firstLine)) {
          return resolve(firstLine);
        }

        if (/^[a-zA-Z0-9_-]{11}$/.test(firstLine)) {
          return resolve(`https://www.youtube.com/watch?v=${firstLine}`);
        }

        return reject(new Error('Could not resolve search result URL'));
      });
    });
  }

  async startDownload(jobId) {
    const job = this.db.getJob(jobId);
    if (!job) return;

    const activeCount = Array.from(this.activeDownloads.keys()).length;
    if (activeCount >= MAX_CONCURRENT_JOBS) {
      this.db.updateJob(jobId, { status: 'queued' });
      return;
    }

    this.db.updateJob(jobId, { status: 'downloading', updated_at: new Date().toISOString(), error_message: null });

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
      this.processQueue();
    }
  }

  processQueue() {
    const queuedJobs = this.db.getAllJobs().filter(j => j.status === 'queued');
    if (queuedJobs.length > 0 && this.activeDownloads.size < MAX_CONCURRENT_JOBS) {
        const oldestQueued = queuedJobs.sort((a,b) => new Date(a.created_at) - new Date(b.created_at))[0];
        if (oldestQueued) {
            console.log(`[Downloader] Picking up queued job: ${oldestQueued.id}`);
            this.startDownload(oldestQueued.id);
        }
    }
  }

  async downloadYtDlp(job) {
    const storageRoot = getStorageRoot();
    const finalDir = path.join(storageRoot, 'library');
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

    const binary = this.getToolPath('yt-dlp');
    const ffmpegPath = this.getToolPath('ffmpeg');
    const cookiesPath = path.join(storageRoot, 'cookies.txt');
    
    // Quality Strategy: Best available MP4 combination
    const formatStr = job.is_audio ? 'ba/b' : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b';
    
    const args = [
      '--output', path.join(finalDir, job.safe_filename),
      '--format', formatStr,
      '--no-playlist',
      '--newline',
      '--progress',
      '--progress-template', '{"percent":"%(progress._percent_str)s"}',
      '--js-runtime', 'node',
      '--extractor-args', 'youtube:player_client=ios,tv,mweb,web',
      '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Referer:https://www.youtube.com/',
      '--ffmpeg-location', ffmpegPath
    ];

    if (job.is_audio) {
      args.push('--extract-audio', '--audio-format', 'm4a', '--audio-quality', '0');
    } else {
      args.push('--merge-output-format', 'mp4');
    }

    if (fs.existsSync(cookiesPath)) {
        console.log(`[yt-dlp] Using cookies at ${cookiesPath}`);
        args.push('--cookies', cookiesPath);
    }
    
    args.push(job.url);

    console.log(`[yt-dlp] Starting job ${job.id}: ${job.url}`);
    const child = spawn(binary, args);
    this.activeDownloads.set(job.id, child);

    return new Promise((resolve, reject) => {
      let stderrData = '';

      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.percent !== undefined) {
              const pct = parseFloat(String(parsed.percent).replace('%', ''));
              if (!isNaN(pct)) {
                this.db.updateJob(job.id, { progress_percent: pct });
              }
            }
          } catch (e) {
          }
        }
      });

      child.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrData += msg;
        console.error(`[yt-dlp] [stderr] job ${job.id}: ${msg}`);
      });

      child.on('error', (err) => {
        this.activeDownloads.delete(job.id);
        reject(err);
      });

      child.on('close', async (code) => {
        this.activeDownloads.delete(job.id);
        if (code === 0) {
          let finalPath = path.join(finalDir, job.safe_filename);
          if (!fs.existsSync(finalPath)) {
            try {
              const files = fs.readdirSync(finalDir).filter(f =>
                path.basename(f, path.extname(f)) === job.safe_filename
              );
              if (files.length > 0) {
                finalPath = path.join(finalDir, files[0]);
              }
            } catch (e) {
              console.warn(`[Downloader] Could not scan library dir: ${e.message}`);
            }
          }
          if (fs.existsSync(finalPath)) {
            await this.updateMetadataAfterDownload(job, finalPath);
          } else {
            console.warn(`[Downloader] Could not find downloaded file at ${finalPath}`);
          }
          resolve();
        } else {
          let errorMsg = `yt-dlp failed (code ${code})`;
          if (stderrData.includes('Sign in to confirm') || stderrData.includes('not a bot')) {
            errorMsg = 'YouTube Bot Check: Please upload fresh cookies.txt';
          } else if (stderrData) {
            const lines = stderrData.split('\n').filter(l => l.includes('ERROR:'));
            if (lines.length > 0) errorMsg = lines[lines.length - 1].replace('ERROR: ', '').trim();
          }
          reject(new Error(errorMsg));
        }
      });
    });
  }

  async downloadAria2(job) {
    const storageRoot = getStorageRoot();
    const tmpDir = path.join(storageRoot, 'tmp');
    const finalDir = path.join(storageRoot, 'library');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const args = [
      '--dir', tmpDir,
      '--out', job.safe_filename,
      '--continue=true',
      '--max-connection-per-server=5',
      job.url
    ];

    const child = spawn(this.getToolPath('aria2c'), args);
    this.activeDownloads.set(job.id, child);

    return new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        const match = data.toString().match(/\((.*)%\)/);
        if (match) this.db.updateJob(job.id, { progress_percent: parseFloat(match[1]) });
      });

      child.on('close', (code) => {
        this.activeDownloads.delete(job.id);
        if (code === 0) {
          const tmpPath = path.join(tmpDir, job.safe_filename);
          const finalPath = path.join(finalDir, job.safe_filename);
          fs.renameSync(tmpPath, finalPath);
          resolve();
        } else {
          reject(new Error(`aria2c failed (code ${code})`));
        }
      });
    });
  }

  async downloadNative(job) {
    const storageRoot = getStorageRoot();
    const tmpDir = path.join(storageRoot, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const finalDir = path.join(storageRoot, 'library');
    const tempPath = path.join(tmpDir, job.safe_filename);
    const file = fs.createWriteStream(tempPath);
    const protocol = job.url.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
      const req = protocol.get(job.url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlink(tempPath, () => {});
          job = { ...job, url: response.headers.location };
          this.downloadNative(job).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(tempPath, () => {});
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
      });

      req.setTimeout(30000, () => {
        req.destroy();
        fs.unlink(tempPath, () => {});
        reject(new Error('Download connection timed out after 30 seconds'));
      });

      req.on('error', (err) => {
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

  async updateMetadataAfterDownload(job, finalPath) {
    const stats = fs.statSync(finalPath);
    const actualFilename = path.basename(finalPath);
    const actualRelativePath = job.relative_path
      ? path.join(path.dirname(job.relative_path), actualFilename)
      : actualFilename;
    const update = {
      file_size: stats.size,
      absolute_path: finalPath,
      safe_filename: actualFilename,
      relative_path: actualRelativePath,
      updated_at: new Date().toISOString()
    };

    try {
      const binary = this.getToolPath('yt-dlp');
      const storageRoot = getStorageRoot();
      const cookiesPath = path.join(storageRoot, 'cookies.txt');
      const args = ['--print-json', '--skip-download', '--js-runtime', 'node', '--extractor-args', 'youtube:player_client=ios,tv,mweb,web', job.url];
      if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
      
      const proc = spawn(binary, args);
      let jsonStr = '';
      proc.stdout.on('data', (d) => jsonStr += d.toString());
      await new Promise((res) => proc.on('close', res));
      
      const info = JSON.parse(jsonStr);
      update.width = info.width;
      update.height = info.height;
      update.mime_type = info.ext ? `media/${info.ext}` : null;

      const currentName = String(job.filename || '').trim();
      const looksLikeFallback =
        !currentName ||
        /^youtube_[a-zA-Z0-9_-]{11}$/i.test(currentName) ||
        /^[a-zA-Z0-9_-]{10,14}$/.test(currentName);

      if (looksLikeFallback && typeof info.title === 'string' && info.title.trim()) {
        update.filename = info.title.trim();
      }
    } catch (e) {
      console.warn(`[Downloader] Metadata extraction failed: ${e.message}`);
    }

    this.db.updateJob(job.id, update);
  }
}

module.exports = { Downloader, sanitizeFilename };
