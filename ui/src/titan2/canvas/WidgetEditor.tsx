/**
 * WidgetEditor — Space Agent parity (v5.0).
 *
 * Click a sandboxed widget's pencil icon → this modal opens with the
 * widget's source code + format. Save rewrites the widget via
 * SpaceEngine.updateWidget and pushes the previous (source, format)
 * pair onto a version history so the user can revert.
 *
 * Not for `format: 'system'` widgets — those ship with TITAN and aren't
 * user-editable; the caller should gate the open-editor button on the
 * widget's format.
 *
 * Design choices:
 *   - Plain <textarea> for the source (no Monaco — keeps the bundle
 *     small; users editing real code can copy to their own editor).
 *   - Format switcher limited to react / vanilla / html — same set
 *     SandboxRuntime.render supports.
 *   - Version history capped at WIDGET_HISTORY_MAX entries. Older
 *     entries fall off the end as new saves come in.
 *   - ⌘/Ctrl + Enter saves; Esc closes without saving; backdrop click
 *     closes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Save, History, RotateCcw, Pencil } from 'lucide-react';
import { SpaceEngine } from './SpaceEngine';
import type { WidgetDef, WidgetFormat, WidgetVersion } from '../types';

const WIDGET_HISTORY_MAX = 12;
const FORMATS: WidgetFormat[] = ['react', 'vanilla', 'html'];

interface Props {
    widget: WidgetDef;
    spaceId: string;
    open: boolean;
    onClose: () => void;
    /** Notify the canvas so it can re-render the widget immediately. */
    onSaved?: (next: WidgetDef) => void;
}

