// SQLite database — replaces the previous JSON-file store.
// Complex fields (arrays / objects) are stored as JSON text columns and
// parsed on read, so the shapes returned here match what the frontend expects.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const DB_PATH = process.env.DATABASE_URL && process.env.DATABASE_URL.endsWith('.db')
  ? process.env.DATABASE_URL
  : path.join(DATA_DIR, 'sentinel.db');

// Ensure the directory that will actually hold the DB file exists.
// (DB_PATH may live outside DATA_DIR when DATABASE_URL is an absolute path.)
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    name TEXT,
    url TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    templateMode TEXT DEFAULT 'categories',
    templateCategories TEXT DEFAULT '[]',
    customTemplates TEXT DEFAULT '[]',
    schedule TEXT DEFAULT 'daily',
    cronExpression TEXT,
    notifications TEXT DEFAULT '{}',
    advanced TEXT DEFAULT '{}',
    createdAt TEXT,
    lastScanAt TEXT,
    findingCounts TEXT DEFAULT '{"info":0,"low":0,"medium":0,"high":0,"critical":0}'
  );

  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    monitorId TEXT,
    target TEXT,
    templates TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued',
    queuedAt TEXT,
    startedAt TEXT,
    completedAt TEXT,
    terminalOutput TEXT DEFAULT '',
    error TEXT,
    shareToken TEXT,
    progress TEXT
  );

  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    scanId TEXT,
    templateId TEXT,
    name TEXT,
    severity TEXT DEFAULT 'info',
    host TEXT,
    matchedAt TEXT,
    description TEXT,
    remediation TEXT,
    reference TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    cvss REAL,
    cve TEXT,
    extracted TEXT,
    curl TEXT,
    request TEXT,
    response TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    type TEXT,
    name TEXT,
    enabled INTEGER DEFAULT 0,
    config TEXT DEFAULT '{}',
    connected INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_scans_monitor ON scans(monitorId);
  CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scanId);
