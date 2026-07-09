import { useState, useEffect, useRef } from 'react';
import { X, Globe, ChevronDown, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApp } from '@/contexts/AppContext';
import { useMonitors } from '@/contexts/MonitorsContext';
import { api } from '@/api';
import { TEMPLATE_CATEGORIES, type TemplateCategory } from '@/data/templates';
import { shieldAlert, settings, layout, globe, lock, cpu, eye } from '@/utils/icons';
import type { TemplateMode, ScheduleType } from '@/types';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  cve: shieldAlert(14),
  misconfiguration: settings(14),
  'exposed-panels': layout(14),
  'subdomain-takeover': globe(14),
  'ssl-tls': lock(14),
  technologies: cpu(14),
  dns: globe(14),
  headless: eye(14),
};

const SCHEDULE_OPTIONS: { value: ScheduleType; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'custom', label: 'Custom (cron)' },
];

const DEFAULT_ADVANCED = {
  rateLimit: 150,
  timeout: 30,
  userAgent: 'Sentinel/1.0',
  followRedirects: true,
  maxRedirects: 10,
};

// Per-monitor notification channels ("one monitor = one client").
const NOTIF_CHANNELS: { key: string; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'slack', label: 'Slack' },
  { key: 'discord', label: 'Discord' },
  { key: 'webhook', label: 'Webhook' },
];

function defaultNotifs(): Record<string, any> {
  return {
    email: { enabled: false, level: 'all', recipients: [] },
    telegram: { enabled: false, level: 'high', chatId: '', botToken: '' },
    slack: { enabled: false, level: 'high', webhook: '' },
    discord: { enabled: false, level: 'high', webhook: '' },
    webhook: { enabled: false, level: 'high', url: '', method: 'POST' },
  };
}

// Accept the legacy { email:'all', ... } shape or the rich per-channel shape.
function normalizeNotifs(raw: any): Record<string, any> {
  const base = defaultNotifs();
  if (!raw || typeof raw !== 'object') return base;
  for (const key of Object.keys(base)) {
    const v = raw[key];
    if (v == null) continue;
    if (typeof v === 'string') base[key] = { ...base[key], enabled: v !== 'never', level: v };
    else base[key] = { ...base[key], ...v, enabled: v.enabled !== false };
  }
  return base;
}

