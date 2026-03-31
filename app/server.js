require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const DBManager = require('./db');
const { Downloader, sanitizeFilename } = require('./downloader');
const UrlHelper = require('./utils/url');

const app = express();
const port = process.env.PORT || 8080;
const adminPassword = process.env.MEDIA_DROP_ADMIN_PASSWORD || 'change-me';

// Initialize DB and Downloader
const db = new DBManager();
const downloader = new Downloader(db);

// Middleware
app.use(express.json());
app.use(cookieParser());
app.set('trust proxy', 1); // For Cloudflare/proxies to get real IP

// Trust Cloudflare proxy headers
app.set('trust proxy', 1);
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 100, // Allow 100 requests per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many requests, please try again later.' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());
app.use(limiter);

// Auth middleware
const auth = (req, res, next) => {
  const sessionToken = req.cookies.session;
  if (process.env.MEDIA_DROP_ADMIN_PASSWORD && sessionToken === process.env.MEDIA_DROP_ADMIN_PASSWORD) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// SSE Clients
let sseClients = [];

// API Routes
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (process.env.MEDIA_DROP_ADMIN_PASSWORD && password === process.env.MEDIA_DROP_ADMIN_PASSWORD) {
    res.cookie('session', password, { httpOnly: true, secure: true, sameSite: 'strict' });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  const sessionToken = req.cookies.session;
  res.json({ authenticated: process.env.MEDIA_DROP_ADMIN_PASSWORD && sessionToken === process.env.MEDIA_DROP_ADMIN_PASSWORD });
});

app.get('/api/downloads', auth, (req, res) => {
  const jobs = db.getAllJobs().map(job => ({
    ...job,
    media_url: UrlHelper.buildMediaUrl(job.relative_path || job.safe_filename),
    vlc_url: UrlHelper.buildVlcUrl(job.relative_path || job.safe_filename)
  }));
  res.json(jobs);
});

app.post('/api/downloads', auth, async (req, res) => {
  const { url, filename, subfolder, is_audio } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    // Validate subfolder to prevent path traversal
    let safeSubfolder = '';
    if (subfolder) {
      safeSubfolder = sanitizeFilename(subfolder.replace(/\//g, '_').replace(/\\/g, '_'));
    }

    const parsedUrl = await downloader.validateURL(url);
    const domain = parsedUrl.hostname;

    // Log intent
    db.logAction('DOWNLOAD_SUBMIT', { url, ip, user_agent: userAgent, status: 'pending' });

    // Fetch metadata if no filename provided
    let finalTitle = filename;
    if (!finalTitle) {
        finalTitle = await downloader.getMetadata(url);
    }

    // Determine filename
    let finalFilename = finalTitle || 'download';
    if (!path.extname(finalFilename) && path.extname(parsedUrl.pathname)) {
        finalFilename += path.extname(parsedUrl.pathname);
    }

    const safeName = sanitizeFilename(finalFilename);
    const id = uuidv4();

    const storageRoot = process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop';
    const relativePath = safeSubfolder ? path.join(safeSubfolder, safeName) : safeName;
    const absolutePath = path.join(storageRoot, 'library', relativePath);

    const job = db.createJob({
      id,
      url,
      original_url: url,
      filename: finalFilename,
      safe_filename: safeName,
      relative_path: relativePath,
      absolute_path: absolutePath,
      source_domain: domain,
      is_audio: !!is_audio
    });

    // Start download in background
    downloader.startDownload(id);

    res.json(job);
  } catch (error) {
    db.logAction('DOWNLOAD_ERROR', { url, ip, user_agent: userAgent, status: 'error', details: { message: error.message } });
    res.status(400).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        storage: process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop'
    });
});

