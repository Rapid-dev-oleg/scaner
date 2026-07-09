import { useState } from 'react';
import { Globe, Clock, Database, AlertTriangle, Loader2 } from 'lucide-react';
import TopBar from '@/components/TopBar';
import { Switch } from '@/components/ui/switch';
import { useSettings } from '@/contexts/SettingsContext';
import { useApp } from '@/contexts/AppContext';
import { api } from '@/api';
import type { Severity, DateFormatType } from '@/types';

export default function Settings() {
  const { settings, updateSettings, resetSettings } = useSettings();
  const { addToast } = useApp();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [updatingTemplates, setUpdatingTemplates] = useState(false);

  const handleUpdateTemplates = async () => {
    setUpdatingTemplates(true);
    try {
      const res = await api.updateTemplates();
      addToast({
        type: res.ok ? 'success' : 'alert',
        title: res.ok ? 'Templates Updated' : 'Update Failed',
        message: (res.output || '').split('\n').slice(-1)[0] || (res.ok ? 'Done' : 'nuclei CLI not available'),
      });
    } catch (err: any) {
      addToast({ type: 'alert', title: 'Update Failed', message: err.message });
    } finally {
      setUpdatingTemplates(false);
    }
  };

  const handleExport = async () => {
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sentinel-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      addToast({ type: 'alert', title: 'Export Failed', message: err.message });
    }
  };

  const severityOptions: { value: Severity; label: string }[] = [
    { value: 'info', label: 'Info' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];

  const dateFormats: { value: DateFormatType; label: string }[] = [
    { value: ' Jul 08, 2026', label: 'Jul 08, 2026' },
    { value: '2026-07-08', label: '2026-07-08' },
    { value: '08/07/2026', label: '08/07/2026' },
  ];

  return (
    <div>
      <TopBar title="Settings" />

      <div className="max-w-[640px] space-y-6">
        {/* General */}
        <Section icon={<Globe size={16} />} title="General">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>Language</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Interface language</div>
              </div>
              <select
                disabled
                className="h-8 px-3 rounded-md text-[12px] cursor-not-allowed opacity-50"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                <option>English</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>Theme</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Interface appearance</div>
              </div>
              <select
                disabled
                className="h-8 px-3 rounded-md text-[12px] cursor-not-allowed opacity-50"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                <option>Dark</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>Auto-detect Timezone</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Use browser timezone</div>
              </div>
              <Switch
                checked={settings.autoDetectTimezone}
                onCheckedChange={v => updateSettings({ autoDetectTimezone: v })}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Timezone</label>
              <input
                value={settings.timezone}
                onChange={e => updateSettings({ timezone: e.target.value })}
                disabled={settings.autoDetectTimezone}
                className="w-full h-8 px-3 rounded-md text-[12px] font-mono focus-ring outline-none disabled:opacity-50"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Date Format</label>
              <div className="flex gap-3">
                {dateFormats.map(fmt => (
                  <button
                    key={fmt.value}
                    onClick={() => updateSettings({ dateFormat: fmt.value })}
                    className="flex-1 h-8 rounded-md text-[12px] font-medium transition-all border focus-ring"
                    style={{
                      backgroundColor: settings.dateFormat === fmt.value ? 'rgba(0,212,170,0.1)' : 'var(--bg-tertiary)',
                      borderColor: settings.dateFormat === fmt.value ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                      color: settings.dateFormat === fmt.value ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                    }}
                  >
                    {fmt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {/* Scan Defaults */}
        <Section icon={<Clock size={16} />} title="Scan Defaults">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Default Rate Limit (req/s)</label>
              <input
                type="number"
                value={settings.defaultRateLimit}
                onChange={e => updateSettings({ defaultRateLimit: Number(e.target.value) })}
                className="w-full h-8 px-3 rounded-md text-[12px] focus-ring outline-none"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Default Timeout (seconds)</label>
              <input
                type="number"
                value={settings.defaultTimeout}
                onChange={e => updateSettings({ defaultTimeout: Number(e.target.value) })}
                className="w-full h-8 px-3 rounded-md text-[12px] focus-ring outline-none"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Severity Threshold</label>
              <select
                value={settings.defaultSeverityThreshold}
                onChange={e => updateSettings({ defaultSeverityThreshold: e.target.value as Severity })}
                className="w-full h-8 px-3 rounded-md text-[12px] focus-ring outline-none cursor-pointer"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              >
                {severityOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Concurrent Scans</label>
              <input
                type="number"
                value={settings.concurrentScansLimit}
                onChange={e => updateSettings({ concurrentScansLimit: Number(e.target.value) })}
                className="w-full h-8 px-3 rounded-md text-[12px] focus-ring outline-none"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Scan Timeout (min, 0 = none)</label>
              <input
                type="number"
                value={settings.scanTimeoutMinutes}
                onChange={e => updateSettings({ scanTimeoutMinutes: Number(e.target.value) })}
                className="w-full h-8 px-3 rounded-md text-[12px] focus-ring outline-none"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
          </div>
        </Section>

        {/* Nuclei Config */}
        <Section icon={<Database size={16} />} title="Nuclei Configuration">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Templates Path</label>
              <input
                value={settings.templatesPath}
                onChange={e => updateSettings({ templatesPath: e.target.value })}
                className="w-full h-8 px-3 rounded-md text-[12px] font-mono focus-ring outline-none"
                style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
            <button
              onClick={handleUpdateTemplates}
              disabled={updatingTemplates}
              className="h-8 px-4 rounded-md text-[12px] font-medium transition-colors border focus-ring flex items-center gap-2 disabled:opacity-50"
              style={{
                backgroundColor: 'var(--bg-tertiary)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-active)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              {updatingTemplates && <Loader2 size={12} className="animate-spin-slow" />}
              {updatingTemplates ? 'Updating…' : 'Update Templates Now'}
            </button>
          </div>
        </Section>

        {/* Data Management */}
        <Section icon={<AlertTriangle size={16} />} title="Data Management">
          <div className="space-y-3">
            <button
              className="h-8 px-4 rounded-md text-[12px] font-medium transition-colors border focus-ring"
              style={{
                backgroundColor: 'var(--bg-tertiary)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
              onClick={handleExport}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-active)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              Export All Data
            </button>

            {!showResetConfirm ? (
              <button
                onClick={() => setShowResetConfirm(true)}
                className="h-8 px-4 rounded-md text-[12px] font-medium transition-colors border focus-ring block"
                style={{
                  backgroundColor: 'transparent',
                  borderColor: 'var(--severity-high)',
                  color: 'var(--severity-high)',
                }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.1)'; }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                Reset All Settings
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[12px]" style={{ color: 'var(--severity-high)' }}>Are you sure?</span>
                <button
                  onClick={() => { resetSettings(); setShowResetConfirm(false); }}
                  className="h-7 px-3 rounded text-[11px] font-medium"
                  style={{ backgroundColor: 'var(--severity-high)', color: '#fff' }}
                >
                  Yes, Reset
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="h-7 px-3 rounded text-[11px] font-medium border"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border p-5"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <span style={{ color: 'var(--accent-cyan)' }}>{icon}</span>
        <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}
