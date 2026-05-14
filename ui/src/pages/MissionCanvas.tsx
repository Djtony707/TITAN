/**
 * TITAN — Mission Canvas — "Beautiful Wood Desk" (v6.1.0-alpha.17)
 *
 * Tony's brief: "Make this a true canvas where everything is movable
 * and beautiful, like on a beautiful wood desk. And have whatever it
 * does be displayed on the desk top."
 *
 * What changed from the alpha.8 spatial-pods version:
 *
 *   1. **Wood desk surface** — layered radial + repeating-linear
 *      gradients produce a warm caramel oak with grain, a knot, and
 *      a soft window-light glow falling from upper-left. CSS only,
 *      no image assets.
 *
 *   2. **Everything is a physical object on the desk**:
 *        - Goal placard (leather card) — the mission text.
 *        - Live document — the team's running artifact, sits as a
 *          paper sheet with the running draft.
 *        - Agent cards — one per team member with name / role / what
 *          they're doing right now / state.
 *        - File papers — one per `file` or `report` source emitted
 *          by any agent. Double-click opens the FileViewer modal.
 *        - Sticky notes — one per `fact` source. Yellow Post-it look.
 *        - Question tag — pink card with quick replies, when an
 *          agent is blocked on a decision.
 *        - Cost inkwell — a small brass-ringed badge with $ spent.
 *
 *   3. **Free drag** — every object on the desk is draggable.
 *      Mousedown anywhere on the card body (not on buttons/inputs)
 *      starts the drag. mousemove updates position. mouseup persists
 *      the new {x,y,z,rotation} to localStorage keyed per mission.
 *      Click-to-front (highest z) on grab.
 *
 *   4. **Tidy up** — top-bar button resets every object to a sensible
 *      canonical layout. Useful when things land off-screen or you
 *      want a fresh arrangement.
 *
 *   5. The bottom rail (steer input + slash quick-commands) and the
 *      header chrome are unchanged — same hooks, same data flow.
 *      Bound to the same MissionRoom + SSE as MissionChat.
 *
 * Hook-ordering: every useMemo/useCallback runs on every render. The
 * loading / error early-returns happen AFTER all hooks. (The alpha.12
 * React error #310 fix is preserved.)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  getMission,
  getMissionFile,
  postMessage,
  answerQuestion,
  setMissionStatus,
  deleteMission,
  subscribeToMission,
  type MissionFile,
  type MissionRoom,
  type MissionMessage,
  type MissionMember,
} from '@/api/missions';
import { FileViewer } from '@/pages/mission/FileViewer';
import { AgentMenu, type AgentMenuAnchor } from '@/pages/mission/AgentMenu';
// v6.1.0-alpha.22 — sponsor footer is now a global AppShell mount.
import { getModels } from '@/api/client';
import type { ModelInfo } from '@/api/types';

const SLASH_COMMANDS: Array<{ cmd: string; label: string; hint: string }> = [
  { cmd: '/slow down',      label: 'Slow down',      hint: 'be more careful' },
  { cmd: '/be thorough',    label: 'Be thorough',    hint: 'dig deeper' },
  { cmd: '/wrap it up',     label: 'Wrap it up',     hint: 'finish what you have' },
  { cmd: '/pause',          label: 'Pause',          hint: 'pause the team' },
];

// ── Persistence shape ────────────────────────────────────────────────

interface ItemPose { x: number; y: number; z: number; rotation: number; }
type DeskLayout = Record<string, ItemPose>;

function loadLayout(missionId: string): DeskLayout {
  try {
    const raw = localStorage.getItem(layoutKey(missionId));
    if (!raw) return {};
    return JSON.parse(raw) as DeskLayout;
  } catch { return {}; }
}
function saveLayout(missionId: string, layout: DeskLayout): void {
  try { localStorage.setItem(layoutKey(missionId), JSON.stringify(layout)); }
  catch { /* quota — silently ignore */ }
}
function layoutKey(missionId: string): string { return `titan-desk:${missionId}`; }

// ── Desk items ───────────────────────────────────────────────────────

interface DeskItem {
  id: string;
  kind: 'goal' | 'document' | 'agent' | 'file' | 'fact' | 'question' | 'cost' | 'clock' | 'cabinet' | 'trash';
  ref?: string;
}

/**
 * Storage state for filing cabinet + wastebasket. Items inside one of
 * these containers don't render on the desk; opening the cabinet shows
 * them in a drawer. Trashed items render as wadded paper inside the
 * basket (visual only — the underlying mission source isn't deleted
 * since we don't yet have a backend delete endpoint for sources).
 *
 * Persisted to localStorage at `titan-desk-furniture:{missionId}` so the
 * organization survives reloads independently of layout.
 */
interface DeskFurniture {
  cabinet: string[]; // item ids filed away
  trash: string[];   // item ids tossed
  cabinetOpen: boolean;
}

function furnitureKey(missionId: string): string { return `titan-desk-furniture:${missionId}`; }
function loadFurniture(missionId: string): DeskFurniture {
  try {
    const raw = localStorage.getItem(furnitureKey(missionId));
    if (!raw) return { cabinet: [], trash: [], cabinetOpen: false };
    const parsed = JSON.parse(raw) as Partial<DeskFurniture>;
    return {
      cabinet: Array.isArray(parsed.cabinet) ? parsed.cabinet : [],
      trash: Array.isArray(parsed.trash) ? parsed.trash : [],
      cabinetOpen: Boolean(parsed.cabinetOpen),
    };
  } catch { return { cabinet: [], trash: [], cabinetOpen: false }; }
}
function saveFurniture(missionId: string, f: DeskFurniture): void {
  try { localStorage.setItem(furnitureKey(missionId), JSON.stringify(f)); }
  catch { /* ignore */ }
}

interface FileSource { ref: string; description?: string; type: 'file' | 'report'; }
interface FactSource { ref: string; description?: string; }