export function WidgetEditor({ widget, spaceId, open, onClose, onSaved }: Props) {
    const [draftSource, setDraftSource] = useState(widget.source);
    const [draftFormat, setDraftFormat] = useState<WidgetFormat>(widget.format as WidgetFormat);
    const [draftName, setDraftName] = useState(widget.name);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Reset drafts whenever the widget or the modal's open flag flips.
    // Without this the modal would show last-edit's text when re-opened
    // against a different widget.
    useEffect(() => {
        if (open) {
            setDraftSource(widget.source);
            setDraftFormat(widget.format as WidgetFormat);
            setDraftName(widget.name);
            setError(null);
            setShowHistory(false);
            const t = setTimeout(() => textareaRef.current?.focus(), 50);
            return () => clearTimeout(t);
        }
    }, [open, widget.id, widget.source, widget.format, widget.name]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { void save(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            // Push previous state to history IFF source/format actually
            // changed — a rename-only save shouldn't bloat the version list.
            const sourceChanged = draftSource !== widget.source || draftFormat !== widget.format;
            const prior: WidgetVersion[] = Array.isArray(widget.versions) ? widget.versions : [];
            const nextVersions: WidgetVersion[] | undefined = sourceChanged
                ? [
                    ...prior,
                    { source: widget.source, format: widget.format as WidgetFormat, savedAt: widget.updatedAt },
                  ].slice(-WIDGET_HISTORY_MAX)
                : prior;

            const patch: Partial<WidgetDef> = {
                name: draftName.trim() || widget.name,
                source: draftSource,
                format: draftFormat,
                versions: nextVersions,
            };
            SpaceEngine.updateWidget(spaceId, widget.id, patch);
            onSaved?.({ ...widget, ...patch, updatedAt: Date.now() });
            onClose();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    }, [draftSource, draftFormat, draftName, widget, spaceId, onSaved, onClose]);

    const revert = useCallback((v: WidgetVersion) => {
        setDraftSource(v.source);
        setDraftFormat(v.format);
        setShowHistory(false);
    }, []);

    if (!open) return null;

    const versions = Array.isArray(widget.versions) ? widget.versions : [];
    const versionsNewestFirst = [...versions].reverse();

    return (
        <div
            className="fixed inset-0 z-[2147483200] flex items-center justify-center p-4"
            style={{ background: 'rgba(0, 0, 0, 0.66)', backdropFilter: 'blur(4px)' }}
            onClick={onClose}
        >
            <div
                className="w-full max-w-4xl rounded-2xl border border-[#27272a] bg-[#0c0c10] shadow-2xl flex flex-col"
                style={{ height: 'min(720px, 85vh)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#27272a]">
                    <div className="flex items-center gap-2 min-w-0">
                        <Pencil className="w-4 h-4 text-[#6366f1] shrink-0" />
                        <input
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            className="bg-transparent text-white text-sm font-semibold outline-none border-b border-transparent focus:border-[#6366f1]/60 min-w-0 flex-1"
                        />
                        <span className="text-[10px] font-mono text-[#52525b] shrink-0">{widget.id.slice(0, 14)}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={() => setShowHistory(v => !v)}
                            disabled={versions.length === 0}
                            className={`p-1.5 rounded text-[#a1a1aa] hover:bg-[#18181b] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${showHistory ? 'bg-[#18181b] text-white' : ''}`}
                            title={versions.length === 0 ? 'No history yet' : `${versions.length} prior version${versions.length === 1 ? '' : 's'}`}
                        >
                            <History className="w-4 h-4" />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded text-[#71717a] hover:bg-[#18181b] hover:text-white transition-colors"
                            title="Close (Esc)"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Format + metadata row */}
                <div className="flex items-center gap-3 px-5 py-2 border-b border-[#27272a] text-[11px]">
                    <label className="flex items-center gap-2">
                        <span className="text-[#71717a]">format</span>
                        <select
                            value={draftFormat}
                            onChange={(e) => setDraftFormat(e.target.value as WidgetFormat)}
                            className="bg-[#18181b] border border-[#27272a] rounded px-2 py-0.5 text-[#e4e4e7] focus:outline-none focus:border-[#6366f1]/60"
                        >
                            {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
                        </select>
                    </label>
                    <span className="text-[#52525b]">·</span>
                    <span className="text-[#71717a]">
                        updated <span className="text-[#a1a1aa]">{new Date(widget.updatedAt).toLocaleString()}</span>
                    </span>
                    <span className="text-[#52525b]">·</span>
                    <span className="text-[#71717a]">
                        {widget.w} × {widget.h} grid cells
                    </span>
                    <div className="ml-auto text-[10px] text-[#52525b]">⌘/Ctrl + Enter to save</div>
                </div>

                {/* Body — editor + optional history sidebar */}
                <div className="flex-1 flex min-h-0">
                    <textarea
                        ref={textareaRef}
                        value={draftSource}
                        onChange={(e) => setDraftSource(e.target.value)}
                        spellCheck={false}
                        className="flex-1 p-4 bg-[#09090c] text-[12.5px] text-[#e4e4e7] leading-relaxed font-mono resize-none focus:outline-none border-r border-[#27272a]"
                        placeholder={FORMAT_HINTS[draftFormat]}
                    />
                    {showHistory && (
                        <div className="w-72 flex flex-col border-l border-[#27272a] bg-[#0a0a0e]">
                            <div className="px-3 py-2 border-b border-[#27272a] text-[10px] uppercase tracking-wider text-[#71717a]">
                                History ({versions.length})
                            </div>
                            <div className="flex-1 overflow-auto">
                                {versionsNewestFirst.length === 0 && (
                                    <div className="p-3 text-[11px] text-[#52525b]">No prior versions yet — save to start tracking.</div>
                                )}
                                {versionsNewestFirst.map((v, i) => (
                                    <div key={v.savedAt} className="px-3 py-2 border-b border-[#18181b] hover:bg-[#18181b]/40 transition-colors">
                                        <div className="flex items-center justify-between gap-2 mb-1">
                                            <div className="text-[10px] font-mono text-[#a1a1aa]">{new Date(v.savedAt).toLocaleString()}</div>
                                            <button
                                                onClick={() => revert(v)}
                                                className="inline-flex items-center gap-1 text-[10px] text-[#6366f1] hover:text-[#a5b4fc] transition-colors"
                                                title="Load this version into the editor"
                                            >
                                                <RotateCcw className="w-3 h-3" />
                                                revert
                                            </button>
                                        </div>
                                        <div className="text-[10px] text-[#71717a] font-mono">format: {v.format}</div>
                                        <div className="text-[10px] text-[#52525b] truncate mt-1" title={v.source.slice(0, 280)}>
                                            {v.source.slice(0, 80)}{v.source.length > 80 ? '…' : ''}
                                        </div>
                                        {i === 0 && <div className="text-[9px] text-[#6366f1] mt-1">most recent before current</div>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[#27272a]">
                    <div className="text-[10px] text-[#71717a]">
                        {error
                            ? <span className="text-[#ef4444]">Error: {error}</span>
                            : draftSource !== widget.source || draftFormat !== widget.format || draftName !== widget.name
                                ? 'Unsaved changes'
                                : 'Up to date'}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="px-3 py-1.5 rounded-lg text-[12px] text-[#a1a1aa] hover:text-white hover:bg-[#18181b] transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => { void save(); }}
                            disabled={saving}
                            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-60 text-white text-[12px] font-medium transition-colors"
                        >
                            <Save className="w-3.5 h-3.5" />
                            {saving ? 'Saving…' : 'Save widget'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

const FORMAT_HINTS: Record<WidgetFormat, string> = {
    react: `// Return a React component named "Widget". titan.* APIs are
// available for fetch/api/state. Example:
function Widget({ titan }) {
  const [n, setN] = React.useState(0);
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}`,
    vanilla: `// Export a function (container, titan) => cleanup | void.
// Called once to mount; return a cleanup function if needed.
(container, titan) => {
  container.innerHTML = '<button>Hello</button>';
  const btn = container.querySelector('button');
  btn.addEventListener('click', () => btn.textContent = 'Clicked!');
}`,
    html: `<!-- Raw HTML. No scripts run. -->
<div style="padding:16px;color:#e4e4e7">Hello, widget!</div>`,
    // system shouldn't land here — editor is gated for non-system widgets.
    iframe: '',
    system: '',
};