`);

// ─── Lightweight migrations for pre-existing databases ───
const scanColumns = sqlite.prepare('PRAGMA table_info(scans)').all().map(c => c.name);
if (!scanColumns.includes('shareToken')) {
  sqlite.exec('ALTER TABLE scans ADD COLUMN shareToken TEXT');
}
if (!scanColumns.includes('progress')) {
  sqlite.exec('ALTER TABLE scans ADD COLUMN progress TEXT');
}
sqlite.exec('CREATE INDEX IF NOT EXISTS idx_scans_token ON scans(shareToken)');

// ─── (de)serialization helpers ───
const JSON_FIELDS = {
  monitors: ['templateCategories', 'customTemplates', 'notifications', 'advanced', 'findingCounts'],
  findings: ['reference', 'tags'],
  channels: ['config'],
};

function parseRow(table, row) {
  if (!row) return row;
  const jsonFields = JSON_FIELDS[table] || [];
  const out = { ...row };
  for (const f of jsonFields) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch { /* leave as-is */ }
    }
  }
  if (table === 'channels') {
    out.enabled = !!out.enabled;
    out.connected = !!out.connected;
  }
  return out;
}

function serialize(table, obj) {
  const jsonFields = JSON_FIELDS[table] || [];
  const out = { ...obj };
  for (const f of jsonFields) {
    if (out[f] !== undefined && typeof out[f] !== 'string') {
      out[f] = JSON.stringify(out[f]);
    }
  }
  if (table === 'channels') {
    if ('enabled' in out) out.enabled = out.enabled ? 1 : 0;
    if ('connected' in out) out.connected = out.connected ? 1 : 0;
  }
  return out;
}

// Generic upsert by primary key
function upsert(table, pk, obj) {
  const row = serialize(table, obj);
  const cols = Object.keys(row);
  const placeholders = cols.map(c => `@${c}`).join(', ');
  const updates = cols.filter(c => c !== pk).map(c => `${c}=excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(${pk}) DO UPDATE SET ${updates}`;
  sqlite.prepare(sql).run(row);
}

function patchRow(table, pk, id, updates) {
  const row = serialize(table, updates);
  const cols = Object.keys(row).filter(c => c !== pk);
  if (cols.length === 0) return;
  const setClause = cols.map(c => `${c}=@${c}`).join(', ');
  sqlite.prepare(`UPDATE ${table} SET ${setClause} WHERE ${pk}=@__id`).run({ ...row, __id: id });
}

const db = {
  raw: sqlite,

  // ─── MONITORS ───
  monitors: () => sqlite.prepare('SELECT * FROM monitors').all().map(r => parseRow('monitors', r)),
  getMonitor: (id) => parseRow('monitors', sqlite.prepare('SELECT * FROM monitors WHERE id=?').get(id)),
  insertMonitor: (m) => upsert('monitors', 'id', m),
  updateMonitor: (id, updates) => patchRow('monitors', 'id', id, updates),
  deleteMonitor: (id) => sqlite.prepare('DELETE FROM monitors WHERE id=?').run(id),

  // ─── SCANS ───
  scans: () => sqlite.prepare('SELECT * FROM scans ORDER BY COALESCE(startedAt, queuedAt) DESC').all(),
  getScan: (id) => sqlite.prepare('SELECT * FROM scans WHERE id=?').get(id),
  getScanByToken: (token) => token ? sqlite.prepare('SELECT * FROM scans WHERE shareToken=?').get(token) : undefined,
  insertScan: (s) => upsert('scans', 'id', s),
  updateScan: (id, updates) => patchRow('scans', 'id', id, updates),
  deleteScansByMonitor: (monitorId) => sqlite.prepare('DELETE FROM scans WHERE monitorId=?').run(monitorId),

  // ─── FINDINGS ───
  findings: () => sqlite.prepare('SELECT * FROM findings').all().map(r => parseRow('findings', r)),
  findingsByScan: (scanId) =>
    sqlite.prepare('SELECT * FROM findings WHERE scanId=?').all(scanId).map(r => parseRow('findings', r)),
  insertFindings: (arr) => {
    if (!arr || !arr.length) return;
    const insert = sqlite.prepare(`INSERT INTO findings
      (id, scanId, templateId, name, severity, host, matchedAt, description, remediation, reference, tags, cvss, cve, extracted, curl, request, response, createdAt)
      VALUES (@id, @scanId, @templateId, @name, @severity, @host, @matchedAt, @description, @remediation, @reference, @tags, @cvss, @cve, @extracted, @curl, @request, @response, @createdAt)`);
    const tx = sqlite.transaction((rows) => {
      for (const f of rows) {
        insert.run(serialize('findings', {
          description: null, remediation: null, reference: [], tags: [], cvss: null,
          cve: null, extracted: null, curl: null, request: null, response: null,
          createdAt: new Date().toISOString(), ...f,
        }));
      }
    });
    tx(arr);
  },
  deleteFindingsByScan: (scanId) => sqlite.prepare('DELETE FROM findings WHERE scanId=?').run(scanId),

  // ─── CHANNELS ───
  channels: () => sqlite.prepare('SELECT * FROM channels').all().map(r => parseRow('channels', r)),
  getChannel: (id) => parseRow('channels', sqlite.prepare('SELECT * FROM channels WHERE id=?').get(id)),
  saveChannels: (arr) => {
    const tx = sqlite.transaction((rows) => { rows.forEach(c => upsert('channels', 'id', c)); });
    tx(arr);
  },
  updateChannel: (id, updates) => patchRow('channels', 'id', id, updates),

  // ─── SETTINGS (stored as key/value rows, exposed as one object) ───
  settings: () => {
    const rows = sqlite.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const { key, value } of rows) {
      try { out[key] = JSON.parse(value); } catch { out[key] = value; }
    }
    return out;
  },
  saveSettings: (obj) => {
    const stmt = sqlite.prepare(`INSERT INTO settings (key, value) VALUES (@key, @value)
                                 ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const tx = sqlite.transaction((entries) => {
      for (const [key, value] of entries) stmt.run({ key, value: JSON.stringify(value) });
    });
    tx(Object.entries(obj));
  },
};

// ─── Seed defaults ───
if (db.channels().length === 0) {
  db.saveChannels([
    { id: 'ch-email', type: 'email', name: 'Email', enabled: true, config: { address: '' }, connected: false },
    { id: 'ch-slack', type: 'slack', name: 'Slack', enabled: false, config: { webhook: '', channel: '' }, connected: false },
    { id: 'ch-telegram', type: 'telegram', name: 'Telegram', enabled: false, config: { botToken: '', chatId: '' }, connected: false },
    { id: 'ch-discord', type: 'discord', name: 'Discord', enabled: false, config: { webhook: '', username: 'Sentinel' }, connected: false },
    { id: 'ch-webhook', type: 'webhook', name: 'Webhook', enabled: false, config: { url: '', method: 'POST' }, connected: false },
  ]);
}

if (Object.keys(db.settings()).length === 0) {
  db.saveSettings({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    autoDetectTimezone: true,
    dateFormat: 'MMM dd, yyyy',
    defaultRateLimit: 150,
    defaultTimeout: 30,
    defaultSeverityThreshold: 'low',
    concurrentScansLimit: 5,
    scanTimeoutMinutes: 30,
    templatesPath: '~/.nuclei-templates',
  });
}

module.exports = db;
