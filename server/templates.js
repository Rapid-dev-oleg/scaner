// Nuclei template catalog: reads the local templates directory for real
// counts + search, and can trigger `nuclei -update-templates`.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Canonical categories shown in the UI, mapped to nuclei tags / template dirs.
const CATEGORIES = [
  { id: 'cve', label: 'CVEs', icon: 'shield-alert', dirs: ['http/cves', 'cves'] },
  { id: 'misconfiguration', label: 'Misconfigurations', icon: 'settings', dirs: ['http/misconfiguration', 'misconfiguration'] },
  { id: 'exposed-panels', label: 'Exposed Panels', icon: 'layout', dirs: ['http/exposed-panels', 'exposed-panels'] },
  { id: 'subdomain-takeover', label: 'Subdomain Takeover', icon: 'globe', dirs: ['http/takeovers', 'takeovers'] },
  { id: 'ssl-tls', label: 'SSL/TLS Issues', icon: 'lock', dirs: ['ssl'] },
  { id: 'technologies', label: 'Technologies', icon: 'cpu', dirs: ['http/technologies', 'technologies'] },
  { id: 'dns', label: 'DNS Issues', icon: 'globe', dirs: ['dns'] },
  { id: 'exposures', label: 'Exposures', icon: 'eye', dirs: ['http/exposures', 'exposures'] },
];

// Fallback counts (approximate) used when the templates directory is absent.
const FALLBACK_COUNTS = {
  cve: 4500, misconfiguration: 1200, 'exposed-panels': 900, 'subdomain-takeover': 100,
  'ssl-tls': 60, technologies: 1500, dns: 150, exposures: 800,
};

function templatesDir() {
  const custom = process.env.NUCLEI_TEMPLATES;
  if (custom && fs.existsSync(custom)) return custom;
  const home = path.join(os.homedir(), 'nuclei-templates');
  if (fs.existsSync(home)) return home;
  const root = '/root/nuclei-templates';
  if (fs.existsSync(root)) return root;
  return null;
}

function countYaml(dir) {
  let n = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) n++;
    }
  }
  return n;
}

let _cache = null;
function getCategories({ refresh = false } = {}) {
  if (_cache && !refresh) return _cache;
  const base = templatesDir();
  const installed = !!base;
  const cats = CATEGORIES.map(c => {
    let count = FALLBACK_COUNTS[c.id] || 0;
    if (base) {
      const found = c.dirs.map(d => path.join(base, d)).find(p => fs.existsSync(p));
      count = found ? countYaml(found) : 0;
    }
    return { id: c.id, label: c.label, icon: c.icon, count };
  });
  _cache = { installed, dir: base, categories: cats };
  return _cache;
}

// Search template ids by substring across the templates dir (capped).
function searchTemplates(query, limit = 50) {
  const base = templatesDir();
  if (!base) return { installed: false, results: [] };
  const q = (query || '').toLowerCase();
  const results = [];
  const stack = [base];
  while (stack.length && results.length < limit) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (results.length >= limit) break;
      const full = path.join(cur, e.name);
      // workflows/ aren't individual templates and can't be run via -id/-t here
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'workflows') stack.push(full); }
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) {
        const id = e.name.replace(/\.ya?ml$/, '');
        const rel = path.relative(base, full);
        if (!q || id.toLowerCase().includes(q) || rel.toLowerCase().includes(q)) {
          results.push({ id, path: rel });
        }
      }
    }
  }
  return { installed: true, results };
}

let updating = false;
function updateTemplates() {
  return new Promise((resolve) => {
    if (updating) return resolve({ ok: false, output: 'Update already in progress' });
    updating = true;
    let output = '';
    let proc;
    try {
      proc = spawn('nuclei', ['-update-templates'], { shell: false });
    } catch (err) {
      updating = false;
      return resolve({ ok: false, output: 'nuclei CLI not found' });
    }
    proc.on('error', () => { updating = false; resolve({ ok: false, output: 'nuclei CLI not found' }); });
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', (code) => {
      updating = false;
      _cache = null; // invalidate counts
      resolve({ ok: code === 0, output: output.trim() || `nuclei exited with code ${code}` });
    });
  });
}

module.exports = { getCategories, searchTemplates, updateTemplates, templatesDir };
