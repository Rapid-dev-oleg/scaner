// Scan engine: queue with a concurrency limit, cancellable processes,
// live terminal streaming (SSE) and rich Nuclei output parsing.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./db');
const { sendNotifications } = require('./notifications');
const { templatesDir } = require('./templates');

function reportUrlFor(token) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return base && token ? `${base}/r/${token}` : null;
}

const generateId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

// nuclei tag aliases for our category ids
const TAG_MAP = {
  cve: 'cve',
  misconfiguration: 'misconfig',
  'exposed-panels': 'panel',
  'subdomain-takeover': 'takeover',
  'ssl-tls': 'ssl',
  technologies: 'tech',
  dns: 'dns',
  headless: 'headless',
};

// ─── Live event bus (consumed by the SSE endpoint) ───
const bus = new EventEmitter();
bus.setMaxListeners(0);

// ─── Runtime state ───
const running = new Map();   // scanId -> { proc, kind: 'nuclei'|'mock', cancel }
const queue = [];            // scanId[] waiting to start

function maxConcurrent() {
  const n = Number(db.settings().concurrentScansLimit);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function templatesLabel(monitor) {
  return monitor.templateMode === 'all'
    ? 'All Templates'
    : (monitor.templateCategories || []).join(', ') || 'Custom';
}

// ─── Public: enqueue a scan ───
function enqueueScan(monitor, { scheduled = false } = {}) {
  const scanId = generateId('scan');
  const scan = {
    id: scanId,
    monitorId: monitor.id,
    target: monitor.url,
    templates: templatesLabel(monitor),
    duration: 0,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    terminalOutput: `[INF] ${scheduled ? 'Scheduled scan' : 'Scan'} queued for ${monitor.url}\n`,
    error: null,
    shareToken: crypto.randomBytes(16).toString('hex'),
  };
  db.insertScan(scan);
  emit(scanId, { type: 'status', status: 'queued' });
  pump();
  return scanId;
}

// ─── Public: stop a running or queued scan ───
function stopScan(scanId) {
  const qi = queue.indexOf(scanId);
  if (qi !== -1) {
    queue.splice(qi, 1);
    markCancelled(scanId, '[INF] Scan cancelled while queued');
    return true;
  }
  const active = running.get(scanId);
  if (active) {
    active.cancelled = true;
    if (active.cancel) active.cancel();          // mock timers
    if (active.proc) { try { active.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    return true;
  }
  return false;
}

function queueState() {
  return { running: [...running.keys()], queued: [...queue], maxConcurrent: maxConcurrent() };
}

// ─── SSE helpers ───
function emit(scanId, payload) {
  bus.emit(scanId, payload);
}
function subscribe(scanId, listener) {
  bus.on(scanId, listener);
  return () => bus.off(scanId, listener);
}

// ─── Scheduler pump: promote queued scans up to the concurrency limit ───
function pump() {
  // include any queued scans that aren't tracked locally yet (e.g. after a restart)
  const queuedInDb = db.scans()
    .filter(s => s.status === 'queued' && !queue.includes(s.id) && !running.has(s.id))
    .sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
  for (const s of queuedInDb) queue.push(s.id);

  while (running.size < maxConcurrent() && queue.length > 0) {
    const scanId = queue.shift();
    if (scanId) startScan(scanId);
  }
}

function startScan(scanId) {
  const scan = db.getScan(scanId);
  if (!scan || scan.status !== 'queued') return;
  const monitor = db.getMonitor(scan.monitorId);
  if (!monitor) { markCancelled(scanId, '[ERR] Monitor no longer exists'); return; }

  db.updateScan(scanId, { status: 'running', startedAt: new Date().toISOString() });
  db.updateMonitor(monitor.id, { status: 'scanning' });
  emit(scanId, { type: 'status', status: 'running' });

  runNuclei(scanId, monitor);
}

// ─── Terminal buffering ───
function makeTerminal(scanId, initial = []) {
  const lines = [...initial];
  let saveTimer = null;
  const flush = () => { db.updateScan(scanId, { terminalOutput: lines.join('\n') }); };
  if (initial.length) flush(); // persist the starting lines immediately
  return {
    lines,
    push(line) {
      lines.push(line);
      emit(scanId, { type: 'line', line });
      if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 400);
    },
    flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } flush(); },
  };
}

