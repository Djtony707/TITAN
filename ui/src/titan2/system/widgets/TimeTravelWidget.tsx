/**
 * TimeTravelWidget — Space Agent-style git history UI for TITAN's
 * shadow-git file checkpoints.
 *
 * v6.0.5 — TITAN's `src/agent/shadowGit.ts` has been snapshotting every
 * file before any write/edit/append tool runs (~since v5.0), persisting
 * each pre-edit state to `~/.titan/file-checkpoints/{md5(dirPath)}/`.
 * Until now, the only UI to access them was the CLI (`titan restore <id>`).
 * This widget surfaces them in the canvas:
 *
 *   - Lists the 100 newest checkpoints, newest first.
 *   - Per-row: short hash, time-ago, tool that triggered the snapshot,
 *     and the file path.
 *   - Click a row → fetches the diff vs current file and shows it in a
 *     code panel below.
 *   - Click "Restore" → POST /api/time-travel/restore/:id, writes the
 *     checkpoint content back to the original file.
 *
 * Inspired by Space Agent's `_core/time_travel/` route — same idea, but
 * scoped to TITAN's already-existing shadow-git layer rather than Space
 * Agent's full git-backed L1/L2 history.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/api/client';

interface FileCheckpoint {
    id: string;
    timestamp: string;
    toolName: string;
    filePath: string;
    commitHash: string;
    repoPath: string;
}

function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return iso;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

function fileBase(p: string): string {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
}

export function TimeTravelWidget() {
    const [checkpoints, setCheckpoints] = useState<FileCheckpoint[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [diff, setDiff] = useState<string>('');
    const [diffLoading, setDiffLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingRestore, setPendingRestore] = useState<string | null>(null);
    const [toast, setToast] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiFetch('/api/time-travel/checkpoints?limit=100');
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as { checkpoints: FileCheckpoint[] };
            setCheckpoints(data.checkpoints || []);
        } catch (e) {
            setError((e as Error).message || 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const showToast = useCallback((kind: 'ok' | 'err', message: string) => {
        setToast({ kind, message });
        setTimeout(() => setToast(null), 4000);
    }, []);

    const selectCheckpoint = useCallback(async (id: string) => {
        setSelectedId(id);
        setDiff('');
        setDiffLoading(true);
        try {
            const res = await apiFetch(`/api/time-travel/diff/${encodeURIComponent(id)}`);
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as { diff?: string };
            setDiff(data.diff || '(no diff returned)');
        } catch (e) {
            setDiff(`Failed to load diff: ${(e as Error).message}`);
        } finally {
            setDiffLoading(false);
        }
    }, []);

    const requestRestore = useCallback((id: string) => {
        setPendingRestore(id);
    }, []);

    const confirmRestore = useCallback(async () => {
        if (!pendingRestore) return;
        const id = pendingRestore;
        setPendingRestore(null);
        try {
            const res = await apiFetch(`/api/time-travel/restore/${encodeURIComponent(id)}`, { method: 'POST' });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as { ok?: boolean; message?: string };
            if (data.ok) {
                showToast('ok', data.message || `Restored to ${id.slice(0, 8)}.`);
                // Reload so the new "current state" reflects the restore.
                void load();
            } else {
                showToast('err', data.message || 'Restore failed.');
            }
        } catch (e) {
            showToast('err', (e as Error).message || 'Restore failed.');
        }
    }, [pendingRestore, load, showToast]);

    const visible = useMemo(() => {
        const f = filter.trim().toLowerCase();
        if (!f) return checkpoints;
        return checkpoints.filter(c =>
            c.filePath.toLowerCase().includes(f) ||
            c.toolName.toLowerCase().includes(f) ||
            c.id.toLowerCase().includes(f),
        );
    }, [checkpoints, filter]);

    return (
        <div style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            color: '#e2e8f5',
            fontSize: 12,
            background: 'transparent',
        }}>
            {/* Header */}
            <div style={{
                padding: '10px 14px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
            }}>
                <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Time Travel</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
                        {checkpoints.length} file checkpoints · newest first
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <input
                        type="text"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder="Filter by file or tool…"
                        style={{
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 6,
                            color: '#fff',
                            fontSize: 11,
                            padding: '4px 8px',
                            outline: 'none',
                            width: 180,
                        }}
                    />
                    <button
                        onClick={load}
                        disabled={loading}
                        title="Refresh checkpoint list"
                        style={{
                            background: 'rgba(99,102,241,0.15)',
                            border: '1px solid rgba(99,102,241,0.35)',
                            borderRadius: 6,
                            color: '#c7d2fe',
                            fontSize: 11,
                            padding: '4px 10px',
                            cursor: loading ? 'wait' : 'pointer',
                        }}
                    >
                        {loading ? '…' : 'Refresh'}
                    </button>
                </div>
            </div>

            {/* Toast */}
            {toast && (
                <div style={{
                    margin: '8px 14px 0',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: toast.kind === 'ok' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                    border: `1px solid ${toast.kind === 'ok' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                    color: toast.kind === 'ok' ? '#86efac' : '#fca5a5',
                    fontSize: 11,
                }}>
                    {toast.message}
                </div>
            )}

            {/* Error */}
            {error && (
                <div style={{
                    margin: '8px 14px 0',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'rgba(239,68,68,0.12)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    color: '#fca5a5',
                    fontSize: 11,
                }}>
                    {error}
                </div>
            )}

            {/* List + diff split */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* Left: checkpoint list */}
                <div style={{ flex: 1, overflow: 'auto', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
                    {loading && checkpoints.length === 0 ? (
                        <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)' }}>Loading checkpoints…</div>
                    ) : visible.length === 0 ? (
                        <div style={{ padding: 16, color: 'rgba(255,255,255,0.4)' }}>
                            {filter ? 'No matches for that filter.' : 'No file checkpoints yet. They\'re created automatically whenever TITAN writes or edits a file.'}
                        </div>
                    ) : (
                        visible.map(c => (
                            <div
                                key={c.id}
                                onClick={() => selectCheckpoint(c.id)}
                                style={{
                                    padding: '8px 14px',
                                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                                    cursor: 'pointer',
                                    background: selectedId === c.id ? 'rgba(99,102,241,0.08)' : 'transparent',
                                    borderLeft: selectedId === c.id ? '2px solid #818cf8' : '2px solid transparent',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                                    <span style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', color: '#a5b4fc' }}>
                                        {c.commitHash.slice(0, 8)}
                                    </span>
                                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
                                        {timeAgo(c.timestamp)}
                                    </span>
                                </div>
                                <div style={{ fontSize: 12, color: '#e2e8f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.filePath}>
                                    {fileBase(c.filePath)}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
                                        before <code style={{ color: '#fbbf24' }}>{c.toolName}</code>
                                    </span>
                                    <button
                                        onClick={e => { e.stopPropagation(); requestRestore(c.id); }}
                                        title="Restore this file to the state it was in at this checkpoint"
                                        style={{
                                            fontSize: 10,
                                            padding: '2px 8px',
                                            borderRadius: 999,
                                            background: 'rgba(34,197,94,0.12)',
                                            border: '1px solid rgba(34,197,94,0.3)',
                                            color: '#86efac',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Restore
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Right: diff pane */}
                <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
                    {selectedId ? (
                        diffLoading ? (
                            <div style={{ color: 'rgba(255,255,255,0.4)' }}>Loading diff…</div>
                        ) : (
                            <pre style={{
                                margin: 0,
                                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                                fontSize: 11,
                                lineHeight: 1.5,
                                color: '#e2e8f5',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                            }}>
                                {(diff || '').split('\n').map((line, i) => {
                                    let color = 'rgba(255,255,255,0.7)';
                                    if (line.startsWith('+') && !line.startsWith('+++')) color = '#86efac';
                                    else if (line.startsWith('-') && !line.startsWith('---')) color = '#fca5a5';
                                    else if (line.startsWith('@@')) color = '#a5b4fc';
                                    else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('+++') || line.startsWith('---')) color = 'rgba(255,255,255,0.45)';
                                    return <div key={i} style={{ color }}>{line || ' '}</div>;
                                })}
                            </pre>
                        )
                    ) : (
                        <div style={{ color: 'rgba(255,255,255,0.4)' }}>Select a checkpoint on the left to see its diff vs the current file.</div>
                    )}
                </div>
            </div>

            {/* Restore confirmation modal */}
            {pendingRestore && (
                <div
                    onClick={() => setPendingRestore(null)}
                    style={{
                        position: 'absolute', inset: 0,
                        background: 'rgba(0,0,0,0.5)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        zIndex: 10,
                    }}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{
                            background: '#0d0f1d',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 10,
                            padding: 18,
                            maxWidth: 380,
                            color: '#e2e8f5',
                        }}
                    >
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Restore this checkpoint?</div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginBottom: 12 }}>
                            The file will be overwritten with its state at <code>{pendingRestore.slice(0, 8)}</code>. A NEW checkpoint of the current state is taken first, so you can always come back.
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setPendingRestore(null)}
                                style={{
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    color: '#e2e8f5',
                                    borderRadius: 6,
                                    padding: '6px 12px',
                                    fontSize: 12,
                                    cursor: 'pointer',
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmRestore}
                                style={{
                                    background: 'rgba(34,197,94,0.18)',
                                    border: '1px solid rgba(34,197,94,0.4)',
                                    color: '#86efac',
                                    borderRadius: 6,
                                    padding: '6px 12px',
                                    fontSize: 12,
                                    cursor: 'pointer',
                                }}
                            >
                                Restore
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default TimeTravelWidget;
