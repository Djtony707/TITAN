/**
 * MissionGraphWidget — read-only visual workflow surface.
 *
 * v6.0 — Closes the last competitive gap vs Mastra Studio /
 * LangGraph Studio / CrewAI Flows for v6.0 final: a visual view of the
 * subtask DAG that drives an autonomous mission. Renders the goal's
 * subtask graph in SVG with:
 *
 *   - One node per subtask, layered top-to-bottom by topological order
 *   - Status colour (pending / running / done / failed / skipped)
 *   - Current-subtask highlight (driver-state currentSubtaskId)
 *   - Dependency edges between nodes
 *   - Click a node → side panel with description + last error
 *
 * Pick the mission via dropdown at the top (or the highest-priority
 * active one auto-selects). Polls /api/mission/:id every 6 s.
 *
 * Deliberately read-only for v6.0. Editing the graph (add/remove
 * subtasks, redrawing edges) is the next step toward full Mastra-Studio
 * parity and is queued as v6.1 work.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/api/client';

interface Subtask {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    dependsOn: string[];
    retries: number;
    completedAt?: string;
}

interface Mission {
    goal: {
        id: string;
        title: string;
        description: string;
        status: string;
        progress: number;
        subtasks: Subtask[];
    };
    driver: {
        phase: string;
        currentSubtaskId: string | null;
        budget: { tokensUsed: number; costUsd: number };
    } | null;
}

interface ActiveMissionRef {
    goalId: string;
    title: string;
    phase: string;
}

const STATUS_COLOR: Record<Subtask['status'], string> = {
    pending: '#737373',
    running: '#60a5fa',
    done:    '#34d399',
    failed:  '#ef4444',
    skipped: '#a78bfa',
};

const POLL_MS = 6_000;
const NODE_W = 180;
const NODE_H = 64;
const LAYER_GAP_Y = 96;
const GAP_X = 24;

/**
 * Topological layering — assigns each node to a layer = max(layer of its
 * deps) + 1. Standalone nodes (no deps) end up on layer 0. Cycles get
 * forced into the same layer (defensive — createGoal already rejects
 * cycles but the widget shouldn't crash if one slips in).
 */
function layerize(subtasks: Subtask[]): Map<string, number> {
    const layers = new Map<string, number>();
    const byId = new Map(subtasks.map(s => [s.id, s]));
    const compute = (id: string, stack: Set<string>): number => {
        if (layers.has(id)) return layers.get(id)!;
        if (stack.has(id)) return 0; // cycle break
        const s = byId.get(id);
        if (!s) return 0;
        stack.add(id);
        const deps = (s.dependsOn ?? []).filter(d => byId.has(d));
        const layer = deps.length === 0 ? 0 : Math.max(...deps.map(d => compute(d, stack))) + 1;
        stack.delete(id);
        layers.set(id, layer);
        return layer;
    };
    for (const s of subtasks) compute(s.id, new Set());
    return layers;
}