// ─── Scan runner: optional katana crawl → nuclei (falls back to mock if nuclei absent) ───
function runNuclei(scanId, monitor) {
  const adv = monitor.advanced || {};
  const term = makeTerminal(scanId, [`[INF] Scanning ${monitor.url}...`]);
  const start = Date.now();
  const findings = [];
  let started = false;
  let settled = false; // guards against 'error' and 'close' both finalizing

  const state = { proc: null, cancelled: false, timedOut: false, killTimer: null };
  running.set(scanId, state);

  // Whole-scan timeout (covers crawl + nuclei). Kills whatever process is current.
  const timeoutMin = Number(db.settings().scanTimeoutMinutes);
  if (Number.isFinite(timeoutMin) && timeoutMin > 0) {
    state.killTimer = setTimeout(() => {
      state.timedOut = true;
      term.push(`[ERR] Scan timed out after ${timeoutMin} min — stopping`);
      if (state.proc) { try { state.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    }, timeoutMin * 60000);
  }

  // ── shared progress/stats helpers ──
  const asStats = (t) => {
    if (!t.startsWith('{') || t.indexOf('"percent"') === -1) return null;
    try {
      const p = JSON.parse(t);
      if (p && p.percent !== undefined && p.total !== undefined && p.info === undefined) return p;
    } catch { /* not json */ }
    return null;
  };
  const clampNum = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
  };
  const emitProgress = (p) => {
    const total = clampNum(p.total, 1e9);
    const progress = {
      percent: total > 0 ? clampNum(p.percent, 100) : 0,
      requests: clampNum(p.requests, 1e9),
      total,
      rps: clampNum(p.rps, 1e6),
      matched: clampNum(p.matched, 1e9),
      errors: clampNum(p.errors, 1e9),
      duration: p.duration || '',
      phase: 'scan',
    };
    db.updateScan(scanId, { progress: JSON.stringify(progress) });
    emit(scanId, { type: 'progress', progress });
  };

  // ── template + common nuclei args (target added per-run) ──
  const commonArgs = ['-rl', String(adv.rateLimit || 150), '-timeout', String(adv.timeout || 30), '-j', '-stats', '-si', '5'];
  if (monitor.templateMode === 'categories' && monitor.templateCategories?.length) {
    commonArgs.push('-tags', monitor.templateCategories.map(c => TAG_MAP[c] || c).join(','));
  }
  if (monitor.templateMode === 'custom' && monitor.customTemplates?.length) {
    const dir = templatesDir();
    for (const raw of monitor.customTemplates) {
      const val = String(raw).trim();
      if (!val) continue;
      const rel = /\.ya?ml$/.test(val) ? val : `${val}.yaml`;
      const full = dir ? path.join(dir, rel) : null;
      if (full && fs.existsSync(full)) commonArgs.push('-t', full);
      else commonArgs.push('-id', val.replace(/\.ya?ml$/, ''));
    }
  }
  if (adv.userAgent) commonArgs.push('-H', `User-Agent: ${adv.userAgent}`);
  if (adv.followRedirects === false) commonArgs.push('-no-redirects');

  // ── nuclei phase ──
  const startNuclei = (targetArgs) => {
    const args = [...targetArgs, ...commonArgs];
    term.push(`[INF] nuclei ${args.join(' ')}`);

    let proc;
    try {
      proc = spawn('nuclei', args, { shell: false });
    } catch {
      if (state.killTimer) clearTimeout(state.killTimer);
      running.delete(scanId);
      return runMockScan(scanId, monitor);
    }
    state.proc = proc;

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      if (state.killTimer) clearTimeout(state.killTimer);
      running.delete(scanId);
      if (state.cancelled) return finalize(scanId, Date.now() - start, 'cancelled', term, findings, monitor);
      return runMockScan(scanId, monitor);
    });

    const handleLine = (line, isStdout) => {
      const t = line.trim();
      if (!t) return;
      const st = asStats(t);
      if (st) { emitProgress(st); return; }
      if (isStdout) {
        const finding = parseNucleiLine(t, scanId, monitor);
        if (finding) {
          findings.push(finding);
          term.push(`[${String(findings.length).padStart(3, '0')}] ${finding.host} [${finding.severity}] ${finding.name}`);
          return;
        }
      }
      term.push(t);
    };

    let stdoutBuf = '';
    proc.stdout.on('data', (data) => {
      started = true;
      stdoutBuf += data.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) { handleLine(stdoutBuf.slice(0, nl), true); stdoutBuf = stdoutBuf.slice(nl + 1); }
    });
    let stderrBuf = '';
    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) { handleLine(stderrBuf.slice(0, nl), false); stderrBuf = stderrBuf.slice(nl + 1); }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (state.killTimer) clearTimeout(state.killTimer);
      running.delete(scanId);
      const duration = Date.now() - start;
      if (state.cancelled) {
        term.push(`[INF] Scan cancelled after ${(duration / 1000).toFixed(1)}s`);
        finalize(scanId, duration, 'cancelled', term, findings, monitor);
      } else if (state.timedOut) {
        term.push(`[INF] Stopped by timeout after ${(duration / 1000).toFixed(1)}s (${findings.length} findings kept)`);
        finalize(scanId, duration, 'failed', term, findings, monitor);
      } else if (!started && code !== 0) {
        if (term.lines.some(l => l.includes('no templates provided'))) {
          term.push('[ERR] The selected templates matched nothing. Pick a category, "All templates", or valid custom templates.');
        } else {
          term.push(`[ERR] Nuclei exited with code ${code}`);
        }
        finalize(scanId, duration, 'failed', term, findings, monitor);
      } else {
        term.push(`[INF] Scan ${code === 0 ? 'completed' : 'finished'} in ${(duration / 1000).toFixed(1)}s (${findings.length} findings)`);
        finalize(scanId, duration, 'completed', term, findings, monitor);
      }
      pump();
    });
  };

  // ── crawl phase (opt-in): katana discovers URLs, then nuclei scans them all ──
  const startCrawl = (cb) => {
    const depth = Math.max(1, Math.min(5, Number(adv.crawlDepth) || 2));
    const outFile = path.join(os.tmpdir(), `sentinel-crawl-${scanId}.txt`);
    const kargs = ['-u', monitor.url, '-d', String(depth), '-silent', '-fs', 'fqdn', '-timeout', String(adv.timeout || 15)];
    if (adv.userAgent) kargs.push('-H', `User-Agent: ${adv.userAgent}`);
    term.push(`[INF] Crawling ${monitor.url} (depth ${depth})...`);

    let proc;
    try {
      proc = spawn('katana', kargs, { shell: false });
    } catch {
      term.push('[INF] katana not available — scanning base URL only');
      return cb(['-u', monitor.url]);
    }
    state.proc = proc;

    const urls = new Set([monitor.url]);
    let buf = '';
    const tick = setInterval(() => emit(scanId, {
      type: 'progress',
      progress: { phase: 'crawl', percent: 0, requests: urls.size, total: 0, rps: 0, matched: 0, errors: 0, duration: '' },
    }), 1000);

    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const u = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (/^https?:\/\//i.test(u) && !urls.has(u)) {
          urls.add(u);
          if (urls.size % 25 === 0) term.push(`[INF] Crawled ${urls.size} URLs...`);
        }
      }
    });
    proc.stderr.on('data', () => { /* katana progress noise ignored */ });
    proc.on('error', () => { clearInterval(tick); term.push('[INF] katana not available — scanning base URL only'); cb(['-u', monitor.url]); });
    proc.on('close', () => {
      clearInterval(tick);
      if (settled) return;
      if (state.cancelled || state.timedOut) {
        settled = true;
        if (state.killTimer) clearTimeout(state.killTimer);
        running.delete(scanId);
        term.push(state.cancelled ? '[INF] Cancelled during crawl' : '[INF] Stopped by timeout during crawl');
        finalize(scanId, Date.now() - start, state.cancelled ? 'cancelled' : 'failed', term, [], monitor);
        pump();
        return;
      }
      if (urls.size > 1) {
        try { fs.writeFileSync(outFile, [...urls].join('\n')); term.push(`[INF] Crawl complete: ${urls.size} URLs → scanning all`); return cb(['-l', outFile]); }
        catch { /* fall through to base url */ }
      }
      term.push(`[INF] Crawl found ${urls.size} URL(s) — scanning base URL`);
      cb(['-u', monitor.url]);
    });
  };

  if (adv.crawl) startCrawl(startNuclei);
  else startNuclei(['-u', monitor.url]);
}

