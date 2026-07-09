// Standalone, self-contained HTML report for public share links (/r/:token).
// No auth, no external assets — safe to open from a Telegram/Slack link.

const SEV = {
  critical: { label: 'Critical', color: '#DC2626' },
  high: { label: 'High', color: '#EF4444' },
  medium: { label: 'Medium', color: '#F59E0B' },
  low: { label: 'Low', color: '#10B981' },
  info: { label: 'Info', color: '#3B82F6' },
};
const ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDuration(ms) {
  if (!ms) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function findingCard(f) {
  const c = SEV[f.severity]?.color || '#6B7280';
  const tags = (Array.isArray(f.tags) ? f.tags : []).slice(0, 10)
    .map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const refs = (Array.isArray(f.reference) ? f.reference : [])
    .map(r => `<a href="${esc(r)}" target="_blank" rel="noreferrer noopener">${esc(r)}</a>`).join('');
  return `
  <div class="finding" style="border-left-color:${c}">
    <div class="finding-head">
      <span class="tpl">${esc(f.templateId)}</span>
      <span class="sev" style="background:${c}22;color:${c}">${esc(SEV[f.severity]?.label || f.severity)}</span>
      ${f.cve ? `<span class="chip cve">${esc(f.cve)}</span>` : ''}
      ${f.cvss != null ? `<span class="chip cvss">CVSS ${esc(f.cvss)}</span>` : ''}
    </div>
    <h3>${esc(f.name)}</h3>
    <div class="matched">${esc(f.matchedAt || f.host || '')}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${f.extracted ? `<div class="extracted">${esc(f.extracted)}</div>` : ''}
    ${f.description ? `<div class="block"><span class="lbl">Description</span><p>${esc(f.description)}</p></div>` : ''}
    ${f.remediation ? `<div class="block"><span class="lbl">Remediation</span><p>${esc(f.remediation)}</p></div>` : ''}
    ${refs ? `<div class="block"><span class="lbl">References</span><div class="refs">${refs}</div></div>` : ''}
    ${f.curl ? `<div class="block"><span class="lbl">cURL</span><pre>${esc(f.curl)}</pre></div>` : ''}
  </div>`;
}

function renderReportHtml(scan, findings, monitor) {
  const counts = ORDER.reduce((a, s) => (a[s] = findings.filter(f => f.severity === s).length, a), {});
  const total = findings.length;
  const target = scan.target || (monitor && monitor.url) || '';
  const when = scan.startedAt || scan.queuedAt || '';
  const dateStr = when ? new Date(when).toUTCString() : '';

  // Distribution bar
  const bar = ORDER.filter(s => counts[s] > 0).map(s =>
    `<div style="width:${(counts[s] / total) * 100}%;background:${SEV[s].color}" title="${SEV[s].label}: ${counts[s]}"></div>`).join('');
  const legend = ORDER.filter(s => counts[s] > 0).map(s =>
    `<span class="leg"><i style="background:${SEV[s].color}"></i>${SEV[s].label} ${counts[s]}</span>`).join('');

  // Findings sorted by severity
  const sorted = [...findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const body = total
    ? sorted.map(findingCard).join('')
    : `<div class="empty">✓ No vulnerabilities found in this scan.</div>`;

  const ogDesc = total
    ? `${total} findings — ` + ORDER.filter(s => counts[s] > 0).map(s => `${counts[s]} ${s}`).join(', ')
    : 'No vulnerabilities found';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Sentinel Report — ${esc(target)}</title>
<meta property="og:type" content="website"/>
<meta property="og:title" content="Sentinel Report — ${esc(target)}"/>
<meta property="og:description" content="${esc(ogDesc)}"/>
<meta name="description" content="${esc(ogDesc)}"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🛡️%3C/text%3E%3C/svg%3E"/>
<style>
  :root{--bg:#0D0E12;--bg2:#16171D;--bg3:#1E1F26;--bd:#2A2B35;--tx:#E5E7EB;--tx2:#9CA3AF;--tx3:#6B7280;--cyan:#00D4AA}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:32px 20px 60px}
  .brand{display:flex;align-items:center;gap:8px;color:var(--tx2);font-size:13px;margin-bottom:20px}
  .brand b{color:var(--tx);font-weight:700}
  .card{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:22px;margin-bottom:20px}
  h1{font:600 20px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0 0 10px;word-break:break-all}
  .meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .pill{font-size:12px;padding:3px 9px;border-radius:6px;background:var(--bg3);color:var(--tx2)}
  .pill.ok{color:#10B981} .pill.count{background:rgba(0,212,170,.12);color:var(--cyan);font-weight:600}
  .barwrap{height:10px;border-radius:6px;overflow:hidden;background:var(--bg3);display:flex;margin:18px 0 10px}
  .barwrap div{transition:none}
  .legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--tx2);font-size:12px}
  .leg{display:flex;align-items:center;gap:6px} .leg i{width:9px;height:9px;border-radius:50%;display:inline-block}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--tx3);margin:26px 2px 12px}
  .finding{background:var(--bg2);border:1px solid var(--bd);border-left:3px solid;border-radius:10px;padding:16px 18px;margin-bottom:12px}
  .finding-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px}
  .tpl{font:12px ui-monospace,monospace;color:#3B82F6}
  .sev{font-size:11px;font-weight:600;padding:2px 8px;border-radius:5px}
  .chip{font:10px ui-monospace,monospace;padding:2px 6px;border-radius:5px}
  .chip.cve{background:rgba(59,130,246,.15);color:#3B82F6} .chip.cvss{background:rgba(245,158,11,.15);color:#F59E0B}
  .finding h3{font-size:14px;margin:2px 0 4px}
  .matched{font:12px ui-monospace,monospace;color:var(--tx2);word-break:break-all}
  .tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
  .tag{font-size:10px;padding:2px 7px;border-radius:5px;background:var(--bg3);color:var(--tx3)}
  .extracted{font:12px ui-monospace,monospace;color:var(--tx3);background:var(--bg3);padding:8px 10px;border-radius:6px;margin-top:8px;word-break:break-all}
  .block{margin-top:10px} .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--tx3);display:block;margin-bottom:3px}
  .block p{margin:0;color:var(--tx2)} .refs a{display:block;font:12px ui-monospace,monospace;color:#3B82F6;text-decoration:none;word-break:break-all}
  .refs a:hover{text-decoration:underline}
  pre{background:var(--bg3);padding:10px;border-radius:6px;overflow-x:auto;font:12px ui-monospace,monospace;color:var(--tx2);margin:0}
  .empty{text-align:center;color:#10B981;padding:40px 0;font-size:15px}
  .foot{text-align:center;color:var(--tx3);font-size:12px;margin-top:30px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">🛡️ <b>Sentinel</b> · Security Report</div>
    <div class="card">
      <h1>${esc(target)}</h1>
      <div class="meta">
        ${dateStr ? `<span class="pill">${esc(dateStr)}</span>` : ''}
        <span class="pill ${scan.status === 'completed' ? 'ok' : ''}">${esc(scan.status)}</span>
        <span class="pill">${esc(fmtDuration(scan.duration))}</span>
        ${scan.templates ? `<span class="pill">${esc(scan.templates)}</span>` : ''}
        <span class="pill count">${total} findings</span>
      </div>
      ${total ? `<div class="barwrap">${bar}</div><div class="legend">${legend}</div>` : ''}
    </div>

    <h2>Findings${total ? ` (${total})` : ''}</h2>
    ${body}

    <div class="foot">Generated by Sentinel · ${esc(new Date().toUTCString())}</div>
  </div>
</body>
</html>`;
}

module.exports = { renderReportHtml };
