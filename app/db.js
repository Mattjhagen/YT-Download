const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DBManager {
  constructor() {
    const dbPath = process.env.MEDIA_DROP_DB_PATH || '/srv/media-drop/db/media-drop.sqlite';
    const dbDir = path.dirname(dbPath);
    
    // Ensure DB directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.init();
  }

  init() {
    // Create jobs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        original_url TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        progress_percent REAL DEFAULT 0,
        downloaded_bytes INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        speed_bytes_per_sec INTEGER DEFAULT 0,
        eta_seconds INTEGER DEFAULT 0,
        filename TEXT,
        safe_filename TEXT,
        relative_path TEXT,
        absolute_path TEXT,
        mime_type TEXT,
        file_size INTEGER DEFAULT 0,
        source_domain TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT,
        error_message TEXT
      )
    `);

    // Create trigger for updated_at
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS jobs_updated_at 
      AFTER UPDATE ON jobs
      FOR EACH ROW
      BEGIN
        UPDATE jobs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
      END
    `);

    // Create audit_logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        action TEXT NOT NULL,
        url TEXT,
        ip TEXT,
        user_agent TEXT,
        status TEXT,
        details TEXT
      )
    `);
  }

  createJob(jobData) {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (
        id, url, original_url, status, filename, safe_filename, relative_path, absolute_path, source_domain
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    stmt.run(
      jobData.id,
      jobData.url,
      jobData.original_url,
      'queued',
      jobData.filename,
      jobData.safe_filename,
      jobData.relative_path,
      jobData.absolute_path,
      jobData.source_domain
    );
    return this.getJob(jobData.id);
  }

  updateJob(id, updates) {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const stmt = this.db.prepare(`UPDATE jobs SET ${setClause} WHERE id = ?`);
    stmt.run(...Object.values(updates), id);
  }

  getJob(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  getAllJobs() {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  }

  deleteJob(id) {
    const job = this.getJob(id);
    if (job && job.absolute_path && fs.existsSync(job.absolute_path)) {
      try {
        fs.unlinkSync(job.absolute_path);
      } catch (e) {
        console.error(`Failed to delete file for job ${id}:`, e);
      }
    }
    return this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  logAction(action, data = {}) {
    const cookiePath = process.env.COOKIES_PATH || '/srv/media-drop/cookies.txt';
    if (fs.existsSync(cookiePath)) {
      console.log(`Accessing cookie file at: ${cookiePath}`);
    } else {
      console.warn(`Cookie file not found at: ${cookiePath}`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (action, url, ip, user_agent, status, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      action,
      data.url || null,
      data.ip || null,
      data.user_agent || null,
      data.status || 'success',
      data.details ? JSON.stringify(data.details) : null,
      new Date().toISOString()
    );
  }

  getAuditLogs(limit = 100) {
    return this.db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
  }
}

module.exports = DBManager;
