/**
 * Titan 3.0 Canvas
 * Full-screen widget grid with floating overlays. No sidebar. No pages.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SpaceEngine } from './SpaceEngine';
import { SandboxRuntime } from '../sandbox/SandboxRuntime';
import type { Space, WidgetDef } from '../types';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { ShortcutsHelp } from '@/components/shared/ShortcutsHelp';
import { trackEvent } from '@/api/telemetry';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// ── Error Boundary ────────────────────────────────────────────
class ErrorBoundary extends React.Component<{ children: React.ReactNode; onError: (e: string) => void }> {
  componentDidCatch(error: any) {
    this.props.onError(error.message);
  }
  render() {
    return this.props.children;
  }
}

function SystemWidgetErrorBoundary({ name, children }: { name: string; children: React.ReactNode }) {
  const [error, setError] = React.useState<string | null>(null);
  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center p-4">
        <span className="text-xs text-red-400">{name}: {error}</span>
      </div>
    );
  }
  return (
    <ErrorBoundary onError={setError}>
      {children}
    </ErrorBoundary>
  );
}

// react-grid-layout v2.x shipped a rewritten API (dragConfig/resizeConfig/
// compactor). Our canvas is written against the v1 API (isDraggable,
// compactType, preventCollision, allowOverlap…) which the package keeps
// alive under the `/legacy` subpath. Importing the legacy wrapper means
// both the types AND the runtime match what we're passing.
const ResponsiveGridLayout = React.lazy(() =>
  import('react-grid-layout/legacy').then(m => ({ default: m.Responsive }))
);
import type { ResizeHandleAxis, Layout } from 'react-grid-layout';

// ── System Widget Imports ─────────────────────────────────────
import { NavWidget } from '../system/NavWidget';
import { ChatWidget, findFirstFreeSlot } from '../system/ChatWidget';
import { FloatingChatDock } from '../system/FloatingChatDock';
import { SpaceInstructionsEditor } from './SpaceInstructionsEditor';
import { WidgetEditor } from './WidgetEditor';
import { WidgetGallery } from './WidgetGallery';
import { CmdPaletteWidget } from '../system/CmdPaletteWidget';
import { SomaWidget } from '../system/SomaWidget';
import { SomaOrb } from '../system/SomaOrb';
import { CommandPostWidget } from '../system/CommandPostWidget';
import { IntelligenceWidget } from '../system/IntelligenceWidget';
import { MemoryGraphWidget } from '../system/MemoryGraphWidget';
import { VoiceWidget } from '../system/VoiceWidget';
import { InfraWidget } from '../system/InfraWidget';
import { ToolsWidget } from '../system/ToolsWidget';
import { SettingsWidget } from '../system/SettingsWidget';
import { FilesWidget } from '../system/FilesWidget';
import {
  SettingsGeneralWidget, SettingsSecurityWidget, SettingsAuditWidget, SettingsSpecialistsWidget, SettingsPrivacyWidget,
  IntelligenceAutopilotWidget, IntelligenceWorkflowsWidget, IntelligenceLearningWidget,
  IntelligenceSelfImproveWidget, IntelligencePersonasWidget,
  InfraHomelabWidget, InfraGpuWidget, InfraFilesWidget, InfraLogsWidget, InfraTelemetryWidget,
  ToolsSkillsWidget, ToolsMcpWidget, ToolsIntegrationsWidget, ToolsChannelsWidget, ToolsMeshWidget,
} from '../system/widgets';

import { AgentsWidget } from '../system/AgentsWidget';
import { HealthWidget } from '../system/HealthWidget';
import { StatsWidget } from '../system/StatsWidget';
import { QuickLinksWidget } from '../system/QuickLinksWidget';

const SYSTEM_COMPONENTS: Record<string, React.FC<any>> = {
  'system:nav': NavWidget,
  'system:chat': ChatWidget,
  'system:cmd': CmdPaletteWidget,
  'system:soma': SomaWidget,
  'system:command-post': CommandPostWidget,
  'system:intelligence': IntelligenceWidget,
  'system:memory-graph': MemoryGraphWidget,
  'system:voice': VoiceWidget,
  'system:infra': InfraWidget,
  'system:tools': ToolsWidget,
  'system:settings': SettingsWidget,
  'system:files': FilesWidget,
  'system:settings-general': SettingsGeneralWidget,
  'system:settings-security': SettingsSecurityWidget,
  'system:settings-audit': SettingsAuditWidget,
  'system:settings-specialists': SettingsSpecialistsWidget,
  'system:settings-privacy': SettingsPrivacyWidget,
  'system:intelligence-autopilot': IntelligenceAutopilotWidget,
  'system:intelligence-workflows': IntelligenceWorkflowsWidget,
  'system:intelligence-learning': IntelligenceLearningWidget,
  'system:intelligence-self-improve': IntelligenceSelfImproveWidget,
  'system:intelligence-personas': IntelligencePersonasWidget,
  'system:infra-homelab': InfraHomelabWidget,
  'system:infra-gpu': InfraGpuWidget,
  'system:infra-files': InfraFilesWidget,
  'system:infra-logs': InfraLogsWidget,
  'system:infra-telemetry': InfraTelemetryWidget,
  'system:tools-skills': ToolsSkillsWidget,
  'system:tools-mcp': ToolsMcpWidget,
  'system:tools-integrations': ToolsIntegrationsWidget,
  'system:tools-channels': ToolsChannelsWidget,
  'system:tools-mesh': ToolsMeshWidget,
  'system:agents': AgentsWidget,
  'system:health': HealthWidget,
  'system:stats': StatsWidget,
  'system:quick-links': QuickLinksWidget,
};

// ── Grid Config ───────────────────────────────────────────────
const GRID_COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 };
const GRID_ROW_HEIGHT = 60;
const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 };
const MARGIN: [number, number] = [12, 12];
const RESIZE_HANDLES: ResizeHandleAxis[] = ['se', 'sw', 'ne', 'nw', 'e', 'w', 'n', 's'];

// ── Memoized Widget Item ──────────────────────────────────────
//
// CRITICAL: react-grid-layout positions widgets by calling
// `React.cloneElement(child, { style, className, onMouseDown, onTouchStart,
// onTouchEnd, ref })`. The child must be a plain DOM element OR a
// `forwardRef` function component that forwards ALL those props + ref
// to its rendered root element. A normal function component that drops
// style/className/ref makes RGL's layout transforms invisible, which is
// why every widget looked full-width-stacked instead of placed on the
// grid. We use `forwardRef` here and forward the whole prop set.
type GridItemInjectedProps = {
  style?: React.CSSProperties;
  className?: string;
  onMouseDown?: React.MouseEventHandler;
  onMouseUp?: React.MouseEventHandler;
  onTouchStart?: React.TouchEventHandler;
  onTouchEnd?: React.TouchEventHandler;
  children?: React.ReactNode;
};
interface MemoWidgetItemProps extends GridItemInjectedProps {
  widget: WidgetDef;
  space: Space;
  onRemove: (id: string) => void;
}
const MemoWidgetItemRaw = React.forwardRef<HTMLDivElement, MemoWidgetItemProps>(
  ({ widget, space, onRemove, style, className, onMouseDown, onMouseUp, onTouchStart, onTouchEnd, children }, ref) => {
    const handleRemove = useCallback(() => onRemove(widget.id), [widget.id, onRemove]);
    return (
      <div
        ref={ref}
        style={style}
        className={className}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <GridWidget widget={widget} space={space} onRemove={handleRemove} />
        {/* RGL injects its resize handle as a child via `children` */}
        {children}
      </div>
    );
  },
);
MemoWidgetItemRaw.displayName = 'MemoWidgetItem';
const MemoWidgetItem = React.memo(MemoWidgetItemRaw);

