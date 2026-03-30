require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
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

app.post('/api/downloads', auth, async (req, res) => {
  const { url, filename, subfolder } = req.body;
  
  try {
    const parsedUrl = await downloader.validateURL(url);
    const domain = parsedUrl.hostname;
    
    // Determine filename if not provided
    let finalFilename = filename || path.basename(parsedUrl.pathname) || 'download';
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
    res.status(400).json({ error: error.message });
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

app.listen(port, () => {
  console.log(`Media Drop server running at http://localhost:${port}`);
});