// ─── Parse one JSONL line from `nuclei -j` into our finding shape ───
function parseNucleiLine(line, scanId, monitor) {
  let p;
  try { p = JSON.parse(line); } catch { return null; }
  const info = p.info || {};
  const severity = ['info', 'low', 'medium', 'high', 'critical'].includes(info.severity) ? info.severity : 'info';
  const classification = info.classification || {};
  const cvss = typeof classification['cvss-score'] === 'number' ? classification['cvss-score'] : null;
  const cveId = Array.isArray(classification['cve-id']) ? classification['cve-id'][0]
    : (p['extracted-results'] || []).find(r => /CVE-/.test(r)) || null;

  return {
    id: generateId('f'),
    scanId,
    templateId: p['template-id'] || p.template || 'unknown',
    name: info.name || 'Unknown',
    severity,
    host: p.host || monitor.url,
    matchedAt: p['matched-at'] || p.host || monitor.url,
    description: info.description || null,
    remediation: info.remediation || null,
    reference: Array.isArray(info.reference) ? info.reference : (info.reference ? [info.reference] : []),
    tags: Array.isArray(info.tags) ? info.tags : (typeof info.tags === 'string' ? info.tags.split(',') : []),
    cvss,
    cve: cveId,
    extracted: (p['extracted-results'] || []).join(', ') || null,
    curl: p.curl_command || null,
    request: p.request || null,
    response: p.response || null,
  };
}

