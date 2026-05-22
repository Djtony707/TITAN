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
        <div className="fixed inset-0 z-[2147483150] flex items-center justify-center p-3 sm:p-4 titan-menu-overlay" onClick={onClose}>
            <div
                className="w-full max-w-5xl titan-widget-gallery-window flex flex-col"
                style={{ height: 'min(760px, 92vh)' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="titan-widget-gallery-titlebar">
                    <div className="flex items-center gap-2">
                        <span className="titan-window-dot" />
                        <span className="titan-window-dot titan-window-dot--dim" />
                        <span className="titan-window-dot titan-window-dot--dim" />
                        <Sparkles className="w-4 h-4 ml-1" style={{ color: 'var(--theme-accent)' }} />
                        <h3
                            className="font-semibold text-sm"
                            style={{ color: 'var(--theme-ink)', fontFamily: 'var(--theme-font-display)' }}
                        >
                            Widget gallery
                        </h3>
                        <span className="text-[10px]" style={{ color: 'var(--theme-ink-soft)' }}>
                            {loading ? 'Loading…' : `${templates.length} templates`}
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="titan-close-btn"
                        title="Close (Esc)"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Category filter */}
                <div className="titan-widget-gallery-category-row">
                    {catList.map(cat => (
                        <button
                            key={cat}
                            onClick={() => setActive(cat)}
                            className={`titan-widget-gallery-category ${active === cat ? 'titan-widget-gallery-category--active' : ''}`}
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

                <div className="px-4 sm:px-5 py-2 border-b" style={{ borderColor: 'var(--theme-menu-border)' }}>
                    <label className="titan-widget-gallery-search">
                        <Search className="w-3.5 h-3.5" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search templates..."
                            className="flex-1 bg-transparent text-xs outline-none"
                        />
                    </label>
                </div>

                {/* Template grid */}
                <div className="flex-1 overflow-auto p-4">
                    {loading && (
                        <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--theme-ink-soft)' }}>
                            Loading templates…
                        </div>
                    )}
                    {error && (
                        <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--color-error)' }}>
                            Error: {error}
                        </div>
                    )}
                    {!loading && !error && (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {filtered.map(t => (
                                    <button
                                        key={t.id}
                                        onClick={() => runTemplate(t)}
                                        disabled={addingId !== null}
                                        className="titan-widget-gallery-card group"
                                    >
                                        <div className="flex items-center justify-between gap-2 mb-1">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span
                                                    className="w-1.5 h-1.5 rounded-full shrink-0"
                                                    style={{ background: CATEGORY_PALETTE[t.category] ?? '#9ca3af' }}
                                                />
                                                <span className="text-[12px] font-medium truncate" style={{ color: 'var(--theme-ink)' }}>{t.name}</span>
                                            </div>
                                            <Send className="w-3 h-3 transition-colors shrink-0" />
                                        </div>
                                        <div className="text-[11px] leading-relaxed line-clamp-2" style={{ color: 'var(--theme-ink-soft)' }}>
                                            {addingId === t.id ? 'Adding to canvas...' : t.description}
                                        </div>
                                        {t.tags && t.tags.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {t.tags.slice(0, 3).map(tag => (
                                                    <span key={tag} className="titan-widget-gallery-tag">
                                                        {tag}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                            {filtered.length === 0 && (
                                <div className="flex items-center justify-center h-40 text-sm" style={{ color: 'var(--theme-ink-soft)' }}>
                                    No templates in this category.
                                </div>
                            )}
                        </>
                    )}
                    <div className="titan-widget-gallery-note">
                        <LayoutGrid className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <div className="text-[11px] leading-relaxed">
                            Don&rsquo;t see what you want? Open the chat (click the mascot) and describe
                            your widget in plain English. TITAN can build anything that runs inside a
                            sandboxed iframe with access to <span className="font-mono">titan.fetch</span>,{' '}
                            <span className="font-mono">titan.api.call</span>, and{' '}
                            <span className="font-mono">titan.state</span>.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