app.post('/api/downloads/:id/retry', auth, (req, res) => {
  const { id } = req.params;
  const job = db.getJob(id);
  if (job) {
    db.updateJob(id, { 
      status: 'queued', 
      progress_percent: 0, 
      error_message: null,
      updated_at: new Date().toISOString() 
    });
    downloader.startDownload(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

app.delete('/api/downloads/:id', auth, (req, res) => {
  const { id } = req.params;
  downloader.cancelDownload(id);
  db.deleteJob(id);
  res.json({ success: true });
});

// SSE for progress
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Broadcaster for SSE — sends progress for active jobs + triggers refresh on status change
const _prevJobStatuses = new Map();
setInterval(() => {
  if (sseClients.length === 0) return;
  const allJobs = db.getAllJobs();
  const activeJobs = allJobs.filter(j => j.status === 'downloading' || j.status === 'queued');

  // Detect jobs that changed status since last tick (e.g., completed/failed)
  let statusChanged = false;
  for (const job of allJobs) {
    const prev = _prevJobStatuses.get(job.id);
    if (prev !== undefined && prev !== job.status) {
      statusChanged = true;
    }
    _prevJobStatuses.set(job.id, job.status);
  }

  if (activeJobs.length > 0) {
    const data = JSON.stringify({ type: 'progress', jobs: activeJobs });
    sseClients.forEach(c => c.res.write(`data: ${data}\n\n`));
  }

  if (statusChanged) {
    // Tell the dashboard to do a full reload
    sseClients.forEach(c => c.res.write(`data: ${JSON.stringify({ type: 'refresh' })}\n\n`));
  }
}, 1000);

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
};

// Media Streaming with Range support — supports subfolders via wildcard
app.get('/media/*', auth, (req, res) => {
  const filename = req.params[0];
  const storageRoot = process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop';
  const libraryRoot = path.join(storageRoot, 'library');
  const filePath = path.resolve(libraryRoot, filename);

  // Prevent path traversal
  if (!filePath.startsWith(libraryRoot + path.sep) && filePath !== libraryRoot) {
    return res.status(403).send('Forbidden');
  }

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    // View Tracking (debounced)
    const debounceHours = parseInt(process.env.MEDIA_VIEW_DEBOUNCE_HOURS, 10) || 6;
    const job = db.getJobByFilename(filename);
    if (job) {
        db.updateView(job.id, debounceHours);
    }

    const range = req.headers.range;
    const download = req.query.download === 'true';

    if (range && !download) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, {start, end});
      const head = {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': download ? `attachment; filename="${encodeURIComponent(filename)}"` : 'inline'
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    res.status(404).send('File not found');
  }
});

app.get('/api/files', auth, (req, res) => {
  const storageRoot = process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop';
  const libraryDir = path.join(storageRoot, 'library');
  
  if (!fs.existsSync(libraryDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(libraryDir)
    .filter(file => !file.startsWith('.'))
    .map(file => {
    const filePath = path.join(libraryDir, file);
    const stats = fs.statSync(filePath);
    return {
      name: file,
      size: stats.size,
      mtime: stats.mtime,
      path: filePath,
      url: UrlHelper.buildMediaUrl(file),
      vlc_url: UrlHelper.buildVlcUrl(file)
    };
  });
  
  res.json(files);
});

// Periodic Cleanup Job
async function runCleanup() {
  if (process.env.MEDIA_RETENTION_ENABLED === 'false') return;
  
  const retentionDays = parseInt(process.env.MEDIA_RETENTION_DAYS, 10) || 30;
  console.log(`[Cleanup] Running daily retention check (Threshold: ${retentionDays} days)...`);
  
  const expiredJobs = db.getExpiredJobs(retentionDays);
  let deletedCount = 0;

  for (const job of expiredJobs) {
    if (job.absolute_path && fs.existsSync(job.absolute_path)) {
      try {
        fs.unlinkSync(job.absolute_path);
        db.markJobDeleted(job.id);
        db.logAction('CLEANUP_DELETE', { 
            url: job.url, 
            status: 'success', 
            details: { id: job.id, filename: job.filename, path: job.absolute_path } 
        });
        deletedCount++;
        console.log(`[Cleanup] Deleted expired media: ${job.filename} (ID: ${job.id})`);
      } catch (err) {
        console.error(`[Cleanup] Failed to delete file ${job.absolute_path}:`, err);
      }
    } else {
        // Even if file is missing, mark as expired to keep DB clean
        db.markJobDeleted(job.id);
    }
  }
  
  if (deletedCount > 0) {
    console.log(`[Cleanup] Successfully removed ${deletedCount} expired items.`);
  }
}

// Run cleanup every 24 hours
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
setInterval(runCleanup, CLEANUP_INTERVAL);

// Also run once on startup (after 1 minute to avoid heavy load)
setTimeout(runCleanup, 60 * 1000);

app.listen(port, '127.0.0.1', () => {
  console.log('---------------------------------------------------------');
  console.log(`🚀 Media Drop server starting...`);
  console.log(`📍 Local Address: http://127.0.0.1:${port}`);
  console.log(`📂 Storage Root:  ${process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop'}`);
  console.log(`🛡️  Admin Auth:    ENABLED`);
  console.log(`🔥 Rate Limiting:  ENABLED (100/hr)`);
  console.log('---------------------------------------------------------');
  
  // Log tool versions for debugging
  const { execSync } = require('child_process');
  try {
    const aria2Version = execSync('/usr/bin/aria2c --version | head -n 1').toString().trim();
    console.log(`[System] ${aria2Version}`);
  } catch (e) { console.error('[System] aria2c not found at /usr/bin/aria2c'); }
  
  try {
    const ytdlVersion = execSync('/usr/local/bin/yt-dlp --version').toString().trim();
    console.log(`[System] yt-dlp version: ${ytdlVersion}`);
  } catch (e) { console.error('[System] yt-dlp not found at /usr/local/bin/yt-dlp'); }

  // Resume interrupted downloads on startup
  const interruptedJobs = db.getAllJobs().filter(j => j.status === 'downloading' || j.status === 'queued');
  if (interruptedJobs.length > 0) {
    console.log(`[Startup] Resuming ${interruptedJobs.length} interrupted/queued jobs...`);
    interruptedJobs.forEach(job => {
      downloader.startDownload(job.id);
    });
  }
});
