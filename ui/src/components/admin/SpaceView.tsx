import React, { useState, useRef, useEffect, Suspense } from 'react';
import { useCanvas } from '@/space-agent/CanvasContext';
import { CanvasBackdrop } from '@/components/shared/CanvasBackdrop';
import CommsPanel from '@/space-agent/CommsPanel';
import { NavWidget, AgentsWidget, HealthWidget, QuickLinksWidget, StatsWidget, ChatWidget, SkillsWidget, FilesWidget, SettingsWidget } from '@/space-agent/SystemWidgets';
import { X, GripHorizontal, Sparkles, Trash2, LayoutGrid, Hexagon, Compass, Bot, Activity, Gauge, Zap, MessageSquare, FileText } from 'lucide-react';
import { trackEvent } from '@/api/telemetry';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = React.lazy(() =>
  import('react-grid-layout').then(m => ({ default: m.Responsive }))
);

function PanelCard({ widget, onRemove, runtime }: { widget: any; onRemove: (id: string) => void; runtime: any }) {
  const Component = widget.component;
  const [error, setError] = React.useState<string | null>(null);

  if (!Component) {
    return (
      <div className="w-full h-full rounded-xl bg-[#18181b]/80 border border-[#27272a] flex items-center justify-center">
        <span className="text-xs text-[#52525b]">Loading panel...</span>
      </div>
    );
  }

  return (
    <div className="w-full h-full rounded-xl bg-[#18181b]/90 border border-[#27272a]/60 backdrop-blur-sm overflow-hidden flex flex-col group hover:border-[#6366f1]/30 transition-colors shadow-lg shadow-black/20">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a]/40 panel-drag-handle cursor-move">
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3.5 h-3.5 text-[#3f3f46]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#6366f1]/70">{widget.title}</span>
        </div>
        <button
          onClick={() => onRemove(widget.id)}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#ef4444]/10 text-[#71717a] hover:text-[#ef4444] transition-all"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      {/* Panel body */}
      <div className="flex-1 overflow-hidden relative">
        {error ? (
          <div className="w-full h-full flex items-center justify-center p-4">
            <span className="text-xs text-[#ef4444]">{error}</span>
          </div>
        ) : (
          <ErrorBoundary onError={setError}>
            <Component runtime={runtime} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode; onError: (e: string) => void }> {
  componentDidCatch(error: any) {
    this.props.onError(error.message);
  }
  render() {
    return this.props.children;
  }
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <div className="w-20 h-20 rounded-2xl bg-[#6366f1]/5 border border-[#6366f1]/10 flex items-center justify-center mx-auto mb-5">
          <Hexagon className="w-8 h-8 text-[#6366f1]/40" />
        </div>
        <h2 className="text-lg font-bold text-[#fafafa] mb-2">Your Canvas is Empty</h2>
        <p className="text-sm text-[#52525b] max-w-sm mx-auto mb-6">
          Ask the TITAN Canvas AI to create panels, dashboards, and tools for you. 
          Try "Create a system monitor" or "Make a chart panel".
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onCreate}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-sm font-medium hover:bg-[#6366f1]/20 transition-all"
          >
            <Sparkles className="w-4 h-4" />
            Open Comms
          </button>
        </div>
        <div className="mt-8 flex gap-3 justify-center flex-wrap">
          {['System Monitor', 'Data Chart', 'Terminal', 'Clock', 'Node Table', 'Weather', 'Crypto', 'Tasks'].map(label => (
            <span key={label} className="px-2.5 py-1 rounded-lg bg-[#18181b] border border-[#27272a] text-[10px] text-[#52525b]">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SpaceView() {
  const { widgets, runtime } = useCanvas();
  const [chatOpen, setChatOpen] = useState(true);
  const [canvasWidth, setCanvasWidth] = useState(1200);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width);
      }
    });
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  // Listen for comms:open event from widgets
  useEffect(() => {
    const unsub = runtime.on('comms:open', () => setChatOpen(true));
    return unsub;
  }, [runtime]);

  const gridLayout = widgets.map((w, i) => ({
    i: w.id,
    x: w.x ?? (i % 3) * 4,
    y: w.y ?? Math.floor(i / 3) * 4,
    w: w.w ?? 4,
    h: w.h ?? 4,
  }));

  const handleLayoutChange = () => {
    // Layout changes are handled by react-grid-layout internally
  };

  return (
    <div className="flex h-full w-full overflow-hidden relative bg-[#09090b]">
      <CanvasBackdrop />

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center">
            <Hexagon className="w-4 h-4 text-[#6366f1]" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-[#fafafa]">TITAN Canvas</h1>
            <p className="text-[10px] text-[#52525b]">{widgets.length} panel{widgets.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runtime.widgets.createSystem('Navigation', NavWidget, 3, 4)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Navigation widget"
          >
            <Compass className="w-3 h-3" />
            Nav
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Agents', AgentsWidget, 3, 4)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Agents widget"
          >
            <Bot className="w-3 h-3" />
            Agents
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Health', HealthWidget, 3, 3)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Health widget"
          >
            <Activity className="w-3 h-3" />
            Health
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Stats', StatsWidget, 3, 4)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Stats widget"
          >
            <Gauge className="w-3 h-3" />
            Stats
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Quick Links', QuickLinksWidget, 3, 4)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Quick Links widget"
          >
            <Zap className="w-3 h-3" />
            Links
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Chat', ChatWidget, 4, 5)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Chat widget"
          >
            <MessageSquare className="w-3 h-3" />
            Chat
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Skills', SkillsWidget, 3, 4)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Skills widget"
          >
            <Sparkles className="w-3 h-3" />
            Skills
          </button>
          <button
            onClick={() => runtime.widgets.createSystem('Files', FilesWidget, 3, 5)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
            title="Add Files widget"
          >
            <FileText className="w-3 h-3" />
            Files
          </button>
          {widgets.length > 0 && (
            <button
              onClick={() => {
                trackEvent('canvas_clear_all', { panelCount: widgets.length });
                widgets.forEach(w => runtime.widgets.remove(w.id));
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#ef4444]/5 border border-[#ef4444]/10 text-[#ef4444]/70 text-xs hover:bg-[#ef4444]/10 transition-all"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </button>
          )}
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 text-xs hover:bg-[#6366f1]/10 transition-all"
          >
            <Sparkles className="w-3 h-3" />
            {chatOpen ? 'Hide Comms' : 'Show Comms'}
          </button>
        </div>
      </div>

      {/* Main canvas */}
      <div ref={canvasRef} className="flex-1 relative z-10 overflow-auto pt-16 pb-4 px-4">
        {widgets.length === 0 ? (
          <EmptyState onCreate={() => setChatOpen(true)} />
        ) : (
          <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="text-[#52525b] text-sm">Loading grid...</span></div>}>
            <ResponsiveGridLayout
              width={canvasWidth}
              layouts={{ lg: gridLayout }}
              breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
              cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
              rowHeight={60}
              margin={[12, 12]}
              dragConfig={{ enabled: true, handle: '.panel-drag-handle', bounded: false, threshold: 3 }}
              resizeConfig={{ enabled: true, handles: ['se'] }}
              onLayoutChange={handleLayoutChange}
            >
              {widgets.map(w => (
                <div key={w.id}>
                  <PanelCard widget={w} onRemove={runtime.widgets.remove} runtime={runtime} />
                </div>
              ))}
            </ResponsiveGridLayout>
          </Suspense>
        )}
      </div>

      {/* Comms Panel */}
      {chatOpen && <CommsPanel />}
    </div>
  );
}
