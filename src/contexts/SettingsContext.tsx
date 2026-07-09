import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api } from '@/api';
import type { AppSettings } from '@/types';

const DEFAULT_SETTINGS: AppSettings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  autoDetectTimezone: true,
  dateFormat: ' Jul 08, 2026',
  defaultRateLimit: 150,
  defaultTimeout: 30,
  defaultSeverityThreshold: 'low',
  concurrentScansLimit: 5,
  scanTimeoutMinutes: 30,
  templatesPath: '~/.nuclei-templates',
};

interface SettingsContextType {
  settings: AppSettings;
  isLoading: boolean;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
  resetSettings: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    api.getSettings()
      .then((data: any) => {
        if (data && Object.keys(data).length > 0) {
          setSettings({
            ...DEFAULT_SETTINGS,
            ...data,
            autoDetectTimezone: data.autoDetectTimezone === 'true' || data.autoDetectTimezone === true,
            defaultRateLimit: Number(data.defaultRateLimit) || 150,
            defaultTimeout: Number(data.defaultTimeout) || 30,
            concurrentScansLimit: Number(data.concurrentScansLimit) || 5,
            scanTimeoutMinutes: Number(data.scanTimeoutMinutes) || 30,
          });
        }
      })
      .catch(() => { /* keep defaults if API unavailable */ })
      .finally(() => setIsLoading(false));
  }, []);

  const updateSettings = useCallback(async (updates: Partial<AppSettings>) => {
    await api.updateSettings(updates);
    setSettings(prev => ({ ...prev, ...updates }));
  }, []);

  const resetSettings = useCallback(async () => {
    await api.updateSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, isLoading, updateSettings, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
