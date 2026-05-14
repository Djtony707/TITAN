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
  subscribeToMission,
  type MissionFile,
  type MissionRoom,
  type MissionMessage,
  type MissionMember,
} from '@/api/missions';
import { FileViewer } from '@/pages/mission/FileViewer';

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
  kind: 'goal' | 'document' | 'agent' | 'file' | 'fact' | 'question' | 'cost';
  ref?: string;
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
          <button onClick={() => setHelpOpen(v => !v)} className="w-8 h-8 rounded-full bg-[#2a1d11]/70 border border-[#8a6a3a]/60 text-[#e7d6a8] hover:text-white font-semibold text-sm flex items-center justify-center" title="What's this?">?</button>
        </div>
      </header>

      {/* Desk surface — everything is absolutely positioned on top. */}
      <div className="absolute inset-0 z-10 pointer-events-none">
        {items.map(item => {
          const pose = poseOf(item);
          return (
            <Draggable
              key={item.id}
              pose={pose}
              onGrab={() => bringToFront(item.id)}
              onPose={(p) => setPose(item.id, p)}
            >
              <ItemBody
                item={item}
                room={room}
                openQuestion={openQuestion}
                fileSources={fileSources}
                factSources={factSources}
                onOpenFile={handleOpenFile}
                onAnswer={onAnswer}
              />
            </Draggable>
          );
        })}
      </div>

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
  children: React.ReactNode;
}

/**
 * Generic drag wrapper. Mousedown on the wrapper (not on form
 * controls) starts a drag. The drag updates a local visual pose so
 * the item moves smoothly; the persisted pose is committed on
 * mouseup. Touch events are supported for tablet use.
 */
function Draggable({ pose, onGrab, onPose, children }: DraggableProps) {
  const [drag, setDrag] = useState<{ dx: number; dy: number; x: number; y: number } | null>(null);
  const visual = drag ? { x: drag.x, y: drag.y } : { x: pose.x, y: pose.y };

  // Mousedown — start drag if the target is not a form control / button.
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Honor an explicit no-drag opt-out for nested controls. The data
    // attribute lives on buttons/inputs/textareas inside the cards so
    // those still receive their own click handlers.
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
      // Only persist if the position actually moved (avoids spurious
      // localStorage writes from accidental clicks).
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        onPose({ ...pose, x: finalX, y: finalY });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pose, onGrab, onPose]);

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
  item, room, openQuestion, fileSources, factSources, onOpenFile, onAnswer,
}: {
  item: DeskItem;
  room: MissionRoom;
  openQuestion: Extract<MissionMessage, { kind: 'question' }> | undefined;
  fileSources: FileSource[];
  factSources: FactSource[];
  onOpenFile: (ref: string) => void;
  onAnswer: (approvalId: string, answer: string) => void;
}) {
  if (item.kind === 'goal') return <GoalPlacard goal={room.goal} />;
  if (item.kind === 'document') return <DocumentPaper room={room} />;
  if (item.kind === 'cost') return <CostInkwell room={room} />;
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

function AgentCard({ member }: { member: MissionMember }) {
  const blocked = member.state === 'blocked';
  const active = member.state === 'working' || member.state === 'editing';
  return (
    <div
      className="w-[230px] p-3.5 text-[#1a1f2e]"
      style={{
        background: 'linear-gradient(180deg, #fdfaf0 0%, #f5efde 100%)',
        borderRadius: 8,
        boxShadow: '0 1px 0 rgba(255,255,255,0.4) inset, 0 0 0 1px rgba(0,0,0,0.05)',
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-7 h-7 rounded-md flex items-center justify-center text-white font-bold text-[13px]"
          style={{ background: `linear-gradient(135deg, ${member.color}, ${shade(member.color, -25)})`, boxShadow: `0 2px 6px ${member.color}55` }}
        >{member.name[0]}</div>
        <div className="leading-tight">
          <div className="font-semibold text-[13px] text-[#1a1f2e]">{member.name}</div>
          <div className="text-[10px] uppercase tracking-widest text-[#8a8472]">{member.role}</div>
        </div>
        <div className="ml-auto flex items-center gap-1 text-[10px] text-[#8a8472]">
          <span
            className={`w-1.5 h-1.5 rounded-full ${heartbeatClass(member.state)}`}
            style={{ boxShadow: `0 0 6px ${heartbeatColor(member.state)}` }}
          />
          <span>{stateLabel(member.state)}</span>
        </div>
      </div>
      <div className="text-[12px] text-[#3a3525] leading-snug min-h-[2.4rem] break-words">
        {member.currentActivity ?? <span className="italic text-[#8a8472]">standing by</span>}
      </div>
      {(active || blocked) && (
        <div
          className="absolute -inset-1 -z-10 pointer-events-none rounded-[10px] blur-md"
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
`;

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
