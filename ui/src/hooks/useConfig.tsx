import { useState, useEffect, createContext, useContext } from 'react';
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
    // Poll every 4 seconds — keeps model name, config changes live without a reload
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, []);

  // Voice button is available whenever voice is enabled in config — don't gate on health
  const voiceAvailable = Boolean(config?.voice?.enabled);

  return (
    <ConfigContext.Provider value={{ config, voiceHealth, voiceAvailable, loading, refresh }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  return useContext(ConfigContext);
}
