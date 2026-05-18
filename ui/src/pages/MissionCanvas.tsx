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
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  kind: 'goal' | 'document' | 'agent' | 'file' | 'fact' | 'activity' | 'question' | 'cost' | 'clock' | 'cabinet' | 'trash';
  ref?: string;
}

/**
 * v6.1.0-alpha.31 — a live activity sticky on the desk. One per recent
 * tool call across the team. The agent's color tints the note so the
 * user can see at a glance which helper produced each sticky.
 */
interface ActivitySticky {
  /** Stable id derived from agentId + activity timestamp so React
   *  reuses the same DOM node across re-renders and the sticky's
   *  position survives. */
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  icon: string;
  activity: string;
  detail?: string;
  at: string;
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
  cabinet: string[];          // item ids filed away
  trash: string[];            // item ids tossed (recoverable)
  permanentlyHidden: string[]; // v6.1.0-alpha.33 — "deleted forever" from trash. Never renders again.
  cabinetOpen: boolean;
  trashOpen: boolean;          // v6.1.0-alpha.33 — drawer state for trash bin
}

function furnitureKey(missionId: string): string { return `titan-desk-furniture:${missionId}`; }
function loadFurniture(missionId: string): DeskFurniture {
  const base: DeskFurniture = { cabinet: [], trash: [], permanentlyHidden: [], cabinetOpen: false, trashOpen: false };
  try {
    const raw = localStorage.getItem(furnitureKey(missionId));
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<DeskFurniture>;
    return {
      cabinet: Array.isArray(parsed.cabinet) ? parsed.cabinet : [],
      trash: Array.isArray(parsed.trash) ? parsed.trash : [],
      permanentlyHidden: Array.isArray(parsed.permanentlyHidden) ? parsed.permanentlyHidden : [],
      cabinetOpen: Boolean(parsed.cabinetOpen),
      trashOpen: Boolean(parsed.trashOpen),
    };
  } catch { return base; }
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
  const canvasRootRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1400 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));

  useLayoutEffect(() => {
    const root = canvasRootRef.current;
    if (!root) return;
    const update = () => {
      const rect = root.getBoundingClientRect();
      setCanvasSize((prev) => {
        const width = Math.max(320, Math.round(rect.width));
        const height = Math.max(320, Math.round(rect.height));
        return prev.width === width && prev.height === height ? prev : { width, height };
      });
    };
    update();
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    resizeObserver?.observe(root);
    window.addEventListener('resize', update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [loading, room?.id]);

  const getCanvasRect = useCallback((): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'> => {
    const rect = canvasRootRef.current?.getBoundingClientRect();
    if (rect) return rect;
    return {
      left: 0,
      top: 0,
      width: typeof window === 'undefined' ? 1400 : window.innerWidth,
      height: typeof window === 'undefined' ? 800 : window.innerHeight,
    };
  }, []);

  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = getCanvasRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, [getCanvasRect]);

  const toClampedAgentMenuAnchor = useCallback((clientX: number, clientY: number): AgentMenuAnchor => {
    const point = toCanvasPoint(clientX, clientY);
    return {
      x: Math.max(8, Math.min(point.x, canvasSize.width - 328)),
      y: Math.max(8, Math.min(point.y, canvasSize.height - 368)),
    };
  }, [canvasSize, toCanvasPoint]);

  // Desk layout — pose per item id. Persisted to localStorage.
  const [layout, setLayout] = useState<DeskLayout>({});
  useEffect(() => { if (id) setLayout(loadLayout(id)); }, [id]);
  const persist = useCallback((next: DeskLayout) => {
    setLayout(next);
    if (id) saveLayout(id, next);
  }, [id]);

  // Filing cabinet / wastebasket state — what's filed away, what's tossed.
  const [furniture, setFurniture] = useState<DeskFurniture>({ cabinet: [], trash: [], permanentlyHidden: [], cabinetOpen: false, trashOpen: false });
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

  /**
   * v6.1.0-alpha.31 — flatten the team's activity logs into a flat
   * list of stickies. Newest first. Capped at 12 across the team so
   * the desk doesn't drown in stickies during a long spawn.
   */
  const activityStickies = useMemo<ActivitySticky[]>(() => {
    if (!room) return [];
    const out: ActivitySticky[] = [];
    for (const m of room.team) {
      const log = m.activityLog ?? [];
      for (const e of log) {
        out.push({
          id: `${m.agentId}:${e.at}:${e.icon}`,
          agentId: m.agentId,
          agentName: m.name,
          agentColor: m.color,
          icon: e.icon,
          activity: e.activity,
          detail: e.detail,
          at: e.at,
        });
      }
    }
    // Sort newest first, take top 12.
    out.sort((a, b) => (a.at < b.at ? 1 : -1));
    return out.slice(0, 12);
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
    for (const a of activityStickies) {
      out.push({ id: a.id, kind: 'activity', ref: a.id });
    }
    if (openQuestion) {
      out.push({ id: `q:${openQuestion.approvalId}`, kind: 'question', ref: openQuestion.approvalId });
    }
    return out;
  }, [room, fileSources, factSources, activityStickies, openQuestion]);

  /**
   * Whether an item is currently hidden from the desk surface.
   * v6.1.0-alpha.33 — also checks `permanentlyHidden` (items the user
   * "Deleted forever" from the trash drawer). Those never render
   * again, anywhere — not on the desk, not in any drawer.
   */
  const isHidden = useCallback((itemId: string) => {
    return furniture.cabinet.includes(itemId)
        || furniture.trash.includes(itemId)
        || furniture.permanentlyHidden.includes(itemId);
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

  // v6.1.0-alpha.33 — open/close the trash drawer.
  const toggleTrash = useCallback(() => {
    persistFurniture({ ...furniture, trashOpen: !furniture.trashOpen });
  }, [furniture, persistFurniture]);

  /**
   * v6.1.0-alpha.33 — "Delete forever" from the trash bin.
   * Removes the item from `trash` and adds it to `permanentlyHidden`,
   * which `isHidden()` checks separately. The item will never render
   * on the desk again. Unlike a backend delete, this is UI-only —
   * the underlying mission source (file path, fact, activity entry)
   * stays on disk, but the desk treats it as gone.
   */
  const deleteForever = useCallback((itemId: string) => {
    persistFurniture({
      ...furniture,
      trash: furniture.trash.filter(t => t !== itemId),
      permanentlyHidden: [...new Set([...furniture.permanentlyHidden, itemId])],
    });
  }, [furniture, persistFurniture]);

  /** Compute initial pose for an item that has no saved layout yet. */
  const initialPose = useCallback((item: DeskItem, allItems: DeskItem[]): ItemPose => {
    // Canvas-area approximation; use the measured shell-contained canvas pane
    // instead of the full viewport so the desktop sidebar never eats
    // right-edge items. The measurement is refreshed before paint via
    // useLayoutEffect and ResizeObserver.
    const vw = canvasSize.width;
    const vh = canvasSize.height;
    const cx = vw / 2;
    const cy = vh / 2;
    if (item.kind === 'goal') return { x: cx - 220, y: 90, z: 5, rotation: -1.2 };
    if (item.kind === 'document') return { x: cx - 240, y: cy - 220, z: 4, rotation: 0.4 };
    if (item.kind === 'cost') return { x: vw - 130, y: 90, z: 6, rotation: 2 };
    // v6.1.0-beta.5 — clock x moved from vw-280 to vw-440 so the
    // clock's actual rendered width (264 px) no longer extends past
    // x = vw - 16 and onto the wastebasket's slot at x = vw - 130.
    // Trash z also bumped 3→13 (above clock z=7 and above agent cards
    // z=10/11/12) so even if a future furniture move re-introduces
    // overlap the wastebasket stays visible.
    if (item.kind === 'clock') return { x: vw - 440, y: vh - 240, z: 7, rotation: -1.5 };
    if (item.kind === 'cabinet') return { x: 30, y: vh - 280, z: 3, rotation: 0 };
    if (item.kind === 'trash') return { x: vw - 130, y: vh - 220, z: 13, rotation: 0 };
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
    if (item.kind === 'activity') {
      // v6.1.0-alpha.49 — activity stickies now start at the bottom edge
      // to avoid covering the "Your Mission" goal placard. They fan upward
      // on the desk as new ones arrive, like a pile of incoming mail.
      const idx = allItems.filter(i => i.kind === 'activity').findIndex(i => i.id === item.id);
      const maxPerRow = Math.max(4, Math.floor((vw - 120) / 180));
      const col = idx % maxPerRow;
      const row = Math.floor(idx / maxPerRow);
      return {
        x: 40 + col * 180 + (row % 2 === 0 ? 0 : 40),
        y: vh - 200 - (row * 110),
        z: 14 + idx,
        rotation: (idx % 2 === 0 ? -1 : 1) * (2 + (idx * 0.3)),
      };
    }
    return { x: 100, y: 100, z: 1, rotation: 0 };
  }, [canvasSize]);

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
    // dropped pose visually lines up with where the ghost was. Convert the
    // viewport pointer location to canvas-local coordinates first because the
    // desk is contained inside TitanShell's main pane.
    const point = toCanvasPoint(x, y);
    setPose(itemId, { x: point.x - 80, y: point.y - 20, z: maxZ + 1, rotation });
  }, [furniture, persistFurniture, items, layout, initialPose, setPose, toCanvasPoint]);

  // ── Early-return guards (after all hooks) ─────────────────────

  if (loading) {
    return <div className="absolute inset-0 flex items-center justify-center text-sm" style={{ background: 'var(--theme-bg-base, #3a2a1c)', color: 'var(--theme-paper-fg, #f3e9d0)' }}>Setting the desk…</div>;
  }
  if (error || !room) {
    return (
      <div className="absolute inset-0 flex items-center justify-center flex-col gap-3" style={{ background: 'var(--theme-bg-base, #3a2a1c)' }}>
        <div className="text-[#ffb4a2] text-sm">{error ?? 'Mission not found.'}</div>
        <button onClick={() => navigate('/mission')} className="text-sm hover:underline" style={{ color: 'var(--theme-paper-fg, #f3e9d0)' }}>← Start a new mission</button>
      </div>
    );
  }

  const { working, blocked } = countTeam(room);

  return (
    <div ref={canvasRootRef} className="absolute inset-0 overflow-hidden font-sans" style={{ ...deskStyle, color: 'var(--theme-paper-fg, #f3e9d0)', fontFamily: 'var(--theme-font-display, ui-sans-serif, system-ui)' }}>
      {/* warm window-light glow + vignette */}
      <div className="pointer-events-none absolute inset-0" style={glowStyle} />
      <div className="pointer-events-none absolute inset-0" style={vignetteStyle} />

      {/* Top bar */}
      <header className="relative z-30 flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <button onClick={() => navigate('/mission')} className="hover:text-white text-sm" style={{ color: 'var(--theme-metal-bright, #e7d6a8)' }} title="New mission">←</button>
          <button
            onClick={() => navigate('/mission/library')}
            className="text-[10px] uppercase tracking-widest hover:text-white rounded-full px-2 py-0.5"
            style={{ color: 'var(--theme-ink-soft, #d9c08c)', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}
            title="Browse past missions"
          >
            Library
          </button>
          {/* v6.1.0-alpha.23 — back to the main canvas / spaces home. */}
          <button
            onClick={() => navigate('/space/home')}
            className="text-[10px] uppercase tracking-widest hover:text-white rounded-full px-2 py-0.5 inline-flex items-center gap-1"
            style={{ color: 'var(--theme-ink-soft, #d9c08c)', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}
            title="Back to the canvas spaces"
          >
            🌌 Canvas
          </button>
          <div className="min-w-0 font-semibold tracking-tight" style={{ color: 'var(--theme-paper-fg, #f3e9d0)' }}>
            <span style={{ background: 'linear-gradient(90deg, var(--theme-metal-bright, #f3d27a), var(--theme-metal, #d8a85a))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>TITAN</span>
            <span className="font-normal" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}> &nbsp;›&nbsp; </span>
            <span className="font-normal" style={{ color: 'var(--theme-metal-bright, #e7d6a8)' }}>Desk</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs" style={{ background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}>
            <span className={`w-2 h-2 rounded-full ${blocked > 0 ? 'bg-error animate-pulse' : working > 0 ? 'bg-accent animate-pulse' : 'bg-success'}`} />
            <span style={{ color: 'var(--theme-metal-bright, #e7d6a8)' }}>{statusBlurb(room.status, working, blocked)}</span>
          </div>
          {room.longRunningMode && (
            <div
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
              style={{
                background: 'linear-gradient(90deg, rgba(245,210,122,0.18), rgba(176,138,58,0.18))',
                border: '1px solid var(--theme-metal-dark, #b08a3a)',
                color: 'var(--theme-metal-bright, #ffd86e)',
              }}
              title="Marathon mode — long-running multi-agent collaboration (72h cap)"
            >
              🏃 Marathon
            </div>
          )}
          <button
            onClick={tidyUp}
            className="px-3 py-1.5 text-xs rounded-full hover:text-white"
            style={{ background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))', color: 'var(--theme-metal-bright, #e7d6a8)' }}
            title="Reset every item to a sensible starting position"
          >Tidy up</button>
          <button
            onClick={() => navigate(`/mission/${room.id}`)}
            className="px-3 py-1.5 text-xs rounded-full hover:text-white"
            style={{ background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))', color: 'var(--theme-metal-bright, #e7d6a8)' }}
            title="Switch to the chat thread view"
          >Chat view</button>
          <button
            onClick={onTogglePause}
            className="px-3 py-1.5 text-xs rounded-full hover:text-white"
            style={{ background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))', color: 'var(--theme-metal-bright, #e7d6a8)' }}
          >
            {room.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          {/* v6.1.0-alpha.27 — delete mission. Wood-tone, red on hover. */}
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-xs rounded-full hover:text-[#ff9c9c] hover:border-[#ff9c9c]/50 transition-colors"
            style={{ background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))', color: 'var(--theme-ink-soft, #d9c08c)' }}
            title="Delete this mission"
          >
            🗑 Delete
          </button>
          <button onClick={() => setHelpOpen(v => !v)} className="w-8 h-8 rounded-full hover:text-white font-semibold text-sm flex items-center justify-center" style={{ background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))', color: 'var(--theme-metal-bright, #e7d6a8)' }} title="What's this?">?</button>
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
          const isFilable = item.kind === 'file' || item.kind === 'fact' || item.kind === 'activity';
          return (
            <Draggable
              key={item.id}
              pose={pose}
              onGrab={() => bringToFront(item.id)}
              onPose={(p) => setPose(item.id, p)}
              onClick={isAgent
                ? (x, y) => setAgentMenu({ agentId: item.ref!, anchor: toClampedAgentMenuAnchor(x, y) })
                : undefined}
              onDrop={isFilable ? (target) => handleDrop(item.id, target) : undefined}
            >
              <ItemBody
                item={item}
                room={room}
                openQuestion={openQuestion}
                fileSources={fileSources}
                factSources={factSources}
                activityStickies={activityStickies}
                furniture={furniture}
                onOpenCabinet={toggleCabinet}
                onOpenTrash={toggleTrash}
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
          activityStickies={activityStickies}
          onRestore={restoreItem}
          onRestoreAt={restoreItemAt}
          onOpenFile={handleOpenFile}
          onClose={toggleCabinet}
        />
      )}

      {/* v6.1.0-alpha.33 — Trash drawer overlay — same shape as the
          cabinet but with a "Delete forever" action and a danger tone
          on the chrome. */}
      {furniture.trashOpen && (
        <TrashDrawer
          itemIds={furniture.trash}
          items={items}
          fileSources={fileSources}
          factSources={factSources}
          activityStickies={activityStickies}
          onRestore={restoreItem}
          onDeleteForever={deleteForever}
          onClose={toggleTrash}
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
      <footer
        className="absolute left-0 right-0 bottom-0 z-30 px-3 pb-12 pt-3 sm:px-5 md:pb-8 flex flex-col gap-2"
        style={{ background: 'linear-gradient(to top, var(--theme-leather-edge, rgba(29,19,10,0.95)), transparent)' }}
      >
        <div className="flex max-h-24 flex-wrap items-center gap-2 overflow-y-auto pr-1 max-w-5xl mx-auto w-full sm:max-h-none sm:overflow-visible sm:pr-0">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>quick steer</span>
          {SLASH_COMMANDS.map(s => (
            <button
              key={s.cmd}
              onClick={() => sendSteer(s.cmd)}
              disabled={sending}
              title={s.hint}
              className="px-2.5 py-1 text-[11px] rounded-full hover:text-white disabled:opacity-50"
              style={{ color: 'var(--theme-metal-bright, #e7d6a8)', background: 'var(--theme-leather, rgba(42,29,17,0.7))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}
            >{s.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 max-w-5xl mx-auto w-full">
          <form
            onSubmit={(e) => { e.preventDefault(); sendSteer(steerInput); }}
            className="min-w-0 flex-1 h-11 flex items-center gap-2.5 px-3.5 rounded-full"
            style={{ background: 'var(--theme-leather, rgba(42,29,17,0.8))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}
          >
            <input
              value={steerInput}
              onChange={(e) => setSteerInput(e.target.value)}
              placeholder='Tell the team — "Add a one-line risk note at the top"'
              className="min-w-0 flex-1 bg-transparent outline-none text-sm placeholder:text-[#d9c08c]/50"
              style={{ color: 'var(--theme-paper-fg, #f3e9d0)' }}
            />
            <span className="px-2 py-1 text-[10px] uppercase tracking-widest rounded" style={{ color: 'var(--theme-ink-soft, #d9c08c)', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}>↵</span>
          </form>
        </div>
        {/* Phase 3 polish — permanent trust line. Frames the safety
            contract without explaining it. Muted via theme-ink-soft
            so it never competes with the actual decision moment. */}
        <div
          className="max-w-5xl mx-auto w-full text-center text-[11px] italic"
          style={{ color: 'var(--theme-ink-soft, #d9c08c)', opacity: 0.7 }}
        >
          Your team works independently, but asks before risky or sensitive changes.
        </div>
      </footer>

      {/* File viewer modal (alpha.16) — opens on double-click of file papers. */}
      {openFile && (
        <FileViewer state={openFile} onClose={() => setOpenFile(null)} />
      )}

      {/* Help panel */}
      {helpOpen && (
        <div
          className="absolute left-4 right-4 top-20 z-40 rounded-xl p-4 backdrop-blur-xl shadow-2xl sm:left-auto sm:right-5 sm:w-80"
          style={{ background: 'var(--theme-leather, rgba(42,29,17,0.95))', border: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.6))' }}
        >
          <button onClick={() => setHelpOpen(false)} className="absolute top-3 right-3 hover:text-white text-sm" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>✕</button>
          <h3 className="font-semibold text-sm mb-2" style={{ color: 'var(--theme-paper-fg, #f3e9d0)' }}>The desk</h3>
          <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--theme-metal-bright, #e7d6a8)' }}>
            Everything the team produces lands on this desk as a physical object.
            Drag anything anywhere. <b>Tidy up</b> resets the layout if it gets cluttered.
          </p>
          <ul className="space-y-2 text-xs" style={{ color: 'var(--theme-metal-bright, #e7d6a8)' }}>
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

  // Pointer drag supports mouse, pen, and touch. This keeps the desk usable
  // on tablets without changing the existing click/drop semantics.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-drag]')) return;
    e.preventDefault();
    onGrab();
    const dragNode = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const origX = pose.x;
    const origY = pose.y;
    setDrag({ dx: 0, dy: 0, x: origX, y: origY });

    try { dragNode.setPointerCapture(pointerId); } catch { /* Some browsers reject capture after DOM changes. */ }

    const onMove = (mv: PointerEvent) => {
      if (mv.pointerId !== pointerId) return;
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      setDrag({ dx, dy, x: origX + dx, y: origY + dy });
    };
    const onUp = (mv: PointerEvent) => {
      if (mv.pointerId !== pointerId) return;
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      try { dragNode.releasePointerCapture(pointerId); } catch { /* Already released/cancelled. */ }
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
      // at pointerup, then walk up looking for data-drop-target. Skip the
      // dragged element itself so a card can't "drop on itself".
      if (onDrop) {
        const stack = document.elementsFromPoint(mv.clientX, mv.clientY) as HTMLElement[];
        for (const el of stack) {
          const dropTarget = el.closest('[data-drop-target]') as HTMLElement | null;
          if (!dropTarget) continue;
          if (dropTarget.contains(dragNode)) continue; // own descendant
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
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [pose, onGrab, onPose, onClick, onDrop]);

  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute select-none pointer-events-auto cursor-grab touch-none active:cursor-grabbing"
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
  item, room, openQuestion, fileSources, factSources, activityStickies, furniture, onOpenCabinet, onOpenTrash, onOpenFile, onAnswer,
}: {
  item: DeskItem;
  room: MissionRoom;
  openQuestion: Extract<MissionMessage, { kind: 'question' }> | undefined;
  fileSources: FileSource[];
  factSources: FactSource[];
  activityStickies: ActivitySticky[];
  furniture: DeskFurniture;
  onOpenCabinet: () => void;
  onOpenTrash: () => void;
  onOpenFile: (ref: string) => void;
  onAnswer: (approvalId: string, answer: string) => void;
}) {
  if (item.kind === 'goal') return <GoalPlacard goal={room.goal} status={room.status} />;
  if (item.kind === 'document') return <DocumentPaper room={room} />;
  if (item.kind === 'cost') return <CostInkwell room={room} />;
  if (item.kind === 'clock') return <DeskClock room={room} />;
  if (item.kind === 'cabinet') return <FilingCabinet count={furniture.cabinet.length} onOpen={onOpenCabinet} />;
  if (item.kind === 'trash') return <Wastebasket count={furniture.trash.length} onOpen={onOpenTrash} />;
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
  if (item.kind === 'activity') {
    const a = activityStickies.find(s => s.id === item.ref);
    if (!a) return null;
    return <ActivityStickyNote sticky={a} />;
  }
  if (item.kind === 'question' && openQuestion) {
    return <QuestionTag msg={openQuestion} onAnswer={(text) => onAnswer(openQuestion.approvalId, text)} />;
  }
  return null;
}

function GoalPlacard({ goal, status }: { goal: string; status: MissionRoom['status'] }) {
  // v6.1.0-alpha.30 — status label was hardcoded to "signed off — TITAN"
  // which Tony correctly flagged as misleading: it sounded like the work
  // was already done/approved when the mission had just started. The
  // placard now reflects the real mission status.
  const labels: Record<MissionRoom['status'], { text: string; dotColor: string; dotGlow: string }> = {
    forming: { text: 'forming the team…',     dotColor: '#c4a14a', dotGlow: '#c4a14a' },
    working: { text: 'in progress — TITAN',   dotColor: '#8ed1ff', dotGlow: '#8ed1ff' },
    paused:  { text: 'paused — your call',    dotColor: '#d9c08c', dotGlow: '#d9c08c' },
    blocked: { text: 'needs your input',      dotColor: '#ff9c9c', dotGlow: '#ff9c9c' },
    done:    { text: 'complete · signed off', dotColor: '#22c55e', dotGlow: '#22c55e' },
    failed:  { text: 'stopped — see chat',    dotColor: '#ef4444', dotGlow: '#ef4444' },
  };
  const meta = labels[status] ?? labels.working;
  return (
    <div
      className="w-[420px] px-5 py-4 relative"
      style={{
        background:
          'linear-gradient(140deg, var(--theme-leather, #6b2c2a) 0%, var(--theme-leather-edge, #4a1816) 60%, var(--theme-bolt, #3b110f) 100%)',
        border: '1px solid var(--theme-bolt, #2a0908)',
        borderRadius: 10,
        // Inner depth + outer accent glow tied to the active theme.
        // Phase 1 polish — promotes the placard to the top of the
        // visual hierarchy (100% contrast). Glow is held at low alpha
        // so it reads premium and quiet, not loud.
        boxShadow:
          'inset 0 0 24px var(--theme-shadow, rgba(0,0,0,0.5)), 0 0 0 4px rgba(0,0,0,0.08), 0 0 32px color-mix(in srgb, var(--theme-accent, #c45a30) 28%, transparent)',
        backgroundBlendMode: 'multiply',
        color: 'var(--theme-paper-fg, #f3e9d0)',
      }}
    >
      {/* Eyebrow — "ACTIVE MISSION" sets the hierarchy frame. */}
      <div
        className="text-[10px] uppercase mb-1.5"
        style={{
          letterSpacing: '0.16em',
          color: 'var(--theme-ink-soft, #d9c08c)',
          fontWeight: 600,
        }}
      >
        Active Mission
      </div>
      <div
        className="leading-snug font-semibold tracking-tight"
        style={{ fontSize: 22, color: 'var(--theme-paper-fg, #f3e9d0)' }}
      >
        {goal}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest" style={{ color: 'var(--theme-ink-soft, rgba(217,192,140,0.7))' }}>
        <span
          className={`inline-block w-2 h-2 rounded-full ${status === 'working' || status === 'blocked' || status === 'forming' ? 'animate-pulse' : ''}`}
          style={{ background: meta.dotColor, boxShadow: `0 0 6px ${meta.dotGlow}` }}
        />
        <span>{meta.text}</span>
      </div>
    </div>
  );
}

function DocumentPaper({ room }: { room: MissionRoom }) {
  const content = room.artifact?.content ?? '';
  const prevLenRef = useRef(content.length);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    if (content.length > prevLenRef.current) {
      setTyping(true);
      const t = setTimeout(() => setTyping(false), 2000);
      prevLenRef.current = content.length;
      return () => clearTimeout(t);
    }
    prevLenRef.current = content.length;
  }, [content]);

  const lines = useMemo(() => {
    const all = content.split('\n').filter(l => l.trim().length > 0);
    return all.slice(0, 10);
  }, [content]);
  const words = content.trim().split(/\s+/).filter(Boolean).length;

  // If the team is active and the document recently grew, show a
  // live-writing indicator with a blinking cursor.
  const teamActive = room.team.some(t => t.state === 'working' || t.state === 'editing');

  // Phase 1 polish — show a polished SVG chart skeleton when an
  // Analyst is computing (heuristic: any team member named "Analyst"
  // or with role containing "analyst" is in working/editing state).
  const analystComputing = teamActive && room.team.some(t =>
    (t.state === 'working' || t.state === 'editing') &&
    (t.name.toLowerCase().includes('analyst') || (t.role ?? '').toLowerCase().includes('analyst'))
  );

  return (
    <div
      className="w-[620px] max-w-[92vw] rounded-md p-8 pt-7 relative"
      style={{
        background: 'var(--theme-paper, #f7f5ee)',
        color: 'var(--theme-ink, #1a1f2e)',
        fontFamily: 'var(--theme-font-display, "Iowan Old Style", "Charter", "Georgia", serif)',
        backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 26px, var(--theme-paper-line, #d8d3c2) 26px 27px)',
        backgroundPosition: '0 56px',
        // Phase 1 — central document is hierarchy rank #2 (90%
        // contrast, elevated). Stacked drop shadow + faint accent
        // halo so the eye lands here second.
        boxShadow:
          '0 18px 40px var(--theme-shadow, rgba(0,0,0,0.45)), 0 6px 14px var(--theme-shadow, rgba(0,0,0,0.35)), 0 0 0 1px color-mix(in srgb, var(--theme-accent, #c45a30) 12%, transparent)',
      }}
    >
      <h1 className="text-[22px] font-semibold tracking-tight leading-tight mb-1">
        {shorten(room.goal, 70)}
      </h1>
      <div className="text-[11px] uppercase tracking-widest mb-4 flex items-center gap-2" style={{ color: 'var(--theme-ink-soft, #8a8472)' }}>
        <span>Draft · {words} words · {statusToLabel(room.status)}</span>
        {typing && teamActive && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--theme-accent, #c4a35a)' }} />
            <span className="text-[10px] italic">Writing…</span>
          </span>
        )}
      </div>
      {lines.length > 0 ? (
        <div className="text-[14px] leading-[1.6] space-y-3">
          {lines.map((line, i) => (
            <p key={i}>{line}{typing && teamActive && i === lines.length - 1 && (
              <span className="inline-block w-0.5 h-3.5 ml-0.5 align-middle animate-pulse" style={{ background: 'var(--theme-accent, #c4a35a)' }} />
            )}</p>
          ))}
        </div>
      ) : (
        <div className="text-[12px] italic py-6 text-center" style={{ color: 'var(--theme-ink-soft, #8a8472)' }}>
          The team is just getting started — your document fills in as they work.
        </div>
      )}
      {analystComputing && <ChartSkeleton />}
    </div>
  );
}

/**
 * Phase 1 polish — polished SVG chart skeleton shown when an Analyst
 * is computing. Replaces what used to be an empty rect placeholder.
 * Axis lines, dashed bars (the dashes animate to convey "loading"),
 * and an italic "Analyst computing…" caption. Every color is sourced
 * from theme CSS variables so workshop / observatory themes reskin
 * the chart with their own ink + accent palette.
 */
function ChartSkeleton() {
  return (
    <div className="mt-5 pt-4" style={{ borderTop: '1px dashed var(--theme-paper-line, #d8d3c2)' }}>
      <svg
        viewBox="0 0 320 110"
        className="w-full h-[110px]"
        aria-hidden
        style={{ overflow: 'visible' }}
      >
        {/* Y axis */}
        <line x1="22" y1="6" x2="22" y2="92"
          stroke="var(--theme-ink-soft, #8a8472)" strokeWidth="1" opacity="0.5" />
        {/* X axis */}
        <line x1="22" y1="92" x2="312" y2="92"
          stroke="var(--theme-ink-soft, #8a8472)" strokeWidth="1" opacity="0.5" />
        {/* Y axis ticks */}
        {[20, 44, 68].map(y => (
          <line key={y} x1="18" y1={y} x2="22" y2={y}
            stroke="var(--theme-ink-soft, #8a8472)" strokeWidth="1" opacity="0.35" />
        ))}
        {/* Dashed bars (skeleton). Heights vary so it reads as a bar
            chart not a histogram. Stroke is the active theme accent
            so observatory cyan / workshop green / office copper all
            render correctly without extra logic. */}
        {[
          { x:  40, h: 52 },
          { x:  82, h: 68 },
          { x: 124, h: 32 },
          { x: 166, h: 78 },
          { x: 208, h: 46 },
          { x: 250, h: 62 },
          { x: 292, h: 40 },
        ].map((b, i) => (
          <rect
            key={i}
            x={b.x - 12}
            y={92 - b.h}
            width={24}
            height={b.h}
            fill="none"
            stroke="var(--theme-accent, #c45a30)"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            opacity="0.55"
            style={{ animation: 'tetherFlow 2.4s linear infinite' }}
          />
        ))}
      </svg>
      <div
        className="text-[11px] italic mt-1 text-center"
        style={{ color: 'var(--theme-ink-soft, #8a8472)' }}
      >
        Analyst computing…
      </div>
    </div>
  );
}

function CostInkwell({ room }: { room: MissionRoom }) {
  return (
    <div
      className="w-[110px] h-[110px] rounded-full flex flex-col items-center justify-center"
      style={{
        background: 'radial-gradient(circle at 35% 30%, var(--theme-leather, #2b1a14) 0%, var(--theme-leather-edge, #1a0e08) 70%)',
        boxShadow: 'inset 0 0 18px var(--theme-shadow, rgba(0,0,0,0.6)), 0 0 0 5px var(--theme-metal-dark, #6e4a26), 0 0 0 6px var(--theme-bolt, #382213)',
        color: 'var(--theme-paper-fg, #f3e9d0)',
      }}
      title="Tokens + dollars spent this mission"
    >
      <span className="text-[9px] uppercase tracking-widest" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>spent</span>
      <span className="text-[20px] font-bold tabular-nums">${room.cost.usd.toFixed(2)}</span>
      <span className="text-[9px] tabular-nums" style={{ color: 'var(--theme-ink-soft, rgba(217,192,140,0.8))' }}>{(room.cost.tokens / 1000).toFixed(1)}k tok</span>
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
      className="w-[260px] p-4 pb-3"
      style={{
        background: 'radial-gradient(ellipse at 30% 25%, var(--theme-leather, #4a2e18) 0%, var(--theme-bolt, #2a1808) 75%, var(--theme-leather-edge, #1a0e04) 100%)',
        borderRadius: 14,
        boxShadow:
          '0 0 0 3px var(--theme-metal-dark, #b08a3a), 0 0 0 5px var(--theme-bolt, #5a3a14), 0 12px 22px var(--theme-shadow, rgba(0,0,0,0.5)), inset 0 0 16px rgba(0,0,0,0.6)',
        color: 'var(--theme-metal-bright, #f5d27a)',
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.28em] text-center mb-1.5" style={{ color: 'var(--theme-metal, #c4a14a)' }}>
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
        className="text-center text-[10px] uppercase tracking-[0.22em] mb-1.5"
        style={{ fontFamily: 'system-ui', color: 'var(--theme-metal, rgba(196,161,74,0.85))' }}
      >
        Mission · {elapsed.hh}:{elapsed.mm}:{elapsed.ss}
        {frozen && <span className="ml-1.5" style={{ color: 'var(--theme-ink-soft, rgba(217,192,140,0.7))' }}>· {room.status}</span>}
      </div>
      <div
        className="flex items-center justify-center gap-3 pt-2"
        style={{ fontFamily: 'system-ui', borderTop: '1px solid var(--theme-bolt, rgba(90,58,20,0.6))' }}
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
  // accent/warn are semantic status colors; muted reads as brass (themable).
  const color = tone === 'accent' ? '#8ed1ff' : tone === 'warn' ? '#ff9c9c' : 'var(--theme-metal, #c4a14a)';
  return (
    <div className="flex flex-col items-center leading-tight">
      <span className="text-[18px] font-bold tabular-nums" style={{ color }}>{n}</span>
      <span className="text-[9px] uppercase tracking-widest" style={{ color: 'var(--theme-metal, rgba(196,161,74,0.8))' }}>{label}</span>
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
  const editing = member.state === 'editing';
  const working = member.state === 'working';
  const done    = member.state === 'done';
  const active  = working || editing;
  // v6.1.0-alpha.18 — agents are sticky notes now. Each agent's color
  // tints its note, so the Scout's note feels different from the
  // Builder's. Tape strip across the top.
  const stickyBg = paperFromColor(member.color, blocked);
  // Phase 2 polish — breathing animation is now gated on state so an
  // idle card stays calm. Working uses the 3.4s breath; the
  // "needs you" state pulses faster (1.2s) for urgency; done has no
  // animation and is faded.
  const phaseDelay = active ? `${(member.agentId.charCodeAt(0) % 10) * 0.34}s` : '0s';
  const cardAnimation =
    blocked ? 'stickyBreatheUrgent 1.2s ease-in-out infinite' :
    working ? 'stickyBreathe 1.8s ease-in-out infinite' :
    editing ? 'stickyBreathe 2.4s ease-in-out infinite' :
    'none';
  // Phase 2 polish — "done" cards fade to ~65% opacity. Transition
  // duration covers the 400ms soft-fade requirement when a card
  // moves from working → done.
  const cardOpacity = done ? 0.65 : 1;
  // Idle / editing labels with present-progressive verb tense. Done
  // gets a check glyph. needs_info gets the warm rose treatment via
  // the stickyBg helper above.
  const stateLabelText = stateLabel(member.state);
  // Activity copy: present-progressive when working; tense-aware
  // otherwise. Empty fallback uses "standing by" for idle to match
  // the spec.
  const activityCopy = member.currentActivity ?? (
    done    ? 'wrapped up'  :
    blocked ? 'awaiting your call' :
              'standing by'
  );
  return (
    <div
      className="w-[220px] p-3.5 pt-5 text-[#2a2418] relative"
      style={{
        background: stickyBg,
        boxShadow: '0 1px 0 rgba(255,255,255,0.55) inset, 0 12px 18px rgba(0,0,0,0.42)',
        fontFamily: '"Bradley Hand", "Marker Felt", "Comic Sans MS", cursive',
        animation: cardAnimation,
        animationDelay: phaseDelay,
        opacity: cardOpacity,
        transition: 'opacity 400ms ease-out',
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
          {done ? (
            <span className="text-[12px] leading-none" aria-label="done">✓</span>
          ) : (
            <span
              className={`w-1.5 h-1.5 rounded-full ${heartbeatClass(member.state)}`}
              style={{ boxShadow: `0 0 6px ${heartbeatColor(member.state)}` }}
            />
          )}
          <span>{stateLabelText}</span>
        </div>
      </div>
      <div className="text-[14px] text-[#2a2418] leading-snug min-h-[2.4rem] break-words">
        {member.currentActivity ?? <span className="italic text-[#6b5a3a]">{activityCopy}</span>}
      </div>
      {/* Soft accent glow — only when the card is actually working or
          waiting. Idle/done cards stay calm. */}
      {(active || blocked) && (
        <div
          className="absolute -inset-1 -z-10 pointer-events-none rounded-[2px] blur-md"
          style={{
            background: blocked
              ? 'radial-gradient(circle at 50% 50%, rgba(239,68,68,0.6), transparent 70%)'
              : `radial-gradient(circle at 30% 30%, ${member.color}55, transparent 70%)`,
            animation: blocked ? 'deskAlarm 1.2s ease-in-out infinite' : 'deskGlow 4.2s ease-in-out infinite',
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
      className="w-[200px] p-3"
      style={{
        background: 'linear-gradient(170deg, var(--theme-paper, #fdfbf3) 0%, var(--theme-paper, #f1eada) 100%)',
        color: 'var(--theme-ink, #1a1f2e)',
        borderRadius: 4,
        boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 0 0 1px rgba(0,0,0,0.06)',
      }}
    >
      {/* Bent corner */}
      <div
        className="absolute top-0 right-0 w-4 h-4"
        style={{
          background: 'linear-gradient(225deg, var(--theme-paper-line, #d8cdb3) 0%, var(--theme-paper, #f1eada) 50%, transparent 50%)',
          borderBottomLeftRadius: 4,
        }}
      />
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-base leading-none">{file.type === 'report' ? '📊' : '📄'}</span>
        <span className="text-[9px] uppercase tracking-widest" style={{ color: 'var(--theme-ink-soft, #8a8472)' }}>{file.type}</span>
      </div>
      <div className="font-semibold text-[12px] leading-tight break-words" style={{ color: 'var(--theme-ink, #1a1f2e)' }}>{filename}</div>
      {file.description && (
        <div className="text-[10px] mt-1 leading-snug line-clamp-2" style={{ color: 'var(--theme-ink-soft, #5a5240)' }}>{file.description}</div>
      )}
      <button
        data-no-drag
        onClick={onOpen}
        className="mt-2 w-full px-2 py-1 text-[10px] font-semibold uppercase tracking-widest rounded"
        style={{ background: 'var(--theme-ink, #1a1f2e)', color: 'var(--theme-paper-fg, #f3e9d0)' }}
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
      className="w-[160px] p-3"
      style={{
        background: 'linear-gradient(160deg, var(--theme-sticky-yellow, #fff2a8) 0%, var(--theme-sticky-yellow, #ffe88a) 100%)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.5) inset, 0 8px 14px var(--theme-shadow, rgba(0,0,0,0.35))',
        fontFamily: '"Bradley Hand", "Comic Sans MS", cursive',
        color: 'var(--theme-ink, #3a2e10)',
      }}
    >
      {/* Tape across the top */}
      <div
        className="absolute -top-2 left-1/2 -translate-x-1/2 w-12 h-3.5 opacity-60"
        style={{
          background: 'linear-gradient(180deg, var(--theme-sticky-tape, rgba(255,255,255,0.65)), rgba(255,255,255,0.25))',
        }}
      />
      <div className="text-[12px] leading-snug">{text}</div>
    </div>
  );
}

/**
 * v6.1.0-alpha.31 — live activity sticky. Shows what an agent did
 * during a tool call (searched, fetched, wrote, etc.). Tinted by the
 * agent's color so the user can see at a glance which helper
 * produced it. Smaller than the fact sticky so a desk-full of
 * activity stickies doesn't crowd the document.
 */
function ActivityStickyNote({ sticky }: { sticky: ActivitySticky }) {
  // Map the agent's color into a soft paper tone — same logic as
  // paperFromColor but slightly lighter so the stickies don't compete
  // visually with the agent cards themselves.
  const bg = activityPaperFromColor(sticky.agentColor);
  return (
    <div
      className="w-[170px] p-2.5 relative"
      title={`${sticky.agentName} ${sticky.activity}${sticky.detail ? ': ' + sticky.detail : ''} · ${new Date(sticky.at).toLocaleTimeString()}`}
      style={{
        background: bg,
        boxShadow: '0 1px 0 rgba(255,255,255,0.55) inset, 0 6px 10px var(--theme-shadow, rgba(0,0,0,0.32))',
        fontFamily: '"Bradley Hand", "Marker Felt", "Comic Sans MS", cursive',
        color: 'var(--theme-ink, #2a2418)',
      }}
    >
      {/* Tape across the top */}
      <div
        className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-10 h-3 opacity-60 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, var(--theme-sticky-tape, rgba(255,255,255,0.7)), rgba(255,255,255,0.25))',
        }}
      />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-base leading-none">{sticky.icon}</span>
        <span
          className="text-[10px] uppercase tracking-widest truncate"
          style={{ fontFamily: 'system-ui', color: 'var(--theme-ink-soft, #6b5a3a)' }}
        >
          {sticky.agentName}
        </span>
      </div>
      <div className="text-[12px] leading-snug">{sticky.activity}</div>
      {sticky.detail && (
        <div className="text-[11px] mt-1 leading-snug break-words line-clamp-3" style={{ color: 'var(--theme-ink-soft, #5a4818)' }}>
          {sticky.detail}
        </div>
      )}
    </div>
  );
}

/** Paper tone for an activity sticky — softer than the agent card's
 *  own paper so the visual stack reads as: agent (saturated) → its
 *  activity stickies (pale). */
function activityPaperFromColor(hex: string): string {
  const lower = hex.toLowerCase();
  if (lower.includes('6366f1') || lower.includes('8b5cf6')) {
    return 'linear-gradient(160deg, #efeaff 0%, #e0d5ff 100%)';
  }
  if (lower.includes('22c55e') || lower.includes('10b981') || lower.includes('4adbb5')) {
    return 'linear-gradient(160deg, #e7faea 0%, #cef0d4 100%)';
  }
  if (lower.includes('f59e0b') || lower.includes('eab308') || lower.includes('ff9a4a')) {
    return 'linear-gradient(160deg, #fff8c8 0%, #ffefa3 100%)';
  }
  if (lower.includes('ef4444') || lower.includes('f97316') || lower.includes('ff5d6c')) {
    return 'linear-gradient(160deg, #ffe2d4 0%, #ffcfba 100%)';
  }
  if (lower.includes('06b6d4') || lower.includes('0ea5e9') || lower.includes('6ea8ff')) {
    return 'linear-gradient(160deg, #e0f5fa 0%, #c5e9f1 100%)';
  }
  return 'linear-gradient(160deg, #fff8c8 0%, #ffefa3 100%)';
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
      className="w-[300px] p-4 rounded-xl"
      style={{
        background: 'linear-gradient(180deg, var(--theme-sticky-pink, #ffe9eb), var(--theme-sticky-pink, #ffd0d4))',
        // Phase 3 polish — warm accent rim (rose-toned, themed) +
        // elevated by ~10px via translateY in the animation. Larger
        // glow than the placard since this is the "needs you"
        // decision moment — hierarchy rank #3 in the brief.
        boxShadow:
          '0 18px 36px rgba(255,93,108,0.45), 0 0 0 1.5px var(--theme-accent, rgba(196,90,48,0.6)), 0 0 0 4px rgba(255,93,108,0.12)',
        animation: 'questionLift 4s ease-in-out infinite',
        color: '#5c1820',
        transform: 'translateY(-10px)',
      }}
    >
      {/* Brass pin */}
      <div
        className="absolute -top-2 -right-2 w-5 h-5 rounded-full"
        style={{
          background: 'radial-gradient(circle at 35% 30%, var(--theme-metal-bright, #ffd86e) 0%, var(--theme-metal-dark, #b07a1a) 70%, var(--theme-bolt, #6a4710) 100%)',
          boxShadow: '0 2px 4px var(--theme-shadow, rgba(0,0,0,0.5))',
        }}
      />
      {/* Phase 3 polish — eyebrow label matches the ACTIVE MISSION
          treatment on the placard so the eye reads them as the same
          tier of object. */}
      <div
        className="text-[10px] uppercase mb-1.5"
        style={{
          letterSpacing: '0.16em',
          color: 'rgba(92,24,32,0.7)',
          fontWeight: 600,
        }}
      >
        {msg.from.name} asks
      </div>
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 mb-2 bg-[#5c1820] text-[#ffd0d4] text-[10px] uppercase tracking-widest font-bold rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        TITAN paused — your call.
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
                  ? 'border-transparent text-[var(--theme-paper,#f3e9d0)] bg-[var(--theme-ink,#1a1f2e)]'
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
              className="px-2 py-0.5 rounded text-[11px] font-semibold disabled:opacity-50 text-[var(--theme-paper,#f3e9d0)] bg-[var(--theme-ink,#1a1f2e)]"
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
      className="w-[140px] flex flex-col"
      style={{ color: 'var(--theme-metal-bright, #f5d27a)' }}
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
                'linear-gradient(180deg, var(--theme-leather, #5a3a18) 0%, var(--theme-leather-edge, #3a230b) 100%), repeating-linear-gradient(90deg, rgba(255,180,90,0.05) 0px, rgba(60,30,10,0.08) 2px)',
              border: '1px solid var(--theme-bolt, #2a1808)',
              boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.08) inset',
            }}
          >
            {/* Brass label plate */}
            <div
              className="px-3 py-0.5 text-[10px] uppercase tracking-widest font-bold"
              style={{
                background: 'linear-gradient(180deg, var(--theme-metal-bright, #ffd86e) 0%, var(--theme-metal-dark, #b07a1a) 100%)',
                borderRadius: 2,
                boxShadow: '0 1px 2px var(--theme-shadow, rgba(0,0,0,0.4))',
                color: 'var(--theme-bolt, #3a2a10)',
              }}
            >
              {row === 0 ? 'Files' : 'Drafts'}
            </div>
            {/* Brass pull */}
            <div
              className="absolute right-3 w-6 h-1.5 rounded"
              style={{
                background: 'linear-gradient(180deg, var(--theme-metal-bright, #ffd86e) 0%, var(--theme-metal-dark, #8a5810) 100%)',
                boxShadow: '0 1px 2px var(--theme-shadow, rgba(0,0,0,0.5))',
              }}
            />
          </div>
        ))}
      </button>
      {count > 0 && (
        <div className="mt-1 text-center text-[10px] uppercase tracking-widest" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>
          {count} {count === 1 ? 'item' : 'items'} inside
        </div>
      )}
    </div>
  );
}

function Wastebasket({ count, onOpen }: { count: number; onOpen: () => void }) {
  // Generate wadded-paper visuals based on count.
  const wads = Math.min(count, 6);
  // v6.1.0-alpha.33 — basket is now clickable. Clicking opens a drawer
  // listing every tossed item with two actions per row: "Back to desk"
  // (restore) and "Delete forever" (permanently hide).
  return (
    <button
      type="button"
      data-drop-target="trash"
      data-no-drag
      onClick={onOpen}
      className="relative w-[110px] h-[120px] p-0 bg-transparent border-none cursor-pointer"
      title={count > 0 ? `${count} tossed — click to open the bin` : 'Drop notes here to toss them'}
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
              background: 'radial-gradient(circle at 35% 30%, var(--theme-paper, #fffaee) 0%, var(--theme-paper-line, #d6cdb1) 70%, var(--theme-ink-soft, #a99b71) 100%)',
              boxShadow: 'inset -2px -2px 4px rgba(0,0,0,0.18), 0 1px 2px var(--theme-shadow, rgba(0,0,0,0.3))',
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
            'repeating-linear-gradient(90deg, var(--theme-leather, #5a3a18) 0px, var(--theme-leather, #5a3a18) 2px, var(--theme-leather-edge, #3a230b) 2px, var(--theme-leather-edge, #3a230b) 4px),' +
            'repeating-linear-gradient(0deg, transparent 0 6px, rgba(0,0,0,0.25) 6px 7px)',
          border: '1px solid var(--theme-bolt, #2a1808)',
          borderRadius: 4,
          boxShadow: 'inset 0 4px 8px var(--theme-shadow, rgba(0,0,0,0.5))',
        }}
      />
      {/* Rim */}
      <div
        className="absolute left-1 right-1 bottom-[78px] h-2.5 rounded-sm"
        style={{
          background: 'linear-gradient(180deg, var(--theme-metal-dark, #6b4720) 0%, var(--theme-leather-edge, #3a230b) 100%)',
          border: '1px solid var(--theme-bolt, #1a0f05)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
        }}
      />
      {count > 0 && (
        <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest whitespace-nowrap" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>
          {count} tossed
        </div>
      )}
    </button>
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
  itemIds, items, fileSources, factSources, activityStickies, onRestore, onRestoreAt, onOpenFile, onClose,
}: {
  itemIds: string[];
  items: DeskItem[];
  fileSources: FileSource[];
  factSources: FactSource[];
  /** v6.1.0-alpha.33 — activity stickies in the cabinet too, since
   *  they can be filed via drag-drop. Lets the drawer label them
   *  properly ("Scout · 🔍 searched the web · MLK 1963") instead of
   *  just their internal id. */
  activityStickies: ActivitySticky[];
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
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(180deg, var(--theme-leather, #4a2e18) 0%, var(--theme-bolt, #2a1808) 100%)',
          boxShadow: '0 0 0 3px var(--theme-metal-dark, #b08a3a), 0 30px 60px var(--theme-shadow, rgba(0,0,0,0.6))',
          color: 'var(--theme-metal-bright, #f5d27a)',
        }}
      >
        <div className="flex items-center gap-3 px-5 py-3" style={{ borderBottom: '1px solid var(--theme-metal-dark, #6e4724)' }}>
          <span className="text-2xl">🗄️</span>
          <div className="flex-1">
            <div className="text-sm font-semibold tracking-tight">Filing cabinet</div>
            <div className="text-[11px]" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>{itemIds.length} item{itemIds.length === 1 ? '' : 's'} filed · drag a row out, or click <b>to desk</b></div>
          </div>
          <button data-no-drag onClick={onClose} className="w-8 h-8 rounded-full hover:text-white flex items-center justify-center" style={{ background: 'var(--theme-leather-edge, #1a0f05)', border: '1px solid var(--theme-metal-dark, #6e4724)', color: 'var(--theme-ink-soft, #d9c08c)' }}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {itemIds.length === 0 && (
            <div className="text-center py-12 italic" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>
              Nothing filed yet. Drag a file or sticky note onto the cabinet to file it.
            </div>
          )}
          {itemIds.map(itemId => {
            const item = items.find(i => i.id === itemId);
            if (!item) return (
              <div key={itemId} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--theme-leather-edge, rgba(26,15,5,0.4))', border: '1px solid var(--theme-metal-dark, rgba(110,71,36,0.5))', color: 'var(--theme-ink-soft, rgba(217,192,140,0.7))' }}>
                <span className="text-xs italic">{itemId} (no longer in mission)</span>
                <button data-no-drag onClick={() => onRestore(itemId)} className="text-[11px] hover:text-white">remove</button>
              </div>
            );
            const f = item.kind === 'file' ? fileSources.find(s => s.ref === item.ref) : undefined;
            const fact = item.kind === 'fact' ? factSources.find(s => s.ref === item.ref) : undefined;
            const act = item.kind === 'activity' ? activityStickies.find(s => s.id === item.ref) : undefined;
            const icon = f ? (f.type === 'report' ? '📊' : '📄') : fact ? '💡' : act ? act.icon : '📌';
            const label = f?.ref ?? fact?.ref ?? (act ? `${act.agentName} · ${act.activity}` : itemId);
            return (
              <div
                key={itemId}
                onMouseDown={(e) => startDragOut(e, itemId, label, icon)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-grab active:cursor-grabbing"
                style={{ background: 'var(--theme-leather-edge, rgba(26,15,5,0.4))', border: '1px solid var(--theme-metal-dark, rgba(110,71,36,0.5))' }}
                title="Drag out to place on the desk, or use the buttons →"
              >
                <span className="text-lg leading-none">{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate" style={{ color: 'var(--theme-metal-bright, #f5d27a)' }}>{label}</div>
                  {(f?.description ?? fact?.description) && (
                    <div className="text-[10px] truncate" style={{ color: 'var(--theme-ink-soft, #d9c08c)' }}>{f?.description ?? fact?.description}</div>
                  )}
                </div>
                {f && (
                  <button data-no-drag onClick={() => onOpenFile(f.ref)} className="px-2 py-1 text-[10px] rounded hover:text-white" style={{ background: 'var(--theme-metal-dark, #6e4724)', border: '1px solid var(--theme-metal-dark, #b08a3a)', color: 'var(--theme-metal-bright, #f5d27a)' }}>Open ↗</button>
                )}
                <button data-no-drag onClick={() => onRestore(itemId)} className="px-2 py-1 text-[10px] rounded hover:text-white" style={{ background: 'var(--theme-leather-edge, #1a0f05)', border: '1px solid var(--theme-metal-dark, #6e4724)', color: 'var(--theme-ink-soft, #d9c08c)' }}>to desk</button>
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
            className="px-3 py-2 rounded text-xs flex items-center gap-2 shadow-2xl"
            style={{ transform: 'rotate(-2deg)', background: 'var(--theme-paper, #fdfbf3)', color: 'var(--theme-ink, #1a1f2e)' }}
          >
            <span>{dragOut.icon}</span>
            <span className="font-semibold truncate max-w-[200px]">{dragOut.label}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * v6.1.0-alpha.33 — Trash drawer overlay. Shape mirrors CabinetDrawer
 * but with danger styling (rose accents on the bezel, the chrome reads
 * "Wastebasket"). Each row offers TWO actions:
 *
 *   - **Back to desk** — same as cabinet restore. Item leaves trash,
 *     reappears on the desk at its last known pose.
 *   - **Delete forever** — moves from `trash` to `permanentlyHidden`.
 *     Item never renders again, anywhere. UI-only — the underlying
 *     mission source (file path, fact, activity entry) is untouched
 *     on disk; we just stop showing it on the desk.
 *
 * Confirms "Delete forever" with a window.confirm so you can't nuke
 * a row by accident.
 */
function TrashDrawer({
  itemIds, items, fileSources, factSources, activityStickies, onRestore, onDeleteForever, onClose,
}: {
  itemIds: string[];
  items: DeskItem[];
  fileSources: FileSource[];
  factSources: FactSource[];
  activityStickies: ActivitySticky[];
  onRestore: (itemId: string) => void;
  onDeleteForever: (itemId: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl overflow-hidden text-[#f5d27a]"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(180deg, #4a2018 0%, #2a0e08 100%)',
          boxShadow: '0 0 0 3px #c46a52, 0 30px 60px var(--theme-shadow, rgba(0,0,0,0.6))',
        }}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[#6e3024]">
          <span className="text-2xl">🗑️</span>
          <div className="flex-1">
            <div className="text-sm font-semibold tracking-tight">Wastebasket</div>
            <div className="text-[11px] text-[#e9b09a]">
              {itemIds.length} item{itemIds.length === 1 ? '' : 's'} tossed ·
              <span className="ml-1">restore to desk, or delete forever</span>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-[#1a0a08] border border-[#6e3024] text-[#e9b09a] hover:text-white flex items-center justify-center">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {itemIds.length === 0 && (
            <div className="text-center py-12 text-[#e9b09a] italic">
              Nothing in the bin. Drag a file, sticky, or activity onto the wastebasket to toss it.
            </div>
          )}
          {itemIds.map(itemId => {
            const item = items.find(i => i.id === itemId);
            const f = item?.kind === 'file' ? fileSources.find(s => s.ref === item.ref) : undefined;
            const fact = item?.kind === 'fact' ? factSources.find(s => s.ref === item.ref) : undefined;
            const act = item?.kind === 'activity' ? activityStickies.find(s => s.id === item.ref) : undefined;
            const icon = f ? (f.type === 'report' ? '📊' : '📄') : fact ? '💡' : act ? act.icon : '📌';
            const label = f?.ref ?? fact?.ref ?? (act ? `${act.agentName} · ${act.activity}` : itemId);
            const detail = f?.description ?? fact?.description ?? act?.detail;
            return (
              <div
                key={itemId}
                className="flex items-center gap-3 px-3 py-2 bg-[#1a0a08]/60 border border-[#6e3024]/50 rounded-lg hover:bg-[#1a0a08]/80 transition-colors"
                title={item ? 'Restore to the desk or delete forever' : 'This item no longer exists in the mission'}
              >
                <span className="text-lg leading-none opacity-70">{icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[#f5d27a] truncate line-through decoration-[#c46a52]/50">{label}</div>
                  {detail && (
                    <div className="text-[10px] text-[#e9b09a]/80 truncate">{detail}</div>
                  )}
                </div>
                <button
                  data-no-drag
                  onClick={() => onRestore(itemId)}
                  className="px-2.5 py-1 text-[10px] bg-[#1a0a08] border border-[#6e3024] rounded text-[#e9b09a] hover:text-white hover:border-[#c46a52]"
                  title="Pull this item back out of the bin and put it on the desk"
                >
                  ↩ to desk
                </button>
                <button
                  data-no-drag
                  onClick={() => {
                    const ok = window.confirm(`Delete this forever?\n\n"${label.slice(0, 100)}${label.length > 100 ? '…' : ''}"\n\nThe item will never reappear on the desk again, even after a reload. This is UI-only — the underlying mission file/note isn't deleted on disk.`);
                    if (ok) onDeleteForever(itemId);
                  }}
                  className="px-2.5 py-1 text-[10px] bg-[#3a0a08] border border-[#c46a52]/60 rounded text-[#ff9c9c] hover:text-white hover:bg-[#5a0e0a] hover:border-[#ff9c9c]"
                  title="Permanently hide this item — gone for good"
                >
                  ✕ Delete forever
                </button>
              </div>
            );
          })}
        </div>
        {itemIds.length > 0 && (
          <div className="px-5 py-2 border-t border-[#6e3024] text-center text-[10px] text-[#e9b09a]/70 uppercase tracking-widest">
            tip: drag items onto the wastebasket from the desk · restore is non-destructive
          </div>
        )}
      </div>
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
    // Base wood / surface color — uses theme variables so the workshop /
    // observatory themes can fully repaint the desk with their own
    // background palette while keeping the same grain overlay.
    'linear-gradient(180deg, var(--theme-bg-base, #6e4724) 0%, var(--theme-bg-grain, #5a3717) 50%, var(--theme-leather-edge, #482a13) 100%)',
  ].join(','),
};

const glowStyle: React.CSSProperties = {
  background: 'radial-gradient(ellipse 80% 60% at 20% 0%, rgba(255,220,140,0.18) 0%, rgba(0,0,0,0) 55%)',
};

const vignetteStyle: React.CSSProperties = {
  background: 'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 50%, var(--theme-bg-vignette, rgba(0,0,0,0.45)) 100%)',
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
/* Phase 3 polish — Sage decision card sits ~10px elevated and
   floats gently. Uses an offset baseline so the card stays raised
   relative to the rest of the desk furniture. */
@keyframes questionLift {
  0%, 100% { transform: translateY(-10px); }
  50%      { transform: translateY(-13px); }
}
/* v6.1.0-alpha.24 — gentle bob on working sticky notes. Lives on an
   INNER wrapper so it composes with the parent Draggable's rotation
   transform. */
@keyframes stickyBreathe {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2.5px); }
}
/* Phase 2 polish — faster breath for "needs you" cards (1.2s). */
@keyframes stickyBreatheUrgent {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-3.5px); }
}
/* Phase 2 polish — generic bead-fade keyframe. Actual path travel
   is implemented via SVG animateMotion + mpath in LivingDeskLayer
   so it works without offset-path support. Kept as a fallback. */
@keyframes beadFlow {
  0%, 100% { opacity: 0; }
  10%, 90% { opacity: 0.9; }
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
  // Phase 1 polish bumped DocumentPaper width from 460 → 620 so the
  // tether endpoints have to follow.
  const DOC_W = 620;
  const DOC_H = 300;

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
              <stop offset="0%"  stopColor="var(--theme-metal-bright, #ffd86e)" stopOpacity="0.9" />
              <stop offset="100%" stopColor="var(--theme-metal-bright, #ffd86e)" stopOpacity="0" />
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
            // Phase 2 polish — energy bead riding the connector path
            // from helper → document. Bead color matches the helper's
            // own accent so the user can see at a glance who's
            // pushing energy into the doc. Only mounted for
            // working/editing helpers (filter applied above) so a
            // calm desk has no beads.
            const beadColor = member.color;
            const pathId = `tether-path-${item.id}`;
            return (
              <g key={item.id}>
                <path
                  id={pathId}
                  d={path}
                  fill="none"
                  stroke={tetherColor}
                  strokeWidth={1.4}
                  strokeDasharray="8 8"
                  style={{ animation: 'tetherFlow 1.6s linear infinite' }}
                />
                {/* Small glow at the agent end of the thread */}
                <circle cx={ax} cy={ay} r={14} fill="url(#tetherNodeGlow)" />
                {/* Energy bead — small color-tinted dot that rides
                    the bezier from helper to doc. Uses SVG
                    <animateMotion> with mpath so it follows the
                    exact curve without re-parameterizing. */}
                <circle r={3.2} fill={beadColor} opacity={0.95}>
                  <animateMotion dur="2.2s" repeatCount="indefinite">
                    <mpath href={`#${pathId}`} />
                  </animateMotion>
                </circle>
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