// ─── Mock scan (used when the nuclei binary is not available) ───
function runMockScan(scanId, monitor) {
  const TEMPLATES = [
    { id: 'CVE-2024-1234', name: 'Remote Code Execution', severity: 'critical', remediation: 'Upgrade to the patched version and restrict network access.' },
    { id: 'wp-login', name: 'WordPress Login Panel Exposed', severity: 'medium', remediation: 'Restrict /wp-login.php by IP or add basic auth.' },
    { id: 'nginx-version', name: 'Nginx Version Disclosure', severity: 'low', remediation: 'Set server_tokens off; in the nginx config.' },
    { id: 'cors-misconfig', name: 'CORS Misconfiguration', severity: 'medium', remediation: 'Do not reflect arbitrary Origin; use an allow-list.' },
    { id: 'xss-reflected', name: 'Reflected XSS in Search Parameter', severity: 'high', remediation: 'Encode output and validate input.' },
    { id: 'info-leak', name: 'Information Disclosure via Headers', severity: 'info', remediation: 'Remove verbose response headers.' },
    { id: 'ssl-expired', name: 'SSL Certificate Expired', severity: 'high', remediation: 'Renew the TLS certificate.' },
    { id: 'directory-listing', name: 'Directory Listing Enabled', severity: 'low', remediation: 'Disable autoindex on the web server.' },
  ];

  const start = Date.now();
  const count = Math.floor(Math.random() * 5);
  const picked = [...TEMPLATES].sort(() => 0.5 - Math.random()).slice(0, count);
  const findings = picked.map(t => ({
    id: generateId('f'), scanId,
    templateId: t.id, name: t.name, severity: t.severity,
    host: monitor.url, matchedAt: monitor.url + '/',
    description: `Mock finding — ${t.name}. Install the nuclei CLI for real scans.`,
    remediation: t.remediation, reference: [], tags: ['mock'], cvss: null,
    cve: t.severity === 'critical' ? 'CVE-2024-' + Math.floor(1000 + Math.random() * 9000) : null,
    extracted: null, curl: null, request: null, response: null,
  }));

  const outLines = [
    `[INF] Nuclei Engine v3.11.0 (mock mode — nuclei CLI not found)`,
    `[INF] Templates loaded: ${monitor.templateMode === 'all' ? '8432' : '124'}`,
    `[INF] Executing workflows...`,
    ...findings.map((f, i) => `[${String(i + 1).padStart(3, '0')}] ${monitor.url} [${f.severity}] ${f.name}`),
    `[INF] Scan completed with ${findings.length} findings (mock)`,
  ];

  const term = makeTerminal(scanId, []);
  const state = { proc: null, cancelled: false, cancel: null };
  running.set(scanId, state);

  let i = 0;
  const interval = setInterval(() => {
    if (state.cancelled) return;
    if (i < outLines.length) { term.push(outLines[i]); i++; return; }
    clearInterval(interval);
    running.delete(scanId);
    finalize(scanId, Date.now() - start, 'completed', term, findings, monitor);
    pump();
  }, 250);

  state.cancel = () => {
    clearInterval(interval);
    running.delete(scanId);
    term.push('[INF] Scan cancelled');
    finalize(scanId, Date.now() - start, 'cancelled', term, [], monitor);
    pump();
  };
}

