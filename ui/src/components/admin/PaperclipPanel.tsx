import { useState, useEffect, useCallback } from 'react';
import { Paperclip, Play, Square, RotateCcw, RefreshCw } from 'lucide-react';
import { getPaperclipStatus, startPaperclip, stopPaperclip } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

export default function PaperclipPanel() {
  const [status, setStatus] = useState<{ running: boolean; pid?: number; url?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getPaperclipStatus();
      setStatus(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleStart = async () => {
    try { await startPaperclip(); await refresh(); } catch { /* ignore */ }
  };

  const handleStop = async () => {
    try { await stopPaperclip(); await refresh(); } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Paperclip" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Tools'}, {label:'Paperclip'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      {status && (
        <div className="p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
          <div className="flex items-center gap-2 mb-3">
            <Paperclip className={`w-4 h-4 ${status.running ? 'text-emerald-400' : 'text-[#52525b]'}`} />
            <span className="text-sm font-medium text-[#e4e4e7]">{status.running ? 'Running' : 'Stopped'}</span>
            {status.pid && <span className="text-xs text-[#52525b]">PID {status.pid}</span>}
          </div>
          {status.url && <div className="text-xs text-[#52525b] mb-3">{status.url}</div>}
          <div className="flex gap-2">
            {!status.running && (
              <button onClick={handleStart} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1] text-white text-sm font-medium hover:bg-[#4f46e5]">
                <Play className="w-4 h-4" /> Start
              </button>
            )}
            {status.running && (
              <button onClick={handleStop} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700">
                <Square className="w-4 h-4" /> Stop
              </button>
            )}
            <button onClick={refresh} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46]">
              <RotateCcw className="w-4 h-4" /> Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
