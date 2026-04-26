/**
 * Per-space agent instructions editor — Space Agent parity (v5.0).
 *
 * A small modal that edits `space.agentInstructions` (already threaded
 * into the chat system prompt via ChatWidget.buildSystemPrompt at
 * line ~496). This was the "hidden" side of Space Agent — spaces can
 * have their own agent persona / rules, steering the chat differently
 * depending on which space the user is on.
 *
 * Behaviour:
 *   - Click the Edit button in the canvas header → modal opens
 *   - Textarea seeded with the current instructions
 *   - Save persists via SpaceEngine.save(space), which writes the full
 *     space object to localStorage. Other tabs see the change on next
 *     reload (we keep the CRDT scope limited to widgets for now).
 *   - Esc / backdrop click / Cancel closes without saving
 *   - Empty string clears the instructions
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Save, BookOpen } from 'lucide-react';
import { SpaceEngine } from './SpaceEngine';
import type { Space } from '../types';

interface Props {
    space: Space;
    open: boolean;
    onClose: () => void;
    /** Called with the updated instructions so the parent can refresh. */
    onSaved?: (instructions: string) => void;
}

const MAX_LENGTH = 4000;

// Handful of quick-start presets so a blank textarea isn't intimidating.
// Tony can edit inline after picking one.
const PRESETS: { label: string; body: string }[] = [
    {
        label: 'Focused research partner',
        body: 'You are in the research space. Prefer brief answers with citations. When the user asks a question, default to summarising authoritative sources over generating widgets. Suggest a follow-up question at the end of each response.',
    },
    {
        label: 'Hands-on builder',
        body: 'You are in the build space. Prefer writing + iterating on widgets over explanation. Keep prose to under 2 sentences per reply. Generate widgets with `canvas.createWidget` whenever the user describes a tool they want.',
    },
    {
        label: 'Ops / monitoring',
        body: 'You are in the ops space. Prioritise live data — API calls, log tails, health checks. Use titan.api.call and titan.fetch liberally. Surface numbers in tables or small stat widgets.',
    },
    {
        label: 'Casual / playful',
        body: 'You are in the play space. Relaxed tone, emojis welcome, riff on user ideas, generate fun widgets. Explain trade-offs only if asked.',
    },
];

export function SpaceInstructionsEditor({ space, open, onClose, onSaved }: Props) {
    const [draft, setDraft] = useState(space.agentInstructions ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Re-seed the draft whenever the space or the open flag flips. Prevents
    // stale text from a previous space leaking in.
    useEffect(() => {
        if (open) {
            setDraft(space.agentInstructions ?? '');
            setError(null);
            // Focus + select-all so Tony can type straight over the default.
            const t = setTimeout(() => textareaRef.current?.focus(), 50);
            return () => clearTimeout(t);
        }
    }, [open, space.id, space.agentInstructions]);

    // Esc closes. We mount the listener while open to avoid competing with
    // other dialogs.
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
        if (draft.length > MAX_LENGTH) {
            setError(`Instructions must be ${MAX_LENGTH} characters or fewer.`);
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const trimmed = draft.trim();
            const next: Space = {
                ...space,
                agentInstructions: trimmed || undefined,
                updatedAt: new Date().toISOString(),
            };
            SpaceEngine.save(next);
            onSaved?.(trimmed);
            onClose();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSaving(false);
        }
    }, [draft, space, onSaved, onClose]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[2147483100] flex items-center justify-center p-4"
            style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
            onClick={onClose}
        >
            <div
                className="w-full max-w-2xl rounded-2xl border border-[#27272a] bg-[#0c0c10] shadow-2xl flex flex-col max-h-[85vh]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#27272a]">
                    <div className="flex items-center gap-2">
                        <BookOpen className="w-4 h-4 text-[#6366f1]" />
                        <h3 className="font-semibold text-white text-sm">
                            Agent instructions — <span style={{ color: space.color || '#6366f1' }}>{space.name}</span>
                        </h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 rounded hover:bg-[#27272a] text-[#71717a] hover:text-white transition-colors"
                        title="Close (Esc)"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5 flex-1 overflow-auto space-y-3">
                    <p className="text-[11px] text-[#a1a1aa] leading-relaxed">
                        These instructions are injected into the chat&rsquo;s system prompt whenever
                        this space is active. Use them to give the agent a persona, a rule set,
                        or a focus area — the chat will behave differently here vs. other spaces.
                    </p>

                    <textarea
                        ref={textareaRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="e.g. You're in the research space — prefer concise, sourced answers over widget generation."
                        spellCheck={false}
                        className="w-full h-48 p-3 rounded-lg border border-[#27272a] bg-[#09090c] text-[13px] text-[#e4e4e7] leading-relaxed font-mono resize-y focus:outline-none focus:border-[#6366f1]/60"
                    />

                    <div className="flex items-center justify-between text-[10px] text-[#71717a]">
                        <span>{draft.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()} characters</span>
                        <span>⌘/Ctrl + Enter to save</span>
                    </div>

                    {/* Presets */}
                    <div>
                        <div className="text-[10px] uppercase tracking-wider text-[#71717a] mb-2">Quick presets</div>
                        <div className="grid grid-cols-2 gap-2">
                            {PRESETS.map(p => (
                                <button
                                    key={p.label}
                                    onClick={() => setDraft(p.body)}
                                    className="text-left p-3 rounded-lg border border-[#27272a] bg-[#18181b]/60 hover:border-[#6366f1]/50 hover:bg-[#18181b] transition-colors"
                                >
                                    <div className="text-[11px] font-medium text-white mb-1">{p.label}</div>
                                    <div className="text-[10px] text-[#a1a1aa] line-clamp-2 leading-relaxed">{p.body}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className="text-[11px] text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/30 rounded p-2">
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#27272a]">
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
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
