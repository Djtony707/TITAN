/**
 * Titan 3.0 CRDT Engine
 * Yjs-backed space sync with IndexedDB persistence.
 *
 * Fixed 2026-04-22:
 * - observeSpace now watches both Y.Array and nested Y.Map changes
 *   so layout updates (x/y/w/h) propagate across tabs.
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import type { WidgetDef } from '../types';

const docs = new Map<string, Y.Doc>();
const persistences = new Map<string, IndexeddbPersistence>();
const webrtcs = new Map<string, WebrtcProvider>();

/**
 * WebRTC P2P sync is OFF by default. Previously it ran unconditionally with
 * public signaling servers — every tab world-wide sharing the same Space ID
 * merged their widget state, and a user's own second tab merged its seed
 * widgets into the first, causing runaway duplication. Enable only when you
 * genuinely want peer-to-peer sync by setting
 * `localStorage['titan2:webrtc'] = '1'` (or flipping a future config flag).
 */
function isWebrtcEnabled(): boolean {
  try { return globalThis.localStorage?.getItem('titan2:webrtc') === '1'; }
  catch { return false; }
}

function getDoc(spaceId: string): Y.Doc {
  if (!docs.has(spaceId)) {
    const doc = new Y.Doc({ guid: `titan-space-${spaceId}` });
    docs.set(spaceId, doc);

    // IndexedDB persistence — local-only, always on
    const persistence = new IndexeddbPersistence(`titan-space-${spaceId}`, doc);
    persistences.set(spaceId, persistence);

    // WebRTC P2P sync — opt-in via localStorage['titan2:webrtc']='1'
    if (isWebrtcEnabled()) {
      try {
        const webrtc = new WebrtcProvider(`titan-space-${spaceId}`, doc, {
          signaling: ['wss://signaling.yjs.dev', 'wss://y-webrtc-signaling-eu.herokuapp.com'],
        });
        webrtcs.set(spaceId, webrtc);
      } catch {
        // WebRTC optional — IndexedDB is the source of truth
      }
    }
  }
  return docs.get(spaceId)!;
}

/**
 * Remove duplicate widget entries from a Y.Array, keeping the first occurrence
 * of each widget ID. CRDT-safe: we only delete, never reorder, so the operation
 * merges cleanly if it happens concurrently with another client.
 *
 * Returns the number of duplicate entries removed.
 */
export function dedupeYSpaceWidgets(spaceId: string): number {
  const { widgets } = getYSpace(spaceId);
  const seen = new Set<string>();
  const dupIndices: number[] = [];
  widgets.forEach((yw, i) => {
    const id = yw.get('id');
    if (typeof id !== 'string' || seen.has(id)) dupIndices.push(i);
    else seen.add(id);
  });
  // Delete from end so earlier indices stay valid
  for (let i = dupIndices.length - 1; i >= 0; i--) {
    widgets.delete(dupIndices[i], 1);
  }
  return dupIndices.length;
}

export function getYSpace(spaceId: string): {
  widgets: Y.Array<Y.Map<any>>;
  meta: Y.Map<any>;
  doc: Y.Doc;
  whenSynced: Promise<void>;
} {
  const doc = getDoc(spaceId);
  const widgets = doc.getArray<Y.Map<any>>('widgets');
  const meta = doc.getMap('meta');
  const persistence = persistences.get(spaceId);

  return {
    widgets,
    meta,
    doc,
    whenSynced: persistence?.synced ? Promise.resolve() : new Promise(r => {
      const handler = () => { persistence?.off('synced', handler); r(); };
      persistence?.on('synced', handler);
      setTimeout(() => r(), 2000);
    }),
  };
}

export function yWidgetToDef(yw: Y.Map<any>): WidgetDef {
  return {
    id: yw.get('id'),
    name: yw.get('name'),
    format: yw.get('format'),
    source: yw.get('source'),
    x: yw.get('x'),
    y: yw.get('y'),
    w: yw.get('w'),
    h: yw.get('h'),
    metadata: yw.get('metadata'),
    createdAt: yw.get('createdAt'),
    updatedAt: yw.get('updatedAt'),
  };
}

export function defToYWidget(def: WidgetDef): Y.Map<any> {
  const yw = new Y.Map();
  yw.set('id', def.id);
  yw.set('name', def.name);
  yw.set('format', def.format);
  yw.set('source', def.source);
  yw.set('x', def.x);
  yw.set('y', def.y);
  yw.set('w', def.w);
  yw.set('h', def.h);
  yw.set('metadata', def.metadata);
  yw.set('createdAt', def.createdAt);
  yw.set('updatedAt', def.updatedAt);
  return yw;
}

/**
 * Read the IDs currently saved in localStorage for `spaceId`. localStorage
 * is the user-truth — it reflects exactly what the user has explicitly
 * added and never resurrects from CRDT update logs. Returns null if we
 * couldn't read it (in that case the caller should NOT filter, to avoid
 * accidentally dropping legitimate state).
 */
