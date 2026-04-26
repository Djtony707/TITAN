import { useState, lazy, Suspense } from 'react';
import clsx from 'clsx';

const SkillsPanel = lazy(() => import('../admin/SkillsPanel'));
const McpPanel = lazy(() => import('../admin/McpPanel'));
const IntegrationsPanel = lazy(() => import('../admin/IntegrationsPanel'));
const ChannelsPanel = lazy(() => import('../admin/ChannelsPanel'));
const MeshPanel = lazy(() => import('../admin/MeshPanel'));

const TABS = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'channels', label: 'Channels' },
  { id: 'mesh', label: 'Mesh Network' },
];

export default function ToolsView() {
  const [activeTab, setActiveTab] = useState('skills');

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-5 pt-4 pb-0">
        <h1 className="text-sm font-semibold text-text mb-3">Tools & Connections</h1>
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
          {activeTab === 'skills' && <SkillsPanel />}
          {activeTab === 'mcp' && <McpPanel />}
          {activeTab === 'integrations' && <IntegrationsPanel />}
          {activeTab === 'channels' && <ChannelsPanel />}
          {activeTab === 'mesh' && <MeshPanel />}
        </Suspense>
      </div>
    </div>
  );
}
