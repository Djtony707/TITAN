import { X, PanelRight } from 'lucide-react';
import { usePanel } from '@/context/PanelContext';

/* ═══════════════════════════════════════════════════════════════════
   Properties Panel — Contextual side panel for details/actions
   Pattern ported from Space Agent (Paperclip)
   ═══════════════════════════════════════════════════════════════════ */

export function PropertiesPanel() {
  const { panelContent, panelVisible, closePanel, togglePanelVisible } = usePanel();

  return (
    <>
      {/* Toggle button when panel is empty/hidden */}
      {!panelVisible && !panelContent && (
        <button
          onClick={togglePanelVisible}
          className="hidden lg:flex items-center justify-center w-8 h-8 rounded-lg bg-[#18181b] border border-[#27272a] text-[#52525b] hover:text-[#a1a1aa] hover:border-[#6366f1]/20 transition-all fixed right-4 top-20 z-30"
          title="Open properties panel"
        >
          <PanelRight className="w-4 h-4" />
        </button>
      )}

      {/* Panel */}
      <div
        className={`hidden lg:flex flex-col bg-[#09090b] border-l border-[#27272a] transition-all duration-200 ease-out overflow-hidden ${
          panelVisible && panelContent ? 'w-80 opacity-100' : 'w-0 opacity-0'
        }`}
      >
        {panelVisible && panelContent && (
          <div className="flex flex-col h-full w-80">
            {/* Panel header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#27272a]">
              <span className="text-xs font-bold uppercase tracking-wider text-[#818cf8]">Properties</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={closePanel}
                  className="p-1 rounded hover:bg-[#27272a] text-[#52525b] hover:text-[#ef4444] transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Panel content */}
            <div className="flex-1 overflow-y-auto p-4">
              {panelContent}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
