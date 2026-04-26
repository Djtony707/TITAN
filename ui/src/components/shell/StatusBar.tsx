import { useState } from 'react';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { useUpdateCheck } from '../../hooks/useUpdateCheck';
import { Circle, Download, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
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
  const { info: updateInfo, triggerUpdate } = useUpdateCheck();
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const handleUpdate = async () => {
    if (!updateInfo?.isNewer || updating) return;
    if (!confirm(`Update TITAN from ${updateInfo.current} → ${updateInfo.latest}?

Your data in ~/.titan/ will be preserved. The gateway will restart after the update.`)) {
      return;
    }
    setUpdating(true);
    setUpdateResult(null);
    const result = await triggerUpdate(true);
    setUpdateResult({ ok: result.ok, message: result.message || result.error });
    setUpdating(false);
    if (result.ok) {
      setTimeout(() => {
        alert('Update initiated. The gateway will restart shortly. Please refresh the page in 10-15 seconds.');
      }, 500);
    }
  };

  return (
    <div
      className="flex items-center justify-between px-4 h-7 text-[10px] tracking-wide text-text-muted shrink-0 select-none border-t border-border/50"
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

        {/* Update badge */}
        {updateInfo?.isNewer && updateInfo.latest && (
          <button
            onClick={handleUpdate}
            disabled={updating}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#f59e0b]/10 border border-[#f59e0b]/30 text-[#f59e0b] hover:bg-[#f59e0b]/20 transition-colors cursor-pointer disabled:opacity-50"
            title={`Update available: ${updateInfo.current} → ${updateInfo.latest}`}
          >
            {updating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : updateResult ? (
              updateResult.ok ? (
                <CheckCircle2 className="w-3 h-3" />
              ) : (
                <AlertCircle className="w-3 h-3" />
              )
            ) : (
              <Download className="w-3 h-3" />
            )}
            <span className="font-medium">
              {updating ? 'Updating…' : updateResult ? (updateResult.ok ? 'Restarting…' : 'Failed') : `Update to ${updateInfo.latest}`}
            </span>
          </button>
        )}

        {/* Version */}
        {status.version && (
          <span className="text-text-secondary">TITAN {status.version}</span>
        )}
      </div>
    </div>
  );
}
