import { useState } from 'react';
import { Activity, GitBranch, Sparkles, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import LiveFeedTab from './LiveFeedTab';
import TracesTab from './TracesTab';
import SoulTab from './SoulTab';
import AlertsTab from './AlertsTab';

const TABS = [
  { id: 'live', label: 'Live', icon: Activity },
  { id: 'traces', label: 'Traces', icon: GitBranch },
  { id: 'soul', label: 'Soul', icon: Sparkles },
  { id: 'alerts', label: 'Alerts', icon: AlertTriangle },
] as const;

type TabId = typeof TABS[number]['id'];

export default function ActivityPanel() {
  const [activeTab, setActiveTab] = useState<TabId>('live');

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 pt-2 pb-0 shrink-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors',
              activeTab === id
                ? 'text-accent bg-bg-tertiary border-b-2 border-accent'
                : 'text-text-muted hover:text-text-secondary',
            )}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="h-px bg-bg-tertiary mx-2" />

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {activeTab === 'live' && <LiveFeedTab />}
        {activeTab === 'traces' && <TracesTab />}
        {activeTab === 'soul' && <SoulTab />}
        {activeTab === 'alerts' && <AlertsTab />}
      </div>
    </div>
  );
}
