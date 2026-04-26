import { useState, lazy, Suspense } from 'react';
import clsx from 'clsx';

const SettingsPanel = lazy(() => import('../admin/SettingsPanel'));
const SecurityPanel = lazy(() => import('../admin/SecurityPanel'));
const AuditPanel = lazy(() => import('../admin/AuditPanel'));
const AutonomyPanel = lazy(() => import('../admin/AutonomyPanel'));

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'autonomy', label: 'Autonomy' },
  { id: 'security', label: 'Security' },
  { id: 'audit', label: 'Audit Log' },
];

export default function SettingsView() {
  const [activeTab, setActiveTab] = useState('general');

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-5 pt-4 pb-0">
        <h1 className="text-sm font-semibold text-text mb-3">Settings</h1>
        <div className="flex items-center gap-0.5 border-b border-border/50">
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
          {activeTab === 'general' && <SettingsPanel />}
          {activeTab === 'autonomy' && <AutonomyPanel />}
          {activeTab === 'security' && <SecurityPanel />}
          {activeTab === 'audit' && <AuditPanel />}
        </Suspense>
      </div>
    </div>
  );
}
