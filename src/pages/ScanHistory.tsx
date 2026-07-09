import { useState, useEffect, useRef } from 'react';
import { Clock, Search, Filter, ExternalLink, Loader2, CheckCircle, XCircle, Square, Ban, Download, ChevronDown, Share2 } from 'lucide-react';
import TopBar from '@/components/TopBar';
import SeverityBadge from '@/components/SeverityBadge';
import { useMonitors } from '@/contexts/MonitorsContext';
import { useApp } from '@/contexts/AppContext';
import { api } from '@/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { format, subDays } from 'date-fns';
import type { Scan, Finding } from '@/types';

export default function ScanHistory() {
  const { scans, isLoading, stopScan } = useMonitors();
  const { addToast } = useApp();
  const [sharing, setSharing] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dateRange, setDateRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d');
  const [selectedScan, setSelectedScan] = useState<Scan | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Finding[]>([]);
  // Report severity filter — informational findings are hidden by default.
  const [hiddenSeverities, setHiddenSeverities] = useState<Set<string>>(new Set(['info']));
  const toggleSeverity = (sev: string) =>
    setHiddenSeverities(prev => {
      const next = new Set(prev);
      next.has(sev) ? next.delete(sev) : next.add(sev);
      return next;
    });

  const filtered = scans.filter(s => {
    const matchesSearch = !search || s.target.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
    const matchesDate = dateRange === 'all' || (() => {
      const d = new Date(s.startedAt || s.queuedAt || 0);
      if (dateRange === '24h') return d > subDays(new Date(), 1);
      if (dateRange === '7d') return d > subDays(new Date(), 7);
      if (dateRange === '30d') return d > subDays(new Date(), 30);
      return true;
    })();
    return matchesSearch && matchesStatus && matchesDate;
  });

  const formatDuration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'] as const;
  const SEVERITY_COLORS: Record<string, string> = { critical: '#DC2626', high: '#EF4444', medium: '#F59E0B', low: '#10B981', info: '#3B82F6' };

  // Report findings filtered by the active severities.
  const reportSevCounts = severityOrder.reduce((acc, s) => {
    acc[s] = selectedFindings.filter(f => f.severity === s).length;
    return acc;
  }, {} as Record<string, number>);
  const visibleFindings = selectedFindings.filter(f => !hiddenSeverities.has(f.severity));

  const openScan = async (scan: Scan) => {
    setSelectedScan(scan);
    setSelectedFindings(scan.findings || []);
    try {
      const data = await api.getScan(scan.id);
      setSelectedScan(data);
      setSelectedFindings(data.findings || []);
    } catch { /* keep what we have */ }
  };

  const shareReport = async () => {
    if (!selectedScan) return;
    setSharing(true);
    try {
      const { url } = await api.shareScan(selectedScan.id);
      const link = url || `${window.location.origin}/r/`;
      try { await navigator.clipboard.writeText(link); } catch { /* clipboard may be blocked */ }
      addToast({ type: 'success', title: 'Public link copied', message: link });
    } catch (err: any) {
      addToast({ type: 'alert', title: 'Share failed', message: err.message });
    } finally {
      setSharing(false);
    }
  };

  const exportScan = () => {
    if (!selectedScan) return;
    const data = { ...selectedScan, findings: selectedFindings };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scan-${selectedScan.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div>
        <TopBar title="Scan History" />
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin-slow" style={{ color: 'var(--accent-cyan)' }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <TopBar title="Scan History" />

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6 p-3 rounded-lg border" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
        <div className="relative flex-1 max-w-[280px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by target URL..."
            className="w-full h-8 pl-9 pr-3 rounded-md text-[12px] focus-ring outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
        </div>
        <div className="flex gap-1">
          {(['24h', '7d', '30d', 'all'] as const).map(range => (
            <button key={range} onClick={() => setDateRange(range)}
              className="h-8 px-3 rounded-md text-[11px] font-medium transition-all border focus-ring"
              style={{ backgroundColor: dateRange === range ? 'rgba(0,212,170,0.1)' : 'var(--bg-tertiary)', borderColor: dateRange === range ? 'var(--accent-cyan)' : 'var(--border-subtle)', color: dateRange === range ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>
              {range === 'all' ? 'All' : `Last ${range}`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Filter size={12} style={{ color: 'var(--text-muted)' }} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="h-8 px-2 rounded-md text-[12px] focus-ring cursor-pointer outline-none"
            style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
            <option value="all">All Status</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {filtered.length > 0 ? (
        <div className="rounded-lg border overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          <div className="grid grid-cols-[140px_1fr_140px_80px_140px_110px_130px] gap-4 px-4 h-9 items-center text-[11px] font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-tertiary)' }}>
            <span>Time</span><span>Target</span><span>Templates</span><span>Duration</span><span>Findings</span><span>Status</span><span className="text-right">Actions</span>
          </div>

          {filtered.map((scan, idx) => {
            const findingCounts = severityOrder.reduce((acc, sev) => {
              acc[sev] = scan.findings?.filter((f: Finding) => f.severity === sev).length || 0;
              return acc;
            }, {} as Record<string, number>);
            const isActive = scan.status === 'running' || scan.status === 'queued';

            return (
              <div key={scan.id}
                className="grid grid-cols-[140px_1fr_140px_80px_140px_110px_130px] gap-4 px-4 h-[52px] items-center transition-colors"
                style={{ borderBottom: '1px solid var(--border-subtle)', backgroundColor: idx % 2 === 0 ? 'var(--bg-secondary)' : 'var(--bg-primary)' }}>
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{format(new Date(scan.startedAt || scan.queuedAt || Date.now()), 'MMM dd, HH:mm')}</span>
                <span className="text-[12px] font-mono truncate" style={{ color: 'var(--text-primary)' }} title={scan.target}>{scan.target}</span>
                <span className="text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>{scan.templates}</span>
                <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{isActive ? '—' : formatDuration(scan.duration)}</span>
                <div className="flex flex-wrap gap-1">
                  {severityOrder.filter(s => findingCounts[s] > 0).map(sev => <SeverityBadge key={sev} severity={sev} count={findingCounts[sev]} />)}
                  {(!scan.findings || scan.findings.length === 0) && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>None</span>}
                </div>
                <StatusPill status={scan.status} />
                <div className="flex justify-end items-center gap-1">
                  {isActive && (
                    <button onClick={() => stopScan(scan.id)}
                      className="flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium transition-colors focus-ring"
                      style={{ color: 'var(--severity-high)' }}
                      onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}>
                      <Square size={11} /> Stop
                    </button>
                  )}
                  <button onClick={() => openScan(scan)}
                    className="flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium transition-colors focus-ring"
                    style={{ color: 'var(--accent-cyan)' }}
                    onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(0,212,170,0.1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}>
                    <ExternalLink size={11} /> Report
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20">
          <Clock size={48} style={{ color: 'var(--text-muted)' }} />
          <h3 className="text-[15px] font-semibold mt-4" style={{ color: 'var(--text-primary)' }}>No scans yet</h3>
          <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>Run a scan from the Monitors page to see results here</p>
        </div>
      )}

      {/* Report Modal */}
      <Dialog open={!!selectedScan} onOpenChange={() => setSelectedScan(null)}>
        <DialogContent className="max-w-[820px] max-h-[85vh] p-0 overflow-y-auto sentinel-scrollbar border flex flex-col gap-0" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          {selectedScan && (
            <>
              <DialogHeader className="px-6 py-4 border-b shrink-0 sticky top-0 z-20" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-secondary)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <DialogTitle className="text-[15px] font-mono font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{selectedScan.target}</DialogTitle>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{format(new Date(selectedScan.startedAt || selectedScan.queuedAt || Date.now()), 'MMM dd, yyyy HH:mm:ss')}</span>
                      <StatusPill status={selectedScan.status} />
                      {selectedScan.status !== 'running' && selectedScan.status !== 'queued' &&
                        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{formatDuration(selectedScan.duration)}</span>}
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{selectedScan.templates}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: 'rgba(0,212,170,0.1)', color: 'var(--accent-cyan)' }}>{selectedFindings.length} findings</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={shareReport} disabled={sharing} title="Copy public report link"
                      className="flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border focus-ring disabled:opacity-50"
                      style={{ backgroundColor: 'rgba(0,212,170,0.1)', borderColor: 'var(--accent-cyan)', color: 'var(--accent-cyan)' }}>
                      {sharing ? <Loader2 size={13} className="animate-spin-slow" /> : <Share2 size={13} />} Share
                    </button>
                    <button onClick={exportScan} title="Export report (JSON)"
                      className="flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border focus-ring"
                      style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                      <Download size={13} /> Export
                    </button>
                  </div>
                </div>
              </DialogHeader>

              <Tabs defaultValue="findings" className="flex flex-col">
                <TabsList className="mx-6 mt-4 h-8 w-auto self-start" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                  <TabsTrigger value="findings" className="text-[12px] h-6 px-3">
                    Findings ({visibleFindings.length}{visibleFindings.length !== selectedFindings.length ? `/${selectedFindings.length}` : ''})
                  </TabsTrigger>
                  <TabsTrigger value="terminal" className="text-[12px] h-6 px-3">Terminal Output</TabsTrigger>
                </TabsList>

                <TabsContent value="findings" className="px-6 py-4 m-0">
                  {/* Severity filter */}
                  {selectedFindings.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 mb-4">
                      <span className="text-[11px] font-medium uppercase tracking-wider mr-1" style={{ color: 'var(--text-muted)' }}>Filter</span>
                      {severityOrder.filter(s => reportSevCounts[s] > 0).map(sev => {
                        const active = !hiddenSeverities.has(sev);
                        return (
                          <button key={sev} onClick={() => toggleSeverity(sev)}
                            className="flex items-center gap-1.5 h-6 px-2 rounded-md text-[11px] font-medium capitalize transition-all border focus-ring"
                            style={{
                              backgroundColor: active ? `${SEVERITY_COLORS[sev]}22` : 'var(--bg-tertiary)',
                              borderColor: active ? SEVERITY_COLORS[sev] : 'var(--border-subtle)',
                              color: active ? SEVERITY_COLORS[sev] : 'var(--text-muted)',
                              opacity: active ? 1 : 0.6,
                            }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SEVERITY_COLORS[sev] }} />
                            {sev} {reportSevCounts[sev]}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {visibleFindings.length > 0 ? (
                    <div className="space-y-3">
                      {visibleFindings.map((finding, idx) => <FindingCard key={finding.id} finding={finding} index={idx} />)}
                    </div>
                  ) : selectedFindings.length > 0 ? (
                    <div className="text-center py-10">
                      <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>Nothing to show</p>
                      <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        All {selectedFindings.length} findings are hidden by the filter — enable a severity above to see them.
                      </p>
                    </div>
                  ) : (
                    <div className="text-center py-10">
                      <CheckCircle size={32} style={{ color: 'var(--severity-low)' }} className="mx-auto mb-2" />
                      <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>No findings detected</p>
                      <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {selectedScan.status === 'running' || selectedScan.status === 'queued' ? 'Scan in progress…' : 'This scan completed without discovering any vulnerabilities'}
                      </p>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="terminal" className="m-0">
                  <TerminalView scan={selectedScan} />
                </TabsContent>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
    queued: { icon: <Clock size={12} />, color: 'var(--text-muted)', label: 'Queued' },
    running: { icon: <Loader2 size={12} className="animate-spin-slow" />, color: 'var(--accent-cyan)', label: 'Running' },
    completed: { icon: <CheckCircle size={12} />, color: 'var(--severity-low)', label: 'Completed' },
    failed: { icon: <XCircle size={12} />, color: 'var(--severity-high)', label: 'Failed' },
    cancelled: { icon: <Ban size={12} />, color: 'var(--text-muted)', label: 'Cancelled' },
  };
  const s = map[status] || map.queued;
  return (
    <div className="flex items-center gap-1.5" style={{ color: s.color }}>
      {s.icon}
      <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
    </div>
  );
}

// Live terminal: streams via SSE while the scan is active, otherwise shows the stored output.
function TerminalView({ scan }: { scan: Scan }) {
  const [text, setText] = useState<string>(() => Array.isArray(scan.terminalOutput) ? scan.terminalOutput.join('\n') : (scan.terminalOutput || ''));
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(Array.isArray(scan.terminalOutput) ? scan.terminalOutput.join('\n') : (scan.terminalOutput || ''));
    if (scan.status !== 'running' && scan.status !== 'queued') return;

    const es = new EventSource(api.streamUrl(scan.id));
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'init') setText(msg.terminalOutput || '');
        else if (msg.type === 'line') setText(prev => prev + (prev ? '\n' : '') + msg.line);
        else if (msg.type === 'done') es.close();
      } catch { /* ignore keep-alive */ }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [scan.id, scan.status]);

  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [text]);

  const lines = text.split('\n');
  return (
    <div ref={boxRef} className="m-6 p-4 rounded-md overflow-auto sentinel-scrollbar font-mono text-[11px] leading-relaxed max-h-[50vh]"
      style={{ backgroundColor: '#0D0E12', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          {line.startsWith('[INF]') && <><span style={{ color: 'var(--accent-cyan)' }}>[INF]</span><span>{line.slice(5)}</span></>}
          {line.startsWith('[ERR]') && <><span style={{ color: 'var(--severity-high)' }}>[ERR]</span><span>{line.slice(5)}</span></>}
          {line.match(/^\[\d+\]/) && <><span style={{ color: 'var(--accent-cyan)' }}>{line.match(/^\[\d+\]/)?.[0]}</span><span style={{ color: 'var(--severity-high)' }}>{line.replace(/^\[\d+\]/, '')}</span></>}
          {!line.match(/^\[(INF|ERR|\d+)\]/) && <span>{line}</span>}
        </div>
      ))}
    </div>
  );
}

function FindingCard({ finding, index }: { finding: Finding; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const borderColors: Record<string, string> = { critical: '#DC2626', high: '#EF4444', medium: '#F59E0B', low: '#10B981', info: '#3B82F6' };
  const hasDetail = finding.description || finding.remediation || (finding.reference && finding.reference.length) || finding.curl;

  return (
    <div className="rounded-md p-4 animate-severity-pop" style={{ backgroundColor: 'var(--bg-tertiary)', borderLeft: `3px solid ${borderColors[finding.severity] || '#6B7280'}`, animationDelay: `${index * 60}ms`, opacity: 0 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-[12px] font-mono" style={{ color: 'var(--accent-blue)' }}>{finding.templateId}</span>
            <SeverityBadge severity={finding.severity} />
            {finding.cve && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'rgba(59,130,246,0.15)', color: '#3B82F6' }}>{finding.cve}</span>}
            {finding.cvss != null && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: '#F59E0B' }}>CVSS {finding.cvss}</span>}
          </div>
          <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{finding.name}</h4>
          <p className="text-[12px] font-mono mt-1 break-all" style={{ color: 'var(--text-secondary)' }}>{finding.matchedAt}</p>
          {finding.tags && finding.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {finding.tags.slice(0, 8).map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {finding.extracted && <div className="mt-2 p-2 rounded font-mono text-[11px] break-all" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>{finding.extracted}</div>}

      {hasDetail && (
        <>
          <button onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[11px] font-medium mt-2 focus-ring rounded px-1 -ml-1" style={{ color: 'var(--accent-cyan)' }}>
            <ChevronDown size={12} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded && (
            <div className="mt-2 space-y-2">
              {finding.description && <Detail label="Description" text={finding.description} />}
              {finding.remediation && <Detail label="Remediation" text={finding.remediation} />}
              {finding.reference && finding.reference.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>References</div>
                  <div className="space-y-0.5">
                    {finding.reference.map((r, i) => (
                      <a key={i} href={r} target="_blank" rel="noreferrer" className="block text-[11px] font-mono truncate hover:underline" style={{ color: 'var(--accent-blue)' }}>{r}</a>
                    ))}
                  </div>
                </div>
              )}
              {finding.curl && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>cURL</div>
                  <pre className="text-[11px] font-mono p-2 rounded overflow-x-auto sentinel-scrollbar" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{finding.curl}</pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{text}</p>
    </div>
  );
}
