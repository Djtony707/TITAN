import { useState, useEffect, createContext, useContext, useMemo } from 'react';
import { getConfig, getVoiceHealth } from '@/api/client';
import type { TitanConfig, VoiceHealth } from '@/api/types';

interface ConfigContextType {
  config: TitanConfig | null;
  voiceHealth: VoiceHealth | null;
  voiceAvailable: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextType>({
  config: null,
  voiceHealth: null,
  voiceAvailable: false,
  loading: true,
  refresh: async () => {},
});

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<TitanConfig | null>(null);
  const [voiceHealth, setVoiceHealth] = useState<VoiceHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
      if (cfg.voice?.enabled) {
        try {
          const vh = await getVoiceHealth();
          setVoiceHealth(vh);
        } catch {
          setVoiceHealth(null);
        }
      }
    } catch (e) {
      console.error('Failed to load config:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // Poll every 30 seconds — config rarely changes; pause when tab hidden
    let interval = setInterval(refresh, 30000);
    const onVis = () => {
      if (document.hidden) {
        clearInterval(interval);
      } else {
        refresh();
        interval = setInterval(refresh, 30000);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Voice button is available whenever voice is enabled in config — don't gate on health
  const voiceAvailable = Boolean(config?.voice?.enabled);

  const value = useMemo(() => ({ config, voiceHealth, voiceAvailable, loading, refresh }),
    [config, voiceHealth, voiceAvailable, loading, refresh]);

  return (
    <ConfigContext.Provider value={value}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  return useContext(ConfigContext);
}
