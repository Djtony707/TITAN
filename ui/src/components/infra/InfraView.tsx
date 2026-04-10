import { useState, lazy, Suspense } from 'react';
import clsx from 'clsx';

const HomelabPanel = lazy(() => import('../admin/HomelabPanel'));
const NvidiaPanel = lazy(() => import('../admin/NvidiaPanel'));
const FilesPanel = lazy(() => import('../admin/FilesPanel'));
const LogsPanel = lazy(() => import('../admin/LogsPanel'));
const TelemetryPanel = lazy(() => import('../admin/TelemetryPanel'));

const TABS = [
  { id: 'homelab', label: 'Homelab' },
  { id: 'gpu', label: 'GPU / NVIDIA' },
  { id: 'files', label: 'Files' },
  { id: 'logs', label: 'Logs' },
  { id: 'telemetry', label: 'Telemetry' },
];

export default function InfraView() {
  const [activeTab, setActiveTab] = useState('homelab');

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-5 pt-4 pb-0">
        <h1 className="text-sm font-semibold text-text mb-3">Infrastructure</h1>
        <div className="flex items-center gap-0.5 border-b border-white/[0.04]">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-3 py-2 text-xs font-medium transition-colors relative',
                activeTab === tab.id ? 'text-accent' : 'text-text-muted hover:text-text-secondary',
              )}
            >
              {tab.label}
              {activeTab === tab.id && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-accent rounded-full" />}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-5">
        <Suspense fallback={<div className="skeleton-shimmer h-40 rounded-lg" />}>
          {activeTab === 'homelab' && <HomelabPanel />}
          {activeTab === 'gpu' && <NvidiaPanel />}
          {activeTab === 'files' && <FilesPanel />}
          {activeTab === 'logs' && <LogsPanel />}
          {activeTab === 'telemetry' && <TelemetryPanel />}
        </Suspense>
      </div>
    </div>
  );
}
