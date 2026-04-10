import { useState } from 'react';
import { useResizable } from '../../hooks/useResizable';
import ChatView from '../chat/ChatView';
import ActivityPanel from './ActivityPanel';
import ResizeHandle from '../shell/ResizeHandle';

export default function MissionView({ onVoiceOpen }: { onVoiceOpen?: () => void }) {
  const [activityCollapsed, setActivityCollapsed] = useState(false);
  const { size, isResizing, startResize, containerRef } = useResizable({
    direction: 'horizontal',
    initialSize: 60,
    minSize: 40,
    maxSize: 85,
    storageKey: 'titan-mission-split',
  });

  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      {/* Chat Panel (left) */}
      <div
        className="min-w-0 overflow-hidden"
        style={{ width: activityCollapsed ? '100%' : `${size}%` }}
      >
        <ChatView
          onVoiceOpen={onVoiceOpen}
          onToggleActivity={() => setActivityCollapsed(!activityCollapsed)}
          activityCollapsed={activityCollapsed}
        />
      </div>

      {/* Resize Handle */}
      {!activityCollapsed && (
        <ResizeHandle isResizing={isResizing} onMouseDown={startResize} />
      )}

      {/* Activity Panel (right) */}
      {!activityCollapsed && (
        <div
          className="min-w-0 overflow-hidden border-l border-white/[0.04]"
          style={{ width: `${100 - size}%`, background: 'var(--color-bg-secondary)' }}
        >
          <ActivityPanel />
        </div>
      )}
    </div>
  );
}
