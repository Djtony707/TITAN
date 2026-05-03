/**
 * WidgetGallery — Displays all curated widget templates from the server-side
 * gallery. Clicking a card fetches the full template and adds it to the canvas.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { X, Sparkles, Send, LayoutGrid, Search } from 'lucide-react';
import { apiFetch } from '@/api/client';
import type { GalleryRunRequest, WidgetFormat } from '../types';

interface Props {
    open: boolean;
    onClose: () => void;
}

interface GalleryTemplate {
    id: string;
    name: string;
    category: string;
    description: string;
    tags: string[];
    triggers: string[];
    defaultSize?: { w: number; h: number };
    placeholders?: Array<{ name: string; description: string; default?: string }>;
}

function inferTemplateFormat(source: string): WidgetFormat {
    return String(source || '').startsWith('system:') ? 'system' : 'react';
}

interface CategoryInfo {
    category: string;
    count: number;
}

const CATEGORY_PALETTE: Record<string, string> = {
    productivity: '#a78bfa',
    finance: '#34d399',
    'health-fitness': '#f472b6',
    'music-dj': '#c084fc',
    creative: '#fb923c',
    travel: '#60a5fa',
    gaming: '#f87171',
    social: '#38bdf8',
    cooking: '#fbbf24',
    vehicle: '#94a3b8',
    homelab: '#a3e635',
    'ml-ai': '#818cf8',
    research: '#2dd4bf',
    document: '#f9a8d4',
    devops: '#fcd34d',
    'e-commerce': '#fda4af',
    lifestyle: '#86efac',
    web: '#67e8f9',
    data: '#d8b4fe',
    'multi-modal': '#fdba74',
    automation: '#facc15',
    'smart-home': '#bef264',
    agents: '#e879f9',
    'software-builder': '#7dd3fc',
    utilities: '#a5b4fc',
    media: '#fca5a5',
    communication: '#5eead4',
    education: '#c4b5fd',
    misc: '#9ca3af',
};

function displayCategory(raw: string): string {
    return raw
        .split(/[-_/]/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

export function WidgetGallery({ open, onClose }: Props) {
    const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
    const [categories, setCategories] = useState<CategoryInfo[]>([]);
    const [active, setActive] = useState<string>('All');
    const [query, setQuery] = useState('');
    const [addingId, setAddingId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setLoading(true);
        apiFetch('/api/widget-gallery')
            .then(r => r.json())
            .then(data => {
                setTemplates(data.templates || []);
                setCategories(data.categories || []);
                setLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setLoading(false);
            });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const filtered = useMemo(() => {
        const scoped = active === 'All'
            ? templates
            : templates.filter(t => t.category === active);
        const q = query.trim().toLowerCase();
        if (!q) return scoped;
        return scoped.filter(t => [
            t.name,
            t.description,
            t.category,
            ...(t.tags || []),
            ...(t.triggers || []),
        ].join(' ').toLowerCase().includes(q));
    }, [active, query, templates]);

    if (!open) return null;

    const runTemplate = async (t: GalleryTemplate) => {
        setAddingId(t.id);
        setError(null);
        try {
            const res = await apiFetch(`/api/widget-gallery/${encodeURIComponent(t.id)}`);
            if (!res.ok) throw new Error(`Could not load template (${res.status})`);
            const full = await res.json();
            const detail: GalleryRunRequest = {
                templateId: t.id,
                templateName: full.name || t.name,
                source: full.source,
                format: inferTemplateFormat(full.source),
                defaultSize: {
                    w: full.defaultSize?.w ?? t.defaultSize?.w ?? 4,
                    h: full.defaultSize?.h ?? t.defaultSize?.h ?? 4,
                },
            };
            window.dispatchEvent(new CustomEvent<GalleryRunRequest>('titan:gallery:run-template', { detail }));
            onClose();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setAddingId(null);
        }
    };

    const catList = ['All', ...categories.map(c => c.category)];

    return (
        <div
            className="fixed inset-0 z-[2147483150] flex items-center justify-center p-4"
            style={{ background: 'rgba(0, 0, 0, 0.66)', backdropFilter: 'blur(4px)' }}
            onClick={onClose}
        >
            <div
                className="w-full max-w-4xl rounded-2xl border border-[#27272a] bg-[#0c0c10] shadow-2xl flex flex-col"
                style={{ height: 'min(720px, 90vh)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#27272a]">
                    <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[#a78bfa]" />
                        <h3 className="font-semibold text-white text-sm">Widget gallery</h3>
                        <span className="text-[10px] text-[#71717a]">
                            {loading ? 'Loading…' : `${templates.length} templates`}
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 rounded text-[#71717a] hover:bg-[#18181b] hover:text-white transition-colors"
                        title="Close (Esc)"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Category filter */}
                <div className="flex items-center gap-1.5 px-5 py-2 border-b border-[#27272a] text-[11px] overflow-x-auto">
                    {catList.map(cat => (
                        <button
                            key={cat}
                            onClick={() => setActive(cat)}
                            className={`px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${
                                active === cat
                                    ? 'border-[#6366f1] bg-[#6366f1]/15 text-white'
                                    : 'border-[#27272a] bg-transparent text-[#a1a1aa] hover:border-[#3f3f46] hover:text-white'
                            }`}
                        >
                            {displayCategory(cat)}
                            {cat !== 'All' && (
                                <span className="ml-1.5 text-[9px] opacity-70">
                                    {categories.find(c => c.category === cat)?.count ?? 0}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                <div className="px-5 py-2 border-b border-[#27272a]">
                    <label className="flex items-center gap-2 rounded-lg border border-[#27272a] bg-[#18181b]/60 px-3 py-2">
                        <Search className="w-3.5 h-3.5 text-[#71717a]" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search templates..."
                            className="flex-1 bg-transparent text-xs text-white placeholder:text-[#71717a] outline-none"
                        />
                    </label>
                </div>

                {/* Template grid */}
                <div className="flex-1 overflow-auto p-4">
                    {loading && (
                        <div className="flex items-center justify-center h-full text-[#a1a1aa] text-sm">
                            Loading templates…
                        </div>
                    )}
                    {error && (
                        <div className="flex items-center justify-center h-full text-[#f87171] text-sm">
                            Error: {error}
                        </div>
                    )}
                    {!loading && !error && (
                        <>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                {filtered.map(t => (
                                    <button
                                        key={t.id}
                                        onClick={() => runTemplate(t)}
                                        disabled={addingId !== null}
                                        className="text-left p-3 rounded-lg border border-[#27272a] bg-[#18181b]/60 hover:border-[#6366f1]/50 hover:bg-[#18181b] transition-colors group"
                                    >
                                        <div className="flex items-center justify-between gap-2 mb-1">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span
                                                    className="w-1.5 h-1.5 rounded-full shrink-0"
                                                    style={{ background: CATEGORY_PALETTE[t.category] ?? '#9ca3af' }}
                                                />
                                                <span className="text-[12px] font-medium text-white truncate">{t.name}</span>
                                            </div>
                                            <Send className="w-3 h-3 text-[#52525b] group-hover:text-[#a5b4fc] transition-colors shrink-0" />
                                        </div>
                                        <div className="text-[11px] text-[#a1a1aa] leading-relaxed line-clamp-2">
                                            {addingId === t.id ? 'Adding to canvas...' : t.description}
                                        </div>
                                        {t.tags && t.tags.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {t.tags.slice(0, 3).map(tag => (
                                                    <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-[#27272a] text-[#71717a]">
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                            {filtered.length === 0 && (
                                <div className="flex items-center justify-center h-40 text-[#a1a1aa] text-sm">
                                    No templates in this category.
                                </div>
                            )}
                        </>
                    )}
                    <div className="mt-4 p-3 rounded-lg border border-dashed border-[#27272a] bg-[#0a0a0e] flex items-start gap-2">
                        <LayoutGrid className="w-3.5 h-3.5 text-[#71717a] mt-0.5 shrink-0" />
                        <div className="text-[11px] text-[#a1a1aa] leading-relaxed">
                            Don&rsquo;t see what you want? Open the chat (click the mascot) and describe
                            your widget in plain English. TITAN can build anything that runs inside a
                            sandboxed iframe with access to <span className="font-mono text-[#d4d4d8]">titan.fetch</span>,{' '}
                            <span className="font-mono text-[#d4d4d8]">titan.api.call</span>, and{' '}
                            <span className="font-mono text-[#d4d4d8]">titan.state</span>.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
