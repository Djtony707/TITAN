import { useSystemStatus } from '../../hooks/useSystemStatus';
import { Circle } from 'lucide-react';
import BodyStateIndicator from './BodyStateIndicator';

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function StatusBar() {
  const status = useSystemStatus();

  return (
    <div
      className="flex items-center justify-between px-4 h-7 text-[10px] tracking-wide text-text-muted shrink-0 select-none border-t border-white/[0.04]"
      style={{ background: 'var(--color-status-bar-bg)' }}
    >
      <div className="flex items-center gap-4">
        {/* Connection indicator */}
        <span className="flex items-center gap-1.5">
          <Circle
            size={6}
            fill={status.connected ? 'var(--color-success)' : 'var(--color-error)'}
            stroke="none"
          />
          {status.connected ? 'Connected' : 'Disconnected'}
        </span>

        {/* Model */}
        {status.model && (
          <span className="text-text-secondary">{status.model}</span>
        )}

        {/* Uptime */}
        {status.uptime > 0 && (
          <span>Up {formatUptime(status.uptime)}</span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Soma body-state indicator — hides itself if organism disabled */}
        <BodyStateIndicator />

        {/* Memory */}
        {status.memoryMB > 0 && (
          <span>{status.memoryMB}MB</span>
        )}

        {/* Version */}
        {status.version && (
          <span className="text-text-secondary">TITAN {status.version}</span>
        )}
      </div>
    </div>
  );
}
