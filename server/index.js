const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const scanner = require('./scanner');
const templates = require('./templates');
const { testChannel } = require('./notifications');
const { renderReportHtml } = require('./report');
const crypto = require('crypto');

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const app = express();
app.use(cors());
app.use(express.json());

const API_PORT = process.env.API_PORT || process.env.PORT || 3001;
const generateId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

// ─── AUTH ───
app.get('/api/auth/status', (req, res) => res.json({ authRequired: auth.enabled }));
app.post('/api/auth/login', (req, res) => {
  const { ok, token } = auth.login(req.body?.password);
  if (!ok) return res.status(401).json({ error: 'Invalid password' });
  res.json({ token });
});
app.post('/api/auth/logout', (req, res) => { auth.logout(auth.bearer(req)); res.json({ ok: true }); });

// Everything below /api (except public routes) requires a valid token.
app.use(auth.middleware);

// ─── MONITORS ───
app.get('/api/monitors', (req, res) => res.json(db.monitors()));

app.get('/api/monitors/:id', (req, res) => {
  const m = db.getMonitor(req.params.id);
  m ? res.json(m) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/monitors', (req, res) => {
  const monitor = {
    id: generateId('mon'),
    status: 'active',
    findingCounts: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    createdAt: new Date().toISOString(),
    lastScanAt: null,
    templateCategories: [],
    customTemplates: [],
    notifications: {},
    advanced: {},
    ...req.body,
  };
  db.insertMonitor(monitor);
  scheduleMonitor(monitor);
  res.status(201).json(monitor);
});

