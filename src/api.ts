const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api';

const TOKEN_KEY = 'sentinel_token';
export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v: string | null) {
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

let apiAvailable: boolean | null = null;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options?.headers as any) };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    apiAvailable = false;
    throw new Error('API unreachable');
  }
  apiAvailable = true;

  if (res.status === 401) {
    auth.token = null;
    if (onUnauthorized) onUnauthorized();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  isAvailable: () => apiAvailable,

  // Auth
  authStatus: () => request<{ authRequired: boolean }>('/auth/status'),
  login: (password: string) => request<{ token: string | null }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }).catch(() => {}),

  // Monitors
  getMonitors: () => request<any[]>('/monitors'),
  getMonitor: (id: string) => request<any>(`/monitors/${id}`),
  createMonitor: (data: any) => request<any>('/monitors', { method: 'POST', body: JSON.stringify(data) }),
  updateMonitor: (id: string, data: any) => request<any>(`/monitors/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteMonitor: (id: string) => request<any>(`/monitors/${id}`, { method: 'DELETE' }),

  // Scans
  getScans: () => request<any[]>('/scans'),
  getScan: (id: string) => request<any>(`/scans/${id}`),
  triggerScan: (monitorId: string) => request<any>('/scans', { method: 'POST', body: JSON.stringify({ monitorId }) }),
  stopScan: (id: string) => request<any>(`/scans/${id}/stop`, { method: 'POST' }),
  shareScan: (id: string) => request<{ token: string; url: string }>(`/scans/${id}/share`, { method: 'POST' }),
  unshareScan: (id: string) => request<any>(`/scans/${id}/share`, { method: 'DELETE' }),
  getQueue: () => request<{ running: string[]; queued: string[]; maxConcurrent: number }>('/scans/queue'),
  streamUrl: (id: string) => `${API_BASE}/scans/${id}/stream${auth.token ? `?token=${encodeURIComponent(auth.token)}` : ''}`,

  // Templates
  getTemplates: () => request<{ installed: boolean; dir: string | null; categories: { id: string; label: string; icon: string; count: number }[] }>('/templates'),
  searchTemplates: (q: string, limit = 50) => request<{ installed: boolean; results: { id: string; path: string }[] }>(`/templates/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  updateTemplates: () => request<{ ok: boolean; output: string }>('/templates/update', { method: 'POST' }),

  // Notifications
  getChannels: () => request<any[]>('/notifications/channels'),
  updateChannel: (id: string, data: any) => request<any>(`/notifications/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  testChannel: (id: string) => request<any>(`/notifications/channels/${id}/test`, { method: 'POST' }),

  // Settings
  getSettings: () => request<Record<string, any>>('/settings'),
  updateSettings: (data: any) => request<any>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),

  // Export
  exportData: () => request<any>('/export'),

  health: () => request<any>('/health'),
};
