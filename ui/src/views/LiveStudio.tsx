import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Radio, FileDiff, GitBranch } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';
import { useStudioStream, type StudioFrame } from '@/hooks/useStudioStream';

interface SessionInfo { sessionId: string; count: number; lastTs: number }

/**
 * Live Studio — the "watch it work" split pane (v7.2).
 * Left: the agent's step timeline (spine frames). Right: the latest file diff
 * + the list of changed files (checkpoint rail). Streams from the session-scoped
 * Studio SSE; URL-addressable per session for shareable/replayable runs.
 */
function LiveStudio() {
    const { sessionId: routeSession } = useParams();
    const navigate = useNavigate();
    const selected = routeSession || null;
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const { frames, connected } = useStudioStream(selected);

    useEffect(() => {
        const load = () => apiFetch('/api/studio/sessions', { headers: { 'Content-Type': 'application/json' } })
            .then(r => r.json()).then(d => setSessions(d.sessions || [])).catch(() => {});
        load();
        const t = setInterval(load, 5000);
        return () => clearInterval(t);
    }, []);

    const diffs = useMemo(() => frames.filter(f => f.raw?.diff), [frames]);
    const latestDiff = diffs[diffs.length - 1];
    const changedFiles = useMemo(() => {
        const seen = new Map<string, StudioFrame>();
        for (const f of frames) if (f.raw?.filePath) seen.set(f.raw.filePath, f);
        return [...seen.values()];
    }, [frames]);

    return (
        <div className="space-y-4">
            <PageHeader title="Live Studio" breadcrumbs={[{ label: 'Admin', href: '/overview' }, { label: 'Live Studio' }]} />

            <div className="flex items-center gap-2 text-sm">
                <Radio size={16} className={connected ? 'text-green-400' : 'text-[var(--text-muted)]'} />
                <span className="text-[var(--text-secondary)]">{connected ? 'Watching live' : selected ? 'Connecting…' : 'Idle'}</span>
                <select
                    value={selected || ''}
                    onChange={e => navigate(e.target.value ? `/studio/${e.target.value}` : '/studio')}
                    className="ml-auto bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)]"
                >
                    <option value="">Select a session…</option>
                    {sessions.map(s => <option key={s.sessionId} value={s.sessionId}>{s.sessionId} ({s.count})</option>)}
                </select>
            </div>

            {!selected ? (
                <div className="text-[var(--text-muted)] text-sm p-6 text-center border border-[var(--border)] rounded-lg">
                    Pick a session to watch TITAN work — its steps stream on the left, file diffs on the right.
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Step timeline */}
                    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-2 max-h-[68vh] overflow-auto">
                        <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] px-2 py-1">Steps ({frames.length})</p>
                        {frames.length === 0 && <p className="text-xs text-[var(--text-muted)] px-2">Waiting for activity…</p>}
                        {frames.map((f, i) => (
                            <div key={i} className="flex items-start gap-2 px-2 py-1.5 text-xs border-b border-[var(--border)] last:border-0">
                                <span aria-hidden>{f.icon || '•'}</span>
                                <div className="min-w-0 flex-1">
                                    <div className="text-[var(--text)] truncate">{f.captionControl || f.captionTitan || f.topic}</div>
                                    {f.raw?.tool && (
                                        <div className="text-[10px] text-[var(--text-muted)]">
                                            {f.raw.tool}{f.raw.success === false ? ' · failed' : ''}{f.raw.durationMs ? ` · ${f.raw.durationMs}ms` : ''}
                                        </div>
                                    )}
                                </div>
                                {f.replay && <span className="text-[9px] text-[var(--text-muted)]">replay</span>}
                            </div>
                        ))}
                    </div>

                    {/* Artifact stage + checkpoint rail */}
                    <div className="space-y-3">
                        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-2 max-h-[44vh] overflow-auto">
                            <div className="flex items-center gap-2 px-2 py-1">
                                <FileDiff size={14} className="text-[var(--text-secondary)]" />
                                <span className="text-xs text-[var(--text-secondary)] truncate">{latestDiff?.raw?.filePath || 'No diff yet'}</span>
                            </div>
                            {latestDiff?.raw?.diff ? (
                                <pre className="text-[11px] leading-relaxed font-mono px-2 overflow-auto">
                                    {latestDiff.raw.diff.split('\n').map((line, i) => (
                                        <div key={i} className={line.startsWith('+') ? 'text-green-400' : line.startsWith('-') ? 'text-red-400' : 'text-[var(--text-muted)]'}>{line || ' '}</div>
                                    ))}
                                </pre>
                            ) : <p className="text-xs text-[var(--text-muted)] px-2 py-3">File diffs appear here as TITAN edits.</p>}
                        </div>

                        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-2">
                            <div className="flex items-center gap-2 px-2 py-1">
                                <GitBranch size={14} className="text-[var(--text-secondary)]" />
                                <span className="text-xs text-[var(--text-secondary)]">Changed files ({changedFiles.length})</span>
                            </div>
                            {changedFiles.length === 0
                                ? <p className="text-xs text-[var(--text-muted)] px-2">None yet.</p>
                                : changedFiles.map((f, i) => <div key={i} className="text-xs px-2 py-1 text-[var(--text-secondary)] truncate">{f.raw?.filePath}</div>)}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default LiveStudio;