app.patch('/api/monitors/:id', (req, res) => {
  if (!db.getMonitor(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.updateMonitor(req.params.id, req.body);
  const updated = db.getMonitor(req.params.id);
  scheduleMonitor(updated);
  res.json(updated);
});

app.delete('/api/monitors/:id', (req, res) => {
  const scans = db.scans().filter(s => s.monitorId === req.params.id);
  scans.forEach(s => { scanner.stopScan(s.id); db.deleteFindingsByScan(s.id); });
  db.deleteScansByMonitor(req.params.id);
  db.deleteMonitor(req.params.id);
  unscheduleMonitor(req.params.id);
  res.json({ deleted: true });
});

// ─── SCANS ───
app.get('/api/scans', (req, res) => {
  const withFindings = db.scans().map(s => ({ ...s, findings: db.findingsByScan(s.id) }));
  res.json(withFindings);
});

app.get('/api/scans/queue', (req, res) => res.json(scanner.queueState()));

app.get('/api/scans/:id', (req, res) => {
  const scan = db.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  res.json({ ...scan, findings: db.findingsByScan(req.params.id) });
});

app.post('/api/scans', (req, res) => {
  const monitor = db.getMonitor(req.body.monitorId);
  if (!monitor) return res.status(404).json({ error: 'Monitor not found' });
  const scanId = scanner.enqueueScan(monitor);
  res.status(201).json({ id: scanId, status: 'queued' });
});

app.post('/api/scans/:id/stop', (req, res) => {
  const ok = scanner.stopScan(req.params.id);
  ok ? res.json({ stopped: true }) : res.status(404).json({ error: 'Scan not active' });
});

// Ensure (or return) a public share link for a scan
app.post('/api/scans/:id/share', (req, res) => {
  const scan = db.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  let token = scan.shareToken;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    db.updateScan(scan.id, { shareToken: token });
  }
  res.json({ token, url: `${publicBase(req)}/r/${token}` });
});

// Revoke a share link
app.delete('/api/scans/:id/share', (req, res) => {
  const scan = db.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  db.updateScan(scan.id, { shareToken: null });
  res.json({ revoked: true });
});

// ─── PUBLIC SHARED REPORT (no auth — unguessable token) ───
app.get('/api/public/report/:token', (req, res) => {
  const scan = db.getScanByToken(req.params.token);
  if (!scan) return res.status(404).json({ error: 'Not found' });
  const { terminalOutput, ...meta } = scan;
  res.json({ ...meta, findings: db.findingsByScan(scan.id) });
});

app.get('/r/:token', (req, res) => {
  const scan = db.getScanByToken(req.params.token);
  if (!scan) return res.status(404).type('html').send('<h1 style="font-family:sans-serif">Report not found or link revoked</h1>');
  const findings = db.findingsByScan(scan.id);
  const monitor = db.getMonitor(scan.monitorId);
  res.type('html').send(renderReportHtml(scan, findings, monitor));
});

// Live terminal stream (Server-Sent Events)
app.get('/api/scans/:id/stream', (req, res) => {
  const scan = db.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'init', terminalOutput: scan.terminalOutput || '', status: scan.status })}\n\n`);

  if (['completed', 'failed', 'cancelled'].includes(scan.status)) {
    res.write(`data: ${JSON.stringify({ type: 'done', status: scan.status })}\n\n`);
    return res.end();
  }
  const unsub = scanner.subscribe(req.params.id, (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (payload.type === 'done') { unsub(); clearInterval(ping); res.end(); }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); unsub(); });
});

// ─── TEMPLATES ───
app.get('/api/templates', (req, res) => res.json(templates.getCategories()));
app.get('/api/templates/search', (req, res) =>
  res.json(templates.searchTemplates(req.query.q || '', Number(req.query.limit) || 50)));
app.post('/api/templates/update', async (req, res) => res.json(await templates.updateTemplates()));

// ─── NOTIFICATIONS ───
app.get('/api/notifications/channels', (req, res) => res.json(db.channels()));

app.patch('/api/notifications/channels/:id', (req, res) => {
  if (!db.getChannel(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.updateChannel(req.params.id, req.body);
  res.json(db.getChannel(req.params.id));
});

app.post('/api/notifications/channels/:id/test', async (req, res) => {
  const ch = db.getChannel(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  try {
    const message = await testChannel(ch.type, ch.config || {});
    db.updateChannel(ch.id, { connected: true });
    res.json({ success: true, message });
  } catch (err) {
    db.updateChannel(ch.id, { connected: false });
    res.json({ success: false, message: err.message || 'Connection failed' });
  }
});

// ─── SETTINGS ───
app.get('/api/settings', (req, res) => res.json(db.settings()));
app.patch('/api/settings', (req, res) => {
  db.saveSettings({ ...db.settings(), ...req.body });
  res.json(db.settings());
});

// ─── EXPORT (real data snapshot, secrets omitted) ───
app.get('/api/export', (req, res) => {
  res.json({
    monitors: db.monitors(),
    scans: db.scans().map(s => ({ ...s, findings: db.findingsByScan(s.id) })),
    channels: db.channels().map(({ config, ...c }) => c),
    settings: db.settings(),
    exportedAt: new Date().toISOString(),
  });
});

// ─── HEALTH ───
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── SCHEDULER ───
const jobs = new Map();

function scheduleMonitor(monitor) {
  unscheduleMonitor(monitor.id);
  if (!monitor || monitor.status !== 'active') return;

  let expr;
  switch (monitor.schedule) {
    case 'hourly': expr = '0 * * * *'; break;
    case 'daily': expr = '0 0 * * *'; break;
    case 'weekly': expr = '0 0 * * 0'; break;
    case 'monthly': expr = '0 0 1 * *'; break;
    case 'custom': expr = monitor.cronExpression; break;
    default: expr = '0 0 * * *';
  }
  if (!expr || !cron.validate(expr)) return;

  const job = cron.schedule(expr, () => {
    const fresh = db.getMonitor(monitor.id);
    if (!fresh || fresh.status !== 'active') return;
    console.log(`[Cron] Auto-scan ${fresh.name || fresh.url}`);
    scanner.enqueueScan(fresh, { scheduled: true });
  });
  jobs.set(monitor.id, job);
}

function unscheduleMonitor(id) {
  const job = jobs.get(id);
  if (job) { job.stop(); jobs.delete(id); }
}

// Sync notification channel configs from environment variables
function syncChannelsFromEnv() {
  const envMappings = {
    'ch-email': { address: process.env.EMAIL_ADDRESS },
    'ch-slack': { webhook: process.env.SLACK_WEBHOOK },
    'ch-telegram': { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID },
    'ch-discord': { webhook: process.env.DISCORD_WEBHOOK },
    'ch-webhook': { url: process.env.WEBHOOK_URL, method: process.env.WEBHOOK_METHOD || 'POST' },
  };
  for (const ch of db.channels()) {
    const envConfig = envMappings[ch.id];
    if (!envConfig) continue;
    const config = { ...(ch.config || {}) };
    let changed = false;
    for (const [key, value] of Object.entries(envConfig)) {
      if (value && config[key] !== value) { config[key] = value; changed = true; }
    }
    if (changed) db.updateChannel(ch.id, { config });
  }
}

// ─── STARTUP ───
syncChannelsFromEnv();
db.monitors().filter(m => m.status === 'active').forEach(scheduleMonitor);
scanner.recoverOnBoot();

// Static frontend + SPA fallback (after API routes)
app.use(express.static(path.join(__dirname, '../dist')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(API_PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  Sentinel API — http://localhost:${API_PORT}       ║
╚══════════════════════════════════════════╝
  Auth: ${auth.enabled ? 'ENABLED (password)' : 'disabled (open)'}
  Monitors: ${db.monitors().length}  |  Scans: ${db.scans().length}
  `);
});