// ─── Persist results + update monitor + notify ───
function finalize(scanId, duration, status, term, findings, monitor) {
  term.flush();
  const keep = status === 'cancelled' ? [] : findings;
  db.updateScan(scanId, {
    duration: Math.round(duration),
    status,
    completedAt: new Date().toISOString(),
    terminalOutput: term.lines.join('\n'),
  });
  if (keep.length) db.insertFindings(keep);

  const counts = keep.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }),
    { info: 0, low: 0, medium: 0, high: 0, critical: 0 });

  // restore monitor status (respect paused monitors)
  const fresh = db.getMonitor(monitor.id);
  const nextStatus = fresh && fresh.status === 'paused' ? 'paused' : 'active';
  const patch = { status: nextStatus, lastScanAt: new Date().toISOString() };
  if (status === 'completed') patch.findingCounts = counts;
  db.updateMonitor(monitor.id, patch);

  emit(scanId, { type: 'done', status, findings: keep.length });

  if (status === 'completed') {
    const token = db.getScan(scanId)?.shareToken;
    sendNotifications(keep, monitor, reportUrlFor(token))
      .catch(err => console.error('[Scan] Notifications failed:', err.message || err));
  }
  console.log(`[Scan] ${scanId} ${status} — ${keep.length} findings for ${monitor.url}`);
}

function markCancelled(scanId, message) {
  const scan = db.getScan(scanId);
  const term = (scan?.terminalOutput || '') + '\n' + message;
  db.updateScan(scanId, { status: 'cancelled', completedAt: new Date().toISOString(), terminalOutput: term.trim() });
  const scanRow = db.getScan(scanId);
  if (scanRow) {
    const m = db.getMonitor(scanRow.monitorId);
    if (m && m.status === 'scanning') db.updateMonitor(m.id, { status: 'active' });
  }
  emit(scanId, { type: 'done', status: 'cancelled', findings: 0 });
}

// On boot, re-queue anything that was left running/queued after a restart.
function recoverOnBoot() {
  const stuck = db.scans().filter(s => s.status === 'running' || s.status === 'queued');
  for (const s of stuck) db.updateScan(s.id, { status: 'queued' });
  db.monitors().filter(m => m.status === 'scanning').forEach(m => db.updateMonitor(m.id, { status: 'active' }));
  pump();
}

module.exports = { enqueueScan, stopScan, queueState, subscribe, recoverOnBoot, TAG_MAP };
