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
const bindHost = process.env.MEDIA_DROP_BIND_HOST || '127.0.0.1';
const adminPassword = process.env.MEDIA_DROP_ADMIN_PASSWORD || 'change-me';
const allowPublicMedia = process.env.MEDIA_DROP_ALLOW_PUBLIC_MEDIA === 'true';

// Initialize DB and Downloader
const db = new DBManager();
const downloader = new Downloader(db);

// Middleware
app.use(express.json());
app.use(cookieParser());
app.set('trust proxy', 1); // For Cloudflare/proxies to get real IP

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: parseInt(process.env.MEDIA_DROP_RATE_LIMIT_PER_HOUR || '1200', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  skip: (req) => {
    const requestPath = req.path || '';
    if (req.method === 'GET' && (
      requestPath === '/health' ||
      requestPath === '/api/session' ||
      requestPath === '/api/downloads' ||
      requestPath === '/api/events' ||
      requestPath.startsWith('/media/')
    )) {
      return true;
    }
    return false;
  },
  message: { error: 'Too many requests, please try again later.' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(limiter);

const getStorageRoot = () => process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop';
const getLibraryRoot = () => path.join(getStorageRoot(), 'library');

const normalizeRelativePath = (value) => {
  if (!value) return '';
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
};

const toSafeRelativePath = (absolutePath) => {
  const libraryRoot = getLibraryRoot();
  const relative = path.relative(libraryRoot, absolutePath);
  if (relative.startsWith('..')) return '';
  return normalizeRelativePath(relative);
};

const resolveMediaPath = (requestedPath) => {
  const libraryRoot = getLibraryRoot();
  const normalized = normalizeRelativePath(decodeURIComponent(String(requestedPath || '')));
  if (!normalized) return null;

  const candidate = path.resolve(libraryRoot, normalized);
  if (!candidate.startsWith(libraryRoot + path.sep) && candidate !== libraryRoot) {
    return null;
  }

  if (fs.existsSync(candidate)) {
    return {
      absolutePath: candidate,
      relativePath: toSafeRelativePath(candidate)
    };
  }

  const parsed = path.parse(candidate);
  if (parsed.ext) {
    return null;
  }

  if (!fs.existsSync(parsed.dir)) {
    return null;
  }

  try {
    const matches = fs.readdirSync(parsed.dir)
      .filter((entry) => {
        const entryPath = path.join(parsed.dir, entry);
        if (!fs.existsSync(entryPath)) return false;
        const stat = fs.statSync(entryPath);
        if (!stat.isFile()) return false;
        return path.parse(entry).name === parsed.name;
      })
      .sort();

    if (matches.length === 0) {
      return null;
    }

    const resolvedAbsolute = path.join(parsed.dir, matches[0]);
    return {
      absolutePath: resolvedAbsolute,
      relativePath: toSafeRelativePath(resolvedAbsolute)
    };
  } catch {
    return null;
  }
};

const getPlaybackPathForJob = (job) => {
  const candidates = [
    normalizeRelativePath(job.relative_path),
    normalizeRelativePath(job.safe_filename),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolveMediaPath(candidate);
    if (resolved?.relativePath) {
      return resolved.relativePath;
    }
  }

  if (job.absolute_path && fs.existsSync(job.absolute_path)) {
    const relativePath = toSafeRelativePath(job.absolute_path);
    if (relativePath) return relativePath;
  }

  return candidates[0] || '';
};

const isValidAuthToken = (value) => {
  return typeof value === 'string' && value.length > 0 && value === adminPassword;
};

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== 'string') return null;
  if (!authorizationHeader.toLowerCase().startsWith('bearer ')) return null;
  return authorizationHeader.slice(7).trim();
};

const isAuthenticated = (req, { allowQueryToken = false } = {}) => {
  const sessionToken = req.cookies.session;
  const bearerToken = getBearerToken(req.headers.authorization);
  const finchwireToken = req.headers['x-finchwire-token'];
  const queryToken = allowQueryToken ? req.query.token : null;

  return (
    isValidAuthToken(sessionToken) ||
    isValidAuthToken(bearerToken) ||
    isValidAuthToken(finchwireToken) ||
    isValidAuthToken(queryToken)
  );
};