export function MissionGraphWidget() {
    const [activeMissions, setActiveMissions] = useState<ActiveMissionRef[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [mission, setMission] = useState<Mission | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selectedSubtask, setSelectedSubtask] = useState<string | null>(null);

    // Load the active-mission list once + on poll
    const loadActiveList = useCallback(async () => {
        try {
            const res = await apiFetch('/api/missions/active');
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as { missions: ActiveMissionRef[] };
            const next = data.missions || [];
            setActiveMissions(next);
            if (!selectedId && next.length > 0) setSelectedId(next[0].goalId);
        } catch (e) {
            setError((e as Error).message || 'failed');
        }
    }, [selectedId]);

    // Load the chosen mission's full detail
    const loadMission = useCallback(async (goalId: string) => {
        try {
            const res = await apiFetch(`/api/mission/${encodeURIComponent(goalId)}`);
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const data = await res.json() as Mission;
            setMission(data);
            setError(null);
        } catch (e) {
            setError((e as Error).message || 'failed to load mission');
            setMission(null);
        }
    }, []);

    useEffect(() => {
        loadActiveList();
        const id = setInterval(loadActiveList, POLL_MS);
        return () => clearInterval(id);
    }, [loadActiveList]);

    useEffect(() => {
        if (!selectedId) { setMission(null); return; }
        loadMission(selectedId);
        const id = setInterval(() => loadMission(selectedId), POLL_MS);
        return () => clearInterval(id);
    }, [selectedId, loadMission]);

    const { layout, edges, viewBox } = useMemo(() => {
        if (!mission?.goal.subtasks) return { layout: [], edges: [], viewBox: '0 0 600 200' };
        const subtasks = mission.goal.subtasks;
        const layers = layerize(subtasks);
        // Group nodes by layer
        const byLayer = new Map<number, Subtask[]>();
        for (const s of subtasks) {
            const l = layers.get(s.id) ?? 0;
            if (!byLayer.has(l)) byLayer.set(l, []);
            byLayer.get(l)!.push(s);
        }
        const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
        const maxLayerCount = Math.max(...Array.from(byLayer.values()).map(arr => arr.length), 1);
        const width = Math.max(640, maxLayerCount * (NODE_W + GAP_X) + GAP_X);
        const height = sortedLayers.length * LAYER_GAP_Y + NODE_H + 40;
        // Position each node
        const pos = new Map<string, { x: number; y: number }>();
        const nodes: Array<Subtask & { x: number; y: number }> = [];
        for (const l of sortedLayers) {
            const layerNodes = byLayer.get(l)!;
            const layerWidth = layerNodes.length * NODE_W + (layerNodes.length - 1) * GAP_X;
            const startX = (width - layerWidth) / 2;
            const y = l * LAYER_GAP_Y + 20;
            for (let i = 0; i < layerNodes.length; i++) {
                const x = startX + i * (NODE_W + GAP_X);
                pos.set(layerNodes[i].id, { x, y });
                nodes.push({ ...layerNodes[i], x, y });
            }
        }
        // Edges
        const edges: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
        for (const s of subtasks) {
            const target = pos.get(s.id);
            if (!target) continue;
            for (const dep of s.dependsOn ?? []) {
                const source = pos.get(dep);
                if (!source) continue;
                edges.push({
                    from: dep,
                    to: s.id,
                    x1: source.x + NODE_W / 2,
                    y1: source.y + NODE_H,
                    x2: target.x + NODE_W / 2,
                    y2: target.y,
                });
            }
        }
        return { layout: nodes, edges, viewBox: `0 0 ${width} ${height}` };
    }, [mission]);

    const subtaskById = useMemo(() => new Map((mission?.goal.subtasks ?? []).map(s => [s.id, s])), [mission]);
    const detail = selectedSubtask ? subtaskById.get(selectedSubtask) : null;

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', color: '#e2e8f5', background: 'transparent' }}>
            {/* Header — mission picker + progress */}
            <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Mission graph</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
                        {activeMissions.length} active mission(s) · subtask DAG
                    </div>
                </div>
                {activeMissions.length > 0 && (
                    <select
                        value={selectedId ?? ''}
                        onChange={e => setSelectedId(e.target.value || null)}
                        style={{
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            color: '#fff',
                            fontSize: 11,
                            padding: '4px 8px',
                            maxWidth: 240,
                        }}
                    >
                        {activeMissions.map(m => (
                            <option key={m.goalId} value={m.goalId}>{m.title} [{m.phase}]</option>
                        ))}
                    </select>
                )}
            </div>

            {error && <div style={{ padding: 10, color: '#fca5a5', fontSize: 11 }}>{error}</div>}

            {/* Graph + detail panel */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
                    {!mission ? (
                        <div style={{ padding: 24, color: 'rgba(255,255,255,0.45)', fontSize: 12, textAlign: 'center' }}>
                            {activeMissions.length === 0
                                ? 'No active missions. Launch one via the Mission Driver widget.'
                                : 'Select a mission to view its graph.'}
                        </div>
                    ) : layout.length === 0 ? (
                        <div style={{ padding: 24, color: 'rgba(255,255,255,0.45)', fontSize: 12, textAlign: 'center' }}>
                            This mission has no subtasks yet.
                        </div>
                    ) : (
                        <svg viewBox={viewBox} style={{ width: '100%', height: 'auto' }} role="img" aria-label="Mission subtask DAG">
                            <defs>
                                <marker id="mg-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                    <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.35)" />
                                </marker>
                            </defs>
                            {/* Edges first (behind nodes) */}
                            {edges.map((e, i) => (
                                <line
                                    key={`e-${i}`}
                                    x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                                    stroke="rgba(255,255,255,0.25)"
                                    strokeWidth="1.4"
                                    markerEnd="url(#mg-arrow)"
                                />
                            ))}
                            {/* Nodes */}
                            {layout.map(s => {
                                const isCurrent = mission.driver?.currentSubtaskId === s.id;
                                const color = STATUS_COLOR[s.status];
                                const isSelected = selectedSubtask === s.id;
                                return (
                                    <g
                                        key={s.id}
                                        transform={`translate(${s.x}, ${s.y})`}
                                        onClick={() => setSelectedSubtask(s.id)}
                                        style={{ cursor: 'pointer' }}
                                    >
                                        <rect
                                            width={NODE_W}
                                            height={NODE_H}
                                            rx="8"
                                            fill={isCurrent ? `${color}22` : 'rgba(255,255,255,0.04)'}
                                            stroke={isSelected ? color : isCurrent ? color : `${color}55`}
                                            strokeWidth={isCurrent || isSelected ? 2 : 1}
                                        />
                                        {/* Status dot */}
                                        <circle cx={14} cy={14} r="5" fill={color}>
                                            {s.status === 'running' && (
                                                <animate attributeName="r" values="4;6;4" dur="1.2s" repeatCount="indefinite" />
                                            )}
                                        </circle>
                                        {/* Title — truncated by max width */}
                                        <text x={28} y={18} fontSize="11" fontWeight="600" fill="#fafafa">
                                            {s.title.length > 22 ? s.title.slice(0, 21) + '…' : s.title}
                                        </text>
                                        {/* Status label */}
                                        <text x={28} y={34} fontSize="9" fill="rgba(255,255,255,0.55)" letterSpacing="0.5" style={{ textTransform: 'uppercase' }}>
                                            {s.status}{s.retries > 0 ? ` · ${s.retries} retr${s.retries === 1 ? 'y' : 'ies'}` : ''}
                                        </text>
                                        {/* Description preview */}
                                        <text x={14} y={52} fontSize="9" fill="rgba(255,255,255,0.45)">
                                            {(s.description || '').slice(0, 30)}{(s.description || '').length > 30 ? '…' : ''}
                                        </text>
                                        {isCurrent && (
                                            <text x={NODE_W - 8} y={14} fontSize="8" fill={color} textAnchor="end" fontWeight="700">
                                                NOW
                                            </text>
                                        )}
                                    </g>
                                );
                            })}
                        </svg>
                    )}
                </div>

                {/* Detail panel */}
                {detail && (
                    <div style={{ width: 260, borderLeft: '1px solid rgba(255,255,255,0.06)', padding: 14, overflow: 'auto', fontSize: 11 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#fafafa', flex: 1 }}>{detail.title}</div>
                            <button
                                onClick={() => setSelectedSubtask(null)}
                                style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 14, padding: 0, marginLeft: 6 }}
                            >×</button>
                        </div>
                        <div style={{ marginBottom: 8 }}>
                            <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, background: `${STATUS_COLOR[detail.status]}22`, border: `1px solid ${STATUS_COLOR[detail.status]}55`, color: STATUS_COLOR[detail.status] }}>{detail.status}</span>
                            {detail.retries > 0 && <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.5)' }}>{detail.retries} retries</span>}
                        </div>
                        <div style={{ color: 'rgba(255,255,255,0.85)', lineHeight: 1.5, marginBottom: 10 }}>{detail.description}</div>
                        {detail.dependsOn.length > 0 && (
                            <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 10, marginBottom: 6 }}>
                                <strong>Depends on:</strong> {detail.dependsOn.map(d => subtaskById.get(d)?.title || d).join(', ')}
                            </div>
                        )}
                        {detail.completedAt && (
                            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10 }}>Completed: {new Date(detail.completedAt).toLocaleString()}</div>
                        )}
                    </div>
                )}
            </div>

            {/* Footer — progress + budget */}
            {mission && (
                <div style={{ padding: '6px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>
                    <span>{mission.goal.subtasks.length} subtasks · {mission.goal.progress}% progress</span>
                    {mission.driver && (
                        <span>{mission.driver.phase} · ${mission.driver.budget.costUsd.toFixed(2)} spent</span>
                    )}
                </div>
            )}
        </div>
    );
}

export default MissionGraphWidget;
