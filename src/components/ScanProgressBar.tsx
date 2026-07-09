import { useEffect, useState } from 'react';
import { api } from '@/api';
import type { ScanProgress } from '@/types';

export function parseProgress(p: ScanProgress | string | undefined | null): ScanProgress | null {
  if (!p) return null;
  if (typeof p === 'string') {
    try { return JSON.parse(p) as ScanProgress; } catch { return null; }
  }
  return p;
}

interface Props {
  scanId: string;
  initial?: ScanProgress | string;
  live?: boolean;       // subscribe to SSE for real-time updates
  showMeta?: boolean;   // show "N/M req · X rps" line
  label?: string;
}

export default function ScanProgressBar({ scanId, initial, live = false, showMeta = false, label = 'Scanning' }: Props) {
  const [prog, setProg] = useState<ScanProgress | null>(parseProgress(initial));

  useEffect(() => { setProg(parseProgress(initial)); }, [initial]);

  useEffect(() => {
    if (!live) return;
    const es = new EventSource(api.streamUrl(scanId));
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'progress' && msg.progress) setProg(msg.progress);
        else if (msg.type === 'done') es.close();
      } catch { /* keep-alive */ }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [scanId, live]);

  const crawling = prog?.phase === 'crawl';
  const pct = prog ? Math.min(100, Math.max(0, prog.percent)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
        <span>{crawling ? 'Crawling' : label}{prog ? '' : '… starting'}</span>
        {prog && !crawling && <span style={{ color: 'var(--accent-cyan)' }}>{pct}%</span>}
        {crawling && <span style={{ color: 'var(--accent-cyan)' }}>{prog!.requests} URLs</span>}
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
        <div className={`h-full ${prog && !crawling ? 'transition-all duration-500' : 'animate-pulse'}`}
          style={{ width: `${prog && !crawling ? pct : 30}%`, backgroundColor: 'var(--accent-cyan)' }} />
      </div>
      {showMeta && prog && !crawling && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          {prog.requests.toLocaleString()}/{prog.total.toLocaleString()} req · {prog.rps} rps{prog.errors ? ` · ${prog.errors} errors` : ''}
        </div>
      )}
      {showMeta && crawling && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>discovering endpoints…</div>
      )}
    </div>
  );
}