// Authentication middleware (API)
const auth = (req, res, next) => {
  if (isAuthenticated(req)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// Media auth middleware.
// Allows query token so external players (e.g., VLC) can open protected media URLs.
const mediaAuth = (req, res, next) => {
  if (allowPublicMedia) {
    return next();
  }
  if (isAuthenticated(req, { allowQueryToken: true })) {
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
  const jobs = db.getAllJobs().map((job) => {
    const playbackPath = getPlaybackPathForJob(job);
    const normalizedRelative = normalizeRelativePath(job.relative_path);
    const expectedSafeFilename = playbackPath ? path.basename(playbackPath) : job.safe_filename;

    // Opportunistically heal stale DB rows (older downloads without extension/path corrections).
    if (
      playbackPath &&
      (
        normalizedRelative !== playbackPath ||
        normalizeRelativePath(job.safe_filename) !== expectedSafeFilename ||
        (job.absolute_path && !normalizeRelativePath(job.absolute_path).endsWith(playbackPath))
      )
    ) {
      db.updateJob(job.id, {
        relative_path: playbackPath,
        safe_filename: expectedSafeFilename,
        absolute_path: path.join(getLibraryRoot(), playbackPath),
      });
    }

    return {
      ...job,
      relative_path: playbackPath,
      safe_filename: expectedSafeFilename,
      media_url: UrlHelper.buildMediaUrl(playbackPath),
      vlc_url: UrlHelper.buildVlcUrl(playbackPath),
    };
  });
  res.json(jobs);
});

app.post('/api/downloads', auth, async (req, res) => {
  const { url, filename, subfolder, is_audio } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const requestedInput = String(url || '').trim();
    if (!requestedInput) {
      throw new Error('URL or search query is required');
    }

    const resolvedUrl = await downloader.resolveSearchQuery(requestedInput);

    // Validate subfolder to prevent path traversal
    let safeSubfolder = '';
    if (subfolder) {
      safeSubfolder = sanitizeFilename(subfolder.replace(/\//g, '_').replace(/\\/g, '_'));
    }

    const parsedUrl = await downloader.validateURL(resolvedUrl);
    const domain = parsedUrl.hostname;

    // Log intent
    db.logAction('DOWNLOAD_SUBMIT', {
      url: resolvedUrl,
      ip,
      user_agent: userAgent,
      status: 'pending',
      details: requestedInput !== resolvedUrl ? { input: requestedInput } : undefined
    });

    // Fetch metadata if no filename provided
    let finalTitle = filename;
    if (!finalTitle) {
        finalTitle = await downloader.getMetadata(resolvedUrl);
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
      url: resolvedUrl,
      original_url: requestedInput,
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

app.patch('/api/downloads/:id/keep', auth, (req, res) => {
  const { id } = req.params;
  const { keep_forever } = req.body || {};

  if (typeof keep_forever !== 'boolean') {
    return res.status(400).json({ error: 'keep_forever must be boolean' });
  }

  const job = db.getJob(id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  db.setKeepForever(id, keep_forever);
  const updated = db.getJob(id);
  res.json({ success: true, job: updated });
});

// SSE for progress
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Crucial for Cloudflare/NGINX
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
let lastHeartbeat = Date.now();

setInterval(() => {
  if (sseClients.length === 0) return;
  
  const now = Date.now();
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

  // Send data if active jobs
  if (activeJobs.length > 0) {
    const data = JSON.stringify({ type: 'progress', jobs: activeJobs });
    sseClients.forEach(c => c.res.write(`data: ${data}\n\n`));
  } else if (now - lastHeartbeat > 15000) {
    // Send heartbeat (ping) every 15s if no jobs to keep Cloudflare happy
    sseClients.forEach(c => c.res.write(`: ping\n\n`));
    lastHeartbeat = now;
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
app.get('/media/*', mediaAuth, (req, res) => {
  const requestedPath = req.params[0];
  const resolved = resolveMediaPath(requestedPath);
  const libraryRoot = getLibraryRoot();

  if (!resolved) {
    return res.status(404).send('File not found');
  }

  const filePath = resolved.absolutePath;
  const relativePath = resolved.relativePath;

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const ext = path.extname(relativePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    // View Tracking (debounced)
    const debounceHours = parseInt(process.env.MEDIA_VIEW_DEBOUNCE_HOURS, 10) || 6;
    const job =
      db.getJobByFilename(relativePath) ||
      db.getJobByFilename(path.basename(relativePath));
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
        'Content-Disposition': download
          ? `attachment; filename="${encodeURIComponent(path.basename(relativePath))}"`
          : 'inline'
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

  const files = fs.readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => {
      if (!file || file.startsWith('.') || file.startsWith('._')) return false;
      const ext = path.extname(file).toLowerCase();
      return Boolean(MIME_TYPES[ext]);
    })
    .map((file) => {
      const relativePath = normalizeRelativePath(file);
      const filePath = path.join(libraryDir, relativePath);
      const stats = fs.statSync(filePath);
      return {
        name: file,
        size: stats.size,
        mtime: stats.mtime,
        relative_path: relativePath,
        url: UrlHelper.buildMediaUrl(relativePath)
      };
    })
    .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  
  res.json(files);
});

app.delete('/api/files', auth, (req, res) => {
  const relativePath = normalizeRelativePath(req.body?.relative_path || req.body?.name);
  if (!relativePath) {
    return res.status(400).json({ error: 'relative_path is required' });
  }

  const resolved = resolveMediaPath(relativePath);
  if (!resolved) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    fs.unlinkSync(resolved.absolutePath);
  } catch (error) {
    return res.status(500).json({ error: `Failed to delete file: ${error.message}` });
  }

  const normalizedTarget = normalizeRelativePath(resolved.relativePath);
  const targetBasename = path.basename(normalizedTarget);
  const matchingJobs = db.getAllJobs().filter((job) => {
    const jobRelative = normalizeRelativePath(job.relative_path);
    const jobSafe = normalizeRelativePath(job.safe_filename);
    const jobAbsoluteRelative = toSafeRelativePath(job.absolute_path || '');
    return jobRelative === normalizedTarget || jobSafe === targetBasename || jobAbsoluteRelative === normalizedTarget;
  });

  matchingJobs.forEach((job) => db.deleteJob(job.id));

  db.logAction('FILE_DELETE', {
    status: 'success',
    details: {
      relative_path: normalizedTarget,
      removed_jobs: matchingJobs.map((job) => job.id),
    },
  });

  return res.json({ success: true });
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

app.listen(port, bindHost, () => {
  console.log('---------------------------------------------------------');
  console.log(`🚀 FinchWire server starting...`);
  console.log(`📍 Local Address: http://${bindHost}:${port}`);
  console.log(`📂 Storage Root:  ${process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop'}`);
  console.log(`🛡️  Admin Auth:    ENABLED`);
  console.log(`🎞️  Public Media:  ${allowPublicMedia ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🔥 Rate Limiting:  ENABLED (${process.env.MEDIA_DROP_RATE_LIMIT_PER_HOUR || '1200'}/hr for non-streaming endpoints)`);
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
