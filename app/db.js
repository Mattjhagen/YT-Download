const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getDbPath } = require('./storage');

class DBManager {
  constructor() {
    const dbPath = getDbPath();
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
        error_message TEXT,
        width INTEGER,
        height INTEGER,
        is_audio INTEGER DEFAULT 0,
        last_viewed_at TEXT,
        view_count INTEGER DEFAULT 0,
        keep_forever INTEGER DEFAULT 0,
        deleted_at TEXT
      )
    `);

    // Add columns if they don't exist (for existing DBs)
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN width INTEGER'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN height INTEGER'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN is_audio INTEGER DEFAULT 0'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN last_viewed_at TEXT'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN view_count INTEGER DEFAULT 0'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN keep_forever INTEGER DEFAULT 0'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN deleted_at TEXT'); } catch(e) {}
    try { this.db.exec('ALTER TABLE jobs ADD COLUMN error_message TEXT'); } catch(e) {}

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

    // App-level settings (admin password, AI/TTS providers, API keys, etc.)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
  }

  createJob(jobData) {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (
        id, url, original_url, status, filename, safe_filename, relative_path, absolute_path, source_domain, is_audio
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      jobData.source_domain,
      jobData.is_audio ? 1 : 0
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
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (action, url, ip, user_agent, status, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      action,
      data.url || null,
      data.ip || null,
      data.user_agent || null,
      data.status || null,
      data.details ? JSON.stringify(data.details) : null
    );
  }

  updateView(id, debounceHours = 6) {
    const job = this.getJob(id);
    if (!job) return;

    const now = new Date();
    const lastView = job.last_viewed_at ? new Date(job.last_viewed_at) : null;
    
    // Check debounce window
    if (lastView && (now - lastView) < (debounceHours * 60 * 60 * 1000)) {
        return; // Don't update yet
    }

    this.db.prepare(`
        UPDATE jobs 
        SET last_viewed_at = ?, 
            view_count = view_count + 1 
        WHERE id = ?
    `).run(now.toISOString(), id);
  }

  getExpiredJobs(daysThreshold = 30) {
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - daysThreshold);
    const limitIso = dateLimit.toISOString();

    return this.db.prepare(`
        SELECT * FROM jobs 
        WHERE status = 'completed' 
        AND deleted_at IS NULL
        AND IFNULL(keep_forever, 0) = 0
        AND (
            (last_viewed_at IS NOT NULL AND last_viewed_at < ?) OR
            (last_viewed_at IS NULL AND completed_at IS NOT NULL AND completed_at < ?) OR
            (last_viewed_at IS NULL AND completed_at IS NULL AND created_at < ?)
        )
    `).all(limitIso, limitIso, limitIso);
  }

  getJobByFilename(filename) {
    return this.db.prepare(`
        SELECT * FROM jobs 
        WHERE safe_filename = ? OR relative_path = ? OR filename = ?
        LIMIT 1
    `).get(filename, filename, filename);
  }

  markJobDeleted(id) {
    this.db.prepare(`
        UPDATE jobs 
        SET status = 'expired', 
            deleted_at = ? 
        WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  setKeepForever(id, keepForever) {
    this.db.prepare(`
        UPDATE jobs
        SET keep_forever = ?
        WHERE id = ?
    `).run(keepForever ? 1 : 0, id);
  }

  getSetting(key, fallback = null) {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ? LIMIT 1')
      .get(key);
    if (!row || row.value === undefined || row.value === null) {
      return fallback;
    }
    return row.value;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value);
    return this.getSetting(key);
  }

  getSettings(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) {
      const rows = this.db.prepare('SELECT key, value FROM app_settings').all();
      return rows.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
      }, {});
    }

    const placeholders = keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT key, value FROM app_settings WHERE key IN (${placeholders})`)
      .all(...keys);

    const map = {};
    rows.forEach((row) => {
      map[row.key] = row.value;
    });
    return map;
  }

  getAuditLogs(limit = 100) {
    const stmt = this.db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(limit);
  }
}

module.exports = DBManager;
