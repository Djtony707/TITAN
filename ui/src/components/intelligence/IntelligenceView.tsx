import { useState, lazy, Suspense } from 'react';
import clsx from 'clsx';

const AutopilotPanel = lazy(() => import('../admin/AutopilotPanel'));
const WorkflowsPanel = lazy(() => import('../admin/WorkflowsPanel'));
const LearningPanel = lazy(() => import('../admin/LearningPanel'));
const MemoryGraphPanel = lazy(() => import('../admin/MemoryGraphPanel'));
const SelfImprovePanel = lazy(() => import('../admin/SelfImprovePanel'));
const PersonasPanel = lazy(() => import('../admin/PersonasPanel'));

const TABS = [
  { id: 'autopilot', label: 'Autopilot' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'learning', label: 'Learning' },
  { id: 'memory', label: 'Memory & Graph' },
  { id: 'self-improve', label: 'Self-Improve' },
  { id: 'personas', label: 'Personas' },
];

export default function IntelligenceView() {
  const [activeTab, setActiveTab] = useState('autopilot');

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-5 pt-4 pb-0">
        <h1 className="text-sm font-semibold text-text mb-3">Intelligence</h1>
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
          {activeTab === 'autopilot' && <AutopilotPanel />}
          {activeTab === 'workflows' && <WorkflowsPanel />}
          {activeTab === 'learning' && <LearningPanel />}
          {activeTab === 'memory' && <MemoryGraphPanel />}
          {activeTab === 'self-improve' && <SelfImprovePanel />}
          {activeTab === 'personas' && <PersonasPanel />}
        </Suspense>
      </div>
    </div>
  );
}