export default function MissionCanvas() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<MissionRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [steerInput, setSteerInput] = useState('');
  const [sending, setSending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Desk layout — pose per item id. Persisted to localStorage.
  const [layout, setLayout] = useState<DeskLayout>({});
  useEffect(() => { if (id) setLayout(loadLayout(id)); }, [id]);
  const persist = useCallback((next: DeskLayout) => {
    setLayout(next);
    if (id) saveLayout(id, next);
  }, [id]);

  // Filing cabinet / wastebasket state — what's filed away, what's tossed.
  const [furniture, setFurniture] = useState<DeskFurniture>({ cabinet: [], trash: [], cabinetOpen: false });
  useEffect(() => { if (id) setFurniture(loadFurniture(id)); }, [id]);
  const persistFurniture = useCallback((next: DeskFurniture) => {
    setFurniture(next);
    if (id) saveFurniture(id, next);
  }, [id]);

  // Available models for the AgentMenu's "Brain" picker.
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    getModels().then(setModels).catch(() => setModels([]));
  }, []);

  // Agent menu — { agentId, anchor } when open.
  const [agentMenu, setAgentMenu] = useState<{ agentId: string; anchor: AgentMenuAnchor } | null>(null);

  // FileViewer state — opened on double-clicking a file paper.
  const [openFile, setOpenFile] = useState<{ ref: string; loading: boolean; error?: string; file?: MissionFile } | null>(null);
  const handleOpenFile = useCallback(async (ref: string) => {
    if (!id) return;
    setOpenFile({ ref, loading: true });
    try {
      const file = await getMissionFile(id, ref);
      setOpenFile({ ref, loading: false, file });
    } catch (err) {
      setOpenFile({ ref, loading: false, error: (err as Error).message });
    }
  }, [id]);

  // Initial load + SSE.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    getMission(id)
      .then(({ mission }) => { if (alive) { setRoom(mission); setLoading(false); } })
      .catch((err) => { if (alive) { setError((err as Error).message); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const unsub = subscribeToMission(id, (ev) => {
      if (ev.kind === 'mission_deleted') { navigate('/mission'); return; }
      if (ev.kind === 'hello') return;
      getMission(id).then(({ mission }) => setRoom(mission)).catch(() => { /* ignore */ });
    });
    return unsub;
  }, [id, navigate]);

  const sendSteer = useCallback(async (text: string) => {
    if (!room || !text.trim() || sending) return;
    setSending(true);
    try { await postMessage(room.id, text.trim()); setSteerInput(''); }
    catch (err) { setError((err as Error).message); }
    finally { setSending(false); }
  }, [room, sending]);

  const onAnswer = useCallback(async (approvalId: string, answer: string) => {
    if (!room) return;
    try { await answerQuestion(room.id, approvalId, answer); }
    catch (err) { setError((err as Error).message); }
  }, [room]);

  const onTogglePause = useCallback(async () => {
    if (!room) return;
    const next = room.status === 'paused' ? 'working' : 'paused';
    try { await setMissionStatus(room.id, next); } catch (err) { setError((err as Error).message); }
  }, [room]);

  // v6.1.0-alpha.27 — delete this mission and return to the start page.
  const onDelete = useCallback(async () => {
    if (!room) return;
    const ok = window.confirm(`Delete this mission?\n\n"${room.goal.slice(0, 120)}${room.goal.length > 120 ? '…' : ''}"\n\nThe file is renamed on disk (recoverable manually), but the mission disappears from the UI immediately.`);
    if (!ok) return;
    try {
      await deleteMission(room.id);
      navigate('/mission');
    } catch (err) { setError((err as Error).message); }
  }, [room, navigate]);

  // ── Derive desk items from room state ─────────────────────────
  // Hook order rule: gate on `room ?? null` and run unconditionally.

  const openQuestion = useMemo(() => {
    if (!room) return undefined;
    const reversed = [...room.messages].reverse();
    return reversed.find(
      m => m.kind === 'question' && !(m as Extract<MissionMessage, { kind: 'question' }>).answer,
    ) as Extract<MissionMessage, { kind: 'question' }> | undefined;
  }, [room]);

  /** Flatten unique file / report sources across all agent messages. Dedup
   *  by ref so a file referenced twice doesn't get two papers. Newest
   *  reference wins on description. */
  const fileSources = useMemo<FileSource[]>(() => {
    if (!room) return [];
    const byRef = new Map<string, FileSource>();
    for (const m of room.messages) {
      if (m.kind !== 'agent' || !Array.isArray(m.sources)) continue;
      for (const s of m.sources) {
        if (s.type === 'file' || s.type === 'report') {
          byRef.set(s.ref, { ref: s.ref, description: s.description, type: s.type });
        }
      }
    }
    return Array.from(byRef.values());
  }, [room]);

  /** Flatten unique fact sources — the yellow sticky notes. */
  const factSources = useMemo<FactSource[]>(() => {
    if (!room) return [];
    const byRef = new Map<string, FactSource>();
    for (const m of room.messages) {
      if (m.kind !== 'agent' || !Array.isArray(m.sources)) continue;
      for (const s of m.sources) {
        if (s.type === 'fact') {
          byRef.set(s.ref, { ref: s.ref, description: s.description });
        }
      }
    }
    return Array.from(byRef.values()).slice(0, 8); // cap visual density
  }, [room]);

  /** Build the full ordered list of items to render. */
  const items: DeskItem[] = useMemo(() => {
    if (!room) return [];
    const out: DeskItem[] = [];
    out.push({ id: 'goal', kind: 'goal' });
    out.push({ id: 'document', kind: 'document' });
    out.push({ id: 'cost', kind: 'cost' });
    out.push({ id: 'clock', kind: 'clock' });
    out.push({ id: 'cabinet', kind: 'cabinet' });
    out.push({ id: 'trash', kind: 'trash' });
    for (const m of room.team) {
      out.push({ id: `agent:${m.agentId}`, kind: 'agent', ref: m.agentId });
    }
    for (const f of fileSources) {
      out.push({ id: `file:${f.ref}`, kind: 'file', ref: f.ref });
    }
    for (const fact of factSources) {
      out.push({ id: `fact:${fact.ref}`, kind: 'fact', ref: fact.ref });
    }
    if (openQuestion) {
      out.push({ id: `q:${openQuestion.approvalId}`, kind: 'question', ref: openQuestion.approvalId });
    }
    return out;
  }, [room, fileSources, factSources, openQuestion]);

  /** Whether an item is currently hidden (filed or trashed). */
  const isHidden = useCallback((itemId: string) => {
    return furniture.cabinet.includes(itemId) || furniture.trash.includes(itemId);
  }, [furniture]);

  /** Drop handler — fires when a Draggable is released over a
   *  data-drop-target zone (cabinet or trash). */
  const handleDrop = useCallback((itemId: string, target: string) => {
    if (target === 'cabinet') {
      persistFurniture({
        ...furniture,
        cabinet: [...new Set([...furniture.cabinet, itemId])],
        trash: furniture.trash.filter(x => x !== itemId),
      });
      return true;
    }
    if (target === 'trash') {
      persistFurniture({
        ...furniture,
        trash: [...new Set([...furniture.trash, itemId])],
        cabinet: furniture.cabinet.filter(x => x !== itemId),
      });
      return true;
    }
    return false;
  }, [furniture, persistFurniture]);

  /** Restore a filed/trashed item back to the desk. */
  const restoreItem = useCallback((itemId: string) => {
    persistFurniture({
      ...furniture,
      cabinet: furniture.cabinet.filter(x => x !== itemId),
      trash: furniture.trash.filter(x => x !== itemId),
    });
  }, [furniture, persistFurniture]);

  const toggleCabinet = useCallback(() => {
    persistFurniture({ ...furniture, cabinetOpen: !furniture.cabinetOpen });
  }, [furniture, persistFurniture]);

  /** Compute initial pose for an item that has no saved layout yet. */
  const initialPose = useCallback((item: DeskItem, allItems: DeskItem[]): ItemPose => {
    // Canvas-area approximation; we use viewport-relative pixels. Recomputed
    // on every render so resize doesn't lose intent, but only used when the
    // saved layout is missing this item.
    const vw = typeof window === 'undefined' ? 1400 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
    const cx = vw / 2;
    const cy = vh / 2;
    if (item.kind === 'goal') return { x: cx - 220, y: 90, z: 5, rotation: -1.2 };
    if (item.kind === 'document') return { x: cx - 240, y: cy - 220, z: 4, rotation: 0.4 };
    if (item.kind === 'cost') return { x: vw - 130, y: 90, z: 6, rotation: 2 };
    if (item.kind === 'clock') return { x: vw - 280, y: vh - 240, z: 7, rotation: -1.5 };
    if (item.kind === 'cabinet') return { x: 30, y: vh - 280, z: 3, rotation: 0 };
    if (item.kind === 'trash') return { x: vw - 130, y: vh - 220, z: 3, rotation: 0 };
    if (item.kind === 'question') return { x: cx + 120, y: 200, z: 30, rotation: -3 };
    if (item.kind === 'agent') {
      // Fan agent cards along the right edge initially.
      const idx = allItems.filter(i => i.kind === 'agent').findIndex(i => i.id === item.id);
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      return {
        x: vw - 280 + col * 20,
        y: 200 + row * 180 + col * 30,
        z: 10 + idx,
        rotation: (idx % 2 === 0 ? -1 : 1) * (1.5 + idx * 0.5),
      };
    }
    if (item.kind === 'file') {
      const idx = allItems.filter(i => i.kind === 'file').findIndex(i => i.id === item.id);
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      return {
        x: 60 + col * 30,
        y: 180 + row * 180 + col * 25,
        z: 8 + idx,
        rotation: (idx % 2 === 0 ? 1 : -1) * (2 + idx * 0.3),
      };
    }
    if (item.kind === 'fact') {
      const idx = allItems.filter(i => i.kind === 'fact').findIndex(i => i.id === item.id);
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      return {
        x: cx - 160 + col * 100 + (row % 2 === 0 ? 0 : 25),
        y: vh - 280 + row * 80,
        z: 12 + idx,
        rotation: (idx % 2 === 0 ? -1 : 1) * (4 + idx * 0.7),
      };
    }
    return { x: 100, y: 100, z: 1, rotation: 0 };
  }, []);

  /** Look up an item's pose; fall back to initial layout. */
  const poseOf = useCallback((item: DeskItem): ItemPose => {
    return layout[item.id] ?? initialPose(item, items);
  }, [layout, items, initialPose]);

  /** Drag-end handler — persists pose. */
  const setPose = useCallback((itemId: string, pose: ItemPose) => {
    const next = { ...layout, [itemId]: pose };
    persist(next);
  }, [layout, persist]);

  /** Bring an item to front by bumping its z above all others. */
  const bringToFront = useCallback((itemId: string) => {
    const maxZ = Math.max(0, ...items.map(it => (layout[it.id] ?? initialPose(it, items)).z));
    const current = layout[itemId] ?? initialPose(items.find(i => i.id === itemId)!, items);
    if (current.z >= maxZ) return; // already front
    setPose(itemId, { ...current, z: maxZ + 1 });
  }, [items, layout, initialPose, setPose]);

  /** Tidy-up — wipe saved positions; everything snaps back to initial layout. */
  const tidyUp = useCallback(() => {
    if (!id) return;
    persist({});
  }, [id, persist]);

  /** v6.1.0-alpha.20 — restore a filed item AND drop it at a specific
   *  screen position (used for the drag-out gesture from the cabinet
   *  drawer). Persists both the furniture-removal AND the new pose so
   *  the item ends up where the user released the mouse. Declared here
   *  after initialPose / setPose so the closure captures them. */
  const restoreItemAt = useCallback((itemId: string, x: number, y: number) => {
    persistFurniture({
      ...furniture,
      cabinet: furniture.cabinet.filter(c => c !== itemId),
      trash: furniture.trash.filter(t => t !== itemId),
    });
    const maxZ = Math.max(0, ...items.map(it => (layout[it.id] ?? initialPose(it, items)).z));
    const existing = layout[itemId];
    const rotation = existing?.rotation ?? ((Math.random() * 6) - 3);
    // Offset (-80,-20) matches the cabinet ghost preview offset so the
    // dropped pose visually lines up with where the ghost was.
    setPose(itemId, { x: x - 80, y: y - 20, z: maxZ + 1, rotation });
  }, [furniture, persistFurniture, items, layout, initialPose, setPose]);

  // ── Early-return guards (after all hooks) ─────────────────────

  if (loading) {
    return <div className="fixed inset-0 flex items-center justify-center bg-[#3a2a1c] text-[#f3e9d0] text-sm">Setting the desk…</div>;
  }
  if (error || !room) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#3a2a1c] flex-col gap-3">
        <div className="text-[#ffb4a2] text-sm">{error ?? 'Mission not found.'}</div>
        <button onClick={() => navigate('/mission')} className="text-[#f3e9d0] text-sm hover:underline">← Start a new mission</button>
      </div>
    );
  }

  const { working, blocked } = countTeam(room);

  return (
    <div className="fixed inset-0 overflow-hidden font-sans text-[#f3e9d0]" style={deskStyle}>
      {/* warm window-light glow + vignette */}
      <div className="pointer-events-none absolute inset-0" style={glowStyle} />
      <div className="pointer-events-none absolute inset-0" style={vignetteStyle} />

      {/* Top bar */}
      <header className="relative z-30 flex items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/mission')} className="text-[#e7d6a8] hover:text-white text-sm" title="New mission">←</button>
          <button
            onClick={() => navigate('/mission/library')}
            className="text-[10px] uppercase tracking-widest text-[#d9c08c] hover:text-white border border-[#8a6a3a]/60 rounded-full px-2 py-0.5"
            title="Browse past missions"
          >
            Library
          </button>
          {/* v6.1.0-alpha.23 — back to the main canvas / spaces home. */}
          <button
            onClick={() => navigate('/space/home')}
            className="text-[10px] uppercase tracking-widest text-[#d9c08c] hover:text-white border border-[#8a6a3a]/60 rounded-full px-2 py-0.5 inline-flex items-center gap-1"
            title="Back to the canvas spaces"
          >
            🌌 Canvas
          </button>
          <div className="font-semibold tracking-tight text-[#f3e9d0]">
            <span style={{ background: 'linear-gradient(90deg,#f3d27a,#d8a85a)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>TITAN</span>
            <span className="text-[#d9c08c] font-normal"> &nbsp;›&nbsp; </span>
            <span className="text-[#e7d6a8] font-normal">Desk</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#2a1d11]/70 border border-[#8a6a3a]/60 rounded-full text-xs">
            <span className={`w-2 h-2 rounded-full ${blocked > 0 ? 'bg-error animate-pulse' : working > 0 ? 'bg-accent animate-pulse' : 'bg-success'}`} />
            <span className="text-[#e7d6a8]">{statusBlurb(room.status, working, blocked)}</span>
          </div>
          {room.longRunningMode && (
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
              style={{
                background: 'linear-gradient(90deg, rgba(245,210,122,0.18), rgba(176,138,58,0.18))',
                border: '1px solid #b08a3a',
                color: '#ffd86e',
              }}
              title="Marathon mode — long-running multi-agent collaboration (72h cap)"
            >
              🏃 Marathon
            </div>
          )}
          <button
            onClick={tidyUp}
            className="px-3 py-1.5 text-xs bg-[#2a1d11]/70 border border-[#8a6a3a]/60 rounded-full text-[#e7d6a8] hover:text-white"
            title="Reset every item to a sensible starting position"
          >Tidy up</button>
          <button
            onClick={() => navigate(`/mission/${room.id}`)}
            className="px-3 py-1.5 text-xs bg-[#2a1d11]/70 border border-[#8a6a3a]/60 rounded-full text-[#e7d6a8] hover:text-white"
            title="Switch to the chat thread view"
          >Chat view</button>
          <button
            onClick={onTogglePause}
            className="px-3 py-1.5 text-xs bg-[#2a1d11]/70 border border-[#8a6a3a]/60 rounded-full text-[#e7d6a8] hover:text-white"
          >
            {room.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          {/* v6.1.0-alpha.27 — delete mission. Wood-tone, red on hover. */}
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-xs bg-[#2a1d11]/70 border border-[#8a6a3a]/60 rounded-full text-[#d9c08c] hover:text-[#ff9c9c] hover:border-[#ff9c9c]/50 transition-colors"
            title="Delete this mission"
          >
            🗑 Delete
          </button>
          <button onClick={() => setHelpOpen(v => !v)} className="w-8 h-8 rounded-full bg-[#2a1d11]/70 border border-[#8a6a3a]/60 text-[#e7d6a8] hover:text-white font-semibold text-sm flex items-center justify-center" title="What's this?">?</button>
        </div>
      </header>

      {/*
        v6.1.0-alpha.24 — Living desk layer.
        Three subtle animations that only fire when at least one agent
        is working, so a quiet desk stays calm and a busy desk feels
        alive:
          1. Tether lines — animated dashed amber threads drawn from
             each working/editing agent's card to the live document.
          2. Dust motes — slow-drifting soft particles across the
             whole desk; only present while work is happening.
          3. (sticky-note breathing lives inside AgentCard via CSS.)
        Wrapped in `pointer-events-none` so it never intercepts drag.
      */}
      <LivingDeskLayer
        items={items}
        room={room}
        poseOf={poseOf}
        isHidden={isHidden}
      />

      {/* Desk surface — everything is absolutely positioned on top. */}
      <div className="absolute inset-0 z-10 pointer-events-none">
        {items.map(item => {
          if (isHidden(item.id)) return null;
          const pose = poseOf(item);
          // Agent cards open the AgentMenu on click; everything else
          // is a plain drag-and-drop tile. Files / facts can be dragged
          // into cabinet or trash.
          const isAgent = item.kind === 'agent';
          const isFilable = item.kind === 'file' || item.kind === 'fact';
          return (
            <Draggable
              key={item.id}
              pose={pose}
              onGrab={() => bringToFront(item.id)}
              onPose={(p) => setPose(item.id, p)}
              onClick={isAgent
                ? (x, y) => setAgentMenu({ agentId: item.ref!, anchor: { x, y } })
                : undefined}
              onDrop={isFilable ? (target) => handleDrop(item.id, target) : undefined}
            >
              <ItemBody
                item={item}
                room={room}
                openQuestion={openQuestion}
                fileSources={fileSources}
                factSources={factSources}
                furniture={furniture}
                onOpenCabinet={toggleCabinet}
                onOpenFile={handleOpenFile}
                onAnswer={onAnswer}
              />
            </Draggable>
          );
        })}
      </div>

      {/* Cabinet drawer overlay — shown when the cabinet is open. */}
      {furniture.cabinetOpen && (
        <CabinetDrawer
          itemIds={furniture.cabinet}
          items={items}
          fileSources={fileSources}
          factSources={factSources}
          onRestore={restoreItem}
          onRestoreAt={restoreItemAt}
          onOpenFile={handleOpenFile}
          onClose={toggleCabinet}
        />
      )}

      {/* AgentMenu popover */}
      {agentMenu && (() => {
        const m = room.team.find(t => t.agentId === agentMenu.agentId);
        if (!m) return null;
        const modelOptions = models.map(mi => ({ id: mi.id, label: mi.name, provider: mi.provider }));
        return (
          <AgentMenu
            member={m}
            room={room}
            anchor={agentMenu.anchor}
            availableModels={modelOptions}
            onClose={() => setAgentMenu(null)}
          />
        );
      })()}

      {/* Bottom rail — slash quick steers + steer input. Same layout as before. */}
      <footer className="absolute left-0 right-0 bottom-0 z-30 px-5 pb-5 pt-3 flex flex-col gap-2 bg-gradient-to-t from-[#1d130a]/95 to-transparent">
        <div className="flex flex-wrap items-center gap-2 max-w-5xl mx-auto w-full">
          <span className="text-[10px] uppercase tracking-widest text-[#d9c08c]">quick steer</span>
          {SLASH_COMMANDS.map(s => (
            <button
              key={s.cmd}
              onClick={() => sendSteer(s.cmd)}
              disabled={sending}
              title={s.hint}
              className="px-2.5 py-1 text-[11px] text-[#e7d6a8] bg-[#2a1d11]/70 border border-[#8a6a3a]/60 rounded-full hover:text-white disabled:opacity-50"
            >{s.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 max-w-5xl mx-auto w-full">
          <form
            onSubmit={(e) => { e.preventDefault(); sendSteer(steerInput); }}
            className="flex-1 h-11 flex items-center gap-2.5 px-3.5 bg-[#2a1d11]/80 border border-[#8a6a3a]/60 rounded-full"
          >
            <input
              value={steerInput}
              onChange={(e) => setSteerInput(e.target.value)}
              placeholder='Tell the team — "Add a one-line risk note at the top"'
              className="flex-1 bg-transparent outline-none text-sm text-[#f3e9d0] placeholder:text-[#d9c08c]/50"
            />
            <span className="px-2 py-1 text-[10px] uppercase tracking-widest text-[#d9c08c] border border-[#8a6a3a]/60 rounded">↵</span>
          </form>
        </div>
      </footer>

      {/* File viewer modal (alpha.16) — opens on double-click of file papers. */}
      {openFile && (
        <FileViewer state={openFile} onClose={() => setOpenFile(null)} />
      )}

      {/* Help panel */}
      {helpOpen && (
        <div className="fixed top-16 right-5 w-80 bg-[#2a1d11]/95 border border-[#8a6a3a]/60 rounded-xl p-4 backdrop-blur-xl shadow-2xl z-40">
          <button onClick={() => setHelpOpen(false)} className="absolute top-3 right-3 text-[#d9c08c] hover:text-white text-sm">✕</button>
          <h3 className="font-semibold text-sm mb-2 text-[#f3e9d0]">The desk</h3>
          <p className="text-xs text-[#e7d6a8] leading-relaxed mb-3">
            Everything the team produces lands on this desk as a physical object.
            Drag anything anywhere. <b>Tidy up</b> resets the layout if it gets cluttered.
          </p>
          <ul className="space-y-2 text-xs text-[#e7d6a8]">
            <li className="flex gap-2"><span>📜</span><span><b className="text-white">Leather placard</b> — your mission goal.</span></li>
            <li className="flex gap-2"><span>📄</span><span><b className="text-white">Paper sheets</b> — files the team wrote. Double-click to open.</span></li>
            <li className="flex gap-2"><span>👤</span><span><b className="text-white">Index cards</b> — each AI helper, showing what they're doing now.</span></li>
            <li className="flex gap-2"><span>💡</span><span><b className="text-white">Sticky notes</b> — facts the team picked up while working.</span></li>
            <li className="flex gap-2"><span>📕</span><span><b className="text-white">Pink card</b> — a question waiting on you.</span></li>
          </ul>
        </div>
      )}

      <style>{KEYFRAMES}</style>
    </div>
  );
}

// ── Draggable wrapper ────────────────────────────────────────────────

interface DraggableProps {
  pose: ItemPose;
  onGrab: () => void;
  onPose: (pose: ItemPose) => void;
  /** Optional — fires when mouseup happens without meaningful drag movement
   *  (<5px total). Used by AgentCard to open AgentMenu on click. The click
   *  event coordinates are passed so the popover can anchor to them. */
  onClick?: (clientX: number, clientY: number) => void;
  /** Optional — fires when the user releases over a drop zone. The drop
   *  target id is determined by the element under the cursor at mouseup
   *  carrying `data-drop-target="..."`. If onDrop returns true, the pose
   *  is NOT persisted (the item was consumed by the drop target). */
  onDrop?: (target: string) => boolean | void;
  children: React.ReactNode;
}

/**
 * Generic drag wrapper. Mousedown on the wrapper (not on a `data-no-drag`
 * element) starts a drag. The drag updates a local visual pose so the
 * item moves smoothly; the persisted pose is committed on mouseup.
 *
 * v6.1.0-alpha.19 — added click detection (no-movement mouseup → onClick)
 * and drop-zone hit testing (mouseup over a `data-drop-target` element →
 * onDrop with the target id).
 */
function Draggable({ pose, onGrab, onPose, onClick, onDrop, children }: DraggableProps) {
  const [drag, setDrag] = useState<{ dx: number; dy: number; x: number; y: number } | null>(null);
  const visual = drag ? { x: drag.x, y: drag.y } : { x: pose.x, y: pose.y };

  // Mousedown — start drag (or capture a click, depending on movement).
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag]')) return;
    e.preventDefault();
    onGrab();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = pose.x;
    const origY = pose.y;
    setDrag({ dx: 0, dy: 0, x: origX, y: origY });

    const onMove = (mv: MouseEvent) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      setDrag({ dx, dy, x: origX + dx, y: origY + dy });
    };
    const onUp = (mv: MouseEvent) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const finalX = origX + dx;
      const finalY = origY + dy;
      setDrag(null);
      const moved = Math.abs(dx) > 4 || Math.abs(dy) > 4;
      if (!moved) {
        // Click semantic — no persist, fire onClick at the original
        // coordinates so the popover anchors where the user clicked.
        if (onClick) onClick(mv.clientX, mv.clientY);
        return;
      }
      // Drop zone hit test: pick the topmost element under the cursor
      // at mouseup, then walk up looking for data-drop-target. Skip the
      // dragged element itself so a card can't "drop on itself".
      if (onDrop) {
        const stack = document.elementsFromPoint(mv.clientX, mv.clientY) as HTMLElement[];
        for (const el of stack) {
          const dropTarget = el.closest('[data-drop-target]') as HTMLElement | null;
          if (!dropTarget) continue;
          if (dropTarget.contains(e.currentTarget as Node)) continue; // own descendant
          const t = dropTarget.getAttribute('data-drop-target');
          if (t) {
            const consumed = onDrop(t);
            if (consumed !== false) return; // skip pose-persist
            break;
          }
        }
      }
      onPose({ ...pose, x: finalX, y: finalY });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pose, onGrab, onPose, onClick, onDrop]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute select-none pointer-events-auto cursor-grab active:cursor-grabbing"
      style={{
        left: visual.x,
        top: visual.y,
        zIndex: drag ? 999 : pose.z,
        transform: `rotate(${pose.rotation}deg) ${drag ? 'scale(1.03)' : ''}`,
        transition: drag ? 'transform 80ms ease-out' : 'transform 200ms ease-out',
        filter: drag ? 'drop-shadow(0 22px 32px rgba(0,0,0,0.55))' : 'drop-shadow(0 6px 14px rgba(0,0,0,0.42))',
        willChange: drag ? 'left, top' : undefined,
      }}
    >
      {children}
    </div>
  );
}

// ── Item bodies ──────────────────────────────────────────────────────

function ItemBody({
  item, room, openQuestion, fileSources, factSources, furniture, onOpenCabinet, onOpenFile, onAnswer,
}: {
  item: DeskItem;
  room: MissionRoom;
  openQuestion: Extract<MissionMessage, { kind: 'question' }> | undefined;
  fileSources: FileSource[];
  factSources: FactSource[];
  furniture: DeskFurniture;
  onOpenCabinet: () => void;
  onOpenFile: (ref: string) => void;
  onAnswer: (approvalId: string, answer: string) => void;
}) {
  if (item.kind === 'goal') return <GoalPlacard goal={room.goal} />;
  if (item.kind === 'document') return <DocumentPaper room={room} />;
  if (item.kind === 'cost') return <CostInkwell room={room} />;
  if (item.kind === 'clock') return <DeskClock room={room} />;
  if (item.kind === 'cabinet') return <FilingCabinet count={furniture.cabinet.length} onOpen={onOpenCabinet} />;
  if (item.kind === 'trash') return <Wastebasket count={furniture.trash.length} />;
  if (item.kind === 'agent') {
    const m = room.team.find(t => t.agentId === item.ref);
    if (!m) return null;
    return <AgentCard member={m} />;
  }
  if (item.kind === 'file') {
    const f = fileSources.find(s => s.ref === item.ref);
    if (!f) return null;
    return <FilePaper file={f} onOpen={() => onOpenFile(f.ref)} />;
  }
  if (item.kind === 'fact') {
    const f = factSources.find(s => s.ref === item.ref);
    if (!f) return null;
    return <StickyNote fact={f} />;
  }
  if (item.kind === 'question' && openQuestion) {
    return <QuestionTag msg={openQuestion} onAnswer={(text) => onAnswer(openQuestion.approvalId, text)} />;
  }
  return null;
}

function GoalPlacard({ goal }: { goal: string }) {
  return (
    <div
      className="w-[420px] px-5 py-3.5 text-[#f3e9d0]"
      style={{
        background:
          'linear-gradient(140deg, #6b2c2a 0%, #4a1816 60%, #3b110f 100%)',
        border: '1px solid #2a0908',
        borderRadius: 10,
        boxShadow: 'inset 0 0 24px rgba(0,0,0,0.5), 0 0 0 4px rgba(0,0,0,0.08)',
        backgroundBlendMode: 'multiply',
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.22em] text-[#d9c08c] mb-1">Your mission</div>
      <div className="text-[15px] leading-snug font-semibold tracking-tight">{goal}</div>
      <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest text-[#d9c08c]/70">
        <span className="inline-block w-2 h-2 rounded-full bg-[#c4a14a] shadow-[0_0_6px_#c4a14a]" />
        <span>signed off — TITAN</span>
      </div>
    </div>
  );
}

function DocumentPaper({ room }: { room: MissionRoom }) {
  const lines = useMemo(() => {
    const all = room.artifact.content.split('\n').filter(l => l.trim().length > 0);
    return all.slice(0, 10);
  }, [room.artifact.content]);
  const words = room.artifact.content.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div
      className="w-[460px] max-w-[88vw] bg-[#f7f5ee] text-[#1a1f2e] rounded-md p-7 pt-6"
      style={{
        fontFamily: '"Iowan Old Style", "Charter", "Georgia", serif',
        backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 26px, #d8d3c2 26px 27px)',
        backgroundPosition: '0 48px',
      }}
    >
      <h1 className="text-[20px] font-semibold tracking-tight leading-tight mb-1">
        {shorten(room.goal, 70)}
      </h1>
      <div className="text-[11px] uppercase tracking-widest text-[#8a8472] mb-4">
        Draft · {words} words · {statusToLabel(room.status)}
      </div>
      {lines.length > 0 ? (
        <div className="text-[13px] leading-[1.55] space-y-3">
          {lines.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      ) : (
        <div className="text-[12px] italic text-[#8a8472] py-6 text-center">
          The team is just getting started — your document fills in as they work.
        </div>
      )}
    </div>
  );
}

function CostInkwell({ room }: { room: MissionRoom }) {
  return (
    <div
      className="w-[110px] h-[110px] rounded-full flex flex-col items-center justify-center text-[#f3e9d0]"
      style={{
        background: 'radial-gradient(circle at 35% 30%, #2b1a14 0%, #1a0e08 70%)',
        boxShadow: 'inset 0 0 18px rgba(0,0,0,0.6), 0 0 0 5px #6e4a26, 0 0 0 6px #382213',
      }}
      title="Tokens + dollars spent this mission"
    >
      <span className="text-[9px] uppercase tracking-widest text-[#d9c08c]">spent</span>
      <span className="text-[20px] font-bold tabular-nums">${room.cost.usd.toFixed(2)}</span>
      <span className="text-[9px] text-[#d9c08c]/80 tabular-nums">{(room.cost.tokens / 1000).toFixed(1)}k tok</span>
    </div>
  );
}

/**
 * Desk clock — big segmented-LCD numerals showing the user's local
 * wall-clock time, with the mission's elapsed time as a secondary line
 * and live agent counters below.
 *
 * v6.1.0-alpha.20 — was showing mission elapsed time as the headline.
 * Tony asked for "the clock to run off the system time zone" — so the
 * big numerals are now the local time (formatted via `toLocaleTimeString`
 * so it picks up the browser's locale + timezone automatically), and
 * the elapsed-time hint moved to a smaller line underneath. Tick every
 * second.
 */
function DeskClock({ room }: { room: MissionRoom }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Local wall-clock parts. Use 24h so the digits stay aligned and the
  // segmented-LCD aesthetic reads cleanly. The locale's tz name is
  // shown below in the brand-engraving line.
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  // Resolve the system tz once (memoized — doesn't change while the
  // clock is on screen) into a short label like "PDT".
  const tzShort = useMemo(() => {
    try {
      const m = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
        .formatToParts(new Date())
        .find(p => p.type === 'timeZoneName');
      return m?.value ?? '';
    } catch { return ''; }
  }, []);

  // Mission elapsed (secondary line). Counts up while at least one
  // agent works; freezes on terminal mission status so the chime
  // doesn't keep ticking past completion.
  const startMs = useMemo(() => new Date(room.createdAt).getTime(), [room.createdAt]);
  const frozen = room.status === 'paused' || room.status === 'done' || room.status === 'failed';
  const elapsedMs = frozen
    ? Math.max(0, new Date(room.updatedAt).getTime() - startMs)
    : Math.max(0, now.getTime() - startMs);
  const elapsed = splitHMS(elapsedMs);

  const { working, blocked } = countTeam(room);

  return (
    <div
      className="w-[260px] p-4 pb-3 text-[#f5d27a]"
      style={{
        background: 'radial-gradient(ellipse at 30% 25%, #4a2e18 0%, #2a1808 75%, #1a0e04 100%)',
        borderRadius: 14,
        boxShadow:
          '0 0 0 3px #b08a3a, 0 0 0 5px #5a3a14, 0 12px 22px rgba(0,0,0,0.5), inset 0 0 16px rgba(0,0,0,0.6)',
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.28em] text-[#c4a14a] text-center mb-1.5">
        TITAN{tzShort ? ' · ' + tzShort : ''}
      </div>
      {/* Big local-time numerals */}
      <div
        className="flex items-baseline justify-center gap-1 mb-1"
        style={{
          fontFamily: '"DSEG7 Classic", "Orbitron", "Menlo", monospace',
          textShadow: '0 0 10px rgba(245,210,122,0.65), 0 0 22px rgba(245,210,122,0.35)',
        }}
      >
        <LCDPair value={hh} />
        <span className="text-[28px] font-bold opacity-80 -translate-y-0.5 animate-pulse">:</span>
        <LCDPair value={mm} />
        <span className="text-[20px] font-bold opacity-60 -translate-y-0.5">:</span>
        <span className="text-[24px] font-bold opacity-80 tabular-nums">{ss}</span>
      </div>
      {/* Mission elapsed — small secondary line */}
      <div
        className="text-center text-[10px] uppercase tracking-[0.22em] text-[#c4a14a]/85 mb-1.5"
        style={{ fontFamily: 'system-ui' }}
      >
        Mission · {elapsed.hh}:{elapsed.mm}:{elapsed.ss}
        {frozen && <span className="ml-1.5 text-[#d9c08c]/70">· {room.status}</span>}
      </div>
      <div
        className="flex items-center justify-center gap-3 pt-2 border-t border-[#5a3a14]/60"
        style={{ fontFamily: 'system-ui' }}
      >
        <ClockStat n={working} label="working" tone="accent" />
        <ClockStat n={blocked} label={blocked === 1 ? 'needs you' : 'need you'} tone="warn" />
        <ClockStat n={room.team.length} label="on team" tone="muted" />
      </div>
    </div>
  );
}

function LCDPair({ value }: { value: string }) {
  return (
    <span className="text-[34px] font-bold tabular-nums leading-none">{value}</span>
  );
}

function ClockStat({ n, label, tone }: { n: number; label: string; tone: 'accent' | 'warn' | 'muted' }) {
  const color = tone === 'accent' ? '#8ed1ff' : tone === 'warn' ? '#ff9c9c' : '#c4a14a';
  return (
    <div className="flex flex-col items-center leading-tight">
      <span className="text-[18px] font-bold tabular-nums" style={{ color }}>{n}</span>
      <span className="text-[9px] uppercase tracking-widest text-[#c4a14a]/80">{label}</span>
    </div>
  );
}

function splitHMS(ms: number): { hh: string; mm: string; ss: string } {
  const totalSec = Math.floor(ms / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return { hh, mm, ss };
}

function AgentCard({ member }: { member: MissionMember }) {
  const blocked = member.state === 'blocked';
  const active = member.state === 'working' || member.state === 'editing';
  // v6.1.0-alpha.18 — agents are sticky notes now. Each agent's color
  // tints its note, so the Scout's note feels different from the
  // Builder's. Tape strip across the top. Slight desaturated paper
  // texture from a linear-gradient.
  const stickyBg = paperFromColor(member.color, blocked);
  // v6.1.0-alpha.24 — gentle breathing bob on the sticky when the agent
  // is actively working. Lives on the OUTER card so the desk's parent
  // Draggable rotation transform composes correctly (CSS transforms on
  // separate elements stack predictably). 3.4s loop with a slight
  // per-agent phase offset (driven by the first agentId char's char
  // code mod 10) so multiple working agents don't bob in unison.
  const phaseDelay = active ? `${(member.agentId.charCodeAt(0) % 10) * 0.34}s` : '0s';
  return (
    <div
      className="w-[220px] p-3.5 pt-5 text-[#2a2418] relative"
      style={{
        background: stickyBg,
        boxShadow: '0 1px 0 rgba(255,255,255,0.55) inset, 0 12px 18px rgba(0,0,0,0.42)',
        fontFamily: '"Bradley Hand", "Marker Felt", "Comic Sans MS", cursive',
        animation: active ? 'stickyBreathe 3.4s ease-in-out infinite' : 'none',
        animationDelay: phaseDelay,
      }}
    >
      {/* Translucent washi tape across the top */}
      <div
        className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-20 h-4 opacity-70 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0.25))',
          boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
        }}
      />
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center text-white font-bold text-[13px]"
          style={{ background: `linear-gradient(135deg, ${member.color}, ${shade(member.color, -25)})`, boxShadow: `0 2px 6px ${member.color}55`, fontFamily: 'system-ui' }}
        >{member.name[0]}</div>
        <div className="leading-tight">
          <div className="font-semibold text-[15px] text-[#2a2418]">{member.name}</div>
          <div className="text-[10px] uppercase tracking-widest text-[#6b5a3a]" style={{ fontFamily: 'system-ui' }}>{member.role}</div>
        </div>
        <div className="ml-auto flex items-center gap-1 text-[10px] text-[#6b5a3a]" style={{ fontFamily: 'system-ui' }}>
          <span
            className={`w-1.5 h-1.5 rounded-full ${heartbeatClass(member.state)}`}
            style={{ boxShadow: `0 0 6px ${heartbeatColor(member.state)}` }}
          />
          <span>{stateLabel(member.state)}</span>
        </div>
      </div>
      <div className="text-[14px] text-[#2a2418] leading-snug min-h-[2.4rem] break-words">
        {member.currentActivity ?? <span className="italic text-[#6b5a3a]">standing by</span>}
      </div>
      {(active || blocked) && (
        <div
          className="absolute -inset-1 -z-10 pointer-events-none rounded-[2px] blur-md"
          style={{
            background: blocked
              ? 'radial-gradient(circle at 50% 50%, rgba(239,68,68,0.6), transparent 70%)'
              : `radial-gradient(circle at 30% 30%, ${member.color}55, transparent 70%)`,
            animation: blocked ? 'deskAlarm 1.8s ease-in-out infinite' : 'deskGlow 4.2s ease-in-out infinite',
          }}
        />
      )}
    </div>
  );
}

/**
 * Build a sticky-note background tinted by the agent's color. Uses two
 * subtle linear-gradients to fake paper texture without an image asset.
 * Blocked agents get a red-shifted tint so you spot them across the
 * desk immediately.
 */
function paperFromColor(hex: string, blocked: boolean): string {
  if (blocked) {
    return 'linear-gradient(165deg, #ffd6d6 0%, #ffbaba 100%), linear-gradient(45deg, transparent 49%, rgba(0,0,0,0.04) 49% 51%, transparent 51%)';
  }
  // Map known agent colors to sticky-note tones. Falls back to a
  // generic yellow if the color is unrecognized.
  const lower = hex.toLowerCase();
  if (lower.includes('6366f1') || lower.includes('8b5cf6')) {
    // Scout / Sage — cool blue-violet → soft lavender note
    return 'linear-gradient(160deg, #e7e1ff 0%, #cfc4ff 100%)';
  }
  if (lower.includes('22c55e') || lower.includes('10b981')) {
    // Builder — green → mint
    return 'linear-gradient(160deg, #d9f7d9 0%, #b8edb8 100%)';
  }
  if (lower.includes('f59e0b') || lower.includes('eab308')) {
    // Writer / Analyst — amber → classic yellow
    return 'linear-gradient(160deg, #fff2a8 0%, #ffe88a 100%)';
  }
  if (lower.includes('ef4444') || lower.includes('f97316')) {
    // Critic-style — orange → coral
    return 'linear-gradient(160deg, #ffd6c2 0%, #ffbf9e 100%)';
  }
  if (lower.includes('06b6d4') || lower.includes('0ea5e9')) {
    // cool cyan → robin's egg
    return 'linear-gradient(160deg, #cef3f7 0%, #a8e4ec 100%)';
  }
  // Default — soft pastel yellow Post-it
  return 'linear-gradient(160deg, #fff2a8 0%, #ffe88a 100%)';
}

function FilePaper({ file, onOpen }: { file: FileSource; onOpen: () => void }) {
  const filename = useMemo(() => {
    const slash = file.ref.lastIndexOf('/');
    return slash >= 0 ? file.ref.slice(slash + 1) : file.ref;
  }, [file.ref]);
  return (
    <div
      onDoubleClick={onOpen}
      title="Double-click to open"
      className="w-[200px] p-3 text-[#1a1f2e]"
      style={{
        background: 'linear-gradient(170deg, #fdfbf3 0%, #f1eada 100%)',
        borderRadius: 4,
        boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 0 0 1px rgba(0,0,0,0.06)',
      }}
    >
      {/* Bent corner */}
      <div
        className="absolute top-0 right-0 w-4 h-4"
        style={{
          background: 'linear-gradient(225deg, #d8cdb3 0%, #f1eada 50%, transparent 50%)',
          borderBottomLeftRadius: 4,
        }}
      />
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-base leading-none">{file.type === 'report' ? '📊' : '📄'}</span>
        <span className="text-[9px] uppercase tracking-widest text-[#8a8472]">{file.type}</span>
      </div>
      <div className="font-semibold text-[12px] leading-tight break-words text-[#1a1f2e]">{filename}</div>
      {file.description && (
        <div className="text-[10px] text-[#5a5240] mt-1 leading-snug line-clamp-2">{file.description}</div>
      )}
      <button
        data-no-drag
        onClick={onOpen}
        className="mt-2 w-full px-2 py-1 text-[10px] font-semibold uppercase tracking-widest bg-[#1a1f2e] text-[#f3e9d0] rounded hover:bg-[#3a3525]"
      >Open ↗</button>
    </div>
  );
}

function StickyNote({ fact }: { fact: FactSource }) {
  // Use the description if it exists (longer, human-readable), else the
  // ref (which is the fact string itself for fact-type sources).
  const text = fact.description ?? fact.ref;
  return (
    <div
      className="w-[160px] p-3 text-[#3a2e10]"
      style={{
        background: 'linear-gradient(160deg, #fff2a8 0%, #ffe88a 100%)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.5) inset, 0 8px 14px rgba(0,0,0,0.35)',
        fontFamily: '"Bradley Hand", "Comic Sans MS", cursive',
      }}
    >
      {/* Tape across the top */}
      <div
        className="absolute -top-2 left-1/2 -translate-x-1/2 w-12 h-3.5 opacity-60"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.65), rgba(255,255,255,0.25))',
        }}
      />
      <div className="text-[12px] leading-snug">{text}</div>
    </div>
  );
}

function QuestionTag({
  msg, onAnswer,
}: {
  msg: Extract<MissionMessage, { kind: 'question' }>;
  onAnswer: (answer: string) => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (customMode && taRef.current) taRef.current.focus(); }, [customMode]);

  return (
    <div
      className="w-[280px] p-3.5 rounded-xl text-[#5c1820]"
      style={{
        background: 'linear-gradient(180deg, #ffe9eb, #ffd0d4)',
        boxShadow: '0 8px 28px rgba(255,93,108,0.4), 0 0 0 1px rgba(160,41,56,0.18)',
        animation: 'deskFloat 4s ease-in-out infinite',
      }}
    >
      {/* Brass pin */}
      <div
        className="absolute -top-2 -right-2 w-5 h-5 rounded-full"
        style={{
          background: 'radial-gradient(circle at 35% 30%, #ffd86e 0%, #b07a1a 70%, #6a4710 100%)',
          boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
        }}
      />
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 mb-2 bg-[#5c1820] text-[#ffd0d4] text-[10px] uppercase tracking-widest font-bold rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        {msg.from.name} asks
      </div>
      <div className="text-[13px] leading-snug">{msg.content}</div>
      {!customMode ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {msg.quickReplies.map((q, i) => (
            <button
              key={q}
              data-no-drag
              onClick={() => onAnswer(q)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
                i === msg.quickReplies.length - 1
                  ? 'bg-[#1a1f2e] text-[#f3e9d0] border-transparent'
                  : 'bg-white border-[rgba(160,41,56,0.25)] text-[#5c1820]'
              }`}
            >{q}</button>
          ))}
          <button
            data-no-drag
            onClick={() => setCustomMode(true)}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium underline underline-offset-2 text-[#5c1820]/80 hover:text-[#5c1820]"
          >or type…</button>
        </div>
      ) : (
        <div className="mt-3">
          <textarea
            ref={taRef}
            data-no-drag
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const t = customText.trim();
                if (t) onAnswer(t);
              } else if (e.key === 'Escape') {
                setCustomMode(false);
              }
            }}
            rows={2}
            placeholder="Your answer…"
            className="w-full bg-white/90 border border-[rgba(160,41,56,0.25)] rounded-lg p-2 text-[12px] text-[#5c1820] outline-none"
          />
          <div className="flex items-center justify-end gap-2 mt-1">
            <button data-no-drag onClick={() => setCustomMode(false)} className="text-[10px] text-[#5c1820]/70 hover:text-[#5c1820]">cancel</button>
            <button
              data-no-drag
              onClick={() => { const t = customText.trim(); if (t) onAnswer(t); }}
              disabled={!customText.trim()}
              className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[#1a1f2e] text-[#f3e9d0] disabled:opacity-50"
            >Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filing cabinet ────────────────────────────────────────────────────

/**
 * A small wooden two-drawer filing cabinet. Acts as a drop zone for
 * files / facts (Draggable hits `data-drop-target="cabinet"` on
 * mouseup). Clicking it (no movement) opens the drawer overlay so
 * the user can browse what's inside and pull items back to the desk.
 *
 * Visual: walnut body, brass label plates with the count, two drawer
 * pulls. Hover hint reads "Drop here to file, click to open".
 */
function FilingCabinet({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <div
      data-drop-target="cabinet"
      className="w-[140px] flex flex-col text-[#f5d27a]"
      title={count > 0 ? `${count} filed — click to open` : 'Drop files & notes here'}
    >
      <button
        data-no-drag
        onClick={onOpen}
        className="text-left flex flex-col gap-1 p-0 bg-transparent border-none"
      >
        {[0, 1].map(row => (
          <div
            key={row}
            className="relative w-full h-[58px] flex items-center justify-center"
            style={{
              background:
                'linear-gradient(180deg, #5a3a18 0%, #3a230b 100%), repeating-linear-gradient(90deg, rgba(255,180,90,0.05) 0px, rgba(60,30,10,0.08) 2px)',
              border: '1px solid #2a1808',
              boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.08) inset',
            }}
          >
            {/* Brass label plate */}
            <div
              className="px-3 py-0.5 text-[10px] uppercase tracking-widest text-[#3a2a10] font-bold"
              style={{
                background: 'linear-gradient(180deg, #ffd86e 0%, #b07a1a 100%)',
                borderRadius: 2,
                boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
              }}
            >
              {row === 0 ? 'Files' : 'Drafts'}
            </div>
            {/* Brass pull */}
            <div
              className="absolute right-3 w-6 h-1.5 rounded"
              style={{
                background: 'linear-gradient(180deg, #ffd86e 0%, #8a5810 100%)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
              }}
            />
          </div>
        ))}
      </button>
      {count > 0 && (
        <div className="mt-1 text-center text-[10px] uppercase tracking-widest text-[#d9c08c]">
          {count} {count === 1 ? 'item' : 'items'} inside
        </div>
      )}
    </div>
  );
}

function Wastebasket({ count }: { count: number }) {
  // Generate wadded-paper visuals based on count.
  const wads = Math.min(count, 6);
  return (
    <div
      data-drop-target="trash"
      className="relative w-[110px] h-[120px]"
      title={count > 0 ? `${count} tossed — drag from cabinet to restore` : 'Drop notes here to toss them'}
    >
      {/* Wads peeking over the rim — drawn behind the basket front */}
      <div className="absolute inset-x-3 top-3 bottom-12 flex flex-wrap gap-1 items-end justify-center overflow-hidden">
        {Array.from({ length: wads }).map((_, i) => (
          <div
            key={i}
            className="rounded-full"
            style={{
              width: 18 + ((i * 5) % 14),
              height: 18 + ((i * 7) % 12),
              background: 'radial-gradient(circle at 35% 30%, #fffaee 0%, #d6cdb1 70%, #a99b71 100%)',
              boxShadow: 'inset -2px -2px 4px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.3)',
              transform: `rotate(${(i * 37) % 60 - 30}deg)`,
            }}
          />
        ))}
      </div>
      {/* Basket — concentric mesh pattern */}
      <div
        className="absolute left-2 right-2 bottom-0 h-[80px] overflow-hidden"
        style={{
          clipPath: 'polygon(8% 0%, 92% 0%, 100% 100%, 0% 100%)',
          background:
            'repeating-linear-gradient(90deg, #5a3a18 0px, #5a3a18 2px, #3a230b 2px, #3a230b 4px),' +
            'repeating-linear-gradient(0deg, transparent 0 6px, rgba(0,0,0,0.25) 6px 7px)',
          border: '1px solid #2a1808',
          borderRadius: 4,
          boxShadow: 'inset 0 4px 8px rgba(0,0,0,0.5)',
        }}
      />
      {/* Rim */}
      <div
        className="absolute left-1 right-1 bottom-[78px] h-2.5 rounded-sm"
        style={{
          background: 'linear-gradient(180deg, #6b4720 0%, #3a230b 100%)',
          border: '1px solid #1a0f05',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
        }}
      />
      {count > 0 && (
        <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-[#d9c08c] whitespace-nowrap">
          {count} tossed
        </div>
      )}
    </div>
  );
}

/**
 * Drawer overlay shown when the cabinet is open. Lists every filed
 * item with a row per item.
 *
 * Three ways to get an item back to the desk:
 *   1. Click the **to desk** button on the row — restores at last
 *      known pose.
 *   2. Click the **Open ↗** button (files only) — opens in the
 *      FileViewer (the file stays filed).
 *   3. **v6.1.0-alpha.20 — drag the row out.** Mousedown anywhere on
 *      the row body (not on a button) starts a drag-out gesture: the
 *      drawer closes, a ghost preview follows the cursor, and on
 *      mouseup the item is restored to the desk AT the cursor
 *      position. This is the natural "pull a file out of the cabinet"
 *      motion Tony asked for.
 */
function CabinetDrawer({
  itemIds, items, fileSources, factSources, onRestore, onRestoreAt, onOpenFile, onClose,
}: {
  itemIds: string[];
  items: DeskItem[];
  fileSources: FileSource[];
  factSources: FactSource[];
  onRestore: (itemId: string) => void;
  /** v6.1.0-alpha.20 — restore an item AND place it at a specific
   *  screen position (used for drag-out gesture). */
  onRestoreAt: (itemId: string, x: number, y: number) => void;
  onOpenFile: (ref: string) => void;
  onClose: () => void;
}) {
  // Drag-out state — when the user mousedowns on a row, we close the
  // drawer and start tracking a ghost preview. On mouseup, restore
  // the item at the cursor's screen position.
  const [dragOut, setDragOut] = useState<{
    itemId: string;
    label: string;
    icon: string;
    x: number;
    y: number;
  } | null>(null);

  // Global mousemove + mouseup listeners while dragging.
  useEffect(() => {
    if (!dragOut) return;
    const onMove = (e: MouseEvent) => {
      setDragOut(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
    };
    const onUp = (e: MouseEvent) => {
      onRestoreAt(dragOut.itemId, e.clientX, e.clientY);
      setDragOut(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragOut, onRestoreAt]);

  function startDragOut(e: React.MouseEvent, itemId: string, label: string, icon: string) {
    // Don't start a drag-out if the click landed on a button — the
    // button has its own click semantic (open / restore-to-pose).
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag]')) return;
    e.preventDefault();
    setDragOut({ itemId, label, icon, x: e.clientX, y: e.clientY });
    onClose(); // close the drawer so the desk is visible
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl overflow-hidden text-[#f5d27a]"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(180deg, #4a2e18 0%, #2a1808 100%)',
          boxShadow: '0 0 0 3px #b08a3a, 0 30px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[#6e4724]">
          <span className="text-2xl">🗄️</span>
          <div className="flex-1">
            <div className="text-sm font-semibold tracking-tight">Filing cabinet</div>
            <div className="text-[11px] text-[#d9c08c]">{itemIds.length} item{itemIds.length === 1 ? '' : 's'} filed · drag a row out, or click <b>to desk</b></div>
          </div>
          <button data-no-drag onClick={onClose} className="w-8 h-8 rounded-full bg-[#1a0f05] border border-[#6e4724] text-[#d9c08c] hover:text-white flex items-center justify-center">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {itemIds.length === 0 && (
            <div className="text-center py-12 text-[#d9c08c] italic">
              Nothing filed yet. Drag a file or sticky note onto the cabinet to file it.
            </div>
          )}
          {itemIds.map(itemId => {
            const item = items.find(i => i.id === itemId);
            if (!item) return (
              <div key={itemId} className="flex items-center justify-between px-3 py-2 bg-[#1a0f05]/40 border border-[#6e4724]/50 rounded-lg text-[#d9c08c]/70">
                <span className="text-xs italic">{itemId} (no longer in mission)</span>
                <button data-no-drag onClick={() => onRestore(itemId)} className="text-[11px] hover:text-white">remove</button>
              </div>
            );
            const f = item.kind === 'file' ? fileSources.find(s => s.ref === item.ref) : undefined;
            const fact = item.kind === 'fact' ? factSources.find(s => s.ref === item.ref) : undefined;
            const icon = f ? (f.type === 'report' ? '📊' : '📄') : fact ? '💡' : '📌';
            const label = f?.ref ?? fact?.ref ?? itemId;
            return (
              <div
                key={itemId}
                onMouseDown={(e) => startDragOut(e, itemId, label, icon)}
                className="flex items-center gap-3 px-3 py-2 bg-[#1a0f05]/40 border border-[#6e4724]/50 rounded-lg hover:bg-[#1a0f05]/60 transition-colors cursor-grab active:cursor-grabbing"
                title="Drag out to place on the desk, or use the buttons →"
              >
                <span className="text-lg leading-none">{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[#f5d27a] truncate">{label}</div>
                  {(f?.description ?? fact?.description) && (
                    <div className="text-[10px] text-[#d9c08c] truncate">{f?.description ?? fact?.description}</div>
                  )}
                </div>
                {f && (
                  <button data-no-drag onClick={() => onOpenFile(f.ref)} className="px-2 py-1 text-[10px] bg-[#6e4724] border border-[#b08a3a] rounded text-[#f5d27a] hover:text-white">Open ↗</button>
                )}
                <button data-no-drag onClick={() => onRestore(itemId)} className="px-2 py-1 text-[10px] bg-[#1a0f05] border border-[#6e4724] rounded text-[#d9c08c] hover:text-white">to desk</button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Ghost preview that follows the cursor during drag-out. */}
      {dragOut && (
        <div
          className="fixed z-[70] pointer-events-none"
          style={{ left: dragOut.x - 80, top: dragOut.y - 20 }}
        >
          <div
            className="px-3 py-2 rounded bg-[#fdfbf3] text-[#1a1f2e] text-xs flex items-center gap-2 shadow-2xl"
            style={{ transform: 'rotate(-2deg)' }}
          >
            <span>{dragOut.icon}</span>
            <span className="font-semibold truncate max-w-[200px]">{dragOut.label}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Visual constants ─────────────────────────────────────────────────

const deskStyle: React.CSSProperties = {
  background: [
    // Knot near upper-right
    'radial-gradient(ellipse 120px 80px at 78% 28%, rgba(40,18,8,0.55) 0%, rgba(40,18,8,0) 70%)',
    // Knot near lower-left
    'radial-gradient(ellipse 90px 60px at 22% 72%, rgba(40,18,8,0.45) 0%, rgba(40,18,8,0) 75%)',
    // Primary grain — long horizontal wisps
    'repeating-linear-gradient(92deg, rgba(255,180,90,0.05) 0px, rgba(60,30,10,0.08) 3px, rgba(255,180,90,0.04) 7px, rgba(60,30,10,0.10) 11px, rgba(255,180,90,0.06) 16px)',
    // Slight cross grain for texture variation
    'repeating-linear-gradient(0deg, rgba(0,0,0,0.04) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.03) 4px)',
    // Base wood color
    'linear-gradient(180deg, #6e4724 0%, #5a3717 50%, #482a13 100%)',
  ].join(','),
};

const glowStyle: React.CSSProperties = {
  background: 'radial-gradient(ellipse 80% 60% at 20% 0%, rgba(255,220,140,0.18) 0%, rgba(0,0,0,0) 55%)',
};

const vignetteStyle: React.CSSProperties = {
  background: 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.45) 100%)',
};

const KEYFRAMES = `
@keyframes deskGlow {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 0.8; }
}
@keyframes deskAlarm {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}
@keyframes deskFloat {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-3px); }
}
/* v6.1.0-alpha.24 — gentle bob on working sticky notes. Lives on an
   INNER wrapper so it composes with the parent Draggable's rotation
   transform. */
@keyframes stickyBreathe {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2.5px); }
}
/* Tether-line dash flow — animates stroke-dashoffset to give the
   thread a moving-current feel. The dasharray defines the segment
   pattern. */
@keyframes tetherFlow {
  to { stroke-dashoffset: -20; }
}
/* Dust mote drift — slow vertical drift with a gentle horizontal
   wobble. Two duration variants so motes don't tick in unison. */
@keyframes mote1 {
  0%   { transform: translate(0, 0) scale(1); opacity: 0; }
  10%  { opacity: 0.55; }
  90%  { opacity: 0.45; }
  100% { transform: translate(14px, -90vh) scale(1.1); opacity: 0; }
}
@keyframes mote2 {
  0%   { transform: translate(0, 0) scale(0.9); opacity: 0; }
  10%  { opacity: 0.4; }
  90%  { opacity: 0.3; }
  100% { transform: translate(-12px, -90vh) scale(1); opacity: 0; }
}
`;

/**
 * v6.1.0-alpha.24 — Living desk layer.
 *
 * Renders BEHIND the draggable item layer (z-5). Two responsibilities:
 *
 *   1. **Tether lines** — for each agent currently `working` or
 *      `editing` (and not paused, not hidden), draw a dashed amber
 *      thread from the agent's card center to the document's card
 *      center. The dashes animate flowing toward the document, so
 *      the user sees energy moving from helper → artifact.
 *
 *   2. **Dust motes** — soft white-cream particles drifting upward
 *      across the whole desk. Only present while at least one agent
 *      is doing something. The count scales with the team size
 *      (capped). They animate via CSS keyframes; we render a fixed
 *      pool so React doesn't churn DOM nodes.
 *
 * Pure visual layer. `pointer-events-none` everywhere — nothing here
 * intercepts drags or clicks. Reads the live pose map so tethers
 * follow agents around when the user repositions them.
 */
function LivingDeskLayer({
  items, room, poseOf, isHidden,
}: {
  items: DeskItem[];
  room: MissionRoom;
  poseOf: (item: DeskItem) => ItemPose;
  isHidden: (itemId: string) => boolean;
}) {
  // Document item is the tether endpoint.
  const docItem = items.find(i => i.kind === 'document');
  const docPose = docItem && !isHidden(docItem.id) ? poseOf(docItem) : null;

  // Working / editing agents that are visible and not paused.
  const activeAgents = useMemo(() => {
    if (!docPose) return [] as Array<{ item: DeskItem; member: MissionMember; pose: ItemPose }>;
    const out: Array<{ item: DeskItem; member: MissionMember; pose: ItemPose }> = [];
    for (const item of items) {
      if (item.kind !== 'agent') continue;
      if (isHidden(item.id)) continue;
      const member = room.team.find(t => t.agentId === item.ref);
      if (!member) continue;
      if (member.paused) continue;
      if (member.state !== 'working' && member.state !== 'editing') continue;
      out.push({ item, member, pose: poseOf(item) });
    }
    return out;
  }, [items, room.team, poseOf, isHidden, docPose]);

  const anyWorking = activeAgents.length > 0;

  // Approximate card dimensions so tether endpoints sit at card centers.
  // (We don't measure DOM here — the dimensions are stable from the JSX.)
  const AGENT_W = 220;
  const AGENT_H = 110;
  const DOC_W = 460;
  const DOC_H = 260;

  return (
    <>
      {/* Tether SVG layer. Sits behind draggables (z-5). */}
      {docPose && activeAgents.length > 0 && (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 5 }}
          aria-hidden
        >
          <defs>
            <radialGradient id="tetherNodeGlow">
              <stop offset="0%"  stopColor="#ffd86e" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#ffd86e" stopOpacity="0" />
            </radialGradient>
          </defs>
          {activeAgents.map(({ item, member, pose }) => {
            const ax = pose.x + AGENT_W / 2;
            const ay = pose.y + AGENT_H / 2;
            const dx = docPose.x + DOC_W / 2;
            const dy = docPose.y + DOC_H / 2;
            // Gentle bezier curve so multiple tethers don't visually overlap.
            // The control point lifts slightly toward the top of the screen.
            const mx = (ax + dx) / 2;
            const my = (ay + dy) / 2 - 40;
            const path = `M ${ax} ${ay} Q ${mx} ${my}, ${dx} ${dy}`;
            const tetherColor =
              member.state === 'editing' ? 'rgba(245, 158, 11, 0.55)' :
              member.state === 'blocked' ? 'rgba(239, 68, 68, 0.7)' :
              'rgba(255, 216, 110, 0.55)';
            return (
              <g key={item.id}>
                <path
                  d={path}
                  fill="none"
                  stroke={tetherColor}
                  strokeWidth={1.4}
                  strokeDasharray="8 8"
                  style={{ animation: 'tetherFlow 1.6s linear infinite' }}
                />
                {/* Small glow at the agent end of the thread */}
                <circle cx={ax} cy={ay} r={14} fill="url(#tetherNodeGlow)" />
              </g>
            );
          })}
        </svg>
      )}

      {/* Dust motes — only mounted while work is happening so a quiet
          desk stays calm. */}
      {anyWorking && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 6 }} aria-hidden>
          {DUST_MOTES.map((m, i) => (
            <span
              key={i}
              className="absolute rounded-full"
              style={{
                left: `${m.left}vw`,
                bottom: `${-5 + (m.delay % 12)}vh`,
                width: m.size,
                height: m.size,
                background: 'radial-gradient(circle at 35% 30%, rgba(255,250,235,0.85) 0%, rgba(212,196,158,0.4) 60%, rgba(0,0,0,0) 100%)',
                animation: `${i % 2 === 0 ? 'mote1' : 'mote2'} ${m.duration}s linear infinite`,
                animationDelay: `${m.delay}s`,
                filter: 'blur(0.4px)',
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

// A fixed pool of dust-mote configs so they render with stable identity
// across re-renders. Twelve is enough density without distraction.
const DUST_MOTES: Array<{ left: number; size: number; duration: number; delay: number }> = [
  { left:  6, size: 3, duration: 28, delay: 0 },
  { left: 14, size: 2, duration: 36, delay: 3 },
  { left: 22, size: 4, duration: 30, delay: 8 },
  { left: 30, size: 2, duration: 40, delay: 1 },
  { left: 38, size: 3, duration: 26, delay: 5 },
  { left: 46, size: 3, duration: 34, delay: 11 },
  { left: 54, size: 2, duration: 38, delay: 2 },
  { left: 62, size: 4, duration: 32, delay: 7 },
  { left: 70, size: 3, duration: 30, delay: 9 },
  { left: 78, size: 2, duration: 36, delay: 4 },
  { left: 86, size: 3, duration: 28, delay: 12 },
  { left: 94, size: 4, duration: 34, delay: 6 },
];

// ── Small helpers (parity with chat view) ────────────────────────────

function countTeam(room: MissionRoom) {
  let working = 0, blocked = 0;
  for (const m of room.team) {
    if (m.state === 'working' || m.state === 'editing') working++;
    if (m.state === 'blocked') blocked++;
  }
  return { working, blocked };
}

function statusBlurb(s: MissionRoom['status'], working: number, blocked: number): string {
  if (s === 'paused')  return 'Paused';
  if (s === 'done')    return 'Done';
  if (s === 'failed')  return 'Stopped';
  if (blocked > 0)     return `${working} working · ${blocked} needs you`;
  if (working > 0)     return `${working} working`;
  if (s === 'forming') return 'Forming team…';
  return 'Idle';
}

function statusToLabel(s: MissionRoom['status']): string {
  if (s === 'paused') return 'paused';
  if (s === 'done') return 'done';
  if (s === 'failed') return 'stopped';
  if (s === 'blocked') return 'waiting on you';
  return 'auto-saving';
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function heartbeatClass(s: string): string {
  switch (s) {
    case 'working': return 'bg-accent animate-pulse';
    case 'editing': return 'bg-warning animate-pulse';
    case 'blocked': return 'bg-error animate-pulse';
    case 'done':    return 'bg-success';
    default:        return 'bg-text-muted';
  }
}

function heartbeatColor(s: string): string {
  switch (s) {
    case 'working': return '#6366f1';
    case 'editing': return '#f59e0b';
    case 'blocked': return '#ef4444';
    case 'done':    return '#22c55e';
    default:        return '#71717a';
  }
}

function stateLabel(s: string): string {
  if (s === 'working') return 'working';
  if (s === 'editing') return 'editing';
  if (s === 'blocked') return 'needs you';
  if (s === 'done')    return 'done';
  return 'idle';
}

function shade(hex: string, amount: number): string {
  const m = hex.replace('#', '');
  if (m.length !== 6) return hex;
  const num = parseInt(m, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const adjust = Math.round(255 * (amount / 100));
  r = Math.max(0, Math.min(255, r + adjust));
  g = Math.max(0, Math.min(255, g + adjust));
  b = Math.max(0, Math.min(255, b + adjust));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