export default function CreateMonitorSheet() {
  const { isCreateSheetOpen, closeSheet, editingMonitorId } = useApp();
  const { monitors, createMonitor, updateMonitor } = useMonitors();

  const existing = editingMonitorId ? monitors.find(m => m.id === editingMonitorId) : undefined;

  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [templateMode, setTemplateMode] = useState<TemplateMode>('categories');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([]);
  const [schedule, setSchedule] = useState<ScheduleType>('daily');
  const [cronExpr, setCronExpr] = useState('');
  const [notifications, setNotifications] = useState<Record<string, any>>(() => defaultNotifs());
  const [advanced, setAdvanced] = useState(DEFAULT_ADVANCED);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const initializedRef = useRef<string | null>(null);

  // Real template catalog from the backend (falls back to the static list).
  const [categories, setCategories] = useState<TemplateCategory[]>(TEMPLATE_CATEGORIES);
  const [tplQuery, setTplQuery] = useState('');
  const [tplResults, setTplResults] = useState<{ id: string; path: string }[]>([]);
  const [tplInstalled, setTplInstalled] = useState(true);

  useEffect(() => {
    if (!isCreateSheetOpen) return;
    api.getTemplates()
      .then(t => { if (t.categories?.length) setCategories(t.categories as TemplateCategory[]); setTplInstalled(t.installed); })
      .catch(() => { /* keep static fallback */ });
  }, [isCreateSheetOpen]);

  useEffect(() => {
    if (templateMode !== 'custom' || !isCreateSheetOpen) return;
    const q = tplQuery.trim();
    const handle = setTimeout(() => {
      api.searchTemplates(q, 60)
        .then(r => setTplResults(r.results || []))
        .catch(() => setTplResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [tplQuery, templateMode, isCreateSheetOpen]);

  useEffect(() => {
    const key = isCreateSheetOpen ? (editingMonitorId || '__new__') : null;
    if (initializedRef.current === key) return;
    initializedRef.current = key;

    const current = editingMonitorId ? monitors.find(m => m.id === editingMonitorId) : undefined;
    if (current) {
      setUrl(current.url);
      setName(current.name);
      setTemplateMode(current.templateMode);
      setSelectedCategories(current.templateCategories || []);
      setSelectedTemplates(current.customTemplates || []);
      setSchedule(current.schedule);
      setCronExpr(current.cronExpression || '');
      setNotifications(normalizeNotifs(current.notifications));
      setAdvanced(current.advanced || DEFAULT_ADVANCED);
    } else {
      setUrl('');
      setName('');
      setTemplateMode('categories');
      setSelectedCategories([]);
      setSelectedTemplates([]);
      setSchedule('daily');
      setCronExpr('');
      setNotifications(defaultNotifs());
      setAdvanced(DEFAULT_ADVANCED);
    }
    setErrors({});
  }, [editingMonitorId, isCreateSheetOpen, monitors]);

  const toggleCategory = (id: string) => {
    setSelectedCategories(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const toggleTemplate = (t: string) => {
    setSelectedTemplates(prev =>
      prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]
    );
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!url.trim()) errs.url = 'Target URL is required';
    else if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) errs.url = 'Enter a valid URL (http:// or https://)';
    if (templateMode === 'categories' && selectedCategories.length === 0) errs.templates = 'Select at least one category';
    if (templateMode === 'custom' && selectedTemplates.length === 0) errs.templates = 'Select at least one template';
    if (schedule === 'custom' && !cronExpr.trim()) errs.cron = 'Cron expression is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    setIsSubmitting(true);
    setTimeout(() => {
      const data = {
        name: name.trim() || new URL(url).hostname,
        url: url.trim(),
        templateMode,
        templateCategories: templateMode === 'categories' ? selectedCategories : [],
        customTemplates: templateMode === 'custom' ? selectedTemplates : [],
        schedule,
        cronExpression: schedule === 'custom' ? cronExpr : undefined,
        notifications,
        advanced,
      };
      if (existing) {
        updateMonitor(existing.id, data);
      } else {
        createMonitor(data);
      }
      setIsSubmitting(false);
      closeSheet();
    }, 400);
  };

  if (!isCreateSheetOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 animate-fade-in"
        style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
        onClick={closeSheet}
      />
      {/* Sheet */}
      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col animate-slide-in-right"
        style={{
          width: '100%',
          maxWidth: '560px',
          backgroundColor: 'var(--bg-secondary)',
          borderLeft: '1px solid var(--border-subtle)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 h-14 border-b flex-shrink-0"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {existing ? 'Edit Monitor' : 'New Monitor'}
          </h2>
          <button
            onClick={closeSheet}
            className="w-7 h-7 flex items-center justify-center rounded-md transition-colors focus-ring"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto sentinel-scrollbar p-6 space-y-6">
          {/* Basic Info */}
          <section className="space-y-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Target</h3>
            <div className="space-y-1.5">
              <Label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                Target URL <span style={{ color: 'var(--severity-high)' }}>*</span>
              </Label>
              <div className="relative">
                <Globe size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <Input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="h-9 pl-9 text-[13px] font-mono focus-ring"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: errors.url ? 'var(--severity-high)' : 'var(--border-subtle)', color: 'var(--text-primary)' }}
                />
              </div>
              {errors.url && <p className="text-[11px]" style={{ color: 'var(--severity-high)' }}>{errors.url}</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Monitor Name (optional)</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Auto-filled from domain"
                className="h-9 text-[13px] focus-ring"
                style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              />
            </div>
          </section>

          {/* Template Selection */}
          <section className="space-y-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Templates</h3>
            {/* Mode */}
            <div className="flex gap-2">
              {(['all', 'categories', 'custom'] as TemplateMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setTemplateMode(mode)}
                  className="flex-1 h-8 rounded-md text-[12px] font-medium transition-all border focus-ring"
                  style={{
                    backgroundColor: templateMode === mode ? 'rgba(0,212,170,0.1)' : 'var(--bg-tertiary)',
                    borderColor: templateMode === mode ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                    color: templateMode === mode ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                  }}
                >
                  {mode === 'all' ? 'All' : mode === 'categories' ? 'Categories' : 'Custom'}
                </button>
              ))}
            </div>

            {templateMode === 'all' && (
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Scan with all 7,000+ available Nuclei templates. This is the most thorough but slowest option.
              </p>
            )}

            {templateMode === 'categories' && (
              <div className="grid grid-cols-2 gap-2">
                {categories.map((cat: TemplateCategory) => {
                  const checked = selectedCategories.includes(cat.id);
                  return (
                    <button
                      key={cat.id}
                      onClick={() => toggleCategory(cat.id)}
                      className="flex items-center gap-2 h-9 px-3 rounded-md text-[12px] font-medium transition-all border focus-ring text-left"
                      style={{
                        backgroundColor: checked ? 'rgba(0,212,170,0.08)' : 'var(--bg-tertiary)',
                        borderColor: checked ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                        color: checked ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                      }}
                    >
                      {CATEGORY_ICONS[cat.id]}
                      <span className="flex-1 truncate">{cat.label}</span>
                      <span
                        className="text-[10px] px-1 rounded"
                        style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                      >
                        {cat.count.toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {templateMode === 'custom' && (
              <div className="space-y-2">
                {!tplInstalled && (
                  <p className="text-[11px]" style={{ color: 'var(--severity-medium, #F59E0B)' }}>
                    Nuclei templates are not installed on the server — run “Update Templates” in Settings. You can still type template IDs manually below.
                  </p>
                )}
                {/* Selected template chips */}
                {selectedTemplates.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTemplates.map(t => (
                      <button key={t} onClick={() => toggleTemplate(t)} title={t}
                        className="flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded focus-ring"
                        style={{ backgroundColor: 'rgba(0,212,170,0.1)', color: 'var(--accent-cyan)' }}>
                        {t.split('/').pop()?.replace(/\.ya?ml$/, '')} <X size={10} />
                      </button>
                    ))}
                  </div>
                )}
                {/* Search box */}
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                  <input
                    value={tplQuery}
                    onChange={e => setTplQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && tplQuery.trim()) { e.preventDefault(); toggleTemplate(tplQuery.trim()); setTplQuery(''); }
                    }}
                    placeholder="Search templates by id… (Enter to add manually)"
                    className="w-full h-9 pl-9 pr-3 rounded-md text-[12px] font-mono focus-ring outline-none"
                    style={{ backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                </div>
                {/* Results */}
                {tplResults.length > 0 && (
                  <div className="max-h-[200px] overflow-y-auto rounded-md border space-y-0.5 p-1 sentinel-scrollbar"
                    style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}>
                    {tplResults.map(t => {
                      const checked = selectedTemplates.includes(t.path);
                      return (
                        <button key={t.path} onClick={() => toggleTemplate(t.path)} title={t.path}
                          className="w-full flex items-center gap-2 h-7 px-2 rounded text-[12px] font-mono transition-colors text-left focus-ring"
                          style={{ backgroundColor: checked ? 'rgba(0,212,170,0.08)' : 'transparent', color: checked ? 'var(--accent-cyan)' : 'var(--text-secondary)' }}>
                          <span className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                            style={{ borderColor: checked ? 'var(--accent-cyan)' : 'var(--border-subtle)' }}>
                            {checked && <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: 'var(--accent-cyan)' }} />}
                          </span>
                          <span className="truncate">{t.id}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {tplInstalled && tplQuery && tplResults.length === 0 && (
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>No templates match “{tplQuery}”. Press Enter to add it as a custom id.</p>
                )}
              </div>
            )}
            {errors.templates && <p className="text-[11px]" style={{ color: 'var(--severity-high)' }}>{errors.templates}</p>}
          </section>

          {/* Schedule */}
          <section className="space-y-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Schedule</h3>
            <div className="flex gap-2">
              {SCHEDULE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setSchedule(opt.value)}
                  className="flex-1 h-8 rounded-md text-[12px] font-medium transition-all border focus-ring"
                  style={{
                    backgroundColor: schedule === opt.value ? 'rgba(0,212,170,0.1)' : 'var(--bg-tertiary)',
                    borderColor: schedule === opt.value ? 'var(--accent-cyan)' : 'var(--border-subtle)',
                    color: schedule === opt.value ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {schedule === 'custom' && (
              <div className="space-y-1.5">
                <Input
                  value={cronExpr}
                  onChange={e => setCronExpr(e.target.value)}
                  placeholder="0 0 * * *"
                  className="h-9 text-[13px] font-mono focus-ring"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: errors.cron ? 'var(--severity-high)' : 'var(--border-subtle)', color: 'var(--text-primary)' }}
                />
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Cron expression format: minute hour day month weekday</p>
                {errors.cron && <p className="text-[11px]" style={{ color: 'var(--severity-high)' }}>{errors.cron}</p>}
              </div>
            )}
          </section>

          {/* Notifications — per-monitor channels & recipients */}
          <section className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Notifications</h3>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Recipients for this monitor. Server credentials (SMTP, bot token) come from the global settings; here you set who gets alerts.
            </p>
            {NOTIF_CHANNELS.map(({ key, label }) => {
              const cfg = notifications[key] || {};
              const setNotif = (patch: any) => setNotifications(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
              return (
                <div key={key} className="rounded-md border p-3" style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: cfg.enabled ? 'var(--accent-cyan)' : 'var(--border-subtle)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                    <div className="flex items-center gap-2">
                      {cfg.enabled && (
                        <select
                          value={cfg.level || 'all'}
                          onChange={e => setNotif({ level: e.target.value })}
                          className="h-7 px-2 rounded-md text-[11px] focus-ring cursor-pointer"
                          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                        >
                          <option value="all">All findings</option>
                          <option value="high">High+ only</option>
                        </select>
                      )}
                      <Switch checked={!!cfg.enabled} onCheckedChange={v => setNotif({ enabled: v })} />
                    </div>
                  </div>
                  {cfg.enabled && (
                    <div className="mt-3 space-y-2">
                      {key === 'email' && <RecipientsEditor value={cfg.recipients || []} onChange={r => setNotif({ recipients: r })} />}
                      {key === 'telegram' && (
                        <div className="grid grid-cols-2 gap-2">
                          <NotifInput placeholder="Chat ID *" value={cfg.chatId || ''} onChange={v => setNotif({ chatId: v })} />
                          <NotifInput placeholder="Bot token (optional)" value={cfg.botToken || ''} onChange={v => setNotif({ botToken: v })} />
                        </div>
                      )}
                      {(key === 'slack' || key === 'discord') && (
                        <NotifInput placeholder="Webhook URL *" value={cfg.webhook || ''} onChange={v => setNotif({ webhook: v })} />
                      )}
                      {key === 'webhook' && (
                        <div className="grid grid-cols-[1fr_90px] gap-2">
                          <NotifInput placeholder="URL *" value={cfg.url || ''} onChange={v => setNotif({ url: v })} />
                          <select value={cfg.method || 'POST'} onChange={e => setNotif({ method: e.target.value })}
                            className="h-8 px-2 rounded-md text-[12px] focus-ring cursor-pointer"
                            style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                            <option value="POST">POST</option>
                            <option value="GET">GET</option>
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {/* Advanced */}
          <section>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-[12px] font-medium focus-ring rounded px-1 -ml-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              Advanced Options
            </button>
            {showAdvanced && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Rate Limit (req/s)</Label>
                    <Input
                      type="number"
                      value={advanced.rateLimit}
                      onChange={e => setAdvanced(p => ({ ...p, rateLimit: Number(e.target.value) }))}
                      className="h-8 text-[12px] focus-ring"
                      style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Timeout (seconds)</Label>
                    <Input
                      type="number"
                      value={advanced.timeout}
                      onChange={e => setAdvanced(p => ({ ...p, timeout: Number(e.target.value) }))}
                      className="h-8 text-[12px] focus-ring"
                      style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>User Agent</Label>
                  <Input
                    value={advanced.userAgent}
                    onChange={e => setAdvanced(p => ({ ...p, userAgent: e.target.value }))}
                    className="h-8 text-[12px] font-mono focus-ring"
                    style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Follow Redirects</Label>
                  <Switch
                    checked={advanced.followRedirects}
                    onCheckedChange={v => setAdvanced(p => ({ ...p, followRedirects: v }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Max Redirects</Label>
                  <Input
                    type="number"
                    value={advanced.maxRedirects}
                    onChange={e => setAdvanced(p => ({ ...p, maxRedirects: Number(e.target.value) }))}
                    className="h-8 text-[12px] focus-ring"
                    style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-6 h-14 border-t flex-shrink-0"
          style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-secondary)' }}
        >
          <Button
            variant="ghost"
            onClick={closeSheet}
            className="h-8 px-4 text-[12px] font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="h-8 px-4 text-[12px] font-semibold gap-1.5"
            style={{ backgroundColor: 'var(--accent-cyan)', color: 'var(--bg-primary)' }}
          >
            {isSubmitting && <Loader2 size={12} className="animate-spin-slow" />}
            {existing ? 'Save Changes' : 'Save Monitor'}
          </Button>
        </div>
      </div>
    </>
  );
}

function NotifInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full h-8 px-3 rounded-md text-[12px] font-mono focus-ring outline-none"
      style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
    />
  );
}

function RecipientsEditor({ value, onChange }: { value: string[]; onChange: (r: string[]) => void }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setInput('');
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map(r => (
            <button key={r} onClick={() => onChange(value.filter(x => x !== r))}
              className="flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded focus-ring"
              style={{ backgroundColor: 'rgba(0,212,170,0.1)', color: 'var(--accent-cyan)' }}>
              {r} <X size={10} />
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="email"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="owner@example.com — Enter to add"
          className="flex-1 h-8 px-3 rounded-md text-[12px] font-mono focus-ring outline-none"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
        />
        <button onClick={add} type="button"
          className="h-8 px-3 rounded-md text-[12px] font-medium border focus-ring"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
          Add
        </button>
      </div>
    </div>
  );
}
