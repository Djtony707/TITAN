/**
 * AboutYouMemory — "What I know about you" (v7.0 redo, move 9).
 *
 * One plain-language page of everything TITAN remembers about its user:
 * who it's told to be (identity), what it has noticed (Soma observations),
 * and the facts it has stored. Replaces graph/taxonomy panels as the default
 * Memory surface — those live on in the Workshop for the curious. Memory as
 * relationship, not homework.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Heart, Eye, StickyNote, Wrench } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface AboutMe {
    identity: string | null;
    observations: string[];
    workingHours: { timezone: string } | null;
    facts: Array<{ key: string; value: string; category: string }>;
}

function Paper({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
    return (
        <div
            className="rounded-xl border px-5 py-4 shadow-md"
            style={{
                background: 'var(--theme-paper, var(--color-bg-secondary))',
                borderColor: 'var(--theme-paper-line, var(--color-border))',
                color: 'var(--theme-ink, var(--color-text))',
            }}
        >
            <div className="flex items-center gap-2 mb-3 text-sm font-semibold" style={{ fontFamily: 'var(--theme-font-display, inherit)' }}>
                <span style={{ color: 'var(--theme-accent)' }}>{icon}</span> {title}
            </div>
            {children}
        </div>
    );
}

export default function AboutYouMemory() {
    const navigate = useNavigate();
    const [data, setData] = useState<AboutMe | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        apiFetch('/api/memory/about-me', { headers: { 'Content-Type': 'application/json' } })
            .then(r => r.json())
            .then(d => d.error ? setError(d.message || d.error) : setData(d))
            .catch(e => setError((e as Error).message));
    }, []);

    const factsByCategory = new Map<string, AboutMe['facts']>();
    for (const f of data?.facts ?? []) {
        const list = factsByCategory.get(f.category) || [];
        list.push(f);
        factsByCategory.set(f.category, list);
    }

    return (
        <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">
            <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-ink, var(--color-text))', fontFamily: 'var(--theme-font-display, inherit)' }}>
                What I know about you
            </h1>
            <p className="text-sm" style={{ color: 'var(--theme-ink-soft, var(--color-text-muted))' }}>
                Everything here was learned from working together. Ask me in chat to remember or forget anything.
            </p>

            {error && (
                <Paper icon={<StickyNote size={16} />} title="Hmm">
                    <p className="text-sm">I couldn't read my memory just now: {error}</p>
                </Paper>
            )}

            {data && (
                <>
                    <Paper icon={<Heart size={16} />} title="Who you've asked me to be">
                        <p className="text-[14px] leading-relaxed whitespace-pre-wrap">
                            {data.identity || 'Nothing set yet — tell me in chat, or set my identity in the Workshop.'}
                        </p>
                    </Paper>

                    <Paper icon={<Eye size={16} />} title="Things I've noticed">
                        {data.observations.length === 0 ? (
                            <p className="text-sm opacity-70">Nothing yet — I pick these up over time as we work.</p>
                        ) : (
                            <ul className="space-y-1.5 text-[14px] leading-relaxed list-disc pl-5">
                                {data.observations.slice(-25).reverse().map((o, i) => <li key={i}>{o}</li>)}
                            </ul>
                        )}
                    </Paper>

                    <Paper icon={<StickyNote size={16} />} title="Facts I keep">
                        {factsByCategory.size === 0 ? (
                            <p className="text-sm opacity-70">No stored facts yet — say "remember that …" in chat.</p>
                        ) : (
                            <div className="space-y-3">
                                {[...factsByCategory.entries()].map(([cat, facts]) => (
                                    <div key={cat}>
                                        <div className="text-[11px] uppercase tracking-wide mb-1 opacity-60">{cat}</div>
                                        <ul className="space-y-1 text-[13.5px]">
                                            {facts.slice(0, 12).map(f => (
                                                <li key={f.key}><span className="opacity-70">{f.key}:</span> {f.value}</li>
                                            ))}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Paper>
                </>
            )}

            <button
                onClick={() => navigate('/knowledge/memory-graph')}
                className="flex items-center gap-1.5 text-xs hover:underline underline-offset-2"
                style={{ color: 'var(--theme-ink-soft, var(--color-text-muted))' }}
            >
                <Wrench size={12} /> The deep memory tools (graph, wiki, taxonomy) live in the Workshop
            </button>
        </div>
    );
}