function localStorageWidgetIdsForSpace(spaceId: string): Set<string> | null {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('titan2-spaces') : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Array<{ id: string; widgets?: Array<{ id: string }> }>;
    const space = parsed.find(s => s.id === spaceId);
    if (!space) return null;
    const ids = new Set<string>();
    for (const w of space.widgets || []) {
      if (w && typeof w.id === 'string') ids.add(w.id);
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Per-space set of widget ids that were added in THIS session via
 * `addYWidget`. The Yjs observe→emit fires synchronously on `widgets.push`,
 * which can run BEFORE the caller's localStorage save flushes. Without
 * this allowlist the reconcile would drop freshly-added widgets in the
 * brief window between Yjs append and localStorage save. Cleared by
 * `clearSessionAllowedForSpace` when a space is cleared / destroyed.
 */
const sessionAllowedByspace = new Map<string, Set<string>>();
function markSessionAllowed(spaceId: string, id: string): void {
  let set = sessionAllowedByspace.get(spaceId);
  if (!set) {
    set = new Set<string>();
    sessionAllowedByspace.set(spaceId, set);
  }
  set.add(id);
}
function isSessionAllowed(spaceId: string, id: string): boolean {
  return sessionAllowedByspace.get(spaceId)?.has(id) ?? false;
}
function clearSessionAllowedForSpace(spaceId: string): void {
  sessionAllowedByspace.delete(spaceId);
}

export function observeSpace(
  spaceId: string,
  onChange: (widgets: WidgetDef[]) => void,
): () => void {
  const { widgets } = getYSpace(spaceId);

  const widgetObservers = new Map<Y.Map<any>, () => void>();

  const emit = () => {
    // Defensive filter: dedupe by id, drop phantom widgets that resurrect
    // from a stale IndexedDB persistence layer (~100 cumulative updates
    // can replay widgets the user already removed).
    //
    // Strategy:
    //   1. Dedupe by widget id (CRDT merges can duplicate ids).
    //   2. Drop non-system widgets with empty source (un-renderable).
    //   3. Reconcile against localStorage: if localStorage has this space
    //      and its widget list doesn't include the id AND the id wasn't
    //      added in this session, treat it as a phantom and skip it.
    //      localStorage is updated on every addWidget/removeWidget so it
    //      reflects user-explicit state. CRDT update logs accumulate and
    //      get replayed, so an id that's gone from localStorage but still
    //      in the CRDT is almost certainly stale.
    //   4. If localStorage doesn't have the space yet (first-paint race),
    //      emit unfiltered so we don't drop legitimate hydrating state.
    const seen = new Set<string>();
    const lsIds = localStorageWidgetIdsForSpace(spaceId);
    const defs: WidgetDef[] = [];
    widgets.forEach(yw => {
      const def = yWidgetToDef(yw);
      if (!def.id || seen.has(def.id)) return;
      const isSystem = def.format === 'system';
      const hasSource = typeof def.source === 'string' && def.source.trim() !== '';
      if (!isSystem && !hasSource) return;
      if (lsIds && !lsIds.has(def.id) && !isSessionAllowed(spaceId, def.id)) {
        return; // phantom — IDB update log replayed an id that's not in user-truth
      }
      seen.add(def.id);
      defs.push(def);
    });
    onChange(defs);
  };

  // Observe the array itself (insertions, deletions, moves)
  const arrayHandler = () => {
    // Re-attach observers to any new widgets, detach from removed ones
    const current = new Set<Y.Map<any>>();
    widgets.forEach(yw => current.add(yw));

    for (const [yw, obs] of widgetObservers) {
      if (!current.has(yw)) {
        yw.unobserve(obs);
        widgetObservers.delete(yw);
      }
    }

    for (const yw of current) {
      if (!widgetObservers.has(yw)) {
        const obs = () => emit();
        yw.observe(obs);
        widgetObservers.set(yw, obs);
      }
    }

    emit();
  };

  widgets.observe(arrayHandler);
  arrayHandler(); // initial attach + emit

  return () => {
    widgets.unobserve(arrayHandler);
    for (const [yw, obs] of widgetObservers) {
      yw.unobserve(obs);
    }
    widgetObservers.clear();
  };
}

export function addYWidget(spaceId: string, def: Omit<WidgetDef, 'id' | 'createdAt' | 'updatedAt'>): WidgetDef {
  const { widgets } = getYSpace(spaceId);
  const full: WidgetDef = {
    ...def,
    id: `widget_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Mark the new id as session-allowed BEFORE the push so the synchronous
  // observer emit doesn't drop it as a "not in localStorage yet" phantom
  // (caller mirrors to localStorage after this returns).
  markSessionAllowed(spaceId, full.id);
  widgets.push([defToYWidget(full)]);
  return full;
}

export function removeYWidget(spaceId: string, widgetId: string): void {
  const { widgets } = getYSpace(spaceId);
  let index = -1;
  widgets.forEach((yw, i) => { if (yw.get('id') === widgetId) index = i; });
  if (index >= 0) widgets.delete(index, 1);
}

export function updateYWidget(spaceId: string, widgetId: string, patch: Partial<WidgetDef>): void {
  const { widgets } = getYSpace(spaceId);
  widgets.forEach(yw => {
    if (yw.get('id') === widgetId) {
      for (const [key, value] of Object.entries(patch)) {
        yw.set(key, value);
      }
      yw.set('updatedAt', Date.now());
    }
  });
}

export function clearYSpace(spaceId: string): void {
  const { widgets } = getYSpace(spaceId);
  widgets.delete(0, widgets.length);
  // Forget anything we session-allowed for this space — they're gone now.
  clearSessionAllowedForSpace(spaceId);
}

export function destroyYSpace(spaceId: string): void {
  persistences.get(spaceId)?.destroy();
  webrtcs.get(spaceId)?.destroy();
  docs.get(spaceId)?.destroy();
  persistences.delete(spaceId);
  webrtcs.delete(spaceId);
  docs.delete(spaceId);
  // Drop any stale session-allowlist for this space; the next getYSpace
  // creates a fresh doc and the allowlist starts empty.
  clearSessionAllowedForSpace(spaceId);
}