// ── Widget Renderer ───────────────────────────────────────────

function GridWidgetRaw({ widget, space, onRemove }: { widget: WidgetDef; space: Space; onRemove: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sandboxRef = useRef<SandboxRuntime | null>(null);
  const spaceRef = useRef(space);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep spaceRef fresh so the sandbox message handler always sees current widgets
  useEffect(() => { spaceRef.current = space; }, [space]);

  useEffect(() => {
    if (widget.format === 'system') return;
    if (!iframeRef.current) return;
    if (!widget.source || widget.source.trim() === '') {
      setError('Empty widget — no source code');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    sandboxRef.current = new SandboxRuntime(iframeRef.current, {
      onLog: (logs) => console.log(`[Widget ${widget.id}]`, logs),
    });

    // Wire canvas operations so sandboxed widgets can create/remove widgets.
    // Use spaceRef.current so we always see the latest widget list for placement.
    sandboxRef.current.setMessageHandler((msg) => {
      const s = spaceRef.current;
      if (msg.type === 'canvas' && msg.payload?.action === 'createWidget') {
        const def = msg.payload.def;
        if (!def) return { ok: false, error: 'createWidget requires a `def` object' };
        const w = Number.isFinite(def.w) ? def.w : 4;
        const h = Number.isFinite(def.h) ? def.h : 4;
        const spot = (Number.isFinite(def.x) && Number.isFinite(def.y))
          ? { x: def.x, y: def.y }
          : findFirstFreeSlot(s.widgets || [], w, h);
        try {
          const newWidget = SpaceEngine.addWidget(s.id, {
            name: def.name || 'Agent Widget',
            format: def.format || 'react',
            source: def.source || '',
            x: spot.x,
            y: spot.y,
            w,
            h,
          });
          window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
          return { ok: true, widgetId: newWidget.id };
        } catch (err: any) {
          return { ok: false, error: err.message };
        }
      }
      if (msg.type === 'canvas' && msg.payload?.action === 'updateWidget') {
        const { id, patch } = msg.payload;
        if (!id) return { ok: false, error: 'updateWidget requires an `id`' };
        SpaceEngine.updateWidget(s.id, id, patch || {});
        window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
        return { ok: true, id };
      }
      if (msg.type === 'canvas' && msg.payload?.action === 'listWidgets') {
        return { ok: true, widgets: s.widgets || [] };
      }
      if (msg.type === 'canvas' && msg.payload?.action === 'removeWidget') {
        const id = msg.payload.id;
        if (!id) return { ok: false, error: 'removeWidget requires an `id`' };
        SpaceEngine.removeWidget(s.id, id);
        window.dispatchEvent(new CustomEvent('titan:space:refresh', { detail: { spaceId: s.id } }));
        return { ok: true };
      }
      return { ok: false, error: 'Unknown message type' };
    });

    const timeout = setTimeout(() => {
      setLoading(false);
      setError('Sandbox timeout: widget took longer than 30s to render. Babel (~2MB) or React may be slow to load from unpkg.com. Check network tab in DevTools (F12).');
    }, 30000);

    sandboxRef.current.render(
      widget.format as 'react' | 'vanilla' | 'html',
      widget.source
    ).then(() => {
      clearTimeout(timeout);
      setLoading(false);
    }).catch(err => {
      clearTimeout(timeout);
      setLoading(false);
      setError(String(err));
    });

    return () => {
      clearTimeout(timeout);
      sandboxRef.current?.destroy();
    };
  }, [widget.format, widget.source, widget.id]);

  // System widget
  if (widget.format === 'system') {
    const Component = SYSTEM_COMPONENTS[widget.source];
    if (!Component) {
      return <div className="w-full h-full flex items-center justify-center text-xs text-red-400">Unknown system widget: {widget.source}</div>;
    }
    return (
      <div className="w-full h-full rounded-xl bg-[#18181b]/90 border border-[#27272a]/60 overflow-hidden flex flex-col group hover:border-[#6366f1]/30 transition-colors shadow-lg shadow-black/20">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#27272a]/40 panel-drag-handle cursor-move">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#6366f1]/70">{widget.name}</span>
          <button onClick={onRemove} className="opacity-0 group-hover:opacity-100 text-[#3f3f46] hover:text-red-400 text-xs px-1 transition-opacity">×</button>
        </div>
        <div className="flex-1 overflow-auto relative">
          <SystemWidgetErrorBoundary name={widget.name}>
            <Component space={space} widget={widget} onRemove={onRemove} />
          </SystemWidgetErrorBoundary>
        </div>
      </div>
    );
  }

  // Sandboxed widget — has an inline Edit button (Space Agent parity)
  // that opens the WidgetEditor modal. The editor writes through
  // SpaceEngine.updateWidget; the CRDT observer in TitanCanvas picks up
  // the change and re-renders us with the new (source, format, name),
  // which re-triggers the sandbox render effect above.
  return (
    <div className="w-full h-full rounded-xl bg-[#18181b]/90 border border-[#27272a]/60 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#27272a]/40 panel-drag-handle cursor-move">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6366f1]/70">{widget.name}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('titan:widget:edit', { detail: { spaceId: space.id, widgetId: widget.id } })); }}
            onMouseDown={(e) => e.stopPropagation()}
            className="text-[#52525b] hover:text-[#a5b4fc] px-1"
            title="Edit widget"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m18 2 4 4-14 14H4v-4L18 2z" />
            </svg>
          </button>
          <button onClick={onRemove} className="text-[#3f3f46] hover:text-red-400 text-xs px-1">×</button>
        </div>
      </div>
      <div className="flex-1 relative">
        {error ? (
          <div className="p-3 text-xs text-red-400 font-mono whitespace-pre-wrap">{error}</div>
        ) : (
          <>
            <iframe
              ref={iframeRef}
              className="w-full h-full border-0"
              sandbox="allow-scripts"
              title={widget.name}
            />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/80 text-xs text-[#52525b]">
                <span className="animate-pulse">Loading widget…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
const GridWidget = React.memo(GridWidgetRaw);

// ── Floating Widget ───────────────────────────────────────────

function FloatingWidget({ children, position }: { children: React.ReactNode; position: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' }) {
  const posClass = {
    'bottom-left': 'left-4 bottom-4',
    'bottom-right': 'right-4 bottom-4',
    'top-left': 'left-4 top-4',
    'top-right': 'right-4 top-4',
  }[position];

  return (
    <div className={`fixed ${posClass} z-50`}>
      {children}
    </div>
  );
}

// ── Main Canvas ───────────────────────────────────────────────

export default function TitanCanvas() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const navigate = useNavigate();
  const [space, setSpace] = useState<Space | null>(null);
  // Retained purely for FloatingChatDock's `defaultExpanded` on first
  // mount. Runtime toggles now go through the `titan:chat:toggle`
  // window event so both the ⌘J shortcut and EmptyCanvas's "Open chat"
  // button drive the same dock instance.
  const [chatOpen] = useState(true);
  // Per-space agent instructions editor (Space Agent parity).
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  // Inline widget editor (Space Agent parity). `editingWidgetId` stays
  // null when the modal is closed; a truthy value mounts the modal
  // against the matching widget from current state.
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  // Widget prompt gallery (Space Agent parity).
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(1200);
  const canvasRef = useRef<HTMLDivElement>(null);
  /**
   * The grid measures width from its IMMEDIATE wrapper, not from the
   * full viewport. Previously we observed `canvasRef` (the h-screen
   * w-screen outer div) and passed that straight to ResponsiveGridLayout
   * — but the grid actually renders inside a p-3 padded container, so
   * the 24px * 2 padding was excluded from the available width while
   * RGL still believed every column spanned the full viewport. That's
   * why Tony couldn't drag widgets to the far right: the grid was
   * computing positions in a wider coordinate space than what fit
   * inside the padded wrapper. Measuring `gridWrapRef` (the inner
   * wrapper) gives RGL the truthful container width so widgets can
   * reach both edges and be dropped anywhere in between.
   */
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const { info: updateInfo, triggerUpdate } = useUpdateCheck();
  const [updating, setUpdating] = useState(false);

  // Load space
  useEffect(() => {
    const id = spaceId || 'home';
    const s = SpaceEngine.get(id);
    if (s) {
      setSpace(s);
    } else {
      // Fallback to home
      navigate('/space/home', { replace: true });
    }
  }, [spaceId, navigate]);

  // Resize observer — watches the grid's actual wrapper, not the viewport.
  // Retry-observes once the ref lands because `gridWrapRef` is inside a
  // conditional render (EmptyCanvas vs. ResponsiveGridLayout) and may
  // not be mounted on the first effect pass.
  useEffect(() => {
    const attach = () => {
      const el = gridWrapRef.current;
      if (!el) return null;
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) setCanvasWidth(entry.contentRect.width);
      });
      ro.observe(el);
      // Seed an initial width synchronously so the first render isn't
      // stuck at the useState default (1200) while RO wakes up.
      setCanvasWidth(el.getBoundingClientRect().width || 1200);
      return ro;
    };
    let ro = attach();
    // If EmptyCanvas was showing first, the grid wrapper mounts later —
    // poll briefly until it appears.
    const poll = setInterval(() => {
      if (!ro) ro = attach();
      if (ro) clearInterval(poll);
    }, 200);
    return () => { ro?.disconnect(); clearInterval(poll); };
  }, [space?.id]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdOpen(v => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('titan:chat:toggle'));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useKeyboardShortcuts([
    { key: '?', action: () => setShortcutsOpen(true), description: 'Show keyboard shortcuts help' },
    { key: 'g', shift: true, action: () => navigate('/space/command'), description: 'Go to Command Post space' },
    { key: 'h', shift: true, action: () => navigate('/space/home'), description: 'Go to Home space' },
    { key: 's', shift: true, action: () => navigate('/space/settings'), description: 'Go to Settings space' },
    { key: 'i', shift: true, action: () => navigate('/space/intelligence'), description: 'Go to Intelligence space' },
  ]);

  // Layout persistence is handled via onDragStop / onResizeStop instead of
  // onLayoutChange to avoid the re-render → re-compaction → infinite
  // recursion loop that crashes with RangeError.
  const handleLayoutChange = useCallback(() => {
    // NO-OP — RGL fires this on every render; persisting here causes loops.
  }, []);

  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLayoutRef = useRef<Layout | null>(null);

  const persistLayout = useCallback((layout: Layout) => {
    if (!space) return;
    pendingLayoutRef.current = layout;
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      const pending = pendingLayoutRef.current;
      if (!pending || !space) return;
      SpaceEngine.updateLayout(space.id, pending.map(l => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })));
      pendingLayoutRef.current = null;
      persistTimeoutRef.current = null;
    }, 50);
  }, [space]);

  const handleRemoveWidget = useCallback((widgetId: string) => {
    if (!space) return;
    const widget = space.widgets?.find(w => w.id === widgetId);
    trackEvent('canvas_panel_removed', { widgetId, format: widget?.format, source: widget?.source });
    SpaceEngine.removeWidget(space.id, widgetId);
    const current = Array.isArray(space.widgets) ? space.widgets : [];
    setSpace({ ...space, widgets: current.filter(w => w.id !== widgetId) });
  }, [space]);

  const handleAddWidget = useCallback((def: Omit<WidgetDef, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!space) return;
    const widget = SpaceEngine.addWidget(space.id, def);
    const current = Array.isArray(space.widgets) ? space.widgets : [];
    setSpace({ ...space, widgets: [...current, widget] });
    trackEvent(def.format === 'system' ? 'canvas_system_panel_created' : 'canvas_panel_created', {
      source: def.source,
      name: def.name,
      format: def.format,
    });
    return widget;
  }, [space]);

  // Find first empty slot on the grid for auto-placement
  const findEmptySpot = useCallback((w: number, h: number): { x: number; y: number } => {
    if (!space || !Array.isArray(space.widgets) || space.widgets.length === 0) return { x: 0, y: 0 };
    const cols = 12;
    const grid = new Set<string>();
    for (const widget of space.widgets) {
      for (let dx = 0; dx < widget.w; dx++) {
        for (let dy = 0; dy < widget.h; dy++) {
          grid.add(`${widget.x + dx},${widget.y + dy}`);
        }
      }
    }
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x <= cols - w; x++) {
        let free = true;
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 0; dy < h; dy++) {
            if (grid.has(`${x + dx},${y + dy}`)) { free = false; break; }
          }
          if (!free) break;
        }
        if (free) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }, [space]);

  const handleAddSystemWidget = useCallback((source: string, name: string, w = 4, h = 4) => {
    const spot = findEmptySpot(w, h);
    handleAddWidget({ name, format: 'system', source, x: spot.x, y: spot.y, w, h });
  }, [handleAddWidget, findEmptySpot]);

  // Listen for space refresh events (e.g., agent created widgets)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      console.log('[TitanCanvas] titan:space:refresh received:', detail);
      if (!space) return;
      if (detail?.spaceId === space.id) {
        const refreshed = SpaceEngine.get(space.id);
        if (refreshed) {
          console.log('[TitanCanvas] Refreshing space, widget count:', refreshed.widgets.length);
          setSpace(refreshed);
        }
      }
    };
    window.addEventListener('titan:space:refresh', handler);
    return () => window.removeEventListener('titan:space:refresh', handler);
  }, [space]);

  // Listen for widget-add requests from QuickLinksWidget and other sources
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!space) return;
      if (detail?.source) {
        const name = detail.source.replace('system:', '').replace(/-/g, ' ');
        handleAddSystemWidget(detail.source, name, detail.w || 4, detail.h || 4);
      }
    };
    window.addEventListener('titan:widget:add', handler);
    return () => window.removeEventListener('titan:widget:add', handler);
  }, [space, handleAddSystemWidget]);

  // Listen for widget-edit requests fired from each widget's header
  // pencil. We keep this as a window event rather than drilling a prop
  // down through MemoWidgetItem → GridWidget so React.memo stays effective.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!space) return;
      if (detail?.spaceId === space.id && typeof detail?.widgetId === 'string') {
        setEditingWidgetId(detail.widgetId);
      }
    };
    window.addEventListener('titan:widget:edit', handler);
    return () => window.removeEventListener('titan:widget:edit', handler);
  }, [space]);

  // Observe CRDT changes from other tabs/users
  useEffect(() => {
    if (!space) return;
    const unsub = SpaceEngine.observe(space.id, (widgets) => {
      console.log('[TitanCanvas] CRDT observer fired, widgets:', widgets.length);
      setSpace(prev => prev ? { ...prev, widgets } : prev);
    });
    return unsub;
  }, [space?.id]);

  // Hooks MUST run on every render in the same order. `validWidgets` +
  // `gridLayout` are memoized ABOVE the early-return for `!space` so the hook
  // count stays stable. Previously this was below the early-return, which
  // caused React error #310 ("Rendered more hooks than during the previous
  // render") the first time `setSpace` populated state after the initial
  // null render.
  //
  // Defensive: if `space.widgets` ever ends up as a non-array (corrupted
  // localStorage / Yjs merge quirk / older bundle state in IDB) we return
  // an empty array instead of throwing "X.filter is not a function" or
  // "object is not iterable" mid-render and taking down the whole canvas.
  const validWidgets = useMemo(() => {
    const w = space?.widgets;
    if (!Array.isArray(w)) return [];
    return w.filter(Boolean);
  }, [space]);
  // Explicit per-item bounds so resize isn't silently capped.
  //
  // Without these RGL uses `minW=0, maxW=cols`. The *visual* problem Tony
  // hit ("can't resize bigger than a smaller square") was actually the
  // invisible default `.react-resizable-handle` icon (black triangle at
  // 0.3 opacity — invisible on our near-black widget background). We fix
  // the handle visibility in the styled <div> below, AND stamp large
  // explicit bounds here so the grid engine can't silently clip the
  // widget back down.
  const gridLayout = useMemo(() => validWidgets.map((w, i) => ({
    i: w.id,
    x: Number.isFinite(w.x) ? w.x : (i % 3) * 4,
    y: Number.isFinite(w.y) ? w.y : Math.floor(i / 3) * 4,
    w: Number.isFinite(w.w) ? w.w : 4,
    h: Number.isFinite(w.h) ? w.h : 4,
    minW: 2,
    minH: 2,
    maxW: 12,
    maxH: 40,
  })), [validWidgets]);

  if (!space) {
    return (
      <div className="h-screen w-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-[#52525b] text-sm">Loading space...</div>
      </div>
    );
  }

  return (
    <div ref={canvasRef} className="h-screen w-screen bg-[#0a0a0f] relative overflow-auto">
      {/*
        Resize-handle overrides — fix "cannot resize bigger than a
        smaller square" (Tony, v5.0). The default react-resizable SVG
        icon is a black triangle at opacity 0.3, invisible on our dark
        widget bg. These replacements:
          - Remove the background-image + pad arrow
          - Paint a visible chevron in the accent ring colour
          - Grow the hit area to 22x22 for corners and full-edge strips
            for n/s/e/w so resizing feels generous like Space Agent
          - Light up on hover so the user can SEE the handle exists
        Scoped to `.titan-canvas-grid` so we don't leak to Mission
        Control or any other RGL usage in the app.
      */}
      <style>{`
        .titan-canvas-grid .react-grid-item > .react-resizable-handle {
          background: none;
          padding: 0;
          opacity: 0.35;
          z-index: 10;
          transition: opacity 120ms ease, background-color 120ms ease;
        }
        .titan-canvas-grid .react-grid-item:hover > .react-resizable-handle { opacity: 0.85; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle:hover,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle:active { opacity: 1; }
        /* Corner handles: 22x22 with a ring-coloured chevron */
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-se,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-sw,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-ne,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-nw {
          width: 22px;
          height: 22px;
          background-image: none;
          transform: none;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-se::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-sw::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-ne::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-nw::after {
          content: "";
          position: absolute;
          width: 12px; height: 12px;
          border: 2px solid #6366f1;
          border-radius: 3px;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-se::after { right: 3px;  bottom: 3px; border-top: none; border-left: none; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-sw::after { left: 3px;   bottom: 3px; border-top: none; border-right: none; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-ne::after { right: 3px;  top: 3px;    border-bottom: none; border-left: none; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-nw::after { left: 3px;   top: 3px;    border-bottom: none; border-right: none; }
        /* Edge handles: full-edge strips with a centre grip */
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-e,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-w {
          top: 8px; bottom: 8px; height: auto; margin-top: 0;
          width: 8px; background-image: none; transform: none;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-n,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-s {
          left: 8px; right: 8px; width: auto; margin-left: 0;
          height: 8px; background-image: none; transform: none;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-e::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-w::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-n::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-s::after {
          content: ""; position: absolute; background: #6366f1; border-radius: 2px;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-e::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-w::after {
          top: 50%; transform: translateY(-50%);
          width: 3px; height: 32px;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-e::after { right: 2px; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-w::after { left: 2px; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-n::after,
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-s::after {
          left: 50%; transform: translateX(-50%);
          height: 3px; width: 32px;
        }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-n::after { top: 2px; }
        .titan-canvas-grid .react-grid-item > .react-resizable-handle-s::after { bottom: 2px; }
        /* Allow resizing and dragging freely — placeholder turns accent blue */
        .titan-canvas-grid .react-grid-placeholder {
          background: rgba(99, 102, 241, 0.14) !important;
          border: 1px dashed rgba(99, 102, 241, 0.55) !important;
          border-radius: 12px;
          opacity: 1 !important;
        }
      `}</style>
      {/* Background texture — fixed so it covers the scrollable area */}
      <div className="fixed inset-0 opacity-[0.03] pointer-events-none" style={{
        backgroundImage: `radial-gradient(circle at 1px 1px, rgba(99,102,241,0.5) 1px, transparent 0)`,
        backgroundSize: '24px 24px',
      }} />

      {/* Space header */}
      <div className="absolute top-0 left-0 right-0 h-10 flex items-center justify-between px-4 z-40 border-b border-[#27272a]/30 bg-[#0a0a0f]/80 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-bold uppercase tracking-widest" style={{ color: space.color || '#6366f1' }}>
            {space.name}
          </span>
          {/*
            Instructions row. Clicking opens the SpaceInstructionsEditor.
            Shows the current instructions preview when set, or a "+ Add
            agent instructions" affordance when empty — Tony's Space
            Agent parity ask.
          */}
          <button
            onClick={() => setInstructionsOpen(true)}
            className="flex items-center gap-1.5 text-[10px] text-[#52525b] hover:text-[#a5b4fc] truncate max-w-md transition-colors"
            title="Edit agent instructions for this space"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="m18 2 4 4-14 14H4v-4L18 2z" />
            </svg>
            {space.agentInstructions
              ? <span className="truncate">{space.agentInstructions}</span>
              : <span className="italic">add agent instructions</span>}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Widget count + quick-add + clear */}
          <span className="text-[10px] text-[#52525b]">{validWidgets.length} panel{validWidgets.length !== 1 ? 's' : ''}</span>
          <button
            onClick={() => handleAddSystemWidget('system:nav', 'Nav', 3, 4)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 hover:bg-[#6366f1]/10 transition-colors"
            title="Add Navigation"
          >
            Nav
          </button>
          <button
            onClick={() => handleAddSystemWidget('system:agents', 'Agents', 3, 4)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 hover:bg-[#6366f1]/10 transition-colors"
            title="Add Agents"
          >
            Agents
          </button>
          <button
            onClick={() => handleAddSystemWidget('system:health', 'Health', 3, 3)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 hover:bg-[#6366f1]/10 transition-colors"
            title="Add Health"
          >
            Health
          </button>
          <button
            onClick={() => handleAddSystemWidget('system:stats', 'Stats', 3, 4)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 hover:bg-[#6366f1]/10 transition-colors"
            title="Add Stats"
          >
            Stats
          </button>
          <button
            onClick={() => handleAddSystemWidget('system:quick-links', 'Quick Links', 3, 4)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 hover:bg-[#6366f1]/10 transition-colors"
            title="Add Quick Links"
          >
            Links
          </button>
          <button
            onClick={() => handleAddSystemWidget('system:chat', 'Chat', 4, 5)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#6366f1]/5 border border-[#6366f1]/10 text-[#818cf8]/70 hover:bg-[#6366f1]/10 transition-colors"
            title="Add Chat"
          >
            Chat
          </button>
          {validWidgets.length > 0 && (
            <button
              onClick={async () => {
                trackEvent('canvas_clear_all', { panelCount: validWidgets.length });
                if (space) {
                  await SpaceEngine.clearSpace(space.id);
                  setSpace({ ...space, widgets: [] });
                }
              }}
              className="text-[10px] px-2 py-1 rounded-md bg-[#ef4444]/5 border border-[#ef4444]/10 text-[#ef4444]/70 hover:bg-[#ef4444]/10 transition-colors"
            >
              Clear
            </button>
          )}
          {/* Version chip */}
          <button
            disabled={updating}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${updateInfo?.isNewer ? 'bg-[#f59e0b]/10 border-[#f59e0b]/30 text-[#f59e0b] hover:bg-[#f59e0b]/20 cursor-pointer' : 'bg-[#18181b] border-[#27272a] text-[#52525b]'}`}
            title={updateInfo?.isNewer ? `Update available: ${updateInfo.current} → ${updateInfo.latest}` : `TITAN ${updateInfo?.current || ''}`}
            onClick={async () => {
              if (!updateInfo?.isNewer || updating) return;
              if (!confirm(`Update TITAN from ${updateInfo.current} → ${updateInfo.latest}?

Your data in ~/.titan/ will be preserved. The gateway will restart after the update.`)) return;
              setUpdating(true);
              const result = await triggerUpdate(true);
              setUpdating(false);
              if (result.ok) {
                alert('Update initiated. The gateway will restart shortly. Please refresh the page in 10-15 seconds.');
              } else {
                alert(`Update failed: ${result.error || 'Unknown error'}`);
              }
            }}
          >
            {updating ? '…' : updateInfo?.isNewer ? `↑ ${updateInfo.latest}` : `v${updateInfo?.current || ''}`}
          </button>
          <button
            onClick={() => setGalleryOpen(true)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#18181b] border border-[#27272a] text-[#a78bfa] hover:bg-[#a78bfa]/10 transition-colors flex items-center gap-1.5"
            title="Widget gallery"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.8L20 10l-5 3.6 1.5 6L12 16l-4.5 3.6L9 13.6 4 10l6.1-1.2L12 3z" />
            </svg>
            Gallery
          </button>
          <button
            onClick={() => setCmdOpen(true)}
            className="text-[10px] px-2 py-1 rounded-md bg-[#18181b] border border-[#27272a] text-[#52525b] hover:text-[#a1a1aa] transition-colors"
          >
            ⌘K
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('titan:chat:toggle'))}
            className="text-[10px] px-2 py-1 rounded-md bg-[#18181b] border border-[#27272a] text-[#52525b] hover:text-[#a1a1aa] transition-colors"
          >
            ⌘J
          </button>
        </div>
      </div>

      {/* Widget Grid — unlimited scrollable canvas */}
      {/* Dropped the p-3 padding — RGL computes positions relative to this
          wrapper's width, and any extra CSS padding lied about the
          available horizontal room. containerPadding on the grid itself
          handles the inner gutter. */}
      <div ref={gridWrapRef} className="relative pt-10 min-h-[5000px]">
        {validWidgets.length === 0 ? (
          <EmptyCanvas space={space} onAddWidget={handleAddSystemWidget} onOpenChat={() => window.dispatchEvent(new CustomEvent('titan:chat:toggle', { detail: { open: true } }))} />
        ) : (
          <Suspense fallback={<div className="text-[#52525b] text-sm">Loading grid...</div>}>
            <ResponsiveGridLayout
              className="layout titan-canvas-grid"
              width={canvasWidth}
              layouts={{ lg: gridLayout }}
              breakpoints={BREAKPOINTS}
              cols={GRID_COLS}
              rowHeight={GRID_ROW_HEIGHT}
              margin={MARGIN}
              // Match the visual padding that used to live on the wrapper.
              // RGL does the math itself so widget positions stay truthful
              // and placeholders land exactly where the drop preview shows.
              containerPadding={[12, 12]}
              /*
               * react-grid-layout's real prop names. The previous build was
               * passing `dragConfig` / `resizeConfig` objects the library did
               * not understand; they were silently discarded along with the
               * draggable-handle selector, which is why the grid stopped
               * placing items and everything collapsed to full-width stacks.
               */
              isDraggable
               isResizable
               draggableHandle=".panel-drag-handle"
               resizeHandles={RESIZE_HANDLES}
               /* Space Agent-style free placement. `compactType={null}`
                * keeps widgets exactly where the user drops them —
                * no auto-pack, no snap. Combined with allowOverlap =
                * true this is the "unlimited customization" Tony asked
                * for: drop anything anywhere, even on top of another
                * widget, and it stays. */
               compactType={null}
               preventCollision={false}
               allowOverlap
               useCSSTransforms
              onLayoutChange={handleLayoutChange}
              onDragStop={(_layout: Layout) => {
                persistLayout(_layout);
              }}
              onResizeStop={(_layout: Layout) => {
                persistLayout(_layout);
              }}
            >
              {validWidgets.map(widget => (
                <MemoWidgetItem
                  key={widget.id}
                  widget={widget}
                  space={space}
                  onRemove={handleRemoveWidget}
                />
              ))}
            </ResponsiveGridLayout>
          </Suspense>
        )}
      </div>

      {/* Floating Nav */}
      <FloatingWidget position="bottom-left">
        <NavWidget
          currentSpaceId={space.id}
          onSpaceSelect={(id) => navigate(`/space/${id}`)}
        />
      </FloatingWidget>

      {/*
        Floating Chat Dock — v5.0 "Spacewalk" unification. Replaces both
        the old bottom-right floating ChatWidget AND the grid-mounted
        `home-chat` widget. Single mascot, draggable anywhere (Space
        Agent-style). Click the mascot to expand/collapse the attached
        chat panel. The `chatOpen` boolean is kept for keyboard-shortcut
        parity (⌘J toggles it) but FloatingChatDock owns its own
        expanded state internally via the mascot click.
      */}
      <FloatingChatDock space={space} defaultExpanded={chatOpen} />

      {/* Per-space agent instructions editor — opened from the header. */}
      <SpaceInstructionsEditor
        space={space}
        open={instructionsOpen}
        onClose={() => setInstructionsOpen(false)}
        onSaved={(instructions) => {
          setSpace(prev => prev ? { ...prev, agentInstructions: instructions || undefined } : prev);
        }}
      />

      {/* Inline widget editor — opened via the pencil icon in any
          sandboxed widget's header. The SpaceEngine.updateWidget write
          triggers the CRDT observer which refreshes local state, so we
          don't need to hand-roll optimistic rendering here. */}
      {editingWidgetId && (() => {
        const target = validWidgets.find(w => w.id === editingWidgetId);
        if (!target || target.format === 'system') { setEditingWidgetId(null); return null; }
        return (
          <WidgetEditor
            widget={target}
            spaceId={space.id}
            open
            onClose={() => setEditingWidgetId(null)}
          />
        );
      })()}

      {/* Widget prompt gallery — curated prompts that pipe into the
          chat dock via titan:chat:prompt + titan:chat:toggle. */}
      <WidgetGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />

      {/* SOMA Orb — always present */}
      <SomaOrb />

      {/* Command Palette */}
      {cmdOpen && (
        <CmdPaletteWidget
          currentSpaceId={space.id}
          onSpaceSelect={(id) => { navigate(`/space/${id}`); setCmdOpen(false); }}
          onAction={(action) => {
            if (action.type === 'widget') {
              handleAddSystemWidget(action.source, action.name, action.w, action.h);
            }
            setCmdOpen(false);
          }}
          onClose={() => setCmdOpen(false)}
        />
      )}

      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

// ── Empty Canvas ──────────────────────────────────────────────

function EmptyCanvas({ space, onAddWidget, onOpenChat }: {
  space: Space;
  onAddWidget: (source: string, name: string, w?: number, h?: number) => void;
  onOpenChat: () => void;
}) {
  const examples = [
    { label: 'SOMA', source: 'system:soma', w: 6, h: 6 },
    { label: 'Command Post', source: 'system:command-post', w: 8, h: 6 },
    { label: 'Intelligence', source: 'system:intelligence', w: 6, h: 5 },
    { label: 'Memory Graph', source: 'system:memory-graph', w: 8, h: 7 },
    { label: 'Voice', source: 'system:voice', w: 5, h: 5 },
    { label: 'Files', source: 'system:files', w: 4, h: 6 },
    { label: 'Infra', source: 'system:infra', w: 6, h: 4 },
    { label: 'Tools', source: 'system:tools', w: 5, h: 4 },
  ];

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-lg">
        <div className="w-16 h-16 rounded-2xl bg-[#6366f1]/5 border border-[#6366f1]/10 flex items-center justify-center mx-auto mb-5">
          <svg className="w-7 h-7 text-[#6366f1]/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-[#fafafa] mb-2">{space.name}</h2>
        <p className="text-sm text-[#52525b] mb-6">
          This space is empty. Ask the agent to create widgets, or add system widgets below.
        </p>
        <div className="flex gap-2 justify-center mb-6 flex-wrap">
          <button
            onClick={onOpenChat}
            className="px-4 py-2 rounded-xl bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-sm font-medium hover:bg-[#6366f1]/20 transition-all"
          >
            Ask Agent
          </button>
        </div>
        <div className="flex gap-2 justify-center flex-wrap">
          {examples.map(ex => (
            <button
              key={ex.source}
              onClick={() => onAddWidget(ex.source, ex.label, ex.w, ex.h)}
              className="px-3 py-1.5 rounded-lg bg-[#18181b] border border-[#27272a] text-[11px] text-[#52525b] hover:text-[#a1a1aa] hover:border-[#3f3f46] transition-all"
            >
              + {ex.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
