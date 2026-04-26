import { useState } from 'react';
import clsx from 'clsx';

interface Tab {
  id: string;
  label: string;
  component: React.ComponentType;
}

interface PanelTabContainerProps {
  title: string;
  tabs: Tab[];
  defaultTab?: string;
}

export default function PanelTabContainer({ title, tabs, defaultTab }: PanelTabContainerProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id || '');
  const ActiveComponent = tabs.find(t => t.id === activeTab)?.component;

  return (
    <div className="flex flex-col h-full">
      {/* Header + tabs */}
      <div className="shrink-0 px-5 pt-4 pb-0">
        <h1 className="text-sm font-semibold text-text mb-3">{title}</h1>
        <div className="flex items-center gap-0.5 border-b border-border/50">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-3 py-2 text-xs font-medium transition-colors relative',
                activeTab === tab.id
                  ? 'text-accent'
                  : 'text-text-muted hover:text-text-secondary',
              )}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-accent rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto p-5">
        {ActiveComponent && <ActiveComponent />}
      </div>
    </div>
  );
}
