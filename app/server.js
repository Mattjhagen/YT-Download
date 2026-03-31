require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const DBManager = require('./db');
const { Downloader, sanitizeFilename } = require('./downloader');

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

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['cf-connecting-ip'] || req.ip;
  },
  validate: { xForwardedForHeader: false } // Disable this specific validation as we handle CF headers manually
});

app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
const auth = (req, res, next) => {
  const sessionToken = req.cookies.session;
  if (sessionToken === adminPassword) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// SSE Clients
let sseClients = [];

// API Routes
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === adminPassword) {
    res.cookie('session', adminPassword, { httpOnly: true, maxAge: 86400000 });
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
  res.json({ authenticated: sessionToken === adminPassword });
});

app.get('/api/downloads', auth, (req, res) => {
  const jobs = db.getAllJobs();
  res.json(jobs);
});

app.post('/api/downloads', auth, limiter, async (req, res) => {
  const { url, filename, subfolder } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const userAgent = req.headers['user-agent'];
  
  try {
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
    const relativePath = path.join(subfolder || '', safeName);
    const absolutePath = path.join(storageRoot, 'library', relativePath);

    const job = db.createJob({
      id,
      url,
      original_url: url,
      filename: finalFilename,
      safe_filename: safeName,
      relative_path: relativePath,
      absolute_path: absolutePath,
      source_domain: domain
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

// Broadcaster for SSE
setInterval(() => {
  if (sseClients.length === 0) return;
  const jobs = db.getAllJobs().filter(j => j.status === 'downloading' || j.status === 'queued');
  if (jobs.length > 0) {
    const data = JSON.stringify(jobs);
    sseClients.forEach(c => c.res.write(`data: ${data}\n\n`));
  }
}, 1000);

// Media Streaming with Range support
app.get('/media/:filename', auth, (req, res) => {
  const filename = req.params.filename;
  const storageRoot = process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop';
  const filePath = path.join(storageRoot, 'library', filename);

  // Prevent path traversal
  if (!filePath.startsWith(path.join(storageRoot, 'library'))) {
    return res.status(403).send('Forbidden');
  }

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath, { acceptRanges: true });
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

  const files = fs.readdirSync(libraryDir).map(file => {
    const filePath = path.join(libraryDir, file);
    const stats = fs.statSync(filePath);
    return {
      name: file,
      size: stats.size,
      mtime: stats.mtime,
      path: filePath,
      url: `/media/${encodeURIComponent(file)}`
    };
  });
  
  res.json(files);
});

app.listen(port, '127.0.0.1', () => {
  console.log('---------------------------------------------------------');
  console.log(`🚀 Media Drop server starting...`);
  console.log(`📍 Local Address: http://127.0.0.1:${port}`);
  console.log(`📂 Storage Root:  ${process.env.MEDIA_DROP_STORAGE_ROOT || '/srv/media-drop'}`);
  console.log(`🛡️  Admin Auth:    ENABLED`);
  console.log(`🔥 Rate Limiting:  ENABLED (5/hr)`);
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
